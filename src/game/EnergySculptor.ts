import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  atan,
  cameraViewMatrix,
  float,
  instanceIndex,
  instancedArray,
  mix,
  smoothstep,
  uniform,
  uniformArray,
  uint,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { EmitRequest, EnergySink } from './sculptor/EnergyEmitter';
import type { ArchetypeId } from './sculptor/archetypeShared';
import {
  aizawaFlow,
  ATTRACTOR_PRESETS,
  halvorsenFlow,
  lorenzFlow,
  thomasFlow,
  type AttractorKind,
} from './sculptor/strangeAttractors';

export const SCULPTOR_DEFS = {
  particleCount:        { default: 24576, min: 4096, max: 65536, step: 256, label: 'particle pool', hidden: true },
  particleSize:         { default: 0.022, min: 0.004, max: 0.08, step: 0.001, label: 'particle size' },
  particleOpacity:      { default: 0.85,  min: 0.1,   max: 1,    step: 0.01,  label: 'particle opacity' },
  flowSpeed:            { default: 1.0,   min: 0.1,   max: 3,    step: 0.05, label: 'flow speed' },
  velocityBlend:        { default: 0.92,  min: 0.4,   max: 1,    step: 0.005, label: 'velocity smoothing' },
  speedGlow:            { default: 0.7,   min: 0,    max: 2,    step: 0.01, label: 'speed glow' },
  stretchScale:         { default: 0.06,  min: 0,    max: 0.4,  step: 0.005, label: 'accel stretch' },
  containmentStrength:  { default: 6.0,   min: 0,    max: 20,   step: 0.1, label: 'containment pull' },
  lifeSeconds:          { default: 60,    min: 4,    max: 240,  step: 0.5, label: 'life seconds' },
  fadeFraction:         { default: 0.25,  min: 0.05, max: 0.6,  step: 0.01, label: 'fade fraction' },
  settleAmount:         { default: 0.85,  min: 0,    max: 1,    step: 0.01, label: 'settle amount' },
  settleStart:          { default: 0.5,   min: 0,    max: 0.95, step: 0.01, label: 'settle start' },
  fieldRotationRate:    { default: 1.0,   min: 0,    max: 3,    step: 0.05, label: 'field rotation' },
  fieldBreathAmount:    { default: 0.15,  min: 0,    max: 0.5,  step: 0.01, label: 'field breath' },
  duetBoost:            { default: 0.45,  min: 0,    max: 1.5,  step: 0.01, label: 'duet boost' },
  dissolveBurstSpeed:   { default: 6,     min: 0,    max: 16,   step: 0.1,  label: 'dissolve burst' },
  timerRingRadius:      { default: 0.46,  min: 0.18, max: 1.2,  step: 0.01, label: 'projector base radius' },
  projectorRingCount:   { default: 3,     min: 1,    max: 5,    step: 1,    label: 'projector ring count' },
  projectorRingSpacing: { default: 0.055, min: 0.01, max: 0.25, step: 0.005, label: 'projector ring spacing' },
  projectorRingScale:   { default: 0.74,  min: 0.4,  max: 1.0,  step: 0.01, label: 'projector ring scale' },
  projectorBaseY:       { default: -0.27, min: -0.6, max: 0.3,  step: 0.01, label: 'projector base height' },
  synchronyRingColor:   { type: 'color', default: '#fff5d6', label: 'synchrony ring' },
  timerRingColor:       { type: 'color', default: '#ffd166', label: 'projector rings' },
} as const;

export type SculptorParams = ParamsOf<typeof SCULPTOR_DEFS>;

export type SculptorMusicField = {
  pulse: number;
  drumLevel: number;
  sustained: number;
  intensity: number;
  chordProgress: number;
  groovePhase: number;
};

const TAU = Math.PI * 2;
const DEFAULT_MUSIC_FIELD: SculptorMusicField = {
  pulse: 0,
  drumLevel: 0,
  sustained: 0,
  intensity: 0,
  chordProgress: 0,
  groovePhase: 0,
};

