# Biome System & Sky Life — Design

**Status:** approved
**Date:** 2026-04-25
**Author:** brainstorm w/ Eric

## Goal

Replace the current single "rolling hills" backdrop with a varied, performant biome system viewed through the train windows. Both players in a room see the same scenery. Stays cozy/lofi in tone. Adds weather, birds, occasional magic moments.

## Constraints & opportunities

- Cabin camera is locked. Every visual asset can assume "viewed from inside the cabin through the windows" — no need to be correct from any other angle.
- Current scenery is shader-driven flat planes flanking the cabin at `x = ±2.18 / ±2.26 / ±2.34`. Cheap on the GPU. We keep that footprint.
- WebGPU + Three.js TSL is in use; lean into it.
- Multiplayer is two-player; both clients should agree on what's outside the windows so "look at that lighthouse!" works.

## High-level architecture

Three scrolling layers per side, each a flat plane outside the window:

| Layer       | Speed | Driven by                           | Rendering                                         |
|-------------|-------|-------------------------------------|---------------------------------------------------|
| Background  | slow  | `BackgroundBiome` (4–8 min cadence) | Shader silhouette + color (like current hills)    |
| Midground   | med   | `ForegroundBiome` sprite distrib.   | `InstancedMesh` of textured quads, atlas-sourced  |
| Foreground  | fast  | `ForegroundBiome` sprite distrib.   | `InstancedMesh` of textured quads, atlas-sourced  |

Plus three sky overlays:

| Overlay     | Notes                                                              |
|-------------|--------------------------------------------------------------------|
| Sky life    | Birds, clouds, fireflies, magic moments — `InstancedMesh`, atlas-sourced |
| Weather     | Full-window quad shader: rain/snow streaks + lightning flash + bolt texture |
| Sky         | Existing sun/moon/stars/aurora shader; gains `cloudCover`, `rainAmount`, `lightningFlash` inputs |

Foreground and background biomes are independent: foreground rotates on a ~90–180s cadence, background on a ~4–8 min cadence. This produces "snowy mountains seen behind a forest, then behind a meadow, then behind a lake, then mountains roll on" — the parallax sells the geography.

## Module layout

New files:

- `src/game/biomes.ts` — biome definitions, scheduler, deterministic PRNG
- `src/game/spriteAtlas.ts` — procedural canvas atlas builder + cell registry
- `src/game/skyLife.ts` — birds, clouds, fireflies, magic moments
- `src/game/weather.ts` — rain/snow shader quad + lightning bolt generator

Modified:

- `src/game/scenery.ts` — keeps sky shader; hill layers become biome-parameterized; villages move into `meadow` biome handling
- `src/game/Game.ts` — instantiates the new modules, passes shared room seed + epoch into them, wires their `update()` calls

Each new module owns its own three.js objects and exposes `build(scene)`, `update(delta, ctx)`, `dispose()` so `Game.ts` stays thin.

## Biome model

```ts
type ForegroundBiomeId = 'hills' | 'forest' | 'meadow' | 'lake' | 'coast' | 'snowfield' | 'farmland';
type BackgroundBiomeId = 'distantHills' | 'snowMountains' | 'oceanHorizon' | 'mesa' | 'fogForest';

interface ForegroundBiome {
  id: ForegroundBiomeId;
  groundColor: { day: number; night: number };
  ridge: { amplitude: number; frequency: number };
  sprites: Array<{
    atlasId: string;
    density: number;          // sprites per unit width
    yJitter: number;          // vertical wobble around ground line
    sizeRange: [number, number];
    layer: 'foreground' | 'midground';
  }>;
  water?: { coverage: number; reflectionTint: number };
  villageLights?: { density: number; clusterTightness: number };
  weatherBias: { rain: number; snow: number };  // multiplied with global weather likelihood
  birdBias: number;            // 0..1 multiplier on default bird density
  birdPalette?: 'default' | 'seabird';
}

interface BackgroundBiome {
  id: BackgroundBiomeId;
  silhouette: (x: number, t: number) => number;  // height function for shader
  color: { day: number; night: number };
  fogStrength: number;
  snowCap?: { threshold: number; tint: number };
  banding?: { count: number; tint: number };     // mesa horizontal bands
  shimmer?: { amount: number };                  // ocean horizon glint
  timeOfDayBias: { dawn: number; day: number; dusk: number; night: number };
}
```

