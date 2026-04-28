import type { Archetype } from '../archetypeShared';

const TAU = Math.PI * 2;

/**
 * Woven braid — two intertwining helices that span horizontally and grow
 * outward over the round. Pitch height of plucks pushes the threads up/down.
 */
export const melodyMelody: Archetype = {
  id: 'melodyMelody',
  pair: { a: 'starlace', b: 'starlace' },
  shape: (n, t, seed, kind, out) => {
    const w = 0.55 * (0.4 + 0.6 * t);
    const x = (n - 0.5) * 2 * w;
    const phase = n * TAU * 3 + (kind === 'starlace' ? 0 : Math.PI);
    const r = 0.16 + 0.04 * Math.sin(seed * 11.4);
    out.set(x, Math.sin(phase) * r, Math.cos(phase) * r);
    return out;
  },
  flow: (p, _t, out) => {
    out.set(-p.z * 0.4, 0, p.x * 0.4);
    return out;
  },
};
