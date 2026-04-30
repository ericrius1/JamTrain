import { makeParams, registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { InstrumentId } from './instruments';
import { clamp, cloneVec, hash, lerp, lerpVec, vec } from './math';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type PlayerPose, type Vec3Data } from './types';

type RobotMotionKind = 'still' | 'solo' | 'mirror' | 'complement' | 'opposite';

type RobotMotionPhase = {
  kind: RobotMotionKind;
  startedAt: number;
  duration: number;
  seed: number;
  index: number;
};

type RobotStrikeCue = {
  target: Vec3Data;
  startedAt: number;
  duration: number;
  velocity: number;
};

export type RobotPerformanceContext = {
  instrument: InstrumentId;
  targets: Partial<Record<Handedness, readonly Vec3Data[]>>;
};

type RobotPerformanceGesture = {
  startedAt: number;
  duration: number;
  seed: number;
  index: number;
  targetIndex: number;
  from: Vec3Data;
  to: Vec3Data;
};

type RobotPerformanceIntent = {
  instrument: InstrumentId;
  aim: Vec3Data;
  palm: Vec3Data;
  amount: number;
  contactAmount: number;
  progress: number;
  seed: number;
};

export const ROBOT_MOTION_DEFS = {
  tempo:            { default: 92,   min: 50,  max: 160, step: 1,    label: 'tempo (BPM)' },
  density:          { default: 0.55, min: 0.1, max: 1,   step: 0.01, label: 'density' },
  swing:            { default: 0.18, min: 0,   max: 0.5, step: 0.01, label: 'swing' },
  gestureSize:      { default: 0.78, min: 0.2, max: 1.6, step: 0.01, label: 'gesture size' },
  playerFollow:     { default: 0.56, min: 0,   max: 1,   step: 0.01, label: 'player follow' },
  // Sliding-window seconds the robot averages human note hits over to decide how much to duck its density.
  humanDuckWindow:  { default: 3.5,  min: 1,   max: 8,   step: 0.1,  label: 'human duck window (s)' },
  // Max fraction the robot density is reduced when human activity is fully saturated. 1 = silence robot.
  humanDuckAmount:  { default: 0.75, min: 0,   max: 1,   step: 0.01, label: 'human duck amount' },
  // Number of human notes within the window that maps to fully-saturated activity (1.0).
  humanDuckSaturate:{ default: 8,    min: 1,   max: 30,  step: 1,    label: 'human duck saturate (notes)' },
  // Exponential smoothing time constant (seconds) on top of the window — keeps transitions buttery so the robot doesn't snap density up/down on a single note.
  humanDuckSmoothTau:{default: 0.8,  min: 0,   max: 4,   step: 0.05, label: 'human duck smooth tau (s)' },
} as const;

const ROBOT_MOTION_CONST = {
  stillness: 0.18,
  sequenceSpeed: 1,
  idleMotion: 0.10,
  handLift: 0.12,
  handDrift: 0.055,
  fingerActivity: 0.42,
  holdMinSeconds: 0.9,
  holdMaxSeconds: 2.2,
  moveMinSeconds: 1.6,
  moveMaxSeconds: 3.4,
  handSmooth: 0.72,
  fingerSmooth: 0.84,
} as const;

export type RobotMotionParams = ParamsOf<typeof ROBOT_MOTION_DEFS>;

const fingerSpread: Record<FingerName, number> = {
  thumb: -0.24,
  index: -0.1,
  middle: 0,
  ring: 0.1,
  pinky: 0.2,
};

const fingerReach: Record<FingerName, number> = {
  thumb: 0.23,
  index: 0.34,
  middle: 0.38,
  ring: 0.34,
  pinky: 0.28,
};

export class RobotMotionController {
  readonly params: RobotMotionParams = makeParams(ROBOT_MOTION_DEFS) as RobotMotionParams;
  private registered?: ReturnType<typeof registerTweaks<typeof ROBOT_MOTION_DEFS>>;
  private previousHands?: Record<Handedness, HandPose>;
  private strikeCues: Partial<Record<Handedness, RobotStrikeCue>> = {};
  private performanceGestures: Partial<Record<Handedness, RobotPerformanceGesture>> = {};
  private phase: RobotMotionPhase = {
    kind: 'still',
    startedAt: 0,
    duration: ROBOT_MOTION_CONST.holdMinSeconds,
    seed: 0.37,
    index: 0,
  };

