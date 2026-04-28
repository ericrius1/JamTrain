import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { EmitRequest, EnergySink } from './sculptor/EnergyEmitter';

export const SCULPTOR_DEFS = {
  particlePoolSize:     { default: 12288, min: 4096, max: 24576, step: 256, label: 'particle pool', hidden: true },
  attractorStrength:    { default: 1.5,   min: 0,    max: 4,    step: 0.05, label: 'attractor strength' },
  particleSize:         { default: 0.018, min: 0.004, max: 0.05, step: 0.001, label: 'particle size' },
  velocityDamping:      { default: 0.985, min: 0.9,  max: 1,    step: 0.001, label: 'velocity damping' },
} as const;

export type SculptorParams = ParamsOf<typeof SCULPTOR_DEFS>;

const TMP_VEC = new THREE.Vector3();
const TMP_VEC_2 = new THREE.Vector3();
const TMP_MATRIX = new THREE.Matrix4();
const TMP_QUAT = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);

/**
 * Particle-built sound sculpture at the center of the scene. Particles emitted
 * from the instruments stream toward `center`, get pulled by an attractor (a
 * single point for now; archetype-driven targets land in Task 5), and age out.
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
  private size: number;

  // Per-particle CPU state. Length = size for scalars, size * 3 for vec3s.
  private positions: Float32Array;
  private velocities: Float32Array;
  private targets: Float32Array;
  private colors: Float32Array;
  private lifeCurrent: Float32Array;
  private lifeMax: Float32Array;
  private freeList: number[];

  // GPU instance color attribute.
  private instanceColors: THREE.InstancedBufferAttribute;

  private pendingEmits: EmitRequest[] = [];
  private registered?: ReturnType<typeof registerTweaks<typeof SCULPTOR_DEFS>>;

  constructor(scene: THREE.Scene, center: THREE.Vector3, paneDock?: HTMLElement) {
    this.center = center.clone();
    this.params = { ...Object.fromEntries(Object.entries(SCULPTOR_DEFS).map(([k, d]) => [k, d.default])) } as SculptorParams;

    this.size = this.params.particlePoolSize;
    this.positions = new Float32Array(this.size * 3);
    this.velocities = new Float32Array(this.size * 3);
    this.targets = new Float32Array(this.size * 3);
    this.colors = new Float32Array(this.size * 3);
    this.lifeCurrent = new Float32Array(this.size);
    this.lifeMax = new Float32Array(this.size);
    this.freeList = [];
    for (let i = this.size - 1; i >= 0; i -= 1) this.freeList.push(i);

    const geometry = new THREE.SphereGeometry(1, 5, 4);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Per-instance color comes through InstancedMesh.setColorAt.
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, this.size);
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

    this.registered = registerTweaks(paneDock, 'energySculptor', SCULPTOR_DEFS, {
      title: 'Energy Sculptor',
      params: this.params,
    });
  }

  emit(req: EmitRequest): void {
    this.pendingEmits.push(req);
  }

  update(delta: number): void {
    if (delta <= 0) return;
    this.drainEmits();
    this.integrate(delta);
    this.writeMatrices();
  }

  dispose(): void {
    this.registered?.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }

  private drainEmits(): void {
    if (this.pendingEmits.length === 0) return;
    const reqs = this.pendingEmits;
    this.pendingEmits = [];
    for (const req of reqs) {
      const allowed = Math.min(req.count, this.freeList.length);
      for (let i = 0; i < allowed; i += 1) {
        const idx = this.freeList.pop()!;
        const o3 = idx * 3;
        // Random angular jitter on direction so a burst spreads visibly.
        const jitter = 0.18;
        const jx = (Math.random() - 0.5) * jitter;
        const jy = (Math.random() - 0.5) * jitter;
        const jz = (Math.random() - 0.5) * jitter;
        const dx = req.direction.x + jx;
        const dy = req.direction.y + jy;
        const dz = req.direction.z + jz;
        const dlen = Math.hypot(dx, dy, dz) || 1;
        this.positions[o3] = req.origin.x;
        this.positions[o3 + 1] = req.origin.y;
        this.positions[o3 + 2] = req.origin.z;
        this.velocities[o3] = (dx / dlen) * req.speed;
        this.velocities[o3 + 1] = (dy / dlen) * req.speed;
        this.velocities[o3 + 2] = (dz / dlen) * req.speed;
        // Default target = center (archetype shape sampler will override in a later phase).
        this.targets[o3] = this.center.x;
        this.targets[o3 + 1] = this.center.y;
        this.targets[o3 + 2] = this.center.z;
        this.colors[o3] = req.color.r;
        this.colors[o3 + 1] = req.color.g;
        this.colors[o3 + 2] = req.color.b;
        this.lifeCurrent[idx] = req.lifetime;
        this.lifeMax[idx] = req.lifetime;
      }
    }
    this.instanceColors.needsUpdate = true;
  }

  private integrate(delta: number): void {
    const damping = this.params.velocityDamping;
    const pull = this.params.attractorStrength;
    const size = this.size;
    for (let i = 0; i < size; i += 1) {
      if (this.lifeCurrent[i] <= 0) continue;
      const o3 = i * 3;
      const px = this.positions[o3];
      const py = this.positions[o3 + 1];
      const pz = this.positions[o3 + 2];
      const tx = this.targets[o3];
      const ty = this.targets[o3 + 1];
      const tz = this.targets[o3 + 2];
      let dx = tx - px;
      let dy = ty - py;
      let dz = tz - pz;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      dx /= dist; dy /= dist; dz /= dist;
      let vx = this.velocities[o3] + dx * pull * delta;
      let vy = this.velocities[o3 + 1] + dy * pull * delta;
      let vz = this.velocities[o3 + 2] + dz * pull * delta;
      vx *= damping; vy *= damping; vz *= damping;
      this.velocities[o3] = vx;
      this.velocities[o3 + 1] = vy;
      this.velocities[o3 + 2] = vz;
      this.positions[o3] = px + vx * delta;
      this.positions[o3 + 1] = py + vy * delta;
      this.positions[o3 + 2] = pz + vz * delta;
      this.lifeCurrent[i] -= delta;
      if (this.lifeCurrent[i] <= 0) {
        this.lifeCurrent[i] = 0;
        this.freeList.push(i);
      }
    }
  }

  private writeMatrices(): void {
    const baseSize = this.params.particleSize;
    const size = this.size;
    for (let i = 0; i < size; i += 1) {
      const o3 = i * 3;
      const lifeFrac = this.lifeMax[i] > 0 ? this.lifeCurrent[i] / this.lifeMax[i] : 0;
      const s = lifeFrac > 0 ? baseSize * (0.55 + lifeFrac * 0.6) : 0;
      TMP_VEC.set(this.positions[o3], this.positions[o3 + 1], this.positions[o3 + 2]);
      TMP_SCALE.setScalar(s);
      TMP_MATRIX.compose(TMP_VEC, TMP_QUAT.identity(), TMP_SCALE);
      this.mesh.setMatrixAt(i, TMP_MATRIX);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

void TMP_VEC_2;