Both biome catalogues are constants in `biomes.ts`. `silhouette` is a pure function (sin/cos/noise) so we can crossfade two of them in the shader by lerping the output.

## Scheduler

```ts
class BiomeScheduler {
  constructor(seed: number, epoch: number);
  current(layer: 'foreground' | 'background'): { from: Biome; to: Biome; t: number /*0..1*/ };
  weather(now: number): { rain: number; snow: number; cloudCover: number };
  nextLightningEvent(): { startTime: number; bolt: BoltGeometry; flashPeak: number } | null;
  magicEvents(now: number): MagicEvent[];   // shooting stars, balloons, whales, planes
}
```

- Foreground rotation: each biome lasts `90 + rand()*90` seconds (so 90–180s), with a 12-second crossfade window.
- Background rotation: each lasts `240 + rand()*240` seconds (4–8 min), 25-second crossfade.
- Picking the next biome uses weighted random where weights are `timeOfDayBias[currentPhase] × (1 - recencyPenalty)`. `recencyPenalty` decays with each tick, so biomes can repeat after a while but rarely back-to-back. Time-of-day weights make ocean *more likely* at sunset, snow mountains *more likely* at dawn — but never guaranteed.
- `weather()` is precomputed: at each foreground transition the scheduler decides whether the upcoming biome will have rain/snow based on `weatherBias`. Rain ramps up 15s before peak, holds for ~60–120s, ramps down 20s. Snow uses the same shape but only triggers when foreground or background is `snowfield` / `snowMountains`.
- Lightning events: only inside rain windows, 1 every 30–60s. Each event is `(startTime, boltSeed)`. The bolt geometry is regenerated from the seed identically on both clients.
- Magic events: drawn from a Poisson schedule with biome-gated visibility (e.g., whales only schedule when `coast` is current foreground).

### Determinism

- Seed: `hash(roomName) ^ floor(roomEpoch / 1000)`.
- Epoch: derived from the room's join time. We need a shared epoch; simplest cheap approach is `epochMs = floor(Date.now() / 60000) * 60000` rounded to the minute, then anchored to the room. Both clients connecting within the same minute get the same epoch (good enough for cozy sync; see "Open questions" below if tighter sync is wanted later).
- A small mulberry32 PRNG in `biomes.ts` is reseeded on each `pick` call from `(seed, eventIndex)`.

## Sprite atlas (procedural)

`spriteAtlas.ts` builds one `THREE.CanvasTexture` at boot from a 1024×1024 OffscreenCanvas. Generators draw silhouettes (alpha-only — color comes from the shader so we can tint per biome / time-of-day from one atlas).

Cells (each gets a fixed atlasRect):

| Generator              | Frames | Notes                                  |
|------------------------|--------|----------------------------------------|
| `drawPineTall`         | 1      | Conifer silhouette                     |
| `drawPineShort`        | 1      |                                        |
| `drawDeciduousRound`   | 1      | Maple/oak shape                        |
| `drawDeciduousTall`    | 1      | Birch-like                             |
| `drawBarn`             | 1      |                                        |
| `drawSilo`             | 1      |                                        |
| `drawFencePost`        | 1      |                                        |
| `drawHaystack`         | 1      |                                        |
| `drawCottage`          | 2      | Day silhouette + window-light variant  |
| `drawLighthouse`       | 2      | Off + lit                              |
| `drawSailboat`         | 1      |                                        |
| `drawReeds`            | 1      | For lake edges                         |
| `drawCattail`          | 1      |                                        |
| `drawBird`             | 3      | Wing-up / wing-mid / wing-down         |
| `drawCloudPuff`        | 3      | Small / med / large                    |
| `drawHotAirBalloon`    | 1      |                                        |
| `drawShootingStarTrail`| 1      | Stretched gradient                     |
| `drawWhaleSpout`       | 2      | Spout puff + tail flick                |

