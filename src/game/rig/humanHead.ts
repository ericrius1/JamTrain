import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeEyeMaterial, makeSkinMaterial } from '../creatureShading';

export type HumanHeadHandles = {
  group: THREE.Group;
  /** Materials owned by the head, returned so the rig can dispose them. */
  materials: THREE.Material[];
  /** Geometries owned, for disposal. */
  geometries: THREE.BufferGeometry[];
};

export function buildHumanHead(lighting: CreatureLighting): HumanHeadHandles {
  const group = new THREE.Group();
  const skin = makeSkinMaterial(lighting);
  const eye = makeEyeMaterial(lighting);

  // Cranium: an egg shape — sphere scaled taller than wide, slightly fuller at the back.
  const craniumGeom = new THREE.SphereGeometry(0.22, 32, 22);
  const cranium = new THREE.Mesh(craniumGeom, skin);
  cranium.scale.set(0.92, 1.10, 0.95);
  cranium.position.set(0, 0.02, 0);
  group.add(cranium);

  // Jaw mass: smaller squashed sphere blended at the bottom-front of cranium.
  const jawGeom = new THREE.SphereGeometry(0.14, 24, 16);
  const jaw = new THREE.Mesh(jawGeom, skin);
  jaw.scale.set(0.82, 0.65, 0.82);
  jaw.position.set(0, -0.10, -0.02);
  group.add(jaw);

  // Brow ridge: a thin torus arc above the eye line.
  const browGeom = new THREE.TorusGeometry(0.12, 0.012, 8, 24, Math.PI);
  const brow = new THREE.Mesh(browGeom, skin);
  brow.rotation.set(Math.PI / 2, 0, 0);
  brow.position.set(0, 0.04, -0.18);
  group.add(brow);

  // Nose ridge: tiny stretched cone from brow center down.
  const noseGeom = new THREE.ConeGeometry(0.018, 0.075, 10);
  const nose = new THREE.Mesh(noseGeom, skin);
  nose.position.set(0, -0.01, -0.215);
  nose.rotation.set(Math.PI, 0, 0);
  group.add(nose);

  // Eye sockets: tiny inset spheres slightly behind the cranium front face — they
  // create shadow recesses without needing any normal-map work.
  const socketGeom = new THREE.SphereGeometry(0.04, 16, 12);
  const leftSocket = new THREE.Mesh(socketGeom, skin);
  const rightSocket = new THREE.Mesh(socketGeom, skin);
  leftSocket.scale.set(1.0, 0.7, 0.6);
  rightSocket.scale.copy(leftSocket.scale);
  leftSocket.position.set(-0.07, 0.02, -0.18);
  rightSocket.position.set(0.07, 0.02, -0.18);
  group.add(leftSocket, rightSocket);

  // Eyeballs.
  const eyeGeom = new THREE.SphereGeometry(0.026, 18, 14);
  const leftEye = new THREE.Mesh(eyeGeom, eye);
  const rightEye = new THREE.Mesh(eyeGeom, eye);
  leftEye.position.set(-0.07, 0.025, -0.205);
  rightEye.position.set(0.07, 0.025, -0.205);
  group.add(leftEye, rightEye);

  // Soft mouth: a thin curved arc made from a small torus segment.
  const mouthGeom = new THREE.TorusGeometry(0.05, 0.006, 6, 14, Math.PI * 0.6);
  const mouth = new THREE.Mesh(mouthGeom, eye);
  mouth.rotation.set(0, 0, Math.PI);
  mouth.position.set(0, -0.07, -0.20);
  group.add(mouth);

  return {
    group,
    materials: [skin, eye],
    geometries: [craniumGeom, jawGeom, browGeom, noseGeom, socketGeom, eyeGeom, mouthGeom],
  };
}
