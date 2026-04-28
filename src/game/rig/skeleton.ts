import * as THREE from 'three/webgpu';
import { handDepthConfig } from '../handDepth';
import { fingerNames, handednesses, type FingerJointName, type FingerName, type HandPose, type Handedness, type PlayerPose, type Vec3Data } from '../types';

type Segment = { mesh: THREE.Mesh; radius: number };

export type ArmJointName = 'shoulder' | 'elbow' | 'wrist' | 'palm';

type FingerRig = {
  base: Segment;
  mid: Segment;
  tip: Segment;
  node: THREE.Mesh;
};

export type HandRig = {
  shoulder: THREE.Vector3;
  upper: Segment;
  lower: Segment;
  palm: THREE.Mesh;
  wristNode: THREE.Mesh;
  fingers: Record<FingerName, FingerRig>;
};

const up = new THREE.Vector3(0, 1, 0);
const tempA = new THREE.Vector3();
const tempB = new THREE.Vector3();
const tempC = new THREE.Vector3();
const tempOffset = new THREE.Vector3();

export type SkeletonOptions = {
  /** Outer-cylinder material for upper-arm cloth (player-color). */
  clothMaterial: THREE.Material;
  /** Skin/fur material for forearm and palm cushion. */
  bodyMaterial: THREE.Material;
  /** Cyan-glow material for wristNode + fingertip nodes. */
  accentMaterial: THREE.Material;
  /** Skin/fur material for finger segments. */
  fingerMaterial: THREE.Material;
};

export class Skeleton {
  readonly root = new THREE.Group();
  /** Anchor where the head mesh attaches. Caller adds a head mesh as a child. */
  readonly headAnchor = new THREE.Group();
  /** Anchor where torso/body mesh sits. */
  readonly bodyAnchor = new THREE.Group();
  readonly hands: Record<Handedness, HandRig>;

  private static readonly BASE_SEAT_DISTANCE = 1.05;
  private seatIndex: number;
  private backOffset = 0;
  private seatZ: number;
  private facing: number;
  private armJointWorld = new Map<string, THREE.Vector3>();
  private fingertipWorld = new Map<string, THREE.Vector3>();
  private fingerJointWorld = new Map<string, THREE.Vector3>();
  private readonly wristScratch = new THREE.Vector3();
  private readonly palmScratch = new THREE.Vector3();
  private readonly fingerBaseScratch = new THREE.Vector3();
  private readonly fingerMidScratch = new THREE.Vector3();
  private readonly fingerTipScratch = new THREE.Vector3();

  constructor(opts: SkeletonOptions, seatIndex: number) {
    this.seatIndex = seatIndex;
    this.seatZ = this.computeSeatZ();
    this.facing = seatIndex === 0 ? -1 : 1;
    this.root.position.set(0, 0, this.seatZ);
    this.root.rotation.y = seatIndex === 0 ? 0 : Math.PI;

    this.bodyAnchor.position.set(0, 0.95, 0);
    this.headAnchor.position.set(0, 1.55, -0.04);
    this.root.add(this.bodyAnchor);
    this.root.add(this.headAnchor);

    this.hands = {
      left: this.createHandRig('left', opts),
      right: this.createHandRig('right', opts),
    };
  }

  setSeatIndex(seatIndex: number): void {
    this.seatIndex = seatIndex;
    this.seatZ = this.computeSeatZ();
    this.facing = seatIndex === 0 ? -1 : 1;
    this.root.position.z = this.seatZ;
    this.root.rotation.y = seatIndex === 0 ? 0 : Math.PI;
  }

  setBackOffset(offset: number): void {
    this.backOffset = offset;
    this.seatZ = this.computeSeatZ();
    this.root.position.z = this.seatZ;
  }

  private computeSeatZ(): number {
    const dir = this.seatIndex === 0 ? 1 : -1;
    return dir * (Skeleton.BASE_SEAT_DISTANCE + this.backOffset);
  }

