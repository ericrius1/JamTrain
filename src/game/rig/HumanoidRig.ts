import * as THREE from 'three/webgpu';
import type { FingerName, Handedness, PlayerPose } from '../types';
import type { CreatureId } from '../creatures';
import { createCreatureLighting, makeAccentMaterial, type CreatureLighting } from '../creatureShading';
import { Skeleton } from './skeleton';
import { buildHumanHead, type HumanHeadHandles } from './humanHead';
import { buildHumanBody, type HumanBodyHandles } from './humanBody';

export type HumanoidRigOptions = {
  seatIndex: number;
  color: number;
  creature: CreatureId;
};

type HeadHandles = HumanHeadHandles; // expanded in Phase 2 to include lion head
type BodyHandles = HumanBodyHandles; // expanded in Phase 2 to include lion body

export class HumanoidRig {
  readonly root = new THREE.Group();
  private creature: CreatureId;
  private seatIndex: number;
  private seatColor: number;
  private lighting: CreatureLighting;
  private skeleton!: Skeleton;
  private head!: HeadHandles;
  private body!: BodyHandles;
  private accentMaterial!: THREE.MeshBasicNodeMaterial;

  constructor(private scene: THREE.Scene, opts: HumanoidRigOptions) {
    this.seatIndex = opts.seatIndex;
    this.seatColor = opts.color;
    this.creature = opts.creature;
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
    this.skeleton.update(pose, delta);
  }

  getPalmWorld(hand: Handedness): THREE.Vector3 {
    return this.skeleton.getPalmWorld(hand);
  }

  getFingertipWorld(hand: Handedness, finger: FingerName): THREE.Vector3 {
    return this.skeleton.getFingertipWorld(hand, finger);
  }

  getAllFingertips(): THREE.Vector3[] {
    return this.skeleton.getAllFingertips();
  }

  setFingertipNodeVisible(hand: Handedness, finger: FingerName, visible: boolean): void {
    this.skeleton.setFingertipNodeVisible(hand, finger, visible);
  }

  setFingertipNodesVisible(visible: boolean): void {
    this.skeleton.setFingertipNodesVisible(visible);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.teardownCreatureScopedNodes();
  }

  private buildForCreature(): void {
    // Phase 1: only human is supported. Lion case added in Task 12.
    void this.creature;

    this.body = buildHumanBody(this.lighting, this.seatColor);
    this.head = buildHumanHead(this.lighting);
    this.accentMaterial = makeAccentMaterial();

    this.skeleton = new Skeleton(
      {
        clothMaterial: this.body.clothMaterial,
        bodyMaterial: this.body.skinMaterial,
        accentMaterial: this.accentMaterial,
        fingerMaterial: this.body.skinMaterial,
      },
      this.seatIndex
    );

    // Mount body + head on the skeleton's anchors.
    this.skeleton.bodyAnchor.add(this.body.group);
    this.skeleton.headAnchor.add(this.head.group);

    this.root.add(this.skeleton.root);
  }

  private teardownCreatureScopedNodes(): void {
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
    if (this.accentMaterial) this.accentMaterial.dispose();
  }
}
