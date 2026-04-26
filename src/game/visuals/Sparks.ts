import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  hash,
  instancedArray,
  instanceIndex,
  mix,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { PlayerVisual, VoiceState } from '../instruments';

export const SPARKS_DEFS = {
  count:         { default: 512,  min: 64,  max: 2048, step: 32,    label: 'particle count' },
  lifetime:      { default: 1.4,  min: 0.3, max: 4,    step: 0.05,  label: 'lifetime sec' },
  pointSize:     { default: 0.018, min: 0.005, max: 0.08, step: 0.001, label: 'point size' },
  baseSpawnRate: { default: 0.2,  min: 0,   max: 1,    step: 0.01,  label: 'base spawn' },
  pulseSpawnRate:{ default: 0.9,  min: 0,   max: 2,    step: 0.05,  label: 'pulse spawn' },
  drift:         { default: 0.04, min: 0,   max: 0.3,  step: 0.005, label: 'drift jitter' },
  baseOpacity:   { default: 0.4,  min: 0,   max: 1,    step: 0.01,  label: 'base opacity' },
  coolColor:     { type: 'color', default: '#f7cf72', label: 'cool' },
  warmColor:     { type: 'color', default: '#fff2da', label: 'warm' },
} as const;

export type SparksParams = ParamsOf<typeof SPARKS_DEFS>;

// Choose a single fixed buffer size up front. Live tweaking the count would
// require rebuilding the InstancedMesh; we pick the default at construction.
const PARTICLES = SPARKS_DEFS.count.default;

type AnyTslNode = any; // TSL node typings are not exported

export class Sparks implements PlayerVisual {
  readonly mesh: THREE.InstancedMesh;
  readonly params: SparksParams;
  private positions = instancedArray(PARTICLES, 'vec4');
  private uStart = uniform(new THREE.Vector3());
  private uEnd = uniform(new THREE.Vector3());
  private uDelta = uniform(0);
  private uSpawnChance = uniform(0);
  private uLifetime = uniform(SPARKS_DEFS.lifetime.default);
  private uDrift = uniform(SPARKS_DEFS.drift.default);
  private computeInit: AnyTslNode;
  private computeUpdate: AnyTslNode;
  private smoothedEnergy = 0;
  private smoothedPulse = 0;
  private active = true;
  private renderer?: THREE.WebGPURenderer;
  private initialized = false;
  private registered?: ReturnType<typeof registerTweaks<typeof SPARKS_DEFS>>;

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey: string = 'sparks') {
    this.params = { ...Object.fromEntries(Object.entries(SPARKS_DEFS).map(([k, d]) => [k, d.default])) } as SparksParams;

    this.computeInit = Fn(() => {
      const slot = this.positions.element(instanceIndex);
      // Start all particles dead (age >= lifetime) so they respawn on the
      // first update tick where spawnChance allows.
      slot.assign(vec4(this.uStart, float(99.0)));
    })().compute(PARTICLES);

    this.computeUpdate = Fn(() => {
      const slot = this.positions.element(instanceIndex);
      const age = slot.w;
      const newAge = age.add(this.uDelta);

      const seed = hash(instanceIndex.toFloat().mul(0.137));
      const respawnRoll = hash(instanceIndex.toFloat().mul(0.91).add(this.uDelta.mul(7.31)));

      // If the particle is past its lifetime AND the spawn roll allows,
      // reset it near uStart with a small jitter and age 0.
      const dead = newAge.greaterThan(this.uLifetime);
      const allowed = respawnRoll.lessThan(this.uSpawnChance);

      const jitter = vec3(
        hash(instanceIndex.add(11)).sub(0.5),
        hash(instanceIndex.add(23)).sub(0.5),
        hash(instanceIndex.add(37)).sub(0.5),
      ).mul(0.04);

      // Drift toward uEnd over the particle's lifetime — t = age / lifetime.
      const t = newAge.div(this.uLifetime).clamp(0, 1);
      const path = mix(this.uStart, this.uEnd, t).add(
        vec3(seed.sub(0.5), seed.mul(1.7).sub(0.5), seed.mul(0.7).sub(0.5)).mul(this.uDrift)
      );

      const respawned = vec4(this.uStart.add(jitter), float(0));
      const advanced  = vec4(path, newAge);

      // Branchless select via a mix on a 0/1 mask.
      const respawnMask = dead.and(allowed).select(float(1), float(0));
      slot.assign(mix(advanced, respawned, respawnMask));
    })().compute(PARTICLES);

    const geometry = new THREE.SphereGeometry(this.params.pointSize, 6, 4);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const slot = this.positions.element(instanceIndex);
    material.positionNode = slot.xyz;
    // Fade in at birth, fade out near end of lifetime.
    const ageT = slot.w.div(this.uLifetime).clamp(0, 1);
    const fade = ageT.oneMinus().mul(ageT.mul(4).clamp(0, 1));
    const baseColor = mix(color(this.params.coolColor), color(this.params.warmColor), ageT);
    material.colorNode = baseColor;
    material.opacityNode = fade.mul(this.params.baseOpacity);

    this.mesh = new THREE.InstancedMesh(geometry, material, PARTICLES);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    scene.add(this.mesh);

    this.registered = registerTweaks(paneDock, paneKey, SPARKS_DEFS, {
      title: 'Sparks (Glass Sparks)',
      params: this.params,
      onChange: {
        lifetime: v => { this.uLifetime.value = v; },
        drift:    v => { this.uDrift.value = v; },
      },
    });
  }

  /** Must be called once after the renderer has finished `init()`. */
  initialize(renderer: THREE.WebGPURenderer): void {
    this.renderer = renderer;
    if (this.initialized) return;
    try {
      renderer.compute(this.computeInit);
      this.initialized = true;
    } catch (err) {
      console.warn('[sparks] compute init failed; visual will be dormant', err);
    }
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
  }

  update(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3, voice: VoiceState, delta: number): void {
    if (!this.active || !this.renderer || !this.initialized) return;

    const energyAlpha = 1 - Math.exp(-delta * 5);
    const pulseAlpha = 1 - Math.exp(-delta * 14);
    this.smoothedEnergy += ((voice.active ? voice.energy : 0) - this.smoothedEnergy) * energyAlpha;
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * pulseAlpha;

    this.uStart.value.copy(leftPalm);
    this.uEnd.value.copy(rightPalm);
    this.uDelta.value = delta;
    // Spawn chance = base + pulse * pulseRate, all in 0..1.
    const spawn = Math.min(1, this.params.baseSpawnRate * this.smoothedEnergy + this.params.pulseSpawnRate * this.smoothedPulse);
    this.uSpawnChance.value = spawn;

    try {
      this.renderer.compute(this.computeUpdate);
    } catch (err) {
      console.warn('[sparks] compute update failed', err);
      this.initialized = false;
    }
  }

  dispose(): void {
    this.registered?.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
