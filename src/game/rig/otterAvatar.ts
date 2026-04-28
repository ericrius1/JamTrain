import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FingerName, Handedness, PlayerPose } from '../types';
import type { Skeleton } from './skeleton';

type RestTransform = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

type AimHandle = {
  bone: THREE.Bone;
  axis: THREE.Vector3;
  restDir: THREE.Vector3;
  restQuaternion: THREE.Quaternion;
  restScale: THREE.Vector3;
  restLength: number;
};

type ArmHandles = {
  upper: AimHandle;
  forearm: AimHandle;
  hand: AimHandle;
};

const OTTER_URL = '/otter.glb';
const OTTER_SCALE = 1.36;
const OTTER_Y = 0.93;
const OTTER_Z = -0.04;
const MIDDLE_FINGER: FingerName = 'middle';

export class OtterAvatar {
  readonly group = new THREE.Group();

  private model: THREE.Object3D | null = null;
  private bones = new Map<string, THREE.Bone>();
  private rests = new Map<THREE.Object3D, RestTransform>();
  private arms: Record<Handedness, ArmHandles> | null = null;
  private disposed = false;
  private loadGeneration = 0;

  private readonly targetWorld = new THREE.Vector3();
  private readonly targetParent = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly swing = new THREE.Quaternion();
  private readonly targetQuaternion = new THREE.Quaternion();
  private readonly eulerOffset = new THREE.Euler();

  constructor(private readonly lightLayer: number) {
    this.group.name = 'Otter avatar';
    this.group.visible = false;
    this.group.add(
      this.createLocalBounce(),
      this.createLocalLight(
        'Otter soft fill',
        0xffc987,
        0.46,
        2.15,
        1.75,
        new THREE.Vector3(0.52, 1.52, 0.48),
      ),
      this.createLocalLight(
        'Otter rim light',
        0xffd49a,
        0.95,
        1.8,
        2.0,
        new THREE.Vector3(-0.72, 1.58, 0.12),
      ),
    );
    this.load();
  }

  update(skeleton: Skeleton, pose: PlayerPose, elapsed: number): void {
    this.syncToSkeletonRoot(skeleton);
    if (!this.model || !this.arms) return;

    this.restoreRestPose();
    this.applyBodyMotion(pose, elapsed);
    this.group.updateMatrixWorld(true);

    this.retargetHand('left', skeleton);
    this.retargetHand('right', skeleton);
  }

  dispose(): void {
    this.disposed = true;
    this.loadGeneration += 1;
    this.group.parent?.remove(this.group);
    if (this.model) this.disposeObject(this.model);
    this.group.clear();
    this.model = null;
    this.bones.clear();
    this.rests.clear();
    this.arms = null;
  }

  private load(): void {
    const generation = ++this.loadGeneration;
    const loader = new GLTFLoader();
    loader.load(
      OTTER_URL,
      gltf => {
        if (this.disposed || generation !== this.loadGeneration) {
          this.disposeObject(gltf.scene as unknown as THREE.Object3D);
          return;
        }

        const model = gltf.scene as unknown as THREE.Object3D;
        model.name = 'Otter GLB';
        model.position.set(0, OTTER_Y, OTTER_Z);
        model.rotation.y = Math.PI / 2;
        model.scale.setScalar(OTTER_SCALE);

        this.model = model;
        this.group.add(model);
        this.configureMeshes(model);
        this.captureBones(model);
        this.group.visible = this.arms !== null;
      },
      undefined,
      error => {
        console.warn('[otter] failed to load otter.glb', error);
      }
    );
  }

  private syncToSkeletonRoot(skeleton: Skeleton): void {
    this.group.position.copy(skeleton.root.position);
    this.group.quaternion.copy(skeleton.root.quaternion);
    this.group.scale.copy(skeleton.root.scale);
    this.group.updateMatrixWorld(true);
  }

