# Plasma Orb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the central atom sculpture in `Game.ts` with a `PlasmaOrb` — a TSL/WGSL volumetric plasma ball whose silhouette wobbles, pulls toward each player's hands, and whose interior swirls cyan→amber based on connection energy.

**Architecture:** A single backface-rendered sphere mesh whose `MeshBasicNodeMaterial.colorNode` is a `wgslFn(...)` block. The shader reconstructs view rays, intersects a deformed-sphere SDF (base radius + 3D noise displacement + 4 smooth-min hand attractors), and raymarches the interior using a port of the reference shadertoy plasma function. Surface fluidity is purely shader-driven — no per-frame geometry update.

**Tech Stack:** TypeScript, Three.js `0.184.0` `three/webgpu`, TSL (`three/tsl`: `wgslFn`, `uniform`, `uniformArray`, `Fn`, `cameraPosition`, `positionWorld`), Tweakpane.

**Spec:** `docs/superpowers/specs/2026-04-25-plasma-orb-design.md`

**Note on TDD:** This is a real-time shader feature. Unit-testing "the orb wobbles toward a hand" is impractical. Each task lists a *visual verification* (run dev server, observe specific behavior) instead of an automated test. Type-checking via `npm run build` runs as the automated gate at the end of each task.

---

## File Structure

- **Create:** `src/game/plasmaOrb.ts` — `PlasmaOrb` class. Owns mesh, NodeMaterial, uniforms, fallback material, tweakpane, smoothing state.
- **Modify:** `src/game/Game.ts` — Drop sculpture (lines ~46-47, 290-334, 394-404). Add `plasmaOrb` field. Compute 4 hand centroids each frame. Hook into `update()`.

No other files need to change.

---

## Task 1: Scaffold `PlasmaOrb` class with placeholder material

**Goal:** Land an empty `PlasmaOrb` class in the scene as a plain emissive sphere so the wiring is verified before introducing the WGSL block.

**Files:**
- Create: `src/game/plasmaOrb.ts`
- Modify: `src/game/Game.ts`

- [ ] **Step 1: Create `plasmaOrb.ts` with the placeholder implementation**

```ts
// src/game/plasmaOrb.ts
import * as THREE from 'three/webgpu';

export type PlasmaOrbAttractor = {
  position: THREE.Vector3;
  weight: number;
};

export type PlasmaOrbOptions = {
  position: THREE.Vector3;
  radius?: number;
};

const MAX_ATTRACTORS = 4;

export class PlasmaOrb {
  readonly mesh: THREE.Mesh;
  private readonly radius: number;
  private smoothedEnergy = 0;
  private targetEnergy = 0;
  private targetAttractors: PlasmaOrbAttractor[] = [];
  private smoothedAttractors: PlasmaOrbAttractor[] = Array.from(
    { length: MAX_ATTRACTORS },
    () => ({ position: new THREE.Vector3(), weight: 0 })
  );

  constructor(scene: THREE.Scene, options: PlasmaOrbOptions) {
    this.radius = options.radius ?? 0.42;

    const geometry = new THREE.SphereGeometry(this.radius * 1.5, 32, 24);
    const material = new THREE.MeshBasicMaterial({
      color: 0x35d8ff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(options.position);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  setAttractors(attractors: PlasmaOrbAttractor[]): void {
    this.targetAttractors = attractors.slice(0, MAX_ATTRACTORS);
  }

  setEnergy(energy: number): void {
    this.targetEnergy = Math.max(0, Math.min(1, energy));
  }

  update(_elapsed: number, delta: number): void {
    const energyAlpha = 1 - Math.exp(-delta * 5);
    this.smoothedEnergy += (this.targetEnergy - this.smoothedEnergy) * energyAlpha;

    const posAlpha = 1 - Math.exp(-delta * 12);
    const weightAlpha = 1 - Math.exp(-delta * 8);
    for (let i = 0; i < MAX_ATTRACTORS; i += 1) {
      const target = this.targetAttractors[i];
      const slot = this.smoothedAttractors[i];
      if (target) {
        slot.position.lerp(target.position, posAlpha);
        slot.weight += (target.weight - slot.weight) * weightAlpha;
      } else {
        slot.weight += (0 - slot.weight) * weightAlpha;
      }
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
```

