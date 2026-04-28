import type * as THREE from 'three/webgpu';

export type ParticleKind = 'drum' | 'starlace';

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
  intensity: number;
  speed: number;
};

export interface EnergySink {
  emit(req: EmitRequest): void;
  readonly center: THREE.Vector3;
}
