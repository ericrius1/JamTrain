import * as THREE from 'three/webgpu';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { Pane } from 'tweakpane';
import type { FingerName, Handedness } from './types';

export type OrbMeltOwner = 'local' | 'remote';

export type OrbMeltFingertip = {
  owner: OrbMeltOwner;
  hand: Handedness;
  finger: FingerName;
  position: THREE.Vector3;
  color?: THREE.ColorRepresentation;
};

export type OrbMeltVisibility = {
  owner: OrbMeltOwner;
  hand: Handedness;
  finger: FingerName;
  hidden: boolean;
  amount: number;
};

export type OrbMarchingMeltOptions = {
  center: THREE.Vector3;
  radius: number;
  paneDock?: HTMLElement;
};

type ActiveTip = OrbMeltFingertip & {
  amount: number;
};

const CORE_COLOR = new THREE.Color(0x66f5d2);
const TIP_COLOR = new THREE.Color(0x91f7ff);
const HOT_TIP_COLOR = new THREE.Color(0xffffff);
const tempVec = new THREE.Vector3();
const tempColor = new THREE.Color();

export class OrbMarchingMelt {
  private readonly center = new THREE.Vector3();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly effect: MarchingCubes;
  private readonly maxPolyCount = 70000;
  private pane?: Pane;
  private updateAccumulator = 0;
  private forceUpdate = true;
  private lastSignature = '';

  private readonly params = {
    enabled: true,
    resolution: 20,
    updateHz: 10,
    fieldSize: 1.46,
    isolation: 80,
    subtract: 18,
    coreRadius: 0.43,
    coreStrength: 1.0,
    capRadius: 0.12,
    fingerRadius: 0.052,
    fingerStrength: 1.25,
    connectionDistance: 0.28,
    hideThreshold: 0.48,
    maxFingertips: 6,
    fullCore: false,
    blur: 0,
    opacity: 0.46,
    emissive: 0.72,
  };

  constructor(scene: THREE.Scene, options: OrbMarchingMeltOptions) {
    this.center.copy(options.center);
    this.params.coreRadius = options.radius + 0.01;

    this.material = new THREE.MeshStandardMaterial({
      color: 0x8af6de,
      emissive: 0x21bda5,
      emissiveIntensity: this.params.emissive,
      roughness: 0.22,
      metalness: 0.04,
      transparent: true,
      opacity: this.params.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
    });

    this.effect = new MarchingCubes(this.params.resolution, this.material, false, true, this.maxPolyCount);
    this.effect.name = 'orb-marching-melt';
    this.effect.position.copy(this.center);
    this.effect.scale.setScalar(this.params.fieldSize * 0.5);
    this.effect.isolation = this.params.isolation;
    this.effect.frustumCulled = false;
    this.effect.renderOrder = 12;
    scene.add(this.effect);

    if (options.paneDock) {
      const container = document.createElement('div');
      options.paneDock.appendChild(container);
      this.pane = new Pane({ title: 'Marching Melt', container });
      this.pane.expanded = false;
      this.registerTweaks();
    }
  }

  update(_elapsed: number, delta: number, fingertips: OrbMeltFingertip[]): OrbMeltVisibility[] {
    if (!this.params.enabled) {
      this.effect.visible = false;
      return fingertips.map(tip => ({ ...tip, hidden: false, amount: 0 }));
    }

    const active = this.collectActiveTips(fingertips);
    const activeAmounts = new Map(active.map(tip => [this.keyFor(tip), tip.amount]));
    const visibilities = fingertips.map(tip => {
      const key = this.keyFor(tip);
      const amount = activeAmounts.get(key) ?? 0;
      return {
        owner: tip.owner,
        hand: tip.hand,
        finger: tip.finger,
        hidden: activeAmounts.has(key) && amount >= this.params.hideThreshold,
        amount,
      };
    });

    if (active.length === 0 && !this.params.fullCore) {
      this.effect.visible = false;
      this.updateAccumulator = 0;
      this.lastSignature = '';
      this.forceUpdate = false;
      return visibilities;
    }

    this.updateAccumulator += delta;
    const interval = 1 / Math.max(1, this.params.updateHz);
    const signature = this.signatureFor(active);
    const shouldRebuild =
      this.forceUpdate ||
      !this.effect.visible ||
      this.lastSignature === '' ||
      (this.updateAccumulator >= interval && signature !== this.lastSignature);

    if (shouldRebuild) {
      this.rebuildField(active);
      this.lastSignature = signature;
      this.updateAccumulator = 0;
      this.forceUpdate = false;
    }

    return visibilities;
  }

