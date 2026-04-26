# Creatures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players choose what creature they are (lion as default, human as alternate) from the in-train HUD. Both creatures share one redesigned humanoid rig built with TSL-composed stylized shading, replacing the current `MeshStandardMaterial`-based `PlayerRig`.

**Architecture:** Mirror the existing `instrument` pattern for state/sync (creatures registry, SpacetimeDB column + reducer, MultiplayerClient listeners, localStorage persistence). Build a new modular rig under `src/game/rig/` — shared skeleton + swappable head/accessories + role-keyed materials backed by a shared `creatureColorNode` TSL Fn. Replace the old `PlayerRig` outright. The picker UI hangs off the existing `PlayerPlaque` medallion as a popover.

**Tech Stack:** TypeScript, `three/webgpu`, TSL nodes from `three/tsl`, SpacetimeDB (TypeScript module SDK), Vite, `tsc --noEmit` for type-checking.

**Verification model:** This codebase has no test infrastructure (no Jest, no Vitest, no Playwright). Each task ends with `npm run build` (`tsc --noEmit && vite build`) plus, where the change is visible, a manual browser check via `npm run dev`. There are no `expect(...)`-style asserts in this plan.

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-04-26-creatures-design.md`
- Existing instrument pattern (mirror this): `src/game/instruments.ts`, `src/game/multiplayer.ts` (instrument fields/listeners), `spacetimedb/src/index.ts` (instrument schema + reducer)
- Existing TSL pattern: `src/game/scenery.ts` (`createBackground` is the cleanest example), `src/game/visuals/Sparks.ts`
- Old rig (replaced): `src/game/rig.ts`

---

## Phase 0 — Foundation

### Task 1: Creature registry

**Files:**
- Create: `src/game/creatures.ts`

- [ ] **Step 1: Create the registry**

```ts
// src/game/creatures.ts
export type CreatureId = 'lion' | 'human';

export const CREATURE_IDS: readonly CreatureId[] = ['lion', 'human'];

export const DEFAULT_CREATURE: CreatureId = 'lion';

export type CreatureMeta = {
  id: CreatureId;
  /** Human-friendly name for the picker label and tooltip. */
  label: string;
  /** Single-line subtitle / personality blurb. */
  subtitle: string;
  /** Inline SVG markup for the picker icon and the medallion silhouette. Sized 24×24. */
  iconSvg: string;
  /** Primary color for the picker chip ring + glow. CSS color string. */
  color: string;
};

export const CREATURES: Record<CreatureId, CreatureMeta> = {
  lion: {
    id: 'lion',
    label: 'Lion',
    subtitle: 'maned · golden',
    color: '#f6c66a',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12.5" r="3.6"/><path d="M12 8.9 V 6.5 M9.4 9.6 L 7.6 7.5 M14.6 9.6 L 16.4 7.5 M7.5 12 L 5 11.4 M16.5 12 L 19 11.4 M8 14.5 L 6 16 M16 14.5 L 18 16 M10 16 L 9 18 M14 16 L 15 18 M12 16 V 18.5"/><circle cx="10.6" cy="11.8" r="0.4" fill="currentColor"/><circle cx="13.4" cy="11.8" r="0.4" fill="currentColor"/></svg>`,
  },
  human: {
    id: 'human',
    label: 'Human',
    subtitle: 'tunic · soft',
    color: '#9ed3ff',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20 C 6.5 14.5 9.5 12 12 12 C 14.5 12 17.5 14.5 18.5 20"/></svg>`,
  },
};

export function isCreatureId(value: unknown): value is CreatureId {
  return value === 'lion' || value === 'human';
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — `tsc --noEmit && vite build` completes with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/game/creatures.ts
git commit -m "creatures: add registry, types, and default"
```

---

### Task 2: TSL creature shading factory

**Files:**
- Create: `src/game/creatureShading.ts`

- [ ] **Step 1: Implement the shared color-node Fn factory**

Reference the existing TSL pattern in `src/game/scenery.ts:282–297` (a `MeshBasicNodeMaterial` whose `colorNode = Fn(() => { ... })()` composes color via TSL ops). This file exports the role-keyed factories used by every creature material.

```ts
// src/game/creatureShading.ts
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
  vec3,
} from 'three/tsl';

/**
 * Shared key/back/ambient lighting setup. Single instance reused by all
 * creature materials so a future debug knob hits everything at once.
 */
export type CreatureLighting = {
  keyDir: ReturnType<typeof uniform>;        // vec3, world-space, points TOWARD the light
  backDir: ReturnType<typeof uniform>;       // vec3, world-space, opposite-ish to key
  ambientCool: ReturnType<typeof uniform>;   // color
  rimWarm: ReturnType<typeof uniform>;       // color
  rimPower: ReturnType<typeof uniform>;      // float
  rimStrength: ReturnType<typeof uniform>;   // float
  wrapSoft: ReturnType<typeof uniform>;      // float — half-Lambert smoothstep softness (0..1)
};

export function createCreatureLighting(): CreatureLighting {
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

export type CreatureRoleParams = {
  baseColor: ReturnType<typeof color> | ReturnType<typeof uniform>;
  sssColor: ReturnType<typeof color> | ReturnType<typeof uniform>;
  sssStrength: number; // 0..1; 0 disables back-light add
  fiberHashStrength: number; // 0..1; 0 disables hash variation
};

/**
 * Composes the standard creature lighting model:
 *   half-Lambert key * baseColor, blended out of cool ambient floor,
 *   plus warm rim, plus optional fake-SSS back-light, plus optional fiber hash.
 */
export function makeCreatureColorNode(lighting: CreatureLighting, role: CreatureRoleParams) {
  const { keyDir, backDir, ambientCool, rimWarm, rimPower, rimStrength, wrapSoft } = lighting;
  const { baseColor, sssColor, sssStrength, fiberHashStrength } = role;

  return Fn(() => {
    const n = normalWorld;
    // Half-Lambert key, smoothed into a soft toon falloff.
    const ndl = n.dot(keyDir).mul(0.5).add(0.5);
    const wrap = smoothstep(float(0).sub(wrapSoft), float(1).add(wrapSoft), ndl);

    // Lit base color blended out of the cool ambient floor.
    const baseLit = baseColor.toVar('baseLit');
    const lit = mix(ambientCool, baseLit, wrap).toVar('lit');

    // Optional fiber variation — small per-fragment hash on local position.
    if (fiberHashStrength > 0) {
      const h = hash(positionLocal.mul(38.0)).mul(2).sub(1).mul(fiberHashStrength);
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
      lit.addAssign(sssColor.mul(sss));
    }

    return lit;
  })();
}

/**
 * Eyes use a different node graph: dark sclera, iris ring driven by local Y,
 * and a fixed specular catch via reflect/specDir dot.
 */
export function makeEyeColorNode(lighting: CreatureLighting, irisColor = '#3d2a1c') {
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
  })();
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
    baseColor: color('#cf9a55'),
    sssColor: color('#9b5a2c'),
    sssStrength: 0.22,
    fiberHashStrength: 0.10,
  });
  return m;
}

export function makeManeMaterial(lighting: CreatureLighting, seatColor: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  // Mane base = warm gold tinted toward seat color (keeps gold dominant).
  const seat = new THREE.Color(seatColor);
  const gold = new THREE.Color('#d6953f');
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

/** Cyan glow used at palm/wrist nodes — anchor points for instrument visuals. */
export function makeAccentMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const n = normalWorld;
    const view = cameraPosition.sub(positionWorld).normalize();
    const fres = float(1).sub(n.dot(view).abs()).clamp(0, 1);
    return color('#7ef2ff').mul(float(0.6).add(pow(fres, 1.8).mul(0.9)));
  })();
  return m;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/creatureShading.ts
git commit -m "creatures: TSL shared shading factory and per-role materials"
```

---

## Phase 1 — New rig (human-only, replaces old rig)

The strategy is to build the new rig with **only human support** first, swap it in for the old `PlayerRig`, verify the human looks right, **then** add lion in Phase 2. This makes Phase 1 a self-contained quality lift.

### Task 3: Skeleton module (transforms only, no head/accessories)

**Files:**
- Create: `src/game/rig/skeleton.ts`

- [ ] **Step 1: Extract skeleton transforms from old rig**

The skeleton owns **shoulders, arms, hands, fingers, the torso transform, and the head anchor** — but not the head mesh itself or any species accessories. It exposes pose-update logic and palm/fingertip world lookups.

```ts
// src/game/rig/skeleton.ts
import * as THREE from 'three/webgpu';
import { handDepthConfig } from '../handDepth';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type PlayerPose, type Vec3Data } from '../types';

type Segment = { mesh: THREE.Mesh; radius: number };

type FingerRig = {
  base: Segment;
  mid: Segment;
  tip: Segment;
  node: THREE.Mesh;
};

export type HandRig = {
  shoulder: THREE.Vector3;
  upper: Segment;
  lower: Segment;
  palm: THREE.Mesh;
  wristNode: THREE.Mesh;
  fingers: Record<FingerName, FingerRig>;
};

const up = new THREE.Vector3(0, 1, 0);
const tempA = new THREE.Vector3();
const tempB = new THREE.Vector3();
const tempC = new THREE.Vector3();

export type SkeletonOptions = {
  /** Outer-cylinder material for upper-arm cloth (player-color). */
  clothMaterial: THREE.Material;
  /** Skin/fur material for forearm and palm cushion. */
  bodyMaterial: THREE.Material;
  /** Cyan-glow material for wristNode + fingertip nodes. */
  accentMaterial: THREE.Material;
  /** Skin/fur material for finger segments. */
  fingerMaterial: THREE.Material;
};