  update(pose: PlayerPose, _delta: number): void {
    const t = performance.now();
    const breath = Math.sin(t * 0.0018 + pose.seatIndex) * 0.018;
    this.bodyAnchor.position.y = 0.95 + breath;
    this.headAnchor.position.y = 1.55 + breath * 0.7;
    this.headAnchor.rotation.x = Math.sin(t * 0.001 + pose.seatIndex) * 0.04;
    this.headAnchor.rotation.y = (pose.hands.left.palm.x + pose.hands.right.palm.x) * 0.03;

    for (const handedness of handednesses) {
      this.updateHand(handedness, pose.hands[handedness]);
    }
  }

  getPalmWorld(hand: Handedness, target = new THREE.Vector3()): THREE.Vector3 {
    this.hands[hand].wristNode.getWorldPosition(target);
    return target;
  }

  getPalmCenterWorld(hand: Handedness, target = new THREE.Vector3()): THREE.Vector3 {
    this.hands[hand].palm.getWorldPosition(target);
    return target;
  }

  getArmJointWorld(hand: Handedness, joint: ArmJointName, target = new THREE.Vector3()): THREE.Vector3 {
    const source = this.armJointWorld.get(`${hand}:${joint}`);
    return source ? target.copy(source) : target.set(0, 0, 0);
  }

  getFingertipWorld(hand: Handedness, finger: FingerName, target = new THREE.Vector3()): THREE.Vector3 {
    return this.getFingerJointWorld(hand, finger, 'tip', target);
  }

  getFingerJointWorld(
    hand: Handedness,
    finger: FingerName,
    joint: FingerJointName,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    const source = this.fingerJointWorld.get(`${hand}:${finger}:${joint}`);
    return source ? target.copy(source) : target.set(0, 0, 0);
  }

  worldToPosePoint(handedness: Handedness, point: THREE.Vector3, target: Vec3Data = { x: 0, y: 0, z: 0 }): Vec3Data {
    const side = handedness === 'left' ? -1 : 1;
    tempA.copy(point);
    this.root.worldToLocal(tempA);
    target.x = (tempA.x - side * 0.04) / 0.54;
    target.y = (tempA.y - 0.54) / 0.68;
    target.z = (-0.42 - handDepthConfig.worldDepthOffset - tempA.z) / (0.85 * Math.max(0.0001, handDepthConfig.worldDepthScale));
    return target;
  }

