# Plasma Orb — Design

Replace the central "atom" sculpture (icosahedron core + 3 torus rings + halo) with a volumetric plasma orb rendered through a custom WGSL shader integrated into the TSL node graph. The orb's silhouette and interior are both fluid: the silhouette wobbles on its own rhythm and bulges toward each player's hands; the interior is a raymarched plasma swirl whose color and turbulence respond to player connection.

## Goals

- Visually striking centerpiece that reads as the source of the music both players are shaping.
- Fluid silhouette that visibly *responds to hand motion in space* — the orb reaches toward hands.
- Interior plasma swirl driven by aggregate connection energy.
- Single TSL/WGSL shader path; no second-pass refraction or extra meshes.
- Bounded GPU cost: orb covers ~10–15% of the frame; 48 raymarch steps inside the orb only.

## Non-Goals

- Full SDF fluid simulation with merging blobs (Approach 3 from brainstorming, rejected).
- Vertex displacement on a high-density mesh (Approach 2, rejected).
- Per-fingertip attractors (20 inputs). Aggregating to 4 hand centroids is sufficient.
- Reflection/refraction probes or environment map sampling.
- Sound-reactive amplitude FFT input. Hand-derived `energy` is the only modulation source.

## User Choices Captured From Brainstorming

- **Palette:** Hybrid — cyan/teal core like the reference plasma ball, amber filaments flare in when energy is high (matches the existing cabin color language).
- **Surface motion:** Metaball-attracted plasma — base wobble + 4 hand attractors that pull the silhouette outward.
- **Hand granularity:** Per-hand (4 attractors: 2 players × 2 hands; each attractor positioned at the centroid of that hand's 5 fingertips).
- **Replacement scope:** Full replacement of the existing sculpture (core + rings + halo all removed).
- **Raymarch cost:** Standard — 48 steps, configurable via tweakpane.

## Architecture

### Files

- **New:** `src/game/plasmaOrb.ts` — owns mesh, material, uniforms, tweakpane registration.
- **Modified:** `src/game/Game.ts` — removes `sculpture`/`sculptureMaterials`/`createMusicSculpture`/`updateSculpture`; constructs `PlasmaOrb` after `renderer.init()`; computes 4 hand centroids each frame from `localPose` + `remotePose` and pushes them into the orb. The `sculptureTarget` Vector3 stays (camera anchor).

### `PlasmaOrb` interface

```ts
type PlasmaOrbOptions = {
  position: THREE.Vector3;
  radius?: number;        // default 0.42
  paneDock?: HTMLElement; // optional, for tweakpane registration
};

type Attractor = { position: THREE.Vector3; weight: number };

class PlasmaOrb {
  readonly mesh: THREE.Mesh;
  constructor(scene: THREE.Scene, options: PlasmaOrbOptions);
  setAttractors(attractors: Attractor[]): void;   // up to 4; missing slots become weight=0
  setEnergy(energy: number): void;                 // 0..1
  update(elapsed: number, delta: number): void;    // advances rhythm, smooths attractors
  dispose(): void;
}
```

### Mesh & material

- Geometry: `THREE.SphereGeometry(radius * 1.5, 32, 24)`. Radius is inflated relative to the SDF radius so deformation/bulges stay inside the proxy mesh — the SDF can grow up to ~40% beyond `radius` from attractor pulls + noise; mesh at 1.5× leaves a small safety margin.
- Material: `THREE.MeshBasicNodeMaterial` with:
  - `side: THREE.BackSide` — fragment shader runs at the back face so we can raymarch front-to-back from the eye through the volume.
  - `transparent: true`, `depthWrite: false`, `blending: THREE.AdditiveBlending`.
  - `colorNode = wgslFn(<plasma WGSL>)` returning `vec4f` (rgb + accumulated alpha).

Backface rendering is the standard trick for "raymarch inside a sphere" — it guarantees the fragment shader runs for every pixel covered by the orb without needing a fullscreen pass.

### TSL / WGSL integration

Three.js TSL exposes WGSL via `wgslFn(...)` (and the higher-level `Fn(...)` for node composition). The orb shader is one `wgslFn` block taking these uniforms:

| Uniform | Type | Source |
|---|---|---|
| `uTime` | `f32` | accumulated `elapsed` |
| `uCenter` | `vec3f` | world position of orb |
| `uRadius` | `f32` | base SDF radius |
| `uEnergy` | `f32` | smoothed 0..1 |
| `uAttractors` | `array<vec4f, 4>` | xyz = local-space attractor pos, w = strength (0 if slot unused) |
| `uPalette` | `vec3f, vec3f, vec3f` | cool, warm, hot colors |
| `uSteps` | `i32` (compile-time const) | raymarch steps (48 default) |
| `uNoiseAmp` | `f32` | silhouette wobble amplitude |
| `uAttractorRadius` | `f32` | falloff distance for hand pulls |
| `uCameraPosition` | `vec3f` | world camera position |

Standard TSL/Three uniforms (`cameraPosition`, `modelWorldMatrix`) are read via TSL helpers and passed in.

### Shader structure

The fragment shader:

1. **Reconstruct ray.** From the fragment's world position and `uCameraPosition`, derive ray origin `ro` and direction `rd`.
2. **SDF.** A `sphereSdf(p)` function returns `length(p - uCenter) - uRadius - noiseDisplacement(p, uTime) - smoothMinAttractors(p)`.
   - `noiseDisplacement`: low-frequency 3D simplex/value noise modulated by `uTime * 0.3` and `uEnergy`.
   - `smoothMinAttractors`: for each of 4 attractors, compute `exp(-dist²/uAttractorRadius²) * w` and sum. This *adds* radius near attractors (pulls the surface outward toward hands).
3. **Sphere–ray intersection.** Analytic intersection against a bounding sphere of `radius * 1.4` (covers the maximum deformed SDF extent) gives `tMin`, `tMax` for the raymarch range. Skip if no hit.
4. **Surface refinement (optional, ~6 steps).** Walk the SDF from `tMin` to find the actual deformed surface entry point. This gives accurate silhouette wobble.
5. **Plasma raymarch (48 steps).** Ported from the reference shadertoy:
   - Iterative folding: `p = 0.7 * abs(p) / dot(p,p) - 0.7;`
   - Complex-square: `csqr(yz)` per iteration (10 iterations inside `map`).
   - Density `c` accumulated as `exp(-19 * abs(dot(p,c)))` per iteration; outer loop accumulates `col = 0.99*col + 0.08 * vec3(c³, c², c)`.
   - Step size `dt * exp(-2*c)` — adaptive, denser steps in dense plasma.
   - The folding origin is offset by attractor centroid weighted by strength so the swirl shifts toward whichever hand is closest.
6. **Palette mapping.**
   - `coolColor` = teal/cyan (≈ `vec3(0.15, 0.65, 0.95)`).
   - `warmColor` = amber (≈ `vec3(0.98, 0.62, 0.18)`).
   - `hotColor` = near-white (≈ `vec3(1.0, 0.95, 0.85)`).
   - Base output: `mix(coolColor, hotColor, density)`.
   - Amber accent: `mix(result, warmColor, smoothstep(0.55, 0.85, density) * uEnergy)`.
   - Final: `0.5 * log(1 + col)` (matches reference tone curve).
7. **Rim / fresnel.** Compute `fresnel = pow(1 - abs(dot(rd, normalize(ro - uCenter))), 3)` and add a rim glow tinted by the cool color — gives the orb a clear edge against the cabin background.
8. **Output.** `vec4f(rgb, alpha)` where alpha is `clamp(luminance(rgb) * 1.4, 0, 1)` so the orb fades into transparency at low density, leaving the world visible through the edges.

### Surface fluidity (the "structural" requirement)

There is no separate vertex displacement pass. The orb's *visible* silhouette is determined by where the SDF crosses zero during raymarch, so:

- The proxy mesh stays a static sphere (no per-frame geometry update).
- The wobble comes from `noiseDisplacement` in the SDF. As `uTime` advances, the noise field shifts and the silhouette breathes.
- Each frame, `uAttractors` updates with smoothed hand centroids. The smooth-min in the SDF causes the silhouette to extend toward each hand with falloff `uAttractorRadius` (default 0.6m). Bring a hand close: a teardrop bulge reaches out.
- Internal swirl follows the attractor offset, so the hot core also drifts toward the active hand.

### Data flow per frame

```
HandTracker → localPose (5 fingertips × 2 hands)
RobotMotion / network → remotePose
                                      │
                                      ▼
Game.update():
  1. Compute 4 hand centroids:
     - leftLocal = avg(localPose.hands.left.fingertips)  (world space)
     - rightLocal = avg(localPose.hands.right.fingertips)
     - leftRemote, rightRemote (same)
  2. Map to orb-local space: subtract orb.position
  3. Compute weight per attractor:
     w = clamp(1 - distance(centroid, orb) / maxReach, 0, 1)
     where maxReach ≈ 0.9m (hands beyond this don't pull)
  4. plasmaOrb.setAttractors([{pos, w}, …])
  5. plasmaOrb.setEnergy(energy)  // existing avg link tension
  6. plasmaOrb.update(elapsed, delta)  // smooths attractors with critically-damped spring
                                      │
                                      ▼
Material uniforms updated → next render samples new SDF/swirl.
```

### Smoothing

Hand tracking is jittery. The orb applies critically-damped smoothing per attractor:

- Position: lerp toward target with `1 - exp(-delta * 12)` (≈100ms time constant).
- Weight: lerp with `1 - exp(-delta * 8)`.
- Energy: lerp with `1 - exp(-delta * 5)` (slower; energy already comes from a stable aggregate).

Without smoothing, raw fingertip jitter shows up as visible silhouette twitching.

### Tweakpane controls

Grouped under "Plasma Orb" in the existing `paneDock`:

- `radius` (0.2..0.8)
- `noiseAmp` (0..0.25) — silhouette wobble strength.
- `attractorReach` (0.2..1.5) — how far hands influence the surface.
- `attractorStrength` (0..0.4) — how far the surface pulls toward hands.
- `energyBoost` (0..2) — multiplies smoothed energy before it enters the shader.
- `coolColor`, `warmColor` (color pickers).
- `raymarchSteps` (16..96, integer; requires shader recompile so debounce or rebuild on commit).

### Removed code

In `Game.ts`:
- `private sculpture = new THREE.Group();`
- `private sculptureMaterials: THREE.MeshStandardMaterial[] = [];`
- `private createMusicSculpture(): void { … }` (lines ~290–334)
- `private updateSculpture(energy: number): void { … }` (lines ~394–404)
- The call site `this.updateSculpture(energy)` in `updateLinks()` is replaced with the `setAttractors` / `setEnergy` / `update` calls described above.

`sculptureTarget` Vector3 stays — it's the camera target/orbit anchor. The plasma orb is positioned at `sculptureTarget`.

## Error handling

- `wgslFn` compile errors surface at first render; if the WebGPU device rejects the shader, log a clear error and fall back to a plain `MeshBasicMaterial({color: 0x35d8ff, transparent: true, opacity: 0.4})` sphere so the rest of the game still runs. The fallback is set up in the constructor's catch block.
- If `setAttractors` receives fewer than 4 entries, missing slots are filled with `vec4(0,0,0,0)` (zero strength → no contribution).
- If hand tracking is off, the centroids stay at the orb center with weight 0 — the orb defaults to its idle wobble.

## Testing

Visual / runtime checks (no automated tests for this — it's a real-time shader):

- **Dev server smoke:** Run `npm run dev`, confirm the orb renders at scene center with cyan/teal swirl and visible silhouette wobble at idle.
- **Hand response:** With hand tracking enabled, move one hand close — silhouette should bulge toward it within ~150ms.
- **Energy response:** Bring fingertips into "ideal" alignment with the robot/remote player — amber filaments should appear in the swirl when `energy` exceeds ~0.5.
- **Performance:** With Stats.js panel open, confirm frame time stays under 16ms with `raymarchSteps=48` on the development machine. If it doesn't, drop to 32 in `PlasmaOrbOptions` defaults.
- **Type check:** `npm run build` (which runs `tsc --noEmit && vite build`) must pass.
- **Removal verification:** Confirm there are no remaining references to `sculpture`, `sculptureMaterials`, `createMusicSculpture`, or `updateSculpture` in `Game.ts`.

## Out of scope (explicit YAGNI list)

- No SSR/baked environment for reflections.
- No bloom/post-processing pass — the additive blending plus rim glow is enough.
- No saving/loading of tweakpane values — they reset on reload like other panes in the project.
- No mobile/integrated-GPU fallback beyond the compile-error fallback. Project already requires WebGPU.
