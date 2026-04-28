import type { Archetype } from '../archetypeShared';

const TAU = Math.PI * 2;

/**
 * Halo'd column — a central rising column from the drum stream surrounded by
 * an orbiting halo of starlace streaks. Duet-bonus moments leave bright knots
 * along the column.
 */
export const drumMelody: Archetype = {
  id: 'drumMelody',
  pair: { a: 'drum', b: 'starlace' },
  shape: (n, t, seed, kind, out) => {
    if (kind === 'drum') {
      const height = 1.4 * t;
      const y = n * height;
      const r = 0.05 + 0.04 * Math.sin(n * 24 + seed * 5);
      const angle = (n + seed * 0.21) * TAU * 6;
      out.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
    } else {
      const angle = (n + seed * 0.17) * TAU * 3;
      const haloRadius = 0.32 + 0.05 * Math.sin(seed * 9);
      const elev = (n - 0.5) * 1.0 * t;
      out.set(Math.cos(angle) * haloRadius, 0.6 * t + elev, Math.sin(angle) * haloRadius);
    }
    return out;
  },
  flow: (p, _t, out) => {
    const r2 = p.x * p.x + p.z * p.z;
    if (r2 < 0.04) {
      out.set(0, 0.5, 0);
    } else {
      out.set(-p.z * 0.6, 0.1, p.x * 0.6);
    }
    return out;
  },
};
