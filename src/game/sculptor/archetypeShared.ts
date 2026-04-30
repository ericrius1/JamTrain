import type { ParticleKind } from './EnergyEmitter';

export type ArchetypeId = 'oarOar' | 'melodyMelody' | 'oarMelody';

export function pickArchetype(localKind: ParticleKind, partnerKind: ParticleKind): ArchetypeId {
  if (localKind === 'oar' && partnerKind === 'oar') return 'oarOar';
  if (localKind === 'starlace' && partnerKind === 'starlace') return 'melodyMelody';
  return 'oarMelody';
}
