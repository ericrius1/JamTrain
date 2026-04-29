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
  sin,
  smoothstep,
  uniform,
  uniformArray,
  uint,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { SPECTRUM_BAND_COUNT, type MusicSpectrum } from './audioGraph';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { EmitRequest, EnergySink } from './sculptor/EnergyEmitter';
import type { ArchetypeId } from './sculptor/archetypeShared';
import {
  aizawaFlow,
  ATTRACTOR_PRESETS,
  dadrasFlow,
  halvorsenFlow,
  lorenzFlow,
  rosslerFlow,
  thomasFlow,
  type AttractorKind,
  type AttractorPreset,
} from './sculptor/strangeAttractors';

export const SCULPTOR_DEFS = {
  particleCount:        { default: 24576, min: 4096, max: 65536, step: 256, label: 'particle pool', hidden: true },
  particleSize:         { default: 0.005, min: 0.001, max: 0.03, step: 0.001, label: 'particle size' },
  particleOpacity:      { default: 0.85,  min: 0.1,   max: 1,    step: 0.01,  label: 'particle opacity' },
  particleLifetime:     { default: 30,    min: 0,    max: 240,  step: 0.5,  label: 'particle lifetime' },
  fieldStrength:        { default: 1.0,   min: 0,    max: 100,  step: 0.05, label: 'field strength' },
  affinityFalloffStart: { default: 0.40,  min: 0,    max: 1,    step: 0.01, label: 'affinity falloff start' },
  affinityFalloffEnd:   { default: 0.85,  min: 0,    max: 1,    step: 0.01, label: 'affinity falloff end' },
  finalAffinity:        { default: 0.0,   min: 0,    max: 1,    step: 0.01, label: 'final affinity' },
  fieldRotationRate:    { default: 1.0,   min: 0,    max: 3,    step: 0.05, label: 'field rotation' },
  attractorOverride:    { type: 'select' as const, default: 'auto' as const, options: { auto: 'auto', thomas: 'thomas', lorenz: 'lorenz', aizawa: 'aizawa', halvorsen: 'halvorsen', rossler: 'rossler', dadras: 'dadras' }, label: 'attractor' },
  speedGlow:            { default: 0.7,   min: 0,    max: 2,    step: 0.01, label: 'speed glow' },
  stretchScale:         { default: 0.06,  min: 0,    max: 0.4,  step: 0.005, label: 'accel stretch' },
  containmentStrength:  { default: 6.5,   min: 0,    max: 20,   step: 0.1, label: 'containment pull' },
  fadeFraction:         { default: 0.18,  min: 0.05, max: 0.9,  step: 0.01, label: 'fade fraction' },
  duetBoost:            { default: 0.45,  min: 0,    max: 1.5,  step: 0.01, label: 'duet boost' },
  spectrumFlowGain:     { default: 0.55,  min: 0,    max: 2,    step: 0.01, label: 'fft flow gain' },
  spectrumPulseGain:    { default: 1.4,   min: 0,    max: 4,    step: 0.05, label: 'fft pulse gain' },
  spectrumGlowGain:     { default: 1.1,   min: 0,    max: 3,    step: 0.05, label: 'fft glow gain' },
  spectrumOscillation:  { default: 0.35,  min: 0,    max: 1.5,  step: 0.01, label: 'fft oscillation' },
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
  // x = age (seconds), y = lifeMax (seconds), z = smoothedAccel, w = alphaLife (0..1)
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

  // Per-band spectrum data — `instanceIndex % SPECTRUM_BAND_COUNT` picks
  // which band a particle responds to. We pack (level, pulse, _, _) into a
  // Vector4 array so we can reuse the same uniformArray-of-Vector4 pattern
  // the spawn queue uses (mutation is auto-uploaded by three each frame).
  // A plain number[] with type 'float' was uploading once and never again.
  private spectrumBandArray: THREE.Vector4[] = [];
  private spectrumBandUniform!: THREE.UniformArrayNode<'vec4'>;
  private spectrumOverallUniform = uniform(0);
  private spectrumFlowGainUniform = uniform(0.55);
  private spectrumPulseGainUniform = uniform(1.4);
  private spectrumGlowGainUniform = uniform(1.1);
  private spectrumOscillationUniform = uniform(0.35);
  private spectrumTimeUniform = uniform(0);

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
  private rosslerA = uniform(0.2);
  private rosslerB = uniform(0.2);
  private rosslerC = uniform(5.7);
  private dadrasP = uniform(3);
  private dadrasO = uniform(2.7);
  private dadrasR = uniform(1.7);
  private dadrasC = uniform(2);
  private dadrasE = uniform(9);

  private fieldRotationRate = 1.0;
  // 'auto' = follow archetype-driven attractor; otherwise pin to the chosen kind.
  private attractorOverride: 'auto' | AttractorKind = 'auto';

  // Lifetime-keyed affinity falloff — particles lose attraction to the field
  // as they age. flowInfluence = mix(1, finalAffinity, smoothstep(start, end, lifeT)).
  private affinityFalloffStartUniform = uniform(0.30);
  private affinityFalloffEndUniform = uniform(0.95);
  private finalAffinityUniform = uniform(0.05);
  // Master force multiplier — 0 means no acceleration is applied to particles.
  private fieldStrengthUniform = uniform(1.0);

  // Sample-space rotation — slowly tumbles the attractor through world space
  // so the orbit isn't static. Shader does R^-1 * p before sampling, R * flow
  // afterwards, so particle motion follows the rotated frame consistently.
  private sampleRotUniform = uniform(new THREE.Matrix3());
  private sampleRotInvUniform = uniform(new THREE.Matrix3());
  private sampleRotScratchEuler = new THREE.Euler();
  private sampleRotScratchMat4 = new THREE.Matrix4();

  // Attractor crossfade — during an archetype change, the shader evaluates
  // both the current and target flow fields and lerps between them. Preset
  // values (worldScale, containmentRadius, ...) are also lerped on CPU.
  private attractorTargetUniform = uniform(1);
  private crossfadeWeightUniform = uniform(0);
  private crossfadeRemaining = 0;
  private static readonly CROSSFADE_DURATION = 6;
  private fromPreset = ATTRACTOR_PRESETS.aizawa;
  private toPreset = ATTRACTOR_PRESETS.aizawa;

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
  private elapsed = 0;

  // Decorative scene elements.
  private synchronyRing?: THREE.Mesh;
  private synchronyRingMaterial?: THREE.MeshBasicMaterial;
  private static TIMER_SEGMENTS = 96;
  private projectorRings: THREE.Line[] = [];
  private projectorRingMaterial?: THREE.LineBasicMaterial;
  private projectorRingGeom?: THREE.BufferGeometry;

  // Field debug visualization (toggled with the dev overlay). A 3D grid of
  // line segments sampling the active attractor's flow, transformed by the
  // same rotation the compute shader uses so what we see matches what
  // particles feel.
  private static readonly FIELD_DEBUG_GRID = 7;
  private fieldDebugLines?: THREE.LineSegments;
  private fieldDebugGeom?: THREE.BufferGeometry;
  private fieldDebugMaterial?: THREE.LineBasicMaterial;
  private fieldDebugPositions?: Float32Array;
  private fieldDebugColors?: Float32Array;
  private fieldDebugVisible = false;
  private fieldDebugScratchSample = new THREE.Vector3();
  private fieldDebugScratchFlow = new THREE.Vector3();

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
    this.allocateSpectrumUniforms();
    this.buildComputePipelines();
    this.buildRenderMesh();
    this.buildSynchronyRing();
    this.buildProjectorRings();
    this.buildFieldDebugLines();

    this.applyAttractorPreset(this.currentAttractor);
    this.centerUniform.value.copy(this.center);
    this.particleSizeUniform.value = this.params.particleSize;
    this.particleOpacityUniform.value = this.params.particleOpacity;
    this.containmentStrengthUniform.value = this.params.containmentStrength;
    this.lifeMaxUniform.value = this.params.particleLifetime;
    this.fadeFractionUniform.value = this.params.fadeFraction;
    this.dissolveBurstUniform.value = this.params.dissolveBurstSpeed;
    this.duetBoostUniform.value = this.params.duetBoost;
    this.spectrumFlowGainUniform.value = this.params.spectrumFlowGain;
    this.spectrumPulseGainUniform.value = this.params.spectrumPulseGain;
    this.spectrumGlowGainUniform.value = this.params.spectrumGlowGain;
    this.spectrumOscillationUniform.value = this.params.spectrumOscillation;
    this.speedGlowUniform.value = this.params.speedGlow;
    this.stretchScaleUniform.value = this.params.stretchScale;
    this.affinityFalloffStartUniform.value = this.params.affinityFalloffStart;
    this.affinityFalloffEndUniform.value = this.params.affinityFalloffEnd;
    this.finalAffinityUniform.value = this.params.finalAffinity;
    this.fieldStrengthUniform.value = this.params.fieldStrength;
    this.fieldRotationRate = this.params.fieldRotationRate;

    this.registered = registerTweaks(paneDock, 'energySculptorBoundedLayers', SCULPTOR_DEFS, {
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
        speedGlow: v => { this.speedGlowUniform.value = v; },
        stretchScale: v => { this.stretchScaleUniform.value = v; },
        containmentStrength: v => { this.containmentStrengthUniform.value = v; },
        particleLifetime: v => { this.lifeMaxUniform.value = v; },
        fadeFraction: v => { this.fadeFractionUniform.value = v; },
        affinityFalloffStart: v => { this.affinityFalloffStartUniform.value = v; },
        affinityFalloffEnd: v => { this.affinityFalloffEndUniform.value = v; },
        finalAffinity: v => { this.finalAffinityUniform.value = v; },
        fieldStrength: v => { this.fieldStrengthUniform.value = v; },
        fieldRotationRate: v => { this.fieldRotationRate = v; },
        attractorOverride: v => { this.setAttractorOverride(v as 'auto' | AttractorKind); },
        dissolveBurstSpeed: v => { this.dissolveBurstUniform.value = v; },
        duetBoost: v => { this.duetBoostUniform.value = v; },
        spectrumFlowGain: v => { this.spectrumFlowGainUniform.value = v; },
        spectrumPulseGain: v => { this.spectrumPulseGainUniform.value = v; },
        spectrumGlowGain: v => { this.spectrumGlowGainUniform.value = v; },
        spectrumOscillation: v => { this.spectrumOscillationUniform.value = v; },
      },
    });
  }

  // Push the latest FFT snapshot into the GPU-side band uniforms. We mutate
  // the existing Vector4 instances in place — three's UniformArrayNode reads
  // their components on every dispatch, the same way it already does for
  // the spawn-queue Vector3 array.
  setMusicSpectrum(spectrum: MusicSpectrum): void {
    const n = Math.min(SPECTRUM_BAND_COUNT, spectrum.levels.length);
    for (let i = 0; i < n; i += 1) {
      const band = this.spectrumBandArray[i];
      band.x = spectrum.levels[i];
      band.y = spectrum.pulses[i];
    }
    this.spectrumOverallUniform.value = spectrum.overall;
  }

  // ---------------------------------------------------------------------- emit

  emit(req: EmitRequest): void {
    if (this.dissolveMode > 0) return;
    this.pendingEmits.push(req);
  }

  setArchetype(id: ArchetypeId): void {
    if (this.currentArchetype === id) return;
    this.currentArchetype = id;
    // Manual dropdown override pins the attractor — skip archetype-driven swaps.
    if (this.attractorOverride !== 'auto') return;
    const next = ARCHETYPE_TO_ATTRACTOR[id];
    if (next !== this.currentAttractor) {
      this.currentAttractor = next;
      this.beginAttractorCrossfade(next);
    }
  }

  // Pin the active attractor (or 'auto' to resume archetype-driven selection).
  // Called from the tweakpane dropdown's onChange.
  private setAttractorOverride(override: 'auto' | AttractorKind): void {
    this.attractorOverride = override;
    const target: AttractorKind = override === 'auto'
      ? ARCHETYPE_TO_ATTRACTOR[this.currentArchetype]
      : override;
    if (target !== this.currentAttractor) {
      this.currentAttractor = target;
      this.beginAttractorCrossfade(target);
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

  // Toggle the field debug visualization. Hooked from main.ts/Game so it
  // tracks the DevOverlay's `/` key.
  setDebugVisible(visible: boolean): void {
    this.fieldDebugVisible = visible;
    if (this.fieldDebugLines) this.fieldDebugLines.visible = visible;
  }

  // -------------------------------------------------------------------- update

  update(delta: number): void {
    if (delta <= 0) return;
    const dt = Math.min(delta, 1 / 30);
    this.dtUniform.value = dt;
    this.elapsed += delta;

    // Music + synchrony decay.
    this.synchronyBoost = Math.max(0, this.synchronyBoost * Math.exp(-delta * 4.5));
    this.synchronyBoostUniform.value = this.synchronyBoost;
    this.musicPulseUniform.value = this.musicField.pulse;
    this.musicLevelUniform.value = this.musicField.drumLevel;
    this.musicIntensityUniform.value = this.musicField.intensity;
    this.grooveUniform.value = this.musicField.groovePhase * TAU;
    // Spectrum oscillator phase advances unconditionally — bands modulate
    // its amplitude, but the time base must stay smooth even when bands go
    // silent so the wobble doesn't snap between frames.
    this.spectrumTimeUniform.value = this.elapsed;
    this.tickSynchronyRing(delta);
    this.updateProjectorRing();
    this.tickSampleRotation();
    this.tickAttractorCrossfade(delta);
    this.tickFieldDebug();

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
    this.fieldDebugLines?.removeFromParent();
    this.fieldDebugGeom?.dispose();
    this.fieldDebugMaterial?.dispose();
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

  private allocateSpectrumUniforms(): void {
    for (let i = 0; i < SPECTRUM_BAND_COUNT; i += 1) {
      this.spectrumBandArray.push(new THREE.Vector4(0, 0, 0, 0));
    }
    this.spectrumBandUniform = uniformArray(this.spectrumBandArray, 'vec4');
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

    // Helper: branch over the attractor index uniform and assign the matching
    // flow vector. Used twice — once for the current attractor and once for
    // the crossfade target — so we can lerp between two fields smoothly.
    const sampleFlow = (sel: any, samplePos: any) => {
      const out = vec3(0).toVar();
      If(sel.lessThan(0.5), () => {
        out.assign(thomasFlow(samplePos, this.thomasA));
      });
      If(sel.greaterThanEqual(0.5).and(sel.lessThan(1.5)), () => {
        out.assign(lorenzFlow(samplePos, this.lorenzSigma, this.lorenzRho, this.lorenzBeta));
      });
      If(sel.greaterThanEqual(1.5).and(sel.lessThan(2.5)), () => {
        out.assign(aizawaFlow(
          samplePos,
          this.aizawaA,
          this.aizawaB,
          this.aizawaC,
          this.aizawaD,
          this.aizawaE,
          this.aizawaF,
        ));
      });
      If(sel.greaterThanEqual(2.5).and(sel.lessThan(3.5)), () => {
        out.assign(halvorsenFlow(samplePos, this.halvorsenA));
      });
      If(sel.greaterThanEqual(3.5).and(sel.lessThan(4.5)), () => {
        out.assign(rosslerFlow(samplePos, this.rosslerA, this.rosslerB, this.rosslerC));
      });
      If(sel.greaterThanEqual(4.5), () => {
        out.assign(dadrasFlow(
          samplePos,
          this.dadrasP,
          this.dadrasO,
          this.dadrasR,
          this.dadrasC,
          this.dadrasE,
        ));
      });
      return out;
    };

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

      // Sample the attractor in a slowly-rotating frame: unrotate the position
      // (R^-1 * p), evaluate the flow there, then rotate the flow back into
      // particle space (R * f). The orbits stay structurally intact but tumble
      // through world space, giving a "moving through a meta-realm" feel.
      const samplePos = this.sampleRotInvUniform.mul(pos);
      const flowA = sampleFlow(this.attractorSelectUniform, samplePos);
      const flowB = sampleFlow(this.attractorTargetUniform, samplePos);
      const sampledFlow = mix(flowA, flowB, this.crossfadeWeightUniform);
      const rawFlow = this.sampleRotUniform.mul(sampledFlow);
      const r = pos.length();
      const radial = pos.div(r.max(0.0001));
      const radialFlow = radial.mul(rawFlow.dot(radial));
      const tangentialFlow = rawFlow.sub(radialFlow.mul(0.82));
      const flowLen = tangentialFlow.length();
      const flow = tangentialFlow.div(flowLen.max(0.0001)).mul(flowLen.clamp(0, 3.25));

      // Per-particle band assignment: stable through the particle's life so
      // its motion belongs to one slice of the spectrum. instanceIndex is
      // uint; element() takes a uint, so the cast happens implicitly.
      const bandIdx = instanceIndex.mod(uint(SPECTRUM_BAND_COUNT));
      const bandData = this.spectrumBandUniform.element(bandIdx);
      const bandLevel = bandData.x.toVar();
      const bandPulse = bandData.y.toVar();
      // Each band oscillates at its own rate so low frequencies wobble slowly
      // and high frequencies shimmer fast — gives the visible "different
      // frequencies behave differently" reading the user is after.
      const bandIdxF = bandIdx.toFloat();
      const bandRate = float(2.4).add(bandIdxF.mul(2.6));
      const bandPhase = bandIdxF.mul(0.7);
      const bandWave = sin(this.spectrumTimeUniform.mul(bandRate).add(bandPhase));

      // Music modulation: pulse boosts flow speed; sustained adds gentle swirl.
      // Per-band level layers on top so loud bass / loud highs each push their
      // own particles harder.
      const fftFlow = bandLevel.mul(this.spectrumFlowGainUniform);
      const musicGain = float(1)
        .add(this.musicPulseUniform.mul(0.55))
        .add(this.musicIntensityUniform.mul(0.18))
        .add(fftFlow);
      const synchronyGain = float(1).add(this.synchronyBoostUniform.mul(this.duetBoostUniform));
      const speedGain = this.flowSpeedUniform.mul(musicGain).mul(synchronyGain);

      // Age fraction (0 born → 1 dead).
      const lifeT = m.x.div(m.y.max(0.0001)).clamp(0, 1);
      const fadeStart = float(1).sub(this.fadeFractionUniform);

      // Affinity = how much the particle is influenced by the field. Starts at
      // 1 (full pull) and ramps toward `finalAffinity` between
      // `affinityFalloffStart` and `affinityFalloffEnd` of normalized lifetime.
      const falloffT = smoothstep(this.affinityFalloffStartUniform, this.affinityFalloffEndUniform, lifeT)
        .clamp(0, 1);
      const affinity = mix(float(1), this.finalAffinityUniform, falloffT).clamp(0, 1);
      const flowInfluence = affinity;

      // Drag scales with (1 - affinity) so when the field stops pulling, the
      // remaining velocity damps out and particles come to rest.
      const activeDrag = float(0.55).add(float(1).sub(this.velocityBlendUniform).mul(3.0));
      const settledDrag = activeDrag.add(3.2);
      const drag = mix(activeDrag, settledDrag, float(1).sub(affinity));

      // Soft containment: push runaways back inside the safe radius. Treated
      // as part of the field, so it scales with field strength too — when
      // `fieldStrength = 0` no forces act on the particles at all.
      const overshoot = smoothstep(this.containmentRadiusUniform.mul(0.72), this.containmentRadiusUniform.mul(0.94), r);
      const inward = radial.negate().mul(overshoot).mul(this.containmentStrengthUniform);
      const innerCore = float(1).sub(smoothstep(
        this.containmentRadiusUniform.mul(0.06),
        this.containmentRadiusUniform.mul(0.18),
        r,
      ));
      const coreRepel = radial.mul(innerCore).mul(this.containmentStrengthUniform).mul(0.28);
      // Per-band impulse split: low bands get a radial kick (kick drum, sub
      // → bass shells push outward), high bands get a tangential shimmer
      // (hi-hats, cymbals → swirl on the surface). The mix shifts smoothly
      // across the band index.
      const bandT = bandIdxF.div(float(Math.max(1, SPECTRUM_BAND_COUNT - 1)));
      const radialMix = float(1).sub(bandT).mul(0.85).add(0.15);
      const tangentMix = bandT.mul(1.05).add(0.1);
      // Stable side vector for tangential motion: cross of radial with the
      // sample-rotation Y axis. Picks an axis that drifts with the field,
      // so the shimmer stays visually coherent with the orbit.
      const upRef = this.sampleRotUniform.mul(vec3(0, 1, 0));
      const sideRaw = radial.cross(upRef);
      const side = sideRaw.div(sideRaw.length().max(0.0001));
      const pulseMag = bandPulse.mul(this.spectrumPulseGainUniform);
      const radialKick = radial.mul(pulseMag.mul(radialMix));
      const tangentKick = side.mul(pulseMag.mul(tangentMix));
      // Sustained per-band oscillation: a small wobble along `side` whose
      // amplitude scales with the band's running level. Gives a continuous
      // "the spectrum is breathing through me" feel even between transients.
      const oscillation = side.mul(bandWave.mul(bandLevel).mul(this.spectrumOscillationUniform));

      // Every force is gated by `flowInfluence` (and the master `fieldStrength`)
      // so when affinity → 0 the field stops acting on the particle entirely
      // and the (now-stronger) drag wins, parking it where it last drifted.
      const accel = flow.mul(speedGain)
        .add(inward)
        .add(coreRepel)
        .add(radialKick).add(tangentKick).add(oscillation)
        .mul(flowInfluence)
        .mul(this.fieldStrengthUniform);
      const dragFactor = float(1).div(float(1).add(drag.mul(this.dtUniform)));
      const newVel = vel.add(accel.mul(this.dtUniform)).mul(dragFactor).toVar();
      // Young particles need to actually travel from emit origin into the
      // sculpture before getting parked on the attractor — clamp them loosely
      // so a starlace pluck or drum hit reads as a visible stream. The floor
      // is 0 so finalAffinity=0 means literally not moving.
      const youngBoost = float(1).sub(m.x.div(0.6).clamp(0, 1));
      const maxWorldSpeed = mix(float(0), mix(0.42, 1.4, youngBoost), affinity);
      const maxSpeed = maxWorldSpeed.div(this.worldScaleUniform.max(0.001));
      const speedNow = newVel.length();
      // Guard the denominator: when both maxSpeed and speedNow are 0 (a fully
      // settled, fully stilled particle) this would otherwise produce NaN.
      const speedDenom = speedNow.max(maxSpeed).max(float(1e-5));
      newVel.assign(newVel.mul(maxSpeed.div(speedDenom)));

      // Dissolve burst: blow particles outward away from origin and shorten life.
      const dm = this.dissolveModeUniform;
      const outward = pos.normalize().mul(this.dissolveBurstUniform);
      newVel.assign(mix(newVel, outward, dm));

      const newPos = pos.add(newVel.mul(this.dtUniform));

      // Age + alpha.
      const ageStep = this.dtUniform.mul(float(1).add(dm.mul(2.0)));
      const newAge = m.x.add(ageStep);
      const lifeMax = m.y;
      const newLifeT = newAge.div(lifeMax.max(0.0001)).clamp(0, 1);
      // Linear fade-in over 0.04s (born), linear fade-out over fadeFraction of life.
      // Short fade-in so emit-bursts read as emanating from the source node,
      // not blooming into existence already mid-flight.
      const born = newAge.div(0.04).clamp(0, 1);
      const fadeOut = float(1).sub(smoothstep(fadeStart, 1.0, newLifeT));
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
    const viewVel = cameraViewMatrix.mul(vec4(
      vel.x.mul(this.worldScaleUniform),
      vel.y.mul(this.worldScaleUniform),
      vel.z.mul(this.worldScaleUniform),
      0,
    ));
    const angle = atan(viewVel.y, viewVel.x);
    material.rotationNode = angle;

    // Sprite scale: a lifted-then-faded curve so newborn particles bloom in
    // and dying ones shrink all the way to nothing instead of leaving a small
    // residual disc. fadeShape = alpha * (0.4 + 0.6*alpha) — close to 1 in
    // the middle of life, monotonically → 0 at end so the particle smoothly
    // disappears. No size floor, so the visible "pop" at lifeMax is gone.
    const fadeShape = alpha.mul(float(0.4).add(alpha.mul(0.6)));
    const sizeBase = this.particleSizeUniform.mul(fadeShape);
    material.scaleNode = vec2(sizeBase.mul(stretchSafe), sizeBase.div(stretchSafe));

    // Per-particle band lookup for the render brightness term. Same band the
    // integrate pass used, so brightness and motion line up.
    const renderBandIdx = instanceIndex.mod(uint(SPECTRUM_BAND_COUNT));
    const renderBand = this.spectrumBandUniform.element(renderBandIdx);
    const renderBandLevel = renderBand.x;
    const renderBandPulse = renderBand.y;

    // Color: base color, brightened by speed, music pulse, and per-band fft
    // energy. Multiplied by alphaLife so dead particles contribute nothing
    // under additive blending.
    const baseColor = this.colorsBuffer.toAttribute();
    const speedTerm = speed.mul(0.05).clamp(0, 1).mul(this.speedGlowUniform);
    const musicTerm = this.musicPulseUniform.mul(0.35);
    const fftTerm = renderBandLevel.mul(0.45).add(renderBandPulse.mul(this.spectrumGlowGainUniform));
    const glow = float(0.55).add(speedTerm).add(musicTerm).add(fftTerm);
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

  // Mutually irrational base periods (in seconds) for the three Euler axes.
  // Picked so the rotation never repeats — the sampling frame just keeps
  // wandering through new orientations.
  private static readonly ROT_PERIOD_X = 120;
  private static readonly ROT_PERIOD_Y = 187;
  private static readonly ROT_PERIOD_Z = 251;

  private tickSampleRotation(): void {
    const rate = this.fieldRotationRate;
    const t = this.elapsed * rate;
    const yaw = (t / EnergySculptor.ROT_PERIOD_X) * TAU;
    const pitch = (t / EnergySculptor.ROT_PERIOD_Y) * TAU;
    const roll = (t / EnergySculptor.ROT_PERIOD_Z) * TAU;
    this.sampleRotScratchEuler.set(yaw, pitch, roll, 'XYZ');
    this.sampleRotScratchMat4.makeRotationFromEuler(this.sampleRotScratchEuler);
    this.sampleRotUniform.value.setFromMatrix4(this.sampleRotScratchMat4);
    // Rotation matrices are orthogonal → inverse is the transpose. Cheaper
    // than calling .invert() and avoids the determinant check.
    this.sampleRotInvUniform.value.copy(this.sampleRotUniform.value).transpose();
  }

  // Build a 3D grid of line segments (one per cell, two vertices each). Each
  // frame `tickFieldDebug` rewrites the geometry to point along the current
  // flow at that grid cell. Initially hidden.
  private buildFieldDebugLines(): void {
    const N = EnergySculptor.FIELD_DEBUG_GRID;
    const cells = N * N * N;
    const verts = cells * 2;
    this.fieldDebugPositions = new Float32Array(verts * 3);
    this.fieldDebugColors = new Float32Array(verts * 3);
    // Color the start of each segment dim and the tip bright so direction reads.
    for (let i = 0; i < cells; i += 1) {
      const o = i * 6;
      this.fieldDebugColors[o + 0] = 0.10;
      this.fieldDebugColors[o + 1] = 0.35;
      this.fieldDebugColors[o + 2] = 0.55;
      this.fieldDebugColors[o + 3] = 0.45;
      this.fieldDebugColors[o + 4] = 0.95;
      this.fieldDebugColors[o + 5] = 1.00;
    }
    this.fieldDebugGeom = new THREE.BufferGeometry();
    this.fieldDebugGeom.setAttribute('position', new THREE.BufferAttribute(this.fieldDebugPositions, 3));
    this.fieldDebugGeom.setAttribute('color', new THREE.BufferAttribute(this.fieldDebugColors, 3));
    this.fieldDebugMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.fieldDebugLines = new THREE.LineSegments(this.fieldDebugGeom, this.fieldDebugMaterial);
    this.fieldDebugLines.visible = false;
    this.fieldDebugLines.frustumCulled = false;
    this.fieldDebugLines.renderOrder = 31;
    this.scene.add(this.fieldDebugLines);
  }

  private tickFieldDebug(): void {
    if (!this.fieldDebugVisible) return;
    if (!this.fieldDebugLines || !this.fieldDebugGeom || !this.fieldDebugPositions) return;

    const N = EnergySculptor.FIELD_DEBUG_GRID;
    const radius = this.containmentRadiusUniform.value;
    const worldScale = this.worldScaleUniform.value;
    // Span ±0.85 of the safe radius so arrows live where particles actually fly.
    const half = radius * 0.85;
    const step = (N > 1) ? (2 * half) / (N - 1) : 0;
    // Length of each arrow in attractor space — we then renormalize per-cell so
    // strong-flow regions don't blow out and dead-zone arrows still read.
    const lineLenAttractor = step * 0.6;

    const rot = this.sampleRotUniform.value;
    const invRot = this.sampleRotInvUniform.value;
    const cx = this.center.x;
    const cy = this.center.y;
    const cz = this.center.z;
    const sample = this.fieldDebugScratchSample;
    const flow = this.fieldDebugScratchFlow;
    const positions = this.fieldDebugPositions;

    let idx = 0;
    for (let i = 0; i < N; i += 1) {
      const x = -half + i * step;
      for (let j = 0; j < N; j += 1) {
        const y = -half + j * step;
        for (let k = 0; k < N; k += 1) {
          const z = -half + k * step;
          // Mirror compute: sample the flow at invRot * p, then rotate flow back.
          sample.set(x, y, z).applyMatrix3(invRot);
          this.evaluateFlow(sample, flow);
          flow.applyMatrix3(rot);
          // Normalize flow to a fixed visual length (with a small minimum so
          // near-zero-flow cells still show their orientation).
          const flowLen = flow.length();
          const visLen = lineLenAttractor / Math.max(flowLen, 0.0001);
          const ex = x + flow.x * visLen;
          const ey = y + flow.y * visLen;
          const ez = z + flow.z * visLen;
          // Attractor-space → world-space, anchored at the sculptor center.
          positions[idx + 0] = cx + x * worldScale;
          positions[idx + 1] = cy + y * worldScale;
          positions[idx + 2] = cz + z * worldScale;
          positions[idx + 3] = cx + ex * worldScale;
          positions[idx + 4] = cy + ey * worldScale;
          positions[idx + 5] = cz + ez * worldScale;
          idx += 6;
        }
      }
    }
    (this.fieldDebugGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  // CPU mirror of the TSL flow functions — sample the active attractor (and
  // crossfade target if mid-fade) in attractor-space. Writes into `out`.
  private evaluateFlow(p: THREE.Vector3, out: THREE.Vector3): void {
    const sel = this.attractorSelectUniform.value;
    this.evaluateFlowOne(sel, p, out);
    const w = this.crossfadeWeightUniform.value;
    if (w > 0) {
      const tgt = this.attractorTargetUniform.value;
      const bx = out.x, by = out.y, bz = out.z;
      this.evaluateFlowOne(tgt, p, out);
      out.set(
        bx + (out.x - bx) * w,
        by + (out.y - by) * w,
        bz + (out.z - bz) * w,
      );
    }
  }

  private evaluateFlowOne(sel: number, p: THREE.Vector3, out: THREE.Vector3): void {
    const x = p.x, y = p.y, z = p.z;
    if (sel < 0.5) {
      // Thomas
      const a = this.thomasA.value;
      out.set(-a * x + Math.sin(y), -a * y + Math.sin(z), -a * z + Math.sin(x));
    } else if (sel < 1.5) {
      // Lorenz
      const sigma = this.lorenzSigma.value;
      const rho = this.lorenzRho.value;
      const beta = this.lorenzBeta.value;
      out.set(sigma * (y - x), x * (rho - z) - y, x * y - beta * z);
    } else if (sel < 2.5) {
      // Aizawa
      const a = this.aizawaA.value;
      const b = this.aizawaB.value;
      const c = this.aizawaC.value;
      const d = this.aizawaD.value;
      const e = this.aizawaE.value;
      const f = this.aizawaF.value;
      const r2 = x * x + y * y;
      out.set(
        (z - b) * x - d * y,
        d * x + (z - b) * y,
        c + a * z - (z * z * z) / 3 - r2 * (1 + e * z) + f * z * x * x * x,
      );
    } else if (sel < 3.5) {
      // Halvorsen
      const a = this.halvorsenA.value;
      out.set(
        -a * x - 4 * y - 4 * z - y * y,
        -a * y - 4 * z - 4 * x - z * z,
        -a * z - 4 * x - 4 * y - x * x,
      );
    } else if (sel < 4.5) {
      // Rössler
      const a = this.rosslerA.value;
      const b = this.rosslerB.value;
      const c = this.rosslerC.value;
      out.set(-y - z, x + a * y, b + z * (x - c));
    } else {
      // Dadras
      const pp = this.dadrasP.value;
      const o = this.dadrasO.value;
      const r = this.dadrasR.value;
      const c = this.dadrasC.value;
      const e = this.dadrasE.value;
      out.set(
        y - pp * x + o * y * z,
        r * y - x * z + z,
        c * x * y - e * z,
      );
    }
  }

  private tickAttractorCrossfade(delta: number): void {
    if (this.crossfadeRemaining <= 0) return;
    this.crossfadeRemaining = Math.max(0, this.crossfadeRemaining - delta);
    const dur = EnergySculptor.CROSSFADE_DURATION;
    const t = 1 - this.crossfadeRemaining / dur;
    const eased = t * t * (3 - 2 * t); // smoothstep
    this.crossfadeWeightUniform.value = eased;
    const from = this.fromPreset;
    const to = this.toPreset;
    this.worldScaleUniform.value = lerp(from.worldScale, to.worldScale, eased);
    this.containmentRadiusUniform.value = lerp(from.containmentRadius, to.containmentRadius, eased);
    this.velocityBlendUniform.value = lerp(from.velocityBlend, to.velocityBlend, eased);
    this.flowSpeedUniform.value = lerp(from.dt, to.dt, eased);
    if (this.crossfadeRemaining === 0) {
      // Snap select to the new attractor and reset the weight so any future
      // crossfade starts from a clean lerp(flowA, flowB, 0) state.
      this.attractorSelectUniform.value = this.attractorTargetUniform.value;
      this.crossfadeWeightUniform.value = 0;
      this.fromPreset = this.toPreset;
    }
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
      const dirLen = dirNormSq > 1e-6 ? Math.sqrt(dirNormSq) : 1;
      const dirX = dirNormSq > 1e-6 ? req.direction.x / dirLen : 0;
      const dirY = dirNormSq > 1e-6 ? req.direction.y / dirLen : 1;
      const dirZ = dirNormSq > 1e-6 ? req.direction.z / dirLen : 0;
      const kind = req.kind === 'starlace' ? KIND_STARLACE : KIND_DRUM;
      const launchRadius = req.kind === 'starlace' ? 0.44 : 0.95;
      const coneSpread = req.kind === 'starlace' ? 0.62 : 0.48;
      const speedScale = req.kind === 'starlace' ? 1.28 : 0.92;

      // Build a stable basis around the instrument->sculpture direction. The
      // burst starts clustered, but each particle is launched toward a slightly
      // different slice of the active field instead of a single center ray.
      const upX = Math.abs(dirY) < 0.92 ? 0 : 1;
      const upY = Math.abs(dirY) < 0.92 ? 1 : 0;
      const upZ = 0;
      let sideX = dirY * upZ - dirZ * upY;
      let sideY = dirZ * upX - dirX * upZ;
      let sideZ = dirX * upY - dirY * upX;
      const sideLen = Math.hypot(sideX, sideY, sideZ) || 1;
      sideX /= sideLen;
      sideY /= sideLen;
      sideZ /= sideLen;
      const liftX = sideY * dirZ - sideZ * dirY;
      const liftY = sideZ * dirX - sideX * dirZ;
      const liftZ = sideX * dirY - sideY * dirX;

      for (let i = 0; i < allowed; i += 1) {
        const slot = cursor;
        // Origin: world → attractor space.
        const oxLocal = (req.origin.x - this.center.x) * invWorldScale;
        const oyLocal = (req.origin.y - this.center.y) * invWorldScale;
        const ozLocal = (req.origin.z - this.center.z) * invWorldScale;
        const theta = Math.random() * TAU;
        const disc = Math.sqrt(Math.random());
        const lateralA = Math.cos(theta) * disc;
        const lateralB = Math.sin(theta) * disc;
        const forwardJitter = (Math.random() - 0.5) * launchRadius * 0.28;
        const launchA = lateralA * launchRadius;
        const launchB = lateralB * launchRadius;
        this.spawnPosArray[slot].set(
          oxLocal + sideX * launchA + liftX * launchB + dirX * forwardJitter,
          oyLocal + sideY * launchA + liftY * launchB + dirY * forwardJitter,
          ozLocal + sideZ * launchA + liftZ * launchB + dirZ * forwardJitter,
        );

        // Initial velocity: emit direction, in attractor space. Magnitude is
        // still biased inward, but with enough lateral cone spread that one
        // burst fans into neighboring field streamlines before it settles.
        const seedSpeed = (0.4 + Math.random() * 0.6) * req.speed * speedScale;
        const lateralSpeed = seedSpeed * coneSpread * (0.35 + Math.random() * 0.65);
        const swirlSpeed = seedSpeed * coneSpread * (Math.random() - 0.5) * 0.55;
        this.spawnVelArray[slot].set(
          dirX * seedSpeed + sideX * lateralA * lateralSpeed + liftX * lateralB * lateralSpeed + sideX * swirlSpeed,
          dirY * seedSpeed + sideY * lateralA * lateralSpeed + liftY * lateralB * lateralSpeed + sideY * swirlSpeed,
          dirZ * seedSpeed + sideZ * lateralA * lateralSpeed + liftZ * lateralB * lateralSpeed + sideZ * swirlSpeed,
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

  private static readonly ATTRACTOR_INDEX: Record<AttractorKind, number> = {
    thomas: 0,
    lorenz: 1,
    aizawa: 2,
    halvorsen: 3,
    rossler: 4,
    dadras: 5,
  };

  // Snap to a preset instantly. Used at construction; runtime archetype
  // changes go through beginAttractorCrossfade so the field morphs smoothly.
  private applyAttractorPreset(kind: AttractorKind): void {
    const preset = ATTRACTOR_PRESETS[kind];
    this.worldScaleUniform.value = preset.worldScale;
    this.containmentRadiusUniform.value = preset.containmentRadius;
    this.velocityBlendUniform.value = preset.velocityBlend;
    this.flowSpeedUniform.value = preset.dt;
    const idx = EnergySculptor.ATTRACTOR_INDEX[kind];
    this.attractorSelectUniform.value = idx;
    this.attractorTargetUniform.value = idx;
    this.crossfadeWeightUniform.value = 0;
    this.fromPreset = preset;
    this.toPreset = preset;
    this.crossfadeRemaining = 0;
  }

  private beginAttractorCrossfade(kind: AttractorKind): void {
    // Snapshot the currently-displayed preset (which may itself be mid-lerp)
    // so the next crossfade starts from where we visually are. The target's
    // index goes into attractorTargetUniform; the shader then evaluates both
    // flows and lerps as crossfadeWeightUniform climbs from 0→1.
    const captured: AttractorPreset = {
      kind: this.fromPreset.kind,
      worldScale: this.worldScaleUniform.value,
      containmentRadius: this.containmentRadiusUniform.value,
      velocityBlend: this.velocityBlendUniform.value,
      dt: this.flowSpeedUniform.value,
    };
    this.fromPreset = captured;
    this.toPreset = ATTRACTOR_PRESETS[kind];
    this.attractorSelectUniform.value = EnergySculptor.ATTRACTOR_INDEX[captured.kind];
    this.attractorTargetUniform.value = EnergySculptor.ATTRACTOR_INDEX[kind];
    this.crossfadeWeightUniform.value = 0;
    this.crossfadeRemaining = EnergySculptor.CROSSFADE_DURATION;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