Each generator returns `{ atlasRect: vec4 (u0,v0,u1,v1), anchor: vec2 (px,py) }`. Anchors are usually bottom-center for ground sprites, center for sky sprites. Atlas is regenerated only on construction.

## Foreground / midground rendering

Two `InstancedMesh` per side per layer (so 4 total: foreground L/R, midground L/R). Each mesh uses a single quad geometry and a custom TSL material that:

1. Reads `instanceAtlasRect`, `instancePos`, `instanceScale`, `instanceTint`, `instanceFrameOffset`.
2. Computes world position with `worldX = instancePos.x - scrollOffset`, wrapped modulo layer width.
3. Samples the atlas masked by `atlasRect`.
4. Multiplies alpha mask by `instanceTint × biomeTimeTint`.

Sprite distribution per biome is generated by `BiomeScheduler` once per biome activation and uploaded to instance buffers via `setMatrixAt` / custom instanced attributes. Cap at ~200 instances per layer per side; with 7 foreground biomes + crossfade we hold *both* the outgoing and incoming biome's instances in the buffer simultaneously and crossfade alpha. Worst case: 400 instanced quads per layer per side = ~1600 instanced quads total, all batched in 4 draw calls. Trivial GPU cost.

Water (lake / coast) is a separate shader strip mounted in the same layer, coverage controlled by `biome.water.coverage`. Reflection is a cheap inverted-sky sample with horizontal jitter — we don't need real reflections, just the suggestion.

Village lights (meadow biome) are an additive `THREE.Points` with cluster-biased XY positions, fading in with night brightness. Reuses today's village-points pattern but the points are clustered (Poisson-disk seed → cluster of 5–12 points with tight spread) instead of uniform.

## Background layer

Stays close to `scenery.ts`'s current hill shader. Generalized so the height function is provided by the active background biome and crossfaded between `from` and `to` biomes.

- `snowMountains` adds a snow-cap pass: any vertex above `silhouette(x) > threshold` blends toward `snowCap.tint`.
- `mesa` overlays horizontal bands by sampling a 1D color ramp from world-Y.
- `oceanHorizon` flattens the silhouette to near-zero and overlays a faint shimmer band.
- `fogForest` lays a soft white horizontal gradient over the silhouette tops to suggest mist.
- All background biomes are gently fogged into the sky horizon color so the skyline never looks pasted-on.

## Weather

Full-window quad in front of the sky, behind the foreground.

- **Rain.** Diagonal streaks from a hashed grid (`hash(floor(uv * grid))`) scrolled by `time * speed` along a slight X-Y vector. Streaks short, additive, faintly blue-grey. Sky behind is multiplicatively dimmed by `0.7 + 0.3 * (1 - rainAmount)`.
- **Snow.** Same grid, larger softer dots, slow vertical drift with sine sway. Only when foreground is `snowfield` or background is `snowMountains`.
- **Cloud cover.** A separate slow-scrolling cloud sprite layer (Section: sky life) increases its opacity with `cloudCover` so overcast precedes rain.
- **Lightning flash.** `lightningFlash` uniform briefly raises sky brightness by `0.18 * flash` (muted), warm-cream tint. Envelope: 80ms ramp-up, 600ms exponential decay.
- **Lightning bolt.** Forking polyline drawn once per strike to a 256×128 canvas, uploaded as `THREE.DataTexture`, shown via the weather quad with `boltOpacity` (60ms ramp, 250ms decay).

### Bolt generator

```ts
function generateBolt(seed: number): BoltGeometry {
  // 1. Pick start (top-of-window randomized), end (near horizon).
  // 2. Recursive midpoint displacement, max 3 levels.
  //    - Each subdivision: midpoint += perpendicular * jitter
  //    - At each level, ~30% chance to spawn a child fork (one fewer level)
  // 3. Result: <= ~16 segments + 1–4 forks.
  // 4. Rasterize to 256×128 canvas with soft additive stroke.
}
```

Bolt seed is `(roomSeed, lightningEventIndex)` so both clients get identical bolts.

### Thunder

