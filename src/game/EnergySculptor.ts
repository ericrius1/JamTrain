import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Return,
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
  dadrasFlow,
  halvorsenFlow,
  lorenzFlow,
  rosslerFlow,
  thomasFlow,
  type AttractorKind,
  type AttractorPreset,
} from './sculptor/strangeAttractors';

type AttractorMode = 'cycle' | 'auto' | AttractorKind;

const ATTRACTOR_SEQUENCE: AttractorKind[] = ['thomas', 'lorenz', 'aizawa', 'halvorsen', 'rossler', 'dadras'];

const ATTRACTOR_OPTIONS = {
  cycle: 'cycle',
  auto: 'auto',
  thomas: 'thomas',
  lorenz: 'lorenz',
  aizawa: 'aizawa',
  halvorsen: 'halvorsen',
  rossler: 'rossler',
  dadras: 'dadras',
} as const satisfies Record<string, AttractorMode>;

type BlendingMode = 'additive' | 'normal' | 'subtractive' | 'multiply' | 'none';

const BLENDING_OPTIONS = {
  additive: 'additive',
  normal: 'normal',
  subtractive: 'subtractive',
  multiply: 'multiply',
  none: 'none',
} as const satisfies Record<string, BlendingMode>;

const BLENDING_LOOKUP: Record<BlendingMode, THREE.Blending> = {
  additive: THREE.AdditiveBlending,
  normal: THREE.NormalBlending,
  subtractive: THREE.SubtractiveBlending,
  multiply: THREE.MultiplyBlending,
  none: THREE.NoBlending,
};

const PARTICLE_COUNT = 1024288;
// const PARTICLE_COUNT = 524288;


const ATTRACTOR_LABELS: Record<AttractorKind, string> = {
  thomas: 'Thomas',
  lorenz: 'Lorenz',
  aizawa: 'Aizawa',
  halvorsen: 'Halvorsen',
  rossler: 'Rossler',
  dadras: 'Dadras',
};

// Spawn queue is a TSL uniform array sized to fit a WebGPU UBO (~64KB),
// large enough that no realistic per-frame burst hits it. The only
// user-visible cap on particles is the total pool size.
const SPAWN_QUEUE_CAPACITY = 4096;
const DEFAULT_ATTRACTOR_HOLD_SECONDS = 20;
const DEFAULT_ATTRACTOR_TRANSITION_SECONDS = 5;

export const SCULPTOR_DEFS = {
  particleSize:       { default: 0.005, min: 0.001, max: 0.03, step: 0.001, folder: 'Particles', label: 'particle size' },
  particleOpacity:    { default: 0.85,  min: 0.1,   max: 1,    step: 0.01,  folder: 'Particles', label: 'particle opacity' },
  particleLifetime:   { default: 50,    min: 1,     max: 240,  step: 0.5,   folder: 'Particles', label: 'particle lifetime' },
  opacityFadeStart:   { default: 0.90,  min: 0,     max: 1,    step: 0.01,  folder: 'Particles', label: 'fade start' },
  blendingMode:       { type: 'select' as const, default: 'additive' as const, options: BLENDING_OPTIONS, folder: 'Particles', label: 'blending' },

  fieldStrength:      { default: 0.8,   min: 0,     max: 2,    step: 0.05,  folder: 'Field Affinity', label: 'field strength' },
  fieldFalloffStart:  { default: 0.0,   min: 0,     max: 1,    step: 0.01,  folder: 'Field Affinity', label: 'decay start' },
  fieldFalloffEnd:    { default: 0.1,   min: 0,     max: 1,    step: 0.01,  folder: 'Field Affinity', label: 'decay end' },
  finalFieldEffect:   { default: 0.1,   min: 0,     max: 1,    step: 0.01,  folder: 'Field Affinity', label: 'final affinity' },

  fieldVolumeScale:   { default: 0.55,  min: 0.05,  max: 2.5,  step: 0.01,  folder: 'Field Bounds', label: 'volume scale' },
  fieldSphereRadius:  { default: 1.0,   min: 0.2,   max: 2.2,  step: 0.01,  folder: 'Field Bounds', label: 'sphere radius' },
  fieldSphereCenterY: { default: 0.12,  min: -0.5,  max: 1.1,  step: 0.01,  folder: 'Field Bounds', label: 'center height' },
  volumeAutoEnabled:  { type: 'boolean' as const, default: true,             folder: 'Field Bounds', label: 'auto cycle' },
  volumeAutoCycleS:   { default: 50,    min: 5,     max: 240,  step: 0.5,    folder: 'Field Bounds', label: 'cycle s' },
  volumeAutoSteps:    { default: 10,    min: 2,     max: 40,   step: 1,      folder: 'Field Bounds', label: 'steps' },
  volumeAutoMin:      { default: 0.2,   min: 0.05,  max: 2.5,  step: 0.01,   folder: 'Field Bounds', label: 'cycle min' },
  volumeAutoMax:      { default: 0.5,   min: 0.05,  max: 2.5,  step: 0.01,   folder: 'Field Bounds', label: 'cycle max' },

  fieldRotationRate:  { default: 10,   min: 0,     max: 20,   step: 0.05,  folder: 'Field Shape', label: 'rotation speed' },
  fieldDebugDensity:  { default: 20,    min: 3,     max: 30,   step: 1,     folder: 'Field Shape', label: 'debug density' },
  attractorOverride:  { type: 'select' as const, default: 'cycle' as const, options: ATTRACTOR_OPTIONS, folder: 'Field Shape', label: 'attractor' },
  attractorHoldSeconds:       { default: DEFAULT_ATTRACTOR_HOLD_SECONDS,       min: 1,   max: 120, step: 0.5, folder: 'Field Shape', label: 'hold s' },
  attractorTransitionSeconds: { default: DEFAULT_ATTRACTOR_TRANSITION_SECONDS, min: 0.1, max: 30,  step: 0.1, folder: 'Field Shape', label: 'xfade s' },

  rippleEnabled:        { type: 'boolean' as const, default: true,           folder: 'Bass Ripple', label: 'enabled' },
  rippleSpeed:          { default: 0.55,  min: 0.05, max: 3,    step: 0.01,  folder: 'Bass Ripple', label: 'speed m/s' },
  rippleWidth:          { default: 0.13,  min: 0.02, max: 0.6,  step: 0.005, folder: 'Bass Ripple', label: 'shell width' },
  rippleAmplitude:      { default: 0.55,  min: 0,    max: 4,    step: 0.01,  folder: 'Bass Ripple', label: 'impulse amp' },
  rippleLifetime:       { default: 3.0,   min: 0.3,  max: 8,    step: 0.05,  folder: 'Bass Ripple', label: 'lifetime s' },
  rippleSensitivity:    { default: 1.0,   min: 0.1,  max: 3,    step: 0.05,  folder: 'Bass Ripple', label: 'sensitivity' },

  timerRingRadius:      { default: 0.46,  min: 0.18, max: 1.2,  step: 0.01,  folder: 'Projector', label: 'base radius' },
  projectorRingCount:   { default: 5,     min: 1,    max: 5,    step: 1,     folder: 'Projector', label: 'ring count' },
  projectorRingSpacing: { default: 0.020, min: 0.01, max: 0.25, step: 0.005, folder: 'Projector', label: 'ring spacing' },
  projectorRingScale:   { default: 0.58,  min: 0.4,  max: 1.0,  step: 0.01,  folder: 'Projector', label: 'ring scale' },
  projectorBaseY:       { default: -0.32, min: -0.6, max: 0.3,  step: 0.01,  folder: 'Projector', label: 'base height' },
  timerRingColor:       { type: 'color', default: '#66ffff', folder: 'Projector', label: 'projector rings' },
} as const;

