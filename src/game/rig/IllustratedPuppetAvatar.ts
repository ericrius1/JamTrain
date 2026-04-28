import * as THREE from 'three/webgpu';
import type { Handedness, PlayerPose } from '../types';
import type { Skeleton } from './skeleton';

export type PuppetAnchor = {
  /** 0..1 from the left edge of the sprite. */
  x: number;
  /** 0..1 from the top edge of the sprite. */
  y: number;
};

type Vec3Tuple = readonly [number, number, number];
type RangeTuple = readonly [number, number];

export type PuppetSpriteSpec = {
  url: string;
  width: number;
  aspect: number;
  color?: THREE.ColorRepresentation;
};

export type PuppetSegmentSpec = PuppetSpriteSpec & {
  from: PuppetAnchor;
  to: PuppetAnchor;
  scale?: number;
  minScale?: number;
  maxScale?: number;
  angleOffset?: number;
  offset?: Vec3Tuple;
};

export type PuppetArmLaneSpec = {
  shoulder: Vec3Tuple;
  targetOffset?: Vec3Tuple;
  elbowOffset: Vec3Tuple;
  renderOrder: number;
  upper?: Partial<PuppetSegmentSpec>;
  forearm?: Partial<PuppetSegmentSpec>;
  hand?: Partial<PuppetSegmentSpec & { aimDistance: number; aimLift?: number }>;
};

export type IllustratedPuppetSpec = {
  name: string;
  body: PuppetSpriteSpec & {
    position: Vec3Tuple;
    renderOrder: number;
  };
  contactShadow?: {
    size: readonly [number, number];
    position: Vec3Tuple;
    opacity?: number;
    renderOrder?: number;
  };
  arms: {
    cameraDepth: number;
    target: {
      yScale: number;
      yOffset: number;
      yRange: RangeTuple;
      zScale: number;
      zOffset: number;
      zRange: RangeTuple;
    };
    elbowBlend: number;
    upper: PuppetSegmentSpec;
    forearm: PuppetSegmentSpec;
    hand: PuppetSegmentSpec & {
      aimDistance: number;
      aimLift?: number;
    };
    lanes: Record<Handedness, PuppetArmLaneSpec>;
  };
};

type FlatPart = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.Texture;
};

type AnchoredPart = FlatPart & {
  root: THREE.Group;
  rotor: THREE.Group;
};

type ArmParts = {
  upper: AnchoredPart;
  forearm: AnchoredPart;
  hand: AnchoredPart;
  specs: {
    upper: PuppetSegmentSpec;
    forearm: PuppetSegmentSpec;
    hand: PuppetSegmentSpec & { aimDistance: number; aimLift?: number };
  };
};

const planeFacingY = Math.PI / 2;

function toVector3(tuple: Vec3Tuple, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(tuple[0], tuple[1], tuple[2]);
}

function anchorToLocal(anchor: PuppetAnchor, spec: PuppetSpriteSpec, target = new THREE.Vector2()): THREE.Vector2 {
  const height = spec.width * spec.aspect;
  return target.set((anchor.x - 0.5) * spec.width, (0.5 - anchor.y) * height);
}

export class IllustratedPuppetAvatar {
  readonly group = new THREE.Group();

  private readonly loader = new THREE.TextureLoader();
  private readonly flatParts: FlatPart[] = [];
  private readonly anchoredParts: AnchoredPart[] = [];
  private readonly arms: Record<Handedness, ArmParts>;
  private readonly body: FlatPart;
  private readonly contactShadow?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly contactShadowTexture?: THREE.CanvasTexture;
  private readonly targetWorld = new THREE.Vector3();
  private readonly targetLocal = new THREE.Vector3();
  private readonly shoulder = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly palm = new THREE.Vector3();
  private readonly handAim = new THREE.Vector3();
  private readonly handDirection = new THREE.Vector3();
  private readonly anchorA = new THREE.Vector2();
  private readonly anchorB = new THREE.Vector2();