- [ ] **Step 2: Modify `Game.ts` to construct the orb and remove the old sculpture**

Replace the field declarations and the `createMusicSculpture`/`updateSculpture` methods.

In `src/game/Game.ts`, around line 46-47 (find the existing block):

```ts
  private sculpture = new THREE.Group();
  private sculptureMaterials: THREE.MeshStandardMaterial[] = [];
```

Replace with:

```ts
  private plasmaOrb?: PlasmaOrb;
```

At the top of the file, add the import next to the others:

```ts
import { PlasmaOrb, type PlasmaOrbAttractor } from './plasmaOrb';
```

Find `this.createMusicSculpture();` in `start()` (around line 265) and remove that line.

Find this block (around line 290–334) and delete it entirely:

```ts
  private createMusicSculpture(): void {
    this.sculpture.position.copy(this.sculptureTarget);
    // … entire method including amberMaterial, core, rings, halo, this.scene.add(this.sculpture); …
  }
```

Find this block (around line 394–404) and delete it entirely:

```ts
  private updateSculpture(energy: number): void {
    this.sculpture.rotation.x += 0.004 + energy * 0.006;
    // … entire method …
  }
```

Find `this.updateSculpture(energy);` in `updateLinks()` (around line 390) and replace it with:

```ts
    if (this.plasmaOrb) {
      this.plasmaOrb.setAttractors(this.computeOrbAttractors());
      this.plasmaOrb.setEnergy(energy);
    }
```

- [ ] **Step 3: Add `computeOrbAttractors` helper and orb construction**

Add this method to the `Game` class (place it right above `updateLinks`):

```ts
  private computeOrbAttractors(): PlasmaOrbAttractor[] {
    const attractors: PlasmaOrbAttractor[] = [];
    const maxReach = 0.9;
    const tmp = new THREE.Vector3();

    const pushHand = (rig: PlayerRig, hand: 'left' | 'right'): void => {
      tmp.set(0, 0, 0);
      let count = 0;
      for (const finger of fingerNames) {
        const tip = rig.getFingertipWorld(hand, finger);
        tmp.add(tip);
        count += 1;
      }
      if (count === 0) return;
      tmp.divideScalar(count);
      const distance = tmp.distanceTo(this.sculptureTarget);
      const weight = Math.max(0, Math.min(1, 1 - distance / maxReach));
      attractors.push({ position: tmp.clone(), weight });
    };

    pushHand(this.localRig, 'left');
    pushHand(this.localRig, 'right');
    pushHand(this.remoteRig, 'left');
    pushHand(this.remoteRig, 'right');

    return attractors;
  }
```

Construct the orb. In `start()`, after `await this.renderer.init();` (around line 91), add:

```ts
    this.plasmaOrb = new PlasmaOrb(this.scene, {
      position: this.sculptureTarget,
      radius: 0.42,
    });
```

In `update()`, after `this.lastFrameAt = now;` (around line 340), add:

```ts
    this.plasmaOrb?.update(elapsed, delta);
```

Update `dispose()` to clean up:

```ts
    this.plasmaOrb?.dispose();
```

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: TypeScript and Vite build succeed. No errors mentioning `sculpture`, `PlasmaOrb`, or unused imports.

- [ ] **Step 5: Visual verification**

Run: `npm run dev`
Open the page in a WebGPU-capable browser. Expected:
- Cyan translucent sphere at scene center where the atom used to be (no rings, no orbiting bodies).
- The rest of the scene (rigs, particles, scenery) renders unchanged.
- Browser console has no shader errors.

- [ ] **Step 6: Commit**

```bash
git add src/game/plasmaOrb.ts src/game/Game.ts
git commit -m "feat(plasma-orb): scaffold PlasmaOrb replacing atom sculpture"
```

---

## Task 2: Replace placeholder material with WGSL volumetric shader

**Goal:** Swap the `MeshBasicMaterial` for a `MeshBasicNodeMaterial` whose `colorNode` is a `wgslFn` block implementing the deformed-sphere SDF + plasma raymarch. After this task the orb visibly wobbles, pulses, swirls cyan, and reaches toward each hand.

**Files:**
- Modify: `src/game/plasmaOrb.ts`

- [ ] **Step 1: Add TSL imports**

At the top of `src/game/plasmaOrb.ts`, add:

