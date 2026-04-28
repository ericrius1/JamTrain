import type * as THREE from 'three/webgpu';

function fract(v: number): number {
  return v - Math.floor(v);
}

function hash(seed: number, salt: number): number {
  return fract(Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453123);
}

function signed(seed: number, salt: number): number {
  return hash(seed, salt) * 2 - 1;
}

function clampSoft(v: number, scale = 2.8): number {
  return Math.tanh(v / scale) * scale;
}

/**
 * Clifford / De Jong style map. Good for transparent folded ribbons and
 * shell-like knots.
 */
export function sampleClifford(seed: number, steps: number, out: THREE.Vector3): THREE.Vector3 {
  const a = -1.62 + signed(seed, 1) * 0.28;
  const b = 1.72 + signed(seed, 2) * 0.22;
  const c = 0.74 + signed(seed, 3) * 0.20;
  const d = -1.28 + signed(seed, 4) * 0.26;
  let x = signed(seed, 5) * 1.2;
  let y = signed(seed, 6) * 1.2;
  const count = Math.max(4, Math.floor(steps));

  for (let i = 0; i < count; i += 1) {
    const nx = Math.sin(a * y) + c * Math.cos(a * x);
    const ny = Math.sin(b * x) + d * Math.cos(b * y);
    x = nx;
    y = ny;
  }

  out.set(
    x * 0.22,
    Math.sin((x - y) * 1.35 + seed * 5.1) * 0.18,
    y * 0.22,
  );
  return out;
}

/**
 * Aizawa-like flow. Produces bounded nested shells with a tunneled center.
 */
export function sampleAizawa(seed: number, steps: number, out: THREE.Vector3): THREE.Vector3 {
  const a = 0.95;
  const b = 0.7;
  const c = 0.6;
  const d = 3.5 + signed(seed, 1) * 0.22;
  const e = 0.25;
  const f = 0.1;
  let x = 0.1 + signed(seed, 2) * 0.55;
  let y = signed(seed, 3) * 0.55;
  let z = 0.15 + signed(seed, 4) * 0.45;
  const count = Math.max(8, Math.floor(steps));

  for (let i = 0; i < count; i += 1) {
    const r2 = x * x + y * y;
    const dx = (z - b) * x - d * y;
    const dy = d * x + (z - b) * y;
    const dz = c + a * z - (z * z * z) / 3 - r2 * (1 + e * z) + f * z * x * x * x;
    x = clampSoft(x + dx * 0.012);
    y = clampSoft(y + dy * 0.012);
    z = clampSoft(z + dz * 0.012);
  }

  out.set(x * 0.34, (z - 0.6) * 0.36, y * 0.34);
  return out;
}

/**
 * Halvorsen-like flow. Messier and more tangled; useful for plasma spaghetti.
 */
export function sampleHalvorsen(seed: number, steps: number, out: THREE.Vector3): THREE.Vector3 {
  const a = 1.42 + signed(seed, 1) * 0.08;
  let x = signed(seed, 2) * 0.85;
  let y = signed(seed, 3) * 0.85;
  let z = signed(seed, 4) * 0.85;
  const count = Math.max(10, Math.floor(steps));

  for (let i = 0; i < count; i += 1) {
    const dx = -a * x - 4 * y - 4 * z - y * y;
    const dy = -a * y - 4 * z - 4 * x - z * z;
    const dz = -a * z - 4 * x - 4 * y - x * x;
    x = clampSoft(x + dx * 0.0045, 3.4);
    y = clampSoft(y + dy * 0.0045, 3.4);
    z = clampSoft(z + dz * 0.0045, 3.4);
  }

  out.set(x * 0.12, y * 0.12, z * 0.12);
  return out;
}
