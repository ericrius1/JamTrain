import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { PlayerVisual, VoiceState } from '../instruments';

export const RIBBON_DEFS = {
  segments:      { default: 24,   min: 4,   max: 64,   step: 1,    label: 'segments' },
  baseAmp:       { default: 0.04, min: 0,   max: 0.3,  step: 0.005, label: 'base amp' },
  pulseAmp:      { default: 0.18, min: 0,   max: 0.6,  step: 0.005, label: 'pulse amp' },
  width:         { default: 0.08, min: 0.01, max: 0.4, step: 0.005, label: 'width' },
  scrollSpeed:   { default: 0.7,  min: 0,   max: 4,    step: 0.05, label: 'scroll speed' },
  baseOpacity:   { default: 0.25, min: 0,   max: 1,    step: 0.01, label: 'base opacity' },
  energyOpacity: { default: 0.55, min: 0,   max: 1,    step: 0.01, label: 'energy opacity' },
  coolColor:     { type: 'color', default: '#52e2ff', label: 'cool' },
  warmColor:     { type: 'color', default: '#aef0ff', label: 'warm' },
} as const;

export type RibbonParams = ParamsOf<typeof RIBBON_DEFS>;

export class Ribbon implements PlayerVisual {
  readonly mesh: THREE.Mesh;
  readonly params: RibbonParams;
  private geometry!: THREE.PlaneGeometry;
  private positions!: THREE.BufferAttribute;
  private uvs!: THREE.BufferAttribute;
  private material: THREE.MeshBasicNodeMaterial;
  private smoothedEnergy = 0;
  private smoothedPulse = 0;
  private elapsed = 0;
  private active = true;
  private registered?: ReturnType<typeof registerTweaks<typeof RIBBON_DEFS>>;
  private currentSegments = -1;

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey: string = 'ribbon') {
    this.params = { ...Object.fromEntries(Object.entries(RIBBON_DEFS).map(([k, d]) => [k, d.default])) } as RibbonParams;

    this.material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.material.color = new THREE.Color(this.params.coolColor);

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 1, 1), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    scene.add(this.mesh);

    this.rebuildGeometry(this.params.segments);

    this.registered = registerTweaks(paneDock, paneKey, RIBBON_DEFS, {
      title: 'Ribbon (Cedar Flute)',
      params: this.params,
      onChange: {
        segments:  v => this.rebuildGeometry(v | 0),
        coolColor: v => this.material.color = new THREE.Color(v),
      },
    });
  }

  private rebuildGeometry(segments: number): void {
    const seg = Math.max(2, segments | 0);
    if (seg === this.currentSegments) return;
    this.currentSegments = seg;
    this.geometry?.dispose();
    this.geometry = new THREE.PlaneGeometry(1, 1, seg, 1);
    this.mesh.geometry = this.geometry;
    this.positions = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.uvs = this.geometry.getAttribute('uv') as THREE.BufferAttribute;
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
  }

  update(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3, voice: VoiceState, delta: number): void {
    if (!this.active) return;

    this.elapsed += delta;
    const energyAlpha = 1 - Math.exp(-delta * 6);
    const pulseAlpha = 1 - Math.exp(-delta * 12);
    this.smoothedEnergy += ((voice.active ? voice.energy : 0) - this.smoothedEnergy) * energyAlpha;
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * pulseAlpha;

    const seg = this.currentSegments;
    const verts = this.positions.array as Float32Array;
    const w = this.params.width;
    const ampBase = this.params.baseAmp + this.params.pulseAmp * this.smoothedPulse;

    // Frame the ribbon to face the camera by computing a "up" perpendicular
    // to the chord between palms. We use world-up cross direction; that's
    // visually fine for a horizontal-ish ribbon.
    const dir = new THREE.Vector3().subVectors(rightPalm, leftPalm);
    const dirLen = dir.length();
    if (dirLen < 1e-4) return;
    dir.divideScalar(dirLen);
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize();
    const ribbonUp = new THREE.Vector3().crossVectors(side, dir).normalize();

    const t = this.elapsed * this.params.scrollSpeed;

    // PlaneGeometry(1,1, seg, 1) lays vertices in 2 rows of (seg+1).
    // Index layout: [row0_v0, row0_v1, ..., row0_vSeg, row1_v0, ...]
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const wave = Math.sin(u * Math.PI * 4 + t * 6.28) * ampBase;
      const cx = leftPalm.x + (rightPalm.x - leftPalm.x) * u + ribbonUp.x * wave;
      const cy = leftPalm.y + (rightPalm.y - leftPalm.y) * u + ribbonUp.y * wave;
      const cz = leftPalm.z + (rightPalm.z - leftPalm.z) * u + ribbonUp.z * wave;

      const ax = cx + side.x * w;
      const ay = cy + side.y * w;
      const az = cz + side.z * w;
      const bx = cx - side.x * w;
      const by = cy - side.y * w;
      const bz = cz - side.z * w;

      const top = i * 3;
      const bot = (seg + 1 + i) * 3;
      verts[top]     = ax;
      verts[top + 1] = ay;
      verts[top + 2] = az;
      verts[bot]     = bx;
      verts[bot + 1] = by;
      verts[bot + 2] = bz;
    }
    this.positions.needsUpdate = true;

    const opacity = this.params.baseOpacity + this.params.energyOpacity * this.smoothedEnergy;
    this.material.opacity = opacity;
  }

  dispose(): void {
    this.registered?.dispose();
    this.geometry?.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