export type SculptorParams = ParamsOf<typeof SCULPTOR_DEFS>;

const TAU = Math.PI * 2;
const MIN_PARTICLE_LIFETIME = 1;

const ARCHETYPE_TO_ATTRACTOR: Record<ArchetypeId, AttractorKind> = {
  oarOar: 'lorenz',
  melodyMelody: 'thomas',
  oarMelody: 'aizawa',
};

/**
 * GPU-compute particle sculpture. All particle state lives in TSL
 * `instancedArray` storage buffers; one compute pass injects new particles
 * each frame, another integrates every alive particle through the active
 * archetype's strange-attractor flow field. Field influence falls from full
 * strength to the adjustable final field effect over normalized lifetime, so
 * streams can keep moving or freeze into a layered record of the music.
 */
export class EnergySculptor implements EnergySink {
  readonly center: THREE.Vector3;
  readonly params: SculptorParams;

  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private mesh!: THREE.InstancedMesh;
  private material!: THREE.SpriteNodeMaterial;

  private readonly count = PARTICLE_COUNT;
  private spawnCursorCpu = 0;
  private activeSlotCountCpu = 0;
  private pendingEmits: EmitRequest[] = [];

  // CPU-side bookkeeping for the live-particle counter shown in DevOverlay.
  // Each emit batch records the in-flight count and lifetime captured at spawn
  // time; `getAliveParticleCount` prunes expired batches and sums the rest.
  private aliveBatches: { spawnedAt: number; count: number; lifeMax: number }[] = [];

  // Per-particle GPU storage. Packed to keep the hot path at three storage
  // reads/writes instead of four:
  // positionAge = (position.xyz, age seconds)
  // colorLife = (color.rgb, lifeMax seconds)
  private positionAgeBuffer!: THREE.StorageBufferNode<'vec4'>;
  private velocityBuffer!: THREE.StorageBufferNode<'vec3'>;
  private colorLifeBuffer!: THREE.StorageBufferNode<'vec4'>;

  // Spawn queue uniforms (uniformArray mutated on CPU each frame, auto-uploaded).
  private spawnPosArray: THREE.Vector3[] = [];
  private spawnVelArray: THREE.Vector3[] = [];
  private spawnColorArray: THREE.Vector3[] = [];
  // x=lifeMax, yz reserved
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
  private activeSlotCountUniform = uniform(0);
  private spawnsThisFrame = 0;

  // Integration uniforms.
  private dtUniform = uniform(1 / 60);
  private ageDtUniform = uniform(1 / 60);
  private flowSpeedUniform = uniform(1);
  private worldScaleUniform = uniform(0.014);
  private lifeMaxUniform = uniform(28);
  private opacityFadeStartUniform = uniform(0.90);
  private centerUniform = uniform(new THREE.Vector3());
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
  private rosslerA = uniform(0.2);
  private rosslerB = uniform(0.2);
  private rosslerC = uniform(5.7);
  private dadrasP = uniform(3);
  private dadrasO = uniform(2.7);
  private dadrasR = uniform(1.7);
  private dadrasC = uniform(2);
  private dadrasE = uniform(9);

  private fieldRotationRate = 1.0;
  // cycle = timed preset tour, auto = follow archetype-driven attractor,
  // otherwise pin to the chosen kind.
  private attractorOverride: AttractorMode = 'cycle';

  // Lifetime-keyed field affinity. A particle keeps full field influence until
  // normalizedAge reaches fieldFalloffStart, then eases to finalFieldEffect by
  // fieldFalloffEnd and holds that affinity for the rest of its life. Affinity
  // is purely a flow-strength multiplier — particle lifetime is independent
  // and a particle never dies from low affinity. At finalFieldEffect=0 the
  // settle drag (proportional to 1-fieldEffect) bleeds momentum to ~0 over
  // ~1s, so particles drift to a stop in place instead of being yanked there.
  private fieldFalloffStartUniform = uniform(0.0);
  private fieldFalloffEndUniform = uniform(0.2);
  private finalFieldEffectUniform = uniform(0.0);
  // Master force multiplier — 0 means no acceleration is applied to particles.
  private fieldStrengthUniform = uniform(1.0);
  // Attractor-coordinate to world-coordinate scale used when sampling the
  // field. Particle positions themselves are stored in world-relative meters
  // so settled particles do not move when this changes during a transition.
  private fieldSphereRadiusUniform = uniform(0.55);
  private fieldSphereCenterYUniform = uniform(0.12);

  // Bass-driven ripple — radiates a thin gaussian shell outward from the field
  // center. Particle positions are stored as world-relative offsets, so the
  // center vector here is in particle space. Age ticks up each frame; when it
  // exceeds rippleLifetime the lifeFade clamps to zero and the impulse is
  // inert until the next beat resets it.
  private rippleCenterUniform = uniform(new THREE.Vector3());
  private rippleAgeUniform = uniform(1e6);
  private rippleSpeedUniform = uniform(0.55);
  private rippleWidthUniform = uniform(0.13);
  private rippleAmpUniform = uniform(0.55);
  private rippleLifetimeUniform = uniform(3.0);
  private rippleIntensityUniform = uniform(0);

  // Sample-space rotation — slowly tumbles the attractor through world space
  // so the orbit isn't static. Shader does R^-1 * p before sampling, R * flow
  // afterwards, so particle motion follows the rotated frame consistently.
  private sampleRotUniform = uniform(new THREE.Matrix3());
  private sampleRotInvUniform = uniform(new THREE.Matrix3());
  private sampleRotScratchEuler = new THREE.Euler();
  private sampleRotScratchMat4 = new THREE.Matrix4();

  // Attractor crossfade — during an archetype change, the shader evaluates
  // both the current and target flow fields and lerps between them. Preset
  // scale/speed values are also lerped on CPU.
  private static readonly CROSSFADE_DURATION = DEFAULT_ATTRACTOR_TRANSITION_SECONDS;
  private static readonly MAX_ATTRACTOR_CYCLE_TICK = 0.25;
  private attractorTargetUniform = uniform(1);
  private crossfadeWeightUniform = uniform(0);
  private crossfadeRemaining = 0;
  private crossfadeDuration = EnergySculptor.CROSSFADE_DURATION;
  private fromPreset = ATTRACTOR_PRESETS.thomas;
  private toPreset = ATTRACTOR_PRESETS.thomas;

  // Compute passes (ComputeNode produced by Fn(...)().compute(N)).
  private emitCompute!: THREE.ComputeNode;
  private integrateComputeByAttractor!: Record<AttractorKind, THREE.ComputeNode>;
  private integrateCrossfadeCompute!: THREE.ComputeNode;

  // Frame state.
  private currentArchetype: ArchetypeId = 'oarMelody';
  private currentAttractor: AttractorKind = 'thomas';
  private transitionTarget: AttractorKind = 'thomas';
  private attractorCycleIndex = 0;
  private attractorCycleElapsed = 0;
  private attractorCyclePhase: 'hold' | 'transition' = 'hold';
  private synchronyBoost = 0;
  private elapsed = 0;
  private volumeAutoElapsed = 0;
  private volumeAutoOverride: number | null = null;

  // Decorative scene elements.
  private static TIMER_SEGMENTS = 96;
  private static readonly PROJECTOR_RING_BOB_SPEED = 1.08;
  private static readonly PROJECTOR_RING_BOB_SPEED_STEP = 0.13;
  private static readonly PROJECTOR_RING_BOB_PHASE_STEP = 0.82;
  private projectorRings: THREE.Line[] = [];
  private projectorRingMaterial?: THREE.LineBasicMaterial;
  private projectorRingGeom?: THREE.BufferGeometry;

