import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { PlayerVisual, VoiceState } from '../instruments';

export const SPARKS_DEFS = {
  ringCount:     { default: 7,     min: 3,    max: 10,   step: 1,     label: 'rings' },
  radius:        { default: 0.30,  min: 0.12, max: 0.75, step: 0.01,  label: 'orb radius' },
  stretch:       { default: 0.66,  min: 0.25, max: 1.25, step: 0.01,  label: 'ellipse stretch' },
  swirl:         { default: 0.13,  min: 0,    max: 0.35, step: 0.005, label: 'filament wobble' },
  spin:          { default: 0.72,  min: 0,    max: 2.2,  step: 0.01,  label: 'spin speed' },
  moteCount:     { default: 176,   min: 24,   max: 240,  step: 4,     label: 'motes' },
  moteSize:      { default: 0.018, min: 0.004, max: 0.05, step: 0.001, label: 'mote size' },
  coreSize:      { default: 0.68,  min: 0.08, max: 1.2,  step: 0.01,  label: 'core size' },
  baseOpacity:   { default: 0.72,  min: 0,    max: 1,    step: 0.01,  label: 'opacity' },
  coolColor:     { type: 'color', default: '#9f641c', label: 'ember' },
  warmColor:     { type: 'color', default: '#f6bd4b', label: 'gold' },
  hotColor:      { type: 'color', default: '#fff1c8', label: 'hot core' },
} as const;

export type SparksParams = ParamsOf<typeof SPARKS_DEFS>;

const MAX_RINGS = 10;
const RING_SEGMENTS = 160;
const MAX_MOTES = 240;
const TAU = Math.PI * 2;

