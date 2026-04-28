# Instrument & Sound-Sculpture Redesign

**Status:** design — pending implementation
**Date:** 2026-04-28
**Supersedes:** `2026-04-26-three-instruments-design.md` (the four-instrument frame)

## Why

Today's instruments — Aurora Loom, Wind Chime, Ripple Orbs, Starlace Harp — feel disconnected from each other and from the centerpiece. The `CenterStage` system reads both players' voice state but its bridges/rings/core decay the moment you stop playing, so nothing accumulates. Two players don't get a shared object out of their performance, just a momentary glow.

The redesign centers the experience on a **sound sculpture**: a particle-built form at the center of the cabin that grows from both players' playing over a configurable round, then dissolves and starts fresh. The instruments shrink to two — one rhythmic, one melodic — so the duet is musically meaningful and easy to grasp.

## Goals

- Two players' playing produces a single, beautiful, ever-changing sculpture in the middle of the scene.
- Players feel each other while playing, not only when looking at the sculpture.
- The instruments themselves feel sharp, fun, and clearly different.
- Round system is a sculpture lifecycle — players never have to pause or wait.
- All durations are tweakable so we can find the right pacing in play.

## Non-goals

- A scoring or trophy system.
- A persistent gallery of past sculptures.
- A "rest" period that gates input.
- Saving sculptures to disk or sharing them externally.

## Instruments

Two instruments: **Drum** (rhythmic) and **Starlace** (melodic). Both selectable by either player. The robot partner always picks the *opposite* of the local player's selection, so every solo round is the marquee drum + melody duet.

Instrument swaps take effect at the next round boundary so the sculpture archetype doesn't shift mid-build.

### Drum

Renamed from "Ripple Orbs". Existing mechanics, ripples, hit detection, and audio are preserved verbatim — the surface a player interacts with is unchanged.

Adds:

- **Stable key bindings.** Middle row `A S D F G H J K L`, mapped to the existing orbs in pitch order. Mouse-click on an orb counts as a hit. Hand contact unchanged.
- **Energy emitter.** Each hit fires a *spark cluster* — 40–80 particles bursting from the hit point, biased toward the center stage over ~0.6s. Color: warm orange/amber palette. Burst size scales with hit velocity. Particles feed the sculpture's archetype attractor.

### Starlace

Same conceptual mechanics (pluckable nodes, glissando by sweeping). Visuals fully rewritten to a 3D constellation matching the reference image: glowing nodes in an organic radial cluster, multi-color (magenta / cyan / amber-gold), connection lines between near-neighbors that brighten on activity, ambient floating motes around the cluster, heavy bloom.

- ~30–50 nodes total. The first 8 in pitch order are bound to the middle row `A S D F G H J K L` (same physical keys as the drum — only one instrument is selected at a time, so the binding remaps). Hand and mouse can pluck any node.
- Plucking a node sends a visible wave along its connection lines outward to neighbors.
- **Energy emitter.** Each pluck launches a *star-streak* — a short comet-trail of ~20–30 particles from the node, color-biased to the node's hue, traveling toward the center over ~0.8s. The sculpture inherits Starlace's multi-color palette through these streaks.

### Removed instruments

`HarmonicLoom` and `WindChime` are deleted outright — files, imports, picker buttons, instrument metadata entries, audio routing branches in `handSynth.ts`. The `'orbs'` instrument id is renamed to `'drum'` everywhere, including the SpaceTime sync field. Legacy values from older clients (`'orbs'`, `'loom'`, `'chime'`) all read as `'drum'` so connecting to a room from a stale client doesn't error — they just default to the safe instrument.

## Round system

A new `RoundDirector` owns the round state machine. States:

- **`idle`** — pre-first-round and on disconnect. No particles flow to the sculptor; instruments are still fully playable as a free toy.
- **`playing`** — continuous. Default 30s, tweakable 10–120s.
- **`dissolving`** — a brief micro-state at each round boundary. Default 1.5s, tweakable 0.5–4s. The current sculpture's particles get an outward velocity burst + fade; new particles begin arriving for the fresh sculpture immediately. Players never pause; the cycle is invisible to input.

There is no rest period and no manual ready-up. The cycle just loops `playing → dissolving → playing → ...` forever.

**Timer affordance: in-world ring.** A thin glowing ring rendered around the sculpture in 3D space, depleting as the round progresses, full at start. No DOM-overlay timer — keeps the player's eyes on the sculpture and avoids competing with playing.

## EnergySculptor (the centerpiece system)

Replaces `CenterStage`. Three layers.

### 1. Particle pool (WebGPU compute)

