import * as THREE from 'three/webgpu';
import type { Handedness, PlayerPose } from '../types';
import type { Skeleton } from './skeleton';

type PuppetPart = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.Texture;
};

type ArmParts = {
  upper: PuppetPart;
  forearm: PuppetPart;
  paw: PuppetPart;
};

const ASSET_ROOT = '/puppets/lion';
const BODY_HEIGHT = 1.28;
const BODY_WIDTH = BODY_HEIGHT * (876 / 965);
const UPPER_WIDTH = 0.18;
const FOREARM_WIDTH = 0.15;
const PAW_WIDTH = 0.24;
const CAMERA_DEPTH = 0.03;

const shoulderAnchors: Record<Handedness, THREE.Vector3> = {
  left: new THREE.Vector3(CAMERA_DEPTH - 0.018, 0.90, 0.16),
  right: new THREE.Vector3(CAMERA_DEPTH + 0.018, 0.82, 0.10),
};

export class IllustratedLionAvatar {
  readonly group = new THREE.Group();

  private readonly loader = new THREE.TextureLoader();
  private readonly parts: PuppetPart[] = [];
  private readonly contactShadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly contactShadowTexture: THREE.CanvasTexture;
  private readonly arms: Record<Handedness, ArmParts>;
  private readonly targetWorld = new THREE.Vector3();
  private readonly targetLocal = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly palm = new THREE.Vector3();

  constructor() {
    this.group.name = 'Illustrated lion avatar';
    this.group.visible = false;

    const body = this.createPart(`${ASSET_ROOT}/body.png`, BODY_WIDTH, 965 / 876, 10);
    body.mesh.name = 'Illustrated lion body';
    body.mesh.position.set(CAMERA_DEPTH, 0.78, -0.02);

    this.contactShadowTexture = this.createContactShadowTexture();
    this.contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.12, 0.42),
      new THREE.MeshBasicMaterial({
        map: this.contactShadowTexture,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        opacity: 0.42,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.contactShadow.name = 'Illustrated lion contact shadow';
    this.contactShadow.position.set(CAMERA_DEPTH - 0.006, 0.34, -0.04);
    this.contactShadow.rotation.y = Math.PI / 2;
    this.contactShadow.renderOrder = 9;
    this.contactShadow.frustumCulled = false;
    this.group.add(this.contactShadow);

    this.group.add(body.mesh);

    this.arms = {
      left: this.createArm('left', 11),
      right: this.createArm('right', 14),
    };
  }

  update(skeleton: Skeleton, pose: PlayerPose, elapsed: number): void {
    void pose;
    this.syncToSkeletonRoot(skeleton);
    const breath = Math.sin(elapsed * 1.35) * 0.012;
    this.group.position.y += breath;

    this.updateArm('left', skeleton);
    this.updateArm('right', skeleton);
    this.group.visible = true;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const part of this.parts) {
      part.mesh.geometry.dispose();
      part.mesh.material.dispose();
      part.texture.dispose();
    }
    this.contactShadow.geometry.dispose();
    this.contactShadow.material.dispose();
    this.contactShadowTexture.dispose();
    this.group.clear();
  }

  private createContactShadowTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(128, 72, 8, 128, 72, 116);
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
      gradient.addColorStop(0.48, 'rgba(0, 0, 0, 0.34)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private createArm(hand: Handedness, renderOrder: number): ArmParts {
    const upper = this.createPart(`${ASSET_ROOT}/upper-arm.png`, UPPER_WIDTH, 418 / 267, renderOrder);
    const forearm = this.createPart(`${ASSET_ROOT}/forearm.png`, FOREARM_WIDTH, 435 / 240, renderOrder + 1);
    const paw = this.createPart(`${ASSET_ROOT}/paw-cupped.png`, PAW_WIDTH, 237 / 284, renderOrder + 2);

    upper.mesh.name = `Illustrated lion ${hand} upper arm`;
    forearm.mesh.name = `Illustrated lion ${hand} forearm`;
    paw.mesh.name = `Illustrated lion ${hand} paw`;
    paw.mesh.position.x += hand === 'left' ? 0.018 : 0.028;

    this.group.add(upper.mesh, forearm.mesh, paw.mesh);
    return { upper, forearm, paw };
  }

  private createPart(url: string, worldWidth: number, aspect: number, renderOrder: number): PuppetPart {
    const texture = this.loader.load(url, tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    });
    texture.colorSpace = THREE.SRGBColorSpace;

    const geometry = new THREE.PlaneGeometry(worldWidth, worldWidth * aspect);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      color: 0xf0d5b6,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.025,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.y = Math.PI / 2;
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;

    const part = { mesh, texture };
    this.parts.push(part);
    return part;
  }

  private syncToSkeletonRoot(skeleton: Skeleton): void {
    this.group.position.copy(skeleton.root.position);
    this.group.quaternion.copy(skeleton.root.quaternion);
    this.group.scale.copy(skeleton.root.scale);
    this.group.updateMatrixWorld(true);
  }

  private updateArm(hand: Handedness, skeleton: Skeleton): void {
    const arm = this.arms[hand];
    const shoulder = shoulderAnchors[hand];
    skeleton.getArmJointWorld(hand, 'palm', this.targetWorld);
    this.targetLocal.copy(this.targetWorld);
    this.group.worldToLocal(this.targetLocal);

    const sideBias = hand === 'left' ? -0.03 : 0.07;
    this.palm.set(
      CAMERA_DEPTH + sideBias * 0.16,
      THREE.MathUtils.clamp(this.targetLocal.y * 0.72 + 0.16, 0.68, 1.04),
      THREE.MathUtils.clamp(this.targetLocal.z * 0.72 - 0.02, -0.58, -0.08),
    );

    this.elbow.copy(shoulder).lerp(this.palm, 0.48);
    this.elbow.x += hand === 'left' ? -0.010 : 0.010;
    this.elbow.y += hand === 'left' ? 0.10 : 0.06;
    this.elbow.z += hand === 'left' ? 0.04 : 0.02;

    this.placeSegment(arm.upper.mesh, shoulder, this.elbow, UPPER_WIDTH);
    this.placeSegment(arm.forearm.mesh, this.elbow, this.palm, FOREARM_WIDTH);
    this.placePaw(arm.paw.mesh, this.elbow, this.palm);
  }

  private placeSegment(
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    a: THREE.Vector3,
    b: THREE.Vector3,
    width: number,
  ): void {
    const forward = Math.max(0.04, a.z - b.z);
    const dy = b.y - a.y;
    const angle = THREE.MathUtils.clamp(Math.atan2(dy, forward), -0.72, 0.72);
    const length = Math.max(0.08, Math.hypot(forward, dy));
    mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
    mesh.rotation.set(0, Math.PI / 2, Math.PI / 2 - angle);
    const currentHeight = mesh.geometry.parameters.height;
    mesh.scale.set(width / mesh.geometry.parameters.width, length / currentHeight, 1);
  }

  private placePaw(
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    elbow: THREE.Vector3,
    palm: THREE.Vector3,
  ): void {
    const forward = Math.max(0.04, elbow.z - palm.z);
    const dy = palm.y - elbow.y;
    const angle = THREE.MathUtils.clamp(Math.atan2(dy, forward), -0.68, 0.68);
    mesh.position.set(palm.x + 0.026, palm.y, palm.z - 0.012);
    mesh.rotation.set(0, Math.PI / 2, -angle * 0.72 - 0.06);
  }
}
