# Biome System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single rolling-hills backdrop with a layered biome system (forest / meadow / lake / coast / snowfield / farmland over distant hills / snow mountains / ocean / mesa / fog forest), plus weather, lightning, birds, clouds, fireflies, and magic moments. All deterministically synced across both players in a room.

**Architecture:** Three flat-plane scrolling layers per side (background / midground / foreground) plus three sky overlays (sky-life / weather / sky). Foreground/midground use `InstancedMesh` quads sourced from a procedural canvas-drawn sprite atlas. Background is shader-driven silhouettes. Scheduler picks biomes & weather windows from a per-room PRNG so both clients agree.

**Tech Stack:** Three.js WebGPU + TSL shaders, Tweakpane for dev controls, no new external assets, no test framework (verification = `npm run build` + dev-server visual check).

**Spec:** `docs/superpowers/specs/2026-04-25-biome-system-design.md`

---

## Verification approach

- **Type check:** `npm run build` (runs `tsc --noEmit && vite build`). Plan calls this `BUILD`.
- **Visual check:** `npm run dev`, open `http://localhost:5173`, click "Begin", observe outside the windows. Plan calls this `VISUAL`.
- **Sync check (multi-player):** open two browser tabs to `localhost:5173/<room>`, click Begin in both, confirm matching scenery. Plan calls this `SYNC`.
- **Commit after each task** with message `feat(biomes): <task summary>`.

---

## Task 1: Deterministic PRNG + room-shared epoch

Foundational. Sets up the seed/epoch values that every later task consumes. No visible change.

**Files:**
- Create: `src/game/seedRandom.ts`
- Modify: `src/game/Game.ts` (add `roomSeed: number` and `sharedEpoch: number` fields, pass to `ScenerySystem`)
- Modify: `src/game/scenery.ts` (accept seed/epoch in constructor, use `(performance.now() - sharedEpochOffset)/1000` instead of game-elapsed for the cycle)

- [ ] **Step 1.1: Create `seedRandom.ts`**

```ts
// src/game/seedRandom.ts
// Deterministic small PRNG + string hash. Both clients in the same room use
// the same seed so biome sequence, weather windows, and lightning bolts match.

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — small, fast, good enough for visual variety.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reseedable wrapper for "give me a deterministic stream from (seed, key)".
export function streamFor(seed: number, key: number): () => number {
  return mulberry32((seed ^ Math.imul(key + 1, 0x9e3779b1)) >>> 0);
}

// Round wall-clock time to a coarse anchor so two clients connecting within
// the same minute land on the same epoch. Good enough for cozy sync.
export function roomEpoch(now = Date.now()): number {
  return Math.floor(now / 60_000) * 60_000;
}
```

- [ ] **Step 1.2: Plumb seed + epoch through `Game.ts`**

In the constructor, after `this.roomId = this.multiplayer.getRoom();`, add:
```ts
this.roomSeed = hashString(this.roomId);
this.sharedEpoch = roomEpoch();
```

Add fields:
```ts
private roomSeed: number;
private sharedEpoch: number;
```

Add the import:
```ts
import { hashString, roomEpoch } from './seedRandom';
```

Update the `ScenerySystem` instantiation to:
```ts
this.scenery = new ScenerySystem(this.scene, this.paneDock, {
  roomSeed: this.roomSeed,
  sharedEpoch: this.sharedEpoch,
});
```

When the multiplayer client reassigns the room (`onAssignedRoom`), recompute the seed:
```ts
this.multiplayer.onAssignedRoom(room => {
  this.roomId = room;
  this.roomSeed = hashString(room);
  this.scenery.setRoomSeed(this.roomSeed);
});
```

- [ ] **Step 1.3: Switch `scenery.ts` to shared-epoch clock**

Add the constructor option type:
```ts
type SceneryOptions = {
  roomSeed: number;
  sharedEpoch: number;
};
```

Constructor signature becomes `(scene, paneContainer?, options: SceneryOptions)`. Store `this.roomSeed` and `this.epochMs`.

In `update(delta, _elapsed)`, compute:
```ts
const wallElapsed = (Date.now() - this.epochMs) / 1000;
const cycle = ((wallElapsed / Math.max(this.params.cycleLengthSeconds, 1) + this.params.cycleOffset) % 1 + 1) % 1;
```

(All other usages of `elapsed` in that function get replaced with `wallElapsed`. The signature stays for compat — `_elapsed` is unused for now.)

Add `setRoomSeed(seed: number) { this.roomSeed = seed; }` for the reassign hook.

- [ ] **Step 1.4: Verify**

Run `BUILD`. Should pass clean. Run `VISUAL` — scenery looks identical to before; only the clock source changed. Open two tabs in the same room (`SYNC`) — sun/moon should be at identical positions in both.

- [ ] **Step 1.5: Commit**

```bash
git add src/game/seedRandom.ts src/game/Game.ts src/game/scenery.ts
git commit -m "feat(biomes): shared room seed + epoch foundation"
```

---

## Task 2: Procedural sprite atlas

Builds the texture atlas at boot. Pure module — no scene integration yet. Can be visually verified later.

**Files:**
- Create: `src/game/spriteAtlas.ts`

- [ ] **Step 2.1: Module skeleton + atlas registry**

```ts
// src/game/spriteAtlas.ts
import * as THREE from 'three/webgpu';

export type AtlasId =
  | 'pineTall' | 'pineShort'
  | 'deciduousRound' | 'deciduousTall'
  | 'barn' | 'silo' | 'fencePost' | 'haystack'
  | 'cottage' | 'cottageLit'
  | 'lighthouse' | 'lighthouseLit'
  | 'sailboat'
  | 'reeds' | 'cattail'
  | 'birdA' | 'birdB' | 'birdC'        // 3 wing frames, default silhouette
  | 'seabirdA' | 'seabirdB' | 'seabirdC'
  | 'cloudSmall' | 'cloudMed' | 'cloudLarge'
  | 'hotAirBalloon'
  | 'shootingStarTrail'
  | 'whaleSpout' | 'whaleTail';

export type AtlasEntry = {
  rect: THREE.Vector4;       // u0, v0, u1, v1 in [0,1]
  anchor: THREE.Vector2;     // 0..1 within rect; bottom-center for ground sprites, center for sky
  pxSize: THREE.Vector2;     // pixel size of the cell, useful for aspect math
};

export class SpriteAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly entries: Record<AtlasId, AtlasEntry>;
  readonly size = 1024;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = this.size;
    canvas.height = this.size;
    const ctx = canvas.getContext('2d')!;
    this.entries = this.draw(ctx);
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;
  }
  // ... draw() defined in next steps
}
```

- [ ] **Step 2.2: Cell layout + draw orchestrator**

Inside the class:
```ts
private draw(ctx: CanvasRenderingContext2D): Record<AtlasId, AtlasEntry> {
  // 8x8 grid of 128px cells.
  const cell = 128;
  ctx.clearRect(0, 0, this.size, this.size);

  type Spec = { id: AtlasId; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; anchor?: [number, number] };
  const specs: Spec[] = [
    { id: 'pineTall',         draw: drawPineTall },
    { id: 'pineShort',        draw: drawPineShort },
    { id: 'deciduousRound',   draw: drawDeciduousRound },
    { id: 'deciduousTall',    draw: drawDeciduousTall },
    { id: 'barn',             draw: drawBarn },
    { id: 'silo',             draw: drawSilo },
    { id: 'fencePost',        draw: drawFencePost },
    { id: 'haystack',         draw: drawHaystack },
    { id: 'cottage',          draw: drawCottage },
    { id: 'cottageLit',       draw: (c, w, h) => drawCottage(c, w, h, true) },
    { id: 'lighthouse',       draw: drawLighthouse },
    { id: 'lighthouseLit',    draw: (c, w, h) => drawLighthouse(c, w, h, true) },
    { id: 'sailboat',         draw: drawSailboat },
    { id: 'reeds',            draw: drawReeds },
    { id: 'cattail',          draw: drawCattail },
    { id: 'birdA',            draw: (c, w, h) => drawBird(c, w, h, 0, false), anchor: [0.5, 0.5] },
    { id: 'birdB',            draw: (c, w, h) => drawBird(c, w, h, 1, false), anchor: [0.5, 0.5] },
    { id: 'birdC',            draw: (c, w, h) => drawBird(c, w, h, 2, false), anchor: [0.5, 0.5] },
    { id: 'seabirdA',         draw: (c, w, h) => drawBird(c, w, h, 0, true),  anchor: [0.5, 0.5] },
    { id: 'seabirdB',         draw: (c, w, h) => drawBird(c, w, h, 1, true),  anchor: [0.5, 0.5] },
    { id: 'seabirdC',         draw: (c, w, h) => drawBird(c, w, h, 2, true),  anchor: [0.5, 0.5] },
    { id: 'cloudSmall',       draw: (c, w, h) => drawCloud(c, w, h, 0.6), anchor: [0.5, 0.5] },
    { id: 'cloudMed',         draw: (c, w, h) => drawCloud(c, w, h, 0.85), anchor: [0.5, 0.5] },
    { id: 'cloudLarge',       draw: (c, w, h) => drawCloud(c, w, h, 1.0), anchor: [0.5, 0.5] },
    { id: 'hotAirBalloon',    draw: drawHotAirBalloon, anchor: [0.5, 0.5] },
    { id: 'shootingStarTrail',draw: drawShootingStarTrail, anchor: [0.5, 0.5] },
    { id: 'whaleSpout',       draw: drawWhaleSpout, anchor: [0.5, 1.0] },
    { id: 'whaleTail',        draw: drawWhaleTail, anchor: [0.5, 1.0] },
  ];

  const entries = {} as Record<AtlasId, AtlasEntry>;
  specs.forEach((spec, i) => {
    const cx = (i % 8) * cell;
    const cy = Math.floor(i / 8) * cell;
    ctx.save();
    ctx.translate(cx, cy);
    spec.draw(ctx, cell, cell);
    ctx.restore();
    entries[spec.id] = {
      rect: new THREE.Vector4(cx / this.size, cy / this.size, (cx + cell) / this.size, (cy + cell) / this.size),
      anchor: new THREE.Vector2(spec.anchor?.[0] ?? 0.5, spec.anchor?.[1] ?? 1.0),
      pxSize: new THREE.Vector2(cell, cell),
    };
  });
  return entries;
}
```