const ARCHETYPE_TO_ATTRACTOR: Record<ArchetypeId, AttractorKind> = {
  drumDrum: 'lorenz',
  melodyMelody: 'thomas',
  drumMelody: 'aizawa',
};

// Cap on how many particles we can spawn in a single frame. Sized for the
// instruments' bursty emit: Drum hits emit ~24, Starlace plucks ~20-34. With
// two players hitting hard at the same time we still stay under ~120.
const MAX_SPAWNS_PER_FRAME = 256;

const KIND_DRUM = 0;
const KIND_STARLACE = 1;

/**
 * GPU-compute particle sculpture. All particle state lives in TSL
 * `instancedArray` storage buffers; one compute pass injects new particles
 * each frame, another integrates every alive particle through the active
 * archetype's strange-attractor flow field (Lorenz / Thomas / Aizawa /
 * Halvorsen). Rendering uses a billboard SpriteNodeMaterial driven by the
 * same buffers, so no CPU→GPU per-frame data shuffling beyond the small
 * spawn queue and a handful of uniforms.
 */
export class EnergySculptor implements EnergySink {
  readonly center: THREE.Vector3;
  readonly params: SculptorParams;

  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private mesh!: THREE.InstancedMesh;
  private material!: THREE.SpriteNodeMaterial;

  private count: number;
  private spawnCursorCpu = 0;
  private pendingEmits: EmitRequest[] = [];

  // Per-particle GPU storage.
  private positionsBuffer!: THREE.StorageBufferNode<'vec3'>;
  private velocitiesBuffer!: THREE.StorageBufferNode<'vec3'>;
  private colorsBuffer!: THREE.StorageBufferNode<'vec3'>;
  // x = age (seconds), y = lifeMax (seconds), z = kindBlend (0=drum, 1=starlace), w = alphaLife (0..1)
  private metaBuffer!: THREE.StorageBufferNode<'vec4'>;

  // Spawn queue uniforms (uniformArray mutated on CPU each frame, auto-uploaded).
  private spawnPosArray: THREE.Vector3[] = [];
  private spawnVelArray: THREE.Vector3[] = [];
  private spawnColorArray: THREE.Vector3[] = [];
  // x=lifeMax, y=kindBlend, z=sizeScale (currently unused, reserved)
  private spawnMetaArray: THREE.Vector3[] = [];
  private spawnPosUniform!: THREE.UniformArrayNode<'vec3'>;
  private spawnVelUniform!: THREE.UniformArrayNode<'vec3'>;
  private spawnColorUniform!: THREE.UniformArrayNode<'vec3'>;
  private spawnMetaUniform!: THREE.UniformArrayNode<'vec3'>;
  // Float uniforms; cast to uint at shader edge. Using float here keeps the
  // public TS overload set happy without losing any precision for our counts.
  private spawnCountUniform = uniform(0);
  private spawnCursorUniform = uniform(0);
  private attractorSelectUniform = uniform(1);
  private spawnsThisFrame = 0;

  // Integration uniforms.
  private dtUniform = uniform(1 / 60);
  private flowSpeedUniform = uniform(1);
  private velocityBlendUniform = uniform(0.92);
  private worldScaleUniform = uniform(0.014);
  private containmentRadiusUniform = uniform(36);
  private containmentStrengthUniform = uniform(6);
  private lifeMaxUniform = uniform(28);
  private fadeFractionUniform = uniform(0.25);
  private dissolveModeUniform = uniform(0);
  private dissolveBurstUniform = uniform(6);
  private musicPulseUniform = uniform(0);
  private musicLevelUniform = uniform(0);
  private musicIntensityUniform = uniform(0);
  private grooveUniform = uniform(0);
  private synchronyBoostUniform = uniform(0);
  private duetBoostUniform = uniform(0.45);
  private centerUniform = uniform(new THREE.Vector3());
  private speedGlowUniform = uniform(0.7);
  private stretchScaleUniform = uniform(0.06);
  private particleSizeUniform = uniform(0.022);
  private particleOpacityUniform = uniform(0.85);

