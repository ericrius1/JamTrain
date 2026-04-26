import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeClothMaterial, makeSkinMaterial } from '../creatureShading';

export type HumanBodyHandles = {
  group: THREE.Group;
  /** Material applied to upper-arm cloth — exported so the skeleton can use it. */
  clothMaterial: THREE.MeshBasicNodeMaterial;
  /** Material applied to forearms / palms / fingers. */
  skinMaterial: THREE.MeshBasicNodeMaterial;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildHumanBody(lighting: CreatureLighting, seatColor: number): HumanBodyHandles {
  const group = new THREE.Group();
  const cloth = makeClothMaterial(lighting, seatColor);
  const skin = makeSkinMaterial(lighting);

  // Lathed torso silhouette — points define a half-profile from waist (bottom)
  // to neck (top). Lathe revolves it around Y.
  const torsoProfile = [
    new THREE.Vector2(0.30, -0.30), // hip flare
    new THREE.Vector2(0.26, -0.16),
    new THREE.Vector2(0.22, -0.02), // waist
    new THREE.Vector2(0.27,  0.10),
    new THREE.Vector2(0.30,  0.20), // chest
    new THREE.Vector2(0.26,  0.30),
    new THREE.Vector2(0.18,  0.36), // neck base
    new THREE.Vector2(0.10,  0.40), // neck top
  ];
  const torsoGeom = new THREE.LatheGeometry(torsoProfile, 28);
  torsoGeom.computeVertexNormals();
  const torso = new THREE.Mesh(torsoGeom, cloth);
  group.add(torso);

  // Tunic skirt — a slightly larger lathed flare hanging from the hip.
  const tunicProfile = [
    new THREE.Vector2(0.40, -0.42), // skirt hem
    new THREE.Vector2(0.34, -0.32),
    new THREE.Vector2(0.30, -0.22),
  ];
  const tunicGeom = new THREE.LatheGeometry(tunicProfile, 24);
  tunicGeom.computeVertexNormals();
  const tunic = new THREE.Mesh(tunicGeom, cloth);
  group.add(tunic);

  // Soft shoulder spheres to bridge cloth to upper-arm sleeves.
  const shoulderGeom = new THREE.SphereGeometry(0.085, 16, 12);
  const leftShoulder = new THREE.Mesh(shoulderGeom, cloth);
  const rightShoulder = new THREE.Mesh(shoulderGeom, cloth);
  leftShoulder.position.set(-0.28, 0.30, -0.03);
  rightShoulder.position.set(0.28, 0.30, -0.03);
  leftShoulder.scale.set(1.0, 0.85, 1.0);
  rightShoulder.scale.copy(leftShoulder.scale);
  group.add(leftShoulder, rightShoulder);

  // Soft neck collar — small skin-toned cylinder peek.
  const neckGeom = new THREE.CylinderGeometry(0.085, 0.10, 0.10, 16);
  const neck = new THREE.Mesh(neckGeom, skin);
  neck.position.set(0, 0.42, -0.02);
  group.add(neck);

  return {
    group,
    clothMaterial: cloth,
    skinMaterial: skin,
    materials: [cloth, skin],
    geometries: [torsoGeom, tunicGeom, shoulderGeom, neckGeom],
  };
}