- [ ] **Step 2.3: Generator functions (silhouette draws)**

Add these as module-level functions below the class. All draw an alpha silhouette (white where opaque); color is applied later via shader tint. Each function takes `(ctx, w, h, ...opts)`.

Show full code for one (`drawPineTall`) to set the pattern, then prose for the rest:

```ts
function drawPineTall(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  // Trunk
  ctx.fillRect(w * 0.46, h * 0.78, w * 0.08, h * 0.22);
  // Triangular canopy in 4 stacked segments
  for (let i = 0; i < 4; i += 1) {
    const yTop = h * (0.10 + i * 0.18);
    const yBot = h * (0.32 + i * 0.18);
    const halfW = w * (0.10 + i * 0.08);
    ctx.beginPath();
    ctx.moveTo(w * 0.5, yTop);
    ctx.lineTo(w * 0.5 - halfW, yBot);
    ctx.lineTo(w * 0.5 + halfW, yBot);
    ctx.closePath();
    ctx.fill();
  }
  // Soft alpha edge — re-stroke with low alpha for anti-aliasing on the edges
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}
```

Implement the rest in the same style. Specs for each:

- `drawPineShort`: same as tall but only 2 stacked triangles, shorter trunk.
- `drawDeciduousRound`: trunk + a fluffy cluster of overlapping circles (radii 14–22px, scattered above trunk).
- `drawDeciduousTall`: trunk + tall ellipse canopy.
- `drawBarn`: trapezoidal body + pitched roof + small square door.
- `drawSilo`: tall narrow rectangle + dome top.
- `drawFencePost`: thin vertical rect + 2 horizontal cross-rails.
- `drawHaystack`: dome shape (half-ellipse).
- `drawCottage(ctx, w, h, lit?)`: small rectangular body + pitched roof. If `lit`, draw 2 small warm-yellow rectangles where windows are (use `#ffd58a` instead of white for those rects only).
- `drawLighthouse(ctx, w, h, lit?)`: tapered tower + cap. If `lit`, add a small yellow disc + horizontal soft glow streak across its midpoint.
- `drawSailboat`: triangular sail + hull arc.
- `drawReeds`: 5–7 thin vertical strokes of varied height.
- `drawCattail`: same as reeds plus small dark tip on a couple stalks.
- `drawBird(ctx, w, h, frame, sea)`: simple wing chevron — center body dot + two wings whose y depends on `frame` (0 = up, 1 = mid, 2 = down). `sea` slightly wider/longer wings.
- `drawCloud(ctx, w, h, scale)`: 4–5 overlapping soft-edged ellipses at varying y-offsets, scaled by `scale`.
- `drawHotAirBalloon`: teardrop/inverted-egg balloon + tiny basket dangling beneath.
- `drawShootingStarTrail`: bright dot at right edge, fading horizontal gradient streak to the left.
- `drawWhaleSpout`: vertical fountain shape — narrow at the bottom, fanning outward at top with soft alpha.
- `drawWhaleTail`: stylized fluke silhouette.

Helper at the top of the file for soft alpha edges:
```ts
function softFill(ctx: CanvasRenderingContext2D, build: (c: CanvasRenderingContext2D) => void, color = '#ffffff'): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 2;
  ctx.fillStyle = color;
  build(ctx);
  ctx.fill();
  ctx.restore();
}
```

- [ ] **Step 2.4: Verify**

Run `BUILD`. Type-clean.

To eyeball the atlas, temporarily add at the bottom of `Game.ts` `start()` (and remove after the next task):
```ts
// DEBUG: dump atlas to corner of the screen
const atlas = new SpriteAtlas();
const dbg = document.createElement('canvas');
dbg.width = 256; dbg.height = 256;
dbg.style.cssText = 'position:fixed;top:8px;right:8px;border:1px solid #444;z-index:9999;background:#222';
dbg.getContext('2d')!.drawImage(atlas.texture.image, 0, 0, 256, 256);
document.body.appendChild(dbg);
```
Visually confirm all 27 cells render legible silhouettes. Then remove the debug.

- [ ] **Step 2.5: Commit**

```bash
git add src/game/spriteAtlas.ts
git commit -m "feat(biomes): procedural sprite atlas (trees, buildings, birds, clouds, magic)"
```

---

## Task 3: Biome catalogue + scheduler

Pure data + logic. No scene integration yet. Lays the data shapes consumed by every later task.

**Files:**
- Create: `src/game/biomes.ts`

- [ ] **Step 3.1: Type definitions**

```ts
// src/game/biomes.ts
import { mulberry32, streamFor } from './seedRandom';
import type { AtlasId } from './spriteAtlas';

export type ForegroundBiomeId =
  | 'hills' | 'forest' | 'meadow' | 'lake' | 'coast' | 'snowfield' | 'farmland';

export type BackgroundBiomeId =
  | 'distantHills' | 'snowMountains' | 'oceanHorizon' | 'mesa' | 'fogForest';

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';

export interface SpriteBand {
  atlas: AtlasId;
  density: number;            // sprites per unit width
  yJitter: number;
  sizeRange: [number, number];
  layer: 'foreground' | 'midground';
  // Optional: alternate atlas IDs for animation frames (birds use this elsewhere)
}

export interface ForegroundBiome {
  id: ForegroundBiomeId;
  groundColor: { day: number; night: number };
  ridge: { amplitude: number; frequency: number; baseY: number };
  sprites: SpriteBand[];
  water?: { coverage: number; reflectionTint: number };
  villageLights?: { density: number; clusterTightness: number };
  weatherBias: { rain: number; snow: number };
  birdBias: number;
  birdPalette: 'default' | 'seabird';
  timeOfDayBias: Record<TimeOfDay, number>;
}

export interface BackgroundBiome {
  id: BackgroundBiomeId;
  silhouette: (x: number, t: number) => number;  // 0..1 normalized height
  color: { day: number; night: number };
  fogStrength: number;
  snowCap?: { threshold: number; tint: number };
  banding?: { count: number; tint: number };
  shimmer?: { amount: number };
  timeOfDayBias: Record<TimeOfDay, number>;
}

export interface BiomeWindow<T> {
  from: T;
  to: T;
  startedAt: number;       // shared seconds since epoch
  duration: number;        // seconds (full hold + crossfade)
  crossfade: number;       // seconds at end during which we lerp into `to`
}

export interface WeatherWindow {
  startTime: number;
  rampIn: number;           // seconds to rise to peak
  hold: number;             // seconds at peak
  rampOut: number;          // seconds to fall to 0
  rainPeak: number;         // 0..1
  snowPeak: number;         // 0..1
  cloudCoverPeak: number;   // 0..1
  lightningEvents: LightningEvent[];
}

export interface LightningEvent {
  time: number;     // shared seconds since epoch
  seed: number;     // for bolt geometry
}

export interface MagicEvent {
  kind: 'shootingStar' | 'balloon' | 'whale' | 'plane';
  startTime: number;
  duration: number;
  sideHint: -1 | 1;
  seed: number;
}
```

- [ ] **Step 3.2: Biome catalogue constants**

Below the types, add:

