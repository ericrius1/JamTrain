import { Pane } from 'tweakpane';
import { clamp, cloneVec, hash, lerp, lerpVec, vec } from './math';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type PlayerPose, type Vec3Data } from './types';

type RobotMotionMode = 'auto' | 'still' | 'solo' | 'mirror' | 'complement' | 'opposite';
type RobotMotionKind = Exclude<RobotMotionMode, 'auto'>;

type RobotMotionPhase = {
  kind: RobotMotionKind;
  startedAt: number;
  duration: number;
  seed: number;
  index: number;
};

export type RobotMotionParams = {
  mode: RobotMotionMode;
  motionScale: number;
  idleMotion: number;
  handLift: number;
  handDrift: number;
  fingerActivity: number;
  playerInfluence: number;
  stillness: number;
  sequenceSpeed: number;
  holdMinSeconds: number;
  holdMaxSeconds: number;
  moveMinSeconds: number;
  moveMaxSeconds: number;
  handSmooth: number;
  fingerSmooth: number;
};

const defaultRobotMotionParams: RobotMotionParams = {
  mode: 'auto',
  motionScale: 0.78,
  idleMotion: 0.12,
  handLift: 0.12,
  handDrift: 0.075,
  fingerActivity: 0.46,
  playerInfluence: 0.56,
  stillness: 0.34,
  sequenceSpeed: 1,
  holdMinSeconds: 1.25,
  holdMaxSeconds: 3.1,
  moveMinSeconds: 2.4,
  moveMaxSeconds: 5.2,
  handSmooth: 0.68,
  fingerSmooth: 0.76,
};

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

const motionModes: Record<string, RobotMotionMode> = {
  auto: 'auto',
  still: 'still',
  solo: 'solo',
  mirror: 'mirror',
  complement: 'complement',
  opposite: 'opposite',
};

export class RobotMotionController {
  readonly params: RobotMotionParams = { ...defaultRobotMotionParams };
  private pane: Pane;
  private previousHands?: Record<Handedness, HandPose>;
  private manualKind?: RobotMotionKind;
  private phase: RobotMotionPhase = {
    kind: 'still',
    startedAt: 0,
    duration: defaultRobotMotionParams.holdMinSeconds,
    seed: 0.37,
    index: 0,
  };

  constructor(paneContainer?: HTMLElement) {
    this.pane = new Pane({ title: 'Robot Hands', container: paneContainer });
    this.setupPane();
  }

  update(elapsed: number, delta: number, playerPose?: PlayerPose): Record<Handedness, HandPose> {
    const kind = this.resolveKind(elapsed);
    const phaseProgress = clamp((elapsed - this.phase.startedAt) / Math.max(this.phase.duration, 0.001), 0, 1);
    const manualMode = this.params.mode !== 'auto';
    const moveEnvelope = kind === 'still' ? 0 : manualMode ? 1 : Math.sin(phaseProgress * Math.PI);
    const target = this.makeTargetHands(elapsed, kind, moveEnvelope, playerPose);
    const smoothed = this.smoothHands(target, delta);
    this.previousHands = smoothed;
    return smoothed;
  }

  dispose(): void {
    this.pane.dispose();
  }

  private setupPane(): void {
    const behavior = this.pane.addFolder({ title: 'Behavior' });
    behavior.addBinding(this.params, 'mode', { options: motionModes });
    behavior.addBinding(this.params, 'stillness', { label: 'stillness', min: 0, max: 0.9, step: 0.01 });
    behavior.addBinding(this.params, 'sequenceSpeed', { label: 'sequence speed', min: 0.25, max: 2.5, step: 0.01 });
    behavior.addBinding(this.params, 'playerInfluence', { label: 'player follow', min: 0, max: 1, step: 0.01 });

    const gesture = this.pane.addFolder({ title: 'Gesture' });
    gesture.addBinding(this.params, 'motionScale', { label: 'motion scale', min: 0, max: 1.6, step: 0.01 });
    gesture.addBinding(this.params, 'idleMotion', { label: 'idle motion', min: 0, max: 0.5, step: 0.01 });
    gesture.addBinding(this.params, 'handLift', { label: 'hand lift', min: 0, max: 0.28, step: 0.005 });
    gesture.addBinding(this.params, 'handDrift', { label: 'hand drift', min: 0, max: 0.2, step: 0.005 });
    gesture.addBinding(this.params, 'fingerActivity', { label: 'fingers', min: 0, max: 1.1, step: 0.01 });

    const timing = this.pane.addFolder({ title: 'Timing' });
    timing.addBinding(this.params, 'holdMinSeconds', { label: 'hold min', min: 0.2, max: 6, step: 0.05 });
    timing.addBinding(this.params, 'holdMaxSeconds', { label: 'hold max', min: 0.2, max: 8, step: 0.05 });
    timing.addBinding(this.params, 'moveMinSeconds', { label: 'move min', min: 0.5, max: 8, step: 0.05 });
    timing.addBinding(this.params, 'moveMaxSeconds', { label: 'move max', min: 0.5, max: 10, step: 0.05 });

    const smoothing = this.pane.addFolder({ title: 'Smoothing' });
    smoothing.addBinding(this.params, 'handSmooth', { label: 'hand smooth', min: 0, max: 1, step: 0.01 });
    smoothing.addBinding(this.params, 'fingerSmooth', { label: 'finger smooth', min: 0, max: 1, step: 0.01 });
  }

