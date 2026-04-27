export type Handedness = 'left' | 'right';

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
export type FingerJointName = 'base' | 'mid' | 'tip';

export const fingerNames: FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const fingerJointNames: FingerJointName[] = ['base', 'mid', 'tip'];
export const handednesses: Handedness[] = ['left', 'right'];

export type Vec3Data = {
  x: number;
  y: number;
  z: number;
};

export type FingerPose = {
  name: FingerName;
  base: Vec3Data;
  mid: Vec3Data;
  tip: Vec3Data;
  curl: number;
};

export type HandPose = {
  handedness: Handedness;
  wrist: Vec3Data;
  palm: Vec3Data;
  fingers: Record<FingerName, FingerPose>;
  confidence: number;
};

export type PlayerPose = {
  id: string;
  displayName: string;
  roomId: string;
  seatIndex: number;
  hands: Record<Handedness, HandPose>;
  energy: number;
  isRobot: boolean;
  updatedAt: number;
};

export type LinkSample = {
  from: Vec3Data;
  to: Vec3Data;
  finger: FingerName;
  hand: Handedness;
  tension: number;
};

export type ConnectionState = 'local' | 'connecting' | 'spacetime' | 'offline';
