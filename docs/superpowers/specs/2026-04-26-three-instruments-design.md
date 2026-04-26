# Three Instruments — Design

**Date:** 2026-04-26
**Replaces:** `PlasmaOrb` (deleted as part of this work)

## Problem

The current visualizer is a single shared ray-marched metaball orb (`src/game/plasmaOrb.ts`) that aggregates both players' fingertips into one field. Two issues:

1. **Performance.** Ray-marching with up to 21 metaballs per pixel is too slow on the current hardware budget.
2. **Identity.** A single shared orb has no per-player identity. The Captain-Planet "let our powers combine" fantasy needs each player to *own a thing* between their hands, then have those things meet at the table center.

## Goals

- Each player controls their own instrument visualization between their two hands.
- Three distinct instruments — one ribbony, one orb-bloom, one GPU-particle stream — each with its own audio voice and visual.
- All three instruments combine well in any pairing (same–same and any cross pair) without per-pair special-case logic.
- A subtle shared "bond" effect appears at the center when both players are simultaneously energetic.
- Players can switch instruments live; selection syncs across the multiplayer session.
- New players auto-default to an instrument the existing player isn't currently using.

## Non-goals

- No per-pair combo effects (Stream+Bloom = X, Bloom+Sparks = Y, etc.). Combine is **layered, not branched**.
- No instrument unlocking, progression, or per-room defaults. Instruments are always available, selection is per-player.
- No re-tuning of musical scales or audio mix. The existing scale (minor pentatonic) and master mix stay as-is.

---

## The three instruments

Each instrument is an `InstrumentDef` bundling **audio**, **per-player visual**, and **center contribution**.

### 1. Cedar Flute — Ribbon

| | |
|---|---|
| **Audio** | Triangle oscillator + vibrato + reverb. Same as the existing `flute` voice in `handSynth.ts`. |
| **Per-player visual** | A `PlaneGeometry` strip stretched between the player's two palm positions. Vertex shader displaces the strip on a sine wave (note pulse boosts amplitude). Fragment shader runs a scrolling aurora-noise texture, blue/cyan tones. |
| **Center contribution** | A long ribbon arc that passes **through** the table center, oriented perpendicular to the player's seat. Height/glow scales with `voice.active` + `voice.pulse`. |
| **Tech notes** | One `THREE.Mesh` per player, frustum-culled off, additive blending. Strip resolution ~24 segments. No compute shaders. |

### 2. Velvet Bell — Bloom

