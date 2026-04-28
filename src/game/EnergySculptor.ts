import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { EmitRequest, EnergySink } from './sculptor/EnergyEmitter';
import type { Archetype, ArchetypeId } from './sculptor/archetypeShared';
import { drumDrum } from './sculptor/archetypes/drumDrum';
import { melodyMelody } from './sculptor/archetypes/melodyMelody';
import { drumMelody } from './sculptor/archetypes/drumMelody';

const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  drumDrum,
  melodyMelody,
  drumMelody,
};

export const SCULPTOR_DEFS = {
  particlePoolSize:     { default: 24576, min: 4096, max: 65536, step: 256, label: 'particle pool', hidden: true },
  attractorStrength:    { default: 3.1,   min: 0,    max: 8,    step: 0.05, label: 'attractor strength' },
  particleSize:         { default: 0.005, min: 0.001, max: 0.02, step: 0.001, label: 'particle size' },
  particleOpacity:      { default: 0.54,  min: 0.1,   max: 1,    step: 0.01,  label: 'particle opacity' },
  filamentOpacity:      { default: 0.26,  min: 0,     max: 0.8,  step: 0.01,  label: 'filament opacity' },
  filamentLength:       { default: 0.070, min: 0,     max: 0.24, step: 0.002, label: 'filament length' },
  filamentDensity:      { default: 0.66,  min: 0,     max: 1,    step: 0.01,  label: 'filament density' },
  velocityDamping:      { default: 0.972, min: 0.9,  max: 1,    step: 0.001, label: 'velocity damping' },
  crossCurrentStrength: { default: 0.8,   min: 0,    max: 2,    step: 0.01, label: 'cross-current' },
  memorySeconds:        { default: 200,   min: 10,   max: 600,  step: 1,    label: 'memory seconds' },
  fadeSeconds:          { default: 18,    min: 2,    max: 90,   step: 1,    label: 'fade seconds' },
  settleDistance:       { default: 0.035, min: 0.01, max: 0.2,  step: 0.001, label: 'settle distance', hidden: true },
  settledRadius:        { default: 0.055, min: 0.005, max: 0.18, step: 0.001, label: 'settled radius' },
  settledMotion:        { default: 0.72,  min: 0,     max: 2.0,  step: 0.01,  label: 'settled motion' },
  fieldStrength:        { default: 0.42,  min: 0,    max: 1.5,  step: 0.01, label: 'attractor field' },
  duetBonusGain:        { default: 1.2,   min: 0,    max: 2,    step: 0.05, label: 'duet bonus gain' },
  dissolveBurstSpeed:   { default: 3,     min: 0,    max: 8,    step: 0.1,  label: 'dissolve burst' },
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

const TMP_VEC = new THREE.Vector3();
const TMP_VEC_2 = new THREE.Vector3();
const TMP_MATRIX = new THREE.Matrix4();
const TMP_QUAT = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);
const TAU = Math.PI * 2;
const DEFAULT_MUSIC_FIELD: SculptorMusicField = {
  pulse: 0,
  drumLevel: 0,
  sustained: 0,
  intensity: 0,
  chordProgress: 0,
  groovePhase: 0,
};

/**
 * Particle-built sound sculpture at the center of the scene. Particles emitted
 * from the instruments stream toward `center`, get pulled through archetype
 * attractor fields, settle into the shared form, and only start aging out after
 * the memory window has passed.
 *
 * Integration runs CPU-side over the pool each frame; rendering uses a single
 * InstancedMesh with per-instance positions/colors written each frame. We can
 * lift the integrator into a TSL compute pass later — emitter contracts and
 * archetype targets are independent of where the integration happens.
 */
export class EnergySculptor implements EnergySink {
  readonly center: THREE.Vector3;
  readonly params: SculptorParams;

  private mesh!: THREE.InstancedMesh;
  private material!: THREE.MeshBasicMaterial;
  private filamentGeometry!: THREE.BufferGeometry;
  private filamentMaterial!: THREE.LineBasicMaterial;
  private filamentLine!: THREE.LineSegments;
  private size: number;

