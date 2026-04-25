import * as THREE from 'three/webgpu';
import { clamp, damp, toThree } from './math';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type PlayerPose, type Vec3Data } from './types';

type Segment = {
  mesh: THREE.Mesh;
  radius: number;
};

type FingerRig = {
  base: Segment;
  mid: Segment;
  tip: Segment;
  node: THREE.Mesh;
};

type HandRig = {
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
const tempColor = new THREE.Color();

export class PlayerRig {
  readonly root = new THREE.Group();
  private body: THREE.Mesh;
  private head: THREE.Mesh;
  private face: THREE.Group;
  private robotBits: THREE.Group;
  private hands: Record<Handedness, HandRig>;
  private robotBlend = 0;
  private fingertipWorld = new Map<string, THREE.Vector3>();
  private skinMaterial = new THREE.MeshStandardMaterial({ color: 0xf1b992, roughness: 0.58, metalness: 0.02 });
  private clothMaterial: THREE.MeshStandardMaterial;
  private robotMaterial = new THREE.MeshStandardMaterial({ color: 0x9eb6c4, roughness: 0.28, metalness: 0.65 });
  private nodeMaterial = new THREE.MeshStandardMaterial({ color: 0x7ef2ff, emissive: 0x0d7888, emissiveIntensity: 1.2, roughness: 0.18 });
  private eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x111820, emissive: 0x9ef5ff, emissiveIntensity: 0.3 });
  private mouthMaterial = new THREE.MeshStandardMaterial({ color: 0x30313a, emissive: 0x30161a, emissiveIntensity: 0.2 });
  private seatZ: number;
  private facing: number;

  constructor(
    private scene: THREE.Scene,
    options: { seatIndex: number; color: number; robot?: boolean }
  ) {
    this.seatZ = options.seatIndex === 0 ? 1.32 : -1.32;
    this.facing = options.seatIndex === 0 ? -1 : 1;
    this.root.position.set(0, 0, this.seatZ);
    this.root.rotation.y = options.seatIndex === 0 ? 0 : Math.PI;
    this.clothMaterial = new THREE.MeshStandardMaterial({ color: options.color, roughness: 0.64, metalness: 0.04 });
    this.robotBlend = options.robot ? 1 : 0;

    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.58, 8, 16), this.clothMaterial);
    this.body.position.set(0, 0.95, 0);
    this.body.scale.set(0.86, 1, 0.72);
    this.root.add(this.body);

    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 28, 18), this.skinMaterial);
    this.head.position.set(0, 1.55, -0.04);
    this.head.scale.set(0.92, 1.08, 0.9);
    this.root.add(this.head);

    this.face = this.createFace();
    this.head.add(this.face);
    this.robotBits = this.createRobotBits();
    this.root.add(this.robotBits);

    this.hands = {
      left: this.createHandRig('left'),
      right: this.createHandRig('right'),
    };

    this.scene.add(this.root);
    this.applyRobotBlend(1);
  }

  update(pose: PlayerPose, delta: number, robotTarget: number): void {
    this.robotBlend = damp(this.robotBlend, robotTarget, 4.5, delta);
    this.applyRobotBlend(delta);

    const breath = Math.sin(performance.now() * 0.0018 + pose.seatIndex) * 0.018;
    this.body.position.y = 0.95 + breath;
    this.head.position.y = 1.55 + breath * 0.7;
    this.head.rotation.x = Math.sin(performance.now() * 0.001 + pose.seatIndex) * 0.04;
    this.head.rotation.y = (pose.hands.left.palm.x + pose.hands.right.palm.x) * 0.03;

    for (const handedness of handednesses) {
      this.updateHand(handedness, pose.hands[handedness], delta);
    }
  }

  getFingertipWorld(hand: Handedness, finger: FingerName): THREE.Vector3 {
    return this.fingertipWorld.get(`${hand}:${finger}`)?.clone() ?? new THREE.Vector3();
  }

  getAllFingertips(): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (const handedness of handednesses) {
      for (const finger of fingerNames) points.push(this.getFingertipWorld(handedness, finger));
    }
    return points;
  }

  private createFace(): THREE.Group {
    const group = new THREE.Group();
    const eyeGeometry = new THREE.SphereGeometry(0.028, 12, 8);
    const leftEye = new THREE.Mesh(eyeGeometry, this.eyeMaterial);
    const rightEye = new THREE.Mesh(eyeGeometry, this.eyeMaterial);
    leftEye.position.set(-0.07, 0.03, -0.2);
    rightEye.position.set(0.07, 0.03, -0.2);
    group.add(leftEye, rightEye);

    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.016, 0.012), this.mouthMaterial);
    mouth.position.set(0, -0.075, -0.205);
    group.add(mouth);
    return group;
  }

  private createRobotBits(): THREE.Group {
    const group = new THREE.Group();
    const panelMaterial = new THREE.MeshStandardMaterial({
      color: 0xc9e6ef,
      emissive: 0x163c45,
      emissiveIntensity: 0.7,
      roughness: 0.22,
      metalness: 0.74,
      transparent: true,
      opacity: 0,
    });

    const chestPanel = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.026), panelMaterial);
    chestPanel.position.set(0, 1.08, -0.32);
    group.add(chestPanel);

    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 8), panelMaterial);
    antenna.position.set(0, 1.88, -0.04);
    group.add(antenna);

    const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), panelMaterial);
    antennaTip.position.set(0, 2, -0.04);
    group.add(antennaTip);
    return group;
  }

  private createHandRig(handedness: Handedness): HandRig {
    const side = handedness === 'left' ? -1 : 1;
    const rig: HandRig = {
      shoulder: new THREE.Vector3(side * 0.28, 1.25, -0.03),
      upper: this.createSegment(0.055, this.clothMaterial),
      lower: this.createSegment(0.045, this.skinMaterial),
      palm: new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 10), this.skinMaterial),
      wristNode: new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), this.nodeMaterial),
      fingers: {} as Record<FingerName, FingerRig>,
    };
    rig.palm.scale.set(1.15, 0.72, 0.52);
    this.root.add(rig.upper.mesh, rig.lower.mesh, rig.palm, rig.wristNode);

    for (const finger of fingerNames) {
      const fingerRig: FingerRig = {
        base: this.createSegment(0.018, this.skinMaterial),
        mid: this.createSegment(0.015, this.skinMaterial),
        tip: this.createSegment(0.012, this.skinMaterial),
        node: new THREE.Mesh(new THREE.SphereGeometry(0.033, 12, 8), this.nodeMaterial),
      };
      this.root.add(fingerRig.base.mesh, fingerRig.mid.mesh, fingerRig.tip.mesh, fingerRig.node);
      rig.fingers[finger] = fingerRig;
    }

    return rig;
  }

  private createSegment(radius: number, material: THREE.Material): Segment {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 12), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, radius };
  }

  private updateHand(handedness: Handedness, pose: HandPose, _delta: number): void {
    const rig = this.hands[handedness];
    const side = handedness === 'left' ? -1 : 1;
    const shoulder = rig.shoulder;
    const wrist = this.posePointToRig(pose.wrist, side);
    const palm = this.posePointToRig(pose.palm, side);
    const elbow = tempC
      .copy(shoulder)
      .lerp(wrist, 0.53)
      .add(new THREE.Vector3(side * 0.14, 0.08, 0.16));

    this.placeSegment(rig.upper, shoulder, elbow);
    this.placeSegment(rig.lower, elbow, wrist);
    rig.palm.position.copy(palm);
    rig.palm.rotation.set(0.35 * side, 0.2 * side, -0.24 * side);
    rig.wristNode.position.copy(wrist);

    for (const finger of fingerNames) {
      const fingerPose = pose.fingers[finger];
      const base = this.posePointToRig(fingerPose.base, side);
      const mid = this.posePointToRig(fingerPose.mid, side);
      const tip = this.posePointToRig(fingerPose.tip, side);
      const curlOffset = fingerPose.curl * 0.065 * this.facing;
      mid.z += curlOffset;
      tip.z += curlOffset * 1.5;

      const fingerRig = rig.fingers[finger];
      this.placeSegment(fingerRig.base, palm, base);
      this.placeSegment(fingerRig.mid, base, mid);
      this.placeSegment(fingerRig.tip, mid, tip);
      fingerRig.node.position.copy(tip);

      const world = tip.clone();
      this.root.localToWorld(world);
      this.fingertipWorld.set(`${handedness}:${finger}`, world);
    }
  }

  private posePointToRig(point: Vec3Data, side: number): THREE.Vector3 {
    return new THREE.Vector3(
      point.x * 0.54 + side * 0.04,
      0.54 + point.y * 0.68,
      -0.42 - point.z * 1.05
    );
  }

  private placeSegment(segment: Segment, a: THREE.Vector3, b: THREE.Vector3): void {
    tempA.copy(b).sub(a);
    const length = Math.max(tempA.length(), 0.001);
    segment.mesh.position.copy(a).addScaledVector(tempA, 0.5);
    segment.mesh.scale.set(1, length, 1);
    segment.mesh.quaternion.setFromUnitVectors(up, tempB.copy(tempA).normalize());
  }

  private applyRobotBlend(_delta: number): void {
    const robot = clamp(this.robotBlend);
    tempColor.set(0xf1b992).lerp(new THREE.Color(0xa9c4cf), robot);
    this.skinMaterial.color.copy(tempColor);
    this.skinMaterial.metalness = robot * 0.35;
    this.skinMaterial.roughness = 0.58 - robot * 0.22;

    tempColor.set(this.clothMaterial.color).lerp(new THREE.Color(0x6f8491), robot * 0.2);
    this.body.scale.set(0.86 + robot * 0.08, 1, 0.72 + robot * 0.04);
    this.head.scale.set(0.92 + robot * 0.14, 1.08 - robot * 0.12, 0.9 + robot * 0.08);
    this.robotMaterial.color.set(0x9eb6c4);

    this.robotBits.traverse((child: THREE.Object3D) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.material) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.opacity = robot;
      mesh.visible = robot > 0.02;
    });

    this.eyeMaterial.emissiveIntensity = 0.3 + robot * 1.7;
    this.nodeMaterial.emissiveIntensity = 1.1 + robot * 0.9;
  }
}