  private resolveKind(elapsed: number): RobotMotionKind {
    if (this.params.mode !== 'auto') {
      if (this.manualKind !== this.params.mode) {
        this.manualKind = this.params.mode;
        this.phase = this.createPhase(this.params.mode, elapsed, this.phase.index + 1);
      }
      return this.params.mode;
    }

    this.manualKind = undefined;
    while (elapsed - this.phase.startedAt >= this.phase.duration) {
      this.phase = this.createNextAutoPhase(this.phase.startedAt + this.phase.duration);
    }
    return this.phase.kind;
  }

  private createNextAutoPhase(startedAt: number): RobotMotionPhase {
    const index = this.phase.index + 1;
    const chance = hash(index * 11.71 + this.phase.seed * 3.03);
    if (this.phase.kind !== 'still' && chance < this.params.stillness) {
      return this.createPhase('still', startedAt, index);
    }

    const pick = hash(index * 19.23 + this.phase.seed * 1.67);
    const kind: RobotMotionKind = pick < 0.36 ? 'solo' : pick < 0.66 ? 'mirror' : pick < 0.87 ? 'complement' : 'opposite';
    return this.createPhase(kind, startedAt, index);
  }

  private createPhase(kind: RobotMotionKind, startedAt: number, index: number): RobotMotionPhase {
    const seed = hash(index * 29.31 + (kind === 'still' ? 1.7 : 9.4));
    const min = kind === 'still' ? this.params.holdMinSeconds : this.params.moveMinSeconds;
    const max = kind === 'still' ? this.params.holdMaxSeconds : this.params.moveMaxSeconds;
    const speed = Math.max(this.params.sequenceSpeed, 0.05);
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
    playerPose?: PlayerPose
  ): Record<Handedness, HandPose> {
    const hands = {} as Record<Handedness, HandPose>;
    const stillnessAlive = kind === 'still' ? this.params.idleMotion : 0.22;
    const motionAmount = this.params.motionScale * (stillnessAlive + moveEnvelope * (1 - stillnessAlive));

    for (const handedness of handednesses) {
      hands[handedness] = this.makeTargetHand(handedness, elapsed, kind, motionAmount, moveEnvelope, playerPose);
    }

    return hands;
  }

  private makeTargetHand(
    handedness: Handedness,
    elapsed: number,
    kind: RobotMotionKind,
    motionAmount: number,
    moveEnvelope: number,
    playerPose?: PlayerPose
  ): HandPose {
    const side = handedness === 'left' ? -1 : 1;
    const handIndex = handedness === 'left' ? 0 : 1;
    const seed = this.phase.seed * 100 + handIndex * 7.9;
    const drift = this.params.handDrift * motionAmount;
    const lift = this.params.handLift * motionAmount;
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
        0.24 + wave * 0.1 * motionAmount + delayedWave * 0.08 * moveEnvelope + fingerPulse * this.params.fingerActivity * 0.24 * motionAmount,
        0.06,
        0.88
      );
    }

    this.applyPlayerInfluence(kind, handedness, playerPose, wrist, curls, moveEnvelope);
    return this.buildHand(handedness, wrist, curls);
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
    const influence = this.params.playerInfluence * (0.25 + moveEnvelope * 0.75);
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
    const handAmount = smoothingAmount(this.params.handSmooth, delta);
    const fingerAmount = smoothingAmount(this.params.fingerSmooth, delta);

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