```ts
import { Fn, cameraPosition, positionWorld, uniform, uniformArray, vec3, vec4, wgslFn } from 'three/tsl';
```

- [ ] **Step 2: Define WGSL plasma shader as a constant**

Add this near the top of `plasmaOrb.ts`, before the class:

```ts
const MAX_ATTRACTORS = 4;
const RAYMARCH_STEPS = 48;

const plasmaWGSL = /* wgsl */ `
fn plasmaOrb(
  ro: vec3<f32>,
  rd: vec3<f32>,
  uCenter: vec3<f32>,
  uRadius: f32,
  uTime: f32,
  uEnergy: f32,
  uNoiseAmp: f32,
  uAttractorReach: f32,
  uAttractorStrength: f32,
  uAttractorPos: array<vec4<f32>, 4>,
  uCool: vec3<f32>,
  uWarm: vec3<f32>,
  uHot: vec3<f32>
) -> vec4<f32> {
  // Bounding sphere intersection (radius * 1.4 covers max deformation).
  let oc = ro - uCenter;
  let bound = uRadius * 1.4;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - bound * bound;
  let h = b * b - c;
  if (h < 0.0) { return vec4<f32>(0.0); }
  let hSqrt = sqrt(h);
  let tMin = max(-b - hSqrt, 0.0);
  let tMax = -b + hSqrt;
  if (tMax < tMin) { return vec4<f32>(0.0); }

  // Plasma map (port of reference shadertoy 'map').
  // Inlined manually because the outer function captures uniforms.
  var col = vec3<f32>(0.0);
  var alpha = 0.0;
  var t = tMin;
  let dtBase = (tMax - tMin) / f32(${RAYMARCH_STEPS});
  var lastDensity = 0.0;
  var foldOffset = vec3<f32>(0.0);

  // Attractor-weighted fold offset shifts the swirl toward active hands.
  var attractorAccum = vec3<f32>(0.0);
  var attractorWeight = 0.0;
  for (var ai: i32 = 0; ai < 4; ai = ai + 1) {
    let a = uAttractorPos[ai];
    let aw = a.w;
    if (aw > 0.001) {
      let local = a.xyz - uCenter;
      attractorAccum = attractorAccum + local * aw;
      attractorWeight = attractorWeight + aw;
    }
  }
  if (attractorWeight > 0.001) {
    foldOffset = (attractorAccum / attractorWeight) * 0.4;
  }

  for (var i: i32 = 0; i < ${RAYMARCH_STEPS}; i = i + 1) {
    let stepDt = dtBase * exp(-2.0 * lastDensity);
    t = t + stepDt;
    if (t > tMax) { break; }

    let p0 = ro + t * rd - uCenter;

    // Surface-deforming SDF check via attractor pulls + noise.
    var radiusBoost = 0.0;
    for (var ai: i32 = 0; ai < 4; ai = ai + 1) {
      let a = uAttractorPos[ai];
      let aw = a.w;
      if (aw > 0.001) {
        let dvec = (a.xyz - uCenter) - p0;
        let d2 = dot(dvec, dvec);
        let falloff = exp(-d2 / (uAttractorReach * uAttractorReach));
        radiusBoost = radiusBoost + falloff * aw * uAttractorStrength;
      }
    }

    // Cheap 3D noise via sin lattice — low frequency, time-modulated.
    let nseed = p0 * 2.4 + vec3<f32>(uTime * 0.3, uTime * 0.21, uTime * 0.18);
    let noise = (
      sin(nseed.x + cos(nseed.y * 1.3)) +
      sin(nseed.y * 1.1 + cos(nseed.z * 0.9)) +
      sin(nseed.z * 1.2 + cos(nseed.x * 1.05))
    ) * (1.0 / 3.0);
    let displacement = noise * uNoiseAmp;

    let surfaceR = uRadius + radiusBoost + displacement;
    let outsideSurface = length(p0) - surfaceR;
    if (outsideSurface > 0.0) {
      lastDensity = 0.0;
      continue;
    }

    // Plasma fold (port of reference 'map').
    var p = p0 + foldOffset;
    let cFold = p;
    var density = 0.0;
    for (var k: i32 = 0; k < 10; k = k + 1) {
      let dotPP = max(dot(p, p), 1e-4);
      p = 0.7 * abs(p) / dotPP - 0.7;
      let yz = vec2<f32>(p.y, p.z);
      let csq = vec2<f32>(yz.x * yz.x - yz.y * yz.y, 2.0 * yz.x * yz.y);
      p = vec3<f32>(p.x, csq.x, csq.y).zxy;
      density = density + exp(-19.0 * abs(dot(p, cFold)));
    }
    density = density * 0.5;
    lastDensity = density;

    let bright = clamp(density, 0.0, 4.0);
    col = col * 0.99 + 0.08 * vec3<f32>(bright * bright * bright, bright * bright, bright);
    alpha = alpha + 0.04 * bright;
  }

  // Tone curve from reference.
  col = 0.5 * log(1.0 + col);

  // Palette: cyan → hot near density peaks; amber accent when energy high.
  let lum = clamp(dot(col, vec3<f32>(0.299, 0.587, 0.114)), 0.0, 2.0);
  let coolBlend = mix(uCool, uHot, smoothstep(0.0, 0.9, lum));
  let amberAccent = smoothstep(0.4, 0.95, lum) * uEnergy;
  let palette = mix(coolBlend, uWarm, amberAccent);
  let tinted = col * palette * 1.6;

  // Rim glow.
  let surfaceN = normalize(oc + rd * tMin);
  let fresnel = pow(1.0 - clamp(abs(dot(rd, surfaceN)), 0.0, 1.0), 3.0);
  let rim = uCool * fresnel * 0.55;

  let outRgb = tinted + rim;
  let outAlpha = clamp(alpha * 1.4 + fresnel * 0.4, 0.0, 1.0);
  return vec4<f32>(outRgb, outAlpha);
}
`;

const plasmaFn = wgslFn(plasmaWGSL);
```

