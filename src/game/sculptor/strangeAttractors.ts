import { vec3 } from 'three/tsl';

/**
 * TSL flow fields for canonical strange attractors. Each function takes a
 * vec3 position node + parameter nodes and returns a vec3 velocity node
 * (dp/dt). The compute pass scales by `dt` when integrating, so these
 * return raw derivatives.
 *
 * Working ranges (so positions stay finite when scaled into the sculpture):
 *   Thomas:    a=0.19,  position ~ [-4, 4],   scale to world ~0.10
 *   Lorenz:    σ=10, ρ=28, β=8/3, position ~ [-30, 30], scale ~0.012
 *   Aizawa:    a=0.95, b=0.7, c=0.6, d=3.5, e=0.25, f=0.1, position ~ [-1.7, 1.7], scale ~0.34
 *   Halvorsen: a=1.4, position ~ [-7, 7], scale ~0.06
 *
 * Plain functions (no `Fn`) so each call inlines the math; for our scale
 * (~24k particles, one integrate pass) the deduplication isn't worth the
 * generic-argument typing friction.
 */

// Loose node type — TSL chain methods (.add, .sub, .mul, .sin, etc.) exist on
// all numeric nodes, and TSL does its own type resolution at shader-build
// time. We don't try to thread vec3/float distinctions through TS for these
// inner helpers; the call site keeps the types honest.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

// Thomas — gentle 3D wandering "yarn ball." Pleasant, sparse, never collapses.
//   dx = -a*x + sin(y)
//   dy = -a*y + sin(z)
//   dz = -a*z + sin(x)
export function thomasFlow(p: N, a: N): N {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  return vec3(
    a.negate().mul(x).add(y.sin()),
    a.negate().mul(y).add(z.sin()),
    a.negate().mul(z).add(x.sin()),
  );
}

// Lorenz — iconic butterfly. Two-loop chaotic orbit.
//   dx = σ * (y - x)
//   dy = x * (ρ - z) - y
//   dz = x * y - β * z
export function lorenzFlow(p: N, sigma: N, rho: N, beta: N): N {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  return vec3(
    sigma.mul(y.sub(x)),
    x.mul(rho.sub(z)).sub(y),
    x.mul(y).sub(beta.mul(z)),
  );
}

// Aizawa — nested toroidal shells with a tunneled center. Visually structured.
//   dx = (z - b) * x - d * y
//   dy = d * x + (z - b) * y
//   dz = c + a*z - z^3/3 - (x^2 + y^2)*(1 + e*z) + f*z*x^3
export function aizawaFlow(p: N, a: N, b: N, c: N, d: N, e: N, f: N): N {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  const r2 = x.mul(x).add(y.mul(y));
  return vec3(
    z.sub(b).mul(x).sub(d.mul(y)),
    d.mul(x).add(z.sub(b).mul(y)),
    c
      .add(a.mul(z))
      .sub(z.mul(z).mul(z).div(3))
      .sub(r2.mul(e.mul(z).add(1)))
      .add(f.mul(z).mul(x).mul(x).mul(x)),
  );
}

// Halvorsen — tangled plasma; symmetric in x/y/z.
//   dx = -a*x - 4y - 4z - y^2
//   dy = -a*y - 4z - 4x - z^2
//   dz = -a*z - 4x - 4y - x^2
export function halvorsenFlow(p: N, a: N): N {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  return vec3(
    a.negate().mul(x).sub(y.mul(4)).sub(z.mul(4)).sub(y.mul(y)),
    a.negate().mul(y).sub(z.mul(4)).sub(x.mul(4)).sub(z.mul(z)),
    a.negate().mul(z).sub(x.mul(4)).sub(y.mul(4)).sub(x.mul(x)),
  );
}

// Rössler — single-band spiral that breaks loose into a stretched fold; the
// canonical "simplest" 3D chaotic system.
//   dx = -y - z
//   dy = x + a*y
//   dz = b + z*(x - c)
export function rosslerFlow(p: N, a: N, b: N, c: N): N {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  return vec3(
    y.negate().sub(z),
    x.add(a.mul(y)),
    b.add(z.mul(x.sub(c))),
  );
}

// Dadras — woven asymmetric ribbons; quasi-period that drifts through a
// large bowl-shaped region.
//   dx = y - p*x + o*y*z
//   dy = r*y - x*z + z
//   dz = c*x*y - e*z
export function dadrasFlow(p: N, pp: N, o: N, r: N, c: N, e: N): N {
  const x = p.x;
  const y = p.y;
  const z = p.z;
  return vec3(
    y.sub(pp.mul(x)).add(o.mul(y).mul(z)),
    r.mul(y).sub(x.mul(z)).add(z),
    c.mul(x).mul(y).sub(e.mul(z)),
  );
}

export type AttractorKind = 'thomas' | 'lorenz' | 'aizawa' | 'halvorsen' | 'rossler' | 'dadras';

export type AttractorPreset = {
  kind: AttractorKind;
  worldScale: number;
  dt: number;
};

export const ATTRACTOR_PRESETS: Record<AttractorKind, AttractorPreset> = {
  thomas: {
    kind: 'thomas',
    worldScale: 0.115,
    dt: 1.4,
  },
  lorenz: {
    kind: 'lorenz',
    worldScale: 0.014,
    dt: 0.5,
  },
  aizawa: {
    kind: 'aizawa',
    worldScale: 0.32,
    dt: 1.8,
  },
  halvorsen: {
    kind: 'halvorsen',
    worldScale: 0.055,
    dt: 0.35,
  },
  rossler: {
    kind: 'rossler',
    worldScale: 0.022,
    dt: 0.55,
  },
  dadras: {
    kind: 'dadras',
    worldScale: 0.025,
    dt: 0.45,
  },
};
