// Pure-math verlet rope. One chain owns N nodes laid out top-down: index 0 is
// the pinned root (set externally each frame), indices 1..N-1 dangle below
// under gravity + wind. Distance constraints between consecutive nodes keep
// the rope from stretching. No three.js dependency — positions are flat
// Float32Arrays so a parent can write them straight into BufferAttributes.

const TMP = new Float32Array(3);

export type ChainOptions = {
  nodeCount: number;
  segmentLength: number;
  gravity?: number;       // m/s^2 along -Y, applied to free nodes
  damping?: number;       // 0..1 velocity retention per substep
  iterations?: number;    // constraint solver passes per substep
};

export class VerletChain {
  readonly nodeCount: number;
  // Mutable so a parent system can hot-tweak rope shape/feel each frame.
  segmentLength: number;
  gravity: number;
  damping: number;
  iterations: number;
  readonly positions: Float32Array;       // current pos, flat XYZ
  readonly previous: Float32Array;        // previous pos, flat XYZ
  readonly forces: Float32Array;          // per-node accumulated force, flat XYZ

  constructor(opts: ChainOptions) {
    this.nodeCount = opts.nodeCount;
    this.segmentLength = opts.segmentLength;
    this.gravity = opts.gravity ?? 9.8;
    this.damping = opts.damping ?? 0.985;
    this.iterations = opts.iterations ?? 4;
    this.positions = new Float32Array(this.nodeCount * 3);
    this.previous = new Float32Array(this.nodeCount * 3);
    this.forces = new Float32Array(this.nodeCount * 3);
  }

  /** Place every node along a straight line from `(rx,ry,rz)` going down. */
  reset(rx: number, ry: number, rz: number): void {
    for (let i = 0; i < this.nodeCount; i += 1) {
      const k = i * 3;
      this.positions[k] = rx;
      this.positions[k + 1] = ry - i * this.segmentLength;
      this.positions[k + 2] = rz;
      this.previous[k] = this.positions[k];
      this.previous[k + 1] = this.positions[k + 1];
      this.previous[k + 2] = this.positions[k + 2];
    }
    this.forces.fill(0);
  }

  /** Pin the root node — overwrites its position and zeroes its velocity. */
  setRoot(rx: number, ry: number, rz: number): void {
    this.positions[0] = rx;
    this.positions[1] = ry;
    this.positions[2] = rz;
    this.previous[0] = rx;
    this.previous[1] = ry;
    this.previous[2] = rz;
  }

  /** Add a per-frame force on a free node (index 1..N-1). */
  addForce(nodeIdx: number, fx: number, fy: number, fz: number): void {
    if (nodeIdx <= 0 || nodeIdx >= this.nodeCount) return;
    const k = nodeIdx * 3;
    this.forces[k] += fx;
    this.forces[k + 1] += fy;
    this.forces[k + 2] += fz;
  }

  /** Add a force to every free node (used for uniform wind). */
  addForceAll(fx: number, fy: number, fz: number): void {
    for (let i = 1; i < this.nodeCount; i += 1) {
      const k = i * 3;
      this.forces[k] += fx;
      this.forces[k + 1] += fy;
      this.forces[k + 2] += fz;
    }
  }

  /** Apply an impulse — directly nudges a node by adding to its current pos
   *  while leaving previous unchanged so the next substep sees velocity. */
  addImpulse(nodeIdx: number, dx: number, dy: number, dz: number): void {
    if (nodeIdx <= 0 || nodeIdx >= this.nodeCount) return;
    const k = nodeIdx * 3;
    this.positions[k] += dx;
    this.positions[k + 1] += dy;
    this.positions[k + 2] += dz;
  }

  /** Step the simulation by `dt` seconds. Root must be pinned externally. */
  step(dt: number): void {
    const dt2 = dt * dt;
    const damp = this.damping;
    const g = this.gravity;
    const N = this.nodeCount;
    const pos = this.positions;
    const prev = this.previous;
    const forces = this.forces;

    // Verlet integration — free nodes only.
    for (let i = 1; i < N; i += 1) {
      const k = i * 3;
      const vx = (pos[k] - prev[k]) * damp;
      const vy = (pos[k + 1] - prev[k + 1]) * damp;
      const vz = (pos[k + 2] - prev[k + 2]) * damp;
      prev[k] = pos[k];
      prev[k + 1] = pos[k + 1];
      prev[k + 2] = pos[k + 2];
      pos[k] += vx + forces[k] * dt2;
      pos[k + 1] += vy + (forces[k + 1] - g) * dt2;
      pos[k + 2] += vz + forces[k + 2] * dt2;
    }
    forces.fill(0);

    // Distance constraints — multiple passes for stiffness.
    const seg = this.segmentLength;
    for (let iter = 0; iter < this.iterations; iter += 1) {
      for (let i = 0; i < N - 1; i += 1) {
        const a = i * 3;
        const b = (i + 1) * 3;
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = (dist - seg) / dist;
        // Root (i=0) is immovable; whole correction goes to the lower node.
        if (i === 0) {
          pos[b] -= dx * diff;
          pos[b + 1] -= dy * diff;
          pos[b + 2] -= dz * diff;
        } else {
          const half = diff * 0.5;
          pos[a] += dx * half;
          pos[a + 1] += dy * half;
          pos[a + 2] += dz * half;
          pos[b] -= dx * half;
          pos[b + 1] -= dy * half;
          pos[b + 2] -= dz * half;
        }
      }
    }
    void TMP;
  }

  /** Read node `i` into `out` (or a fresh array). */
  getPosition(i: number, out: Float32Array | number[] = TMP): typeof out {
    const k = i * 3;
    out[0] = this.positions[k];
    out[1] = this.positions[k + 1];
    out[2] = this.positions[k + 2];
    return out;
  }
}
