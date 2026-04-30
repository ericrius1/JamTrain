import type * as THREE from 'three/webgpu';

export type ParticleKind = 'orb' | 'starlace';

/**
 * Discrete emit request handed from an instrument to the sculptor each frame.
 * Position is world-space; color is sRGB 0..1.
 */
export type EmitRequest = {
  kind: ParticleKind;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  color: { r: number; g: number; b: number };
  count: number;
  speed: number;
};

export interface EnergySink {
  emit(req: EmitRequest): void;
  // Primitive-args variant that lets callers pass scratch values without
  // allocating an EmitRequest, Vector3 clones, or color object literals each
  // frame. The sink copies the values into its own pool.
  emitFast(
    kind: ParticleKind,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    r: number, g: number, b: number,
    count: number,
    speed: number,
  ): void;
  readonly center: THREE.Vector3;
}