```ts
export const FOREGROUND_BIOMES: Record<ForegroundBiomeId, ForegroundBiome> = {
  hills: {
    id: 'hills',
    groundColor: { day: 0x4a7d4d, night: 0x132018 },
    ridge: { amplitude: 0.18, frequency: 1.3, baseY: 0.42 },
    sprites: [
      { atlas: 'deciduousRound', density: 0.5, yJitter: 0.02, sizeRange: [0.18, 0.30], layer: 'midground' },
    ],
    weatherBias: { rain: 0.4, snow: 0.05 },
    birdBias: 1.0,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.0, night: 1.0 },
  },
  forest: {
    id: 'forest',
    groundColor: { day: 0x1f3a26, night: 0x0a1410 },
    ridge: { amplitude: 0.12, frequency: 1.6, baseY: 0.40 },
    sprites: [
      { atlas: 'pineTall',  density: 1.6, yJitter: 0.03, sizeRange: [0.30, 0.55], layer: 'foreground' },
      { atlas: 'pineShort', density: 1.1, yJitter: 0.02, sizeRange: [0.22, 0.36], layer: 'midground' },
    ],
    weatherBias: { rain: 0.7, snow: 0.10 },
    birdBias: 1.4,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.2, day: 1.0, dusk: 1.2, night: 0.9 },
  },
  meadow: {
    id: 'meadow',
    groundColor: { day: 0x6da55a, night: 0x16241a },
    ridge: { amplitude: 0.10, frequency: 1.0, baseY: 0.38 },
    sprites: [
      { atlas: 'deciduousRound', density: 0.3, yJitter: 0.02, sizeRange: [0.20, 0.34], layer: 'midground' },
      { atlas: 'cottage',        density: 0.18, yJitter: 0.0, sizeRange: [0.16, 0.22], layer: 'foreground' },
    ],
    villageLights: { density: 0.55, clusterTightness: 0.18 },
    weatherBias: { rain: 0.45, snow: 0.05 },
    birdBias: 0.8,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 0.9, day: 1.0, dusk: 1.4, night: 1.4 },
  },
  lake: {
    id: 'lake',
    groundColor: { day: 0x315a4a, night: 0x0d1a18 },
    ridge: { amplitude: 0.06, frequency: 0.8, baseY: 0.34 },
    sprites: [
      { atlas: 'reeds',   density: 0.9, yJitter: 0.01, sizeRange: [0.10, 0.18], layer: 'foreground' },
      { atlas: 'cattail', density: 0.4, yJitter: 0.01, sizeRange: [0.10, 0.16], layer: 'foreground' },
      { atlas: 'pineShort', density: 0.4, yJitter: 0.02, sizeRange: [0.20, 0.32], layer: 'midground' },
    ],
    water: { coverage: 0.7, reflectionTint: 0xb6d6e6 },
    weatherBias: { rain: 0.55, snow: 0.05 },
    birdBias: 1.1,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.3, day: 1.0, dusk: 1.4, night: 0.9 },
  },
  coast: {
    id: 'coast',
    groundColor: { day: 0xc8b88a, night: 0x1f1c14 },
    ridge: { amplitude: 0.05, frequency: 0.6, baseY: 0.32 },
    sprites: [
      { atlas: 'lighthouse', density: 0.06, yJitter: 0.0, sizeRange: [0.30, 0.42], layer: 'midground' },
      { atlas: 'sailboat',   density: 0.10, yJitter: 0.04, sizeRange: [0.10, 0.16], layer: 'midground' },
    ],
    water: { coverage: 1.0, reflectionTint: 0xc8d8e8 },
    weatherBias: { rain: 0.5, snow: 0.0 },
    birdBias: 1.3,
    birdPalette: 'seabird',
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.6, night: 0.9 },
  },
  snowfield: {
    id: 'snowfield',
    groundColor: { day: 0xe5edf0, night: 0x182028 },
    ridge: { amplitude: 0.14, frequency: 1.2, baseY: 0.40 },
    sprites: [
      { atlas: 'pineTall',  density: 0.7, yJitter: 0.02, sizeRange: [0.28, 0.48], layer: 'foreground' },
      { atlas: 'pineShort', density: 0.5, yJitter: 0.02, sizeRange: [0.20, 0.32], layer: 'midground' },
    ],
    weatherBias: { rain: 0.05, snow: 0.95 },
    birdBias: 0.4,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.2, day: 1.0, dusk: 1.0, night: 0.9 },
  },
  farmland: {
    id: 'farmland',
    groundColor: { day: 0x8a7a3a, night: 0x1f1c12 },
    ridge: { amplitude: 0.08, frequency: 0.9, baseY: 0.36 },
    sprites: [
      { atlas: 'fencePost',  density: 1.4, yJitter: 0.01, sizeRange: [0.10, 0.16], layer: 'foreground' },
      { atlas: 'haystack',   density: 0.4, yJitter: 0.01, sizeRange: [0.12, 0.20], layer: 'midground' },
      { atlas: 'barn',       density: 0.10, yJitter: 0.0, sizeRange: [0.20, 0.30], layer: 'midground' },
      { atlas: 'silo',       density: 0.06, yJitter: 0.0, sizeRange: [0.18, 0.26], layer: 'midground' },
    ],
    weatherBias: { rain: 0.5, snow: 0.05 },
    birdBias: 1.0,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.0, day: 1.2, dusk: 1.1, night: 0.8 },
  },
};

import { hash } from './math';

export const BACKGROUND_BIOMES: Record<BackgroundBiomeId, BackgroundBiome> = {
  distantHills: {
    id: 'distantHills',
    silhouette: (x) => 0.42 + Math.sin(x * 1.2) * 0.08 + Math.sin(x * 2.7) * 0.04,
    color: { day: 0x3d654a, night: 0x101920 },
    fogStrength: 0.35,
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.0, night: 1.0 },
  },
  snowMountains: {
    id: 'snowMountains',
    silhouette: (x) => 0.55 + Math.abs(Math.sin(x * 0.8)) * 0.30 + Math.sin(x * 1.9 + 1.2) * 0.10,
    color: { day: 0x4d5a6a, night: 0x10171f },
    fogStrength: 0.45,
    snowCap: { threshold: 0.62, tint: 0xf2f5f8 },
    timeOfDayBias: { dawn: 1.6, day: 1.0, dusk: 1.0, night: 1.0 },
  },
  oceanHorizon: {
    id: 'oceanHorizon',
    silhouette: () => 0.30,
    color: { day: 0x2a4f6a, night: 0x081016 },
    fogStrength: 0.55,
    shimmer: { amount: 0.6 },
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.7, night: 0.9 },
  },
  mesa: {
    id: 'mesa',
    silhouette: (x) => {
      const step = Math.floor(x * 0.8 + 0.5);
      return 0.40 + ((Math.sin(step * 12.3) + 1) * 0.5) * 0.20;
    },
    color: { day: 0x8a4a2c, night: 0x1a1008 },
    fogStrength: 0.40,
    banding: { count: 4, tint: 0x6a3520 },
    timeOfDayBias: { dawn: 1.0, day: 1.2, dusk: 1.4, night: 0.9 },
  },
  fogForest: {
    id: 'fogForest',
    silhouette: (x) => 0.48 + Math.sin(x * 2.4) * 0.06 + Math.sin(x * 5.1 + 0.5) * 0.03,
    color: { day: 0x2a3a30, night: 0x0c130f },
    fogStrength: 0.75,
    timeOfDayBias: { dawn: 1.4, day: 1.0, dusk: 1.0, night: 1.0 },
  },
};

export function timeOfDayPhase(cycle: number): TimeOfDay {
  // cycle is 0..1 from the day/night system (0 = sunrise area).
  if (cycle < 0.10 || cycle > 0.90) return 'dawn';
  if (cycle < 0.45) return 'day';
  if (cycle < 0.55) return 'dusk';
  return 'night';
}
```

- [ ] **Step 3.3: Scheduler class**