A single pool of 12,288 particles (default; tweakable via `particlePoolSize`), allocated half to "drum-flavored" and half to "melody-flavored" slots — enough for two full streams without thrashing. Each particle has:

- position, velocity, age, lifetime
- color (RGB), size
- source-instrument tag (drum | starlace)
- archetype-target offset (where in the attractor this particle wants to land)

A compute pass per frame:

1. Integrates velocity into position
2. Applies attractor force toward this particle's slot in the current archetype's shape
3. Applies cross-current force from the *other* instrument's coarse density grid (sampled from the previous frame's particle positions)
4. Decays age; dead particles return to the free list

During `dissolving`, the compute pass instead applies an outward velocity burst + accelerated age decay; the pool returns to "available" as particles die, ready for the next round.

### 2. Per-archetype attractor curves

Three archetypes for the three pairings: drum+drum, melody+melody, drum+melody. Each is a small TypeScript module under `src/game/sculptor/archetypes/` exporting:

- `shape(t: 0..1, seed): Vec3[]` — the curve(s)/point cloud the particles want to occupy. `t` is `elapsed / roundDuration` so the sculpture grows with the round (e.g. drum+drum starts as a stub and builds into a tower).
- `flow(p: Vec3, t): Vec3` — directional bias applied along the way (e.g. drum+drum lifts upward; melody+melody braids horizontally; duet swirls into a halo'd column).
- `colorBlend(srcColor, t): Vec3` — how the two source palettes mix in this archetype.

The three archetypes:

- **drum+drum** — *Stalagmite tower.* Vertical staccato structure, bands of dense particles where beats clustered, ascending over the round.
- **melody+melody** — *Woven braid.* Horizontal flowing curves intertwining; pitch height of plucks pushes braid threads up and down.
- **drum+melody (duet)** — *Halo'd column.* A central rising column from the drum stream surrounded by an orbiting ring of starlace streaks; duet-bonus moments leave bright knots along the column.

### 3. Dissolve transition

At round boundary:

1. `RoundDirector` emits `dissolving`.
2. EnergySculptor flips a uniform; compute pass switches to dissolve mode (outward burst, accelerated age).
3. After `dissolveDuration` seconds, sculptor begins consuming particles for the new archetype (which is selected from the current player instruments — accounts for instrument swap if any).

No persistence. No gallery. No saved data.

## Cross-currents and duet bonus

Both layered on top of the basic stream-to-center flow.

**Cross-currents.** Each frame, the compute pass samples a low-resolution 3D presence field (a coarse density grid filled by the *other* player's particles last frame) and applies a deflection force. Drum particles passing through Starlace's corridor get jostled; Starlace streaks curving past drum sparks get color-tinted slightly.

**Duet bonus.** When both players are simultaneously active — drum hit + Starlace pluck within ~0.4s of each other — a synchrony beat fires:

- Both players' next emitted particles get a brightness/size/lifetime boost
- The archetype attractor briefly pulls harder, leaving a visibly denser knot
- A faint shared "synchrony ring" pulses outward from the center as feedback

Always additive, never punitive. Solo playing is still pretty, just less rich.

## Architecture

### New files

- `src/game/RoundDirector.ts` — round state machine, elapsed timer, configurable durations, event broadcaster.
- `src/game/EnergySculptor.ts` — WebGPU compute pipeline, particle pool, archetype dispatcher, dissolve transition, in-world timer ring.
- `src/game/sculptor/EnergyEmitter.ts` — shared interface + helpers (burst, streak).
- `src/game/sculptor/archetypes/drumDrum.ts`
- `src/game/sculptor/archetypes/melodyMelody.ts`
- `src/game/sculptor/archetypes/drumMelody.ts`
- `src/game/visuals/Drum.ts` — moved/renamed from `OrbDrums.ts`. Mechanics preserved; gains an `EnergyEmitter` field.
- `src/game/visuals/Starlace.ts` — full rewrite of `StarlaceHarp.ts` to the constellation visual + multi-color palette + energy streak emitter on pluck.

### Files deleted

- `src/game/CenterStage.ts`
- `src/game/visuals/HarmonicLoom.ts`
- `src/game/visuals/WindChime.ts`
- The old `OrbDrums.ts` and `StarlaceHarp.ts` are replaced by their successors above.

### Files modified

- `src/game/instruments.ts` — `InstrumentId` narrows to `'drum' | 'starlace'`; `INSTRUMENTS` map updated; `INSTRUMENT_IDS` shrinks; `isInstrumentId` updated. `'orbs'`/`'loom'`/`'chime'` legacy strings normalize to `'drum'`.
- `src/game/handSynth.ts` — drop loom + chime branches; orb-as-drum branch retained (paths just renamed); starlace branch retained.
- `src/game/Game.ts` — replace `CenterStage` instantiation with `EnergySculptor`; install `RoundDirector`; wire instrument emitters to sculptor; remove old instrument branches in `installPlayerVisual`.
- `src/game/multiplayer.ts` — robot-partner picks the *opposite* of the local player's instrument; partner instrument override applied at round boundaries (queued during a round, applied on the next `dissolving → playing` edge).
- `src/hud/components/InstrumentPicker.ts` — only two buttons now (drum + starlace).
- `src/hud/Hud.ts` — drop the four-instrument assumptions; everything else stays.

### Data flow per frame

1. `HandSynth` produces `VoiceState` for each player (existing).
2. Each instrument visual reads its `VoiceState` + discrete events (orb hit, starlace pluck), calls `EnergyEmitter.emit(...)` with N particles into the sculptor's compute buffer.
3. `EnergySculptor` runs one compute pass: integrate, attract, cross-current, age, fade.
4. `RoundDirector` ticks elapsed; on boundary → triggers dissolve transition + selects new archetype based on current player instruments.
5. Render: sculptor draws particles + timer ring; instruments draw their interactive surfaces.

## Tweakable params

Added under existing `*_DEFS` / tweakpane scheme. Persisted to `localStorage` per the project convention; `r` resets to code defaults when debug mode is active.

`RoundDirector`:

- `roundDuration` (10–120s, default 30, step 1)
- `dissolveDuration` (0.5–4s, default 1.5, step 0.1)

`EnergySculptor`:

- `particlePoolSize` (4096–24576, default 12288, step 256)
- `crossCurrentStrength` (0–1, default 0.35)
- `duetBonusGain` (0–2, default 1.2)
- `attractorStrength` (0–4, default 1.5)
- `dissolveBurstSpeed` (0–8, default 3)

Per-archetype params (each archetype module exposes its own defs):

- shape scale, flow strength, color mix bias

Per-instrument emitter params:

- spark burst size range (drum)
- streak length and lifetime (starlace)

## Solo / robot partner

The robot picks the opposite instrument of the local player and emits at moderate energy. Robot-emitted particles go into the same pool tagged with the same source-instrument tag as a real partner would produce, so the archetype + cross-currents + duet bonus all behave identically. From the sculptor's point of view, "robot" doesn't exist — it just sees a second stream.

The robot's playing pattern is intentionally simple: gentle steady cadence on whichever instrument it owns. The duet bonus still fires when the local player aligns; a player who plays nothing gets a quieter, sparser sculpture.

## Testing

Visual smoke verification on every change. The project has no unit-test suite and we won't introduce one for this — the system is real-time visual/audio.

Verification path after implementation:

1. Build runs clean (`tsc`, Vite) with no console errors on cold load.
2. Drum hits visibly emit warm spark clusters that travel to and feed the central sculpture.
3. Starlace plucks emit color-tinted star-streaks that travel to and feed the central sculpture.
4. Sculpture archetype matches the current pairing (verified by visual identity — tower vs braid vs halo'd column).
5. Round timer ring depletes over `roundDuration`; sculpture dissolves at the boundary; new sculpture begins immediately.
6. Robot partner picks the opposite instrument and the swap takes effect at the next boundary, not mid-round.
7. Duet synchrony ring fires when drum + starlace events align within ~0.4s.
8. Tweakpane changes to `roundDuration`, `dissolveDuration`, `particlePoolSize`, `crossCurrentStrength`, `duetBonusGain` all visibly affect behavior live.
9. Pressing `r` in debug mode resets all new params to defaults.

## Risks

- **WebGPU compute particle pipeline** is the largest unknown; if the project doesn't already have a compute pass plumbed end-to-end, this is the first one. Plan B (graceful): start with a CPU-driven particle integrator with the same data shape, swap in the compute pass once visuals are right. Same instrument and emitter contracts either way.
- **Archetype legibility.** Three archetypes that "feel different" requires real tuning. Mitigation: ship with strong silhouette differences (vertical, horizontal, columnar), then refine in tweakpane.
- **Multi-color Starlace bloom + 12k particles** could be heavy on lower-end GPUs. Mitigation: `particlePoolSize` is tweakable; can downshift to 4–8k if needed without changing behavior.

## Out of scope (future)

- Persistent gallery / saving sculptures.
- More than two instruments.
- Scoring / win conditions.
- Per-archetype audio tail (the sculpture making its own sound at round end).
- Cross-room or spectator viewing.
