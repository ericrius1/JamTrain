import type * as THREE from 'three/webgpu';
import type { ParticleKind } from './EnergyEmitter';

export type ArchetypeId = 'drumDrum' | 'melodyMelody' | 'drumMelody';

/**
 * Per-archetype shape sampler. Given a normalized index 0..1 inside the emit
 * burst, continuous build progress where 1 is roughly the first full 30s form,
 * and a per-particle seed, returns a target world-space offset relative to the
 * sculptor center. Particles are pulled toward this point instead of a single
 * attractor center.
 */
export type ShapeSampler = (
  particleNorm: number,
  roundProgress: number,
  seed: number,
  kind: ParticleKind,
  out: THREE.Vector3,
) => THREE.Vector3;

/**
 * Per-archetype directional flow bias added to a particle's initial velocity
 * at emit time. Returns a vec3 in world units.
 */
export type FlowSampler = (
  position: THREE.Vector3,
  roundProgress: number,
  out: THREE.Vector3,
) => THREE.Vector3;

export type Archetype = {
  id: ArchetypeId;
  shape: ShapeSampler;
  flow: FlowSampler;
  pair: { a: ParticleKind; b: ParticleKind };
};

export function pickArchetype(localKind: ParticleKind, partnerKind: ParticleKind): ArchetypeId {
  if (localKind === 'drum' && partnerKind === 'drum') return 'drumDrum';
  if (localKind === 'starlace' && partnerKind === 'starlace') return 'melodyMelody';
  return 'drumMelody';
}
