import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeFurMaterial, makeManeMaterial } from '../creatureShading';

export type LionTailHandles = {
  group: THREE.Group;
  /** Drive sway: pass elapsed seconds. */
  update(elapsed: number): void;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildLionTail(lighting: CreatureLighting, seatColor: number): LionTailHandles {
  const group = new THREE.Group();
  const fur = makeFurMaterial(lighting);
  const tuftMat = makeManeMaterial(lighting, seatColor);

  // Tail curve — starts at the lower back, sweeps down and slightly to one side, then up.
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.0, 0.05),
    new THREE.Vector3(0.06, -0.05, 0.20),
    new THREE.Vector3(0.10, -0.12, 0.32),
    new THREE.Vector3(0.06, -0.20, 0.40),
  ]);
  const tubeGeom = new THREE.TubeGeometry(tailCurve, 32, 0.015, 8, false);
  const tube = new THREE.Mesh(tubeGeom, fur);
  group.add(tube);

  // Tail tuft — a small ico-sphere with mane material.
  const tuftGeom = new THREE.IcosahedronGeometry(0.028, 1);
  const tuft = new THREE.Mesh(tuftGeom, tuftMat);
  tuft.position.set(0.06, -0.20, 0.40);
  group.add(tuft);

  // Anchor on the lower back of the body.
  group.position.set(0, -0.10, 0.12);

  const update = (elapsed: number) => {
    group.rotation.y = Math.sin(elapsed * 1.4) * 0.18;
    group.rotation.z = Math.sin(elapsed * 0.9 + 1.7) * 0.10;
  };

  return {
    group,
    update,
    materials: [fur, tuftMat],
    geometries: [tubeGeom, tuftGeom],
  };
}
