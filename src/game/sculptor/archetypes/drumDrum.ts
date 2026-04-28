import type { Archetype } from '../archetypeShared';

const TAU = Math.PI * 2;

/**
 * Stalagmite tower — vertical staccato structure, bands of dense particles
 * where beats clustered, ascending over the round.
 */
export const drumDrum: Archetype = {
  id: 'drumDrum',
  pair: { a: 'drum', b: 'drum' },
  shape: (n, t, seed, _kind, out) => {
    const height = 1.2 * t;
    const y = n * height;
    const banding = 0.05 * Math.sin(n * 18 + seed * 7.3);
    const radius = (0.16 + banding) * (1 - n * 0.55);
    const angle = (n + seed * 0.13) * TAU * 4;
    out.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    return out;
  },
  flow: (_p, _t, out) => {
    out.set(0, 0.55, 0);
    return out;
  },
};