export class Skeleton {
  readonly root = new THREE.Group();
  /** Anchor point where the head mesh attaches. Caller adds a head mesh as a child. */
  readonly headAnchor = new THREE.Group();
  /** Anchor point where torso/body mesh sits. */
  readonly bodyAnchor = new THREE.Group();
  readonly hands: Record<Handedness, HandRig>;

  private static readonly BASE_SEAT_DISTANCE = 1.05;
  private seatIndex: number;
  private backOffset = 0;
  private seatZ: number;
  private facing: number;
  private fingertipWorld = new Map<string, THREE.Vector3>();

  constructor(opts: SkeletonOptions, seatIndex: number) {
    this.seatIndex = seatIndex;
    this.seatZ = this.computeSeatZ();
    this.facing = seatIndex === 0 ? -1 : 1;
    this.root.position.set(0, 0, this.seatZ);
    this.root.rotation.y = seatIndex === 0 ? 0 : Math.PI;

    this.bodyAnchor.position.set(0, 0.95, 0);
    this.headAnchor.position.set(0, 1.55, -0.04);
    this.root.add(this.bodyAnchor);
    this.root.add(this.headAnchor);

    this.hands = {
      left: this.createHandRig('left', opts),
      right: this.createHandRig('right', opts),
    };
  }

  setSeatIndex(seatIndex: number): void {
    this.seatIndex = seatIndex;
    this.seatZ = this.computeSeatZ();
    this.facing = seatIndex === 0 ? -1 : 1;
    this.root.position.z = this.seatZ;
    this.root.rotation.y = seatIndex === 0 ? 0 : Math.PI;
  }

  setBackOffset(offset: number): void {
    this.backOffset = offset;
    this.seatZ = this.computeSeatZ();
    this.root.position.z = this.seatZ;
  }

  private computeSeatZ(): number {
    const dir = this.seatIndex === 0 ? 1 : -1;
    return dir * (Skeleton.BASE_SEAT_DISTANCE + this.backOffset);
  }

  update(pose: PlayerPose, _delta: number): void {
    const t = performance.now();
    const breath = Math.sin(t * 0.0018 + pose.seatIndex) * 0.018;
    this.bodyAnchor.position.y = 0.95 + breath;
    this.headAnchor.position.y = 1.55 + breath * 0.7;
    this.headAnchor.rotation.x = Math.sin(t * 0.001 + pose.seatIndex) * 0.04;
    this.headAnchor.rotation.y = (pose.hands.left.palm.x + pose.hands.right.palm.x) * 0.03;

    for (const handedness of handednesses) {
      this.updateHand(handedness, pose.hands[handedness]);
    }
  }

  getPalmWorld(hand: Handedness): THREE.Vector3 {
    const v = new THREE.Vector3();
    this.hands[hand].wristNode.getWorldPosition(v);
    return v;
  }

  getFingertipWorld(hand: Handedness, finger: FingerName): THREE.Vector3 {
    return this.fingertipWorld.get(`${hand}:${finger}`)?.clone() ?? new THREE.Vector3();
  }

  getAllFingertips(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const handedness of handednesses) {
      for (const finger of fingerNames) out.push(this.getFingertipWorld(handedness, finger));
    }
    return out;
  }

  setFingertipNodeVisible(hand: Handedness, finger: FingerName, visible: boolean): void {
    this.hands[hand].fingers[finger].node.visible = visible;
  }

  setFingertipNodesVisible(visible: boolean): void {
    for (const handedness of handednesses) {
      for (const finger of fingerNames) {
        this.setFingertipNodeVisible(handedness, finger, visible);
      }
    }
  }

  private createHandRig(handedness: Handedness, opts: SkeletonOptions): HandRig {
    const side = handedness === 'left' ? -1 : 1;
    const palmGeom = new THREE.SphereGeometry(0.075, 16, 10);
    const wristGeom = new THREE.SphereGeometry(0.045, 12, 8);
    const fingerNodeGeom = new THREE.SphereGeometry(0.033, 12, 8);

    const rig: HandRig = {
      shoulder: new THREE.Vector3(side * 0.28, 1.25, -0.03),
      upper: this.createSegment(0.055, opts.clothMaterial),
      lower: this.createSegment(0.045, opts.bodyMaterial),
      palm: new THREE.Mesh(palmGeom, opts.bodyMaterial),
      wristNode: new THREE.Mesh(wristGeom, opts.accentMaterial),
      fingers: {} as Record<FingerName, FingerRig>,
    };
    rig.palm.scale.set(1.15, 0.72, 0.52);
    this.root.add(rig.upper.mesh, rig.lower.mesh, rig.palm, rig.wristNode);

    for (const finger of fingerNames) {
      const fingerRig: FingerRig = {
        base: this.createSegment(0.018, opts.fingerMaterial),
        mid: this.createSegment(0.015, opts.fingerMaterial),
        tip: this.createSegment(0.012, opts.fingerMaterial),
        node: new THREE.Mesh(fingerNodeGeom, opts.accentMaterial),
      };
      this.root.add(fingerRig.base.mesh, fingerRig.mid.mesh, fingerRig.tip.mesh, fingerRig.node);
      rig.fingers[finger] = fingerRig;
    }

    return rig;
  }

  private createSegment(radius: number, material: THREE.Material): Segment {
    // Slight taper for the limb sleeves: top a bit thicker than bottom.
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.92, radius, 1, 12), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, radius };
  }

  private updateHand(handedness: Handedness, pose: HandPose): void {
    const rig = this.hands[handedness];
    const side = handedness === 'left' ? -1 : 1;
    const shoulder = rig.shoulder;
    const wrist = this.posePointToRig(pose.wrist, side);
    const palm = this.posePointToRig(pose.palm, side);
    const elbow = tempC.copy(shoulder).lerp(wrist, 0.53).add(new THREE.Vector3(side * 0.14, 0.08, 0.16));

    this.placeSegment(rig.upper, shoulder, elbow);
    this.placeSegment(rig.lower, elbow, wrist);
    rig.palm.position.copy(palm);
    rig.palm.rotation.set(0.35 * side, 0.2 * side, -0.24 * side);
    rig.wristNode.position.copy(wrist);

    for (const finger of fingerNames) {
      const fingerPose = pose.fingers[finger];
      const base = this.posePointToRig(fingerPose.base, side);
      const mid = this.posePointToRig(fingerPose.mid, side);
      const tip = this.posePointToRig(fingerPose.tip, side);
      const curlOffset = fingerPose.curl * 0.065 * this.facing;
      mid.z += curlOffset;
      tip.z += curlOffset * 1.5;

      const fingerRig = rig.fingers[finger];
      this.placeSegment(fingerRig.base, palm, base);
      this.placeSegment(fingerRig.mid, base, mid);
      this.placeSegment(fingerRig.tip, mid, tip);
      fingerRig.node.position.copy(tip);

      const world = tip.clone();
      this.root.localToWorld(world);
      this.fingertipWorld.set(`${handedness}:${finger}`, world);
    }
  }

  private posePointToRig(point: Vec3Data, side: number): THREE.Vector3 {
    return new THREE.Vector3(
      point.x * 0.54 + side * 0.04,
      0.54 + point.y * 0.68,
      -0.42 - point.z * 0.85 * handDepthConfig.worldDepthScale - handDepthConfig.worldDepthOffset
    );
  }

  private placeSegment(segment: Segment, a: THREE.Vector3, b: THREE.Vector3): void {
    tempA.copy(b).sub(a);
    const length = Math.max(tempA.length(), 0.001);
    segment.mesh.position.copy(a).addScaledVector(tempA, 0.5);
    segment.mesh.scale.set(1, length, 1);
    segment.mesh.quaternion.setFromUnitVectors(up, tempB.copy(tempA).normalize());
  }
}

// Re-export so other rig modules don't need the deep import.
export type { Handedness } from '../types';
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/skeleton.ts
git commit -m "rig: extract Skeleton — transforms, hands, palm/fingertip lookups"
```

---

### Task 4: Human head module

**Files:**
- Create: `src/game/rig/humanHead.ts`

- [ ] **Step 1: Compose the human head from primitives**

The head is a `THREE.Group` rooted at the skeleton's `headAnchor`. It contains an egg-shaped cranium, a soft jaw mass, a brow ridge, a small nose ridge, eyes, and a mouth. Eye geometry sits inside subtle socket recesses (small inset spheres just behind the front face).

```ts
// src/game/rig/humanHead.ts
import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeEyeMaterial, makeSkinMaterial } from '../creatureShading';

export type HumanHeadHandles = {
  group: THREE.Group;
  /** Materials owned by the head, returned so the rig can dispose them. */
  materials: THREE.Material[];
  /** Geometries owned, for disposal. */
  geometries: THREE.BufferGeometry[];
};