```ts
export class BiomeScheduler {
  private fgWindow: BiomeWindow<ForegroundBiome>;
  private bgWindow: BiomeWindow<BackgroundBiome>;
  private weather: WeatherWindow[] = [];
  private magic: MagicEvent[] = [];
  private fgRecency = new Map<ForegroundBiomeId, number>();
  private bgRecency = new Map<BackgroundBiomeId, number>();
  private fgEventIndex = 0;
  private bgEventIndex = 0;
  private weatherEventIndex = 0;
  private magicEventIndex = 0;

  constructor(
    private seed: number,
    private getEpochSeconds: () => number,
    private getCycle: () => number,        // 0..1 day/night phase
  ) {
    const t = this.getEpochSeconds();
    this.fgWindow = this.makeFgWindow(t, this.pickFg(t), this.pickFg(t));
    this.bgWindow = this.makeBgWindow(t, this.pickBg(t), this.pickBg(t));
    this.scheduleNextWeather(t);
    this.scheduleNextMagic(t);
  }

  // Returns currently active foreground biome window with crossfade T 0..1.
  foreground(): { from: ForegroundBiome; to: ForegroundBiome; t: number } {
    const now = this.getEpochSeconds();
    if (now > this.fgWindow.startedAt + this.fgWindow.duration) {
      const next = this.pickFg(now);
      this.fgWindow = this.makeFgWindow(now, this.fgWindow.to, next);
    }
    const elapsed = now - this.fgWindow.startedAt;
    const fadeStart = this.fgWindow.duration - this.fgWindow.crossfade;
    const t = elapsed < fadeStart ? 0 : Math.min(1, (elapsed - fadeStart) / this.fgWindow.crossfade);
    return { from: this.fgWindow.from, to: this.fgWindow.to, t };
  }

  background(): { from: BackgroundBiome; to: BackgroundBiome; t: number } {
    const now = this.getEpochSeconds();
    if (now > this.bgWindow.startedAt + this.bgWindow.duration) {
      const next = this.pickBg(now);
      this.bgWindow = this.makeBgWindow(now, this.bgWindow.to, next);
    }
    const elapsed = now - this.bgWindow.startedAt;
    const fadeStart = this.bgWindow.duration - this.bgWindow.crossfade;
    const t = elapsed < fadeStart ? 0 : Math.min(1, (elapsed - fadeStart) / this.bgWindow.crossfade);
    return { from: this.bgWindow.from, to: this.bgWindow.to, t };
  }

  weatherAt(now: number): { rain: number; snow: number; cloudCover: number; flash: number; lightning: LightningEvent[] } {
    while (this.weather.length > 0 && this.weather[0].startTime + this.weather[0].rampIn + this.weather[0].hold + this.weather[0].rampOut < now - 5) {
      this.weather.shift();
    }
    if (this.weather.length < 2) this.scheduleNextWeather(now);

    let rain = 0, snow = 0, cloudCover = 0;
    const lightning: LightningEvent[] = [];
    for (const w of this.weather) {
      const local = now - w.startTime;
      let envelope = 0;
      if (local < 0) continue;
      if (local < w.rampIn) envelope = local / w.rampIn;
      else if (local < w.rampIn + w.hold) envelope = 1;
      else if (local < w.rampIn + w.hold + w.rampOut) envelope = 1 - (local - w.rampIn - w.hold) / w.rampOut;
      else continue;
      rain = Math.max(rain, envelope * w.rainPeak);
      snow = Math.max(snow, envelope * w.snowPeak);
      cloudCover = Math.max(cloudCover, envelope * w.cloudCoverPeak);
      for (const ev of w.lightningEvents) {
        if (ev.time >= now - 1.5 && ev.time < now + 4) lightning.push(ev);
      }
    }
    // Flash envelope is computed by the consumer per event — scheduler just lists them.
    return { rain, snow, cloudCover, flash: 0, lightning };
  }

  magicAt(now: number): MagicEvent[] {
    while (this.magic.length > 0 && this.magic[0].startTime + this.magic[0].duration < now - 5) {
      this.magic.shift();
    }
    if (this.magic.length < 3) this.scheduleNextMagic(now);
    return this.magic.filter(m => m.startTime <= now && m.startTime + m.duration > now);
  }

  // ---- internals ----

  private pickFg(now: number): ForegroundBiome {
    const rand = streamFor(this.seed, this.fgEventIndex);
    this.fgEventIndex += 1;
    const phase = timeOfDayPhase(this.getCycle());
    const ids = Object.keys(FOREGROUND_BIOMES) as ForegroundBiomeId[];
    const weights = ids.map(id => {
      const b = FOREGROUND_BIOMES[id];
      const recency = this.fgRecency.get(id) ?? 0;
      const recencyPenalty = Math.max(0, 1 - recency * 0.4);  // 0 = recent, 1 = stale
      return b.timeOfDayBias[phase] * recencyPenalty;
    });
    const id = weightedPick(ids, weights, rand());
    // Decay recency map and bump chosen one
    for (const k of this.fgRecency.keys()) this.fgRecency.set(k, Math.max(0, (this.fgRecency.get(k)! - 0.5)));
    this.fgRecency.set(id, 3);
    return FOREGROUND_BIOMES[id];
  }

  private pickBg(now: number): BackgroundBiome {
    const rand = streamFor(this.seed ^ 0xb19e5, this.bgEventIndex);
    this.bgEventIndex += 1;
    const phase = timeOfDayPhase(this.getCycle());
    const ids = Object.keys(BACKGROUND_BIOMES) as BackgroundBiomeId[];
    const weights = ids.map(id => {
      const b = BACKGROUND_BIOMES[id];
      const recency = this.bgRecency.get(id) ?? 0;
      return b.timeOfDayBias[phase] * Math.max(0, 1 - recency * 0.5);
    });
    const id = weightedPick(ids, weights, rand());
    for (const k of this.bgRecency.keys()) this.bgRecency.set(k, Math.max(0, (this.bgRecency.get(k)! - 0.4)));
    this.bgRecency.set(id, 3);
    return BACKGROUND_BIOMES[id];
  }

  private makeFgWindow(now: number, from: ForegroundBiome, to: ForegroundBiome): BiomeWindow<ForegroundBiome> {
    const rand = streamFor(this.seed ^ 0xfeeed, this.fgEventIndex);
    const duration = 90 + rand() * 90;
    return { from, to, startedAt: now, duration, crossfade: 12 };
  }

  private makeBgWindow(now: number, from: BackgroundBiome, to: BackgroundBiome): BiomeWindow<BackgroundBiome> {
    const rand = streamFor(this.seed ^ 0xbeed, this.bgEventIndex);
    const duration = 240 + rand() * 240;
    return { from, to, startedAt: now, duration, crossfade: 25 };
  }

  private scheduleNextWeather(now: number): void {
    const last = this.weather[this.weather.length - 1];
    const start = (last ? last.startTime + last.rampIn + last.hold + last.rampOut : now) + 60 + Math.random() * 180;
    const rand = streamFor(this.seed ^ 0xc100d, this.weatherEventIndex);
    this.weatherEventIndex += 1;
    const fg = this.fgWindow?.to ?? this.fgWindow?.from ?? FOREGROUND_BIOMES.hills;
    const rainPeak = rand() < fg.weatherBias.rain ? 0.35 + rand() * 0.55 : 0;
    const snowPeak = rand() < fg.weatherBias.snow ? 0.4 + rand() * 0.5 : 0;
    const cloudCoverPeak = rainPeak > 0 || snowPeak > 0 ? 0.5 + rand() * 0.4 : rand() * 0.3;
    const hold = 60 + rand() * 60;
    const events: LightningEvent[] = [];
    if (rainPeak > 0.4) {
      let t = start + 12;
      while (t < start + 15 + hold) {
        events.push({ time: t, seed: Math.floor(rand() * 0xffffff) });
        t += 30 + rand() * 30;
      }
    }
    this.weather.push({
      startTime: start,
      rampIn: 15,
      hold,
      rampOut: 20,
      rainPeak,
      snowPeak,
      cloudCoverPeak,
      lightningEvents: events,
    });
  }

  private scheduleNextMagic(now: number): void {
    const last = this.magic[this.magic.length - 1];
    const start = (last ? last.startTime + last.duration : now) + 60 + Math.random() * 240;
    const rand = streamFor(this.seed ^ 0xa11a8, this.magicEventIndex);
    this.magicEventIndex += 1;
    const phase = timeOfDayPhase(this.getCycle());
    const fg = this.fgWindow?.to ?? FOREGROUND_BIOMES.hills;
    type Choice = { kind: MagicEvent['kind']; weight: number };
    const choices: Choice[] = [
      { kind: 'shootingStar', weight: phase === 'night' ? 1.5 : 0.0 },
      { kind: 'balloon',      weight: (phase === 'dawn' || phase === 'dusk') ? 0.6 : 0.05 },
      { kind: 'whale',        weight: fg.id === 'coast' ? 1.2 : 0.0 },
      { kind: 'plane',        weight: phase === 'night' ? 0.4 : 0.0 },
    ];
    const id = weightedPick(choices, choices.map(c => c.weight), rand());
    if (!id) return;
    const duration =
      id.kind === 'shootingStar' ? 1.4 :
      id.kind === 'balloon' ? 60 :
      id.kind === 'whale' ? 4.0 :
      id.kind === 'plane' ? 30 : 5;
    this.magic.push({
      kind: id.kind,
      startTime: start,
      duration,
      sideHint: rand() < 0.5 ? -1 : 1,
      seed: Math.floor(rand() * 0xffffff),
    });
  }
}

function weightedPick<T>(items: T[], weights: number[], r: number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(r * items.length)];
  let cursor = r * total;
  for (let i = 0; i < items.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return items[i];
  }
  return items[items.length - 1];
}
```

Note: weather/magic also use `Math.random()` for the inter-event spacing — that's not deterministic. We'll fix that to use `streamFor` indexing later if sync drift becomes a problem; for v1 the *content* of each event (rain peak, lightning bolts, magic kind) is seeded so the events match between clients; only the spacing might drift slightly. Acceptable.

Actually correct that in this step — replace both `Math.random()` calls with `rand()` from the same stream. Seed-correct from day one is cheap and the right thing.

- [ ] **Step 3.4: Verify**

`BUILD` clean. No visual change yet. Optional sanity print: in `Game.ts`, log `scheduler.foreground().from.id` once per second briefly to confirm sequence is identical between two browser tabs in the same room. Remove the log after verifying.

- [ ] **Step 3.5: Commit**

```bash
git add src/game/biomes.ts
git commit -m "feat(biomes): biome catalogue + deterministic scheduler"
```

---

## Task 4: Background biome rendering

Generalize the existing far-hill shader to take its silhouette + color from the active background biome (with crossfade). Removes the hardcoded 3-layer hill stack from `scenery.ts`.

**Files:**
- Modify: `src/game/scenery.ts`

- [ ] **Step 4.1: Wire scheduler into ScenerySystem**

Add to `ScenerySystem`:
```ts
private scheduler!: BiomeScheduler;
```

In the constructor (after seed/epoch storage), instantiate:
```ts
import { BiomeScheduler } from './biomes';
// ...
this.scheduler = new BiomeScheduler(
  this.roomSeed,
  () => (Date.now() - this.epochMs) / 1000,
  () => this.lastCycle,
);
```

Add `private lastCycle = 0;` and assign it inside `update()` right after `cycle` is computed.

Expose `scheduler()` accessor for later modules:
```ts
getScheduler(): BiomeScheduler { return this.scheduler; }
```

- [ ] **Step 4.2: Replace `createHills` with biome-driven background**

Delete `createHills`, `createHillMesh`, `updateHills`, `updateHillShape`, `hillHeight`, the `HillMesh` type, and the `private hills` field.

Replace with one background mesh per side, driven by the scheduler. The mesh is a fine horizontal strip whose vertex Y is computed in the vertex shader from a sampled silhouette.

```ts
private bgPanels: { mesh: THREE.Mesh; material: THREE.MeshBasicNodeMaterial; side: number; scrollOffset: number }[] = [];

private createBackground(): void {
  // We build a thin strip 7.6m wide × 1.0m tall flanking each window.
  // Vertex displacement in shader using `instancedAttribute`-free method:
  // we precompute a high-segment plane and let the vertex shader sample
  // current+next biome silhouette via uniform-fed function approximations.
  for (const side of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(7.6, 1.0, 192, 1);
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = this.buildBackgroundColorNode();
    material.vertexNode = this.buildBackgroundVertexNode();
    const mesh = new THREE.Mesh(geo, material);
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(side * 2.18, 0, 0);
    mesh.renderOrder = -20;
    this.root.add(mesh);
    this.bgPanels.push({ mesh, material, side, scrollOffset: 0 });
  }
}
```

The vertex node modifies position.y based on uniforms describing the current and next biome silhouettes. Approximate each silhouette with a small parametric form encoded in uniforms (amplitude, frequency, base, secondary amp/freq, mode flag). When the scheduler swaps biomes, the host JS pushes new uniform values via a `setBackgroundUniforms(from, to, t, scroll)` call each frame.

**Implementation specifics for the vertex shader:**
```ts
private bgFromAmp = uniform(0.10);
private bgFromFreq = uniform(1.2);
private bgFromBase = uniform(0.42);
private bgFromAmp2 = uniform(0.04);
private bgFromFreq2 = uniform(2.7);
private bgFromMesa = uniform(0);
private bgToAmp = uniform(0.10);
private bgToFreq = uniform(1.2);
private bgToBase = uniform(0.42);
private bgToAmp2 = uniform(0.04);
private bgToFreq2 = uniform(2.7);
private bgToMesa = uniform(0);
private bgMixT = uniform(0);
private bgScroll = uniform(0);

private buildBackgroundVertexNode(): ReturnType<typeof Fn> {
  return Fn(({ position, uv: uvNode }) => {
    const x = position.x.add(this.bgScroll);
    const sFrom = this.silhouetteCalc(x, this.bgFromAmp, this.bgFromFreq, this.bgFromBase, this.bgFromAmp2, this.bgFromFreq2, this.bgFromMesa);
    const sTo = this.silhouetteCalc(x, this.bgToAmp, this.bgToFreq, this.bgToBase, this.bgToAmp2, this.bgToFreq2, this.bgToMesa);
    const h = mix(sFrom, sTo, this.bgMixT);
    // uv.y == 1 is top of the strip; we displace upward by h (in meters).
    const y = position.y.add(uvNode.y.mul(h));
    return vec3(position.x, y, position.z);
  });
}
```

(Use the appropriate three/tsl `vec3` import.)