  getAllFingertips(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const handedness of handednesses) {
      for (const finger of fingerNames) out.push(this.getFingertipWorld(handedness, finger));
    }
    return out;
  }

  setFingertipNodeVisible(hand: Handedness, finger: FingerName, visible: boolean): void {
    this.hands[hand].fingers[finger].node.visible = visible;
  }

  setFingertipNodesVisible(visible: boolean): void {
    for (const handedness of handednesses) {
      for (const finger of fingerNames) {
        this.setFingertipNodeVisible(handedness, finger, visible);
      }
    }
  }

  private createHandRig(handedness: Handedness, opts: SkeletonOptions): HandRig {
    const side = handedness === 'left' ? -1 : 1;
    const palmGeom = new THREE.SphereGeometry(0.075, 16, 10);
    const wristGeom = new THREE.SphereGeometry(0.045, 12, 8);
    const fingerNodeGeom = new THREE.SphereGeometry(0.033, 12, 8);

    const rig: HandRig = {
      shoulder: new THREE.Vector3(side * 0.28, 1.25, -0.03),
      upper: this.createSegment(0.055, opts.clothMaterial),
      lower: this.createSegment(0.045, opts.bodyMaterial),
      palm: new THREE.Mesh(palmGeom, opts.bodyMaterial),
      wristNode: new THREE.Mesh(wristGeom, opts.accentMaterial),
      fingers: {} as Record<FingerName, FingerRig>,
    };
    rig.palm.scale.set(1.15, 0.72, 0.52);
    this.root.add(rig.upper.mesh, rig.lower.mesh, rig.palm, rig.wristNode);

    for (const finger of fingerNames) {
      const fingerRig: FingerRig = {
        base: this.createSegment(0.018, opts.fingerMaterial),
        mid: this.createSegment(0.015, opts.fingerMaterial),
        tip: this.createSegment(0.012, opts.fingerMaterial),
        node: new THREE.Mesh(fingerNodeGeom, opts.accentMaterial),
      };
      this.root.add(fingerRig.base.mesh, fingerRig.mid.mesh, fingerRig.tip.mesh, fingerRig.node);
      rig.fingers[finger] = fingerRig;
    }

    return rig;
  }

  private createSegment(radius: number, material: THREE.Material): Segment {
    // Slight taper for the limb sleeves: top a bit thicker than bottom.
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.92, radius, 1, 12), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, radius };
  }

  private updateHand(handedness: Handedness, pose: HandPose): void {
    const rig = this.hands[handedness];
    const side = handedness === 'left' ? -1 : 1;
    const shoulder = rig.shoulder;
    const wrist = this.posePointToRig(pose.wrist, side, this.wristScratch);
    const palm = this.posePointToRig(pose.palm, side, this.palmScratch);
    const elbow = tempC.copy(shoulder).lerp(wrist, 0.53).add(tempOffset.set(side * 0.14, 0.08, 0.16));

    this.placeSegment(rig.upper, shoulder, elbow);
    this.placeSegment(rig.lower, elbow, wrist);
    rig.palm.position.copy(palm);
    rig.palm.rotation.set(0.35 * side, 0.2 * side, -0.24 * side);
    rig.wristNode.position.copy(wrist);
    this.setArmJointWorld(handedness, 'shoulder', shoulder);
    this.setArmJointWorld(handedness, 'elbow', elbow);
    this.setArmJointWorld(handedness, 'wrist', wrist);
    this.setArmJointWorld(handedness, 'palm', palm);

    for (const finger of fingerNames) {
      const fingerPose = pose.fingers[finger];
      const base = this.posePointToRig(fingerPose.base, side, this.fingerBaseScratch);
      const mid = this.posePointToRig(fingerPose.mid, side, this.fingerMidScratch);
      const tip = this.posePointToRig(fingerPose.tip, side, this.fingerTipScratch);
      const curlOffset = fingerPose.curl * 0.065 * this.facing;
      mid.z += curlOffset;
      tip.z += curlOffset * 1.5;

      const fingerRig = rig.fingers[finger];
      this.placeSegment(fingerRig.base, palm, base);
      this.placeSegment(fingerRig.mid, base, mid);
      this.placeSegment(fingerRig.tip, mid, tip);
      fingerRig.node.position.copy(tip);

      this.setFingerJointWorld(handedness, finger, 'base', base);
      this.setFingerJointWorld(handedness, finger, 'mid', mid);
      this.setFingerJointWorld(handedness, finger, 'tip', tip);
    }
  }

  private setFingerJointWorld(
    handedness: Handedness,
    finger: FingerName,
    joint: FingerJointName,
    point: THREE.Vector3,
  ): void {
    const jointKey = `${handedness}:${finger}:${joint}`;
    let world = this.fingerJointWorld.get(jointKey);
    if (!world) {
      world = new THREE.Vector3();
      this.fingerJointWorld.set(jointKey, world);
      if (joint === 'tip') this.fingertipWorld.set(`${handedness}:${finger}`, world);
    }
    world.copy(point);
    this.root.localToWorld(world);
  }

  private setArmJointWorld(handedness: Handedness, joint: ArmJointName, point: THREE.Vector3): void {
    const key = `${handedness}:${joint}`;
    let world = this.armJointWorld.get(key);
    if (!world) {
      world = new THREE.Vector3();
      this.armJointWorld.set(key, world);
    }
    world.copy(point);
    this.root.localToWorld(world);
  }

  private posePointToRig(point: Vec3Data, side: number, target: THREE.Vector3): THREE.Vector3 {
    return target.set(
      point.x * 0.54 + side * 0.04,
      0.54 + point.y * 0.68,
      -0.42 - point.z * 0.85 * handDepthConfig.worldDepthScale - handDepthConfig.worldDepthOffset
    );
  }

  private placeSegment(segment: Segment, a: THREE.Vector3, b: THREE.Vector3): void {
    tempA.copy(b).sub(a);
    const length = Math.max(tempA.length(), 0.001);
    segment.mesh.position.copy(a).addScaledVector(tempA, 0.5);
    segment.mesh.scale.set(1, length, 1);
    segment.mesh.quaternion.setFromUnitVectors(up, tempB.copy(tempA).normalize());
  }
}