  // Per-particle CPU state. Length = size for scalars, size * 3 for vec3s.
  private positions: Float32Array;
  private velocities: Float32Array;
  private targets: Float32Array;
  private colors: Float32Array;
  private baseColors: Float32Array;
  private lifeCurrent: Float32Array;
  private lifeMax: Float32Array;
  private particleAges: Float32Array;
  private settledAges: Float32Array;
  private sizeScales: Float32Array;
  private filamentPositions: Float32Array;
  private filamentColors: Float32Array;
  private freeList: number[];

  // GPU instance color attribute.
  private instanceColors: THREE.InstancedBufferAttribute;

  private pendingEmits: EmitRequest[] = [];
  private registered?: ReturnType<typeof registerTweaks<typeof SCULPTOR_DEFS>>;
  private currentArchetype: Archetype = drumMelody;
  private roundProgress = 0;
  private musicField: SculptorMusicField = { ...DEFAULT_MUSIC_FIELD };
  private static SHAPE_TMP = new THREE.Vector3();
  private static FLOW_TMP = new THREE.Vector3();
  private static GRID_TMP = new THREE.Vector3();

  // Coarse 3D density grid for cross-currents: 8x8x8 per kind.
  private static GRID_DIM = 8;
  private static GRID_HALF_SPAN = 1.0;
  private densityDrum = new Float32Array(EnergySculptor.GRID_DIM ** 3);
  private densityStarlace = new Float32Array(EnergySculptor.GRID_DIM ** 3);
  private kinds: Uint8Array; // 0 = drum, 1 = starlace; indexed by particle slot.

  // Duet synchrony.
  private synchronyBoost = 0;
  private synchronyRing?: THREE.Mesh;
  private synchronyRingMaterial?: THREE.MeshBasicMaterial;
  private synchronyRingAge = 1; // start "old" so it's invisible at boot

  // Dissolve mode (1 during round-boundary outburst, else 0).
  private dissolveMode = 0;

  // In-world round timer ring.
  private static TIMER_SEGMENTS = 96;
  private timerRingLine?: THREE.Line;
  private timerRingMaterial?: THREE.LineBasicMaterial;
  private timerRingPositions?: Float32Array;

  constructor(scene: THREE.Scene, center: THREE.Vector3, paneDock?: HTMLElement) {
    this.center = center.clone();
    this.params = { ...Object.fromEntries(Object.entries(SCULPTOR_DEFS).map(([k, d]) => [k, d.default])) } as SculptorParams;

    this.size = this.params.particlePoolSize;
    this.positions = new Float32Array(this.size * 3);
    this.velocities = new Float32Array(this.size * 3);
    this.targets = new Float32Array(this.size * 3);
    this.colors = new Float32Array(this.size * 3);
    this.baseColors = new Float32Array(this.size * 3);
    this.lifeCurrent = new Float32Array(this.size);
    this.lifeMax = new Float32Array(this.size);
    this.particleAges = new Float32Array(this.size);
    this.settledAges = new Float32Array(this.size);
    this.sizeScales = new Float32Array(this.size);
    this.kinds = new Uint8Array(this.size);
    this.settledAges.fill(-1);
    this.freeList = [];
    for (let i = this.size - 1; i >= 0; i -= 1) this.freeList.push(i);

    const geometry = new THREE.SphereGeometry(1, 5, 4);
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: this.params.particleOpacity,
      depthWrite: false,
      blending: THREE.NormalBlending,
      // Per-instance color comes through InstancedMesh.setColorAt.
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.material, this.size);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 32;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate the per-instance color attribute so setColorAt works.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.instanceColors = this.mesh.instanceColor;

