import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
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

const ATTRACTOR_LABELS: Record<AttractorKind, string> = {
  thomas: 'Thomas',
  lorenz: 'Lorenz',
  aizawa: 'Aizawa',
  halvorsen: 'Halvorsen',
  rossler: 'Rossler',
  dadras: 'Dadras',
};

// The spawn queue is baked into TSL uniform arrays and the emit compute
// dispatch size, so changing the live stream cap rebuilds that small emit
// pipeline. The particle pool itself stays fixed.
const DEFAULT_MAX_SPAWNS_PER_FRAME = 256;
const MIN_CONFIGURABLE_SPAWNS_PER_FRAME = 16;
const MAX_CONFIGURABLE_SPAWNS_PER_FRAME = 2048;
const DEFAULT_ATTRACTOR_HOLD_SECONDS = 20;
const DEFAULT_ATTRACTOR_TRANSITION_SECONDS = 5;

export const SCULPTOR_DEFS = {
  particleCount:      { default: 24576, min: 4096, max: 65536, step: 256, label: 'particle pool', hidden: true },
  maxSpawnsPerFrame:  { default: DEFAULT_MAX_SPAWNS_PER_FRAME, min: MIN_CONFIGURABLE_SPAWNS_PER_FRAME, max: MAX_CONFIGURABLE_SPAWNS_PER_FRAME, step: 16, folder: 'Particles', label: 'stream cap / frame' },
  particleSize:       { default: 0.01, min: 0.001, max: 0.03, step: 0.001, folder: 'Particles', label: 'particle size' },
  particleOpacity:    { default: 0.85,  min: 0.1,   max: 1,    step: 0.01,  folder: 'Particles', label: 'particle opacity' },
  particleLifetime:   { default: 100,    min: 1,     max: 240,  step: 0.5,   folder: 'Particles', label: 'particle lifetime' },
  opacityFadeStart:   { default: 0.90,  min: 0,     max: 1,    step: 0.01,  folder: 'Particles', label: 'opacity fade starts at life' },

  fieldStrength:      { default: 0.8,   min: 0,     max: 2,    step: 0.05,  folder: 'Field Affinity', label: 'field strength' },
  fieldFalloffStart:  { default: 0.1,   min: 0,     max: 1,    step: 0.01,  folder: 'Field Affinity', label: 'decay starts at life' },
  fieldFalloffEnd:    { default: 0.7,   min: 0,     max: 1,    step: 0.01,  folder: 'Field Affinity', label: 'final reached at life' },
  finalFieldEffect:   { default: 0.1,   min: 0,     max: 1,    step: 0.01,  folder: 'Field Affinity', label: 'final affinity' },

  fieldVolumeScale:   { default: 0.55,  min: 0.25,  max: 2.5,  step: 0.01,  folder: 'Field Bounds', label: 'volume scale' },
  fieldSphereRadius:  { default: 1.0,   min: 0.2,   max: 2.2,  step: 0.01,  folder: 'Field Bounds', label: 'sphere radius' },
  fieldSphereCenterY: { default: 0.12,  min: -0.5,  max: 1.1,  step: 0.01,  folder: 'Field Bounds', label: 'center height' },

  fieldRotationRate:  { default: 0.3,   min: 0,     max: 10,   step: 0.05,  folder: 'Field Shape', label: 'rotation speed' },
  fieldDebugDensity:  { default: 16,    min: 3,     max: 20,   step: 1,     folder: 'Field Shape', label: 'debug density' },
  attractorOverride:  { type: 'select' as const, default: 'cycle' as const, options: ATTRACTOR_OPTIONS, folder: 'Field Shape', label: 'attractor' },
  attractorHoldSeconds:       { default: DEFAULT_ATTRACTOR_HOLD_SECONDS,       min: 1,   max: 120, step: 0.5, folder: 'Field Shape', label: 'cycle hold seconds' },
  attractorTransitionSeconds: { default: DEFAULT_ATTRACTOR_TRANSITION_SECONDS, min: 0.1, max: 30,  step: 0.1, folder: 'Field Shape', label: 'cycle transition seconds' },

  speedGlow:          { default: 0.7,   min: 0,     max: 2,    step: 0.01,  folder: 'Appearance', label: 'speed glow' },
  stretchScale:       { default: 0.06,  min: 0,     max: 0.4,  step: 0.005, folder: 'Appearance', label: 'accel stretch' },

  dissolveBurstSpeed:   { default: 4.2,   min: 0,    max: 16,   step: 0.1,   folder: 'Projector', label: 'dissolve burst' },
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
const THOMAS_SEED_A = 0.19;
const THOMAS_TARGET_COUNT = 4096;

const ARCHETYPE_TO_ATTRACTOR: Record<ArchetypeId, AttractorKind> = {
  drumDrum: 'lorenz',
  melodyMelody: 'thomas',
  drumMelody: 'aizawa',
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

  private count: number;
  private spawnQueueCapacity = DEFAULT_MAX_SPAWNS_PER_FRAME;
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
  private spawnsThisFrame = 0;

  // Integration uniforms.
  private dtUniform = uniform(1 / 60);
  private ageDtUniform = uniform(1 / 60);
  private flowSpeedUniform = uniform(1);
  private worldScaleUniform = uniform(0.014);
  private lifeMaxUniform = uniform(28);
  private opacityFadeStartUniform = uniform(0.90);
  private dissolveModeUniform = uniform(0);
  private dissolveBurstUniform = uniform(6);
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
  // fieldFalloffEnd and holds that affinity for the rest of its life. If
  // finalFieldEffect is exactly 0 and the falloff has completed, velocity is
  // zeroed so it freezes instead of drifting on residual velocity.
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
  private integrateCompute!: THREE.ComputeNode;

  // Frame state.
  private currentArchetype: ArchetypeId = 'drumMelody';
  private currentAttractor: AttractorKind = 'thomas';
  private transitionTarget: AttractorKind = 'thomas';
  private attractorCycleIndex = 0;
  private attractorCycleElapsed = 0;
  private attractorCyclePhase: 'hold' | 'transition' = 'hold';
  private roundProgress = 0;
  private dissolveMode = 0;
  private synchronyBoost = 0;
  private elapsed = 0;

  // Decorative scene elements.
  private static TIMER_SEGMENTS = 96;
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
  private thomasSeedTargets: THREE.Vector3[] = [];
  private thomasTargetScratch = new THREE.Vector3();
  private thomasTargetCursor = 0;
  private attractorDebugMessage?: HTMLDivElement;
  private affinityDebugParticleAge = 0;
  private affinityDebugParticleLifeMax = 0;

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
    this.spawnQueueCapacity = clampSpawnQueueCapacity(this.params.maxSpawnsPerFrame);

    this.allocateBuffers();
    this.allocateSpawnQueue();
    this.buildComputePipelines();
    this.buildRenderMesh();
    this.buildProjectorRings();
    this.buildFieldDebugLines();
    this.buildThomasSeedTargets();

    this.applyAttractorPreset(this.currentAttractor);
    this.buildAttractorDebugMessage(paneDock);
    this.centerUniform.value.copy(this.center);
    this.particleSizeUniform.value = this.params.particleSize;
    this.particleOpacityUniform.value = this.params.particleOpacity;
    this.applyParticleLifetime();
    this.opacityFadeStartUniform.value = this.params.opacityFadeStart;
    this.dissolveBurstUniform.value = this.params.dissolveBurstSpeed;
    this.speedGlowUniform.value = this.params.speedGlow;
    this.stretchScaleUniform.value = this.params.stretchScale;
    this.fieldFalloffStartUniform.value = this.params.fieldFalloffStart;
    this.fieldFalloffEndUniform.value = this.params.fieldFalloffEnd;
    this.finalFieldEffectUniform.value = this.params.finalFieldEffect;
    this.fieldStrengthUniform.value = this.params.fieldStrength;
    this.applyFieldVolumeParams();
    this.fieldRotationRate = this.params.fieldRotationRate;

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
        maxSpawnsPerFrame: v => { this.applyMaxSpawnsPerFrame(v); },
        speedGlow: v => { this.speedGlowUniform.value = v; },
        stretchScale: v => { this.stretchScaleUniform.value = v; },
        particleLifetime: v => { this.applyParticleLifetime(v); },
        opacityFadeStart: v => { this.opacityFadeStartUniform.value = v; },
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
        attractorOverride: v => { this.setAttractorOverride(v as AttractorMode); },
        attractorHoldSeconds: v => { this.applyAttractorHoldSeconds(v); },
        attractorTransitionSeconds: v => { this.applyAttractorTransitionSeconds(v); },
        dissolveBurstSpeed: v => { this.dissolveBurstUniform.value = v; },
      },
    });
    this.syncAttractorCycleIndex();
    this.updateAttractorDebugMessage();
  }

  // ---------------------------------------------------------------------- emit

  emit(req: EmitRequest): void {
    if (this.dissolveMode > 0) return;
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

  setRoundProgress(progress: number): void {
    this.roundProgress = Math.max(0, progress);
  }

  fireSynchrony(): void {
    this.synchronyBoost = 1;
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
    this.ageDtUniform.value = dt;
    this.elapsed += delta;

    // Synchrony only drives the decorative ring. Particle motion is governed
    // by the field plus the lifetime-based settling controls.
    this.synchronyBoost = Math.max(0, this.synchronyBoost * Math.exp(-delta * 4.5));
    this.updateProjectorRing();
    this.tickSampleRotation();
    this.tickAttractorCrossfade(delta);
    this.tickAttractorCycle(delta);
    this.tickAffinityDebugParticle(delta);
    this.updateAttractorDebugMessage();
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

  // Used after a hidden-tab pause: expire particle lifetimes without applying
  // a huge physics step that would fling the sculpture when rendering resumes.
  advanceLifecycle(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const previousDt = this.dtUniform.value;
    const previousAgeDt = this.ageDtUniform.value;
    this.dtUniform.value = 0;
    this.ageDtUniform.value = seconds;
    this.renderer.compute(this.integrateCompute);
    this.dtUniform.value = previousDt;
    this.ageDtUniform.value = previousAgeDt;
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

    const lines = [this.getAttractorDebugLine(), ...this.getAffinityDebugLines()];
    this.setAttractorDebugText(lines.join('\n'));
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

  private getAffinityDebugLines(): string[] {
    const hasParticle = this.affinityDebugParticleLifeMax > 0 && this.affinityDebugParticleAge < this.affinityDebugParticleLifeMax;
    const life = Math.max(
      MIN_PARTICLE_LIFETIME,
      hasParticle ? this.affinityDebugParticleLifeMax : this.lifeMaxUniform.value,
    );
    const age = hasParticle ? Math.min(this.affinityDebugParticleAge, life) : 0;
    const lifeT = life > 0 ? age / life : 0;
    const { start, finalAt } = this.affinityFalloffWindow();
    const startSec = start * life;
    const finalAtSec = finalAt * life;
    const finalAffinity = clamp01(this.finalFieldEffectUniform.value);
    const currentAffinity = this.affinityAtLifeT(lifeT);
    const journey = start === finalAt
      ? `${this.formatPercent(1)} until ${this.formatLifePoint(finalAtSec, finalAt)}, then ${this.formatPercent(finalAffinity)}`
      : `${this.formatPercent(1)} until ${this.formatLifePoint(startSec, start)}, decays to ${this.formatPercent(finalAffinity)} by ${this.formatLifePoint(finalAtSec, finalAt)}`;
    const finalBehavior = finalAffinity <= 0.0005
      ? `field motion stops after ${this.formatLifePoint(finalAtSec, finalAt)}`
      : `keeps ${this.formatPercent(finalAffinity)} field after ${this.formatLifePoint(finalAtSec, finalAt)}`;
    const particleLabel = hasParticle ? 'debug particle' : 'next particle';

    return [
      `Affinity: ${this.formatSeconds(life)} life, ${journey}; ${finalBehavior}`,
      `${particleLabel}: age ${this.formatSeconds(age)} (${this.formatPercent(lifeT)}), affinity ${this.formatPercent(currentAffinity)}`,
    ];
  }

  private tickAffinityDebugParticle(delta: number): void {
    if (this.affinityDebugParticleLifeMax <= 0) return;
    this.affinityDebugParticleAge = Math.min(
      this.affinityDebugParticleLifeMax,
      this.affinityDebugParticleAge + delta,
    );
  }

  private affinityFalloffWindow(): { start: number; finalAt: number } {
    const start = clamp01(this.fieldFalloffStartUniform.value);
    const finalAt = Math.max(start, clamp01(this.fieldFalloffEndUniform.value));
    return { start, finalAt };
  }

  private affinityAtLifeT(lifeT: number): number {
    const { start, finalAt } = this.affinityFalloffWindow();
    const span = Math.max(0.0001, finalAt - start);
    const raw = clamp01((clamp01(lifeT) - start) / span);
    const eased = raw * raw * (3 - 2 * raw);
    return clamp01(1 + (clamp01(this.finalFieldEffectUniform.value) - 1) * eased);
  }

  private formatSeconds(value: number): string {
    return `${value.toFixed(value >= 10 ? 0 : 1)}s`;
  }

  private formatLifePoint(seconds: number, normalized: number): string {
    return `${this.formatSeconds(seconds)} (${this.formatPercent(normalized)})`;
  }

  private formatPercent(value: number): string {
    return `${Math.round(clamp01(value) * 100)}%`;
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
    // All particles start zeroed → alphaLife=0, which the integrate pass
    // treats as dead, so the freshly-allocated pool draws nothing.
    this.positionsBuffer = instancedArray(this.count, 'vec3');
    this.velocitiesBuffer = instancedArray(this.count, 'vec3');
    this.colorsBuffer = instancedArray(this.count, 'vec3');
    this.metaBuffer = instancedArray(this.count, 'vec4');
  }

  private allocateSpawnQueue(): void {
    this.spawnPosArray = [];
    this.spawnVelArray = [];
    this.spawnColorArray = [];
    this.spawnMetaArray = [];
    for (let i = 0; i < this.spawnQueueCapacity; i += 1) {
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
    const spawnQueueCapacity = this.spawnQueueCapacity;
    const spawnSearchSteps = Math.ceil(this.count / spawnQueueCapacity);

    // Emit pass: only write into dead slots. Dropping overflow is preferable to
    // replacing live particles, because replacement bypasses lifetime fade-out
    // and reads as popping.
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
      const writeSpawn = (slot: any) => {
        positions.element(slot).assign(spawnPos);
        velocities.element(slot).assign(spawnVel);
        colors.element(slot).assign(spawnColor);
        // meta = (age=0, lifeMax, smoothedAccel=0, alphaLife=1)
        meta.element(slot).assign(vec4(0, spawnMeta.x, 0, 1));
      };
      Loop(spawnSearchSteps, ({ i: scan }) => {
        const slot = spawnCursorU
          .add(i)
          .add(scan.toUint().mul(uint(spawnQueueCapacity)))
          .mod(uint(this.count));
        const slotMeta = meta.element(slot);
        const isDead = slotMeta.y.lessThanEqual(0).or(slotMeta.x.greaterThanEqual(slotMeta.y));
        If(isDead, () => {
          writeSpawn(slot);
          Break();
        });
      });
    });
    this.emitCompute = emitFn().compute(spawnQueueCapacity);

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
      // Skip dead particles. Lifetime is the authoritative alive flag; render
      // alpha is visual-only so fade behavior cannot shorten the configured
      // particle lifetime or make faded particles reusable early.
      If(m.y.lessThanEqual(0).or(m.x.greaterThanEqual(m.y)), () => {
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
      const fieldCenterWorld = vec3(0, this.fieldSphereCenterYUniform, 0);
      const samplePos = this.sampleRotInvUniform.mul(
        pos.sub(fieldCenterWorld).div(this.worldScaleUniform.max(0.001)),
      );
      const flowA = sampleFlow(this.attractorSelectUniform, samplePos);
      const flowB = sampleFlow(this.attractorTargetUniform, samplePos);
      const sampledFlow = mix(flowA, flowB, this.crossfadeWeightUniform);
      const rawFlow = this.sampleRotUniform.mul(sampledFlow);
      const flowLen = rawFlow.length();
      const flow = rawFlow.div(flowLen.max(0.0001)).mul(flowLen.clamp(0, 3.25));

      // Age fraction (0 born -> 1 dead).
      const lifeT = m.x.div(m.y.max(0.0001)).clamp(0, 1);
      const fadeStart = this.opacityFadeStartUniform.clamp(0, 1);

      // Field affinity stays full until the configured normalized start, then
      // reaches the configured final affinity by the configured normalized end.
      const falloffStart = this.fieldFalloffStartUniform.clamp(0, 1);
      const falloffFinalAt = this.fieldFalloffEndUniform.clamp(0, 1).max(falloffStart);
      const falloffRaw = lifeT.sub(falloffStart).div(falloffFinalAt.sub(falloffStart).max(0.0001)).clamp(0, 1);
      const falloffT = falloffRaw.mul(falloffRaw).mul(float(3).sub(falloffRaw.mul(2)));
      const fieldEffect = mix(float(1), this.finalFieldEffectUniform, falloffT).clamp(0, 1);
      const freezeWhenSettled = this.finalFieldEffectUniform.lessThanEqual(0.0001).and(falloffT.greaterThanEqual(0.999));

      // The field is the only sculpting force. Treat it as a velocity field
      // with light inertia instead of a raw acceleration so Thomas particles
      // trace the attractor lobes rather than ballistically filling the bounds.
      // `fieldEffect` scales the target velocity itself, so an affinity of 0
      // settles motion to a full stop while 0.2 keeps exactly 20% field speed.
      const desiredVel = flow
        .mul(this.flowSpeedUniform)
        .mul(this.worldScaleUniform)
        .mul(this.fieldStrengthUniform)
        .mul(fieldEffect);
      const fieldFollow = this.dtUniform.mul(6.5).clamp(0, 1);
      const newVel = mix(vel, desiredVel, fieldFollow).toVar();

      // Dissolve burst: blow particles outward away from origin and shorten life.
      const dm = this.dissolveModeUniform;
      const outward = pos.normalize().mul(this.dissolveBurstUniform).mul(this.worldScaleUniform);
      newVel.assign(mix(newVel, outward, dm));

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
      const containActive = dm.lessThan(0.5);
      If(containActive.and(outsideT.greaterThan(0)), () => {
        const outwardSpeed = radialSpeed.max(0);
        const inwardSpeed = outsideT.mul(0.38);
        newVel.assign(newVel.sub(sphereNormal.mul(outwardSpeed.mul(outsideT))).sub(sphereNormal.mul(inwardSpeed)));
        containedPos.assign(pos.add(newVel.mul(this.dtUniform)));
      });
      const hardFromSphereCenter = containedPos.sub(sphereCenter);
      const hardDist = hardFromSphereCenter.length();
      const hardRadius = sphereRadius.mul(1.18);
      const hardNormal = hardFromSphereCenter.div(hardDist.max(0.0001));
      If(containActive.and(hardDist.greaterThan(hardRadius)), () => {
        const hardOutwardSpeed = newVel.dot(hardNormal).max(0);
        containedPos.assign(sphereCenter.add(hardNormal.mul(hardRadius)));
        newVel.assign(newVel.sub(hardNormal.mul(hardOutwardSpeed)));
      });

      // A final affinity of zero means "no field or guardrail influence" once
      // the settling window is complete. Apply the hard stop after containment
      // so the bounds guardrail cannot keep pulling settled particles inward.
      If(containActive.and(freezeWhenSettled), () => {
        containedPos.assign(pos);
        newVel.assign(vec3(0));
      });

      // Age + alpha.
      const ageStep = this.ageDtUniform.mul(float(1).add(dm.mul(2.0)));
      const newAge = m.x.add(ageStep);
      const lifeMax = m.y;
      const newLifeT = newAge.div(lifeMax.max(0.0001)).clamp(0, 1);
      // Short fade-in so emit-bursts read as emanating from the source node,
      // not blooming into existence already mid-flight. Fade-out is opacity-only
      // from the configured normalized lifetime point to death.
      const born = newAge.div(0.04).clamp(0, 1);
      const fadeOut = float(1).sub(newLifeT).div(float(1).sub(fadeStart).max(0.0001)).clamp(0, 1);
      const alphaLife = born.mul(fadeOut);

      // Signed acceleration along the path, low-passed across frames so the
      // visual stretch doesn't strobe on every integration tick.
      const newSpeed = newVel.length();
      const instantAccel = newSpeed.sub(oldSpeed).div(this.dtUniform.max(1e-4));
      const smoothedAccel = mix(instantAccel, m.z, 0.7);

      positions.element(i).assign(containedPos);
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

    // Position: particles are stored as world-relative offsets from center.
    const localPos = this.positionsBuffer.toAttribute();
    material.positionNode = localPos.add(this.centerUniform);

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
      vel.x,
      vel.y,
      vel.z,
      0,
    ));
    const angle = atan(viewVel.y, viewVel.x);
    material.rotationNode = angle;

    // Sprite size stays stable across lifetime; fade-out is opacity-only.
    const sizeBase = this.particleSizeUniform;
    material.scaleNode = vec2(sizeBase.mul(stretchSafe), sizeBase.div(stretchSafe));

    // Color: base color brightened only by motion. Multiplying by alphaLife
    // keeps dead particles invisible under additive blending.
    const baseColor = this.colorsBuffer.toAttribute();
    const speedTerm = speed.mul(0.05).clamp(0, 1).mul(this.speedGlowUniform);
    const glow = float(0.55).add(speedTerm);
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
      blending: THREE.AdditiveBlending,
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
    const scale = Math.max(0.01, this.params.fieldVolumeScale);
    this.fieldSphereRadiusUniform.value = this.params.fieldSphereRadius * scale;
    this.fieldSphereCenterYUniform.value = this.params.fieldSphereCenterY;
  }

  private buildThomasSeedTargets(): void {
    this.thomasSeedTargets.length = 0;
    let x = 0.1;
    let y = 0;
    let z = 0;
    const dt = 0.035;
    const warmup = 4000;
    const sampleStride = 12;
    const totalSteps = warmup + THOMAS_TARGET_COUNT * sampleStride;

    const deriv = (px: number, py: number, pz: number): [number, number, number] => [
      -THOMAS_SEED_A * px + Math.sin(py),
      -THOMAS_SEED_A * py + Math.sin(pz),
      -THOMAS_SEED_A * pz + Math.sin(px),
    ];

    for (let i = 0; i < totalSteps; i += 1) {
      const k1 = deriv(x, y, z);
      const k2 = deriv(x + k1[0] * dt * 0.5, y + k1[1] * dt * 0.5, z + k1[2] * dt * 0.5);
      const k3 = deriv(x + k2[0] * dt * 0.5, y + k2[1] * dt * 0.5, z + k2[2] * dt * 0.5);
      const k4 = deriv(x + k3[0] * dt, y + k3[1] * dt, z + k3[2] * dt);
      x += (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) * dt / 6;
      y += (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) * dt / 6;
      z += (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]) * dt / 6;

      if (i >= warmup && (i - warmup) % sampleStride === 0) {
        this.thomasSeedTargets.push(new THREE.Vector3(x, y, z));
      }
    }
  }

  private nextThomasTargetWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.thomasSeedTargets.length === 0) return out.set(0, this.fieldSphereCenterYUniform.value, 0);
    // Prime stride walks the precomputed orbit without visibly marching along
    // the array while still giving streams coherent Thomas-attractor targets.
    this.thomasTargetCursor = (this.thomasTargetCursor + 127) % this.thomasSeedTargets.length;
    const source = this.thomasSeedTargets[this.thomasTargetCursor];
    out.copy(source);
    out.applyMatrix3(this.sampleRotUniform.value);
    out.multiplyScalar(this.worldScaleUniform.value || 1);
    const spread = this.fieldSphereRadiusUniform.value * 0.18;
    const theta = Math.random() * TAU;
    const cos = Math.random() * 2 - 1;
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const radius = spread * Math.cbrt(Math.random());
    out.x += Math.cos(theta) * sin * radius;
    out.y += cos * radius;
    out.z += Math.sin(theta) * sin * radius;
    const targetLimit = this.fieldSphereRadiusUniform.value * 0.96;
    const len = out.length();
    if (len > targetLimit && len > 1e-5) out.multiplyScalar(targetLimit / len);
    out.y += this.fieldSphereCenterYUniform.value;
    return out;
  }

  private applyParticleLifetime(value = this.params.particleLifetime): void {
    const lifetime = Math.max(MIN_PARTICLE_LIFETIME, value);
    this.params.particleLifetime = lifetime;
    this.lifeMaxUniform.value = lifetime;
  }

  private applyMaxSpawnsPerFrame(value = this.params.maxSpawnsPerFrame): void {
    const next = clampSpawnQueueCapacity(value);
    this.params.maxSpawnsPerFrame = next;
    if (next === this.spawnQueueCapacity && this.spawnPosArray.length === next) return;
    this.spawnQueueCapacity = next;
    this.allocateSpawnQueue();
    this.buildComputePipelines();
  }

  private fillSpawnQueue(): void {
    let cursor = 0;
    const frameCap = this.spawnQueueCapacity;
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
      const launchRadius = req.kind === 'starlace' ? 0.10 : 0.14;
      const coneSpread = req.kind === 'starlace' ? 0.48 : 0.42;
      const targetBias = req.kind === 'starlace' ? 0.62 : 0.58;
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

        // Initial velocity aims at the active attractor, not at a random point
        // in the bounding sphere. For Thomas, precomputed orbit targets let
        // instrument streams enter the lobes quickly while the sphere remains
        // only an escape guardrail.
        let targetX: number;
        let targetY: number;
        let targetZ: number;
        if (this.currentAttractor === 'thomas') {
          const target = this.nextThomasTargetWorld(this.thomasTargetScratch);
          targetX = this.center.x + target.x;
          targetY = this.center.y + target.y;
          targetZ = this.center.z + target.z;
        } else {
          const targetTheta = Math.random() * TAU;
          const targetCos = Math.random() * 2 - 1;
          const targetSin = Math.sqrt(Math.max(0, 1 - targetCos * targetCos));
          const targetRadius = sphereRadius * (0.22 + Math.random() * 0.68);
          targetX = this.center.x + Math.cos(targetTheta) * targetSin * targetRadius;
          targetY = sphereCenterWorldY + targetCos * targetRadius;
          targetZ = this.center.z + Math.sin(targetTheta) * targetSin * targetRadius;
        }
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
    if (cursor > 0 && (this.affinityDebugParticleLifeMax <= 0 || this.affinityDebugParticleAge >= this.affinityDebugParticleLifeMax)) {
      this.affinityDebugParticleAge = 0;
      this.affinityDebugParticleLifeMax = lifeBase;
    }
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

function clampSpawnQueueCapacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SPAWNS_PER_FRAME;
  return Math.max(MIN_CONFIGURABLE_SPAWNS_PER_FRAME, Math.min(MAX_CONFIGURABLE_SPAWNS_PER_FRAME, Math.round(value)));
}