  private configureMeshes(root: THREE.Object3D): void {
    root.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.layers.enable(this.lightLayer);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    });
  }

  private createLocalBounce(): THREE.HemisphereLight {
    const light = new THREE.HemisphereLight(0xffc98b, 0x24120c, 0.18);
    light.name = 'Otter local bounce';
    light.layers.set(this.lightLayer);
    return light;
  }

  private createLocalLight(
    name: string,
    color: THREE.ColorRepresentation,
    intensity: number,
    distance: number,
    decay: number,
    position: THREE.Vector3,
  ): THREE.PointLight {
    const light = new THREE.PointLight(color, intensity, distance, decay);
    light.name = name;
    light.position.copy(position);
    light.layers.set(this.lightLayer);
    return light;
  }

  private captureBones(root: THREE.Object3D): void {
    this.bones.clear();
    this.rests.clear();

    root.traverse(child => {
      this.rests.set(child, {
        position: child.position.clone(),
        quaternion: child.quaternion.clone(),
        scale: child.scale.clone(),
      });

      const bone = child as THREE.Bone;
      if (bone.isBone && bone.name) {
        this.bones.set(bone.name, bone);
        const originalName = child.userData?.name;
        if (typeof originalName === 'string' && originalName) {
          this.bones.set(originalName, bone);
        }
      }
    });

    const left = this.createArmHandles('left');
    const right = this.createArmHandles('right');
    this.arms = left && right ? { left, right } : null;

    if (!this.arms) {
      console.warn('[otter] otter.glb loaded, but required arm bones were not found');
    }
  }

  private createArmHandles(hand: Handedness): ArmHandles | null {
    const suffix = hand === 'left' ? 'L' : 'R';
    const upper = this.createAimHandle(`UpperArm.${suffix}`);
    const forearm = this.createAimHandle(`Forearm.${suffix}`);
    const handBone = this.createAimHandle(`Hand.${suffix}`, new THREE.Vector3(0, 1, 0), 0.15);
    if (!upper || !forearm || !handBone) return null;
    return { upper, forearm, hand: handBone };
  }

  private createAimHandle(name: string, fallbackAxis?: THREE.Vector3, fallbackLength = 0.2): AimHandle | null {
    const bone = this.bones.get(name);
    if (!bone) return null;
    const rest = this.rests.get(bone);
    if (!rest) return null;

    const childBone = bone.children.find(child => (child as THREE.Bone).isBone) as THREE.Bone | undefined;
    const axis = childBone
      ? childBone.position.clone()
      : (fallbackAxis ? fallbackAxis.clone() : new THREE.Vector3(0, 1, 0));
    const restLength = Math.max(axis.length(), fallbackLength, 0.001);
    axis.normalize();

    const restDir = axis.clone().applyQuaternion(rest.quaternion).normalize();
    return {
      bone,
      axis,
      restDir,
      restQuaternion: rest.quaternion.clone(),
      restScale: rest.scale.clone(),
      restLength,
    };
  }

  private restoreRestPose(): void {
    for (const [object, rest] of this.rests) {
      object.position.copy(rest.position);
      object.quaternion.copy(rest.quaternion);
      object.scale.copy(rest.scale);
    }
  }

  private applyBodyMotion(pose: PlayerPose, elapsed: number): void {
    const body = this.bones.get('Body');
    const head = this.bones.get('Head');
    const bodyRest = body ? this.rests.get(body) : undefined;
    const headRest = head ? this.rests.get(head) : undefined;
    const handMidX = (pose.hands.left.palm.x + pose.hands.right.palm.x) * 0.5;
    const handEnergy = pose.energy;

    if (body && bodyRest) {
      body.position.y = bodyRest.position.y + Math.sin(elapsed * 1.7 + pose.seatIndex) * 0.012;
      this.eulerOffset.set(
        Math.sin(elapsed * 1.15 + pose.seatIndex) * 0.025,
        THREE.MathUtils.clamp(handMidX * 0.07, -0.08, 0.08),
        Math.sin(elapsed * 1.4) * 0.018,
      );
      body.quaternion.copy(bodyRest.quaternion).multiply(this.targetQuaternion.setFromEuler(this.eulerOffset));
    }

    if (head && headRest) {
      this.eulerOffset.set(
        Math.sin(elapsed * 1.25 + pose.seatIndex) * 0.055 - THREE.MathUtils.clamp(handEnergy * 0.035, 0, 0.08),
        THREE.MathUtils.clamp(handMidX * 0.18, -0.18, 0.18),
        Math.sin(elapsed * 1.9) * 0.025,
      );
      head.quaternion.copy(headRest.quaternion).multiply(this.targetQuaternion.setFromEuler(this.eulerOffset));
    }
  }

  private retargetHand(hand: Handedness, skeleton: Skeleton): void {
    if (!this.arms) return;
    const arm = this.arms[hand];

    this.aimAt(arm.upper, skeleton.getArmJointWorld(hand, 'elbow', this.targetWorld), 0.74, 1.34);
    this.aimAt(arm.forearm, skeleton.getArmJointWorld(hand, 'wrist', this.targetWorld), 0.72, 1.38);

    const palm = skeleton.getArmJointWorld(hand, 'palm', this.targetWorld);
    const fingertip = skeleton.getFingertipWorld(hand, MIDDLE_FINGER, this.targetParent);
    this.targetWorld.copy(palm).lerp(fingertip, 0.45);
    this.aimAt(arm.hand, this.targetWorld, 0.82, 1.22);
  }

  private aimAt(handle: AimHandle, targetWorld: THREE.Vector3, minScale: number, maxScale: number): void {
    const bone = handle.bone;
    const parent = bone.parent;
    if (!parent) return;

    parent.updateWorldMatrix(true, false);
    this.targetParent.copy(targetWorld);
    parent.worldToLocal(this.targetParent);
    this.direction.copy(this.targetParent).sub(bone.position);
    const length = this.direction.length();
    if (length < 0.001) return;

    this.direction.multiplyScalar(1 / length);
    this.swing.setFromUnitVectors(handle.restDir, this.direction);
    this.targetQuaternion.copy(this.swing).multiply(handle.restQuaternion);
    bone.quaternion.copy(this.targetQuaternion);
    bone.scale.copy(handle.restScale);
    bone.scale.y *= THREE.MathUtils.clamp(length / handle.restLength, minScale, maxScale);
  }

  private disposeObject(root: THREE.Object3D): void {
    root.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      this.disposeMaterial(mesh.material as THREE.Material | THREE.Material[] | undefined);
    });
  }

  private disposeMaterial(material: THREE.Material | THREE.Material[] | undefined): void {
    if (!material) return;
    if (Array.isArray(material)) {
      for (const item of material) this.disposeMaterial(item);
      return;
    }
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
      const value = (material as unknown as Record<string, unknown>)[key];
      if (value && (value as THREE.Texture).isTexture) {
        (value as THREE.Texture).dispose();
      }
    }
    material.dispose();
  }
}