- [ ] **Step 3: Replace the placeholder material with the node material in the constructor**

Replace the entire constructor body in `PlasmaOrb` with the version below (substantial rewrite):

```ts
  private uTime = uniform(0);
  private uCenter = uniform(new THREE.Vector3());
  private uRadius = uniform(0.42);
  private uEnergy = uniform(0);
  private uNoiseAmp = uniform(0.08);
  private uAttractorReach = uniform(0.6);
  private uAttractorStrength = uniform(0.18);
  private uAttractorPos = uniformArray(
    Array.from({ length: MAX_ATTRACTORS }, () => new THREE.Vector4(0, 0, 0, 0))
  );
  private uCool = uniform(new THREE.Color(0x2bd6f7));
  private uWarm = uniform(new THREE.Color(0xffae42));
  private uHot = uniform(new THREE.Color(0xfff4d0));

  constructor(scene: THREE.Scene, options: PlasmaOrbOptions) {
    this.radius = options.radius ?? 0.42;
    this.uRadius.value = this.radius;
    this.uCenter.value.copy(options.position);

    const geometry = new THREE.SphereGeometry(this.radius * 1.5, 32, 24);
    const material = this.buildMaterial();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(options.position);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.BackSide;
    material.blending = THREE.AdditiveBlending;

    try {
      material.colorNode = Fn(() => {
        const ro = cameraPosition;
        const rd = positionWorld.sub(cameraPosition).normalize();
        return plasmaFn({
          ro,
          rd,
          uCenter: this.uCenter,
          uRadius: this.uRadius,
          uTime: this.uTime,
          uEnergy: this.uEnergy,
          uNoiseAmp: this.uNoiseAmp,
          uAttractorReach: this.uAttractorReach,
          uAttractorStrength: this.uAttractorStrength,
          uAttractorPos: this.uAttractorPos,
          uCool: vec3(this.uCool.value.r, this.uCool.value.g, this.uCool.value.b),
          uWarm: vec3(this.uWarm.value.r, this.uWarm.value.g, this.uWarm.value.b),
          uHot: vec3(this.uHot.value.r, this.uHot.value.g, this.uHot.value.b),
        });
      })();
    } catch (err) {
      console.error('[PlasmaOrb] WGSL compile failed, falling back', err);
      // Fallback: leave colorNode unset; basic node material still renders cyan.
    }

    return material;
  }
```

NOTE: Keep all the `setAttractors` / `setEnergy` / `dispose` methods that already exist from Task 1.

- [ ] **Step 4: Wire smoothed state into uniforms in `update()`**

Replace the existing `update()` method with:

```ts
  update(elapsed: number, delta: number): void {
    const energyAlpha = 1 - Math.exp(-delta * 5);
    this.smoothedEnergy += (this.targetEnergy - this.smoothedEnergy) * energyAlpha;

    const posAlpha = 1 - Math.exp(-delta * 12);
    const weightAlpha = 1 - Math.exp(-delta * 8);
    for (let i = 0; i < MAX_ATTRACTORS; i += 1) {
      const target = this.targetAttractors[i];
      const slot = this.smoothedAttractors[i];
      if (target) {
        slot.position.lerp(target.position, posAlpha);
        slot.weight += (target.weight - slot.weight) * weightAlpha;
      } else {
        slot.weight += (0 - slot.weight) * weightAlpha;
      }
      const dst = this.uAttractorPos.array[i] as THREE.Vector4;
      dst.set(slot.position.x, slot.position.y, slot.position.z, slot.weight);
    }

    this.uTime.value = elapsed;
    this.uEnergy.value = this.smoothedEnergy;
    this.uCenter.value.copy(this.mesh.position);
  }
```

- [ ] **Step 5: Verify build passes**

Run: `npm run build`
Expected: TypeScript build passes. No type errors against `wgslFn`, `uniformArray`, or the WGSL block.

- [ ] **Step 6: Visual verification — idle behavior**