  // Per-attractor parameter uniforms. CPU swaps values on archetype change.
  // attractorSelectUniform is a float (0/1/2/3), cast to uint at compute site.
  private thomasA = uniform(0.19);
  private lorenzSigma = uniform(10);
  private lorenzRho = uniform(28);
  private lorenzBeta = uniform(8 / 3);
  private aizawaA = uniform(0.95);
  private aizawaB = uniform(0.7);
  private aizawaC = uniform(0.6);
  private aizawaD = uniform(3.5);
  private aizawaE = uniform(0.25);
  private aizawaF = uniform(0.1);
  private halvorsenA = uniform(1.4);

  // Compute passes (ComputeNode produced by Fn(...)().compute(N)).
  private emitCompute!: THREE.ComputeNode;
  private integrateCompute!: THREE.ComputeNode;

  // Frame state.
  private currentArchetype: ArchetypeId = 'drumMelody';
  private currentAttractor: AttractorKind = 'aizawa';
  private musicField: SculptorMusicField = { ...DEFAULT_MUSIC_FIELD };
  private roundProgress = 0;
  private dissolveMode = 0;
  private synchronyBoost = 0;
  private synchronyRingAge = 1;

  // Decorative scene elements.
  private synchronyRing?: THREE.Mesh;
  private synchronyRingMaterial?: THREE.MeshBasicMaterial;
  private static TIMER_SEGMENTS = 96;
  private projectorRings: THREE.Line[] = [];
  private projectorRingMaterial?: THREE.LineBasicMaterial;
  private projectorRingGeom?: THREE.BufferGeometry;

  private registered?: ReturnType<typeof registerTweaks<typeof SCULPTOR_DEFS>>;

  constructor(
    scene: THREE.Scene,
    center: THREE.Vector3,
    renderer: THREE.WebGPURenderer,
    paneDock?: HTMLElement,
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.center = center.clone();
    this.params = { ...Object.fromEntries(Object.entries(SCULPTOR_DEFS).map(([k, d]) => [k, d.default])) } as SculptorParams;
    this.count = this.params.particleCount;

    this.allocateBuffers();
    this.allocateSpawnQueue();
    this.buildComputePipelines();
    this.buildRenderMesh();
    this.buildSynchronyRing();
    this.buildProjectorRings();

    this.applyAttractorPreset(this.currentAttractor);
    this.centerUniform.value.copy(this.center);
    this.particleSizeUniform.value = this.params.particleSize;
    this.particleOpacityUniform.value = this.params.particleOpacity;
    this.flowSpeedUniform.value = this.params.flowSpeed;
    this.velocityBlendUniform.value = this.params.velocityBlend;
    this.containmentStrengthUniform.value = this.params.containmentStrength;
    this.lifeMaxUniform.value = this.params.lifeSeconds;
    this.fadeFractionUniform.value = this.params.fadeFraction;
    this.dissolveBurstUniform.value = this.params.dissolveBurstSpeed;
    this.duetBoostUniform.value = this.params.duetBoost;
    this.speedGlowUniform.value = this.params.speedGlow;
    this.stretchScaleUniform.value = this.params.stretchScale;

    this.registered = registerTweaks(paneDock, 'energySculptor', SCULPTOR_DEFS, {
      title: 'Energy Sculptor',
      params: this.params,
      onChange: {
        synchronyRingColor: v => this.synchronyRingMaterial?.color.set(v),
        timerRingColor: v => this.projectorRingMaterial?.color.set(v),
        timerRingRadius: () => this.layoutProjectorRings(),
        projectorRingCount: () => this.rebuildProjectorRings(),
        projectorRingSpacing: () => this.layoutProjectorRings(),
        projectorRingScale: () => this.layoutProjectorRings(),
        projectorBaseY: () => this.layoutProjectorRings(),
        particleSize: v => { this.particleSizeUniform.value = v; },
        particleOpacity: v => { this.particleOpacityUniform.value = v; },
        flowSpeed: v => { this.flowSpeedUniform.value = v; },
        velocityBlend: v => { this.velocityBlendUniform.value = v; },
        speedGlow: v => { this.speedGlowUniform.value = v; },
        stretchScale: v => { this.stretchScaleUniform.value = v; },
        containmentStrength: v => { this.containmentStrengthUniform.value = v; },
        lifeSeconds: v => { this.lifeMaxUniform.value = v; },
        fadeFraction: v => { this.fadeFractionUniform.value = v; },
        dissolveBurstSpeed: v => { this.dissolveBurstUniform.value = v; },
        duetBoost: v => { this.duetBoostUniform.value = v; },
      },
    });
  }

