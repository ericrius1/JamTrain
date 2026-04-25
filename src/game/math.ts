import * as THREE from 'three/webgpu';
import type { Vec3Data } from './types';

export const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));

export const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

export const damp = (from: number, to: number, lambda: number, delta: number): number => {
  return lerp(from, to, 1 - Math.exp(-lambda * delta));
};

export const vec = (x = 0, y = 0, z = 0): Vec3Data => ({ x, y, z });

export const cloneVec = (value: Vec3Data): Vec3Data => ({ x: value.x, y: value.y, z: value.z });

export const lerpVec = (from: Vec3Data, to: Vec3Data, amount: number): Vec3Data => ({
  x: lerp(from.x, to.x, amount),
  y: lerp(from.y, to.y, amount),
  z: lerp(from.z, to.z, amount),
});

export const distance = (a: Vec3Data, b: Vec3Data): number => {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = a.z - b.z;
  return Math.sqrt(x * x + y * y + z * z);
};

export const toThree = (value: Vec3Data, target = new THREE.Vector3()): THREE.Vector3 => {
  target.set(value.x, value.y, value.z);
  return target;
};

export const fromThree = (value: THREE.Vector3): Vec3Data => ({ x: value.x, y: value.y, z: value.z });

export const hash = (value: number): number => {
  const x = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