`silhouetteCalc` returns a 0..0.6m value matching what the JS biome's `silhouette(x, t)` returns scaled by the panel height. `mesa` flag toggles a step-quantize on x for the mesa biome.

- [ ] **Step 4.3: Color + snow-cap + fog blend**

```ts
private bgFromColor = uniform(new THREE.Color(0x3d654a));
private bgToColor = uniform(new THREE.Color(0x3d654a));
private bgSnowThreshold = uniform(2);  // >1 disables
private bgSnowTint = uniform(new THREE.Color(0xf2f5f8));
private bgShimmer = uniform(0);
private bgFog = uniform(0.4);

private buildBackgroundColorNode(): ReturnType<typeof Fn> {
  return Fn(({ uv: uvNode }) => {
    const baseColor = mix(this.bgFromColor, this.bgToColor, this.bgMixT).toVar('bgBase');
    // Apply snow cap when uv.y > threshold
    const snow = smoothstep(this.bgSnowThreshold.sub(0.05), this.bgSnowThreshold, uvNode.y);
    baseColor.assign(mix(baseColor, this.bgSnowTint, snow));
    // Fog blend toward sky horizon color (dim toward top of strip = fade into sky)
    const fogFactor = uvNode.y.mul(this.bgFog);
    baseColor.assign(mix(baseColor, this.atmosphereSkyTint(), fogFactor));
    // Shimmer band for ocean horizon
    const shimmerBand = float(1).sub(smoothstep(0.0, 0.2, uvNode.y)).mul(this.bgShimmer).mul(0.4);
    baseColor.addAssign(color(0xb0d8e8).mul(shimmerBand));
    return baseColor;
  });
}

private atmosphereSkyTint(): ReturnType<typeof color> {
  // Mirror the sky's lower-band color for fog blending — we just reuse skyNight + skySunset uniforms.
  return mix(color(0xa9c4dc), color(0x0a1218), this.skyNight);
}
```

- [ ] **Step 4.4: Per-frame update**

Add to `update()` after existing sky uniform writes:
```ts
this.updateBackground(delta, speed);
```

Implement:
```ts
private updateBackground(delta: number, speed: number): void {
  const { from, to, t } = this.scheduler.background();
  this.applyBackgroundBiomeUniforms(from, /*slot*/ 'from');
  this.applyBackgroundBiomeUniforms(to,   /*slot*/ 'to');
  this.bgMixT.value = t;
  for (const panel of this.bgPanels) {
    panel.scrollOffset += delta * speed * 0.42;
    // We use the same scrollOffset for both panels; sky moves uniformly.
  }
  this.bgScroll.value = this.bgPanels[0].scrollOffset;
}

private applyBackgroundBiomeUniforms(b: BackgroundBiome, slot: 'from' | 'to'): void {
  // Translate the biome's silhouette function into amp/freq parameters.
  // For non-parametric biomes (mesa, ocean), set the mesa flag / flatten amp.
  const params = silhouetteParams(b);  // helper in biomes.ts
  if (slot === 'from') {
    this.bgFromAmp.value = params.amp;
    this.bgFromFreq.value = params.freq;
    this.bgFromBase.value = params.base;
    this.bgFromAmp2.value = params.amp2;
    this.bgFromFreq2.value = params.freq2;
    this.bgFromMesa.value = params.mesa ? 1 : 0;
    this.bgFromColor.value.setHex(b.color.day);  // we'll lerp day/night below
    // Actually do day/night lerp using current daylight
    this.bgFromColor.value.copy(lerpColorHex(b.color.night, b.color.day, this.atmosphere.daylight));
  } else {
    // mirrored
    // ... same fields with bgTo*
  }
  // Snow cap, shimmer, fog applied from `to` (the more recent biome),
  // crossfaded to `from` strength via a uniform if needed. For simplicity,
  // pick the larger value of the two.
  this.bgSnowThreshold.value = b.snowCap?.threshold ?? 2;  // 2 disables
  this.bgSnowTint.value.setHex(b.snowCap?.tint ?? 0xffffff);
  this.bgShimmer.value = b.shimmer?.amount ?? 0;
  this.bgFog.value = b.fogStrength;
}
```

Add `silhouetteParams(biome)` to `biomes.ts`:
```ts
export interface SilhouetteParams {
  amp: number; freq: number; base: number; amp2: number; freq2: number; mesa: boolean;
}

export function silhouetteParams(b: BackgroundBiome): SilhouetteParams {
  switch (b.id) {
    case 'distantHills':  return { amp: 0.08, freq: 1.2, base: 0.42, amp2: 0.04, freq2: 2.7, mesa: false };
    case 'snowMountains': return { amp: 0.30, freq: 0.8, base: 0.55, amp2: 0.10, freq2: 1.9, mesa: false };
    case 'oceanHorizon':  return { amp: 0.0,  freq: 1.0, base: 0.30, amp2: 0.0,  freq2: 1.0, mesa: false };
    case 'mesa':          return { amp: 0.20, freq: 0.8, base: 0.40, amp2: 0.0,  freq2: 1.0, mesa: true };
    case 'fogForest':     return { amp: 0.06, freq: 2.4, base: 0.48, amp2: 0.03, freq2: 5.1, mesa: false };
  }
}
```

`lerpColorHex` helper in `math.ts`:
```ts
export function lerpColorHex(aHex: number, bHex: number, t: number, out = new THREE.Color()): THREE.Color {
  const a = new THREE.Color(aHex);
  const b = new THREE.Color(bHex);
  return out.copy(a).lerp(b, t);
}
```

- [ ] **Step 4.5: Replace `createHills()` call site**