  // ---------------------------------------------------------------------- emit

  emit(req: EmitRequest): void {
    if (this.dissolveMode > 0) return;
    this.pendingEmits.push(req);
  }

  setArchetype(id: ArchetypeId): void {
    if (this.currentArchetype === id) return;
    this.currentArchetype = id;
    const next = ARCHETYPE_TO_ATTRACTOR[id];
    if (next !== this.currentAttractor) {
      this.currentAttractor = next;
      this.applyAttractorPreset(next);
    }
  }

  setRoundProgress(progress: number): void {
    this.roundProgress = Math.max(0, progress);
  }

  setMusicField(field: SculptorMusicField): void {
    this.musicField.pulse = clamp01(field.pulse);
    this.musicField.drumLevel = clamp01(field.drumLevel);
    this.musicField.sustained = clamp01(field.sustained);
    this.musicField.intensity = clamp01(field.intensity);
    this.musicField.chordProgress = field.chordProgress - Math.floor(field.chordProgress);
    this.musicField.groovePhase = field.groovePhase - Math.floor(field.groovePhase);
  }

  fireSynchrony(): void {
    this.synchronyBoost = 1;
    this.synchronyRingAge = 0;
  }

  getSynchronyBoost(): number {
    return this.synchronyBoost;
  }

  beginDissolve(): void {
    this.dissolveMode = 1;
    this.dissolveModeUniform.value = 1;
  }

  endDissolve(): void {
    this.dissolveMode = 0;
    this.dissolveModeUniform.value = 0;
  }

  // -------------------------------------------------------------------- update

  update(delta: number): void {
    if (delta <= 0) return;
    const dt = Math.min(delta, 1 / 30);
    this.dtUniform.value = dt;

    // Music + synchrony decay.
    this.synchronyBoost = Math.max(0, this.synchronyBoost * Math.exp(-delta * 4.5));
    this.synchronyBoostUniform.value = this.synchronyBoost;
    this.musicPulseUniform.value = this.musicField.pulse;
    this.musicLevelUniform.value = this.musicField.drumLevel;
    this.musicIntensityUniform.value = this.musicField.intensity;
    this.grooveUniform.value = this.musicField.groovePhase * TAU;
    this.tickSynchronyRing(delta);
    this.updateProjectorRing();

    // Drain CPU emit queue into the spawn uniformArrays.
    this.fillSpawnQueue();

    // Dispatch compute passes. Emit first so freshly-spawned particles get
    // integrated this frame too — visually they'd otherwise pop in stationary.
    if (this.spawnsThisFrame > 0) {
      this.renderer.compute(this.emitCompute);
    }
    this.renderer.compute(this.integrateCompute);
  }

  dispose(): void {
    this.registered?.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
    if (this.synchronyRing) {
      this.synchronyRing.geometry.dispose();
      this.synchronyRingMaterial?.dispose();
      this.synchronyRing.removeFromParent();
    }
    for (const ring of this.projectorRings) ring.removeFromParent();
    this.projectorRings.length = 0;
    this.projectorRingGeom?.dispose();
    this.projectorRingMaterial?.dispose();
  }

  // ----------------------------------------------------------------- internals