  // Field debug visualization (toggled with the dev overlay). A 3D grid of
  // line segments sampling the active attractor's flow, transformed by the
  // same rotation the compute shader uses so what we see matches what
  // particles feel.
  private fieldDebugGrid = 7;
  private fieldDebugLines?: THREE.LineSegments;
  private fieldDebugGeom?: THREE.BufferGeometry;
  private fieldDebugMaterial?: THREE.LineBasicMaterial;
  private fieldDebugPositions?: Float32Array;
  private fieldDebugColors?: Float32Array;
  private fieldDebugVisible = false;
  private fieldDebugScratchSample = new THREE.Vector3();
  private fieldDebugScratchFlow = new THREE.Vector3();
  private attractorDebugMessage?: HTMLDivElement;

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

    this.allocateBuffers();
    this.allocateSpawnQueue();
    this.buildComputePipelines();
    this.buildRenderMesh();
    this.buildProjectorRings();
    this.buildFieldDebugLines();
    this.applyAttractorPreset(this.currentAttractor);
    this.buildAttractorDebugMessage(paneDock);
    this.centerUniform.value.copy(this.center);
    this.particleSizeUniform.value = this.params.particleSize;
    this.particleOpacityUniform.value = this.params.particleOpacity;
    this.applyParticleLifetime();
    this.opacityFadeStartUniform.value = this.params.opacityFadeStart;
    this.fieldFalloffStartUniform.value = this.params.fieldFalloffStart;
    this.fieldFalloffEndUniform.value = this.params.fieldFalloffEnd;
    this.finalFieldEffectUniform.value = this.params.finalFieldEffect;
    this.fieldStrengthUniform.value = this.params.fieldStrength;
    this.applyFieldVolumeParams();
    this.fieldRotationRate = this.params.fieldRotationRate;
    this.rippleSpeedUniform.value = this.params.rippleSpeed;
    this.rippleWidthUniform.value = this.params.rippleWidth;
    this.rippleAmpUniform.value = this.params.rippleAmplitude;
    this.rippleLifetimeUniform.value = this.params.rippleLifetime;

