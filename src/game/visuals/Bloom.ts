import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { PlayerVisual, VoiceState } from '../instruments';

export const BLOOM_DEFS = {
  baseSize:        { default: 0.32, min: 0.05, max: 1.2,  step: 0.01,  label: 'base size' },
  pulseSize:       { default: 0.55, min: 0,    max: 2,    step: 0.01,  label: 'pulse size' },
  baseOpacity:     { default: 0.18, min: 0,    max: 1,    step: 0.01,  label: 'base opacity' },
  energyOpacity:   { default: 0.65, min: 0,    max: 1,    step: 0.01,  label: 'energy opacity' },
  haloSoftness:    { default: 0.78, min: 0.2,  max: 1.5,  step: 0.01,  label: 'halo softness' },
  warmColor:       { type: 'color', default: '#ff7ad6', label: 'warm' },
  hotColor:        { type: 'color', default: '#fff2da', label: 'hot' },
} as const;

export type BloomParams = ParamsOf<typeof BLOOM_DEFS>;

const TEX_SIZE = 256;

function makeBloomTexture(): THREE.DataTexture {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  const cx = TEX_SIZE / 2;
  const cy = TEX_SIZE / 2;
  const maxR = TEX_SIZE / 2;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const dx = (x - cx) / maxR;
      const dy = (y - cy) / maxR;
      const r = Math.sqrt(dx * dx + dy * dy);
      // Painterly soft falloff: smoothstep-ish curve. Bright center, long tail.
      const core = Math.pow(Math.max(0, 1 - r), 2.4);
      const halo = Math.pow(Math.max(0, 1 - r), 0.9) * 0.45;
      const a = Math.min(1, core + halo);
      const i = (y * TEX_SIZE + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, TEX_SIZE, TEX_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Bloom implements PlayerVisual {
  readonly mesh: THREE.Sprite;
  readonly params: BloomParams;
  private smoothedEnergy = 0;
  private smoothedPulse = 0;
  private active = true;
  private registered?: ReturnType<typeof registerTweaks<typeof BLOOM_DEFS>>;
  private warmColor = new THREE.Color();
  private hotColor = new THREE.Color();
  private mixedColor = new THREE.Color();

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey: string = 'bloom') {
    const tex = makeBloomTexture();
    const material = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Sprite(material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    scene.add(this.mesh);

    this.params = { ...Object.fromEntries(Object.entries(BLOOM_DEFS).map(([k, d]) => [k, d.default])) } as BloomParams;
    this.warmColor.set(this.params.warmColor);
    this.hotColor.set(this.params.hotColor);

    this.registered = registerTweaks(paneDock, paneKey, BLOOM_DEFS, {
      title: 'Bloom (Velvet Bell)',
      params: this.params,
      onChange: {
        warmColor: v => this.warmColor.set(v),
        hotColor:  v => this.hotColor.set(v),
      },
    });
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
  }

  update(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3, voice: VoiceState, delta: number): void {
    if (!this.active) return;

    const energyAlpha = 1 - Math.exp(-delta * 6);
    const pulseAlpha = 1 - Math.exp(-delta * 14);
    this.smoothedEnergy += ((voice.active ? voice.energy : 0) - this.smoothedEnergy) * energyAlpha;
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * pulseAlpha;

    this.mesh.position.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);

    const size = this.params.baseSize + this.params.pulseSize * this.smoothedPulse;
    this.mesh.scale.setScalar(size);

    const opacity = this.params.baseOpacity + this.params.energyOpacity * this.smoothedEnergy;
    (this.mesh.material as THREE.SpriteMaterial).opacity = opacity;

    // Hot color flashes in on each pulse, then settles back to warm.
    this.mixedColor.copy(this.warmColor).lerp(this.hotColor, Math.min(1, this.smoothedPulse * 1.4));
    (this.mesh.material as THREE.SpriteMaterial).color.copy(this.mixedColor);
  }

  dispose(): void {
    this.registered?.dispose();
    const mat = this.mesh.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.mesh.removeFromParent();
  }
}