  constructor(private readonly spec: IllustratedPuppetSpec) {
    this.group.name = `${spec.name} illustrated puppet`;
    this.group.visible = false;

    this.body = this.createFlatPart(spec.body, spec.body.renderOrder);
    this.body.mesh.name = `${spec.name} body`;
    this.body.mesh.position.set(...spec.body.position);
    this.group.add(this.body.mesh);

    if (spec.contactShadow) {
      this.contactShadowTexture = this.createContactShadowTexture();
      this.contactShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(spec.contactShadow.size[0], spec.contactShadow.size[1]),
        new THREE.MeshBasicMaterial({
          map: this.contactShadowTexture,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          opacity: spec.contactShadow.opacity ?? 0.42,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      );
      this.contactShadow.name = `${spec.name} contact shadow`;
      this.contactShadow.position.set(...spec.contactShadow.position);
      this.contactShadow.rotation.y = planeFacingY;
      this.contactShadow.renderOrder = spec.contactShadow.renderOrder ?? 9;
      this.contactShadow.frustumCulled = false;
      this.group.add(this.contactShadow);
    }

    this.arms = {
      left: this.createArm('left'),
      right: this.createArm('right'),
    };
  }

  update(skeleton: Skeleton, pose: PlayerPose, elapsed: number): void {
    void pose;
    this.syncToSkeletonRoot(skeleton);
    this.group.position.y += Math.sin(elapsed * 1.35) * 0.012;
    this.group.updateMatrixWorld(true);

    this.updateArm('left', skeleton);
    this.updateArm('right', skeleton);
    this.group.visible = true;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    for (const part of [...this.flatParts, ...this.anchoredParts]) {
      part.mesh.geometry.dispose();
      part.mesh.material.dispose();
      part.texture.dispose();
    }
    this.contactShadow?.geometry.dispose();
    this.contactShadow?.material.dispose();
    this.contactShadowTexture?.dispose();
    this.group.clear();
  }

  private createArm(hand: Handedness): ArmParts {
    const lane = this.spec.arms.lanes[hand];
    const upperSpec = { ...this.spec.arms.upper, ...lane.upper };
    const forearmSpec = { ...this.spec.arms.forearm, ...lane.forearm };
    const handSpec = { ...this.spec.arms.hand, ...lane.hand };
    const upper = this.createAnchoredPart(upperSpec, lane.renderOrder);
    const forearm = this.createAnchoredPart(forearmSpec, lane.renderOrder + 1);
    const handPart = this.createAnchoredPart(handSpec, lane.renderOrder + 2);

    upper.mesh.name = `${this.spec.name} ${hand} upper arm`;
    forearm.mesh.name = `${this.spec.name} ${hand} forearm`;
    handPart.mesh.name = `${this.spec.name} ${hand} hand`;

    this.group.add(upper.root, forearm.root, handPart.root);
    return { upper, forearm, hand: handPart, specs: { upper: upperSpec, forearm: forearmSpec, hand: handSpec } };
  }

  private createFlatPart(spec: PuppetSpriteSpec, renderOrder: number): FlatPart {
    const texture = this.loader.load(spec.url, tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    });
    texture.colorSpace = THREE.SRGBColorSpace;

    const geometry = new THREE.PlaneGeometry(spec.width, spec.width * spec.aspect);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      color: spec.color ?? 0xffffff,
      transparent: true,
      depthWrite: false,
      alphaTest: 0.025,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.y = planeFacingY;
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;

    const part = { mesh, texture };
    this.flatParts.push(part);
    return part;
  }