    this.registered = registerTweaks(paneDock, 'energySculptorThomasFlowV1', SCULPTOR_DEFS, {
      title: 'Energy Sculptor',
      params: this.params,
      onChange: {
        timerRingColor: v => this.projectorRingMaterial?.color.set(v),
        timerRingRadius: () => this.layoutProjectorRings(),
        projectorRingCount: () => this.rebuildProjectorRings(),
        projectorRingSpacing: () => this.layoutProjectorRings(),
        projectorRingScale: () => this.layoutProjectorRings(),
        projectorBaseY: () => this.layoutProjectorRings(),
        particleSize: v => { this.particleSizeUniform.value = v; },
        particleOpacity: v => { this.particleOpacityUniform.value = v; },
        particleLifetime: v => { this.applyParticleLifetime(v); },
        opacityFadeStart: v => { this.opacityFadeStartUniform.value = v; },
        blendingMode: v => {
          this.material.blending = BLENDING_LOOKUP[v as BlendingMode];
          this.material.needsUpdate = true;
        },
        fieldFalloffStart: v => { this.fieldFalloffStartUniform.value = v; },
        fieldFalloffEnd: v => { this.fieldFalloffEndUniform.value = v; },
        finalFieldEffect: v => { this.finalFieldEffectUniform.value = v; },
        fieldStrength: v => { this.fieldStrengthUniform.value = v; },
        fieldVolumeScale: () => this.applyFieldVolumeParams(),
        fieldSphereRadius: () => this.applyFieldVolumeParams(),
        fieldSphereCenterY: () => this.applyFieldVolumeParams(),
        fieldRotationRate: v => { this.fieldRotationRate = v; },
        fieldDebugDensity: v => {
          const next = Math.max(2, Math.round(v));
          if (next === this.fieldDebugGrid) return;
          this.fieldDebugGrid = next;
          this.rebuildFieldDebugLines();
        },
        rippleSpeed: v => { this.rippleSpeedUniform.value = v; },
        rippleWidth: v => { this.rippleWidthUniform.value = v; },
        rippleAmplitude: v => { this.rippleAmpUniform.value = v; },
        rippleLifetime: v => { this.rippleLifetimeUniform.value = v; },
        attractorOverride: v => { this.setAttractorOverride(v as AttractorMode); },
        attractorHoldSeconds: v => { this.applyAttractorHoldSeconds(v); },
        attractorTransitionSeconds: v => { this.applyAttractorTransitionSeconds(v); },
      },
    });
    this.syncAttractorCycleIndex();
    this.updateAttractorDebugMessage();
  }

  // ---------------------------------------------------------------------- emit

  emit(req: EmitRequest): void {
    this.pendingEmits.push(req);
  }

  setArchetype(id: ArchetypeId): void {
    if (this.currentArchetype === id) return;
    this.currentArchetype = id;
    if (this.attractorOverride !== 'auto') {
      this.updateAttractorDebugMessage();
      return;
    }
    const next = ARCHETYPE_TO_ATTRACTOR[id];
    const activeTarget = this.crossfadeRemaining > 0 ? this.transitionTarget : this.currentAttractor;
    if (next !== activeTarget) {
      this.beginAttractorCrossfade(next);
    }
    this.updateAttractorDebugMessage();
  }

  // Select cycle, archetype auto, or a manually pinned attractor.
  // Called from the tweakpane dropdown's onChange.
  private setAttractorOverride(override: AttractorMode): void {
    this.attractorOverride = override;
    if (override === 'cycle') {
      const cycleKind = this.crossfadeRemaining > 0 ? this.transitionTarget : this.currentAttractor;
      this.syncAttractorCycleIndex(cycleKind);
      this.attractorCycleElapsed = 0;
      this.attractorCyclePhase = this.crossfadeRemaining > 0 ? 'transition' : 'hold';
      this.updateAttractorDebugMessage();
      return;
    }
    this.attractorCycleElapsed = 0;
    this.attractorCyclePhase = 'hold';
    const target: AttractorKind = override === 'auto'
      ? ARCHETYPE_TO_ATTRACTOR[this.currentArchetype]
      : override;
    const activeTarget = this.crossfadeRemaining > 0 ? this.transitionTarget : this.currentAttractor;
    if (target !== activeTarget) {
      this.beginAttractorCrossfade(target);
    }
    this.updateAttractorDebugMessage();
  }

  fireSynchrony(): void {
    this.synchronyBoost = 1;
  }

  // Bass beat from the backing track — restarts the outward ripple shell at
  // the field center. Intensity scales the impulse for that single shell.
  triggerRipple(intensity = 1): void {
    if (!this.params.rippleEnabled) return;
    const sens = Math.max(0.05, this.params.rippleSensitivity);
    this.rippleAgeUniform.value = 0;
    this.rippleIntensityUniform.value = clamp01(intensity * sens);
  }

  getSynchronyBoost(): number {
    return this.synchronyBoost;
  }

  // Approximate live-particle count for the DevOverlay readout. Drops batches
  // whose lifetime has elapsed and caps the total at the GPU pool size, since
  // the spawn ring buffer overwrites older live particles when it wraps.
  getAliveParticleCount(): number {
    const now = this.elapsed;
    let writeIdx = 0;
    let total = 0;
    for (let i = 0; i < this.aliveBatches.length; i += 1) {
      const batch = this.aliveBatches[i];
      if (now - batch.spawnedAt >= batch.lifeMax) continue;
      this.aliveBatches[writeIdx] = batch;
      writeIdx += 1;
      total += batch.count;
    }
    this.aliveBatches.length = writeIdx;
    return Math.min(total, this.count);
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
    this.ageDtUniform.value = dt;
    this.elapsed += delta;

    // Synchrony only drives the decorative ring. Particle motion is governed
    // by the field plus the lifetime-based settling controls.
    this.synchronyBoost = Math.max(0, this.synchronyBoost * Math.exp(-delta * 4.5));
    this.tickVolumeAuto(delta);
    this.tickRipple(delta);
    this.updateProjectorRing();
    this.tickSampleRotation();
    this.tickAttractorCrossfade(delta);
    this.tickAttractorCycle(delta);
    this.updateAttractorDebugMessage();
    this.tickFieldDebug();

    // Drain CPU emit queue into the spawn uniformArrays.
    this.fillSpawnQueue();

    // Dispatch compute passes. Emit first so freshly-spawned particles get
    // integrated this frame too — visually they'd otherwise pop in stationary.
    if (this.spawnsThisFrame > 0) {
      this.renderer.compute(this.emitCompute);
    }
    if (this.activeSlotCountCpu > 0) this.dispatchIntegrateCompute();
  }

  // Used after a hidden-tab pause: expire particle lifetimes without applying
  // a huge physics step that would fling the sculpture when rendering resumes.
  advanceLifecycle(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    if (this.activeSlotCountCpu <= 0) return;
    const previousDt = this.dtUniform.value;
    const previousAgeDt = this.ageDtUniform.value;
    this.dtUniform.value = 0;
    this.ageDtUniform.value = seconds;
    this.dispatchIntegrateCompute();
    this.dtUniform.value = previousDt;
    this.ageDtUniform.value = previousAgeDt;
  }

  private dispatchIntegrateCompute(): void {
    const compute = this.crossfadeRemaining > 0
      ? this.integrateCrossfadeCompute
      : this.integrateComputeByAttractor[this.currentAttractor];
    this.renderer.compute(compute);
  }

  dispose(): void {
    this.registered?.dispose();
    this.attractorDebugMessage?.remove();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
    for (const ring of this.projectorRings) ring.removeFromParent();
    this.projectorRings.length = 0;
    this.projectorRingGeom?.dispose();
    this.projectorRingMaterial?.dispose();
    this.fieldDebugLines?.removeFromParent();
    this.fieldDebugGeom?.dispose();
    this.fieldDebugMaterial?.dispose();
  }

  // ----------------------------------------------------------------- internals

  private buildAttractorDebugMessage(paneDock?: HTMLElement): void {
    if (!paneDock) return;
    const message = document.createElement('div');
    message.className = 'attractor-debug-message';
    message.setAttribute('aria-live', 'polite');
    const summary = paneDock.querySelector('.tweak-pane-dock-summary');
    const anchor = summary?.nextSibling ?? null;
    paneDock.insertBefore(message, anchor);
    this.attractorDebugMessage = message;
    this.updateAttractorDebugMessage();
  }

  private syncAttractorCycleIndex(kind: AttractorKind = this.currentAttractor): void {
    const idx = ATTRACTOR_SEQUENCE.indexOf(kind);
    this.attractorCycleIndex = idx >= 0 ? idx : 0;
  }

  private nextCycleTarget(): AttractorKind {
    return ATTRACTOR_SEQUENCE[(this.attractorCycleIndex + 1) % ATTRACTOR_SEQUENCE.length];
  }

  private tickAttractorCycle(delta: number): void {
    if (this.attractorOverride !== 'cycle') return;

    if (this.attractorCyclePhase === 'transition') {
      if (this.crossfadeRemaining <= 0) {
        this.attractorCyclePhase = 'hold';
        this.attractorCycleElapsed = 0;
        this.syncAttractorCycleIndex();
      }
      return;
    }

    const cycleDelta = Math.min(delta, EnergySculptor.MAX_ATTRACTOR_CYCLE_TICK);
    this.attractorCycleElapsed += cycleDelta;
    if (this.attractorCycleElapsed < this.attractorHoldSeconds()) return;

    this.attractorCyclePhase = 'transition';
    this.attractorCycleElapsed = 0;
    this.beginAttractorCrossfade(this.nextCycleTarget(), this.attractorTransitionSeconds());
  }

  private updateAttractorDebugMessage(): void {
    const message = this.attractorDebugMessage;
    if (!message) return;

    const lines = [this.getAttractorDebugLine(), ...this.getVolumeCycleDebugLines()];
    this.setAttractorDebugText(lines.join('\n'));
  }

  private getVolumeCycleDebugLines(): string[] {
    if (!this.params.volumeAutoEnabled) {
      const manual = this.params.fieldVolumeScale.toFixed(2);
      return [`Volume cycle: off (manual ${manual})`];
    }
    const cycle = Math.max(0.5, this.params.volumeAutoCycleS);
    const steps = Math.max(2, Math.round(this.params.volumeAutoSteps));
    const stepDur = cycle / steps;
    const idx = Math.min(steps - 1, Math.floor((this.volumeAutoElapsed / cycle) * steps));
    const half = Math.floor(steps / 2);
    const min = Math.min(this.params.volumeAutoMin, this.params.volumeAutoMax);
    const max = Math.max(this.params.volumeAutoMin, this.params.volumeAutoMax);
    const inc = (max - min) / Math.max(1, half);
    const valueAt = (i: number) => {
      const wrapped = ((i % steps) + steps) % steps;
      return wrapped <= half ? min + wrapped * inc : max - (wrapped - half) * inc;
    };
    const current = this.volumeAutoOverride ?? valueAt(idx);
    const next = valueAt(idx + 1);
    const stepEnd = (idx + 1) * stepDur;
    const remaining = Math.max(0, stepEnd - this.volumeAutoElapsed);
    return [
      `Volume cycle: ${current.toFixed(2)} (step ${idx + 1}/${steps}), next ${next.toFixed(2)} in ${this.formatSeconds(remaining)}`,
      `range ${min.toFixed(2)}-${max.toFixed(2)}, +${inc.toFixed(2)}/step over ${this.formatSeconds(cycle)} cycle`,
    ];
  }

  private getAttractorDebugLine(): string {
    if (this.crossfadeRemaining > 0) {
      const t = 1 - this.crossfadeRemaining / Math.max(this.crossfadeDuration, 0.001);
      const progress = Math.round(Math.max(0, Math.min(1, t)) * 100);
      const prefix = this.attractorOverride === 'cycle' ? 'Attractor cycle' : 'Attractor field';
      const remaining = this.formatSeconds(this.crossfadeRemaining);
      return `${prefix}: ${ATTRACTOR_LABELS[this.currentAttractor]} -> ${ATTRACTOR_LABELS[this.transitionTarget]} (${progress}%, ${remaining} left)`;
    }

    if (this.attractorOverride === 'cycle') {
      const remaining = Math.max(0, this.attractorHoldSeconds() - this.attractorCycleElapsed);
      return `Attractor cycle: ${ATTRACTOR_LABELS[this.currentAttractor]} holding; next ${ATTRACTOR_LABELS[this.nextCycleTarget()]} in ${this.formatSeconds(remaining)}`;
    }

    if (this.attractorOverride === 'auto') {
      return `Attractor auto: ${ATTRACTOR_LABELS[this.currentAttractor]} from instruments`;
    }

    return `Attractor pinned: ${ATTRACTOR_LABELS[this.currentAttractor]}`;
  }

  private formatSeconds(value: number): string {
    return `${value.toFixed(value >= 10 ? 0 : 1)}s`;
  }

  private attractorHoldSeconds(): number {
    return clampRange(this.params.attractorHoldSeconds, 1, 120, DEFAULT_ATTRACTOR_HOLD_SECONDS);
  }

  private attractorTransitionSeconds(): number {
    return clampRange(this.params.attractorTransitionSeconds, 0.1, 30, DEFAULT_ATTRACTOR_TRANSITION_SECONDS);
  }

  private applyAttractorHoldSeconds(value: number): void {
    this.params.attractorHoldSeconds = clampRange(value, 1, 120, DEFAULT_ATTRACTOR_HOLD_SECONDS);
  }

  private applyAttractorTransitionSeconds(value: number): void {
    const next = clampRange(value, 0.1, 30, DEFAULT_ATTRACTOR_TRANSITION_SECONDS);
    this.params.attractorTransitionSeconds = next;

    if (
      this.attractorOverride !== 'cycle'
      || this.attractorCyclePhase !== 'transition'
      || this.crossfadeRemaining <= 0
    ) {
      return;
    }

    const progress = 1 - this.crossfadeRemaining / Math.max(this.crossfadeDuration, 0.001);
    this.crossfadeDuration = next;
    this.crossfadeRemaining = Math.max(0, next * (1 - clamp01(progress)));
  }

  private setAttractorDebugText(text: string): void {
    if (!this.attractorDebugMessage || this.attractorDebugMessage.textContent === text) return;
    this.attractorDebugMessage.textContent = text;
  }

  private allocateBuffers(): void {
    // All particles start zeroed. colorLife.w=0 means dead, so the freshly
    // allocated pool draws nothing.
    this.positionAgeBuffer = instancedArray(this.count, 'vec4');
    this.velocityBuffer = instancedArray(this.count, 'vec3');
    this.colorLifeBuffer = instancedArray(this.count, 'vec4');
  }

  private allocateSpawnQueue(): void {
    this.spawnPosArray = [];
    this.spawnVelArray = [];
    this.spawnColorArray = [];
    this.spawnMetaArray = [];
    for (let i = 0; i < SPAWN_QUEUE_CAPACITY; i += 1) {
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
    const positionAge = this.positionAgeBuffer;
    const velocities = this.velocityBuffer;
    const colorLife = this.colorLifeBuffer;
    const spawnQueueCapacity = SPAWN_QUEUE_CAPACITY;

    // Emit pass: write at the cursor-derived slot unconditionally. Pool size is
    // the only cap — when the ring wraps, the oldest particle is overwritten.
    // Stream rate and lifetime are tuned via tweakpane to find the sweet spot.
    const emitFn = Fn(() => {
      const i = instanceIndex;
      const spawnCountU = this.spawnCountUniform.toUint();
      const spawnCursorU = this.spawnCursorUniform.toUint();
      If(i.greaterThanEqual(spawnCountU), () => {
        Return();
      });
      const spawnPos = this.spawnPosUniform.element(i);
      const spawnVel = this.spawnVelUniform.element(i);
      const spawnColor = this.spawnColorUniform.element(i);
      const spawnMeta = this.spawnMetaUniform.element(i);
      const slot = spawnCursorU.add(i).mod(uint(this.count));
      positionAge.element(slot).assign(vec4(spawnPos.x, spawnPos.y, spawnPos.z, 0));
      velocities.element(slot).assign(spawnVel);
      colorLife.element(slot).assign(vec4(spawnColor.x, spawnColor.y, spawnColor.z, spawnMeta.x));
    });
    this.emitCompute = emitFn().compute(spawnQueueCapacity);

    const sampleFlowByKind = (kind: AttractorKind, samplePos: any) => {
      switch (kind) {
        case 'thomas':
          return thomasFlow(samplePos, this.thomasA);
        case 'lorenz':
          return lorenzFlow(samplePos, this.lorenzSigma, this.lorenzRho, this.lorenzBeta);
        case 'aizawa':
          return aizawaFlow(
            samplePos,
            this.aizawaA,
            this.aizawaB,
            this.aizawaC,
            this.aizawaD,
            this.aizawaE,
            this.aizawaF,
          );
        case 'halvorsen':
          return halvorsenFlow(samplePos, this.halvorsenA);
        case 'rossler':
          return rosslerFlow(samplePos, this.rosslerA, this.rosslerB, this.rosslerC);
        case 'dadras':
          return dadrasFlow(samplePos, this.dadrasP, this.dadrasO, this.dadrasR, this.dadrasC, this.dadrasE);
      }
    };

    // Helper: branch over the attractor index uniform and assign the matching
    // flow vector. Only used by the crossfade kernel; normal playback uses
    // per-attractor kernels so settled high-count frames avoid this branch set.
    const sampleSelectedFlow = (sel: any, samplePos: any) => {
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

    const makeIntegrateCompute = (sampleFlow: (samplePos: any) => any): THREE.ComputeNode => {
      // Integrate pass: per-particle attractor flow + life update.
      const integrateFn = Fn(() => {
        const i = instanceIndex;
        const activeSlotsU = this.activeSlotCountUniform.toUint();
        If(i.greaterThanEqual(activeSlotsU), () => {
          Return();
        });

        const pAge = positionAge.element(i).toVar();
        const lifeMax = colorLife.element(i).w;
        // Skip dead particles. Lifetime is the authoritative alive flag; render
        // alpha is visual-only so fade behavior cannot shorten the configured
        // particle lifetime or make faded particles reusable early.
        If(lifeMax.lessThanEqual(0).or(pAge.w.greaterThanEqual(lifeMax)), () => {
          Return();
        });

        const pos = pAge.xyz.toVar();
        const vel = velocities.element(i).toVar();
        const newAge = pAge.w.add(this.ageDtUniform);

        // Age fraction (0 born -> 1 dead). Compute this before sampling the
        // attractor so low-affinity settled particles can take the cheap path.
        const lifeT = pAge.w.div(lifeMax.max(0.0001)).clamp(0, 1);
        const falloffStart = this.fieldFalloffStartUniform.clamp(0, 1);
        const falloffFinalAt = this.fieldFalloffEndUniform.clamp(0, 1).max(falloffStart);
        const falloffRaw = lifeT.sub(falloffStart).div(falloffFinalAt.sub(falloffStart).max(0.0001)).clamp(0, 1);
        const falloffT = falloffRaw.mul(falloffRaw).mul(float(3).sub(falloffRaw.mul(2)));
        const fieldEffect = mix(float(1), this.finalFieldEffectUniform, falloffT).clamp(0, 1);

        // Bass ripple: a thin outward-traveling gaussian shell from the field
        // center. Independent of fieldEffect so even fully-settled particles
        // get a small kick as the wavefront passes through, then drag pulls
        // them back to rest while higher-affinity particles re-engage the field.
        const rOffset = pos.sub(this.rippleCenterUniform);
        const rDist = rOffset.length();
        const rRadius = this.rippleAgeUniform.mul(this.rippleSpeedUniform);
        const rShellT = rDist.sub(rRadius).div(this.rippleWidthUniform.max(0.001));
        const rDecay = float(0).sub(rShellT.mul(rShellT)).exp();
        const rLifeFade = float(1).sub(this.rippleAgeUniform.div(this.rippleLifetimeUniform.max(0.001))).clamp(0, 1);
        const rOutDir = rOffset.div(rDist.max(0.0001));
        const rImpulse = rOutDir
          .mul(this.rippleAmpUniform)
          .mul(this.rippleIntensityUniform)
          .mul(rDecay)
          .mul(rLifeFade)
          .mul(this.dtUniform);

        // Once affinity is low, stop paying for attractor sampling and boundary
        // work. The particle simply coasts while drag bleeds out remaining
        // velocity, preserving the settled sculpture at much lower ALU cost.
        If(fieldEffect.lessThanEqual(0.2), () => {
          const settleDrag = this.dtUniform
            .mul(4.0)
            .mul(float(1).sub(fieldEffect))
            .clamp(0, 1);
          const settledVel = mix(vel, vec3(0), settleDrag).add(rImpulse);
          const settledPos = pos.add(settledVel.mul(this.dtUniform));
          positionAge.element(i).assign(vec4(settledPos.x, settledPos.y, settledPos.z, newAge));
          velocities.element(i).assign(settledVel);
          Return();
        });

        // Sample the attractor in a slowly-rotating frame: unrotate the position
        // (R^-1 * p), evaluate the flow there, then rotate the flow back into
        // particle space (R * f). The orbits stay structurally intact but tumble
        // through world space, giving a "moving through a meta-realm" feel.
        const fieldCenterWorld = vec3(0, this.fieldSphereCenterYUniform, 0);
        const samplePos = this.sampleRotInvUniform.mul(
          pos.sub(fieldCenterWorld).div(this.worldScaleUniform.max(0.001)),
        );
        const sampledFlow = sampleFlow(samplePos);
        const rawFlow = this.sampleRotUniform.mul(sampledFlow) as any;
        const flowLen = rawFlow.length();
        const flow = rawFlow.div(flowLen.max(0.0001)).mul(flowLen.clamp(0, 3.25));

        // The field is the only sculpting force. Treat it as a velocity field
        // with light inertia instead of a raw acceleration so Thomas particles
        // trace the attractor lobes rather than ballistically filling the bounds.
        // Affinity controls both field speed and coupling. Scaling only the
        // desired velocity still allowed low-affinity particles to re-follow a
        // transitioning field with full responsiveness.
        const desiredVel = flow
          .mul(this.flowSpeedUniform)
          .mul(this.worldScaleUniform)
          .mul(this.fieldStrengthUniform)
          .mul(fieldEffect);
        const fieldFollow = this.dtUniform.mul(6.5).mul(fieldEffect).clamp(0, 1);
        const newVel = mix(vel, desiredVel, fieldFollow).toVar();
        const settleDrag = this.dtUniform
          .mul(4.0)
          .mul(float(1).sub(fieldEffect))
          .clamp(0, 1);
        newVel.assign(mix(newVel, vec3(0), settleDrag));
        newVel.assign(newVel.add(rImpulse));

        const containedPos = pos.add(newVel.mul(this.dtUniform)).toVar();
        const sphereCenter = vec3(0, this.fieldSphereCenterYUniform, 0);
        const fromSphereCenter = containedPos.sub(sphereCenter);
        const sphereDist = fromSphereCenter.length();
        const sphereRadius = this.fieldSphereRadiusUniform.max(0.01);
        const sphereNormal = fromSphereCenter.div(sphereDist.max(0.0001));
        const radialSpeed = newVel.dot(sphereNormal);
        const softRadius = sphereRadius.mul(1.02);
        const outsideT = sphereDist.sub(softRadius).div(sphereRadius.mul(0.22).max(0.001)).clamp(0, 1);

        // The sphere is a guardrail, not the sculpture. Outside the radius we
        // softly remove outward radial velocity and add a small inward drift;
        // only well beyond the guardrail do we clamp as an escape hatch.
        If(outsideT.greaterThan(0), () => {
          const outwardSpeed = radialSpeed.max(0);
          const inwardSpeed = outsideT.mul(0.38).mul(fieldEffect);
          newVel.assign(newVel.sub(sphereNormal.mul(outwardSpeed.mul(outsideT))).sub(sphereNormal.mul(inwardSpeed)));
          containedPos.assign(pos.add(newVel.mul(this.dtUniform)));
        });
        const hardFromSphereCenter = containedPos.sub(sphereCenter);
        const hardDist = hardFromSphereCenter.length();
        const hardRadius = sphereRadius.mul(1.18);
        const hardNormal = hardFromSphereCenter.div(hardDist.max(0.0001));
        If(hardDist.greaterThan(hardRadius), () => {
          const hardOutwardSpeed = newVel.dot(hardNormal).max(0);
          containedPos.assign(sphereCenter.add(hardNormal.mul(hardRadius)));
          newVel.assign(newVel.sub(hardNormal.mul(hardOutwardSpeed)));
        });

        positionAge.element(i).assign(vec4(containedPos.x, containedPos.y, containedPos.z, newAge));
        velocities.element(i).assign(newVel);
      });
      return integrateFn().compute(this.count);
    };

    this.integrateComputeByAttractor = {
      thomas: makeIntegrateCompute((samplePos: any) => sampleFlowByKind('thomas', samplePos)),
      lorenz: makeIntegrateCompute((samplePos: any) => sampleFlowByKind('lorenz', samplePos)),
      aizawa: makeIntegrateCompute((samplePos: any) => sampleFlowByKind('aizawa', samplePos)),
      halvorsen: makeIntegrateCompute((samplePos: any) => sampleFlowByKind('halvorsen', samplePos)),
      rossler: makeIntegrateCompute((samplePos: any) => sampleFlowByKind('rossler', samplePos)),
      dadras: makeIntegrateCompute((samplePos: any) => sampleFlowByKind('dadras', samplePos)),
    };
    this.integrateCrossfadeCompute = makeIntegrateCompute((samplePos: any) => {
      const flowA = sampleSelectedFlow(this.attractorSelectUniform, samplePos);
      const flowB = sampleSelectedFlow(this.attractorTargetUniform, samplePos);
      return mix(flowA, flowB, this.crossfadeWeightUniform);
    });
  }

  private buildRenderMesh(): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      blending: BLENDING_LOOKUP[this.params.blendingMode as BlendingMode],
      depthWrite: false,
    });

    // Position: particles are stored as world-relative offsets from center.
    const positionAge = this.positionAgeBuffer.toAttribute();
    material.positionNode = positionAge.xyz.add(this.centerUniform);

    const age = positionAge.w;
    const colorLife = this.colorLifeBuffer.toAttribute();
    const lifeMax = colorLife.w;
    const lifeT = age.div(lifeMax.max(0.0001)).clamp(0, 1);
    const fadeStart = this.opacityFadeStartUniform.clamp(0, 1);
    const born = age.div(0.04).clamp(0, 1);
    const fadeOut = float(1).sub(lifeT).div(float(1).sub(fadeStart).max(0.0001)).clamp(0, 1);
    const alpha = born.mul(fadeOut);

    // Sprite size stays stable across lifetime; fade-out is opacity-only.
    const sizeBase = this.particleSizeUniform;
    material.scaleNode = vec2(sizeBase, sizeBase);

    // Color alpha is derived here from age/lifeMax, so field affinity cannot
    // affect opacity or death time.
    const baseColor = colorLife.xyz;
    const r = uv().sub(0.5).length();
    const disc = smoothstep(0.5, 0.42, r);
    const lit = baseColor.mul(0.72).mul(alpha);
    material.colorNode = lit;
    material.opacityNode = alpha.mul(this.particleOpacityUniform).mul(disc);

    this.material = material;
    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 32;
    this.scene.add(this.mesh);
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
      blending: THREE.NormalBlending,
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
    this.positionProjectorRings(0);
  }

  private positionProjectorRings(time: number): void {
    const baseRadius = this.params.timerRingRadius;
    const spacing = this.params.projectorRingSpacing;
    const radiusScale = this.params.projectorRingScale;
    const baseY = this.center.y + this.params.projectorBaseY;
    const bobAmplitude = Math.min(0.006, Math.max(0.0015, spacing * 0.22));
    for (let i = 0; i < this.projectorRings.length; i += 1) {
      const ring = this.projectorRings[i];
      const r = baseRadius * Math.pow(radiusScale, i);
      const bobSpeed = EnergySculptor.PROJECTOR_RING_BOB_SPEED + i * EnergySculptor.PROJECTOR_RING_BOB_SPEED_STEP;
      const bobPhase = i * EnergySculptor.PROJECTOR_RING_BOB_PHASE_STEP;
      const bob = Math.sin(time * bobSpeed + bobPhase) * bobAmplitude;
      ring.scale.set(r, 1, r);
      ring.position.set(this.center.x, baseY + i * spacing + bob, this.center.z);
    }
  }

  private updateProjectorRing(): void {
    if (!this.projectorRingMaterial) return;
    this.projectorRingMaterial.opacity = 0.18;
    this.positionProjectorRings(this.elapsed);
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
    const N = this.fieldDebugGrid;
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
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    this.fieldDebugLines = new THREE.LineSegments(this.fieldDebugGeom, this.fieldDebugMaterial);
    this.fieldDebugLines.visible = this.fieldDebugVisible;
    this.fieldDebugLines.frustumCulled = false;
    this.fieldDebugLines.renderOrder = 31;
    this.scene.add(this.fieldDebugLines);
  }

  private rebuildFieldDebugLines(): void {
    this.fieldDebugLines?.removeFromParent();
    this.fieldDebugGeom?.dispose();
    this.fieldDebugMaterial?.dispose();
    this.fieldDebugLines = undefined;
    this.fieldDebugGeom = undefined;
    this.fieldDebugMaterial = undefined;
    this.fieldDebugPositions = undefined;
    this.fieldDebugColors = undefined;
    this.buildFieldDebugLines();
  }

  private tickFieldDebug(): void {
    if (!this.fieldDebugVisible) return;
    if (!this.fieldDebugLines || !this.fieldDebugGeom || !this.fieldDebugPositions) return;

    const N = this.fieldDebugGrid;
    const worldScale = this.worldScaleUniform.value;
    const invWorldScale = 1 / Math.max(worldScale, 0.001);
    const radius = this.fieldSphereRadiusUniform.value;
    const centerY = this.fieldSphereCenterYUniform.value;
    const step = (N > 1) ? (radius * 2) / (N - 1) : 0;
    const lineLenWorld = Math.max(0.02, step * 0.55);

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
      const xw = -radius + i * step;
      for (let j = 0; j < N; j += 1) {
        const ywLocal = -radius + j * step;
        const yw = centerY + ywLocal;
        for (let k = 0; k < N; k += 1) {
          const zw = -radius + k * step;
          if (xw * xw + ywLocal * ywLocal + zw * zw > radius * radius) {
            positions[idx + 0] = cx;
            positions[idx + 1] = cy + centerY;
            positions[idx + 2] = cz;
            positions[idx + 3] = cx;
            positions[idx + 4] = cy + centerY;
            positions[idx + 5] = cz;
            idx += 6;
            continue;
          }
          const x = xw * invWorldScale;
          const y = ywLocal * invWorldScale;
          const z = zw * invWorldScale;
          // Mirror compute: sample the flow at invRot * p, then rotate flow back.
          sample.set(x, y, z).applyMatrix3(invRot);
          this.evaluateFlow(sample, flow);
          flow.applyMatrix3(rot);
          // Normalize flow to a fixed visual length (with a small minimum so
          // near-zero-flow cells still show their orientation).
          const flowLen = flow.length();
          const visLen = (lineLenWorld * invWorldScale) / Math.max(flowLen, 0.0001);
          const exw = xw + flow.x * visLen * worldScale;
          const eyw = yw + flow.y * visLen * worldScale;
          const ezw = zw + flow.z * visLen * worldScale;
          // Attractor-space → world-space, anchored at the sculptor center.
          positions[idx + 0] = cx + xw;
          positions[idx + 1] = cy + yw;
          positions[idx + 2] = cz + zw;
          positions[idx + 3] = cx + exw;
          positions[idx + 4] = cy + eyw;
          positions[idx + 5] = cz + ezw;
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
    const dur = Math.max(this.crossfadeDuration, 0.001);
    const t = 1 - this.crossfadeRemaining / dur;
    const eased = t * t * (3 - 2 * t); // smoothstep
    this.crossfadeWeightUniform.value = eased;
    const from = this.fromPreset;
    const to = this.toPreset;
    this.worldScaleUniform.value = lerp(from.worldScale, to.worldScale, eased);
    this.flowSpeedUniform.value = lerp(from.dt, to.dt, eased);
    if (this.crossfadeRemaining === 0) {
      // Snap select to the new attractor and reset the weight so any future
      // crossfade starts from a clean lerp(flowA, flowB, 0) state.
      this.attractorSelectUniform.value = this.attractorTargetUniform.value;
      this.crossfadeWeightUniform.value = 0;
      this.fromPreset = this.toPreset;
      this.currentAttractor = this.transitionTarget;
      if (this.attractorOverride === 'cycle') this.syncAttractorCycleIndex();
    }
  }

  private applyFieldVolumeParams(): void {
    const baseScale = this.volumeAutoOverride ?? this.params.fieldVolumeScale;
    const scale = Math.max(0.01, baseScale);
    this.fieldSphereRadiusUniform.value = this.params.fieldSphereRadius * scale;
    this.fieldSphereCenterYUniform.value = this.params.fieldSphereCenterY;
  }

  // Stepped triangular wave on the field volume scale. Cycle = up-then-down
  // over `volumeAutoCycleS`; `volumeAutoSteps` is total positions visited per
  // cycle, so the time between jumps is cycleS/steps and the per-step delta
  // is (max-min)/(steps/2).
  private tickVolumeAuto(delta: number): void {
    if (!this.params.volumeAutoEnabled) {
      if (this.volumeAutoOverride !== null) {
        this.volumeAutoOverride = null;
        this.applyFieldVolumeParams();
      }
      this.volumeAutoElapsed = 0;
      return;
    }
    const cycle = Math.max(0.5, this.params.volumeAutoCycleS);
    const steps = Math.max(2, Math.round(this.params.volumeAutoSteps));
    this.volumeAutoElapsed = (this.volumeAutoElapsed + delta) % cycle;
    const idx = Math.min(steps - 1, Math.floor((this.volumeAutoElapsed / cycle) * steps));
    const half = Math.floor(steps / 2);
    const min = Math.min(this.params.volumeAutoMin, this.params.volumeAutoMax);
    const max = Math.max(this.params.volumeAutoMin, this.params.volumeAutoMax);
    const inc = (max - min) / Math.max(1, half);
    const value = idx <= half ? min + idx * inc : max - (idx - half) * inc;
    const next = Math.min(max, Math.max(min, value));
    if (next !== this.volumeAutoOverride) {
      this.volumeAutoOverride = next;
      this.applyFieldVolumeParams();
    }
  }

  private tickRipple(delta: number): void {
    // Center stays at the bounding-sphere center expressed in particle space
    // (positions are stored as world-relative offsets from this.center).
    this.rippleCenterUniform.value.set(0, this.fieldSphereCenterYUniform.value, 0);
    const lifetime = Math.max(0.05, this.params.rippleLifetime);
    const cap = lifetime + 0.5;
    if (this.rippleAgeUniform.value < cap) {
      this.rippleAgeUniform.value = Math.min(cap, this.rippleAgeUniform.value + delta);
    }
  }

  private applyParticleLifetime(value = this.params.particleLifetime): void {
    const lifetime = Math.max(MIN_PARTICLE_LIFETIME, value);
    this.params.particleLifetime = lifetime;
    this.lifeMaxUniform.value = lifetime;
  }

  private fillSpawnQueue(): void {
    let cursor = 0;
    const frameCap = SPAWN_QUEUE_CAPACITY;
    const lifeBase = Math.max(MIN_PARTICLE_LIFETIME, this.lifeMaxUniform.value);
    const sphereRadius = this.fieldSphereRadiusUniform.value;
    const sphereCenterY = this.fieldSphereCenterYUniform.value;
    const sphereCenterWorldY = this.center.y + sphereCenterY;

    for (let reqIndex = this.pendingEmits.length - 1; reqIndex >= 0; reqIndex -= 1) {
      const req = this.pendingEmits[reqIndex];
      if (cursor >= frameCap) break;
      const allowed = Math.min(req.count, frameCap - cursor);
      let dirX = this.center.x - req.origin.x;
      let dirY = sphereCenterWorldY - req.origin.y;
      let dirZ = this.center.z - req.origin.z;
      let dirLen = Math.hypot(dirX, dirY, dirZ);
      if (dirLen < 1e-4) {
        dirX = req.direction.x;
        dirY = req.direction.y;
        dirZ = req.direction.z;
        dirLen = Math.hypot(dirX, dirY, dirZ) || 1;
      }
      dirX /= dirLen;
      dirY /= dirLen;
      dirZ /= dirLen;
      // Narrow spawn radius: the burst leaves the instrument as a tight stream
      // matching the orb / starlace node it came from. Divergence is then
      // produced by uniformly-sampled per-particle targets across the bounding
      // sphere so trails fan out into the full volume before the field pulls
      // them into orbits.
      const launchRadius = req.kind === 'starlace' ? 0.035 : 0.045;
      const coneSpread = req.kind === 'starlace' ? 0.78 : 0.72;
      const targetBias = req.kind === 'starlace' ? 0.78 : 0.74;
      const speedScale = req.kind === 'starlace' ? 0.9 : 1.0;

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
        const theta = Math.random() * TAU;
        const disc = Math.sqrt(Math.random());
        const lateralA = Math.cos(theta) * disc;
        const lateralB = Math.sin(theta) * disc;
        const forwardJitter = (Math.random() - 0.5) * launchRadius * 0.28;
        const launchA = lateralA * launchRadius;
        const launchB = lateralB * launchRadius;
        const spawnX = req.origin.x + sideX * launchA + liftX * launchB + dirX * forwardJitter;
        const spawnY = req.origin.y + sideY * launchA + liftY * launchB + dirY * forwardJitter;
        const spawnZ = req.origin.z + sideZ * launchA + liftZ * launchB + dirZ * forwardJitter;
        this.spawnPosArray[slot].set(
          spawnX - this.center.x,
          spawnY - this.center.y,
          spawnZ - this.center.z,
        );

        // Each particle aims at a unique point sampled uniformly across the
        // active bounding sphere so the burst spreads out instead of bunching
        // toward a single attractor lobe. The flow field still pulls each
        // trajectory into orbit shape after the initial fan-out.
        const targetTheta = Math.random() * TAU;
        const targetCos = Math.random() * 2 - 1;
        const targetSin = Math.sqrt(Math.max(0, 1 - targetCos * targetCos));
        const targetRadius = sphereRadius * (0.35 + Math.random() * 0.6);
        const targetX = this.center.x + Math.cos(targetTheta) * targetSin * targetRadius;
        const targetY = sphereCenterWorldY + targetCos * targetRadius;
        const targetZ = this.center.z + Math.sin(targetTheta) * targetSin * targetRadius;
        let aimX = targetX - spawnX;
        let aimY = targetY - spawnY;
        let aimZ = targetZ - spawnZ;
        const aimLen = Math.hypot(aimX, aimY, aimZ) || 1;
        aimX /= aimLen;
        aimY /= aimLen;
        aimZ /= aimLen;
        let sprayX = dirX + sideX * lateralA * coneSpread + liftX * lateralB * coneSpread;
        let sprayY = dirY + sideY * lateralA * coneSpread + liftY * lateralB * coneSpread;
        let sprayZ = dirZ + sideZ * lateralA * coneSpread + liftZ * lateralB * coneSpread;
        const sprayLen = Math.hypot(sprayX, sprayY, sprayZ) || 1;
        sprayX /= sprayLen;
        sprayY /= sprayLen;
        sprayZ /= sprayLen;
        let launchX = aimX * targetBias + sprayX * (1 - targetBias);
        let launchY = aimY * targetBias + sprayY * (1 - targetBias);
        let launchZ = aimZ * targetBias + sprayZ * (1 - targetBias);
        const launchLen = Math.hypot(launchX, launchY, launchZ) || 1;
        launchX /= launchLen;
        launchY /= launchLen;
        launchZ /= launchLen;
        const seedSpeed = (0.7 + Math.random() * 0.45) * req.speed * speedScale;
        const lateralSpeed = seedSpeed * coneSpread * (0.18 + Math.random() * 0.32);
        const swirlSpeed = seedSpeed * coneSpread * (Math.random() - 0.5) * 0.18;
        this.spawnVelArray[slot].set(
          launchX * seedSpeed + sideX * lateralA * lateralSpeed + liftX * lateralB * lateralSpeed + sideX * swirlSpeed,
          launchY * seedSpeed + sideY * lateralA * lateralSpeed + liftY * lateralB * lateralSpeed + sideY * swirlSpeed,
          launchZ * seedSpeed + sideZ * lateralA * lateralSpeed + liftZ * lateralB * lateralSpeed + sideZ * swirlSpeed,
        );

        this.spawnColorArray[slot].set(req.color.r, req.color.g, req.color.b);

        // The lifetime slider is exact. Randomizing it made particles vanish
        // before the configured lifetime, which made the sculpture hard to tune.
        this.spawnMetaArray[slot].set(lifeBase, 0, 0);

        cursor += 1;
      }
    }
    this.pendingEmits.length = 0;
    this.spawnsThisFrame = cursor;
    this.spawnCountUniform.value = cursor;
    this.spawnCursorUniform.value = this.spawnCursorCpu;
    this.spawnCursorCpu = (this.spawnCursorCpu + cursor) % this.count;
    if (cursor > 0) {
      this.activeSlotCountCpu = Math.min(this.count, this.activeSlotCountCpu + cursor);
      this.activeSlotCountUniform.value = this.activeSlotCountCpu;
      this.mesh.count = this.activeSlotCountCpu;
      this.mesh.visible = true;
      this.aliveBatches.push({ spawnedAt: this.elapsed, count: cursor, lifeMax: lifeBase });
    }
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
    this.flowSpeedUniform.value = preset.dt;
    const idx = EnergySculptor.ATTRACTOR_INDEX[kind];
    this.attractorSelectUniform.value = idx;
    this.attractorTargetUniform.value = idx;
    this.crossfadeWeightUniform.value = 0;
    this.fromPreset = preset;
    this.toPreset = preset;
    this.currentAttractor = kind;
    this.transitionTarget = kind;
    this.crossfadeDuration = EnergySculptor.CROSSFADE_DURATION;
    this.crossfadeRemaining = 0;
  }

  private beginAttractorCrossfade(kind: AttractorKind, duration = this.attractorTransitionSeconds()): void {
    // Snapshot the currently-displayed preset (which may itself be mid-lerp)
    // so the next crossfade starts from where we visually are. The target's
    // index goes into attractorTargetUniform; the shader then evaluates both
    // flows and lerps as crossfadeWeightUniform climbs from 0 -> 1.
    const captured: AttractorPreset = {
      kind: this.currentAttractor,
      worldScale: this.worldScaleUniform.value,
      dt: this.flowSpeedUniform.value,
    };
    this.fromPreset = captured;
    this.toPreset = ATTRACTOR_PRESETS[kind];
    this.transitionTarget = kind;
    this.attractorSelectUniform.value = EnergySculptor.ATTRACTOR_INDEX[captured.kind];
    this.attractorTargetUniform.value = EnergySculptor.ATTRACTOR_INDEX[kind];
    this.crossfadeWeightUniform.value = 0;
    this.crossfadeDuration = Math.max(duration, 0.001);
    this.crossfadeRemaining = this.crossfadeDuration;
    this.updateAttractorDebugMessage();
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampRange(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