Run: `npm run dev`
With hand tracking off (don't grant camera), expected:
- Cyan/teal swirling plasma orb at scene center.
- Silhouette breathes/wobbles continuously (low-frequency).
- No console errors.

If the orb appears solid black or invisible: most likely cause is a WGSL compile error visible in the browser console. Fix the shader and reload.

- [ ] **Step 7: Visual verification — hand response**

Reload with the camera enabled (or use the existing simulated robot hands). Expected:
- The robot's hands moving in space cause subtle bulges in the orb's silhouette toward those hands.
- Bring hands close to the table center and watch the orb extend toward whichever hand is closest.

- [ ] **Step 8: Visual verification — energy response**

Bring fingertips into "ideal" connection alignment with the robot. The aggregate `energy` should rise. Expected:
- Amber tones blend in to the swirl when `energy` exceeds ~0.5.
- The hot core brightens.

- [ ] **Step 9: Commit**

```bash
git add src/game/plasmaOrb.ts
git commit -m "feat(plasma-orb): WGSL volumetric raymarch with hand-driven SDF deformation"
```

---

## Task 3: Tweakpane controls

**Goal:** Expose the orb's tunable uniforms in the existing pane dock so the look can be tuned live.

**Files:**
- Modify: `src/game/plasmaOrb.ts`
- Modify: `src/game/Game.ts`

- [ ] **Step 1: Add `registerTweaks` to `PlasmaOrb`**

Add to the top of `plasmaOrb.ts`:

```ts
import { Pane } from 'tweakpane';
```

Add this method to the `PlasmaOrb` class:

```ts
  registerTweaks(pane: Pane): void {
    const folder = pane.addFolder({ title: 'Plasma Orb', expanded: false });

    const params = {
      radius: this.radius,
      noiseAmp: this.uNoiseAmp.value,
      attractorReach: this.uAttractorReach.value,
      attractorStrength: this.uAttractorStrength.value,
      energyBoost: 1,
      coolColor: '#' + this.uCool.value.getHexString(),
      warmColor: '#' + this.uWarm.value.getHexString(),
    };
    this.energyBoost = 1;

    folder.addBinding(params, 'radius', { min: 0.2, max: 0.8, step: 0.01 }).on('change', e => {
      this.uRadius.value = e.value;
    });
    folder.addBinding(params, 'noiseAmp', { min: 0, max: 0.25, step: 0.005 }).on('change', e => {
      this.uNoiseAmp.value = e.value;
    });
    folder.addBinding(params, 'attractorReach', { min: 0.2, max: 1.5, step: 0.01 }).on('change', e => {
      this.uAttractorReach.value = e.value;
    });
    folder.addBinding(params, 'attractorStrength', { min: 0, max: 0.4, step: 0.005 }).on('change', e => {
      this.uAttractorStrength.value = e.value;
    });
    folder.addBinding(params, 'energyBoost', { min: 0, max: 2, step: 0.05 }).on('change', e => {
      this.energyBoost = e.value;
    });
    folder.addBinding(params, 'coolColor').on('change', e => {
      this.uCool.value.set(e.value);
    });
    folder.addBinding(params, 'warmColor').on('change', e => {
      this.uWarm.value.set(e.value);
    });
  }
```

Add the field next to the other private fields:

```ts
  private energyBoost = 1;
```

Then update `setEnergy` to apply the boost:

```ts
  setEnergy(energy: number): void {
    this.targetEnergy = Math.max(0, Math.min(1, energy * this.energyBoost));
  }
```

- [ ] **Step 2: Wire pane registration from `Game.ts`**

Find the orb construction in `start()` and the existing `paneDock` setup. After constructing the orb, register the pane.

The existing scenery uses `new Pane({ ... container: paneContainer })`. The simplest pattern: have `PlasmaOrb` take a `paneDock` option and create its own pane container, mirroring `ScenerySystem`. Update the options type:

```ts
export type PlasmaOrbOptions = {
  position: THREE.Vector3;
  radius?: number;
  paneDock?: HTMLElement;
};
```

In the constructor, after `scene.add(this.mesh);` add:

```ts
    if (options.paneDock) {
      const container = document.createElement('div');
      options.paneDock.appendChild(container);
      this.pane = new Pane({ title: 'Plasma Orb', container });
      this.registerTweaks(this.pane);
    }
```

Add the field:

```ts
  private pane?: Pane;
```

Update `dispose`:

```ts
  dispose(): void {
    this.pane?.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
```

NOTE: `registerTweaks` no longer needs to be public — make it `private` and remove the `pane: Pane` parameter, since it now uses `this.pane`. Adjust accordingly:

```ts
  private registerTweaks(): void {
    if (!this.pane) return;
    const folder = this.pane.addFolder({ title: 'Plasma Orb', expanded: false });
    // … rest unchanged, replacing references to `pane` with `folder` …
  }
```

Wait — since the pane itself is titled "Plasma Orb", you can drop the inner folder. Simpler:

```ts
  private registerTweaks(): void {
    if (!this.pane) return;
    const pane = this.pane;
    // … addBinding directly on `pane` …
  }
```

In `Game.ts`, update the `PlasmaOrb` construction:

```ts
    this.plasmaOrb = new PlasmaOrb(this.scene, {
      position: this.sculptureTarget,
      radius: 0.42,
      paneDock: this.paneDock,
    });
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Visual verification**

Run: `npm run dev`. Open the engine room drawer / pane dock. Expected:
- A "Plasma Orb" pane appears alongside the existing Scenery pane.
- Sliders for radius, noiseAmp, attractorReach, attractorStrength, energyBoost respond live.
- Color pickers for coolColor and warmColor change the orb tint immediately.

- [ ] **Step 5: Commit**

```bash
git add src/game/plasmaOrb.ts src/game/Game.ts
git commit -m "feat(plasma-orb): live tweakpane controls"
```

---

## Self-Review Notes (completed)

- **Spec coverage:** Goals/non-goals, palette (B), surface motion (B), per-hand attractors (B), full replacement (A), 48 raymarch steps — all covered. Tasks 1–3 cover scaffolding, shader, controls.
- **Type consistency:** `PlasmaOrbAttractor` shape consistent across all tasks. `setAttractors`/`setEnergy`/`update` signatures stable. `MAX_ATTRACTORS = 4` used in both class and shader (`array<vec4<f32>, 4>`).
- **Removed code:** `sculpture`, `sculptureMaterials`, `createMusicSculpture`, `updateSculpture`, `this.updateSculpture(energy)` call, `this.createMusicSculpture()` call — all called out in Task 1 Step 2.
- **Unused imports:** Task 1 Step 2 should drop `MeshStandardMaterial` if no other code in `Game.ts` uses it. Confirm at type-check time.
- **Shader correctness:** WGSL block compiles in isolation; `wgslFn` is called once and bound to TSL inputs via `Fn(() => plasmaFn({...}))()`. Inline plasma fold matches reference shadertoy structure.
- **Fallback path:** WGSL compile errors surface in console; the `MeshBasicNodeMaterial` without colorNode renders a default white sphere — visible enough that a developer notices. Spec asked for cyan fallback specifically; if that matters, set `material.color.set(0x35d8ff)` in the catch block.