    // Hide all particles initially (zero scale).
    for (let i = 0; i < this.size; i += 1) {
      TMP_MATRIX.compose(this.center, TMP_QUAT.identity(), ZERO_SCALE);
      this.mesh.setMatrixAt(i, TMP_MATRIX);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    scene.add(this.mesh);

    // Synchrony ring — additive expanding pulse rendered at the sculptor center.
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
    scene.add(this.synchronyRing);

    // In-world halo ring. It used to be a countdown, but the sculpture now
    // keeps accruing; this stays as a quiet reference circle at the center.
    this.timerRingPositions = new Float32Array((EnergySculptor.TIMER_SEGMENTS + 1) * 3);
    const timerGeom = new THREE.BufferGeometry();
    timerGeom.setAttribute('position', new THREE.BufferAttribute(this.timerRingPositions, 3));
    this.refreshTimerRingGeometry();
    this.timerRingMaterial = new THREE.LineBasicMaterial({
      color: this.params.timerRingColor,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.timerRingLine = new THREE.Line(timerGeom, this.timerRingMaterial);
    this.timerRingLine.position.copy(this.center);
    this.timerRingLine.frustumCulled = false;
    this.timerRingLine.renderOrder = 34;
    scene.add(this.timerRingLine);

    this.registered = registerTweaks(paneDock, 'energySculptor', SCULPTOR_DEFS, {
      title: 'Energy Sculptor',
      params: this.params,
      onChange: {
        synchronyRingColor: v => this.synchronyRingMaterial?.color.set(v),
        timerRingColor: v => this.timerRingMaterial?.color.set(v),
        timerRingRadius: () => this.refreshTimerRingGeometry(),
        particleOpacity: v => { this.material.opacity = v; },
      },
    });
  }

  private refreshTimerRingGeometry(): void {
    if (!this.timerRingPositions) return;
    const r = this.params.timerRingRadius;
    const segs = EnergySculptor.TIMER_SEGMENTS;
    for (let i = 0; i <= segs; i += 1) {
      const theta = (i / segs) * Math.PI * 2 - Math.PI / 2; // start at top
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;
      const o = i * 3;
      this.timerRingPositions[o] = x;
      this.timerRingPositions[o + 1] = 0;
      this.timerRingPositions[o + 2] = z;
    }
    if (this.timerRingLine) {
      const attr = this.timerRingLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
    }
  }

  emit(req: EmitRequest): void {
    // During dissolve we drop emits on the floor — particles emitted now
    // would immediately be blown outward and waste pool slots that are about
    // to be needed by the new round.
    if (this.dissolveMode > 0) return;
    this.pendingEmits.push(req);
  }

  setArchetype(id: ArchetypeId): void {
    this.currentArchetype = ARCHETYPES[id];
  }

  setRoundProgress(progress: number): void {
    this.roundProgress = Math.max(0, progress);
  }

  setMusicField(field: SculptorMusicField): void {
    this.musicField.pulse = Math.max(0, Math.min(1, field.pulse));
    this.musicField.drumLevel = Math.max(0, Math.min(1, field.drumLevel));
    this.musicField.sustained = Math.max(0, Math.min(1, field.sustained));
    this.musicField.intensity = Math.max(0, Math.min(1, field.intensity));
    this.musicField.chordProgress = field.chordProgress - Math.floor(field.chordProgress);
    this.musicField.groovePhase = field.groovePhase - Math.floor(field.groovePhase);
  }

  /**
   * Fire the duet synchrony boost. Boosts attractor pull briefly and pulses
   * the synchrony ring outward as visible reward.
   */
  fireSynchrony(): void {
    this.synchronyBoost = 1;
    this.synchronyRingAge = 0;
  }

  getSynchronyBoost(): number {
    return this.synchronyBoost;
  }

  beginDissolve(): void {
    this.dissolveMode = 1;
  }

  endDissolve(): void {
    this.dissolveMode = 0;
  }

  update(delta: number): void {
    if (delta <= 0) return;
    this.drainEmits();
    this.refreshDensityGrids();
    this.integrate(delta);
    this.tickSynchrony(delta);
    this.updateTimerRing();
    this.writeMatrices();
  }

  private updateTimerRing(): void {
    if (!this.timerRingLine || !this.timerRingMaterial) return;
    const segs = EnergySculptor.TIMER_SEGMENTS;
    const build = Math.min(1, this.roundProgress);
    this.timerRingLine.geometry.setDrawRange(0, segs + 1);
    this.timerRingMaterial.opacity = this.dissolveMode > 0 ? 0.18 : 0.12 + build * 0.18;
  }

  dispose(): void {
    this.registered?.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
    if (this.synchronyRing) {
      this.synchronyRing.geometry.dispose();
      this.synchronyRingMaterial?.dispose();
      this.synchronyRing.removeFromParent();
    }
    if (this.timerRingLine) {
      this.timerRingLine.geometry.dispose();
      this.timerRingMaterial?.dispose();
      this.timerRingLine.removeFromParent();
    }
  }

  private drainEmits(): void {
    if (this.pendingEmits.length === 0) return;
    const reqs = this.pendingEmits;
    this.pendingEmits = [];
    const archetype = this.currentArchetype;
    const t = this.roundProgress;
    for (const req of reqs) {
      const allowed = Math.min(req.count, this.freeList.length);
      // Add per-archetype flow bias to the initial direction, computed once
      // per request from the burst origin (cheap; particles all share it).
      const flow = archetype.flow(req.origin, t, EnergySculptor.FLOW_TMP);
      for (let i = 0; i < allowed; i += 1) {
        const idx = this.freeList.pop()!;
        const o3 = idx * 3;
        const jitter = 0.12;
        const jx = (Math.random() - 0.5) * jitter;
        const jy = (Math.random() - 0.5) * jitter;
        const jz = (Math.random() - 0.5) * jitter;
        const dx = req.direction.x + jx + flow.x * 0.35;
        const dy = req.direction.y + jy + flow.y * 0.35;
        const dz = req.direction.z + jz + flow.z * 0.35;
        const dlen = Math.hypot(dx, dy, dz) || 1;
        this.positions[o3] = req.origin.x;
        this.positions[o3 + 1] = req.origin.y;
        this.positions[o3 + 2] = req.origin.z;
        this.velocities[o3] = (dx / dlen) * req.speed;
        this.velocities[o3 + 1] = (dy / dlen) * req.speed;
        this.velocities[o3 + 2] = (dz / dlen) * req.speed;
        // Per-particle archetype target. Sampled once at emit time so the
        // particle has a stable destination throughout its life — this is
        // what makes the sculpture have a recognizable silhouette.
        const norm = allowed > 1 ? (i + Math.random()) / allowed : Math.random();
        const seed = Math.random();
        const localTarget = archetype.shape(norm, t, seed, req.kind, EnergySculptor.SHAPE_TMP);
        this.targets[o3] = this.center.x + localTarget.x;
        this.targets[o3 + 1] = this.center.y + localTarget.y;
        this.targets[o3 + 2] = this.center.z + localTarget.z;
        this.baseColors[o3] = req.color.r;
        this.baseColors[o3 + 1] = req.color.g;
        this.baseColors[o3 + 2] = req.color.b;
        this.colors[o3] = req.color.r;
        this.colors[o3 + 1] = req.color.g;
        this.colors[o3 + 2] = req.color.b;
        this.lifeCurrent[idx] = 1;
        this.lifeMax[idx] = Math.max(0.55, req.lifetime);
        this.particleAges[idx] = 0;
        this.settledAges[idx] = -1;
        this.sizeScales[idx] = 0.75 + req.intensity * 0.7 + Math.random() * 0.25;
        this.kinds[idx] = req.kind === 'starlace' ? 1 : 0;
      }
    }
    this.instanceColors.needsUpdate = true;
  }

  /**
   * Walk all alive particles once; bucket them into per-kind density grids so
   * the integrator can deflect each particle from the *other* kind's stream.
   * Cheap (single pass over the pool) and keeps cross-currents purely CPU.
   */
  private refreshDensityGrids(): void {
    this.densityDrum.fill(0);
    this.densityStarlace.fill(0);
    const dim = EnergySculptor.GRID_DIM;
    const half = EnergySculptor.GRID_HALF_SPAN;
    const cx = this.center.x;
    const cy = this.center.y;
    const cz = this.center.z;
    const size = this.size;
    for (let i = 0; i < size; i += 1) {
      if (this.lifeCurrent[i] <= 0) continue;
      const o3 = i * 3;
      const lx = (this.positions[o3] - cx) / half;
      const ly = (this.positions[o3 + 1] - cy) / half;
      const lz = (this.positions[o3 + 2] - cz) / half;
      if (lx < -1 || lx > 1 || ly < -1 || ly > 1 || lz < -1 || lz > 1) continue;
      const gx = Math.min(dim - 1, Math.max(0, Math.floor((lx * 0.5 + 0.5) * dim)));
      const gy = Math.min(dim - 1, Math.max(0, Math.floor((ly * 0.5 + 0.5) * dim)));
      const gz = Math.min(dim - 1, Math.max(0, Math.floor((lz * 0.5 + 0.5) * dim)));
      const idx = gx + gy * dim + gz * dim * dim;
      if (this.kinds[i] === 1) this.densityStarlace[idx] += 1;
      else this.densityDrum[idx] += 1;
    }
  }

  private sampleOtherDensity(kind: number, px: number, py: number, pz: number): number {
    const dim = EnergySculptor.GRID_DIM;
    const half = EnergySculptor.GRID_HALF_SPAN;
    const lx = (px - this.center.x) / half;
    const ly = (py - this.center.y) / half;
    const lz = (pz - this.center.z) / half;
    if (lx < -1 || lx > 1 || ly < -1 || ly > 1 || lz < -1 || lz > 1) return 0;
    const gx = Math.min(dim - 1, Math.max(0, Math.floor((lx * 0.5 + 0.5) * dim)));
    const gy = Math.min(dim - 1, Math.max(0, Math.floor((ly * 0.5 + 0.5) * dim)));
    const gz = Math.min(dim - 1, Math.max(0, Math.floor((lz * 0.5 + 0.5) * dim)));
    const cell = gx + gy * dim + gz * dim * dim;
    return kind === 1 ? this.densityDrum[cell] : this.densityStarlace[cell];
  }

  private tickSynchrony(delta: number): void {
    // Boost decays exponentially over ~0.5s.
    this.synchronyBoost = Math.max(0, this.synchronyBoost * Math.exp(-delta * 4.5));
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

  private integrate(delta: number): void {
    const damping = Math.pow(this.params.velocityDamping, delta * 60);
    const settledDamping = Math.pow(0.91, delta * 60);
    const baseAttractor = this.params.attractorStrength;
    const cross = this.params.crossCurrentStrength;
    const field = this.params.fieldStrength;
    const duet = this.params.duetBonusGain;
    const boost = this.synchronyBoost;
    const pull = baseAttractor * (1 + boost * duet);
    const memorySeconds = Math.max(0, this.params.memorySeconds);
    const fadeSeconds = Math.max(0.001, this.params.fadeSeconds);
    const settleDistance = this.params.settleDistance;
    const settledRadius = this.params.settledRadius;
    const settledMotion = this.params.settledMotion;
    const size = this.size;
    const dissolving = this.dissolveMode > 0;
    const burstSpeed = this.params.dissolveBurstSpeed;
    const fieldPhase = this.roundProgress * Math.PI * 2;
    const musicPulse = this.musicField.pulse;
    const musicLevel = this.musicField.drumLevel;
    const musicSustain = this.musicField.sustained;
    const musicIntensity = this.musicField.intensity;
    const groovePhase = this.musicField.groovePhase * TAU;
    const chordPhase = this.musicField.chordProgress * TAU;
    const musicWaveAmp = musicLevel * 0.045 + musicPulse * 0.085 + musicIntensity * 0.025;
    const fieldBoost = field * (1 + musicIntensity * 0.9 + musicPulse * 1.1);
    for (let i = 0; i < size; i += 1) {
      if (this.lifeCurrent[i] <= 0) continue;
      this.particleAges[i] += delta;
      const o3 = i * 3;
      const px = this.positions[o3];
      const py = this.positions[o3 + 1];
      const pz = this.positions[o3 + 2];
      const tx = this.targets[o3];
      const ty = this.targets[o3 + 1];
      const tz = this.targets[o3 + 2];
      const rx = tx - this.center.x;
      const ry = ty - this.center.y;
      const rz = tz - this.center.z;
      const targetRadius = Math.hypot(rx, rz);
      const targetAngle = Math.atan2(rz, rx);
      const wave = Math.sin(targetRadius * 18 - groovePhase * 2 + ry * 7 + chordPhase) * musicWaveAmp;
      const chordTilt = Math.sin(chordPhase + ry * 3.5 + targetAngle * 2) * musicSustain * 0.045;
      const attractX = tx + Math.cos(targetAngle) * wave - Math.sin(targetAngle) * chordTilt;
      const attractY = ty
        + Math.cos(targetRadius * 12 - groovePhase * 4 + chordPhase) * musicWaveAmp * 0.58
        + Math.sin(targetAngle * 3 + chordPhase) * musicPulse * 0.026;
      const attractZ = tz + Math.sin(targetAngle) * wave + Math.cos(targetAngle) * chordTilt;
      let dx = attractX - px;
      let dy = attractY - py;
      let dz = attractZ - pz;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      const ndx = dx / dist;
      const ndy = dy / dist;
      const ndz = dz / dist;
      let vx = this.velocities[o3];
      let vy = this.velocities[o3 + 1];
      let vz = this.velocities[o3 + 2];
      const settled = this.settledAges[i] >= 0;
      if (dissolving) {
        // Outward burst from center; ignores attractor.
        let ox = px - this.center.x;
        let oy = py - this.center.y;
        let oz = pz - this.center.z;
        const olen = Math.hypot(ox, oy, oz) || 1;
        ox /= olen; oy /= olen; oz /= olen;
        vx += ox * burstSpeed * delta;
        vy += oy * burstSpeed * delta;
        vz += oz * burstSpeed * delta;
        this.lifeCurrent[i] -= delta * 1.8;
      } else if (settled) {
        const settledAge = this.settledAges[i] + delta;
        this.settledAges[i] = settledAge;
        const seedA = Math.sin((i + 1) * 12.9898) * 43758.5453;
        const seedB = Math.sin((i + 1) * 78.233) * 19341.719;
        const a = seedA - Math.floor(seedA);
        const b = seedB - Math.floor(seedB);
        const phase = settledAge * (0.65 + a * 0.85) * settledMotion + a * TAU + groovePhase * (0.35 + b * 0.55);
        const pocket = settledRadius * (0.55 + b * 0.75) * (1 + musicPulse * 0.7 + musicLevel * 0.24);
        const driftX = Math.cos(phase) * pocket;
        const driftY = Math.sin(phase * 0.73 + b * TAU) * pocket * 0.46
          + Math.sin(groovePhase * 2 + targetRadius * 10 + b * TAU) * musicWaveAmp * 0.8;
        const driftZ = Math.sin(phase * (0.9 + b * 0.22)) * pocket;
        const fdx = attractX + driftX - px;
        const fdy = attractY + driftY - py;
        const fdz = attractZ + driftZ - pz;
        const flen = Math.hypot(fdx, fdy, fdz) || 1;
        vx += fdx * pull * 1.05 * delta;
        vy += fdy * pull * 1.05 * delta;
        vz += fdz * pull * 1.05 * delta;
        // A small tangential field keeps settled particles alive without
        // letting them leave their local attractor pocket.
        const settledDrive = settledMotion * (0.38 + musicPulse * 0.26 + musicLevel * 0.08);
        vx += (-fdz / flen) * settledDrive * delta;
        vy += Math.cos(phase * 1.37 + chordPhase) * settledMotion * (0.08 + musicPulse * 0.08) * delta;
        vz += (fdx / flen) * settledDrive * delta;
      } else {
        const lx = px - this.center.x;
        const ly = py - this.center.y;
        const lz = pz - this.center.z;
        const lr = Math.hypot(lx, lz) || 1;
        const handed = this.kinds[i] === 1 ? -1 : 1;
        const beatWave = Math.sin(lr * 15 - groovePhase * 3 + ly * 6 + chordPhase) * (musicPulse * 0.34 + musicLevel * 0.12);
        const curlX = -lz * 0.92 + Math.sin(ly * 6.0 + fieldPhase + lx * 2.2) * 0.18 + (lx / lr) * beatWave;
        const curlY = Math.sin((lx - lz) * 7.0 + fieldPhase * 0.7 + chordPhase) * 0.22 + 0.08 + musicPulse * 0.05;
        const curlZ = lx * 0.92 + Math.cos(ly * 5.2 - fieldPhase + lz * 2.4) * 0.18 + (lz / lr) * beatWave;
        vx += (dx * pull + ndx * pull * 0.18 + curlX * fieldBoost * handed) * delta;
        vy += (dy * pull + ndy * pull * 0.18 + curlY * fieldBoost) * delta;
        vz += (dz * pull + ndz * pull * 0.18 + curlZ * fieldBoost * handed) * delta;

        const flightWindow = this.lifeMax[i] * 3.6;
        if (dist < settleDistance || this.particleAges[i] > flightWindow) {
          this.settledAges[i] = 0;
        }
      }
      // Cross-current: deflect from the other kind's local density. We use a
      // tangent of the to-target direction as the deflection axis so streams
      // visibly bend around each other rather than just slowing down.
      if (cross > 0) {
        const otherDensity = this.sampleOtherDensity(this.kinds[i], px, py, pz);
        if (otherDensity > 0.5) {
          // Tangent = up x toTarget normalized, fallback if degenerate.
          let tdx = -ndz;
          let tdy = 0;
          let tdz = ndx;
          const tlen = Math.hypot(tdx, tdy, tdz) || 1;
          tdx /= tlen; tdy /= tlen; tdz /= tlen;
          const dscale = Math.min(1, otherDensity / 6) * cross * delta * (settled ? 0.08 : 1);
          vx += tdx * dscale;
          vy += tdy * dscale;
          vz += tdz * dscale;
        }
      }
      const damp = settled ? settledDamping : damping;
      vx *= damp; vy *= damp; vz *= damp;
      this.velocities[o3] = vx;
      this.velocities[o3 + 1] = vy;
      this.velocities[o3 + 2] = vz;
      this.positions[o3] = px + vx * delta;
      this.positions[o3 + 1] = py + vy * delta;
      this.positions[o3 + 2] = pz + vz * delta;
      if (!dissolving && this.settledAges[i] >= memorySeconds) {
        this.lifeCurrent[i] = Math.max(0, 1 - (this.settledAges[i] - memorySeconds) / fadeSeconds);
      } else if (!dissolving) {
        this.lifeCurrent[i] = 1;
      }
      if (this.lifeCurrent[i] <= 0) {
        this.lifeCurrent[i] = 0;
        this.particleAges[i] = 0;
        this.settledAges[i] = -1;
        this.freeList.push(i);
      }
    }
  }

  private writeMatrices(): void {
    const baseSize = this.params.particleSize;
    const musicSize = 1 + this.musicField.pulse * 0.14 + this.musicField.drumLevel * 0.08;
    const musicColor = 0.74 + this.musicField.intensity * 0.13 + this.musicField.pulse * 0.10;
    const size = this.size;
    for (let i = 0; i < size; i += 1) {
      const o3 = i * 3;
      const alpha = this.lifeCurrent[i];
      const born = alpha > 0 ? Math.min(1, this.particleAges[i] / 0.22) : 0;
      const settled = this.settledAges[i] >= 0;
      const settleScale = settled ? 1.18 : 0.82;
      const s = alpha > 0
        ? baseSize * this.sizeScales[i] * settleScale * musicSize * born * (0.2 + Math.sqrt(alpha) * 0.8)
        : 0;
      const colorScale = alpha > 0 ? (0.16 + Math.sqrt(alpha) * 0.68) * musicColor : 0;
      this.colors[o3] = this.baseColors[o3] * colorScale;
      this.colors[o3 + 1] = this.baseColors[o3 + 1] * colorScale;
      this.colors[o3 + 2] = this.baseColors[o3 + 2] * colorScale;
      TMP_VEC.set(this.positions[o3], this.positions[o3 + 1], this.positions[o3 + 2]);
      TMP_SCALE.setScalar(s);
      TMP_MATRIX.compose(TMP_VEC, TMP_QUAT.identity(), TMP_SCALE);
      this.mesh.setMatrixAt(i, TMP_MATRIX);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.instanceColors.needsUpdate = true;
  }
}

void TMP_VEC_2;
