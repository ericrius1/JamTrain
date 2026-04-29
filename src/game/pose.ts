import { clamp, vec } from './math';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type PlayerPose } from './types';

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

export function makeMouseHands(
  time: number,
  pointerX: number,
  pointerY: number,
  velocityX = 0,
  velocityY = 0,
  confidence = 1,
  seatIndex = 0,
): Record<Handedness, HandPose> {
  const hands = {} as Record<Handedness, HandPose>;
  const speed = Math.hypot(velocityX, velocityY);
  const speedN = clamp(speed / 8, 0, 1);
  const xN = clamp(pointerX, -1, 1);
  const yN = clamp(pointerY, -1, 1);
  const depthSign = seatIndex === 0 ? 1 : -1;
  const depthX = xN * depthSign;
  // In the game camera, the player's playable instrument arc is seen mostly
  // edge-on. Screen X should therefore travel through depth, not world X.
  const centerX = xN * 0.18;
  const centerY = clamp(0.98 + clamp(pointerY, -1, 1) * 0.68, 0.3, 1.64);
  const centerZ = clamp(0.2 + depthX * 0.52 + yN * 0.08, -0.24, 0.72);
  const separation = 0.22 - speedN * 0.08;
  const leadX = clamp(velocityX * 0.01, -0.08, 0.08);
  const leadY = clamp(velocityY * 0.03, -0.18, 0.18);
  const leadZ = clamp(velocityX * 0.045 * depthSign + velocityY * 0.01, -0.26, 0.26);

  for (const hand of handednesses) {
    const side = hand === 'left' ? -1 : 1;
    const palm = vec(
      clamp(centerX + side * separation * 0.5, -1.0, 1.0),
      centerY + side * 0.018,
      centerZ - side * 0.025,
    );
    const wrist = vec(
      palm.x - side * 0.06 - leadX * 0.22,
      palm.y - 0.18 - leadY * 0.2,
      palm.z + 0.04 - leadZ * 0.25,
    );

    const fingers = Object.fromEntries(
      fingerNames.map((name, index) => {
        const idleBend = Math.sin(time * 1.8 + index * 0.7 + side) * 0.5 + 0.5;
        const curl = clamp(0.12 + idleBend * 0.26 + (1 - speedN) * 0.08, 0.04, 0.56);
        const spread = fingerSpread[name] * side;
        const reach = fingerReach[name] * (1.08 - curl * 0.22 + speedN * 0.16);
        const sweepX = leadX * (0.42 + index * 0.08);
        const sweepY = leadY * (0.4 + index * 0.08);
        const sweepZ = leadZ * (0.35 + index * 0.06);
        const base = vec(
          palm.x + spread * 0.42 + sweepX * 0.18,
          palm.y + 0.04 + index * 0.005 + sweepY * 0.1,
          palm.z,
        );
        const mid = vec(
          base.x + spread * 0.16 + sweepX * 0.55,
          base.y + reach * 0.5 + sweepY * 0.45,
          base.z - 0.04 - curl * 0.07 + sweepZ * 0.45,
        );
        const tip = vec(
          base.x + spread * 0.26 + sweepX,
          base.y + reach + sweepY,
          base.z - 0.08 - curl * 0.13 + sweepZ,
        );
        return [name, { name, base, mid, tip, curl }];
      })
    ) as HandPose['fingers'];

    hands[hand] = {
      handedness: hand,
      wrist,
      palm,
      fingers,
      confidence,
    };
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

