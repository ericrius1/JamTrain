import type { ParticleKind } from './EnergyEmitter';

export type ArchetypeId = 'drumDrum' | 'melodyMelody' | 'drumMelody';

export function pickArchetype(localKind: ParticleKind, partnerKind: ParticleKind): ArchetypeId {
  if (localKind === 'drum' && partnerKind === 'drum') return 'drumDrum';
  if (localKind === 'starlace' && partnerKind === 'starlace') return 'melodyMelody';
  return 'drumMelody';
}
