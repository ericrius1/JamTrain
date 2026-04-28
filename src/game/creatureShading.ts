import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  hash,
  mix,
  normalWorld,
  positionLocal,
  positionWorld,
  cameraPosition,
  pow,
  smoothstep,
  uniform,
} from 'three/tsl';

/**
 * Shared key/back/ambient lighting setup. Single instance reused by all
 * creature materials so a future debug knob hits everything at once. The
 * concrete uniform types are inferred from the factory below to keep the
 * TSL node graph methods (`.mul`, `.dot`, `.add`, ...) reachable without
 * having to spell out the full TSL union.
 */
export function createCreatureLighting() {
  return {
    keyDir: uniform(new THREE.Vector3(0.45, 0.78, 0.42).normalize()),
    backDir: uniform(new THREE.Vector3(-0.35, 0.18, -0.6).normalize()),
    ambientCool: uniform(new THREE.Color('#1f2a3a')),
    rimWarm: uniform(new THREE.Color('#ffd6a2')),
    rimPower: uniform(2.6),
    rimStrength: uniform(0.55),
    wrapSoft: uniform(0.32),
  };
}

export type CreatureLighting = ReturnType<typeof createCreatureLighting>;

export type CreatureRoleParams = {
  // TSL color/vec3 types diverge across factories (color('#...') is Node<"color">,
  // mix/uniform yields can be Node<"vec3">). The lighting model treats them
  // uniformly, so we accept any TSL node here.
  baseColor: unknown;
  sssColor: unknown;
  sssStrength: number; // 0..1; 0 disables back-light add
  fiberHashStrength: number; // 0..1; 0 disables hash variation
};

type AnyColorNode = THREE.MeshBasicNodeMaterial['colorNode'];

/**
 * Composes the standard creature lighting model:
 *   half-Lambert key * baseColor, blended out of cool ambient floor,
 *   plus warm rim, plus optional fake-SSS back-light, plus optional fiber hash.
 */
export function makeCreatureColorNode(lighting: CreatureLighting, role: CreatureRoleParams): AnyColorNode {
  const { keyDir, backDir, ambientCool, rimWarm, rimPower, rimStrength, wrapSoft } = lighting;
  const { baseColor, sssColor, sssStrength, fiberHashStrength } = role;

  return Fn(() => {
    const n = normalWorld;
    // Half-Lambert key, smoothed into a soft toon falloff.
    const ndl = n.dot(keyDir).mul(0.5).add(0.5);
    const wrap = smoothstep(float(0).sub(wrapSoft), float(1).add(wrapSoft), ndl);

    // Lit base color blended out of the cool ambient floor.
    const baseLit = (baseColor as ReturnType<typeof color>).toVar('baseLit');
    const lit = mix(ambientCool, baseLit, wrap).toVar('lit');

    // Optional fiber variation — small per-fragment hash on local position.
    if (fiberHashStrength > 0) {
      const h = hash(positionLocal.length().mul(38.0)).mul(2).sub(1).mul(fiberHashStrength);
      lit.assign(lit.mul(float(1).add(h)));
    }

    // Warm rim — fresnel against view direction.
    const view = cameraPosition.sub(positionWorld).normalize();
    const fres = float(1).sub(n.dot(view).abs()).clamp(0, 1);
    const rim = pow(fres, rimPower).mul(rimStrength);
    lit.addAssign(rimWarm.mul(rim));

    // Fake SSS — back-light add term, faded at fresnel edges.
    if (sssStrength > 0) {
      const ndb = n.dot(backDir).clamp(0, 1);
      const sss = ndb.mul(float(1).sub(fres)).mul(sssStrength);
      lit.addAssign((sssColor as ReturnType<typeof color>).mul(sss));
    }

    return lit;
  })() as unknown as AnyColorNode;
}

/**
 * Eyes use a different node graph: dark sclera, iris ring driven by local Y,
 * and a fixed specular catch via reflect/specDir dot.
 */
export function makeEyeColorNode(lighting: CreatureLighting, irisColor = '#3d2a1c'): AnyColorNode {
  return Fn(() => {
    const sclera = color('#16161e');
    const iris = color(irisColor);
    // local-Y on the eyeball roughly maps to vertical iris position.
    const irisMask = smoothstep(float(0.55), float(0.35), positionLocal.length());
    const base = mix(sclera, iris, irisMask).toVar('eyeBase');

    // Specular catch: small bright dot when normal aligns with key direction.
    const n = normalWorld;
    const view = cameraPosition.sub(positionWorld).normalize();
    const halfway = lighting.keyDir.add(view).normalize();
    const specMask = smoothstep(float(0.97), float(1.0), n.dot(halfway));
    base.addAssign(color('#ffffff').mul(specMask));
    return base;
  })() as unknown as AnyColorNode;
}

/** Per-role wrappers — one factory per material role used in the rig. */
export function makeSkinMaterial(lighting: CreatureLighting): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = makeCreatureColorNode(lighting, {
    baseColor: color('#e9b893'),
    sssColor: color('#c46a52'),
    sssStrength: 0.35,
    fiberHashStrength: 0,
  });
  return m;
}

export function makeClothMaterial(lighting: CreatureLighting, seatColor: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = makeCreatureColorNode(lighting, {
    baseColor: color(new THREE.Color(seatColor)),
    sssColor: color('#000000'),
    sssStrength: 0,
    fiberHashStrength: 0.04,
  });
  return m;
}

export function makeFurMaterial(lighting: CreatureLighting): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = makeCreatureColorNode(lighting, {
    baseColor: color('#b97933'),
    sssColor: color('#7c3f19'),
    sssStrength: 0.22,
    fiberHashStrength: 0.10,
  });
  return m;
}

export function makeManeMaterial(lighting: CreatureLighting, seatColor: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  // Mane base = warm gold tinted toward seat color (keeps gold dominant).
  const seat = new THREE.Color(seatColor);
  const gold = new THREE.Color('#c9862d');
  const maneBase = gold.clone().lerp(seat, 0.35);
  m.colorNode = makeCreatureColorNode(lighting, {
    baseColor: color(maneBase),
    sssColor: color('#7a3c12'),
    sssStrength: 0.25,
    fiberHashStrength: 0.18,
  });
  return m;
}

export function makeEyeMaterial(lighting: CreatureLighting): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = makeEyeColorNode(lighting, '#3d2a1c');
  return m;
}

/** Golden glow used at palm/wrist nodes — anchor points for instrument visuals. */
export function makeAccentMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const n = normalWorld;
    const view = cameraPosition.sub(positionWorld).normalize();
    const fres = float(1).sub(n.dot(view).abs()).clamp(0, 1);
    return color('#ffd36b').mul(float(0.72).add(pow(fres, 1.8).mul(1.05)));
  })() as unknown as AnyColorNode;
  return m;
}