A muted, low-passed rumble plays 0.5–2.0s after the flash with reverb. **Open question for implementation:** generate procedurally via `OfflineAudioContext` (filtered noise burst with long convolution-reverb tail) rather than ship an asset. This keeps the project asset-free and matches the cozy lofi tone better than any free sample I could find. Will start with procedural; if it sounds bad we add a small file.

## Sky life

`skyLife.ts` owns one `InstancedMesh` per category, all using the shared atlas.

- **Clouds.** Two layers, ~12 instances per side. Slow X drift independent of train scroll. Tint warms at sunrise/sunset, cools toward grey at `rainAmount > 0.3`. Opacity ramps with `cloudCover`.
- **Birds.** Up to 16 per side. Parametric path: `x(t) = -W/2 + ((t * speed) mod W)`, `y(t) = y0 + sin(t * freq) * amp`. Some birds get a "swoop" mode where amp briefly grows. Wing-flap is a 3-frame atlas index by `floor(time * flapHz) % 3`. Density scaled by `currentForegroundBiome.birdBias`. `coast` biome uses the seabird palette/shape.
- **Fireflies.** Only when `foreground.id === 'meadow'` AND `night > 0.5`. ~30 additive yellow points per side, slow random walk, sine brightness pulse out of phase per instance.
- **Magic moments** (scheduler-driven, both clients see them):
  - **Shooting star** — single instance, animates across window with fading trail. ~1 every 2–4 min at night.
  - **Hot air balloon** — single instance at sunrise/dusk, drifts very slowly. ~1 every 8–15 min.
  - **Whale spout** — only on `coast`. Spout puff blooms then fades, optional tail flick after. ~1 every 4–8 min.
  - **Distant plane** — night only, blinking dot crossing slowly.

## Sync model

- Sky/day-night/weather/biomes/lightning/magic-events all derive from `(roomSeed, sharedEpoch)`.
- Today's `scenery.update(delta, elapsed)` uses client-elapsed; **change** to use `(now - sharedEpoch) / 1000` so `cycle` is identical across clients.
- `Game.ts` computes `sharedEpoch` from `multiplayer.getRoom()` once on connect and passes it to `ScenerySystem` and the new modules.
- No new server messages required.

## Tweakpane controls

The existing scenery pane gets new tabs/folders:

- **Biomes:** force-set foreground / background biome; lock rotation; speed multiplier for transitions; recency penalty strength.
- **Weather:** manual rain/snow/cloud sliders; trigger lightning bolt button; storm intensity.
- **Sky life:** bird density, firefly density, trigger shooting star / balloon / whale buttons.

These are dev-only conveniences. Defaults reflect production behavior.

## Performance budget

Target: keep current frame budget. Rough accounting:

- Atlas build: one-time at boot, ~10ms (canvas 2D draws).
- Background: same shader cost as today's hills (3 plane meshes per side).
- Foreground/midground sprites: ~1600 instanced quads, 4 draw calls. <1ms GPU.
- Sky life: ~100 instanced quads + ~60 firefly points. Negligible.
- Weather: 2 full-window quads (rain/snow + bolt). Negligible.
- Scheduler: <0.1ms per frame; most work is at biome transitions.

Watch for: instance buffer churn at biome transitions. We mitigate by preallocating max-size buffers and writing in-place, never reallocating.

## Open questions / deferred

- **Tighter epoch sync.** If "started 30s apart → desynced day/night" becomes annoying, send the room's start epoch from the server via existing SpacetimeDB room state. For v1 we round to the minute and accept it.
- **Thunder audio quality.** Procedural first; if it's not cozy enough, add a single tiny audio file.
- **Mobile/low-end perf.** Not tested in this design pass. The architecture should scale by lowering instance counts and disabling fireflies; a `low/medium/high` quality knob can land later if needed.
- **Camera-shake on close lightning.** Tempting but feels off-brand for cozy/lofi. Leaving out.

## Out of scope

- Real 3D meshes for trees/mountains (Section 3 alternative C — rejected).
- Asset pipeline (no external textures or audio files).
- Per-player biome preferences (everyone in the room sees the same outside).
- New server messages.
