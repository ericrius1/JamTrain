import type { Archetype } from '../archetypeShared';
import { sampleHalvorsen } from '../attractorFields';

const TAU = Math.PI * 2;

/**
 * Branching cadence tree — drum hits stack as ridged growth rings with
 * off-axis branches rather than a centered cylinder.
 */
export const drumDrum: Archetype = {
  id: 'drumDrum',
  pair: { a: 'drum', b: 'drum' },
  shape: (n, t, seed, _kind, out) => {
    const build = Math.min(1, Math.max(0, t));
    const layer = t <= 1 ? build : (t * 0.73 + seed * 0.11) % 1;
    const branch = Math.floor(n * 7);
    const local = (n * 7) % 1;
    sampleHalvorsen(seed + branch * 0.29 + layer * 1.9, 28 + local * 90 + layer * 36, out);
    const trunkLean = Math.sin(layer * TAU * 1.45 + seed * 3.1) * 0.14;
    const y = -0.48 + layer * 1.15 + Math.sin(local * Math.PI) * 0.07 + out.y * 0.62;
    const angle = branch * TAU / 7 + layer * TAU * 1.1 + Math.sin(layer * TAU * 3) * 0.24;
    const forkGate = Math.pow(Math.sin(layer * Math.PI), 0.55);
    const reach = (0.035 + forkGate * (0.10 + build * 0.24)) * Math.pow(local, 0.9);
    const ridge = Math.sin(layer * TAU * 8 + branch * 1.7 + local * 3.2) * 0.035;
    out.set(
      out.x * 0.88 + trunkLean + Math.cos(angle) * (reach + ridge),
      y,
      out.z * 0.88 + Math.sin(layer * TAU * 0.8 + seed) * 0.08 + Math.sin(angle) * (reach * 0.82 + ridge),
    );
    return out;
  },
  flow: (_p, _t, out) => {
    out.set(0, 0.68, 0);
    return out;
  },
};
