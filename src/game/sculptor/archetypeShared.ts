import type { ParticleKind } from './EnergyEmitter';

export type ArchetypeId = 'orbOrb' | 'melodyMelody' | 'orbMelody';

export function pickArchetype(localKind: ParticleKind, partnerKind: ParticleKind): ArchetypeId {
  if (localKind === 'orb' && partnerKind === 'orb') return 'orbOrb';
  if (localKind === 'starlace' && partnerKind === 'starlace') return 'melodyMelody';
  return 'orbMelody';
}