| | |
|---|---|
| **Audio** | FM bell. Same as the existing `rhodes` voice. |
| **Per-player visual** | A camera-facing `PlaneGeometry` billboard between the hands. Soft radial-gradient texture (painterly, like the user's reference image). Scale and opacity pulse on each note attack via `voice.pulse`. Magenta/gold tones. |
| **Center contribution** | A larger billboard orb hovering over the center pole, breathing with the player's `pulse`. |
| **Tech notes** | Single sprite plane per player + per center-piece. Texture is a procedural radial gradient baked at startup (no per-frame texture work). Additive blend. Trivially cheap. |

### 3. Glass Sparks — Streaming particles

| | |
|---|---|
| **Audio** | New voice. `Tone.PluckSynth` (Karplus-Strong) into a shimmer reverb (long decay + +12 pitch shift on the wet bus). Crystalline pluck attack, fairy-dust sustain. Same scale + same pitch/expression mapping as the other two. |
| **Per-player visual** | TSL **compute-shader** particle system (~512 particles per player). Particles spawn near the left palm, follow a curved path to the right palm, fade out. `voice.pulse` boosts spawn rate; `voice.active` keeps the stream alive. Gold/amber. |
| **Center contribution** | A second compute-particle pass: ~256 particles in an orbital ring around the center pole, slowly spinning. Density scales with active+energy. |
| **Tech notes** | Uses `three/webgpu` TSL compute (project already imports `three/webgpu`). Storage buffer for particle position+age+seed; one compute dispatch per frame to advance + respawn; one render pass with point sprites. |

---

## Combine behavior

There is **no special-case pair logic**. Each instrument always projects its own center contribution whenever its player is actively making sound. The "let our powers combine" image emerges from layering:

- Both playing Flute → two ribbon arcs cross at the center.
- Flute + Bell → ribbon arcs **through** an orb at the center.
- Bell + Sparks → orb at the center with sparks orbiting it.
- Etc. Six combinations, all visually distinct, zero branching code.

### Bond glow

One shared additive effect — a soft bloom flare at the table center — fades in when **both** players' instantaneous energy (smoothed `voice.active * voice.pulse`) is above a threshold simultaneously. Same effect regardless of which instruments are playing. This is the only piece that gates on both-players state.

---

## Selection + multiplayer sync

### UX

A new `InstrumentPicker` chip lives in the HUD near each player's video panel — three small icons (ribbon / bloom / sparks). Tapping cycles or directly picks. Active instrument has a glow ring.

- **Local player** can change anytime; change applies on next note attack (in-flight notes finish on the old voice to avoid mid-note glitch).
- **Remote player's** picker is read-only and reflects what the remote is currently playing.

### Persistence

- **Local:** `localStorage` key `jamtrain.instrument` keyed to whatever pattern the existing tweakable params use (per `tweakDefs.ts`).
- **Multiplayer:** new `instrument` column on the `player` table in SpacetimeDB.

### Auto-default for second player

When the local client subscribes and sees an existing online partner in the same room, and the local player has **never** picked an instrument before (no `localStorage` value), the client picks an instrument **different** from the partner's current `instrument` field. After that first auto-pick, the choice is remembered locally and never auto-changes again, even if the partner switches.

If both players join at exactly the same time and neither has a stored choice, both default to Cedar Flute and the system trusts the user to pick something else manually. (Edge case, no special handling.)

### SpacetimeDB schema change

In `spacetimedb/src/index.ts`, add to the `player` table:

```ts
instrument: t.string(), // 'flute' | 'bell' | 'sparks'
```

New reducer:

```ts
export const update_instrument = spacetimedb.reducer(
  { instrument: t.string() },
  (ctx, { instrument }) => {
    const ALLOWED = new Set(['flute', 'bell', 'sparks']);
    if (!ALLOWED.has(instrument)) throw new SenderError('invalid instrument');
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    ctx.db.player.identity.update({ ...row, instrument, updatedAt: ctx.timestamp });
  }
);
```

`request_seat` is updated to insert `instrument: 'flute'` as a placeholder; the client overwrites it via `update_instrument` once it has resolved the auto-default.

---

## Code structure

**New files:**

- `src/game/instruments.ts` — exports `INSTRUMENTS: Record<InstrumentId, InstrumentDef>` and types. Each `InstrumentDef` is data + factory functions (`createVoice`, `createPlayerVisual`, `createCenterPiece`).
- `src/game/visuals/Ribbon.ts` — per-player ribbon mesh module.
- `src/game/visuals/Bloom.ts` — per-player bloom sprite module.
- `src/game/visuals/Sparks.ts` — per-player TSL compute particle stream.
- `src/game/CenterStage.ts` — owns the up-to-two active center pieces + bond glow. Reactive to per-player `{ instrument, active, energy, pulse }` state.
- `src/hud/components/InstrumentPicker.ts` — three-icon chip component.

**Modified files:**

- `src/game/handSynth.ts` — voice creation becomes instrument-driven instead of profile-hardcoded. `setInstrument(player, id)` swaps the voice (graceful release on the old voice).
- `src/game/Game.ts` — drop `PlasmaOrb` wiring; instantiate `CenterStage` and per-player visual modules; wire selection state.
- `src/game/multiplayer.ts` (or wherever `request_seat` / `update_pose` are called) — add `update_instrument` calls and surface partner's `instrument` field.
- `src/hud/Hud.ts` — mount `InstrumentPicker` for local + remote slots.
- `spacetimedb/src/index.ts` — schema + reducer change above.

**Deleted files:**

- `src/game/plasmaOrb.ts`
- `PLASMA_DEFS` references in `tweakDefs.ts` if any persist outside `plasmaOrb.ts`.

**Generated bindings:** `src/module_bindings/` will regenerate from the schema change — touched by tooling, not by hand.

---

## Tweakable params (debug overlay)

Each visual module exposes a `*_DEFS` object using the existing `tweakDefs.ts` pattern, so all three are tunable live with the `/` overlay:

- `RIBBON_DEFS` — segment count, sine amplitude, scroll speed, color stops, opacity.
- `BLOOM_DEFS` — base size, pulse-size multiplier, halo softness, color stops, opacity.
- `SPARKS_DEFS` — particle count (player + center), spawn rate, lifetime, drag, color stops, point size.
- `CENTER_DEFS` — bond-glow threshold, bond-glow size + color, center-piece scale.

Pressing `r` in debug mode resets all of these to their in-code defaults, per existing convention.

---

## Performance budget

- **Ribbon:** 1 mesh × 24 segments × 2 players = 48 triangles. Trivial.
- **Bloom:** 1 sprite per player + 1 per center-piece + 1 bond-glow sprite = ~6 sprites max. Trivial.
- **Sparks:** Player streams 512 particles × 2 players + center ring 256 = ~1280 active particles. One TSL compute dispatch + one render pass. Well within budget for `three/webgpu`.
- **Center stage total:** ≤ 2 ribbon arcs + ≤ 2 orb bills + ≤ 1 particle ring + 1 bond glow at any moment.
- **Net:** Strict upper bound on draw calls is ~10 per frame for the visualizer — far below where the metaball ray-march was sitting.

---

## Migration

Single PR, no compatibility shim:

1. Schema change + `update_instrument` reducer; regenerate bindings.
2. Add the three visual modules + `instruments.ts` + `CenterStage.ts`.
3. Refactor `HandSynthEngine` to be instrument-driven.
4. Wire HUD picker + auto-default logic.
5. Delete `PlasmaOrb` and its imports.

`PlasmaOrb`'s persisted tweak params in `localStorage` (under its module key in `tweakDefs.ts`) will remain orphaned but harmless; they'll be naturally cleared on the next `r`-reset.

---

## Open risks

- **TSL compute reliability:** `three/webgpu` compute is recent. If the Sparks compute path fails to compile on the user's hardware, the Sparks instrument needs a CPU-driven fallback (BufferGeometry with per-frame attribute updates). Implementation will include a try/compile+fallback pattern, mirroring the one already in `plasmaOrb.ts` (`try { … colorNode = … } catch { … fallback material }`).
- **Audio context starvation:** Adding a third polyphonic synth (PluckSynth + shimmer) layered over the existing flute + rhodes + ambient bed + drums could cause audible CPU spikes on weaker machines. Voice creation is lazy — only the currently-selected instrument's voice is allocated per player, so worst case is two voices total, not six.