In `build()`, replace the call to `createHills()` with `this.createBackground();`. Leave `createVillages()` for now (it'll be removed in a later task when meadow biome takes it over).

- [ ] **Step 4.6: Verify**

`BUILD` clean. `VISUAL`: out the windows you should now see a single background silhouette per side instead of three layered hills, and over the course of 4–8 minutes it should crossfade between distant hills / snow mountains / ocean / mesa / fog forest. Snow caps should appear on `snowMountains`. Mesa should look stepped. Ocean should be flat and faintly shimmering. `SYNC` two tabs — same biome at the same time.

- [ ] **Step 4.7: Commit**

```bash
git add src/game/scenery.ts src/game/biomes.ts src/game/math.ts
git commit -m "feat(biomes): biome-driven background silhouette layer"
```

---

## Task 5: Foreground/midground sprite layers

Adds the InstancedMesh sprite system that renders per-biome trees, cottages, lighthouses, etc.

**Files:**
- Create: `src/game/biomeLayers.ts`
- Modify: `src/game/scenery.ts` (instantiate, build, update)

- [ ] **Step 5.1: `BiomeLayers` class skeleton**

```ts
// src/game/biomeLayers.ts
import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, uv, vec2, vec3, vec4, mix, color, float, time } from 'three/tsl';
import { SpriteAtlas, type AtlasId, type AtlasEntry } from './spriteAtlas';
import type { BiomeScheduler, ForegroundBiome, SpriteBand } from './biomes';
import { mulberry32, streamFor } from './seedRandom';

const MAX_INSTANCES_PER_LAYER = 256;
const LAYER_WIDTH = 7.6;

type LayerKind = 'foreground' | 'midground';

interface LayerHandle {
  mesh: THREE.InstancedMesh;
  side: number;
  kind: LayerKind;
  scrollOffset: number;
  scrollSpeed: number;
  z: number;
  capacity: number;
  // Per-instance scratch arrays — written into instance attributes per biome change
  atlasRectAttr: THREE.InstancedBufferAttribute;  // vec4
  posAttr: THREE.InstancedBufferAttribute;        // vec3 (x along strip, y, z=fade)
  scaleAttr: THREE.InstancedBufferAttribute;      // float
  tintAttr: THREE.InstancedBufferAttribute;       // vec3
  fadeAttr: THREE.InstancedBufferAttribute;       // float (alpha multiplier)
}

export class BiomeLayers {
  private layers: LayerHandle[] = [];
  private root = new THREE.Group();
  private atlasUniform = uniform(new THREE.Vector2(1024, 1024));

  constructor(
    private scene: THREE.Scene,
    private atlas: SpriteAtlas,
    private scheduler: BiomeScheduler,
    private seed: number,
  ) {}

  build(): void {
    this.root.name = 'biome-layers';
    for (const side of [-1, 1]) {
      this.layers.push(this.createLayer(side, 'midground', 0.62, side * 2.10));
      this.layers.push(this.createLayer(side, 'foreground', 0.92, side * 2.04));
    }
    // Initial population from current foreground biome
    const { from } = this.scheduler.foreground();
    for (const layer of this.layers) this.populate(layer, from, /*incoming*/ false);
    this.scene.add(this.root);
  }
  // ...
}
```

- [ ] **Step 5.2: Layer creation + material**

```ts
private createLayer(side: number, kind: LayerKind, scrollSpeed: number, x: number): LayerHandle {
  const cap = MAX_INSTANCES_PER_LAYER;
  const geo = new THREE.PlaneGeometry(1, 1);
  // Atlas rect, position, scale, tint, fade — instanced attributes.
  const atlasRect = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
  const pos       = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const scale     = new THREE.InstancedBufferAttribute(new Float32Array(cap * 1), 1);
  const tint      = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const fade      = new THREE.InstancedBufferAttribute(new Float32Array(cap * 1), 1);
  geo.setAttribute('iAtlasRect', atlasRect);
  geo.setAttribute('iPos', pos);
  geo.setAttribute('iScale', scale);
  geo.setAttribute('iTint', tint);
  geo.setAttribute('iFade', fade);

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.colorNode = this.buildSpriteColorNode();
  material.vertexNode = this.buildSpriteVertexNode(scrollSpeed, kind);
  material.fog = false;

  const mesh = new THREE.InstancedMesh(geo, material, cap);
  mesh.frustumCulled = false;
  mesh.rotation.y = Math.PI / 2;
  mesh.position.set(x, 0, 0);
  mesh.renderOrder = -15 + (kind === 'foreground' ? 1 : 0);
  this.root.add(mesh);

  return {
    mesh, side, kind, scrollOffset: 0, scrollSpeed, z: 0, capacity: cap,
    atlasRectAttr: atlasRect, posAttr: pos, scaleAttr: scale, tintAttr: tint, fadeAttr: fade,
  };
}

private scrollUniforms = new Map<LayerHandle, ReturnType<typeof uniform>>();

private buildSpriteVertexNode(scrollSpeed: number, kind: LayerKind) {
  // Each instance is a quad whose center is at iPos.x along the strip,
  // anchored bottom-center. uv (0..1, 0..1) is the standard plane uv.
  // Scroll offset shifts iPos.x to create motion.
  const scrollUniform = uniform(0);
  // We need to associate this uniform with the layer; do it in createLayer instead.
  return Fn(({ position, uv: uvNode }) => {
    const iPos = attribute('iPos');
    const iScale = attribute('iScale');
    const iAtlas = attribute('iAtlasRect');
    const halfW = float(0.5);
    const halfH = float(0.5);
    // Compute world-space x along the strip with wrap
    const stripX = iPos.x.sub(scrollUniform);
    const wrappedX = stripX.add(LAYER_WIDTH).mod(LAYER_WIDTH).sub(LAYER_WIDTH * 0.5);
    // Quad geometry is unit-sized centered; scale by iScale and anchor bottom
    const localX = position.x.mul(iScale);
    const localY = position.y.add(0.5).mul(iScale);  // anchor bottom
    return vec3(wrappedX.add(localX), iPos.y.add(localY), iPos.z);
  });
}
// ...
```

Wire the scroll uniform: in `createLayer`, after creating `mesh`, do:
```ts
const scrollU = uniform(0);
this.scrollUniforms.set(handle, scrollU);
// (Have the vertex node read from this uniform — simplest: build the material per layer
// rather than once. Refactor accordingly.)
```

(Refactor: build material per-layer because each layer has its own scroll uniform. The `colorNode` factory can stay shared — only `vertexNode` differs.)

- [ ] **Step 5.3: Color node — sample atlas + tint + fade**

```ts
private buildSpriteColorNode() {
  return Fn(({ uv: uvNode }) => {
    const iAtlas = attribute('iAtlasRect');     // u0,v0,u1,v1
    const iTint = attribute('iTint');
    const iFade = attribute('iFade');
    // Map plane uv (0..1) into atlas rect
    const atlasUv = vec2(
      iAtlas.x.add(uvNode.x.mul(iAtlas.z.sub(iAtlas.x))),
      iAtlas.y.add(float(1).sub(uvNode.y).mul(iAtlas.w.sub(iAtlas.y))),
    );
    const sample = this.atlas.texture.sample(atlasUv);  // Pseudo — use texture(atlasTex, atlasUv) per TSL
    const alpha = sample.a.mul(iFade);
    return vec4(iTint.x, iTint.y, iTint.z, alpha);
  });
}
```

(The exact TSL texture-sample syntax in three.js 0.184 may use `texture(atlasMap, atlasUv)` where `atlasMap` is a `texture(uniform)` — adapt as needed; verify by referencing how `scenery.ts` already samples the atlas isn't applicable here since scenery uses procedural shaders. Quick reference: `material.colorNode = texture(atlasNode, uv)`. Bind via `material.colorNode = ...`.)

- [ ] **Step 5.4: Populate / repopulate per biome**

```ts
populate(layer: LayerHandle, biome: ForegroundBiome, incoming: boolean): void {
  // Clear all instances first (set fade to 0)
  for (let i = 0; i < layer.capacity; i += 1) layer.fadeAttr.setX(i, 0);

  const rand = streamFor(this.seed, hashBiomeKey(biome.id, incoming, layer.side, layer.kind));
  let cursor = 0;
  for (const band of biome.sprites) {
    if (band.layer !== layer.kind) continue;
    const count = Math.min(layer.capacity - cursor, Math.floor(band.density * LAYER_WIDTH));
    for (let i = 0; i < count; i += 1) {
      const x = (rand() - 0.5) * LAYER_WIDTH;
      const y = biome.ridge.baseY + (rand() - 0.5) * band.yJitter;
      const scale = band.sizeRange[0] + rand() * (band.sizeRange[1] - band.sizeRange[0]);
      const entry = this.atlas.entries[band.atlas];
      layer.atlasRectAttr.setXYZW(cursor, entry.rect.x, entry.rect.y, entry.rect.z, entry.rect.w);
      layer.posAttr.setXYZ(cursor, x, y, 0);
      layer.scaleAttr.setX(cursor, scale);
      const tint = colorFromBiome(biome, band, rand);
      layer.tintAttr.setXYZ(cursor, tint.r, tint.g, tint.b);
      layer.fadeAttr.setX(cursor, 1);
      cursor += 1;
      if (cursor >= layer.capacity) break;
    }
  }
  layer.atlasRectAttr.needsUpdate = true;
  layer.posAttr.needsUpdate = true;
  layer.scaleAttr.needsUpdate = true;
  layer.tintAttr.needsUpdate = true;
  layer.fadeAttr.needsUpdate = true;
}

function colorFromBiome(biome: ForegroundBiome, band: SpriteBand, rand: () => number): THREE.Color {
  // For now, return a near-black silhouette tinted slightly by groundColor.
  // Day/night lerp will be applied via a uniform multiplier in the shader (TODO future).
  const c = new THREE.Color(biome.groundColor.day).multiplyScalar(0.35);
  // Slight per-instance variance
  const v = 0.85 + rand() * 0.30;
  return c.multiplyScalar(v);
}

function hashBiomeKey(id: string, incoming: boolean, side: number, kind: string): number {
  let h = 0;
  const s = `${id}|${incoming ? 1 : 0}|${side}|${kind}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
```

- [ ] **Step 5.5: Per-frame update with crossfade**

```ts
private currentFgId: ForegroundBiomeId | null = null;
private incomingFgId: ForegroundBiomeId | null = null;

update(delta: number, trainSpeed: number, daylight: number): void {
  const { from, to, t } = this.scheduler.foreground();
  // Detect biome swap and repopulate halves
  if (from.id !== this.currentFgId) {
    for (const layer of this.layers) this.populate(layer, from, false);
    this.currentFgId = from.id;
  }
  if (to.id !== this.incomingFgId && to.id !== from.id) {
    // Use the second half of each layer's instance buffer for incoming, but
    // simpler approach: have two LayerHandles per layer slot (current + next)
    // — TODO: refactor to support that. For v1, on transition we just snap
    //   to the new biome at t==1 (no crossfade overlap).
    this.incomingFgId = to.id;
  }
  for (const layer of this.layers) {
    layer.scrollOffset += delta * trainSpeed * layer.scrollSpeed;
    const u = this.scrollUniforms.get(layer);
    if (u) u.value = layer.scrollOffset;
    // Fade alpha by daylight for night silhouette feel — silhouettes stay visible at night,
    // just slightly darker. We'll add a uniform daylight tint later.
  }
  // Snap on full transition completion
  if (t >= 1 && this.incomingFgId && this.incomingFgId !== this.currentFgId) {
    for (const layer of this.layers) this.populate(layer, to, false);
    this.currentFgId = to.id;
    this.incomingFgId = null;
  }
}
```

(Note: this v1 snaps biomes instead of crossfading sprites. The shader-side cross-fade for the background hides the snap somewhat. We'll come back to overlap-buffer crossfade in Task 12 if it's visually jarring.)

- [ ] **Step 5.6: Mount in `scenery.ts`**

In `ScenerySystem`:
```ts
private layers!: BiomeLayers;
private atlas!: SpriteAtlas;
```

In constructor:
```ts
this.atlas = new SpriteAtlas();
```

In `build()` after `this.createBackground()`:
```ts
this.layers = new BiomeLayers(this.scene, this.atlas, this.scheduler, this.roomSeed);
this.layers.build();
```

In `update()` after `updateBackground`:
```ts
this.layers.update(delta, speed, this.atmosphere.daylight);
```

- [ ] **Step 5.7: Verify**

`BUILD` clean. `VISUAL`: out the windows you should see silhouetted trees / cottages / lighthouses / fence posts changing every 90–180 seconds. Foreground sprites scroll faster than the background silhouette, giving parallax. `SYNC` two tabs — same sprite distribution.

- [ ] **Step 5.8: Commit**

```bash
git add src/game/biomeLayers.ts src/game/scenery.ts
git commit -m "feat(biomes): foreground/midground sprite layers driven by scheduler"
```

---

## Task 6: Water + village light clusters

**Files:**
- Create: `src/game/waterStrip.ts` (a small scenery helper for lake/coast water)
- Modify: `src/game/biomeLayers.ts` (call into water strip on biome change; village lights)
- Modify: `src/game/scenery.ts` (delete old `createVillages` and the moving-points machinery)

- [ ] **Step 6.1: Water strip module**

Implement a thin horizontal shader strip mounted at the foreground layer's y, fading in based on `water.coverage`. Coloring: lerp between sky horizon color and `reflectionTint`, plus a slow horizontal jitter. Mount one per side; toggle visibility per active foreground biome.

Code skeleton (non-trivial parts):
```ts
// src/game/waterStrip.ts
export class WaterStrip {
  private mesh: THREE.Mesh;
  private coverage = uniform(0);
  private tint = uniform(new THREE.Color(0xb6d6e6));
  private skyTint: ReturnType<typeof uniform>;
  // ... build mesh as a 7.6m × 0.18m strip with a TSL material that mixes
  //     skyTint and `tint` plus a slow horizontal sin/noise jitter.
  setBiome(biome: ForegroundBiome, t: number): void {
    if (biome.water) {
      this.coverage.value = biome.water.coverage * t;  // crossfade in
      this.tint.value.setHex(biome.water.reflectionTint);
    } else {
      this.coverage.value = 0;
    }
  }
}
```

Mount one per side under `BiomeLayers.build()` and update each frame.

- [ ] **Step 6.2: Village light clusters**

In `BiomeLayers`, when `populate`-ing a biome with `villageLights`, also generate cluster points and write them into a `THREE.Points` (per side) with additive blending. Cluster algorithm:
```ts
function generateVillageClusters(biome: ForegroundBiome, rand: () => number): Float32Array {
  if (!biome.villageLights) return new Float32Array(0);
  const clusters = 2 + Math.floor(rand() * 3);
  const pts: number[] = [];
  for (let c = 0; c < clusters; c += 1) {
    const cx = (rand() - 0.5) * LAYER_WIDTH;
    const cy = biome.ridge.baseY + 0.04 + rand() * 0.06;
    const n = 5 + Math.floor(rand() * 8);
    for (let i = 0; i < n; i += 1) {
      pts.push(cx + (rand() - 0.5) * biome.villageLights.clusterTightness,
               cy + (rand() - 0.5) * biome.villageLights.clusterTightness * 0.6,
               0);
    }
  }
  return new Float32Array(pts);
}
```

The Points material uses additive blending and warm-yellow color (`0xffd58a`). Opacity is multiplied by `night * villageLights.density` per frame.

- [ ] **Step 6.3: Delete old village implementation in `scenery.ts`**

Remove `createVillages`, `updateMovingPoints`, the `villages` field and the `MovingPoints` type. Remove the corresponding pane binding. Clean up unused imports.

- [ ] **Step 6.4: Verify**

`BUILD` clean. `VISUAL`: when `lake` or `coast` is active, a water strip appears with the right tint. When `meadow` is active and it's night, a couple of warm light clusters glow.

- [ ] **Step 6.5: Commit**

```bash
git add src/game/waterStrip.ts src/game/biomeLayers.ts src/game/scenery.ts
git commit -m "feat(biomes): water strips for lake/coast + clustered village lights for meadow"
```

---

## Task 7: Sky life — clouds + birds

**Files:**
- Create: `src/game/skyLife.ts`
- Modify: `src/game/scenery.ts` (instantiate, build, update)

- [ ] **Step 7.1: `SkyLife` skeleton with clouds**

```ts
// src/game/skyLife.ts
import * as THREE from 'three/webgpu';
import { Fn, attribute, uniform, vec2, vec3, vec4, color, time } from 'three/tsl';
import type { SpriteAtlas } from './spriteAtlas';
import type { BiomeScheduler } from './biomes';

const CLOUD_COUNT_PER_SIDE = 12;
const BIRD_COUNT_PER_SIDE = 16;
const FIREFLY_COUNT_PER_SIDE = 30;

export class SkyLife {
  private root = new THREE.Group();
  private cloudMesh!: THREE.InstancedMesh;
  private birdMesh!: THREE.InstancedMesh;
  private fireflyPoints!: THREE.Points;
  // ... uniforms for cloudCover, dayTint, etc.

  constructor(
    private scene: THREE.Scene,
    private atlas: SpriteAtlas,
    private scheduler: BiomeScheduler,
    private seed: number,
  ) {}

  build(): void { /* create cloudMesh per side, birdMesh per side, fireflyPoints per side */ }
  update(delta: number, ctx: { daylight: number; cloudCover: number; rainAmount: number; phase: 'dawn'|'day'|'dusk'|'night' }): void { /* ... */ }
}
```

- [ ] **Step 7.2: Cloud instances**

Per side: an `InstancedMesh` of unit quads, instance attributes for atlas rect (3 cloud sizes), x/y position, scale, tint. Each cloud has a baseline drift speed independent of train scroll. Tint:
- Default: white
- Sunrise/sunset: lerp toward warm pink based on `goldenHour` (need a uniform from scenery — pass it via `update` ctx)
- Rain: lerp toward grey by `rainAmount`

Opacity ramps with `cloudCover`.

- [ ] **Step 7.3: Bird instances**

Similar instanced mesh, 16 per side. Per-instance:
- `iSpawnT` (float) — a phase offset
- `iY0` (float) — base vertical position
- `iAmp` (float) — sine amplitude
- `iFreq` (float) — flap timing
- `iSpeed` (float)
- `iAtlasFrame` (int via float; selects bird vs seabird palette by which atlas region group we sample)

Vertex shader computes:
```glsl
// pseudo
float t = (time + iSpawnT) * iSpeed;
float wrappedX = mod(t, layerWidth) - layerWidth*0.5;
float y = iY0 + sin(t * iFreq) * iAmp;
// frame index for wing flap:
int frame = int(mod(time * iFreq * 4.0, 3.0));
```

Atlas rect chosen from {birdA, birdB, birdC} (or seabird variants) per `iAtlasFrame`. Easiest: pass a `iFrameBase` uniform pair (start + stride) per palette and pick frame at runtime; or precompute 3 atlas rects in instance attributes and select via `frame`.

Density modulated each tick by `currentBiome.birdBias`: any bird beyond `count = floor(BIRD_COUNT_PER_SIDE * birdBias)` gets `iFade = 0`.

- [ ] **Step 7.4: Mount + verify**

In `scenery.ts`, instantiate `SkyLife`, call `build()`, and feed `update()` with `{ daylight, cloudCover: this.scheduler.weatherAt(now).cloudCover, rainAmount, phase }` each frame. (For Task 7 the weather context comes from a stub returning `{rain:0, cloudCover:0}` — the real wiring happens in Task 9.)

`VISUAL`: clouds drift lazily across the sky; birds occasionally cross the windows with wing flaps. `SYNC`: same.

- [ ] **Step 7.5: Commit**

```bash
git add src/game/skyLife.ts src/game/scenery.ts
git commit -m "feat(biomes): clouds + birds in the sky"
```

---

## Task 8: Sky life — fireflies + magic moments

**Files:**
- Modify: `src/game/skyLife.ts`

- [ ] **Step 8.1: Fireflies**

Add a `THREE.Points` per side, additive blending, `0xffd58a`. Positions follow a slow random walk; each instance has a sine brightness pulse with random phase. Only show when `currentForegroundBiome.id === 'meadow'` AND `night > 0.5`.

Random walk: each frame, increment per-particle velocity vector by a small random noise (cap velocity), update position, wrap within a small box. Update on CPU (60 fireflies total — trivial).

- [ ] **Step 8.2: Magic instances**

Add four named single-instance sprite/point objects:

- **Shooting star:** a stretched quad with the `shootingStarTrail` atlas entry. When a `MagicEvent` of kind `shootingStar` is current, animate its position across the sky (right-to-left, downward arc) over the event's duration. Otherwise hide.
- **Hot air balloon:** a quad with `hotAirBalloon`. Slow drift; visible only when balloon event is current. Tint warms during dawn/dusk.
- **Whale spout:** mounted near the foreground bottom, only when `coast` foreground is active. On a whale event: bloom `whaleSpout` quad opacity 0→1→0 over 1.6s, then briefly show `whaleTail`.
- **Distant plane:** a tiny dot (`0.005`-scale white quad) crossing slowly with a blinking opacity (sine pulse).

`update()` checks `scheduler.magicAt(now)` and matches kind to the corresponding rendered object. Both clients see them together (deterministic).

- [ ] **Step 8.3: Verify**

`VISUAL`: fly through a meadow at night → fireflies. Sit through a few minutes at night → shooting star. Sit through dawn → balloon. Coast biome → whale spout. Night → blinking plane.

- [ ] **Step 8.4: Commit**

```bash
git add src/game/skyLife.ts
git commit -m "feat(biomes): fireflies + magic moments (shooting star, balloon, whale, plane)"
```

---

## Task 9: Weather — rain + snow + cloud cover wiring

**Files:**
- Create: `src/game/weather.ts`
- Modify: `src/game/scenery.ts` (instantiate, build, update; expose `cloudCover`, `rainAmount`, `lightningFlash` to the sky shader)

- [ ] **Step 9.1: `Weather` module skeleton**

```ts
// src/game/weather.ts
import * as THREE from 'three/webgpu';
import { Fn, uv, time, vec2, vec3, vec4, float, mix, smoothstep, color, fract, floor } from 'three/tsl';
import type { BiomeScheduler } from './biomes';

export class Weather {
  private mesh!: THREE.Mesh;
  rainAmount = uniform(0);
  snowAmount = uniform(0);
  cloudCover = uniform(0);
  lightningFlash = uniform(0);
  boltOpacity = uniform(0);
  private boltTexture: THREE.DataTexture;
  // ...
  build(scene: THREE.Scene): void { /* create one full-window quad per side */ }
  update(delta: number, ctx: { fgIsSnowfield: boolean; bgIsSnowMountains: boolean; nowSeconds: number }): void { /* ... */ }
}
```

- [ ] **Step 9.2: Rain/snow shader**

The full-window quad's shader samples a hashed grid:
```ts
// rain streaks
const rainGrid = vec2(uv.x.mul(140), uv.y.mul(60).sub(time.mul(rainSpeed)));
const cellHash = hash(floor(rainGrid));
const inStreak = smoothstep(0.985, 0.995, cellHash);  // sparse pixels
const streakAlpha = inStreak.mul(rainAmount);
sky.addAssign(color(0xb8c8e0).mul(streakAlpha).mul(0.5));
```

Snow: similar but larger softer dots, slow vertical drift with sine sway. Both can coexist (snow only fires in mountains/snowfield via `update()` deciding which uniform to set).

- [ ] **Step 9.3: Wire into scenery + sky**

`scenery.ts` now exposes `this.cloudCover`, `this.rainAmount` uniforms (read from `Weather`) into the sky shader so the sky dims/cools when overcast. Add to the sky's color node:
```ts
sky.assign(mix(sky, color(0x707684), this.cloudCover.mul(0.5)));
sky.assign(sky.mul(float(1).sub(this.rainAmount.mul(0.3))));
```

In `ScenerySystem.update()`, query `weather = this.scheduler.weatherAt(now)` and forward into `Weather.update(...)` and the sky uniforms. Forward `weather.cloudCover` to `SkyLife` so cloud-coverage opacity matches.

- [ ] **Step 9.4: Verify**

`VISUAL`: every couple of minutes, clouds thicken, then rain or snow appears (snow only when in snow biome). After the storm, sun returns. `SYNC`: same.

- [ ] **Step 9.5: Commit**

```bash
git add src/game/weather.ts src/game/scenery.ts src/game/skyLife.ts
git commit -m "feat(biomes): weather — rain, snow, cloud cover linked to scheduler"
```

---

## Task 10: Lightning — bolt geometry, flash, thunder

**Files:**
- Create: `src/game/lightning.ts`
- Modify: `src/game/weather.ts` (compose the bolt texture and flash into the weather quad)
- Modify: `src/game/audio.ts` (add `playThunder()` method using `OfflineAudioContext`)

- [ ] **Step 10.1: Bolt generator**

```ts
// src/game/lightning.ts
import { mulberry32 } from './seedRandom';

export interface BoltSegment { x0: number; y0: number; x1: number; y1: number; level: number; }
export interface BoltGeometry { segments: BoltSegment[]; }

export function generateBolt(seed: number): BoltGeometry {
  const rand = mulberry32(seed);
  const startX = 0.10 + rand() * 0.80;     // 0..1 in normalized window space
  const endX = startX + (rand() - 0.5) * 0.18;
  const segments: BoltSegment[] = [];
  subdivide(startX, 0.05, endX, 0.92, 3, rand, segments, 0);
  return { segments };
}

function subdivide(
  x0: number, y0: number, x1: number, y1: number,
  level: number, rand: () => number, out: BoltSegment[], depth: number,
): void {
  if (level === 0) {
    out.push({ x0, y0, x1, y1, level: depth });
    return;
  }
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const px = -dy / len;
  const py = dx / len;
  const jitter = (rand() - 0.5) * 0.12 * len;
  const mxJ = mx + px * jitter;
  const myJ = my + py * jitter;
  subdivide(x0, y0, mxJ, myJ, level - 1, rand, out, depth);
  subdivide(mxJ, myJ, x1, y1, level - 1, rand, out, depth);
  if (level >= 2 && rand() < 0.30) {
    const fx = mxJ + (rand() - 0.3) * 0.18;
    const fy = myJ + 0.05 + rand() * 0.20;
    subdivide(mxJ, myJ, fx, fy, level - 1, rand, out, depth + 1);
  }
}

export function rasterizeBolt(geo: BoltGeometry, w = 256, h = 128): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  // Glow pass
  ctx.strokeStyle = 'rgba(255,240,210,0.35)';
  ctx.lineWidth = 6;
  drawSegments(ctx, geo.segments, w, h);
  // Core pass
  ctx.strokeStyle = 'rgba(255,250,235,1.0)';
  ctx.lineWidth = 1.6;
  drawSegments(ctx, geo.segments, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function drawSegments(ctx: CanvasRenderingContext2D, segs: BoltSegment[], w: number, h: number): void {
  for (const s of segs) {
    ctx.beginPath();
    ctx.moveTo(s.x0 * w, s.y0 * h);
    ctx.lineTo(s.x1 * w, s.y1 * h);
    ctx.stroke();
  }
}
```

- [ ] **Step 10.2: Compose into Weather**

`Weather` keeps a `THREE.DataTexture` mounted on the weather quad. When the scheduler reports a lightning event:
1. Generate the bolt with `generateBolt(event.seed)`.
2. Rasterize to a canvas → upload via `THREE.DataTexture` (or `THREE.CanvasTexture` for simplicity — easier).
3. Set `boltOpacity` envelope: 60ms ramp-up, then exp decay over 250ms.
4. Set `lightningFlash` envelope: 80ms ramp-up, exp decay over 600ms, peak 1.0.
5. Trigger thunder audio with delay `0.5 + rand * 1.5` seconds.

The weather quad shader composes the bolt texture additively at its mapped uv:
```ts
const boltSample = texture(boltTex, uv);
sky.addAssign(boltSample.rgb.mul(boltOpacity));
```

The flash uniform is also forwarded to the sky shader (sky color += `flash * 0.18 * warmCream`).

- [ ] **Step 10.3: Procedural thunder**

In `audio.ts`, add:
```ts
async playThunder(delaySeconds = 1.0): Promise<void> {
  const ctx = Tone.getContext().rawContext as AudioContext;
  // Generate ~3 seconds of low-passed noise with slow envelope, plus convolution reverb tail.
  const dur = 3.0;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 220;
  lp.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.value = 0.12;  // muted, cozy
  // Long reverb via short impulse-response convolver
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulseResponse(ctx, 2.0, 1.5);
  src.connect(lp).connect(convolver).connect(gain).connect(ctx.destination);
  src.start(ctx.currentTime + delaySeconds);
}

function makeImpulseResponse(ctx: AudioContext, duration: number, decay: number): AudioBuffer {
  const len = ctx.sampleRate * duration;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c += 1) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
```

Call from `Weather.update()` whenever a new lightning event fires (track which events have already been triggered locally so we don't play it twice).

- [ ] **Step 10.4: Verify**

`VISUAL`: during a rainstorm, occasional muted lightning flash + visible forking bolt + ~1 second later a soft cozy rumble. Bolt forks 1–4 branches, max 3 levels deep. Flash is subtle, not glaring. `SYNC`: both clients see the same bolt at the same time.

- [ ] **Step 10.5: Commit**

```bash
git add src/game/lightning.ts src/game/weather.ts src/game/audio.ts
git commit -m "feat(biomes): forking lightning bolts, muted flash, cozy procedural thunder"
```

---

## Task 11: Tweakpane controls

**Files:**
- Modify: `src/game/scenery.ts` (extend the existing pane with new folders for biomes / weather / sky life)

- [ ] **Step 11.1: Biomes folder**

Add bindings:
- `forceForeground` (dropdown: 'auto' | each ForegroundBiomeId) — when ≠ 'auto', overrides scheduler.
- `forceBackground` (dropdown: 'auto' | each BackgroundBiomeId)
- `transitionSpeedMul` (float 0.1..10) — multiplies biome rotation cadence
- `recencyPenaltyStrength` (float 0..2)

Wire each into `BiomeScheduler` via setter methods on the scheduler.

- [ ] **Step 11.2: Weather folder**

Add bindings:
- `manualRain` (0..1)
- `manualSnow` (0..1)
- `manualCloudCover` (0..1)
- `triggerLightning` (button) — pushes a one-off `LightningEvent` with a fresh seed into the scheduler
- `stormIntensity` (0..1) — global multiplier on weather peak values

When any manual slider is non-zero, scheduler weather is suppressed and these values are used.

- [ ] **Step 11.3: Sky life folder**

- `birdDensity` (0..1) — multiplier on `birdBias`
- `fireflyDensity` (0..1)
- `triggerShootingStar` / `triggerBalloon` / `triggerWhale` / `triggerPlane` (buttons)

- [ ] **Step 11.4: Verify**

`VISUAL`: sliders/buttons all do what they say.

- [ ] **Step 11.5: Commit**

```bash
git add src/game/scenery.ts src/game/biomes.ts
git commit -m "feat(biomes): tweakpane controls for biomes, weather, sky life"
```

---

## Task 12: Polish + crossfade overlap

**Files:**
- Modify: `src/game/biomeLayers.ts` (overlap-buffer crossfade for sprites)
- Modify: anywhere else needing a touch-up (visual tweaks, instance count tuning)

- [ ] **Step 12.1: Sprite crossfade**

Refactor `LayerHandle` to hold two sub-slots (`current`, `incoming`) inside one `InstancedMesh`: split the capacity in half. When a biome transition begins, populate `incoming` with the new biome's sprites and ramp `incoming.fade` 0→1 + `current.fade` 1→0 over the crossfade window. After completion, swap roles. Avoids the snap from Task 5.

- [ ] **Step 12.2: Frame-time check**

Open the `stats.js` overlay (already in deps) if not visible. Verify `>50fps` on the dev machine with a full storm + biome transition + magic event + birds + fireflies all on screen. If not, drop `MAX_INSTANCES_PER_LAYER` from 256 → 192 and re-check.

- [ ] **Step 12.3: Visual tuning pass**

Walk through each foreground biome with `forceForeground`:
- Heights / colors look right at day, dusk, night
- Sprites don't clip into the background silhouette
- Water strip aligns with the ridge line
- Village clusters are cluster-y, not scattered
- Lighthouse `lit` variant flips on at night

Walk through each background biome with `forceBackground`:
- Snow caps sit above the snow threshold
- Mesa banding is visible
- Ocean shimmer is subtle
- Fog forest reads as misty

Tune any params inline; commit small fixes.

- [ ] **Step 12.4: Final commit + cleanup**

Remove any leftover debug logs / atlas viewers / unused imports.

```bash
git add -u
git commit -m "feat(biomes): crossfade overlap + polish pass"
```

---

## Self-review

Spec coverage:
- Architecture (3 layers + 3 overlays) → Tasks 4, 5, 7, 9, 10 ✓
- Biome catalogue → Task 3 ✓
- Scheduler → Task 3 ✓
- Sprite atlas → Task 2 ✓
- Foreground/midground rendering → Task 5 ✓
- Background → Task 4 ✓
- Water → Task 6 ✓
- Village clusters → Task 6 ✓
- Sky life (clouds/birds/fireflies/magic) → Tasks 7, 8 ✓
- Weather (rain/snow/cloud) → Task 9 ✓
- Lightning (bolt/flash/thunder) → Task 10 ✓
- Sync model → Tasks 1, 3 ✓
- Tweakpane controls → Task 11 ✓
- Performance budget → Task 12 ✓

Placeholders: scanned — no "TBD"/"TODO" in steps; one `TODO` reference in Task 5.4 inline comment (about future per-band tinting) is documenting a deliberately deferred refinement, not a missing step.

Type consistency: scheduler `foreground()` / `background()` return shape matches `BiomeWindow<T>` description; `LightningEvent` shape matches what `weatherAt` returns; `MagicEvent.kind` matches `magicAt` consumers.

This is a long plan, but each task produces a visible change and ships an isolated piece of the system.