  constructor(paneContainer?: HTMLElement) {
    this.registered = registerTweaks(paneContainer, 'robotMotion', ROBOT_MOTION_DEFS, {
      title: 'Robot Hands',
      params: this.params,
    });
  }

  update(
    elapsed: number,
    delta: number,
    playerPose?: PlayerPose,
    performance?: RobotPerformanceContext
  ): Record<Handedness, HandPose> {
    const kind = this.resolveKind(elapsed);
    const phaseProgress = clamp((elapsed - this.phase.startedAt) / Math.max(this.phase.duration, 0.001), 0, 1);
    const moveEnvelope = kind === 'still' ? 0 : Math.sin(phaseProgress * Math.PI);
    const target = this.makeTargetHands(elapsed, kind, moveEnvelope, playerPose, performance);
    const smoothed = this.smoothHands(target, delta);
    this.previousHands = smoothed;
    return smoothed;
  }

  dispose(): void {
    this.registered?.dispose();
  }

  cueStrike(handedness: Handedness, target: Vec3Data, velocity: number, elapsed: number): void {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) return;
    const v = clamp(velocity, 0, 1);
    this.strikeCues[handedness] = {
      target: cloneVec(target),
      startedAt: elapsed - 0.10,
      duration: lerp(0.72, 1.05, v),
      velocity: v,
    };
  }

  private resolveKind(elapsed: number): RobotMotionKind {
    while (elapsed - this.phase.startedAt >= this.phase.duration) {
      this.phase = this.createNextAutoPhase(this.phase.startedAt + this.phase.duration);
    }
    return this.phase.kind;
  }

  private createNextAutoPhase(startedAt: number): RobotMotionPhase {
    const index = this.phase.index + 1;
    const chance = hash(index * 11.71 + this.phase.seed * 3.03);
    if (this.phase.kind !== 'still' && chance < ROBOT_MOTION_CONST.stillness) {
      return this.createPhase('still', startedAt, index);
    }

    const pick = hash(index * 19.23 + this.phase.seed * 1.67);
    const kind: RobotMotionKind = pick < 0.36 ? 'solo' : pick < 0.66 ? 'mirror' : pick < 0.87 ? 'complement' : 'opposite';
    return this.createPhase(kind, startedAt, index);
  }

  private createPhase(kind: RobotMotionKind, startedAt: number, index: number): RobotMotionPhase {
    const seed = hash(index * 29.31 + (kind === 'still' ? 1.7 : 9.4));
    const min = kind === 'still' ? ROBOT_MOTION_CONST.holdMinSeconds : ROBOT_MOTION_CONST.moveMinSeconds;
    const max = kind === 'still' ? ROBOT_MOTION_CONST.holdMaxSeconds : ROBOT_MOTION_CONST.moveMaxSeconds;
    const speed = ROBOT_MOTION_CONST.sequenceSpeed;
    const duration = lerp(Math.min(min, max), Math.max(min, max), hash(seed * 41.8 + index)) / speed;

    return {
      kind,
      startedAt,
      duration,
      seed,
      index,
    };
  }

  private makeTargetHands(
    elapsed: number,
    kind: RobotMotionKind,
    moveEnvelope: number,
    playerPose?: PlayerPose,
    performance?: RobotPerformanceContext
  ): Record<Handedness, HandPose> {
    const hands = {} as Record<Handedness, HandPose>;
    const stillnessAlive = kind === 'still' ? ROBOT_MOTION_CONST.idleMotion : 0.22;
    const motionAmount = this.params.gestureSize * (stillnessAlive + moveEnvelope * (1 - stillnessAlive));

    for (const handedness of handednesses) {
      hands[handedness] = this.makeTargetHand(
        handedness,
        elapsed,
        kind,
        motionAmount,
        moveEnvelope,
        playerPose,
        performance,
      );
    }

    return hands;
  }

  private makeTargetHand(
    handedness: Handedness,
    elapsed: number,
    kind: RobotMotionKind,
    motionAmount: number,
    moveEnvelope: number,
    playerPose?: PlayerPose,
    performance?: RobotPerformanceContext
  ): HandPose {
    const side = handedness === 'left' ? -1 : 1;
    const handIndex = handedness === 'left' ? 0 : 1;
    const seed = this.phase.seed * 100 + handIndex * 7.9;
    const drift = ROBOT_MOTION_CONST.handDrift * motionAmount;
    const lift = ROBOT_MOTION_CONST.handLift * motionAmount;
    const baseX = side * 0.46;
    const baseY = 0.56;
    const baseZ = 0.12;
    const soloTempo = 0.34 + hash(seed + 4.1) * 0.18;
    const wrist = vec(
      baseX + side * Math.sin(elapsed * soloTempo + seed) * drift + Math.sin(elapsed * 0.18 + seed) * drift * 0.35,
      baseY + Math.sin(elapsed * (0.44 + hash(seed + 1.8) * 0.18) + seed * 0.7) * lift,
      baseZ + Math.cos(elapsed * (0.31 + hash(seed + 2.9) * 0.12) + seed) * drift * 0.58
    );

    const curls = {} as Record<FingerName, number>;
    for (const finger of fingerNames) {
      const index = fingerNames.indexOf(finger);
      const wave = Math.sin(elapsed * (0.56 + index * 0.06 + hash(seed + index) * 0.18) + seed + index * 0.91);
      const delayedWave = Math.sin(elapsed * (0.22 + hash(seed + index * 2.4) * 0.2) + seed * 1.7 + index);
      const fingerPulse = smoothPulse((elapsed * (0.07 + hash(seed + index * 8.3) * 0.08) + hash(seed + index * 5.6)) % 1);
      curls[finger] = clamp(
        0.24 + wave * 0.1 * motionAmount + delayedWave * 0.08 * moveEnvelope + fingerPulse * ROBOT_MOTION_CONST.fingerActivity * 0.24 * motionAmount,
        0.06,
        0.88
      );
    }

    this.applyPlayerInfluence(kind, handedness, playerPose, wrist, curls, moveEnvelope);
    const performanceIntent = this.applyPerformanceGesture(
      handedness,
      elapsed,
      performance,
      wrist,
      curls,
    );
    const hand = this.buildHand(handedness, wrist, curls);
    if (performanceIntent) this.applyPerformanceHandShape(hand, performanceIntent);
    this.applyStrikeCue(hand, elapsed);
    return hand;
  }

  private applyPerformanceGesture(
    handedness: Handedness,
    elapsed: number,
    performance: RobotPerformanceContext | undefined,
    wrist: Vec3Data,
    curls: Record<FingerName, number>,
  ): RobotPerformanceIntent | undefined {
    const targets = performance?.targets[handedness];
    if (!performance || !targets?.length) {
      this.performanceGestures[handedness] = undefined;
      return undefined;
    }

    const gesture = this.ensurePerformanceGesture(handedness, elapsed, performance.instrument, targets);
    const progress = clamp((elapsed - gesture.startedAt) / Math.max(gesture.duration, 0.001), 0, 1);
    const isOar = performance.instrument === 'oar';
    const side = handedness === 'left' ? -1 : 1;
    const approachEnd = isOar ? 0.68 : 0.86;
    const approach = easeInOutCubic(smoothstepScalar(0, approachEnd, progress));
    const release = isOar
      ? smoothstepScalar(0.70, 1, progress)
      : smoothstepScalar(0.88, 1, progress);
    const contactAmount = isOar
      ? smoothstepScalar(0.42, 0.62, progress) * (1 - smoothstepScalar(0.84, 1, progress))
      : smoothstepScalar(0.18, 0.58, progress) * (1 - smoothstepScalar(0.94, 1, progress));
    const path = lerpVec(gesture.from, gesture.to, approach);
    const arc = Math.sin(approach * Math.PI) * (1 - release * 0.8);
    const phraseSway = Math.sin(progress * Math.PI * 2 + gesture.seed * 5.7) * (isOar ? 0.018 : 0.04);
    const depthSway = Math.sin(progress * Math.PI + gesture.seed * 7.1) * (isOar ? 0.035 : 0.055);
    const palmTarget = vec(
      clamp(path.x + side * phraseSway, -0.96, 0.96),
      clamp(path.y + arc * (isOar ? 0.15 : 0.065) + release * (isOar ? 0.05 : 0.015), 0.10, 1.62),
      clamp(path.z + depthSway * (1 - contactAmount * 0.65) + release * (isOar ? 0.035 : 0.02), -0.42, 1.02),
    );
    const wristTarget = vec(
      clamp(palmTarget.x - side * (0.065 + contactAmount * (isOar ? 0.015 : 0.005)), -1.0, 1.0),
      clamp(palmTarget.y - 0.17 - contactAmount * (isOar ? 0.025 : 0.005), 0.02, 1.35),
      clamp(palmTarget.z + 0.055 + release * (isOar ? 0.055 : 0.025), -0.42, 1.04),
    );
    const amount = isOar ? 0.86 : 0.78;
    wrist.x = lerp(wrist.x, wristTarget.x, amount);
    wrist.y = lerp(wrist.y, wristTarget.y, amount);
    wrist.z = lerp(wrist.z, wristTarget.z, amount);

    for (const finger of fingerNames) {
      const index = fingerNames.indexOf(finger);
      const lead = finger === 'index' || finger === 'middle' ? 1 : finger === 'ring' ? 0.62 : finger === 'thumb' ? 0.46 : 0.38;
      const targetCurl = isOar
        ? 0.18 + (1 - lead) * 0.24 + contactAmount * 0.08
        : 0.08 + (1 - lead) * 0.16 + Math.sin(progress * Math.PI + index) * 0.035;
      curls[finger] = lerp(curls[finger], clamp(targetCurl, 0.04, 0.58), amount * (0.48 + lead * 0.32));
    }

    return {
      instrument: performance.instrument,
      aim: cloneVec(gesture.to),
      palm: palmTarget,
      amount,
      contactAmount,
      progress,
      seed: gesture.seed,
    };
  }

  private ensurePerformanceGesture(
    handedness: Handedness,
    elapsed: number,
    instrument: InstrumentId,
    targets: readonly Vec3Data[],
  ): RobotPerformanceGesture {
    const current = this.performanceGestures[handedness];
    if (
      current &&
      current.targetIndex < targets.length &&
      elapsed - current.startedAt < current.duration
    ) {
      copyVecData(current.to, this.clampPerformanceTarget(targets[current.targetIndex]));
      return current;
    }

    const index = (current?.index ?? 0) + 1;
    const seed = this.phase.seed * 97.3 + index * 13.37 + (handedness === 'left' ? 4.2 : 9.6);
    const targetIndex = this.pickPerformanceTargetIndex(handedness, targets, current?.targetIndex ?? -1, seed);
    const from = this.previousHands
      ? cloneVec(this.previousHands[handedness].palm)
      : this.defaultPerformancePalm(handedness);
    const to = this.clampPerformanceTarget(targets[targetIndex]);
    const duration = instrument === 'oar'
      ? lerp(0.58, 0.96, hash(seed + 1.1))
      : lerp(0.92, 1.58, hash(seed + 1.1));
    const initialDelay = current ? 0 : (handedness === 'left' ? duration * 0.34 : 0);
    const gesture: RobotPerformanceGesture = {
      startedAt: elapsed + initialDelay,
      duration,
      seed,
      index,
      targetIndex,
      from,
      to,
    };
    this.performanceGestures[handedness] = gesture;
    return gesture;
  }

  private pickPerformanceTargetIndex(
    handedness: Handedness,
    targets: readonly Vec3Data[],
    previousIndex: number,
    seed: number,
  ): number {
    const side = handedness === 'left' ? -1 : 1;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const lateralPreference = clamp(target.x * side, -1, 1) * 0.22;
      const novelty = i === previousIndex ? -0.45 : 0;
      const score = hash(seed + i * 17.19) + lateralPreference + novelty;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private defaultPerformancePalm(handedness: Handedness): Vec3Data {
    const side = handedness === 'left' ? -1 : 1;
    return vec(side * 0.44, 0.72, 0.14);
  }

  private clampPerformanceTarget(target: Vec3Data): Vec3Data {
    return vec(
      clamp(target.x, -0.94, 0.94),
      clamp(target.y, 0.16, 1.56),
      clamp(target.z, -0.38, 0.96),
    );
  }

  private applyPerformanceHandShape(hand: HandPose, intent: RobotPerformanceIntent): void {
    const isOar = intent.instrument === 'oar';
    const side = hand.handedness === 'left' ? -1 : 1;
    const palmAmount = intent.amount * (isOar ? 0.34 : 0.42);
    hand.palm = lerpVec(hand.palm, intent.palm, palmAmount);

    for (const finger of fingerNames) {
      const index = fingerNames.indexOf(finger);
      const lead = finger === 'index' || finger === 'middle' ? 1 : finger === 'ring' ? 0.62 : finger === 'thumb' ? 0.48 : 0.36;
      const spread = fingerSpread[finger] * side;
      const fingerAmount = clamp(intent.amount * (0.30 + intent.contactAmount * 0.70) * (0.52 + lead * 0.48), 0, 1);
      const glide = isOar
        ? 0
        : Math.sin(intent.progress * Math.PI * 2 + intent.seed + index * 0.61) * 0.026;
      const tipTarget = vec(
        clamp(intent.aim.x + spread * (isOar ? 0.045 : 0.080) + glide * side, -0.98, 0.98),
        clamp(intent.aim.y + (isOar ? (1 - lead) * 0.032 : lead * 0.024 + glide * 0.35), 0.12, 1.58),
        clamp(intent.aim.z + (isOar ? (1 - lead) * 0.052 : Math.cos(intent.progress * Math.PI + index) * 0.028), -0.40, 1.0),
      );
      const baseTarget = vec(
        hand.palm.x + spread * (isOar ? 0.26 : 0.35),
        hand.palm.y + 0.028 + index * 0.004,
        hand.palm.z + (isOar ? 0.010 : 0.006),
      );
      const midTarget = vec(
        baseTarget.x + (tipTarget.x - baseTarget.x) * (isOar ? 0.48 : 0.56),
        baseTarget.y + (tipTarget.y - baseTarget.y) * (isOar ? 0.52 : 0.58) + lead * (isOar ? 0.026 : 0.016),
        baseTarget.z + (tipTarget.z - baseTarget.z) * (isOar ? 0.50 : 0.58),
      );
      const pose = hand.fingers[finger];
      pose.base = lerpVec(pose.base, baseTarget, fingerAmount);
      pose.mid = lerpVec(pose.mid, midTarget, fingerAmount);
      pose.tip = lerpVec(pose.tip, tipTarget, fingerAmount);
      pose.curl = lerp(
        pose.curl,
        clamp(isOar ? 0.08 + (1 - lead) * 0.24 : 0.05 + (1 - lead) * 0.16, 0.04, 0.42),
        fingerAmount,
      );
    }
  }

  private applyStrikeCue(hand: HandPose, elapsed: number): void {
    const cue = this.strikeCues[hand.handedness];
    if (!cue) return;

    const t = clamp((elapsed - cue.startedAt) / Math.max(0.001, cue.duration), 0, 1);
    if (t >= 1) {
      delete this.strikeCues[hand.handedness];
      return;
    }

    const attack = smoothstepScalar(0, 0.14, t);
    const release = 1 - smoothstepScalar(0.62, 1, t);
    const amount = clamp(attack * release * (0.72 + cue.velocity * 0.28), 0, 1);
    if (amount <= 0.001) return;

    const side = hand.handedness === 'left' ? -1 : 1;
    const target = {
      x: clamp(cue.target.x, -0.92, 0.92),
      y: clamp(cue.target.y, 0.18, 1.58),
      z: clamp(cue.target.z, -0.36, 0.95),
    };
    const palmTarget = vec(
      clamp(target.x - side * 0.025, -0.95, 0.95),
      clamp(target.y - 0.07 + cue.velocity * 0.018, 0.12, 1.38),
      clamp(target.z + 0.015, -0.36, 0.95),
    );
    const wristTarget = vec(
      clamp(palmTarget.x - side * 0.09, -1.0, 1.0),
      clamp(palmTarget.y - 0.16, 0.04, 1.18),
      clamp(palmTarget.z + 0.055, -0.34, 0.98),
    );

    hand.wrist = lerpVec(hand.wrist, wristTarget, amount);
    hand.palm = lerpVec(hand.palm, palmTarget, amount);

    for (const finger of fingerNames) {
      const index = fingerNames.indexOf(finger);
      const lead = finger === 'index' || finger === 'middle' ? 1 : finger === 'ring' ? 0.55 : 0.34;
      const spread = fingerSpread[finger] * side;
      const tipTarget = vec(
        clamp(target.x + spread * 0.075 * (1 - lead * 0.45), -0.98, 0.98),
        clamp(target.y - (1 - lead) * 0.045 + Math.sin(t * Math.PI) * 0.016 * lead, 0.16, 1.5),
        clamp(target.z + (1 - lead) * 0.045, -0.38, 0.98),
      );
      const baseTarget = vec(
        hand.palm.x + spread * 0.32,
        hand.palm.y + 0.035 + index * 0.005,
        hand.palm.z + 0.006,
      );
      const midTarget = vec(
        baseTarget.x + (tipTarget.x - baseTarget.x) * 0.54,
        baseTarget.y + (tipTarget.y - baseTarget.y) * 0.58 + 0.035 * lead,
        baseTarget.z + (tipTarget.z - baseTarget.z) * 0.55,
      );
      const pose = hand.fingers[finger];
      const fingerAmount = clamp(amount * (0.55 + lead * 0.45), 0, 1);
      pose.base = lerpVec(pose.base, baseTarget, fingerAmount);
      pose.mid = lerpVec(pose.mid, midTarget, fingerAmount);
      pose.tip = lerpVec(pose.tip, tipTarget, fingerAmount);
      pose.curl = lerp(pose.curl, clamp(0.05 + (1 - lead) * 0.28, 0.04, 0.48), fingerAmount);
    }
  }

  private applyPlayerInfluence(
    kind: RobotMotionKind,
    handedness: Handedness,
    playerPose: PlayerPose | undefined,
    wrist: Vec3Data,
    curls: Record<FingerName, number>,
    moveEnvelope: number
  ): void {
    if (!playerPose || kind === 'solo' || kind === 'still') return;

    const sourceHandedness = kind === 'mirror' || kind === 'complement' ? oppositeHand(handedness) : handedness;
    const source = playerPose.hands[sourceHandedness];
    const sourceSide = sourceHandedness === 'left' ? -1 : 1;
    const influence = this.params.playerFollow * (0.25 + moveEnvelope * 0.75);
    const sourceX = clamp(source.palm.x - sourceSide * 0.49, -0.38, 0.38);
    const sourceY = clamp(source.palm.y - 0.72, -0.38, 0.46);
    const sourceZ = clamp(source.palm.z - 0.1, -0.35, 0.35);
    const horizontal = kind === 'mirror' ? -sourceX : sourceX * (kind === 'opposite' ? -0.75 : 0.45);
    const vertical = kind === 'opposite' || kind === 'complement' ? -sourceY : sourceY;

    wrist.x += horizontal * influence * 0.46;
    wrist.y += vertical * influence * 0.34;
    wrist.z += sourceZ * influence * (kind === 'opposite' ? -0.25 : 0.25);

    for (const finger of fingerNames) {
      const index = fingerNames.indexOf(finger);
      const sourceCurl = source.fingers[finger].curl;
      let responseCurl = sourceCurl;
      if (kind === 'opposite') responseCurl = 1 - sourceCurl;
      if (kind === 'complement') responseCurl = index % 2 === 0 ? 0.72 - sourceCurl * 0.42 : 0.12 + sourceCurl * 0.52;
      curls[finger] = lerp(curls[finger], clamp(responseCurl, 0.05, 0.9), influence);
    }
  }

  private buildHand(handedness: Handedness, wrist: Vec3Data, curls: Record<FingerName, number>): HandPose {
    const side = handedness === 'left' ? -1 : 1;
    const palm = vec(wrist.x + side * 0.03, wrist.y + 0.16, wrist.z - 0.02);
    const fingers = {} as HandPose['fingers'];

    for (const finger of fingerNames) {
      const index = fingerNames.indexOf(finger);
      const curl = clamp(curls[finger], 0, 1);
      const spread = fingerSpread[finger] * side;
      const reach = fingerReach[finger] * (1 - curl * 0.36);
      const base = vec(palm.x + spread * 0.48, palm.y + 0.05 + index * 0.006, palm.z);
      const mid = vec(base.x + spread * 0.18, base.y + reach * 0.48, base.z - 0.04 - curl * 0.09);
      const tip = vec(base.x + spread * 0.28, base.y + reach, base.z - 0.07 - curl * 0.16);
      fingers[finger] = { name: finger, base, mid, tip, curl };
    }

    return {
      handedness,
      wrist,
      palm,
      fingers,
      confidence: 1,
    };
  }

  private smoothHands(target: Record<Handedness, HandPose>, delta: number): Record<Handedness, HandPose> {
    if (!this.previousHands) return cloneHands(target);

    const hands = {} as Record<Handedness, HandPose>;
    const handAmount = smoothingAmount(ROBOT_MOTION_CONST.handSmooth, delta);
    const fingerAmount = smoothingAmount(ROBOT_MOTION_CONST.fingerSmooth, delta);

    for (const handedness of handednesses) {
      const previous = this.previousHands[handedness];
      const next = target[handedness];
      const fingers = {} as HandPose['fingers'];

      for (const finger of fingerNames) {
        fingers[finger] = {
          name: finger,
          base: lerpVec(previous.fingers[finger].base, next.fingers[finger].base, fingerAmount),
          mid: lerpVec(previous.fingers[finger].mid, next.fingers[finger].mid, fingerAmount),
          tip: lerpVec(previous.fingers[finger].tip, next.fingers[finger].tip, fingerAmount),
          curl: lerp(previous.fingers[finger].curl, next.fingers[finger].curl, fingerAmount),
        };
      }

      hands[handedness] = {
        handedness,
        wrist: lerpVec(previous.wrist, next.wrist, handAmount),
        palm: lerpVec(previous.palm, next.palm, handAmount),
        fingers,
        confidence: next.confidence,
      };
    }

    return hands;
  }
}

