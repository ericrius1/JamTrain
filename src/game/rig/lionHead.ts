import * as THREE from 'three/webgpu';
import { makeEyeMaterial, makeFurMaterial } from '../creatureShading';

export type LionHeadHandles = {
  group: THREE.Group;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildLionHead(): LionHeadHandles {
  const group = new THREE.Group();
  const fur = makeFurMaterial();
  const eye = makeEyeMaterial();
  // Cheap dark material for nose pad + ear inner — solid color, no lighting model.
  const darkPadMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color('#1f1612') });

  // Domed skull — sphere scaled slightly wider than tall to suggest a feline silhouette.
  const skullGeom = new THREE.SphereGeometry(0.21, 32, 22);
  const skull = new THREE.Mesh(skullGeom, fur);
  skull.scale.set(1.05, 0.95, 1.0);
  skull.position.set(0, 0.02, 0);
  group.add(skull);

  // Snout block — extruded forward and tapered to the nose pad.
  const snoutGeom = new THREE.CylinderGeometry(0.085, 0.07, 0.16, 18);
  const snout = new THREE.Mesh(snoutGeom, fur);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, -0.04, -0.20);
  group.add(snout);

  // Nose pad — small dark spheroid at the tip.
  const nosePadGeom = new THREE.SphereGeometry(0.028, 14, 10);
  const nosePad = new THREE.Mesh(nosePadGeom, darkPadMat);
  nosePad.scale.set(1.1, 0.85, 0.9);
  nosePad.position.set(0, -0.03, -0.29);
  group.add(nosePad);

  // Upper-lip curve — a thin torus arc under the nose.
  const lipGeom = new THREE.TorusGeometry(0.06, 0.012, 8, 18, Math.PI);
  const lip = new THREE.Mesh(lipGeom, fur);
  lip.rotation.set(Math.PI / 2, 0, Math.PI);
  lip.position.set(0, -0.10, -0.25);
  group.add(lip);

  // Cheek tufts — a few small instanced cones, jittered.
  const cheekGeom = new THREE.ConeGeometry(0.014, 0.05, 8);
  const cheekCount = 6;
  const cheekMesh = new THREE.InstancedMesh(cheekGeom, fur, cheekCount * 2);
  let idx = 0;
  const dummy = new THREE.Object3D();
  const jitter = (n: number) => {
    const v = Math.sin(n * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let side = 0; side < 2; side += 1) {
    const sx = side === 0 ? -1 : 1;
    for (let i = 0; i < cheekCount; i += 1) {
      const seed = (i + 1) * (sx + 2);
      const j1 = jitter(seed);
      const j2 = jitter(seed + 0.7);
      dummy.position.set(sx * (0.10 + j1 * 0.03), -0.07 + j2 * 0.05, -0.18 - i * 0.005);
      dummy.rotation.set(0, 0, sx * (-0.4 - j1 * 0.3));
      dummy.scale.setScalar(0.7 + j2 * 0.6);
      dummy.updateMatrix();
      cheekMesh.setMatrixAt(idx++, dummy.matrix);
    }
  }
  cheekMesh.instanceMatrix.needsUpdate = true;
  group.add(cheekMesh);

  // Pointed ears — outer cone + small inner hollow cone for shadow recess.
  const outerEarGeom = new THREE.ConeGeometry(0.06, 0.10, 14);
  const innerEarGeom = new THREE.ConeGeometry(0.035, 0.07, 12);
  for (const sx of [-1, 1]) {
    const outer = new THREE.Mesh(outerEarGeom, fur);
    outer.position.set(sx * 0.13, 0.18, -0.04);
    outer.rotation.set(-0.2, 0, sx * 0.18);
    const inner = new THREE.Mesh(innerEarGeom, darkPadMat);
    inner.position.set(sx * 0.13, 0.17, -0.045);
    inner.rotation.set(-0.18, 0, sx * 0.18);
    group.add(outer, inner);
  }

  // Eye sockets + eyeballs — slightly closer-set than human, lower on the head.
  const socketGeom = new THREE.SphereGeometry(0.04, 16, 12);
  for (const sx of [-1, 1]) {
    const socket = new THREE.Mesh(socketGeom, fur);
    socket.scale.set(0.95, 0.7, 0.6);
    socket.position.set(sx * 0.06, 0.01, -0.18);
    group.add(socket);
  }
  const eyeGeom = new THREE.SphereGeometry(0.024, 18, 14);
  for (const sx of [-1, 1]) {
    const eyeMesh = new THREE.Mesh(eyeGeom, eye);
    eyeMesh.position.set(sx * 0.06, 0.013, -0.20);
    group.add(eyeMesh);
  }

  return {
    group,
    materials: [fur, eye, darkPadMat],
    geometries: [
      skullGeom, snoutGeom, nosePadGeom, lipGeom, cheekGeom,
      outerEarGeom, innerEarGeom, socketGeom, eyeGeom,
    ],
  };
}