  getVertexCount(): number {
    return Math.max(0, Math.min(this.effect.count, this.effect.geometry.getAttribute('position').count));
  }

  dispose(): void {
    this.pane?.dispose();
    this.effect.geometry.dispose();
    this.material.dispose();
    this.effect.removeFromParent();
  }

  private registerTweaks(): void {
    if (!this.pane) return;

    this.pane.addBinding(this.params, 'enabled', { label: 'enabled' }).on('change', () => {
      this.forceUpdate = true;
    });

    const shape = this.pane.addFolder({ title: 'melt shape', expanded: true });
    shape.addBinding(this.params, 'coreRadius', { label: 'orb edge', min: 0.25, max: 0.62, step: 0.005 }).on('change', () => {
      this.forceUpdate = true;
    });
    shape.addBinding(this.params, 'coreStrength', { label: 'cap strength', min: 0.25, max: 2.5, step: 0.01 }).on('change', () => {
      this.forceUpdate = true;
    });
    shape.addBinding(this.params, 'capRadius', { label: 'cap radius', min: 0.04, max: 0.26, step: 0.002 }).on('change', () => {
      this.forceUpdate = true;
    });
    shape.addBinding(this.params, 'fingerRadius', { label: 'tip radius', min: 0.025, max: 0.14, step: 0.002 }).on('change', () => {
      this.forceUpdate = true;
    });
    shape.addBinding(this.params, 'fingerStrength', { label: 'tip strength', min: 0.1, max: 4, step: 0.01 }).on('change', () => {
      this.forceUpdate = true;
    });
    shape.addBinding(this.params, 'connectionDistance', { label: 'melt distance', min: 0.04, max: 0.75, step: 0.005 }).on('change', () => {
      this.forceUpdate = true;
    });
    shape.addBinding(this.params, 'hideThreshold', { label: 'hide tips at', min: 0.05, max: 0.95, step: 0.01 });
    shape.addBinding(this.params, 'fullCore', { label: 'full orb mesh' }).on('change', () => {
      this.forceUpdate = true;
    });

    const performance = this.pane.addFolder({ title: 'marching cubes', expanded: true });
    performance.addBinding(this.params, 'resolution', { min: 12, max: 48, step: 1 }).on('change', e => {
      this.params.resolution = Math.round(e.value);
      this.effect.init(this.params.resolution);
      this.forceUpdate = true;
    });
    performance.addBinding(this.params, 'updateHz', { label: 'update hz', min: 2, max: 60, step: 1 });
    performance.addBinding(this.params, 'maxFingertips', { label: 'max tips', min: 1, max: 20, step: 1 }).on('change', e => {
      this.params.maxFingertips = Math.round(e.value);
      this.forceUpdate = true;
    });
    performance.addBinding(this.params, 'fieldSize', { label: 'field size', min: 1.0, max: 2.6, step: 0.01 }).on('change', () => {
      this.effect.scale.setScalar(this.params.fieldSize * 0.5);
      this.forceUpdate = true;
    });
    performance.addBinding(this.params, 'isolation', { min: 24, max: 140, step: 1 }).on('change', () => {
      this.effect.isolation = this.params.isolation;
      this.forceUpdate = true;
    });
    performance.addBinding(this.params, 'subtract', { min: 4, max: 40, step: 0.5 }).on('change', () => {
      this.forceUpdate = true;
    });
    performance.addBinding(this.params, 'blur', { min: 0, max: 2, step: 1 }).on('change', () => {
      this.forceUpdate = true;
    });

    const material = this.pane.addFolder({ title: 'surface', expanded: false });
    material.addBinding(this.params, 'opacity', { min: 0.05, max: 1, step: 0.01 }).on('change', () => {
      this.material.opacity = this.params.opacity;
    });
    material.addBinding(this.params, 'emissive', { min: 0, max: 2.5, step: 0.01 }).on('change', () => {
      this.material.emissiveIntensity = this.params.emissive;
    });
  }