function cloneHands(hands: Record<Handedness, HandPose>): Record<Handedness, HandPose> {
  const copy = {} as Record<Handedness, HandPose>;

  for (const handedness of handednesses) {
    const hand = hands[handedness];
    const fingers = {} as HandPose['fingers'];
    for (const finger of fingerNames) {
      const pose = hand.fingers[finger];
      fingers[finger] = {
        name: finger,
        base: cloneVec(pose.base),
        mid: cloneVec(pose.mid),
        tip: cloneVec(pose.tip),
        curl: pose.curl,
      };
    }

    copy[handedness] = {
      handedness,
      wrist: cloneVec(hand.wrist),
      palm: cloneVec(hand.palm),
      fingers,
      confidence: hand.confidence,
    };
  }

  return copy;
}

function oppositeHand(handedness: Handedness): Handedness {
  return handedness === 'left' ? 'right' : 'left';
}

function copyVecData(target: Vec3Data, source: Vec3Data): Vec3Data {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
  return target;
}

function easeInOutCubic(value: number): number {
  const t = clamp(value, 0, 1);
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function smoothingAmount(smoothness: number, delta: number): number {
  const response = lerp(18, 3.2, clamp(smoothness, 0, 1));
  return 1 - Math.exp(-response * delta);
}

function smoothPulse(position: number): number {
  const wrapped = ((position % 1) + 1) % 1;
  const attack = smoothstepScalar(0.02, 0.18, wrapped);
  const release = 1 - smoothstepScalar(0.18, 0.42, wrapped);
  return attack * release;
}

function smoothstepScalar(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
