import * as THREE from 'three/webgpu';
import type { FingerJointName, FingerName, Handedness, PlayerPose, Vec3Data } from '../types';
import type { CreatureId } from '../creatures';
import { makeAccentMaterial } from '../creatureShading';
import { Skeleton } from './skeleton';
import { buildLionHead, type LionHeadHandles } from './lionHead';
import { buildLionBody, type LionBodyHandles } from './lionBody';
import { IllustratedPuppetAvatar } from './IllustratedPuppetAvatar';
import { getIllustratedPuppetSpec } from './illustratedPuppets';

export type HumanoidRigOptions = {
  seatIndex: number;
  creature: CreatureId;
};

export class HumanoidRig {
  readonly root = new THREE.Group();
  private creature: CreatureId;
  private seatIndex: number;
  private skeleton!: Skeleton;
  private head!: LionHeadHandles;
  private body!: LionBodyHandles;
  private illustratedPuppet: IllustratedPuppetAvatar | null = null;
  private accentMaterial!: THREE.MeshBasicNodeMaterial;
  private fingertipNodesVisible = true;
  private elapsed = 0;

  constructor(private scene: THREE.Scene, opts: HumanoidRigOptions) {
    this.seatIndex = opts.seatIndex;
    this.creature = opts.creature;

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
    if (this.illustratedPuppet) this.illustratedPuppet.update(this.skeleton, pose, this.elapsed);
  }

  getPalmWorld(hand: Handedness, target?: THREE.Vector3): THREE.Vector3 {
    return this.skeleton.getPalmWorld(hand, target);
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

  worldToPosePoint(hand: Handedness, point: THREE.Vector3, target?: Vec3Data): Vec3Data {
    return this.skeleton.worldToPosePoint(hand, point, target);
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
    const puppetSpec = getIllustratedPuppetSpec(this.creature);
    if (!puppetSpec) {
      throw new Error(`No illustrated puppet spec for creature '${this.creature}'`);
    }

    this.body = buildLionBody();
    this.head = buildLionHead();
    this.illustratedPuppet = new IllustratedPuppetAvatar(puppetSpec);

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

    // Skeleton segments stay in the scene graph for hand-tracking transforms,
    // but they're hidden — only the illustrated puppet renders.
    this.skeleton.root.visible = false;
    this.root.add(this.illustratedPuppet.group);
    this.root.add(this.skeleton.root);
  }

  private teardownCreatureScopedNodes(): void {
    if (this.illustratedPuppet) {
      this.illustratedPuppet.dispose();
      this.illustratedPuppet = null;
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
    if (this.accentMaterial) this.accentMaterial.dispose();
  }
}