  private createAnchoredPart(spec: PuppetSegmentSpec, renderOrder: number): AnchoredPart {
    const part = this.createFlatPart(spec, renderOrder);
    part.mesh.rotation.set(0, 0, 0);

    const root = new THREE.Group();
    const plane = new THREE.Group();
    const rotor = new THREE.Group();
    plane.rotation.y = planeFacingY;
    root.add(plane);
    plane.add(rotor);
    rotor.add(part.mesh);

    const anchor = anchorToLocal(spec.from, spec, this.anchorA);
    part.mesh.position.set(-anchor.x, -anchor.y, 0);

    const anchored = { ...part, root, rotor };
    this.anchoredParts.push(anchored);
    return anchored;
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

  private syncToSkeletonRoot(skeleton: Skeleton): void {
    this.group.position.copy(skeleton.root.position);
    this.group.quaternion.copy(skeleton.root.quaternion);
    this.group.scale.copy(skeleton.root.scale);
    this.group.updateMatrixWorld(true);
  }

  private updateArm(hand: Handedness, skeleton: Skeleton): void {
    const cfg = this.spec.arms;
    const arm = this.arms[hand];
    const lane = cfg.lanes[hand];

    skeleton.getArmJointWorld(hand, 'palm', this.targetWorld);
    this.targetLocal.copy(this.targetWorld);
    this.group.worldToLocal(this.targetLocal);

    const target = cfg.target;
    toVector3(lane.shoulder, this.shoulder);
    const targetOffset = lane.targetOffset ?? [0, 0, 0];
    this.palm.set(
      cfg.cameraDepth + targetOffset[0],
      THREE.MathUtils.clamp(
        this.targetLocal.y * target.yScale + target.yOffset + targetOffset[1],
        target.yRange[0],
        target.yRange[1],
      ),
      THREE.MathUtils.clamp(
        this.targetLocal.z * target.zScale + target.zOffset + targetOffset[2],
        target.zRange[0],
        target.zRange[1],
      ),
    );

    this.elbow.copy(this.shoulder).lerp(this.palm, cfg.elbowBlend);
    const elbowOffset = lane.elbowOffset;
    this.elbow.x += elbowOffset[0];
    this.elbow.y += elbowOffset[1];
    this.elbow.z += elbowOffset[2];

    this.placeSegment(arm.upper, arm.specs.upper, this.shoulder, this.elbow);
    this.placeSegment(arm.forearm, arm.specs.forearm, this.elbow, this.palm);
    this.placeHand(arm.hand, arm.specs.hand);
  }

  private placeHand(part: AnchoredPart, spec: PuppetSegmentSpec & { aimDistance: number; aimLift?: number }): void {
    this.handDirection.subVectors(this.palm, this.elbow);
    this.handDirection.x = 0;
    if (this.handDirection.lengthSq() < 0.0001) {
      this.handDirection.set(0, 0.08, -0.16);
    }
    this.handDirection.normalize();
    this.handAim.copy(this.palm).addScaledVector(this.handDirection, spec.aimDistance);
    this.handAim.y += spec.aimLift ?? 0;
    this.placeSegment(part, spec, this.palm, this.handAim);
  }

  private placeSegment(part: AnchoredPart, spec: PuppetSegmentSpec, from: THREE.Vector3, to: THREE.Vector3): void {
    const fromAnchor = anchorToLocal(spec.from, spec, this.anchorA);
    const toAnchor = anchorToLocal(spec.to, spec, this.anchorB);
    const restX = toAnchor.x - fromAnchor.x;
    const restY = toAnchor.y - fromAnchor.y;
    const restLength = Math.max(Math.hypot(restX, restY), 0.0001);
    const restAngle = Math.atan2(restY, restX);

    const targetX = -(to.z - from.z);
    const targetY = to.y - from.y;
    const targetLength = Math.max(Math.hypot(targetX, targetY), 0.0001);
    const targetAngle = Math.atan2(targetY, targetX);
    const scale = THREE.MathUtils.clamp(
      (targetLength / restLength) * (spec.scale ?? 1),
      spec.minScale ?? 0.65,
      spec.maxScale ?? 1.85,
    );
    const offset = spec.offset ?? [0, 0, 0];

    part.root.position.set(from.x + offset[0], from.y + offset[1], from.z + offset[2]);
    part.rotor.rotation.z = targetAngle - restAngle + (spec.angleOffset ?? 0);
    part.rotor.scale.setScalar(scale);
  }
}