  private allocateBuffers(): void {
    // All particles start zeroed → alphaLife=0, which the integrate pass
    // treats as dead, so the freshly-allocated pool draws nothing.
    this.positionsBuffer = instancedArray(this.count, 'vec3');
    this.velocitiesBuffer = instancedArray(this.count, 'vec3');
    this.colorsBuffer = instancedArray(this.count, 'vec3');
    this.metaBuffer = instancedArray(this.count, 'vec4');
  }

  private allocateSpawnQueue(): void {
    for (let i = 0; i < MAX_SPAWNS_PER_FRAME; i += 1) {
      this.spawnPosArray.push(new THREE.Vector3());
      this.spawnVelArray.push(new THREE.Vector3());
      this.spawnColorArray.push(new THREE.Vector3());
      this.spawnMetaArray.push(new THREE.Vector3());
    }
    this.spawnPosUniform = uniformArray(this.spawnPosArray, 'vec3');
    this.spawnVelUniform = uniformArray(this.spawnVelArray, 'vec3');
    this.spawnColorUniform = uniformArray(this.spawnColorArray, 'vec3');
    this.spawnMetaUniform = uniformArray(this.spawnMetaArray, 'vec3');
  }

  private buildComputePipelines(): void {
    const positions = this.positionsBuffer;
    const velocities = this.velocitiesBuffer;
    const colors = this.colorsBuffer;
    const meta = this.metaBuffer;

    // Emit pass: write spawn-queue entries into ring-buffer slots.
    const emitFn = Fn(() => {
      const i = instanceIndex;
      const spawnCountU = this.spawnCountUniform.toUint();
      const spawnCursorU = this.spawnCursorUniform.toUint();
      If(i.greaterThanEqual(spawnCountU), () => {
        Return();
      });
      const slot = spawnCursorU.add(i).mod(uint(this.count));
      const spawnPos = this.spawnPosUniform.element(i);
      const spawnVel = this.spawnVelUniform.element(i);
      const spawnColor = this.spawnColorUniform.element(i);
      const spawnMeta = this.spawnMetaUniform.element(i);
      positions.element(slot).assign(spawnPos);
      velocities.element(slot).assign(spawnVel);
      colors.element(slot).assign(spawnColor);
      // meta = (age=0, lifeMax, smoothedAccel=0, alphaLife=1)
      meta.element(slot).assign(vec4(0, spawnMeta.x, 0, 1));
    });
    this.emitCompute = emitFn().compute(MAX_SPAWNS_PER_FRAME);

    // Integrate pass: per-particle attractor flow + life update.
    const integrateFn = Fn(() => {
      const i = instanceIndex;
      const m = meta.element(i).toVar();
      // Skip dead particles.
      If(m.w.lessThanEqual(0), () => {
        Return();
      });
      const pos = positions.element(i).toVar();
      const vel = velocities.element(i).toVar();
      // Capture pre-integration speed so we can derive a signed acceleration
      // (positive when the particle is speeding up, negative when slowing).
      // Used by the renderer to stretch / squish the sprite along travel.
      const oldSpeed = vel.length().toVar();

      // Compute candidate flow from each attractor; select via uniform branch.
      const flow = vec3(0).toVar();

      const sel = this.attractorSelectUniform;
      If(sel.lessThan(0.5), () => {
        flow.assign(thomasFlow(pos, this.thomasA));
      });
      If(sel.greaterThanEqual(0.5).and(sel.lessThan(1.5)), () => {
        flow.assign(lorenzFlow(pos, this.lorenzSigma, this.lorenzRho, this.lorenzBeta));
      });
      If(sel.greaterThanEqual(1.5).and(sel.lessThan(2.5)), () => {
        flow.assign(aizawaFlow(
          pos,
          this.aizawaA,
          this.aizawaB,
          this.aizawaC,
          this.aizawaD,
          this.aizawaE,
          this.aizawaF,
        ));
      });
      If(sel.greaterThanEqual(2.5), () => {
        flow.assign(halvorsenFlow(pos, this.halvorsenA));
      });

      // Music modulation: pulse boosts flow speed; sustained adds gentle swirl.
      const musicGain = float(1)
        .add(this.musicPulseUniform.mul(0.55))
        .add(this.musicIntensityUniform.mul(0.18));
      const synchronyGain = float(1).add(this.synchronyBoostUniform.mul(this.duetBoostUniform));
      const speedGain = this.flowSpeedUniform.mul(musicGain).mul(synchronyGain);

      // Smoothly blend velocity toward flow so trajectories feel inertial
      // rather than instantaneously snapping to dp/dt.
      const targetVel = flow.mul(speedGain);
      const newVel = mix(targetVel, vel, this.velocityBlendUniform).toVar();

      // Soft containment: when a particle drifts past the safe radius for
      // this attractor, push it back so we don't accumulate runaways.
      const r = pos.length();
      const overshoot = smoothstep(this.containmentRadiusUniform.mul(0.85), this.containmentRadiusUniform, r);
      const inward = pos.normalize().negate().mul(overshoot).mul(this.containmentStrengthUniform);
      newVel.addAssign(inward);

      // Dissolve burst: blow particles outward away from origin and shorten life.
      const dm = this.dissolveModeUniform;
      const outward = pos.normalize().mul(this.dissolveBurstUniform);
      newVel.assign(mix(newVel, outward, dm));

      // Step.
      const newPos = pos.add(newVel.mul(this.dtUniform));

      // Age + alpha.
      const ageStep = this.dtUniform.mul(float(1).add(dm.mul(2.0)));
      const newAge = m.x.add(ageStep);
      const lifeMax = m.y;
      const lifeT = newAge.div(lifeMax.max(0.0001)).clamp(0, 1);
      // Linear fade-in over 0.15s (born), linear fade-out over fadeFraction of life
      const born = newAge.div(0.15).clamp(0, 1);
      const fadeStart = float(1).sub(this.fadeFractionUniform);
      const fadeOut = float(1).sub(smoothstep(fadeStart, 1.0, lifeT));
      const alphaLife = born.mul(fadeOut);

      // Signed acceleration along the path, low-passed across frames so the
      // visual stretch doesn't strobe on every integration tick.
      const newSpeed = newVel.length();
      const instantAccel = newSpeed.sub(oldSpeed).div(this.dtUniform.max(1e-4));
      const smoothedAccel = mix(instantAccel, m.z, 0.7);

      positions.element(i).assign(newPos);
      velocities.element(i).assign(newVel);
      meta.element(i).assign(vec4(newAge, lifeMax, smoothedAccel, alphaLife));
    });
    this.integrateCompute = integrateFn().compute(this.count);
  }

