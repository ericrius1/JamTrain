import * as THREE from 'three/webgpu';
import { makeFurMaterial } from '../creatureShading';

export type LionBodyHandles = {
  group: THREE.Group;
  /** Material applied to upper-arm sleeves — fur, not seat-tinted cloth. */
  clothMaterial: THREE.MeshBasicNodeMaterial;
  /** Material applied to forearms / palms / fingers — same fur material. */
  skinMaterial: THREE.MeshBasicNodeMaterial;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildLionBody(): LionBodyHandles {
  const group = new THREE.Group();
  const fur = makeFurMaterial();

  // Stockier than human torso — wider chest, less waist taper.
  const torsoProfile = [
    new THREE.Vector2(0.34, -0.32),
    new THREE.Vector2(0.30, -0.18),
    new THREE.Vector2(0.27, -0.04), // mild waist
    new THREE.Vector2(0.32,  0.10),
    new THREE.Vector2(0.34,  0.20),
    new THREE.Vector2(0.28,  0.30),
    new THREE.Vector2(0.18,  0.36),
    new THREE.Vector2(0.10,  0.40),
  ];
  const torsoGeom = new THREE.LatheGeometry(torsoProfile, 28);
  torsoGeom.computeVertexNormals();
  const torso = new THREE.Mesh(torsoGeom, fur);
  group.add(torso);

  // Belly fur — small softening sphere at the lower torso front.
  const bellyGeom = new THREE.SphereGeometry(0.16, 18, 14);
  const belly = new THREE.Mesh(bellyGeom, fur);
  belly.scale.set(1.05, 0.7, 0.6);
  belly.position.set(0, -0.18, -0.10);
  group.add(belly);

  // Shoulder spheres.
  const shoulderGeom = new THREE.SphereGeometry(0.090, 16, 12);
  for (const sx of [-1, 1]) {
    const sh = new THREE.Mesh(shoulderGeom, fur);
    sh.position.set(sx * 0.28, 0.30, -0.03);
    sh.scale.set(1.0, 0.85, 1.0);
    group.add(sh);
  }

  return {
    group,
    clothMaterial: fur,
    skinMaterial: fur,
    materials: [fur],
    geometries: [torsoGeom, bellyGeom, shoulderGeom],
  };
}
