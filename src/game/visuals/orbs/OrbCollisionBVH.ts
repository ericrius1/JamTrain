import * as THREE from 'three/webgpu';
import { PointsBVH } from 'three-mesh-bvh';

const _querySphere = new THREE.Sphere();
const _segment = new THREE.Vector3();
const _pointToStart = new THREE.Vector3();
const _closest = new THREE.Vector3();

export class OrbCollisionBVH {
  readonly count: number;
  readonly geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private bvh: PointsBVH;

  constructor(count: number) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.bvh = new PointsBVH(this.geometry);
  }

  setPoint(i: number, x: number, y: number, z: number): void {
    const k = i * 3;
    this.positions[k] = x;
    this.positions[k + 1] = y;
    this.positions[k + 2] = z;
  }

  getPoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    const k = i * 3;
    return out.set(this.positions[k], this.positions[k + 1], this.positions[k + 2]);
  }

  refit(): void {
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.bvh.refit();
  }

  collectSweptPointHits(from: THREE.Vector3, to: THREE.Vector3, radius: number, out: number[]): void {
    const sweepRadius = radius + from.distanceTo(to) * 0.5;
    _querySphere.center.copy(from).lerp(to, 0.5);
    _querySphere.radius = sweepRadius;

    const r2 = radius * radius;
    this.bvh.shapecast({
      intersectsBounds: box => box.intersectsSphere(_querySphere),
      intersectsPoint: this.makePointVisitor(pointIndex => {
        if (this.distanceSqToSegment(pointIndex, from, to) <= r2) out.push(pointIndex);
        return false;
      }),
    });
  }

  collectPointHits(point: THREE.Vector3, radius: number, out: number[]): void {
    const r2 = radius * radius;
    _querySphere.center.copy(point);
    _querySphere.radius = radius;

    this.bvh.shapecast({
      intersectsBounds: box => box.intersectsSphere(_querySphere),
      intersectsPoint: this.makePointVisitor(pointIndex => {
        const k = pointIndex * 3;
        const dx = this.positions[k] - point.x;
        const dy = this.positions[k + 1] - point.y;
        const dz = this.positions[k + 2] - point.z;
        if (dx * dx + dy * dy + dz * dz <= r2) out.push(pointIndex);
        return false;
      }),
    });
  }

  dispose(): void {
    this.geometry.dispose();
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
}