export class Sparks implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: SparksParams;

  private ringLines: THREE.Line[] = [];
  private ringMaterials: THREE.LineBasicMaterial[] = [];
  private moteMesh: THREE.InstancedMesh;
  private moteMaterial: THREE.MeshBasicMaterial;
  private coreSprite: THREE.Sprite;
  private coreMaterial: THREE.SpriteMaterial;
  private glowTexture: THREE.DataTexture;
  private smoothedEnergy = 0;
  private smoothedPulse = 0;
  private elapsed = 0;
  private active = true;
  private registered?: ReturnType<typeof registerTweaks<typeof SPARKS_DEFS>>;

  private center = new THREE.Vector3();
  private axisX = new THREE.Vector3(1, 0, 0);
  private axisY = new THREE.Vector3(0, 1, 0);
  private axisZ = new THREE.Vector3(0, 0, 1);
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpN = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private dummy = new THREE.Object3D();
  private moteSeeds = new Float32Array(MAX_MOTES * 4);
  private hot = new THREE.Color();
  private warm = new THREE.Color();
  private ember = new THREE.Color();

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey: string = 'sparks') {
    this.params = { ...Object.fromEntries(Object.entries(SPARKS_DEFS).map(([k, d]) => [k, d.default])) } as SparksParams;
    this.mesh = new THREE.Group();
    this.mesh.name = 'golden-filigree-sigil';

    this.glowTexture = makeRadialGlowTexture();
    this.coreMaterial = new THREE.SpriteMaterial({
      map: this.glowTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.coreSprite = new THREE.Sprite(this.coreMaterial);
    this.coreSprite.frustumCulled = false;
    this.coreSprite.renderOrder = 14;
    this.mesh.add(this.coreSprite);

    for (let i = 0; i < MAX_RINGS; i += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_SEGMENTS + 1) * 3), 3));
      const material = new THREE.LineBasicMaterial({
        color: 0xf6bd4b,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = 15 + i;
      this.ringLines.push(line);
      this.ringMaterials.push(material);
      this.mesh.add(line);
    }

    const moteGeometry = new THREE.SphereGeometry(1, 7, 5);
    this.moteMaterial = new THREE.MeshBasicMaterial({
      color: 0xffdf8a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.moteMesh = new THREE.InstancedMesh(moteGeometry, this.moteMaterial, MAX_MOTES);
    this.moteMesh.frustumCulled = false;
    this.moteMesh.renderOrder = 24;
    this.mesh.add(this.moteMesh);

    for (let i = 0; i < MAX_MOTES; i += 1) {
      const k = i * 4;
      this.moteSeeds[k] = hash01(i * 19.17 + 0.13);
      this.moteSeeds[k + 1] = hash01(i * 7.31 + 2.41);
      this.moteSeeds[k + 2] = hash01(i * 13.93 + 4.73);
      this.moteSeeds[k + 3] = hash01(i * 29.21 + 1.91);
    }

    scene.add(this.mesh);
    this.applyColors();

    this.registered = registerTweaks(paneDock, paneKey, SPARKS_DEFS, {
      title: 'Glass Sparks (Golden Sigil)',
      params: this.params,
      onChange: {
        coolColor: () => this.applyColors(),
        warmColor: () => this.applyColors(),
        hotColor:  () => this.applyColors(),
      },
    });
  }

  /** Retained for the old WebGPU particle contract; this visual is CPU-driven. */
  initialize(_renderer: THREE.WebGPURenderer): void {
    // No compute setup needed.
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
  }

  update(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3, voice: VoiceState, delta: number): void {
    if (!this.active) return;

    this.elapsed += delta;
    const energyAlpha = 1 - Math.exp(-delta * 5.5);
    const pulseAlpha = 1 - Math.exp(-delta * 15);
    this.smoothedEnergy += ((voice.active ? voice.energy : 0) - this.smoothedEnergy) * energyAlpha;
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * pulseAlpha;

    this.center.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
    const palmDistance = Math.max(0.18, leftPalm.distanceTo(rightPalm));
    const radius = this.params.radius * (0.82 + Math.min(0.65, palmDistance) * 0.28) * (1 + this.smoothedPulse * 0.16);
    const intensity = this.params.baseOpacity * (0.16 + this.smoothedEnergy * 0.68 + this.smoothedPulse * 0.42);

    this.resolveAxes(leftPalm, rightPalm);
    this.updateCore(radius, intensity);
    this.updateRings(radius, intensity);
    this.updateMotes(radius, intensity);
  }

  dispose(): void {
    this.registered?.dispose();
    for (const line of this.ringLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.moteMesh.geometry.dispose();
    (this.moteMesh.material as THREE.Material).dispose();
    this.coreMaterial.map?.dispose();
    this.coreMaterial.dispose();
    this.mesh.removeFromParent();
  }

  private resolveAxes(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3): void {
    this.axisX.subVectors(rightPalm, leftPalm);
    if (this.axisX.lengthSq() < 0.0001) this.axisX.set(1, 0, 0);
    else this.axisX.normalize();

    this.axisY.set(0, 1, 0);
    if (Math.abs(this.axisY.dot(this.axisX)) > 0.88) this.axisY.set(0, 0, 1);
    this.axisY.addScaledVector(this.axisX, -this.axisY.dot(this.axisX)).normalize();
    this.axisZ.crossVectors(this.axisX, this.axisY).normalize();
  }

  private updateCore(radius: number, intensity: number): void {
    const scale = radius * this.params.coreSize * (0.84 + this.smoothedPulse * 0.25);
    this.coreSprite.position.copy(this.center);
    this.coreSprite.scale.setScalar(scale);
    this.coreMaterial.opacity = Math.min(0.92, intensity * 0.95);
    this.coreMaterial.color.copy(this.hot).lerp(this.warm, 0.35);
  }

  private updateRings(radius: number, intensity: number): void {
    const visibleRings = Math.max(0, Math.min(MAX_RINGS, Math.round(this.params.ringCount)));
    const spin = this.elapsed * this.params.spin;

    for (let i = 0; i < MAX_RINGS; i += 1) {
      const line = this.ringLines[i];
      const material = this.ringMaterials[i];
      line.visible = i < visibleRings;
      if (!line.visible) continue;

      const phase = spin * (0.55 + i * 0.085) + i * 0.91;
      const tiltA = phase + i * 0.37;
      const tiltB = phase * -0.72 + i * 1.23;
      const a = this.tmpA
        .copy(this.axisX).multiplyScalar(Math.cos(tiltA))
        .addScaledVector(this.axisY, Math.sin(tiltA))
        .normalize();
      const b = this.tmpB
        .copy(this.axisZ).multiplyScalar(Math.cos(tiltB))
        .addScaledVector(this.axisY, Math.sin(tiltB))
        .normalize();
      const n = this.tmpN.crossVectors(a, b).normalize();

      const ringT = visibleRings <= 1 ? 0 : i / (visibleRings - 1);
      const rA = radius * (0.70 + ringT * 0.28);
      const rB = radius * this.params.stretch * (0.52 + (1 - ringT) * 0.24);
      const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;

      for (let s = 0; s <= RING_SEGMENTS; s += 1) {
        const t = s / RING_SEGMENTS;
        const theta = t * TAU;
        const harmonic = 2 + (i % 4);
        const wobble = Math.sin(theta * harmonic + phase * 2.1) * this.params.swirl * radius;
        const braid = Math.sin(theta * (harmonic + 1) - phase * 1.4) * this.params.swirl * radius * 0.42;

        this.tmpP.copy(this.center)
          .addScaledVector(a, Math.cos(theta) * rA)
          .addScaledVector(b, Math.sin(theta) * rB)
          .addScaledVector(n, wobble + braid);

        positions.setXYZ(s, this.tmpP.x, this.tmpP.y, this.tmpP.z);
      }

      positions.needsUpdate = true;
      const bright = i % 3 === 0 ? 0.18 : 0;
      material.opacity = Math.min(0.92, intensity * (0.44 + ringT * 0.22 + bright));
      material.color.copy(this.warm).lerp(this.hot, bright + this.smoothedPulse * 0.22);
    }
  }

  private updateMotes(radius: number, intensity: number): void {
    const count = Math.max(0, Math.min(MAX_MOTES, Math.round(this.params.moteCount)));
    const spin = this.elapsed * this.params.spin;
    this.moteMaterial.opacity = Math.min(0.82, intensity * 0.85);
    this.moteMaterial.color.copy(this.warm).lerp(this.hot, 0.25 + this.smoothedPulse * 0.25);

    for (let i = 0; i < MAX_MOTES; i += 1) {
      const k = i * 4;
      const s0 = this.moteSeeds[k];
      const s1 = this.moteSeeds[k + 1];
      const s2 = this.moteSeeds[k + 2];
      const s3 = this.moteSeeds[k + 3];
      const enabled = i < count ? 1 : 0;
      const drift = (spin * (0.16 + s0 * 0.34) + s1) % 1;
      const angle = drift * TAU + s2 * TAU;
      const shell = radius * (0.24 + s0 * 1.16);
      const lift = (s3 - 0.5) * radius * 0.72 + Math.sin(spin * 1.8 + s2 * TAU) * radius * 0.10;
      const radialPulse = 1 + Math.sin(spin * 2.4 + s1 * TAU) * 0.12 + this.smoothedPulse * 0.28;

      this.tmpP.copy(this.center)
        .addScaledVector(this.axisX, Math.cos(angle) * shell * radialPulse)
        .addScaledVector(this.axisZ, Math.sin(angle) * shell * this.params.stretch * radialPulse)
        .addScaledVector(this.axisY, lift);

      const flicker = 0.52 + 0.48 * Math.sin(spin * (3.2 + s0 * 5) + s3 * TAU);
      const size = this.params.moteSize * enabled * (0.55 + s2 * 1.2) * (0.55 + this.smoothedEnergy + this.smoothedPulse * 0.7) * flicker;
      this.dummy.position.copy(this.tmpP);
      this.dummy.scale.setScalar(Math.max(0.0001, size));
      this.dummy.updateMatrix();
      this.moteMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.moteMesh.instanceMatrix.needsUpdate = true;
  }

  private applyColors(): void {
    this.ember.set(this.params.coolColor);
    this.warm.set(this.params.warmColor);
    this.hot.set(this.params.hotColor);
    this.coreMaterial.color.copy(this.hot);
    this.moteMaterial.color.copy(this.warm);
    for (let i = 0; i < this.ringMaterials.length; i += 1) {
      const t = i / Math.max(1, this.ringMaterials.length - 1);
      this.ringMaterials[i].color.copy(this.ember).lerp(this.warm, 0.55 + t * 0.35);
    }
  }
}

function makeRadialGlowTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const maxR = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - cx) / maxR;
      const dy = (y - cy) / maxR;
      const r = Math.sqrt(dx * dx + dy * dy);
      const core = Math.max(0, 1 - r * 3.8);
      const halo = Math.max(0, 1 - r);
      const alpha = Math.min(1, Math.pow(core, 0.65) * 0.95 + Math.pow(halo, 2.4) * 0.55);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(218 + core * 37);
      data[i + 2] = Math.round(126 + core * 98);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hash01(n: number): number {
  const s = Math.sin(n) * 43758.5453123;
  return s - Math.floor(s);
}
