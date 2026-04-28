import type { Archetype } from '../archetypeShared';
import { sampleAizawa, sampleClifford } from '../attractorFields';

const TAU = Math.PI * 2;

/**
 * Woven lissajous nest — melodic particles trace nested knots and ribbons
 * that open sideways instead of stacking vertically.
 */
export const melodyMelody: Archetype = {
  id: 'melodyMelody',
  pair: { a: 'starlace', b: 'starlace' },
  shape: (n, t, seed, kind, out) => {
    const build = Math.min(1, Math.max(0, t));
    const travel = t <= 1 ? build : (t * 0.47 + seed * 0.13) % 1;
    const thread = Math.floor(n * 6);
    const local = (n * 6) % 1;
    if (thread % 2 === 0) {
      sampleClifford(seed + thread * 0.31 + travel * 1.2, 24 + local * 82 + travel * 42, out);
    } else {
      sampleAizawa(seed + thread * 0.23 + travel * 1.5, 34 + local * 70 + travel * 30, out);
    }
    const u = travel * TAU * 2.15 + thread * TAU / 6 + seed * 0.42;
    const w = 0.34 + build * 0.38;
    const x = out.x * 0.86 + Math.sin(u) * w + Math.sin(u * 2.0 + local) * 0.14;
    const phase = u * 1.65 + (kind === 'starlace' ? 0 : Math.PI);
    const r = 0.12 + build * 0.15 + 0.04 * Math.sin(seed * 11.4 + travel * TAU * 2);
    const y = out.y * 0.82 + Math.sin(phase) * r + Math.sin(u * 0.7 + local * TAU) * 0.13;
    const z = out.z * 0.86 + Math.cos(u * 1.18) * r + Math.sin(u * 2.7 + local * TAU) * 0.12;
    out.set(x, y, z);
    return out;
  },
  flow: (p, _t, out) => {
    out.set(-p.z * 0.4, 0, p.x * 0.4);
    return out;
  },
};
