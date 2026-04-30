import * as THREE from 'three/webgpu';
import {
  Fn,
  clamp,
  float,
  hash,
  length,
  pass,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';

const TONEMAP_OPTIONS = {
  ACES: 'aces',
  AgX: 'agx',
  Neutral: 'neutral',
  Linear: 'linear',
  None: 'none',
} as const;
type TonemapKey = (typeof TONEMAP_OPTIONS)[keyof typeof TONEMAP_OPTIONS];

const TONEMAP_TO_THREE: Record<TonemapKey, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
  linear: THREE.LinearToneMapping,
  none: THREE.NoToneMapping,
};

export const POSTFX_DEFS = {
  tonemap: {
    type: 'select' as const,
    default: 'aces' as TonemapKey,
    options: TONEMAP_OPTIONS,
    folder: 'tonemap',
    label: 'curve',
  },
  exposure: { default: 1.0, min: 0.2, max: 3.0, step: 0.01, folder: 'tonemap', label: 'exposure' },

  caStrength: { default: 0.0035, min: 0, max: 0.02, step: 0.0001, folder: 'chromatic', label: 'strength' },
  caEdgeBias: { default: 1.6,    min: 0, max: 4.0,  step: 0.05,   folder: 'chromatic', label: 'edge bias' },

  vignetteRadius:    { default: 0.30, min: 0, max: 1.2, step: 0.01, folder: 'vignette', label: 'inner radius' },
  vignetteSoftness:  { default: 0.95, min: 0, max: 1.5, step: 0.01, folder: 'vignette', label: 'outer radius' },
  vignetteIntensity: { default: 0.55, min: 0, max: 1.5, step: 0.01, folder: 'vignette', label: 'strength' },

  grain:           { default: 0.045, min: 0, max: 0.25, step: 0.001, folder: 'grain', label: 'amount' },
  grainLumaWeight: { default: 0.65,  min: 0, max: 1.0,  step: 0.01,  folder: 'grain', label: 'shadow bias' },

  pulseGain: { default: 0.30, min: 0, max: 1.5, step: 0.01, folder: 'pulse', label: 'loudness gain' },
} as const;

export type PostFXParams = ParamsOf<typeof POSTFX_DEFS>;

export class PostFX {
  private renderer: THREE.WebGPURenderer;
  private pipeline: THREE.RenderPipeline;
  private params: PostFXParams;
  private registered?: ReturnType<typeof registerTweaks<typeof POSTFX_DEFS>>;

  // Uniforms exposed to the TSL composite. `.value` is mutated each frame /
  // on tweakpane change so the shader picks the new number up without rebuild.
  private uCa = uniform(0);
  private uCaEdge = uniform(0);
  private uVigR = uniform(0);
  private uVigSoft = uniform(0);
  private uVigInt = uniform(0);
  private uGrain = uniform(0);
  private uGrainLuma = uniform(0);
  private uLoudness = uniform(0);
  private uPulseGain = uniform(0);

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.params = Object.fromEntries(
      Object.entries(POSTFX_DEFS).map(([k, d]) => [k, d.default]),
    ) as PostFXParams;

    this.pushParamsToUniforms();
    this.applyToneMappingFromParams();

    const scenePass = pass(scene, camera);
    const sceneTex = scenePass.getTextureNode();

    const composite = Fn(() => {
      const u = uv();
      const center = u.sub(vec2(0.5));
      const radial = length(center);

      // Edge-biased CA: offset grows with radial distance so the center stays clean.
      const edge = clamp(radial.mul(this.uCaEdge), 0, 1);
      const off = center.mul(this.uCa).mul(edge);

      const r = sceneTex.sample(clamp(u.sub(off), 0, 1)).r;
      const g = sceneTex.sample(u).g;
      const b = sceneTex.sample(clamp(u.add(off), 0, 1)).b;
      const sampled = vec3(r, g, b);

      // Vignette: smoothstep(inner, outer, dist) — pulse amplifies on loudness.
      const pulseBoost = float(1.0).add(this.uLoudness.mul(this.uPulseGain));
      const vig = smoothstep(this.uVigR, this.uVigSoft, radial).mul(this.uVigInt).mul(pulseBoost);
      const dimmed = sampled.mul(float(1.0).sub(vig).max(0));

      // Grain: hash of (uv * large + time*60). Slight luma weight so shadows
      // grain a touch more than highlights — reads more "film" than digital noise.
      const seed = u.x.mul(1920.0).add(u.y.mul(1080.0).mul(31.7)).add(time.mul(60.0));
      const noise = hash(seed).sub(0.5);
      const luma = dimmed.dot(vec3(0.299, 0.587, 0.114));
      const shadowMask = float(1.0).sub(luma).mul(this.uGrainLuma).add(float(1.0).sub(this.uGrainLuma));
      const grainAmt = this.uGrain.mul(shadowMask).mul(pulseBoost);
      const grained = dimmed.add(noise.mul(grainAmt));

      return vec4(grained.max(0), 1.0);
    });

    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputNode = composite();
  }

  attachPane(dock: HTMLElement): void {
    if (this.registered) return;
    this.registered = registerTweaks(dock, 'postfxV1', POSTFX_DEFS, {
      title: 'Post FX',
      params: this.params,
      onChange: {
        tonemap: () => this.applyToneMappingFromParams(),
        exposure: (v: number) => { this.renderer.toneMappingExposure = v; },
        caStrength: (v: number) => { this.uCa.value = v; },
        caEdgeBias: (v: number) => { this.uCaEdge.value = v; },
        vignetteRadius: (v: number) => { this.uVigR.value = v; },
        vignetteSoftness: (v: number) => { this.uVigSoft.value = Math.max(v, this.params.vignetteRadius + 1e-3); },
        vignetteIntensity: (v: number) => { this.uVigInt.value = v; },
        grain: (v: number) => { this.uGrain.value = v; },
        grainLumaWeight: (v: number) => { this.uGrainLuma.value = v; },
        pulseGain: (v: number) => { this.uPulseGain.value = v; },
      },
    });
    // registerTweaks fires onChange for any persisted overrides at startup,
    // so uniforms are now in sync. Re-apply tone mapping in case it changed.
    this.applyToneMappingFromParams();
    this.renderer.toneMappingExposure = this.params.exposure;
  }

  /** Pumped each frame from BackingTrackAnalyzer's smoothed low-band envelope. */
  setLoudness(v: number): void {
    this.uLoudness.value = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }

  render(): void {
    this.pipeline.render();
  }

  dispose(): void {
    this.registered?.dispose();
    this.registered = undefined;
    this.pipeline.dispose();
  }

  private pushParamsToUniforms(): void {
    this.uCa.value = this.params.caStrength;
    this.uCaEdge.value = this.params.caEdgeBias;
    this.uVigR.value = this.params.vignetteRadius;
    this.uVigSoft.value = Math.max(this.params.vignetteSoftness, this.params.vignetteRadius + 1e-3);
    this.uVigInt.value = this.params.vignetteIntensity;
    this.uGrain.value = this.params.grain;
    this.uGrainLuma.value = this.params.grainLumaWeight;
    this.uPulseGain.value = this.params.pulseGain;
  }

  private applyToneMappingFromParams(): void {
    const key = this.params.tonemap as TonemapKey;
    this.renderer.toneMapping = TONEMAP_TO_THREE[key] ?? THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.params.exposure;
  }
}
