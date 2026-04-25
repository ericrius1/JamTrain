import { clamp, vec } from './math';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type PlayerPose, type Vec3Data } from './types';

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

export function makeNeutralHand(handedness: Handedness, time = 0, phaseOffset = 0): HandPose {
  const side = handedness === 'left' ? -1 : 1;
  const pulse = Math.sin(time * 1.3 + phaseOffset) * 0.5 + 0.5;
  const wrist = vec(side * 0.46 + Math.sin(time * 0.7 + side) * 0.035, 0.56 + pulse * 0.08, 0.12);
  const palm = vec(wrist.x + side * 0.03, wrist.y + 0.16, wrist.z - 0.02);

  const fingers = Object.fromEntries(
    fingerNames.map((name, index) => {
      const curl = clamp(0.22 + Math.sin(time * (1.2 + index * 0.08) + index + phaseOffset) * 0.18, 0, 1);
      const spread = fingerSpread[name] * side;
      const reach = fingerReach[name] * (1 - curl * 0.35);
      const base = vec(palm.x + spread * 0.48, palm.y + 0.05 + index * 0.006, palm.z);
      const mid = vec(base.x + spread * 0.18, base.y + reach * 0.48, base.z - 0.04 - curl * 0.09);
      const tip = vec(base.x + spread * 0.28, base.y + reach, base.z - 0.07 - curl * 0.16);
      return [name, { name, base, mid, tip, curl }];
    })
  ) as HandPose['fingers'];

  return {
    handedness,
    wrist,
    palm,
    fingers,
    confidence: 0.35,
  };
}

export function makeSimulatedHands(time: number, pointerX: number, pointerY: number): Record<Handedness, HandPose> {
  const hands = {} as Record<Handedness, HandPose>;

  for (const hand of handednesses) {
    const side = hand === 'left' ? -1 : 1;
    const neutral = makeNeutralHand(hand, time, side * 0.7);
    neutral.wrist.x += pointerX * 0.1;
    neutral.wrist.y += pointerY * 0.08;
    neutral.palm.x += pointerX * 0.16;
    neutral.palm.y += pointerY * 0.12;

    for (const finger of fingerNames) {
      const index = fingerNames.indexOf(finger);
      const pose = neutral.fingers[finger];
      const bend = Math.sin(time * 2.1 + index * 0.8 + pointerX * 2 + side) * 0.5 + 0.5;
      pose.curl = clamp(0.1 + bend * 0.42 + (1 - pointerY) * 0.12, 0, 1);
      pose.base.x += pointerX * 0.12;
      pose.mid.x += pointerX * 0.16;
      pose.tip.x += pointerX * 0.22;
      pose.tip.y += pointerY * 0.16 + Math.sin(time * 3 + index) * 0.025;
      pose.tip.z += Math.cos(time * 1.8 + index + side) * 0.08;
    }

    hands[hand] = neutral;
  }

  return hands;
}

export function makeRobotHands(time: number): Record<Handedness, HandPose> {
  const hands = makeSimulatedHands(time * 0.42, Math.sin(time * 0.28) * 0.22, Math.cos(time * 0.21) * 0.18);

  for (const hand of handednesses) {
    const side = hand === 'left' ? -1 : 1;
    hands[hand].wrist.y += Math.sin(time * 0.36 + side) * 0.035;
    hands[hand].palm.y += Math.sin(time * 0.36 + side) * 0.035;

    for (const finger of fingerNames) {
      const pose = hands[hand].fingers[finger];
      const index = fingerNames.indexOf(finger);
      const slowCurl = Math.sin(time * (0.5 + index * 0.04) + index * 0.82 + side) * 0.5 + 0.5;
      const smallLift = Math.sin(time * (0.74 + index * 0.03) + index + side) * 0.012;
      pose.curl = clamp(0.16 + slowCurl * 0.42, 0.06, 0.82);
      pose.mid.y += smallLift * 0.5;
      pose.tip.y += smallLift;
      pose.tip.z += Math.cos(time * (0.46 + index * 0.05) + index + side) * 0.016;
    }
    hands[hand].confidence = 1;
  }

  return hands;
}

export function makePlayerPose(
  id: string,
  displayName: string,
  roomId: string,
  seatIndex: number,
  hands: Record<Handedness, HandPose>,
  isRobot = false
): PlayerPose {
  let energy = 0;
  let samples = 0;

  for (const hand of handednesses) {
    for (const finger of fingerNames) {
      const pose = hands[hand].fingers[finger];
      energy += Math.abs(pose.tip.x - pose.base.x) + Math.abs(pose.tip.y - pose.base.y) + Math.abs(pose.tip.z - pose.base.z);
      samples += 1;
    }
  }

  return {
    id,
    displayName,
    roomId,
    seatIndex,
    hands,
    energy: clamp(energy / Math.max(samples, 1), 0, 1.8),
    isRobot,
    updatedAt: Date.now(),
  };
}

export function serializePose(pose: PlayerPose): string {
  return JSON.stringify({
    id: pose.id,
    displayName: pose.displayName,
    roomId: pose.roomId,
    seatIndex: pose.seatIndex,
    hands: pose.hands,
    energy: pose.energy,
    updatedAt: pose.updatedAt,
  });
}

export function parsePose(value: string): PlayerPose | null {
  try {
    const parsed = JSON.parse(value) as PlayerPose;
    if (!parsed || !parsed.hands?.left || !parsed.hands?.right) return null;
    return {
      ...parsed,
      isRobot: false,
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

export function clonePoseAsRobot(pose: PlayerPose, time: number): PlayerPose {
  return {
    ...pose,
    id: 'robot',
    displayName: 'Robot',
    seatIndex: 1,
    hands: makeRobotHands(time),
    isRobot: true,
    updatedAt: Date.now(),
  };
}

export function flattenFingertips(hands: Record<Handedness, HandPose>): Vec3Data[] {
  const points: Vec3Data[] = [];
  for (const hand of handednesses) {
    for (const finger of fingerNames) points.push(hands[hand].fingers[finger].tip);
  }
  return points;
}
