import * as THREE from 'three/webgpu';
import { PointsBVH } from 'three-mesh-bvh';

// Wraps three-mesh-bvh's PointsBVH for our gem cloud. Each gem is a single
// point in a BufferGeometry; positions are rewritten every frame after the
// verlet step, then the BVH is refit and used to drive sphere queries:
// gem-vs-gem (collision pairs) and hand-vs-gems (poke detection).

const _scratchPoint = new THREE.Vector3();
const _scratchSphere = new THREE.Sphere();
const _segment = new THREE.Vector3();
const _pointToStart = new THREE.Vector3();
const _closest = new THREE.Vector3();

export type GemPair = {
  /** Lower index — owner. */
  a: number;
  /** Higher index. */
  b: number;
  /** Squared distance at time of test. */
  distSq: number;
};

export class ChimeBVH {
  readonly count: number;
  readonly geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private bvh: PointsBVH;

  constructor(count: number) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    // The BVH expects a populated position attribute at construction time; we
    // initialize to zero and refit after the first verlet step.
    this.bvh = new PointsBVH(this.geometry);
  }

  /** Update one gem's position; caller must invoke `refit()` once per frame. */
  setPoint(i: number, x: number, y: number, z: number): void {
    const k = i * 3;
    this.positions[k] = x;
    this.positions[k + 1] = y;
    this.positions[k + 2] = z;
  }

  /** Get gem center into a Vector3 (returns the same vec3 for chaining). */
  getPoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    const k = i * 3;
    return out.set(this.positions[k], this.positions[k + 1], this.positions[k + 2]);
  }

  /** Refit the BVH bounds from the updated point cloud. Call after writing
   *  all gem positions for this frame. Cheap for small N. */
  refit(): void {
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.bvh.refit();
  }

  /** Find every (i, j) pair within `radius` of each other. `radius` is the
   *  sphere of contact (i.e. 2 × gemRadius for sphere-on-sphere contact).
   *  Pushes pairs into `out`. Each pair appears once with a < b. */
  collectGemPairs(radius: number, out: GemPair[]): void {
    const r2 = radius * radius;
    for (let i = 0; i < this.count; i += 1) {
      const k = i * 3;
      _scratchSphere.center.set(this.positions[k], this.positions[k + 1], this.positions[k + 2]);
      _scratchSphere.radius = radius;

      this.bvh.shapecast({
        intersectsBounds: box => box.intersectsSphere(_scratchSphere),
        intersectsPoint: this.makePointVisitor(pointIndex => {
          if (pointIndex <= i) return false;
          const o = pointIndex * 3;
          const dx = this.positions[o] - _scratchSphere.center.x;
          const dy = this.positions[o + 1] - _scratchSphere.center.y;
          const dz = this.positions[o + 2] - _scratchSphere.center.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2) out.push({ a: i, b: pointIndex, distSq: d2 });
          return false;
        }),
      });
    }
  }

  /** Return every gem within `radius` of the given world-space point. */
  collectHandHits(point: THREE.Vector3, radius: number, out: number[]): void {
    const r2 = radius * radius;
    _scratchSphere.center.copy(point);
    _scratchSphere.radius = radius;
    this.bvh.shapecast({
      intersectsBounds: box => box.intersectsSphere(_scratchSphere),
      intersectsPoint: this.makePointVisitor(pointIndex => {
        const o = pointIndex * 3;
        const dx = this.positions[o] - point.x;
        const dy = this.positions[o + 1] - point.y;
        const dz = this.positions[o + 2] - point.z;
        if (dx * dx + dy * dy + dz * dz < r2) out.push(pointIndex);
        return false;
      }),
    });
  }

  /** Return every gem intersected by a swept sphere from `from` to `to`. */
  collectSweptPointHits(from: THREE.Vector3, to: THREE.Vector3, radius: number, out: number[]): void {
    const sweepRadius = radius + from.distanceTo(to) * 0.5;
    _scratchSphere.center.copy(from).lerp(to, 0.5);
    _scratchSphere.radius = sweepRadius;

    const r2 = radius * radius;
    this.bvh.shapecast({
      intersectsBounds: box => box.intersectsSphere(_scratchSphere),
      intersectsPoint: this.makePointVisitor(pointIndex => {
        if (this.distanceSqToSegment(pointIndex, from, to) <= r2) out.push(pointIndex);
        return false;
      }),
    });
  }

  dispose(): void {
    this.geometry.dispose();
  }

  private makePointVisitor(
    visit: (pointIndex: number) => boolean | void,
  ): (pointIndex: number, contained: boolean, depth: number) => boolean | void {
    return ((first: number | THREE.Vector3, second?: number | boolean) => {
      const pointIndex = typeof first === 'number'
        ? first
        : typeof second === 'number'
          ? second
          : -1;
      if (pointIndex < 0 || pointIndex >= this.count) return false;
      return visit(pointIndex);
    }) as (pointIndex: number, contained: boolean, depth: number) => boolean | void;
  }

  private distanceSqToSegment(pointIndex: number, from: THREE.Vector3, to: THREE.Vector3): number {
    const k = pointIndex * 3;
    _segment.copy(to).sub(from);
    const lenSq = _segment.lengthSq();
    if (lenSq <= 1e-8) {
      const dx = this.positions[k] - to.x;
      const dy = this.positions[k + 1] - to.y;
      const dz = this.positions[k + 2] - to.z;
      return dx * dx + dy * dy + dz * dz;
    }

    _pointToStart.set(this.positions[k], this.positions[k + 1], this.positions[k + 2]).sub(from);
    const t = THREE.MathUtils.clamp(_pointToStart.dot(_segment) / lenSq, 0, 1);
    _closest.copy(from).addScaledVector(_segment, t);
    const dx = this.positions[k] - _closest.x;
    const dy = this.positions[k + 1] - _closest.y;
    const dz = this.positions[k + 2] - _closest.z;
    return dx * dx + dy * dy + dz * dz;
  }
}

void _scratchPoint;