export function buildHumanHead(lighting: CreatureLighting): HumanHeadHandles {
  const group = new THREE.Group();
  const skin = makeSkinMaterial(lighting);
  const eye = makeEyeMaterial(lighting);

  // Cranium: an egg shape — sphere scaled taller than wide, slightly fuller at the back.
  const craniumGeom = new THREE.SphereGeometry(0.22, 32, 22);
  const cranium = new THREE.Mesh(craniumGeom, skin);
  cranium.scale.set(0.92, 1.10, 0.95);
  cranium.position.set(0, 0.02, 0);
  group.add(cranium);

  // Jaw mass: smaller squashed sphere blended at the bottom-front of cranium.
  const jawGeom = new THREE.SphereGeometry(0.14, 24, 16);
  const jaw = new THREE.Mesh(jawGeom, skin);
  jaw.scale.set(0.82, 0.65, 0.82);
  jaw.position.set(0, -0.10, -0.02);
  group.add(jaw);

  // Brow ridge: a thin torus arc above the eye line.
  const browGeom = new THREE.TorusGeometry(0.12, 0.012, 8, 24, Math.PI);
  const brow = new THREE.Mesh(browGeom, skin);
  brow.rotation.set(Math.PI / 2, 0, 0);
  brow.position.set(0, 0.04, -0.18);
  group.add(brow);

  // Nose ridge: tiny stretched cone from brow center down.
  const noseGeom = new THREE.ConeGeometry(0.018, 0.075, 10);
  const nose = new THREE.Mesh(noseGeom, skin);
  nose.position.set(0, -0.01, -0.215);
  nose.rotation.set(Math.PI, 0, 0);
  group.add(nose);

  // Eye sockets: tiny inset spheres slightly behind the cranium front face — they
  // create shadow recesses without needing any normal-map work.
  const socketGeom = new THREE.SphereGeometry(0.04, 16, 12);
  const leftSocket = new THREE.Mesh(socketGeom, skin);
  const rightSocket = new THREE.Mesh(socketGeom, skin);
  leftSocket.scale.set(1.0, 0.7, 0.6);
  rightSocket.scale.copy(leftSocket.scale);
  leftSocket.position.set(-0.07, 0.02, -0.18);
  rightSocket.position.set(0.07, 0.02, -0.18);
  group.add(leftSocket, rightSocket);

  // Eyeballs.
  const eyeGeom = new THREE.SphereGeometry(0.026, 18, 14);
  const leftEye = new THREE.Mesh(eyeGeom, eye);
  const rightEye = new THREE.Mesh(eyeGeom, eye);
  leftEye.position.set(-0.07, 0.025, -0.205);
  rightEye.position.set(0.07, 0.025, -0.205);
  group.add(leftEye, rightEye);

  // Soft mouth: a thin curved arc made from a small torus segment.
  const mouthGeom = new THREE.TorusGeometry(0.05, 0.006, 6, 14, Math.PI * 0.6);
  const mouth = new THREE.Mesh(mouthGeom, eye);
  mouth.rotation.set(0, 0, Math.PI);
  mouth.position.set(0, -0.07, -0.20);
  group.add(mouth);

  return {
    group,
    materials: [skin, eye],
    geometries: [craniumGeom, jawGeom, browGeom, noseGeom, socketGeom, eyeGeom, mouthGeom],
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/humanHead.ts
git commit -m "rig: human head — compound forms (cranium, jaw, brow, nose, eyes)"
```

---

### Task 5: Human body module

**Files:**
- Create: `src/game/rig/humanBody.ts`

- [ ] **Step 1: Compose the torso + tunic from primitives**

The body sits at the skeleton's `bodyAnchor`. A subtle compound: lathed upper torso narrowing into a waist, then a flared lower-tunic skirt (per-seat color), with a soft neck collar.

```ts
// src/game/rig/humanBody.ts
import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeClothMaterial, makeSkinMaterial } from '../creatureShading';

export type HumanBodyHandles = {
  group: THREE.Group;
  /** Material applied to upper-arm cloth — exported so the skeleton can use it. */
  clothMaterial: THREE.MeshBasicNodeMaterial;
  /** Material applied to forearms / palms / fingers. */
  skinMaterial: THREE.MeshBasicNodeMaterial;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildHumanBody(lighting: CreatureLighting, seatColor: number): HumanBodyHandles {
  const group = new THREE.Group();
  const cloth = makeClothMaterial(lighting, seatColor);
  const skin = makeSkinMaterial(lighting);

  // Lathed torso silhouette — points define a half-profile from waist (bottom)
  // to neck (top). Lathe revolves it around Y.
  const torsoProfile = [
    new THREE.Vector2(0.30, -0.30), // hip flare
    new THREE.Vector2(0.26, -0.16),
    new THREE.Vector2(0.22, -0.02), // waist
    new THREE.Vector2(0.27,  0.10),
    new THREE.Vector2(0.30,  0.20), // chest
    new THREE.Vector2(0.26,  0.30),
    new THREE.Vector2(0.18,  0.36), // neck base
    new THREE.Vector2(0.10,  0.40), // neck top
  ];
  const torsoGeom = new THREE.LatheGeometry(torsoProfile, 28);
  torsoGeom.computeVertexNormals();
  const torso = new THREE.Mesh(torsoGeom, cloth);
  group.add(torso);

  // Tunic skirt — a slightly larger lathed flare hanging from the hip.
  const tunicProfile = [
    new THREE.Vector2(0.40, -0.42), // skirt hem
    new THREE.Vector2(0.34, -0.32),
    new THREE.Vector2(0.30, -0.22),
  ];
  const tunicGeom = new THREE.LatheGeometry(tunicProfile, 24);
  tunicGeom.computeVertexNormals();
  const tunic = new THREE.Mesh(tunicGeom, cloth);
  group.add(tunic);

  // Soft shoulder spheres to bridge cloth to upper-arm sleeves.
  const shoulderGeom = new THREE.SphereGeometry(0.085, 16, 12);
  const leftShoulder = new THREE.Mesh(shoulderGeom, cloth);
  const rightShoulder = new THREE.Mesh(shoulderGeom, cloth);
  leftShoulder.position.set(-0.28, 0.30, -0.03);
  rightShoulder.position.set(0.28, 0.30, -0.03);
  leftShoulder.scale.set(1.0, 0.85, 1.0);
  rightShoulder.scale.copy(leftShoulder.scale);
  group.add(leftShoulder, rightShoulder);

  // Soft neck collar — small skin-toned cylinder peek.
  const neckGeom = new THREE.CylinderGeometry(0.085, 0.10, 0.10, 16);
  const neck = new THREE.Mesh(neckGeom, skin);
  neck.position.set(0, 0.42, -0.02);
  group.add(neck);

  return {
    group,
    clothMaterial: cloth,
    skinMaterial: skin,
    materials: [cloth, skin],
    geometries: [torsoGeom, tunicGeom, shoulderGeom, neckGeom],
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/humanBody.ts
git commit -m "rig: human body — lathed torso + tunic skirt + shoulder spheres"
```

---

### Task 6: HumanoidRig (human-only) — public API

**Files:**
- Create: `src/game/rig/HumanoidRig.ts`

- [ ] **Step 1: Compose the rig**

`HumanoidRig` exposes the same API the existing consumers use (`update(pose, delta, _ignored)`, `getPalmWorld`, `getFingertipWorld`, `setFingertipNodesVisible`, `setSeatIndex`, `setBackOffset`, `dispose`, `root`). It accepts `creature` in its constructor and exposes `setCreature(id)` — but in this task only `'human'` works. Lion is added in Phase 2.

```ts
// src/game/rig/HumanoidRig.ts
import * as THREE from 'three/webgpu';
import type { FingerName, Handedness, PlayerPose } from '../types';
import type { CreatureId } from '../creatures';
import { createCreatureLighting, makeAccentMaterial, type CreatureLighting } from '../creatureShading';
import { Skeleton } from './skeleton';
import { buildHumanHead, type HumanHeadHandles } from './humanHead';
import { buildHumanBody, type HumanBodyHandles } from './humanBody';

export type HumanoidRigOptions = {
  seatIndex: number;
  color: number;
  creature: CreatureId;
};

type HeadHandles = HumanHeadHandles; // expanded in Phase 2 to include lion head
type BodyHandles = HumanBodyHandles; // expanded in Phase 2 to include lion body

export class HumanoidRig {
  readonly root = new THREE.Group();
  private creature: CreatureId;
  private seatIndex: number;
  private seatColor: number;
  private lighting: CreatureLighting;
  private skeleton!: Skeleton;
  private head!: HeadHandles;
  private body!: BodyHandles;
  private accentMaterial!: THREE.MeshBasicNodeMaterial;

  constructor(private scene: THREE.Scene, opts: HumanoidRigOptions) {
    this.seatIndex = opts.seatIndex;
    this.seatColor = opts.color;
    this.creature = opts.creature;
    this.lighting = createCreatureLighting();

    this.buildForCreature();
    this.scene.add(this.root);
  }

  setCreature(id: CreatureId): void {
    if (id === this.creature) return;
    this.creature = id;
    this.teardownCreatureScopedNodes();
    this.buildForCreature();
  }

  setSeatIndex(seatIndex: number): void {
    this.seatIndex = seatIndex;
    this.skeleton.setSeatIndex(seatIndex);
  }

  setBackOffset(offset: number): void {
    this.skeleton.setBackOffset(offset);
  }

  update(pose: PlayerPose, delta: number, _robotTarget: number): void {
    void _robotTarget; // robot overlay was dropped — ignored, kept for caller compat.
    this.skeleton.update(pose, delta);
  }

  getPalmWorld(hand: Handedness): THREE.Vector3 {
    return this.skeleton.getPalmWorld(hand);
  }

  getFingertipWorld(hand: Handedness, finger: FingerName): THREE.Vector3 {
    return this.skeleton.getFingertipWorld(hand, finger);
  }

  getAllFingertips(): THREE.Vector3[] {
    return this.skeleton.getAllFingertips();
  }

  setFingertipNodeVisible(hand: Handedness, finger: FingerName, visible: boolean): void {
    this.skeleton.setFingertipNodeVisible(hand, finger, visible);
  }

  setFingertipNodesVisible(visible: boolean): void {
    this.skeleton.setFingertipNodesVisible(visible);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.teardownCreatureScopedNodes();
  }

  private buildForCreature(): void {
    if (this.creature !== 'human') {
      // Phase 1 fallback: lion not yet implemented — treat as human until Task 9.
      // (This branch is removed in Task 9 once lion exists.)
    }

    this.body = buildHumanBody(this.lighting, this.seatColor);
    this.head = buildHumanHead(this.lighting);
    this.accentMaterial = makeAccentMaterial();

    this.skeleton = new Skeleton(
      {
        clothMaterial: this.body.clothMaterial,
        bodyMaterial: this.body.skinMaterial,
        accentMaterial: this.accentMaterial,
        fingerMaterial: this.body.skinMaterial,
      },
      this.seatIndex
    );

    // Mount body + head on the skeleton's anchors.
    this.skeleton.bodyAnchor.add(this.body.group);
    this.skeleton.headAnchor.add(this.head.group);

    this.root.add(this.skeleton.root);
  }

  private teardownCreatureScopedNodes(): void {
    if (this.skeleton) {
      this.root.remove(this.skeleton.root);
      this.skeleton.root.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    if (this.body) {
      for (const g of this.body.geometries) g.dispose();
      for (const m of this.body.materials) m.dispose();
    }
    if (this.head) {
      for (const g of this.head.geometries) g.dispose();
      for (const m of this.head.materials) m.dispose();
    }
    if (this.accentMaterial) this.accentMaterial.dispose();
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/HumanoidRig.ts
git commit -m "rig: HumanoidRig — composes Skeleton + human head + human body"
```

---

### Task 7: Swap consumers from PlayerRig to HumanoidRig; delete old rig

**Files:**
- Modify: `src/game/Game.ts` (replace `PlayerRig` import + instantiation)
- Modify: any other file importing `PlayerRig` from `./rig` (find with grep below)
- Delete: `src/game/rig.ts`

- [ ] **Step 1: Find every consumer of `PlayerRig`**

Run:
```bash
grep -rn "from ['\"].*rig['\"]" /Users/eric/codeprojects/JamTrain/src
grep -rn "PlayerRig" /Users/eric/codeprojects/JamTrain/src
```

Expected: a small set of files (likely `Game.ts` only). If others appear, treat each one the same way as `Game.ts` below.

- [ ] **Step 2: In each consumer, replace the import**

Replace:
```ts
import { PlayerRig } from './rig';
```
with:
```ts
import { HumanoidRig } from './rig/HumanoidRig';
```

And replace each `new PlayerRig(scene, { seatIndex, color, robot })` with:
```ts
new HumanoidRig(scene, { seatIndex, color, creature: 'human' })
```

(`robot` is dropped — `HumanoidRig.update(pose, delta, _robotTarget)` ignores its third arg, so call sites that pass a robot target can keep doing so without code change.)

If a call site uses the type `PlayerRig` for a field annotation, replace it with `HumanoidRig`.

- [ ] **Step 3: Delete the old rig**

Run: `rm /Users/eric/codeprojects/JamTrain/src/game/rig.ts`

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS. If `tsc` reports an unused import or unresolved type from a missed consumer, fix it now.

- [ ] **Step 5: Manual visual check**

Run: `npm run dev`
Open the app in a browser, click through `BeginGate`, and confirm:

- The player avatar renders (no missing rig — black hole, broken transforms, etc.).
- The avatar's hands follow your hands.
- The avatar reads as a stylized human (compound head with brow + nose, lathed torso with tunic flare, shoulder spheres). It will look different from the previous rig — that's intended.
- Lighting reads softly: shadowed sides should be cool/desaturated, lit sides warm; rim glow visible on silhouettes.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add -u src/game/Game.ts
git rm src/game/rig.ts
# also any other consumers that were updated
git commit -m "rig: replace PlayerRig with HumanoidRig (human only); delete old rig"
```

---

## Phase 2 — Lion variant

### Task 8: Lion head module

**Files:**
- Create: `src/game/rig/lionHead.ts`

- [ ] **Step 1: Compose the lion head**

The lion head replaces the human head while reusing the eye material and accepting the same `CreatureLighting`. It exposes the same `{ group, materials, geometries }` shape so `HumanoidRig` can swap them by single field assignment.

```ts
// src/game/rig/lionHead.ts
import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeEyeMaterial, makeFurMaterial } from '../creatureShading';

export type LionHeadHandles = {
  group: THREE.Group;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildLionHead(lighting: CreatureLighting): LionHeadHandles {
  const group = new THREE.Group();
  const fur = makeFurMaterial(lighting);
  const eye = makeEyeMaterial(lighting);
  // Cheap dark material for nose pad + ear inner — solid color, no lighting model.
  const darkPadMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color('#1f1612') });

  // Domed skull — sphere scaled slightly wider than tall to suggest a feline silhouette.
  const skullGeom = new THREE.SphereGeometry(0.21, 32, 22);
  const skull = new THREE.Mesh(skullGeom, fur);
  skull.scale.set(1.05, 0.95, 1.0);
  skull.position.set(0, 0.02, 0);
  group.add(skull);

  // Snout block — extruded forward and tapered to the nose pad.
  const snoutGeom = new THREE.CylinderGeometry(0.085, 0.07, 0.16, 18);
  const snout = new THREE.Mesh(snoutGeom, fur);
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, -0.04, -0.20);
  group.add(snout);

  // Nose pad — small dark spheroid at the tip.
  const nosePadGeom = new THREE.SphereGeometry(0.028, 14, 10);
  const nosePad = new THREE.Mesh(nosePadGeom, darkPadMat);
  nosePad.scale.set(1.1, 0.85, 0.9);
  nosePad.position.set(0, -0.03, -0.29);
  group.add(nosePad);

  // Upper-lip curve — a thin torus arc under the nose.
  const lipGeom = new THREE.TorusGeometry(0.06, 0.012, 8, 18, Math.PI);
  const lip = new THREE.Mesh(lipGeom, fur);
  lip.rotation.set(Math.PI / 2, 0, Math.PI);
  lip.position.set(0, -0.10, -0.25);
  group.add(lip);

  // Cheek tufts — a few small instanced cones, jittered.
  const cheekGeom = new THREE.ConeGeometry(0.014, 0.05, 8);
  const cheekCount = 6;
  const cheekMesh = new THREE.InstancedMesh(cheekGeom, fur, cheekCount * 2);
  let idx = 0;
  const dummy = new THREE.Object3D();
  for (let side = 0; side < 2; side += 1) {
    const sx = side === 0 ? -1 : 1;
    for (let i = 0; i < cheekCount; i += 1) {
      const seed = (i + 1) * (sx + 2);
      const jitter = (n: number) => (Math.sin(n * 12.9898) * 43758.5453) % 1;
      const j1 = jitter(seed);
      const j2 = jitter(seed + 0.7);
      dummy.position.set(sx * (0.10 + j1 * 0.03), -0.07 + j2 * 0.05, -0.18 - i * 0.005);
      dummy.rotation.set(0, 0, sx * (-0.4 - j1 * 0.3));
      dummy.scale.setScalar(0.7 + j2 * 0.6);
      dummy.updateMatrix();
      cheekMesh.setMatrixAt(idx++, dummy.matrix);
    }
  }
  cheekMesh.instanceMatrix.needsUpdate = true;
  group.add(cheekMesh);

  // Pointed ears — outer cone + small inner hollow cone for shadow recess.
  const outerEarGeom = new THREE.ConeGeometry(0.06, 0.10, 14);
  const innerEarGeom = new THREE.ConeGeometry(0.035, 0.07, 12);
  for (const sx of [-1, 1]) {
    const outer = new THREE.Mesh(outerEarGeom, fur);
    outer.position.set(sx * 0.13, 0.18, -0.04);
    outer.rotation.set(-0.2, 0, sx * 0.18);
    const inner = new THREE.Mesh(innerEarGeom, darkPadMat);
    inner.position.set(sx * 0.13, 0.17, -0.045);
    inner.rotation.set(-0.18, 0, sx * 0.18);
    group.add(outer, inner);
  }

  // Eye sockets + eyeballs — slightly closer-set than human, lower on the head.
  const socketGeom = new THREE.SphereGeometry(0.04, 16, 12);
  for (const sx of [-1, 1]) {
    const socket = new THREE.Mesh(socketGeom, fur);
    socket.scale.set(0.95, 0.7, 0.6);
    socket.position.set(sx * 0.06, 0.01, -0.18);
    group.add(socket);
  }
  const eyeGeom = new THREE.SphereGeometry(0.024, 18, 14);
  for (const sx of [-1, 1]) {
    const eyeMesh = new THREE.Mesh(eyeGeom, eye);
    eyeMesh.position.set(sx * 0.06, 0.013, -0.20);
    group.add(eyeMesh);
  }

  return {
    group,
    materials: [fur, eye, darkPadMat],
    geometries: [
      skullGeom, snoutGeom, nosePadGeom, lipGeom, cheekGeom,
      outerEarGeom, innerEarGeom, socketGeom, eyeGeom,
    ],
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/lionHead.ts
git commit -m "rig: lion head — domed skull, snout, nose pad, ears, cheek tufts"
```

---

### Task 9: Lion mane module

**Files:**
- Create: `src/game/rig/lionMane.ts`

- [ ] **Step 1: Build the mane corona**

The mane is two passes of instanced cones — an inner darker pass and an outer pass tinted by the seat color. Per-tuft scale and orientation are seeded by `seatIndex`.

```ts
// src/game/rig/lionMane.ts
import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeManeMaterial } from '../creatureShading';

export type LionManeHandles = {
  group: THREE.Group;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

const TAU = Math.PI * 2;

export function buildLionMane(
  lighting: CreatureLighting,
  seatColor: number,
  seatIndex: number,
  tuftCount = 48
): LionManeHandles {
  const group = new THREE.Group();
  const outer = makeManeMaterial(lighting, seatColor);
  // Inner darker mane: same factory tinted toward black so it reads as shadow underneath.
  const innerColor = new THREE.Color(seatColor).lerp(new THREE.Color('#1a0d05'), 0.7).getHex();
  const inner = makeManeMaterial(lighting, innerColor);

  const tuftGeom = new THREE.ConeGeometry(0.022, 0.085, 7);

  const innerMesh = new THREE.InstancedMesh(tuftGeom, inner, tuftCount);
  const outerMesh = new THREE.InstancedMesh(tuftGeom, outer, tuftCount);

  const dummy = new THREE.Object3D();
  // Deterministic per-player jitter — seatIndex shifts the seed so each player
  // gets a stable but distinct mane.
  const seedFn = (i: number) => {
    const x = Math.sin((i + 1) * 12.9898 + seatIndex * 7.13) * 43758.5453;
    return x - Math.floor(x);
  };

  // Inner pass: tighter, smaller, slightly inset.
  for (let i = 0; i < tuftCount; i += 1) {
    const t = i / tuftCount;
    const angle = t * TAU + seedFn(i + 100) * 0.4;
    const phi = (seedFn(i + 200) - 0.5) * 0.6 + 0.1; // mostly equatorial, slight tilt up
    const r = 0.21 + seedFn(i + 300) * 0.02;
    dummy.position.set(
      Math.cos(angle) * Math.cos(phi) * r,
      Math.sin(phi) * r + 0.02,
      Math.sin(angle) * Math.cos(phi) * r
    );
    dummy.lookAt(0, dummy.position.y, 0);
    dummy.rotateX(Math.PI); // point cone outward
    dummy.scale.setScalar(0.7 + seedFn(i + 400) * 0.4);
    dummy.updateMatrix();
    innerMesh.setMatrixAt(i, dummy.matrix);
  }
  innerMesh.instanceMatrix.needsUpdate = true;

  // Outer pass: longer, larger, slightly fanned.
  for (let i = 0; i < tuftCount; i += 1) {
    const t = i / tuftCount;
    const angle = t * TAU + seedFn(i + 500) * 0.6;
    const phi = (seedFn(i + 600) - 0.5) * 0.7 + 0.05;
    const r = 0.27 + seedFn(i + 700) * 0.04;
    dummy.position.set(
      Math.cos(angle) * Math.cos(phi) * r,
      Math.sin(phi) * r + 0.02,
      Math.sin(angle) * Math.cos(phi) * r
    );
    dummy.lookAt(0, dummy.position.y, 0);
    dummy.rotateX(Math.PI);
    dummy.scale.setScalar(1.0 + seedFn(i + 800) * 0.7);
    dummy.updateMatrix();
    outerMesh.setMatrixAt(i, dummy.matrix);
  }
  outerMesh.instanceMatrix.needsUpdate = true;

  group.add(innerMesh, outerMesh);

  return {
    group,
    materials: [inner, outer],
    geometries: [tuftGeom],
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/lionMane.ts
git commit -m "rig: lion mane — instanced two-pass corona, seat-seeded jitter"
```

---

### Task 10: Lion tail module

**Files:**
- Create: `src/game/rig/lionTail.ts`

- [ ] **Step 1: Build the tail with idle sway**

The tail is a `TubeGeometry` along a smooth curve, with a small tuft at the end. Sway is applied via per-frame transform updates on the tail group's rotation (cleaner than threading time uniforms into the tube geometry).

```ts
// src/game/rig/lionTail.ts
import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeFurMaterial, makeManeMaterial } from '../creatureShading';

export type LionTailHandles = {
  group: THREE.Group;
  /** Drive sway: pass elapsed seconds. */
  update(elapsed: number): void;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildLionTail(lighting: CreatureLighting, seatColor: number): LionTailHandles {
  const group = new THREE.Group();
  const fur = makeFurMaterial(lighting);
  const tuftMat = makeManeMaterial(lighting, seatColor);

  // Tail curve — starts at the lower back, sweeps down and slightly to one side, then up.
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.0, 0.05),
    new THREE.Vector3(0.06, -0.05, 0.20),
    new THREE.Vector3(0.10, -0.12, 0.32),
    new THREE.Vector3(0.06, -0.20, 0.40),
  ]);
  const tubeGeom = new THREE.TubeGeometry(tailCurve, 32, 0.015, 8, false);
  const tube = new THREE.Mesh(tubeGeom, fur);
  group.add(tube);

  // Tail tuft — a small ico-sphere with mane material.
  const tuftGeom = new THREE.IcosahedronGeometry(0.028, 1);
  const tuft = new THREE.Mesh(tuftGeom, tuftMat);
  tuft.position.set(0.06, -0.20, 0.40);
  group.add(tuft);

  // Anchor on the lower back of the body.
  group.position.set(0, -0.10, 0.12);

  const update = (elapsed: number) => {
    group.rotation.y = Math.sin(elapsed * 1.4) * 0.18;
    group.rotation.z = Math.sin(elapsed * 0.9 + 1.7) * 0.10;
  };

  return {
    group,
    update,
    materials: [fur, tuftMat],
    geometries: [tubeGeom, tuftGeom],
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/lionTail.ts
git commit -m "rig: lion tail — tube curve + tuft + idle sway"
```

---

### Task 11: Lion body module

**Files:**
- Create: `src/game/rig/lionBody.ts`

- [ ] **Step 1: Compose lion body (fur replaces tunic)**

Same skeleton as human, but the body uses fur material everywhere — no tunic flare. The body silhouette is a slightly stockier version of the human torso lathe.

```ts
// src/game/rig/lionBody.ts
import * as THREE from 'three/webgpu';
import type { CreatureLighting } from '../creatureShading';
import { makeFurMaterial } from '../creatureShading';

export type LionBodyHandles = {
  group: THREE.Group;
  /** Material applied to upper-arm sleeves — fur, not seat-tinted cloth. */
  clothMaterial: THREE.MeshBasicNodeMaterial;
  /** Material applied to forearms / palms / fingers — same fur material. */
  skinMaterial: THREE.MeshBasicNodeMaterial;
  materials: THREE.Material[];
  geometries: THREE.BufferGeometry[];
};

export function buildLionBody(lighting: CreatureLighting): LionBodyHandles {
  const group = new THREE.Group();
  const fur = makeFurMaterial(lighting);

  // Stockier than human torso — wider chest, less waist taper.
  const torsoProfile = [
    new THREE.Vector2(0.34, -0.32),
    new THREE.Vector2(0.30, -0.18),
    new THREE.Vector2(0.27, -0.04), // mild waist
    new THREE.Vector2(0.32,  0.10),
    new THREE.Vector2(0.34,  0.20),
    new THREE.Vector2(0.28,  0.30),
    new THREE.Vector2(0.18,  0.36),
    new THREE.Vector2(0.10,  0.40),
  ];
  const torsoGeom = new THREE.LatheGeometry(torsoProfile, 28);
  torsoGeom.computeVertexNormals();
  const torso = new THREE.Mesh(torsoGeom, fur);
  group.add(torso);

  // Belly fur — small softening sphere at the lower torso front.
  const bellyGeom = new THREE.SphereGeometry(0.16, 18, 14);
  const belly = new THREE.Mesh(bellyGeom, fur);
  belly.scale.set(1.05, 0.7, 0.6);
  belly.position.set(0, -0.18, -0.10);
  group.add(belly);

  // Shoulder spheres.
  const shoulderGeom = new THREE.SphereGeometry(0.090, 16, 12);
  for (const sx of [-1, 1]) {
    const sh = new THREE.Mesh(shoulderGeom, fur);
    sh.position.set(sx * 0.28, 0.30, -0.03);
    sh.scale.set(1.0, 0.85, 1.0);
    group.add(sh);
  }

  return {
    group,
    clothMaterial: fur,
    skinMaterial: fur,
    materials: [fur],
    geometries: [torsoGeom, bellyGeom, shoulderGeom],
  };
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/game/rig/lionBody.ts
git commit -m "rig: lion body — stockier lathed torso, belly, shoulders, fur material"
```

---

### Task 12: Wire lion into HumanoidRig

**Files:**
- Modify: `src/game/rig/HumanoidRig.ts`

- [ ] **Step 1: Add lion to the build path**

Replace the `buildForCreature` method (and the head/body type unions) so both creatures are supported. Add a `tail` handle and wire its `update(elapsed)` into the per-frame update.

In `src/game/rig/HumanoidRig.ts`:

Add imports at top:
```ts
import { buildLionHead, type LionHeadHandles } from './lionHead';
import { buildLionMane, type LionManeHandles } from './lionMane';
import { buildLionTail, type LionTailHandles } from './lionTail';
import { buildLionBody, type LionBodyHandles } from './lionBody';
```

Replace the type aliases:
```ts
type HeadHandles = HumanHeadHandles | LionHeadHandles;
type BodyHandles = HumanBodyHandles | LionBodyHandles;
```

Add fields to the class:
```ts
private mane: LionManeHandles | null = null;
private tail: LionTailHandles | null = null;
private elapsed = 0;
```

Replace `update(...)` with:
```ts
update(pose: PlayerPose, delta: number, _robotTarget: number): void {
  void _robotTarget;
  this.elapsed += delta;
  this.skeleton.update(pose, delta);
  if (this.tail) this.tail.update(this.elapsed);
}
```

Replace `buildForCreature` (full new body):
```ts
private buildForCreature(): void {
  this.accentMaterial = makeAccentMaterial();

  if (this.creature === 'lion') {
    this.body = buildLionBody(this.lighting);
    this.head = buildLionHead(this.lighting);
    this.mane = buildLionMane(this.lighting, this.seatColor, this.seatIndex);
    this.tail = buildLionTail(this.lighting, this.seatColor);
  } else {
    this.body = buildHumanBody(this.lighting, this.seatColor);
    this.head = buildHumanHead(this.lighting);
    this.mane = null;
    this.tail = null;
  }

  this.skeleton = new Skeleton(
    {
      clothMaterial: this.body.clothMaterial,
      bodyMaterial: this.body.skinMaterial,
      accentMaterial: this.accentMaterial,
      fingerMaterial: this.body.skinMaterial,
    },
    this.seatIndex
  );

  this.skeleton.bodyAnchor.add(this.body.group);
  this.skeleton.headAnchor.add(this.head.group);
  if (this.mane) this.skeleton.headAnchor.add(this.mane.group);
  if (this.tail) this.skeleton.bodyAnchor.add(this.tail.group);

  this.root.add(this.skeleton.root);
}
```

Replace `teardownCreatureScopedNodes` (full new body):
```ts
private teardownCreatureScopedNodes(): void {
  if (this.skeleton) {
    this.root.remove(this.skeleton.root);
    this.skeleton.root.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
  if (this.body) {
    for (const g of this.body.geometries) g.dispose();
    for (const m of this.body.materials) m.dispose();
  }
  if (this.head) {
    for (const g of this.head.geometries) g.dispose();
    for (const m of this.head.materials) m.dispose();
  }
  if (this.mane) {
    for (const g of this.mane.geometries) g.dispose();
    for (const m of this.mane.materials) m.dispose();
  }
  if (this.tail) {
    for (const g of this.tail.geometries) g.dispose();
    for (const m of this.tail.materials) m.dispose();
  }
  if (this.accentMaterial) this.accentMaterial.dispose();
  this.mane = null;
  this.tail = null;
}
```

- [ ] **Step 2: Default the rig to lion**

In `src/game/Game.ts`, change the `HumanoidRig` constructor calls so `creature: 'lion'` is the default for new rigs (this matches the spec — lion is the default creature). For both the local rig and the partner rig.

Search:
```bash
grep -n "new HumanoidRig" /Users/eric/codeprojects/JamTrain/src/game/Game.ts
```

Edit each call site so `creature: 'lion'` is passed. (If `Game.ts` already pulls the local creature from somewhere — it doesn't yet — keep that path.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual visual check**

Run: `npm run dev`
Open the app, click through `BeginGate`, and confirm:

- The avatar is a lion (mane around the head, fur-colored body, tail visible behind the body, snout + ear silhouette).
- Hands and pose tracking still work as before (palms follow your hands, fingers articulate).
- Mane reads as a corona of tufts, not a solid disc; per-player seat color shows up in the mane and the tail tuft.
- Tail visibly sways idly.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add -u src/game/rig/HumanoidRig.ts src/game/Game.ts
git commit -m "rig: add lion variant — head, mane, tail, body — and default to lion"
```

---

### Task 13: Tweakable params for the rig + lighting + lion

**Files:**
- Modify: `src/hud/tweakDefs.ts`
- Modify: `src/game/rig/HumanoidRig.ts` (consume lighting params)
- Modify: `src/game/rig/lionMane.ts` (consume mane params)
- Modify: `src/game/rig/lionTail.ts` (consume tail params)

- [ ] **Step 1: Read the current `tweakDefs.ts` shape**

Read the file:
```bash
cat /Users/eric/codeprojects/JamTrain/src/hud/tweakDefs.ts
```

Note the existing `*_DEFS` pattern (each entry is `{ default, min, max, step, hidden? }`) and how modules are keyed and persisted.

- [ ] **Step 2: Add three DEFS objects following the existing pattern**

Add to `src/hud/tweakDefs.ts`:

```ts
export const CREATURE_SHADING_DEFS = {
  wrapSoft:    { default: 0.32, min: 0.0,  max: 1.0, step: 0.01 },
  rimPower:    { default: 2.6,  min: 0.5,  max: 8.0, step: 0.1 },
  rimStrength: { default: 0.55, min: 0.0,  max: 2.0, step: 0.01 },
  ambientCool: { default: '#1f2a3a', kind: 'color' as const },
  rimWarm:     { default: '#ffd6a2', kind: 'color' as const },
  keyYaw:      { default: 0.50, min: -1.0, max: 1.0, step: 0.01 },
  keyPitch:    { default: 0.78, min: -1.0, max: 1.0, step: 0.01 },
  backYaw:     { default: -0.40, min: -1.0, max: 1.0, step: 0.01 },
  backPitch:   { default: 0.18, min: -1.0, max: 1.0, step: 0.01 },
};

export const LION_DEFS = {
  maneTuftCount:     { default: 48,  min: 12, max: 96, step: 1 },
  maneSwayAmplitude: { default: 0.0, min: 0.0, max: 0.2, step: 0.005 }, // future use
  tailSwayY:         { default: 0.18, min: 0.0, max: 0.6, step: 0.01 },
  tailSwayZ:         { default: 0.10, min: 0.0, max: 0.6, step: 0.01 },
  tailSwayFreq:      { default: 1.4,  min: 0.1, max: 4.0, step: 0.05 },
};
```

(Match the surrounding file's exact convention — if it uses different keys like `kind` vs not, defaults inline vs separate, conform to it.)

- [ ] **Step 3: Plumb the lighting DEFS through `HumanoidRig`**

In `src/game/rig/HumanoidRig.ts`, after `this.lighting = createCreatureLighting()`, read `CREATURE_SHADING_DEFS` (or whatever the project's runtime accessor is — check `tweakDefs.ts` for an existing helper like `getDefault(key)`) and write the values into `this.lighting.wrapSoft.value`, `this.lighting.rimPower.value`, etc. Also wire `keyDir.value` from `keyYaw/keyPitch` (sphere-coords → vec3) and `backDir` similarly.

If the project has an existing live tweakpane subscription pattern (look at any other module that consumes `*_DEFS` — `scenery.ts` is a good example), wire to it the same way so `r`-reset and live edits work.

- [ ] **Step 4: Plumb tail/mane DEFS**

In `lionTail.ts`, accept the relevant params either as constructor args or via an injected `tweakables` object — match the pattern other modules use.

- [ ] **Step 5: Build + verify in debug mode**

Run: `npm run build` — expected PASS.
Run: `npm run dev`. Open the app, press `/` to open the debug overlay, find the new sections (Creature Shading, Lion), tweak a few values, confirm they update live. Press `r` and confirm everything snaps back to defaults. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add -u src/hud/tweakDefs.ts src/game/rig/HumanoidRig.ts src/game/rig/lionMane.ts src/game/rig/lionTail.ts
git commit -m "rig: tweakDefs — creature shading and lion params"
```

---

## Phase 3 — Multiplayer creature sync

### Task 14: Add `creature` column + `update_creature` reducer to SpacetimeDB

**Files:**
- Modify: `spacetimedb/src/index.ts`

- [ ] **Step 1: Read the current schema**

```bash
sed -n '1,40p' /Users/eric/codeprojects/JamTrain/spacetimedb/src/index.ts
```

Identify the `player` table declaration and the `request_seat` reducer. Note the exact pattern used to declare `instrument` (column declaration + default value in `request_seat` insert + the `update_instrument` reducer with `ALLOWED_INSTRUMENTS` set).

- [ ] **Step 2: Add the column**

In the `player` table, after the `instrument` line, add:
```ts
creature: t.string(),
```

- [ ] **Step 3: Add `creature: 'lion'` to the `request_seat` insert**

Wherever `request_seat` builds the new player row, add `creature: 'lion'` (place it next to the `instrument: 'flute'` line for clarity).

- [ ] **Step 4: Add the `update_creature` reducer**

After `update_instrument`, add:
```ts
const ALLOWED_CREATURES = new Set(['lion', 'human']);

export const update_creature = spacetimedb.reducer(
  { creature: t.string() },
  (ctx, { creature }) => {
    if (!ALLOWED_CREATURES.has(creature)) {
      throw new SenderError(`invalid creature: ${creature}`);
    }
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    ctx.db.player.identity.update({
      ...row,
      creature,
      updatedAt: ctx.timestamp,
    });
  }
);
```

- [ ] **Step 5: Build the spacetime module + regenerate client bindings**

The project's regen command is in `spacetime.json` or `package.json` scripts. Check the current `spacetime.json` and the `module_bindings/` git history for the exact command.

Run:
```bash
cat /Users/eric/codeprojects/JamTrain/spacetime.json
```

Then run the project's standard regen. If it isn't obvious, the typical SpacetimeDB CLI flow is:

```bash
cd spacetimedb && spacetime publish
spacetime generate --lang typescript --out-dir ../src/module_bindings
```

Expected: `src/module_bindings/` updated with a new `update_creature_reducer.ts` and the `player_table.ts` types now include `creature: string`.

- [ ] **Step 6: Build the client**

Run: `npm run build`
Expected: PASS — the new bindings type-check.

- [ ] **Step 7: Commit**

```bash
git add spacetimedb/src/index.ts src/module_bindings
git commit -m "schema: add creature column + update_creature reducer; default lion"
```

---

### Task 15: MultiplayerClient — creature state, listeners, persistence

**Files:**
- Modify: `src/game/multiplayer.ts`

- [ ] **Step 1: Read the existing instrument plumbing**

```bash
grep -n "instrument\|Instrument" /Users/eric/codeprojects/JamTrain/src/game/multiplayer.ts
```

Identify:
- The `localInstrument` and `partnerInstrument` fields and their defaults.
- The `setLocalInstrument(id)` method that calls the reducer.
- The `onLocalInstrumentChange` / `onPartnerInstrumentChange` listener pairs.
- Where `acceptOwnPlayer()` reads `row.instrument`.
- Where `updatePartner()` reads `row.instrument`.
- Where `partnerInstrument` is reset on disconnect.

- [ ] **Step 2: Mirror it for `creature`**

Add imports at top:
```ts
import { DEFAULT_CREATURE, isCreatureId, type CreatureId } from './creatures';
```

Add fields next to the instrument fields:
```ts
private localCreature: CreatureId = DEFAULT_CREATURE;
private partnerCreature: CreatureId = DEFAULT_CREATURE;
private localCreatureListeners = new Set<(id: CreatureId) => void>();
private partnerCreatureListeners = new Set<(id: CreatureId) => void>();
```

In the constructor (or wherever localInstrument is seeded), seed `localCreature` from `localStorage`:
```ts
const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('jamtrain.creature')) || '';
if (isCreatureId(stored)) this.localCreature = stored;
```

Add public methods (mirror of instrument):
```ts
getLocalCreature(): CreatureId { return this.localCreature; }
getPartnerCreature(): CreatureId { return this.partnerCreature; }

onLocalCreatureChange(listener: (id: CreatureId) => void): () => void {
  this.localCreatureListeners.add(listener);
  listener(this.localCreature);
  return () => { this.localCreatureListeners.delete(listener); };
}

onPartnerCreatureChange(listener: (id: CreatureId) => void): () => void {
  this.partnerCreatureListeners.add(listener);
  listener(this.partnerCreature);
  return () => { this.partnerCreatureListeners.delete(listener); };
}

setLocalCreature(id: CreatureId): void {
  if (id === this.localCreature) return;
  this.localCreature = id;
  if (typeof localStorage !== 'undefined') localStorage.setItem('jamtrain.creature', id);
  this.localCreatureListeners.forEach((fn) => fn(id));
  if (this.connection) {
    this.connection.reducers.updateCreature({ creature: id });
  }
}

private fireLocalCreature(id: CreatureId): void {
  if (id === this.localCreature) return;
  this.localCreature = id;
  if (typeof localStorage !== 'undefined') localStorage.setItem('jamtrain.creature', id);
  this.localCreatureListeners.forEach((fn) => fn(id));
}

private firePartnerCreature(id: CreatureId): void {
  if (id === this.partnerCreature) return;
  this.partnerCreature = id;
  this.partnerCreatureListeners.forEach((fn) => fn(id));
}
```

- [ ] **Step 3: Resolution between local and server in `acceptOwnPlayer()`**

In the existing `acceptOwnPlayer()` method, alongside the instrument resolution, add:

```ts
const serverCreature = isCreatureId(row.creature) ? row.creature : DEFAULT_CREATURE;
const hadStoredLocal =
  typeof localStorage !== 'undefined' && isCreatureId(localStorage.getItem('jamtrain.creature') ?? '');

if (hadStoredLocal && this.localCreature !== serverCreature) {
  // Local choice wins on first connect — push it up.
  this.connection.reducers.updateCreature({ creature: this.localCreature });
} else {
  // Adopt server value.
  this.fireLocalCreature(serverCreature);
}
```

- [ ] **Step 4: Read partner creature in `updatePartner()`**

Where `updatePartner()` reads `row.instrument` for the partner, add a sibling read for `creature`:

```ts
const nextCreature = isCreatureId(row.creature) ? row.creature : DEFAULT_CREATURE;
this.firePartnerCreature(nextCreature);
```

- [ ] **Step 5: Reset partnerCreature on disconnect**

Find the place that resets `partnerInstrument` to default on disconnect (recent commit `5f94524`); next to it, add:

```ts
this.firePartnerCreature(DEFAULT_CREATURE);
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -u src/game/multiplayer.ts
git commit -m "multiplayer: sync creature per player; localStorage persistence"
```

---

### Task 16: Wire creature listeners in `Game.ts`

**Files:**
- Modify: `src/game/Game.ts`

- [ ] **Step 1: Subscribe local + partner creature listeners**

Find where `Game` listens to `onLocalInstrumentChange` / `onPartnerInstrumentChange` (or where it constructs the rigs). Add parallel subscriptions following whatever pattern the instrument listeners use. Conceptually:

```ts
this.disposers.push(
  this.multiplayer.onLocalCreatureChange((id) => {
    this.localRig.setCreature(id);
  }),
  this.multiplayer.onPartnerCreatureChange((id) => {
    this.partnerRig.setCreature(id);
  })
);
```

**Adjust to the actual class.** The rig fields in `Game.ts` may be named differently (e.g. `selfRig` / `partnerRig`, or stored in a Map); the cleanup collection may be `disposers`, `cleanups`, `unsubs`, or absent — read `Game.ts` first and mirror exactly what the instrument listeners do.

- [ ] **Step 2: Construct rigs with the right initial creature**

When constructing the local rig, use `this.multiplayer.getLocalCreature()` instead of hard-coded `'lion'`:
```ts
new HumanoidRig(scene, {
  seatIndex: localSeat,
  color: localColor,
  creature: this.multiplayer.getLocalCreature(),
});
```

For the partner rig, use `this.multiplayer.getPartnerCreature()`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual sync check**

Open two browser tabs to `npm run dev`. Both should show lions. The local creature can't be changed yet (picker UI ships next), but verify the schema sync by running this in one tab's devtools console:

```js
// Replace `multiplayer` with the actual exposed instance — the Game class typically
// exposes itself on window during dev. If not, skip this step and verify in Task 19.
window.__game?.multiplayer?.setLocalCreature('human');
```

Confirm the other tab's partner rig swaps to a human. If `__game` isn't exposed, defer this verification to Task 19 (which adds the picker UI and provides a real way to trigger the swap).

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add -u src/game/Game.ts
git commit -m "game: wire local + partner creature listeners; init from MultiplayerClient"
```

---

## Phase 4 — HUD picker

### Task 17: Make the medallion creature-aware

**Files:**
- Modify: `src/hud/components/Medallion.ts`
- Modify: `src/hud/components/PlayerPlaque.ts`

- [ ] **Step 1: Read the current Medallion**

```bash
cat /Users/eric/codeprojects/JamTrain/src/hud/components/Medallion.ts
```

Note its current API — `createMedallion(robot: boolean)`. We'll change it to take a creature instead.

- [ ] **Step 2: Replace the Medallion API**

Edit `src/hud/components/Medallion.ts`:

```ts
import { CREATURES, type CreatureId } from '../../game/creatures';

export function createMedallion(creature: CreatureId): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `medallion-icon medallion-${creature}`;
  wrap.innerHTML = CREATURES[creature].iconSvg;
  wrap.setAttribute('aria-label', CREATURES[creature].label);
  return wrap;
}
```

(If the existing Medallion does more — gradient backgrounds, animations — preserve all of that and only swap what determines the silhouette/label. Read the file fully before editing.)

- [ ] **Step 3: Update `PlayerPlaque` to accept and store a creature**

Edit `src/hud/components/PlayerPlaque.ts`:

Replace the `currentRobot: boolean` field with `currentCreature: CreatureId`. Replace the `kind === 'automaton'` derivation with a new `creature` constructor option. Update the `set(...)` method's signature to take `creature: CreatureId` and re-render the medallion when it changes.

```ts
import { appendRivets } from './Rivets';
import { createMedallion } from './Medallion';
import type { CreatureId } from '../../game/creatures';

export type PlayerSide = 'left' | 'right';
export type PlayerKind = 'conductor' | 'passenger' | 'automaton';

export class PlayerPlaque {
  readonly el: HTMLElement;
  readonly medallionWrap: HTMLElement;
  private side: PlayerSide;
  private stampEl: HTMLElement;
  private nameEl: HTMLElement;
  private voiceEl: HTMLElement;
  private currentCreature: CreatureId;

  constructor(opts: {
    side: PlayerSide;
    name: string;
    voice: string;
    kind: PlayerKind;
    creature: CreatureId;
  }) {
    this.side = opts.side;
    this.currentCreature = opts.creature;

    this.el = document.createElement('div');
    this.el.className = `plaque player-plaque ${opts.side}`;
    appendRivets(this.el);

    this.medallionWrap = document.createElement('div');
    this.medallionWrap.className = 'medallion';
    this.medallionWrap.appendChild(createMedallion(this.currentCreature));
    this.el.appendChild(this.medallionWrap);

    this.stampEl = document.createElement('div');
    this.stampEl.className = 'stamp';
    this.stampEl.textContent = stampFor(opts.kind);
    this.el.appendChild(this.stampEl);

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'name';
    this.nameEl.textContent = opts.name;
    this.el.appendChild(this.nameEl);

    this.voiceEl = document.createElement('div');
    this.voiceEl.className = 'voice';
    this.voiceEl.textContent = opts.voice;
    this.el.appendChild(this.voiceEl);
  }

  set(opts: { name: string; voice: string; kind: PlayerKind; creature: CreatureId }): void {
    this.nameEl.textContent = opts.name;
    this.voiceEl.textContent = opts.voice;
    this.stampEl.textContent = stampFor(opts.kind);
    if (opts.creature !== this.currentCreature) {
      this.currentCreature = opts.creature;
      this.medallionWrap.replaceChildren(createMedallion(opts.creature));
    }
  }
}

function stampFor(kind: PlayerKind): string {
  switch (kind) {
    case 'conductor': return '· Conductor ·';
    case 'passenger': return '· Passenger ·';
    case 'automaton': return '· Automaton ·';
  }
}
```

Note `medallionWrap` is now `readonly` and public — the picker mounts under it in Task 19.

- [ ] **Step 4: Update every `PlayerPlaque` constructor call site**

```bash
grep -rn "new PlayerPlaque\|playerPlaque.set\|plaque.set" /Users/eric/codeprojects/JamTrain/src
```

Add `creature: <appropriate value>` to each call. For local plaque: `this.multiplayer.getLocalCreature()`. For partner plaque: `this.multiplayer.getPartnerCreature()`. For `set(...)` inside an update path: pass through whatever the most recent known creature is.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS. If any caller still passes `kind: 'automaton'` derivation as a robot signal, just stop using it (the kind enum stays for the stamp text — only the medallion logic changed).

- [ ] **Step 6: Commit**

```bash
git add -u src/hud/components/Medallion.ts src/hud/components/PlayerPlaque.ts
# also any call sites updated
git commit -m "hud: medallion + plaque take creature instead of robot bool"
```

---

### Task 18: CreaturePicker popover component

**Files:**
- Create: `src/hud/components/CreaturePicker.ts`
- Modify: `src/hud/style.css` (add styles for the picker)

- [ ] **Step 1: Create the popover**

```ts
// src/hud/components/CreaturePicker.ts
import { CREATURE_IDS, CREATURES, type CreatureId } from '../../game/creatures';

export type CreaturePickerOptions = {
  initial: CreatureId;
  onPick: (id: CreatureId) => void;
};

/**
 * A small popover with one button per creature. Shows below the medallion it's
 * anchored to. The caller is responsible for mounting / unmounting.
 */
export class CreaturePicker {
  readonly el: HTMLElement;
  private current: CreatureId;
  private buttons = new Map<CreatureId, HTMLButtonElement>();

  constructor(opts: CreaturePickerOptions) {
    this.current = opts.initial;
    this.el = document.createElement('div');
    this.el.className = 'creature-picker';
    this.el.setAttribute('role', 'menu');

    for (const id of CREATURE_IDS) {
      const meta = CREATURES[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'creature-picker-option';
      btn.dataset.creature = id;
      btn.setAttribute('aria-label', meta.label);
      btn.title = `${meta.label} — ${meta.subtitle}`;
      btn.innerHTML = meta.iconSvg;
      btn.addEventListener('click', () => {
        if (id === this.current) return;
        opts.onPick(id);
      });
      this.buttons.set(id, btn);
      this.el.appendChild(btn);
    }
    this.applySelection();
  }

  setCurrent(id: CreatureId): void {
    if (id === this.current) return;
    this.current = id;
    this.applySelection();
  }

  private applySelection(): void {
    for (const [id, btn] of this.buttons.entries()) {
      btn.classList.toggle('is-selected', id === this.current);
    }
  }
}
```

- [ ] **Step 2: Add CSS for the picker**

Append to `src/hud/style.css`:

```css
.medallion {
  position: relative;
  cursor: pointer; /* local plaque only — see PlayerPlaque toggle */
}

.medallion[data-readonly="true"] {
  cursor: default;
}

.creature-picker {
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translate(-50%, 6px);
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 14px;
  background: rgba(20, 24, 32, 0.92);
  border: 1px solid rgba(255, 230, 180, 0.18);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
  z-index: 30;
  pointer-events: auto;
  animation: creature-picker-pop 120ms ease-out;
}

@keyframes creature-picker-pop {
  from { opacity: 0; transform: translate(-50%, 0); }
  to   { opacity: 1; transform: translate(-50%, 6px); }
}

.creature-picker-option {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.10);
  color: #f6c66a;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.creature-picker-option:hover {
  background: rgba(255, 230, 180, 0.06);
  border-color: rgba(255, 230, 180, 0.28);
}

.creature-picker-option.is-selected {
  background: rgba(255, 230, 180, 0.10);
  border-color: rgba(255, 230, 180, 0.50);
  box-shadow: 0 0 0 2px rgba(255, 198, 106, 0.20);
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hud/components/CreaturePicker.ts src/hud/style.css
git commit -m "hud: CreaturePicker popover component + styles"
```

---

### Task 19: Mount picker on local medallion + wire it up

**Files:**
- Modify: `src/hud/Hud.ts`
- Possibly: `src/hud/components/PlayerPlaque.ts` (helper accessor for medallion)

- [ ] **Step 1: Read the current Hud wiring**

```bash
cat /Users/eric/codeprojects/JamTrain/src/hud/Hud.ts
```

Identify:
- Where the local `PlayerPlaque` is constructed.
- Where the partner `PlayerPlaque` is constructed.
- Where update paths call `plaque.set(...)`.
- What multiplayer reference is available.

- [ ] **Step 2: Mount the picker on the local medallion**

After constructing the local `PlayerPlaque` in `Hud.ts`, wire up the picker:

```ts
import { CreaturePicker } from './components/CreaturePicker';

// ... after `this.localPlaque = new PlayerPlaque({ ..., creature: localCreature });`

const localMedallion = this.localPlaque.medallionWrap;
localMedallion.setAttribute('role', 'button');
localMedallion.setAttribute('tabindex', '0');
localMedallion.setAttribute('aria-haspopup', 'menu');

let picker: CreaturePicker | null = null;
const closePicker = () => {
  if (!picker) return;
  picker.el.remove();
  picker = null;
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('keydown', onDocKey);
};
const onDocClick = (e: MouseEvent) => {
  if (!picker) return;
  if (!localMedallion.contains(e.target as Node) && !picker.el.contains(e.target as Node)) {
    closePicker();
  }
};
const onDocKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') closePicker();
};
const togglePicker = () => {
  if (picker) { closePicker(); return; }
  picker = new CreaturePicker({
    initial: this.multiplayer.getLocalCreature(),
    onPick: (id) => {
      this.multiplayer.setLocalCreature(id);
      closePicker();
    },
  });
  localMedallion.appendChild(picker.el);
  // Defer doc-listener attach to avoid the same click closing it.
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onDocKey);
  }, 0);
};
localMedallion.addEventListener('click', togglePicker);
localMedallion.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    togglePicker();
  }
});

// Keep picker selection in sync if creature changes from elsewhere (server push).
// Use whatever cleanup pattern Hud already has — mirror the instrument listener.
this.disposers.push(
  this.multiplayer.onLocalCreatureChange((id) => {
    if (picker) picker.setCurrent(id);
    this.localPlaque.set({ /* existing fields */ creature: id });
  })
);
```

(Adapt the `this.localPlaque.set(...)` call to whatever the existing call shape looks like — pass through current `name`, `voice`, `kind` alongside the new `creature`.)

- [ ] **Step 3: Mark partner medallion as read-only**

After constructing the partner `PlayerPlaque`:

```ts
this.partnerPlaque.medallionWrap.setAttribute('data-readonly', 'true');
this.disposers.push(
  this.multiplayer.onPartnerCreatureChange((id) => {
    this.partnerPlaque.set({ /* existing fields */ creature: id });
  })
);
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual end-to-end smoke test**

Run: `npm run dev`. Open two browser tabs. In each:

1. Click through `BeginGate`.
2. Confirm the avatar is a lion in both tabs.
3. Click your medallion → popover appears with lion + human icons. Lion is highlighted.
4. Click human → popover closes, your avatar swaps to human in place (head/accessories/materials change, body skeleton stays driven by your hands). The other tab's partner rig also swaps to human within ~1 second.
5. Click your medallion again, click lion → swap back. Other tab follows.
6. Refresh your tab. Your avatar comes back as human (because your `localStorage` was set to human, and per the resolution rule the local value wins on reconnect).
7. Click outside the popover or press `Escape` → popover closes.
8. Confirm the partner medallion in your tab is **not** clickable (no popover opens, cursor is default).

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add -u src/hud/Hud.ts src/hud/components/PlayerPlaque.ts
git commit -m "hud: mount CreaturePicker on local medallion; wire partner read-only"
```

---

## Phase 5 — Final verification

### Task 20: Final build + smoke test

- [ ] **Step 1: Type-check + production build**

Run: `npm run build`
Expected: PASS — no `tsc` errors, vite build completes.

- [ ] **Step 2: Full smoke walkthrough**

Run: `npm run dev`. Walk through:

1. Open one tab, click `BeginGate` Start → see lion in train.
2. Press `/` to open debug overlay → confirm `Creature Shading` and `Lion` sections exist with their controls. Tweak `rimStrength` higher → confirm rim glow visibly increases on the lion. Press `r` → defaults restore.
3. Open second tab, click Start → see lion in your view + the partner sees lion in theirs.
4. Click your medallion → popover, swap to human → both tabs see your rig change to human in place. Hand-tracking continues uninterrupted.
5. Refresh tab 1 → comes back as human (localStorage). Refresh tab 2 → also comes back as whatever it picked last.
6. Disconnect tab 2 (close it). Tab 1's partner rig should reset to lion (default per `firePartnerCreature(DEFAULT_CREATURE)` on disconnect).
7. Confirm instrument visuals (Ribbon/Bloom/Sparks) still anchor between palms correctly on both creatures.

Stop the dev server.

- [ ] **Step 3: Confirm no lingering references to old types**

```bash
grep -rn "PlayerRig\|robotMaterial\|robotBlend\|MeshStandardMaterial" /Users/eric/codeprojects/JamTrain/src
```

Expected: No matches in `src/`. (If `MeshStandardMaterial` is referenced anywhere outside `node_modules`, investigate and either replace with TSL node material or document why it's allowed.)

- [ ] **Step 4: Commit any final cleanup**

If Step 3 found leftovers and you fixed them:
```bash
git add -u
git commit -m "creatures: remove legacy PlayerRig / robot references"
```

If nothing to commit, skip.