  private collectActiveTips(fingertips: OrbMeltFingertip[]): ActiveTip[] {
    const active: ActiveTip[] = [];
    const fieldHalfSize = this.params.fieldSize * 0.5;

    for (const tip of fingertips) {
      const normalized = this.worldToNormalized(tip.position);
      if (
        normalized.x <= 0.02 || normalized.x >= 0.98 ||
        normalized.y <= 0.02 || normalized.y >= 0.98 ||
        normalized.z <= 0.02 || normalized.z >= 0.98
      ) {
        continue;
      }

      const distanceFromCenter = tip.position.distanceTo(this.center);
      if (distanceFromCenter > fieldHalfSize * 0.98) continue;

      const surfaceGap = Math.max(0, distanceFromCenter - this.params.coreRadius);
      const melt = 1 - smoothstep(0, Math.max(0.001, this.params.connectionDistance), surfaceGap);
      if (melt <= 0.01) continue;

      active.push({
        ...tip,
        amount: Math.pow(melt, 0.72),
      });
    }

    active.sort((a, b) => b.amount - a.amount);
    return active.slice(0, Math.max(0, Math.floor(this.params.maxFingertips)));
  }

  private rebuildField(activeTips: ActiveTip[]): void {
    this.effect.visible = this.params.enabled;
    this.effect.position.copy(this.center);
    this.effect.scale.setScalar(this.params.fieldSize * 0.5);
    this.effect.isolation = this.params.isolation;
    this.effect.reset();

    if (this.params.fullCore) {
      this.addMetaball(this.center, this.params.coreRadius, this.params.coreStrength, CORE_COLOR);
    }

    for (const tip of activeTips) {
      const color = tempColor
        .set(tip.color ?? TIP_COLOR)
        .lerp(HOT_TIP_COLOR, tip.amount * 0.28)
        .lerp(CORE_COLOR, tip.amount * 0.42);
      const radius = this.params.fingerRadius * THREE.MathUtils.lerp(0.72, 1.22, tip.amount);
      const strength = this.params.fingerStrength * THREE.MathUtils.lerp(0.18, 1.0, tip.amount);
      const cap = this.surfaceCapPosition(tip.position);
      const capRadius = this.params.capRadius * THREE.MathUtils.lerp(0.55, 1.08, tip.amount);
      const capStrength = this.params.coreStrength * THREE.MathUtils.lerp(0.35, 1.0, tip.amount);
      this.addMetaball(cap, capRadius, capStrength, CORE_COLOR);
      if (tip.amount > 0.22) {
        const bridge = tempVec.copy(tip.position).lerp(cap, 0.54).clone();
        this.addMetaball(bridge, radius * 0.82, strength * 0.72, color);
      }
      this.addMetaball(tip.position, radius, strength, color);
    }

    if (this.params.blur > 0) {
      this.effect.blur(this.params.blur);
    }

    this.effect.update();
    this.effect.visible = this.params.enabled && this.effect.count > 0;
  }

  private addMetaball(position: THREE.Vector3, worldRadius: number, strengthScale: number, color: THREE.Color): void {
    const normalized = this.worldToNormalized(position);
    const normalizedRadius = THREE.MathUtils.clamp(worldRadius / this.params.fieldSize, 0.001, 0.48);
    const strength = (this.params.isolation + this.params.subtract) * normalizedRadius * normalizedRadius * strengthScale;
    this.effect.addBall(normalized.x, normalized.y, normalized.z, strength, this.params.subtract, color);
  }

  private surfaceCapPosition(position: THREE.Vector3): THREE.Vector3 {
    const direction = position.clone().sub(this.center);
    if (direction.lengthSq() < 0.0001) direction.set(0, 0, 1);
    return direction.normalize().multiplyScalar(this.params.coreRadius * 0.98).add(this.center);
  }

  private signatureFor(activeTips: ActiveTip[]): string {
    if (this.params.fullCore && activeTips.length === 0) return 'core';
    const snap = 0.018;
    return activeTips.map(tip => {
      const p = tip.position;
      return [
        this.keyFor(tip),
        Math.round(p.x / snap),
        Math.round(p.y / snap),
        Math.round(p.z / snap),
        Math.round(tip.amount * 16),
      ].join(':');
    }).join('|');
  }

  private worldToNormalized(position: THREE.Vector3): THREE.Vector3 {
    return tempVec
      .copy(position)
      .sub(this.center)
      .divideScalar(this.params.fieldSize)
      .addScalar(0.5);
  }

  private keyFor(tip: Pick<OrbMeltFingertip, 'owner' | 'hand' | 'finger'>): string {
    return `${tip.owner}:${tip.hand}:${tip.finger}`;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
