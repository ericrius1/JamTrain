import * as THREE from 'three/webgpu';
import type { FingerJointName, FingerName, Handedness, PlayerPose } from '../types';
import type { CreatureId } from '../creatures';
import { createCreatureLighting, makeAccentMaterial, type CreatureLighting } from '../creatureShading';
import { Skeleton } from './skeleton';
import { buildHumanHead, type HumanHeadHandles } from './humanHead';
import { buildHumanBody, type HumanBodyHandles } from './humanBody';
import { buildLionHead, type LionHeadHandles } from './lionHead';
import { buildLionMane, type LionManeHandles } from './lionMane';
import { buildLionTail, type LionTailHandles } from './lionTail';
import { buildLionBody, type LionBodyHandles } from './lionBody';
import { OtterAvatar } from './otterAvatar';

export type HumanoidRigOptions = {
  seatIndex: number;
  color: number;
  creature: CreatureId;
};

type HeadHandles = HumanHeadHandles | LionHeadHandles;
type BodyHandles = HumanBodyHandles | LionBodyHandles;

export class HumanoidRig {
  readonly root = new THREE.Group();
  private creature: CreatureId;
  private seatIndex: number;
  private seatColor: number;
  private readonly otterLightLayer: number;
  private lighting: CreatureLighting;
  private skeleton!: Skeleton;
  private head!: HeadHandles;
  private body!: BodyHandles;
  private mane: LionManeHandles | null = null;
  private tail: LionTailHandles | null = null;
  private otter: OtterAvatar | null = null;
  private accentMaterial!: THREE.MeshBasicNodeMaterial;
  private fingertipNodesVisible = true;
  private elapsed = 0;

  constructor(private scene: THREE.Scene, opts: HumanoidRigOptions) {
    this.seatIndex = opts.seatIndex;
    this.seatColor = opts.color;
    this.creature = opts.creature;
    this.otterLightLayer = opts.seatIndex === 0 ? 2 : 3;
    this.lighting = createCreatureLighting();

    this.buildForCreature();
    this.scene.add(this.root);
  }

  setCreature(id: CreatureId): void {
    if (id === this.creature) return;
    this.creature = id;
    this.teardownCreatureScopedNodes();
    this.buildForCreature();
  }

  setSeatIndex(seatIndex: number): void {
    this.seatIndex = seatIndex;
    this.skeleton.setSeatIndex(seatIndex);
  }

  setBackOffset(offset: number): void {
    this.skeleton.setBackOffset(offset);
  }

  update(pose: PlayerPose, delta: number, _robotTarget: number): void {
    void _robotTarget; // robot overlay was dropped — ignored, kept for caller compat.
    this.elapsed += delta;
    this.skeleton.update(pose, delta);
    if (this.tail) this.tail.update(this.elapsed);
    if (this.otter) this.otter.update(this.skeleton, pose, this.elapsed);
  }

  getPalmWorld(hand: Handedness): THREE.Vector3 {
    return this.skeleton.getPalmWorld(hand);
  }

  getPalmCenterWorld(hand: Handedness, target?: THREE.Vector3): THREE.Vector3 {
    return this.skeleton.getPalmCenterWorld(hand, target);
  }

  getFingertipWorld(hand: Handedness, finger: FingerName, target?: THREE.Vector3): THREE.Vector3 {
    return this.skeleton.getFingertipWorld(hand, finger, target);
  }

  getFingerJointWorld(
    hand: Handedness,
    finger: FingerName,
    joint: FingerJointName,
    target?: THREE.Vector3,
  ): THREE.Vector3 {
    return this.skeleton.getFingerJointWorld(hand, finger, joint, target);
  }

  getAllFingertips(): THREE.Vector3[] {
    return this.skeleton.getAllFingertips();
  }

  setFingertipNodeVisible(hand: Handedness, finger: FingerName, visible: boolean): void {
    this.skeleton.setFingertipNodeVisible(hand, finger, visible);
  }

  setFingertipNodesVisible(visible: boolean): void {
    this.fingertipNodesVisible = visible;
    this.skeleton.setFingertipNodesVisible(visible);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.teardownCreatureScopedNodes();
  }

  private buildForCreature(): void {
    this.accentMaterial = makeAccentMaterial();

    if (this.creature === 'lion') {
      this.body = buildLionBody(this.lighting);
      this.head = buildLionHead(this.lighting);
      this.mane = buildLionMane(this.lighting, this.seatColor, this.seatIndex);
      this.tail = buildLionTail(this.lighting, this.seatColor);
      this.otter = null;
    } else if (this.creature === 'otter') {
      this.body = buildLionBody(this.lighting);
      this.head = buildLionHead(this.lighting);
      this.mane = null;
      this.tail = null;
      this.otter = new OtterAvatar(this.otterLightLayer);
    } else {
      this.body = buildHumanBody(this.lighting, this.seatColor);
      this.head = buildHumanHead(this.lighting);
      this.mane = null;
      this.tail = null;
      this.otter = null;
    }

    this.skeleton = new Skeleton(
      {
        clothMaterial: this.body.clothMaterial,
        bodyMaterial: this.body.skinMaterial,
        accentMaterial: this.accentMaterial,
        fingerMaterial: this.body.skinMaterial,
      },
      this.seatIndex
    );

    this.skeleton.setFingertipNodesVisible(this.fingertipNodesVisible);

    if (this.otter) {
      this.skeleton.root.visible = false;
      this.root.add(this.otter.group);
    } else {
      this.skeleton.bodyAnchor.add(this.body.group);
      this.skeleton.headAnchor.add(this.head.group);
      if (this.mane) this.skeleton.headAnchor.add(this.mane.group);
      if (this.tail) this.skeleton.bodyAnchor.add(this.tail.group);
    }

    this.root.add(this.skeleton.root);
  }

  private teardownCreatureScopedNodes(): void {
    if (this.otter) {
      this.otter.dispose();
      this.otter = null;
    }
    if (this.skeleton) {
      this.root.remove(this.skeleton.root);
      this.skeleton.root.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    if (this.body) {
      for (const g of this.body.geometries) g.dispose();
      for (const m of this.body.materials) m.dispose();
    }
    if (this.head) {
      for (const g of this.head.geometries) g.dispose();
      for (const m of this.head.materials) m.dispose();
    }
    if (this.mane) {
      for (const g of this.mane.geometries) g.dispose();
      for (const m of this.mane.materials) m.dispose();
    }
    if (this.tail) {
      for (const g of this.tail.geometries) g.dispose();
      for (const m of this.tail.materials) m.dispose();
    }
    if (this.accentMaterial) this.accentMaterial.dispose();
    this.mane = null;
    this.tail = null;
  }
}
