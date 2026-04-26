import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeManeMaterial } from '../creatureShading';

export type LionManeHandles = {
  group: THREE.Group;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

const TAU = Math.PI * 2;

export function buildLionMane(
  lighting: CreatureLighting,
  seatColor: number,
  seatIndex: number,
  tuftCount = 48
): LionManeHandles {
  const group = new THREE.Group();
  const outer = makeManeMaterial(lighting, seatColor);
  // Inner darker mane: same factory tinted toward black so it reads as shadow underneath.
  const innerColor = new THREE.Color(seatColor).lerp(new THREE.Color('#1a0d05'), 0.7).getHex();
  const inner = makeManeMaterial(lighting, innerColor);

  const tuftGeom = new THREE.ConeGeometry(0.022, 0.085, 7);

  const innerMesh = new THREE.InstancedMesh(tuftGeom, inner, tuftCount);
  const outerMesh = new THREE.InstancedMesh(tuftGeom, outer, tuftCount);

  const dummy = new THREE.Object3D();
  // Deterministic per-player jitter — seatIndex shifts the seed so each player
  // gets a stable but distinct mane.
  const seedFn = (i: number) => {
    const x = Math.sin((i + 1) * 12.9898 + seatIndex * 7.13) * 43758.5453;
    return x - Math.floor(x);
  };

  // Inner pass: tighter, smaller, slightly inset.
  for (let i = 0; i < tuftCount; i += 1) {
    const t = i / tuftCount;
    const angle = t * TAU + seedFn(i + 100) * 0.4;
    const phi = (seedFn(i + 200) - 0.5) * 0.6 + 0.1; // mostly equatorial, slight tilt up
    const r = 0.21 + seedFn(i + 300) * 0.02;
    dummy.position.set(
      Math.cos(angle) * Math.cos(phi) * r,
      Math.sin(phi) * r + 0.02,
      Math.sin(angle) * Math.cos(phi) * r
    );
    dummy.lookAt(0, dummy.position.y, 0);
    dummy.rotateX(Math.PI); // point cone outward
    dummy.scale.setScalar(0.7 + seedFn(i + 400) * 0.4);
    dummy.updateMatrix();
    innerMesh.setMatrixAt(i, dummy.matrix);
  }
  innerMesh.instanceMatrix.needsUpdate = true;

  // Outer pass: longer, larger, slightly fanned.
  for (let i = 0; i < tuftCount; i += 1) {
    const t = i / tuftCount;
    const angle = t * TAU + seedFn(i + 500) * 0.6;
    const phi = (seedFn(i + 600) - 0.5) * 0.7 + 0.05;
    const r = 0.27 + seedFn(i + 700) * 0.04;
    dummy.position.set(
      Math.cos(angle) * Math.cos(phi) * r,
      Math.sin(phi) * r + 0.02,
      Math.sin(angle) * Math.cos(phi) * r
    );
    dummy.lookAt(0, dummy.position.y, 0);
    dummy.rotateX(Math.PI);
    dummy.scale.setScalar(1.0 + seedFn(i + 800) * 0.7);
    dummy.updateMatrix();
    outerMesh.setMatrixAt(i, dummy.matrix);
  }
  outerMesh.instanceMatrix.needsUpdate = true;

  group.add(innerMesh, outerMesh);

  return {
    group,
    materials: [inner, outer],
    geometries: [tuftGeom],
  };
}
