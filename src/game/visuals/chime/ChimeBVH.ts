import * as THREE from 'three/webgpu';
import { PointsBVH } from 'three-mesh-bvh';

// Wraps three-mesh-bvh's PointsBVH for our gem cloud. Each gem is a single
// point in a BufferGeometry; positions are rewritten every frame after the
// verlet step, then the BVH is refit and used to drive sphere queries:
// gem-vs-gem (collision pairs) and hand-vs-gems (poke detection).

const _scratchPoint = new THREE.Vector3();
const _scratchSphere = new THREE.Sphere();

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
        intersectsPoint: pointIndex => {
          if (pointIndex <= i) return false;
          const o = pointIndex * 3;
          const dx = this.positions[o] - _scratchSphere.center.x;
          const dy = this.positions[o + 1] - _scratchSphere.center.y;
          const dz = this.positions[o + 2] - _scratchSphere.center.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r2) out.push({ a: i, b: pointIndex, distSq: d2 });
          return false;
        },
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
      intersectsPoint: pointIndex => {
        const o = pointIndex * 3;
        const dx = this.positions[o] - point.x;
        const dy = this.positions[o + 1] - point.y;
        const dz = this.positions[o + 2] - point.z;
        if (dx * dx + dy * dy + dz * dz < r2) out.push(pointIndex);
        return false;
      },
    });
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

void _scratchPoint;
