import type { Archetype } from '../archetypeShared';
import { sampleAizawa, sampleHalvorsen } from '../attractorFields';

const TAU = Math.PI * 2;

/**
 * Halo lattice — drum sparks build amber nodal ribs while Starlace streaks
 * braid through tilted rose-knot loops. Duet-bonus moments leave bright knots
 * where the two fields cross.
 */
export const drumMelody: Archetype = {
  id: 'drumMelody',
  pair: { a: 'drum', b: 'starlace' },
  shape: (n, t, seed, kind, out) => {
    const build = Math.min(1, Math.max(0, t));
    const layer = t <= 1 ? build : (t * 0.61 + seed * 0.09) % 1;
    if (kind === 'drum') {
      const rib = Math.floor(n * 6);
      const local = (n * 6) % 1;
      sampleHalvorsen(seed + rib * 0.37 + layer * 1.3, 32 + local * 70 + layer * 28, out);
      const y = -0.46 + layer * 1.10 + Math.sin(local * Math.PI) * 0.07 + out.y * 0.55;
      const ribAngle = rib * TAU / 6 + layer * TAU * 1.65 + seed * 0.32;
      const lobe = Math.sin(layer * TAU * 3 + rib * 1.4) * 0.065;
      const reach = (0.06 + build * 0.21 + lobe) * Math.pow(local, 0.72);
      const spine = 0.11 + 0.07 * Math.sin(layer * TAU * 2.2 + seed * 5);
      out.set(
        out.x * 0.66 + Math.cos(ribAngle) * (spine + reach),
        y,
        out.z * 0.66 + Math.sin(ribAngle) * (spine * 0.72 + reach),
      );
    } else {
      const strand = Math.floor(n * 5);
      const local = (n * 5) % 1;
      sampleAizawa(seed + strand * 0.41 + layer * 1.7, 44 + local * 80 + layer * 34, out);
      const u = layer * TAU * 2.4 + strand * TAU / 5 + seed * 0.38;
      const rose = 0.24 + build * 0.22 + Math.sin(u * 3 + seed * 4) * 0.05;
      const x = out.x * 0.78 + Math.sin(u) * rose + Math.sin(u * 2.0) * 0.12;
      const y = out.y * 0.78 - 0.32 + layer * 1.04 + Math.cos(u * 1.5 + local * TAU) * 0.13;
      const z = out.z * 0.78 + Math.cos(u * 0.82) * rose * 0.62 + Math.sin(u * 2.4 + local * TAU) * 0.09;
      out.set(x, y, z);
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