  private buildRenderMesh(): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    // Position: attractor-space → world-space.
    const localPos = this.positionsBuffer.toAttribute();
    material.positionNode = localPos.mul(this.worldScaleUniform).add(this.centerUniform);

    const m = this.metaBuffer.toAttribute();
    const alpha = m.w;
    const accel = m.z;
    const vel = this.velocitiesBuffer.toAttribute();
    const speed = vel.length();

    // Acceleration → directional stretch. Positive accel stretches the sprite
    // along the velocity direction; negative accel squishes it (inverse on
    // perpendicular). At rest the factor is 1.0 → perfect circle.
    const stretchAmount = accel.mul(this.stretchScaleUniform).clamp(-0.55, 0.85);
    // Mute stretch on near-stationary particles so freshly-spawned dots stay
    // round instead of getting a random rotation from numerical jitter.
    const speedRamp = speed.mul(2.0).clamp(0, 1);
    const stretchFactor = float(1).add(stretchAmount.mul(speedRamp));
    const stretchSafe = stretchFactor.max(0.45);

    // Project world-space velocity into camera-view space so the sprite's
    // X axis (after billboarding) can be aligned with the on-screen velocity
    // direction. Length-zero velocities (just-spawned, frozen) fall back to
    // angle 0 — the speedRamp gate above already disables their stretch.
    const worldVel = vel.mul(this.worldScaleUniform);
    const viewVel = cameraViewMatrix.mul(vec4(worldVel, 0));
    const angle = atan(viewVel.y, viewVel.x);
    material.rotationNode = angle;

    // Sprite scale: base size * sqrt(alpha) so dying particles shrink, then
    // stretch one axis and squish the other for the kinetic feel.
    const sizeBase = this.particleSizeUniform.mul(alpha.sqrt().add(0.15));
    material.scaleNode = vec2(sizeBase.mul(stretchSafe), sizeBase.div(stretchSafe));

    // Color: base color, brightened by speed and music pulse, multiplied by
    // alphaLife so dead particles contribute nothing under additive blending.
    const baseColor = this.colorsBuffer.toAttribute();
    const speedTerm = speed.mul(0.05).clamp(0, 1).mul(this.speedGlowUniform);
    const musicTerm = this.musicPulseUniform.mul(0.35);
    const glow = float(0.55).add(speedTerm).add(musicTerm);
    const lit = baseColor.mul(glow).mul(alpha);
    material.colorNode = lit;

    // Discard quad corners so the underlying PlaneGeometry reads as a circle.
    // Soft edge over a few percent of the radius gives it a glow falloff that
    // plays nicely with additive blending.
    const r = uv().sub(0.5).length();
    const disc = smoothstep(0.5, 0.42, r);
    material.opacityNode = alpha.mul(this.particleOpacityUniform).mul(disc);

    this.material = material;
    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 32;
    this.scene.add(this.mesh);
  }

  private buildSynchronyRing(): void {
    this.synchronyRingMaterial = new THREE.MeshBasicMaterial({
      color: this.params.synchronyRingColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ringGeom = new THREE.RingGeometry(0.12, 0.16, 96);
    this.synchronyRing = new THREE.Mesh(ringGeom, this.synchronyRingMaterial);
    this.synchronyRing.position.copy(this.center);
    this.synchronyRing.rotation.x = Math.PI / 2;
    this.synchronyRing.frustumCulled = false;
    this.synchronyRing.renderOrder = 33;
    this.scene.add(this.synchronyRing);
  }

  private buildProjectorRings(): void {
    const segs = EnergySculptor.TIMER_SEGMENTS;
    const ringPositions = new Float32Array((segs + 1) * 3);
    for (let i = 0; i <= segs; i += 1) {
      const theta = (i / segs) * Math.PI * 2 - Math.PI / 2;
      const o = i * 3;
      ringPositions[o] = Math.cos(theta);
      ringPositions[o + 1] = 0;
      ringPositions[o + 2] = Math.sin(theta);
    }
    this.projectorRingGeom = new THREE.BufferGeometry();
    this.projectorRingGeom.setAttribute('position', new THREE.BufferAttribute(ringPositions, 3));
    this.projectorRingMaterial = new THREE.LineBasicMaterial({
      color: this.params.timerRingColor,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.rebuildProjectorRings();
  }

  private rebuildProjectorRings(): void {
    if (!this.projectorRingGeom || !this.projectorRingMaterial) return;
    for (const ring of this.projectorRings) ring.removeFromParent();
    this.projectorRings.length = 0;
    const count = Math.max(1, Math.round(this.params.projectorRingCount));
    for (let i = 0; i < count; i += 1) {
      const ring = new THREE.Line(this.projectorRingGeom, this.projectorRingMaterial);
      ring.frustumCulled = false;
      ring.renderOrder = 34;
      this.projectorRings.push(ring);
      this.scene.add(ring);
    }
    this.layoutProjectorRings();
  }

  private layoutProjectorRings(): void {
    const baseRadius = this.params.timerRingRadius;
    const spacing = this.params.projectorRingSpacing;
    const radiusScale = this.params.projectorRingScale;
    const baseY = this.center.y + this.params.projectorBaseY;
    for (let i = 0; i < this.projectorRings.length; i += 1) {
      const ring = this.projectorRings[i];
      const r = baseRadius * Math.pow(radiusScale, i);
      ring.scale.set(r, 1, r);
      ring.position.set(this.center.x, baseY + i * spacing, this.center.z);
    }
  }

  private updateProjectorRing(): void {
    if (!this.projectorRingMaterial) return;
    const build = Math.min(1, this.roundProgress);
    this.projectorRingMaterial.opacity = this.dissolveMode > 0 ? 0.18 : 0.12 + build * 0.18;
  }

  private tickSynchronyRing(delta: number): void {
    if (!this.synchronyRing || !this.synchronyRingMaterial) return;
    this.synchronyRingAge += delta;
    const lifeWindow = 0.85;
    if (this.synchronyRingAge >= lifeWindow) {
      this.synchronyRingMaterial.opacity = 0;
      return;
    }
    const t = this.synchronyRingAge / lifeWindow;
    const radius = 0.18 + t * 0.95;
    this.synchronyRing.scale.setScalar(radius);
    this.synchronyRingMaterial.opacity = (1 - t) * 0.9;
  }

  private fillSpawnQueue(): void {
    let cursor = 0;
    const lifeBase = this.lifeMaxUniform.value;
    const worldScale = this.worldScaleUniform.value || 1;
    const invWorldScale = 1 / worldScale;

    for (const req of this.pendingEmits) {
      if (cursor >= MAX_SPAWNS_PER_FRAME) break;
      const allowed = Math.min(req.count, MAX_SPAWNS_PER_FRAME - cursor);
      const dirNormSq = req.direction.lengthSq();
      const dirX = dirNormSq > 1e-6 ? req.direction.x : 0;
      const dirY = dirNormSq > 1e-6 ? req.direction.y : 1;
      const dirZ = dirNormSq > 1e-6 ? req.direction.z : 0;
      const kind = req.kind === 'starlace' ? KIND_STARLACE : KIND_DRUM;

      for (let i = 0; i < allowed; i += 1) {
        const slot = cursor;
        // Origin: world → attractor space.
        const oxLocal = (req.origin.x - this.center.x) * invWorldScale;
        const oyLocal = (req.origin.y - this.center.y) * invWorldScale;
        const ozLocal = (req.origin.z - this.center.z) * invWorldScale;
        // Add a small jitter so a burst doesn't all collapse onto one orbit.
        const jx = (Math.random() - 0.5) * 0.6;
        const jy = (Math.random() - 0.5) * 0.6;
        const jz = (Math.random() - 0.5) * 0.6;
        this.spawnPosArray[slot].set(oxLocal + jx, oyLocal + jy, ozLocal + jz);

        // Initial velocity: emit direction, attenuated and rotated toward
        // attractor space. Magnitude small so attractor flow dominates fast.
        const seedSpeed = (0.4 + Math.random() * 0.6) * (req.speed * 0.4);
        this.spawnVelArray[slot].set(
          dirX * seedSpeed,
          dirY * seedSpeed,
          dirZ * seedSpeed,
        );

        this.spawnColorArray[slot].set(req.color.r, req.color.g, req.color.b);

        // The slider is the actual base lifetime in seconds; ±15% jitter.
        const lifeMax = lifeBase * (0.85 + Math.random() * 0.30);
        this.spawnMetaArray[slot].set(lifeMax, kind, 1);

        cursor += 1;
      }
    }
    this.pendingEmits.length = 0;
    this.spawnsThisFrame = cursor;
    this.spawnCountUniform.value = cursor;
    this.spawnCursorUniform.value = this.spawnCursorCpu;
    this.spawnCursorCpu = (this.spawnCursorCpu + cursor) % this.count;
  }

  private applyAttractorPreset(kind: AttractorKind): void {
    const preset = ATTRACTOR_PRESETS[kind];
    this.worldScaleUniform.value = preset.worldScale;
    this.containmentRadiusUniform.value = preset.containmentRadius;
    this.velocityBlendUniform.value = Math.min(this.params.velocityBlend, preset.velocityBlend);
    this.flowSpeedUniform.value = this.params.flowSpeed * preset.dt;
    const kindIdx: Record<AttractorKind, number> = { thomas: 0, lorenz: 1, aizawa: 2, halvorsen: 3 };
    this.attractorSelectUniform.value = kindIdx[kind];
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
