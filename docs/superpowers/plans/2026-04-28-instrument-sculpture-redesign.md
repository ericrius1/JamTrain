# Instrument & Sound-Sculpture Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-instrument + decaying-`CenterStage` setup with two instruments (Drum + Starlace) feeding a particle-built central sound sculpture that grows over a configurable round and dissolves into a fresh one.

**Architecture:** A new `RoundDirector` runs a continuous `playing → dissolving` cycle (no rest gate). A new `EnergySculptor` owns a TSL/WebGPU compute particle pool; instrument visuals call its `emit()` API on hits/plucks. Three small archetype modules supply shape/flow/color per pairing. `Starlace` gets a full visual rewrite to a 3D constellation matching the user's reference image. `OrbDrums` mechanics are preserved (renamed to `Drum`); only an emitter is added. `HarmonicLoom`, `WindChime`, and `CenterStage` are deleted.

**Tech Stack:** TypeScript, three.js (`three/webgpu`), TSL compute (`Fn`/`compute`/`instancedArray`), tweakpane via the existing `registerTweaks` helper, SpacetimeDB sync (existing module bindings).

**Spec:** `docs/superpowers/specs/2026-04-28-instrument-sculpture-redesign-design.md`

---

## File map

### Created

- `src/game/RoundDirector.ts` — round state machine + tweakable durations.
- `src/game/EnergySculptor.ts` — TSL compute particle pool, archetype dispatcher, dissolve, timer ring.
- `src/game/sculptor/EnergyEmitter.ts` — shared emitter interface + helpers for `emitBurst` / `emitStreak`.
- `src/game/sculptor/archetypes/drumDrum.ts`
- `src/game/sculptor/archetypes/melodyMelody.ts`
- `src/game/sculptor/archetypes/drumMelody.ts`
- `src/game/sculptor/archetypeShared.ts` — common types (Archetype interface, ColorPair).
- `src/game/visuals/Drum.ts` — successor of `OrbDrums.ts` (mechanics preserved, emitter added).
- `src/game/visuals/Starlace.ts` — successor of `StarlaceHarp.ts` (full visual rewrite + emitter).

### Deleted

- `src/game/CenterStage.ts`
- `src/game/visuals/HarmonicLoom.ts`
- `src/game/visuals/WindChime.ts`
- `src/game/visuals/OrbDrums.ts` (replaced by `Drum.ts`)
- `src/game/visuals/StarlaceHarp.ts` (replaced by `Starlace.ts`)

### Modified

- `src/game/instruments.ts` — narrow `InstrumentId`, drop loom/chime/orbs metadata, add `drum` entry; legacy normalization helper.
- `src/game/handSynth.ts` — drop `loom`/`chime` branches everywhere; rename internal `'orbs'` references to `'drum'`.
- `src/game/Game.ts` — remove `CenterStage`, install `RoundDirector` + `EnergySculptor`; rewrite `installPlayerVisual` to handle only drum/starlace; wire emitters; pass round state to instruments where needed.
- `src/game/multiplayer.ts` — robot picks opposite instrument; legacy ID normalization on incoming partner instrument.
- `src/hud/Hud.ts` — drop loom/chime references.
- `src/hud/components/InstrumentPicker.ts` — uses `INSTRUMENT_IDS` (now 2 entries) — should "just work" once metadata shrinks; verify.

### Schema (out-of-tree)

The SpacetimeDB schema for `instrument` is a free-form string column (it accepts whatever the client sends). No schema migration needed — older clients still send legacy values, but our normalization at the read boundary maps them to `drum`. No write-side restriction in the schema; we just stop *sending* legacy values from this client.

---

## Conventions

- **TDD doesn't fit this work.** The system is real-time visual/audio; there is no test runner in this project. Verification is by running the dev server and checking visual/console behavior. Each task ends with a verification step that lists what to look at and what to expect.
- **Commits per task.** Each task ends with a `git add` + `git commit` step. Commit messages use the project's lowercase-prefix style (e.g. `cleanup: ...`, `sculptor: ...`, `drum: ...`).
- **Tweakable params** follow the project's `*_DEFS` + `registerTweaks` pattern (see `src/hud/tweakDefs.ts`). Always co-locate metadata with the value, register under a unique key, and rely on the `r` reset.
- **TSL compute** follows `src/game/particles.ts` exactly. Use `Fn(...)().compute(N)` to build the node, hold it on the class, and call `renderer.compute(node)` per frame. Use `uniform()`, `uniformArray()`, `instancedArray()` for state. Wrap compute calls in `try/catch` with a CPU fallback path *only if* it's cheap; otherwise let it throw and surface the error in console.
- **Don't import from `three`.** Always `three/webgpu` and `three/tsl`. The project's renderer is `WebGPURenderer`.
- **No emojis in code.** Project rule.
- **Don't introduce new abstractions** unless the file paths above call for them. Keep modules small and focused.

---

## Task 1 — Phase 1 cleanup: narrow to two instruments

**Files:**
- Modify: `src/game/instruments.ts`
- Delete: `src/game/CenterStage.ts`, `src/game/visuals/HarmonicLoom.ts`, `src/game/visuals/WindChime.ts`
- Rename: `src/game/visuals/OrbDrums.ts` → `src/game/visuals/Drum.ts`, `src/game/visuals/StarlaceHarp.ts` → `src/game/visuals/Starlace.ts`
- Modify: `src/game/Game.ts`, `src/game/handSynth.ts`, `src/game/multiplayer.ts`, `src/hud/Hud.ts`

**Goal:** End in a buildable state with only `drum` and `starlace` instruments. No EnergySculptor yet — center is empty space (the old `CenterStage` is just deleted; nothing replaces it in this task).

- [ ] **Step 1.1 — Narrow `InstrumentId` and rebuild `INSTRUMENTS`.**

Edit `src/game/instruments.ts`. Replace the existing `InstrumentId`, `INSTRUMENT_IDS`, `INSTRUMENTS`, and `isInstrumentId` with:

```ts
export type InstrumentId = 'drum' | 'starlace';

export const INSTRUMENT_IDS: readonly InstrumentId[] = ['drum', 'starlace'];

export const INSTRUMENTS: Record<InstrumentId, InstrumentMeta> = {
  drum: {
    id: 'drum',
    label: 'Drum',
    subtitle: 'rhythm · pulse · spark',
    color: '#ff9a3c',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="9" rx="8" ry="2.4"/><path d="M4 9v6c0 1.32 3.6 2.4 8 2.4s8-1.08 8-2.4V9"/><path d="M8.5 11.4l1.4 2.6M15.5 11.4l-1.4 2.6"/></svg>`,
  },
  starlace: {
    id: 'starlace',
    label: 'Starlace',
    subtitle: 'melody · constellation · glissando',
    color: '#ff8cf0',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7.5 10 4l5.6 2.7 3.9 4.8-2.2 5.6-6 2.9-5.8-2.4-2-5.4 1-4.7Z"/><path d="M4.5 7.5 11.3 20M10 4l1.3 16M15.6 6.7l-10.1 10.9M19.5 11.5 5.5 17.6M4.5 7.5l15 4M10 4l7.3 13.1"/><circle cx="4.5" cy="7.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.6" cy="6.7" r="1.15" fill="currentColor" stroke="none"/><circle cx="19.5" cy="11.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="17.3" cy="17.1" r="1.15" fill="currentColor" stroke="none"/><circle cx="11.3" cy="20" r="1.15" fill="currentColor" stroke="none"/><circle cx="5.5" cy="17.6" r="1.15" fill="currentColor" stroke="none"/></svg>`,
  },
};

export function isInstrumentId(value: string): value is InstrumentId {
  return value === 'drum' || value === 'starlace';
}

/**
 * Map any string (including legacy 'loom'/'chime'/'orbs') to a valid InstrumentId.
 * Used at every read boundary that might receive stale data (e.g. SpacetimeDB
 * partner instrument from an older client).
 */
export function normalizeInstrumentId(value: string | undefined | null): InstrumentId {
  if (value === 'starlace') return 'starlace';
  return 'drum';
}
```

Leave the rest of the file (`VoiceState`, `OrbGestureState`, `HandContactPoint`, `PlayerVisual`) unchanged.

- [ ] **Step 1.2 — Delete dead files.**

```bash
git rm src/game/CenterStage.ts \
       src/game/visuals/HarmonicLoom.ts \
       src/game/visuals/WindChime.ts
git mv src/game/visuals/OrbDrums.ts src/game/visuals/Drum.ts
git mv src/game/visuals/StarlaceHarp.ts src/game/visuals/Starlace.ts
```

- [ ] **Step 1.3 — Rename class+exports inside the moved files.**

In `src/game/visuals/Drum.ts`:

- Rename the exported class `OrbDrums` → `Drum`.
- Rename `ORB_DRUMS_DEFS` → `DRUM_DEFS`.
- Rename `OrbDrumsParams` → `DrumParams`, `OrbDrumsPalette` → `DrumPalette`, `OrbDrumsOptions` → `DrumOptions`.
- Update the tweakpane registration `paneKey = 'orbDrums'` → `'drum'`.
- Update `title` defaults if present (e.g. `'Ripple Orb'` → `'Drum'`).

In `src/game/visuals/Starlace.ts` (still the old harp visuals at this point — we rewrite later):

- Rename the exported class `StarlaceHarp` → `Starlace`.
- Rename `STARLACE_HARP_DEFS` → `STARLACE_DEFS` and other matching identifiers.
- Update the tweakpane registration key/title if it referenced "Harp".

Use Find-and-Replace; verify `tsc` reports no remaining references afterward.

- [ ] **Step 1.4 — Update `Game.ts` instrument wiring.**

In `src/game/Game.ts`:

- Replace the imports:

```ts
// REMOVE
import { HarmonicLoom } from './visuals/HarmonicLoom';
import { WindChime } from './visuals/WindChime';
import { OrbDrums } from './visuals/OrbDrums';
import { StarlaceHarp } from './visuals/StarlaceHarp';
import { CenterStage } from './CenterStage';
```

```ts
// ADD
import { Drum } from './visuals/Drum';
import { Starlace } from './visuals/Starlace';
```

- Remove the `centerStage` field, its instantiation in `start()`, all calls (`centerStage?.update(...)`, `centerStage?.setInputs(...)`, `centerStage?.dispose()`).
- Change `playerInstruments` default from `'loom'` to `'drum'`:

```ts
private playerInstruments: Record<PlayerSlot, InstrumentId> = { local: 'drum', remote: 'drum' };
```

- Rewrite `installPlayerVisual` so it only handles `drum` and `starlace`. Replace the entire `if (id === 'chime') ... else if ... else { HarmonicLoom }` block with:

```ts
private installPlayerVisual(player: PlayerSlot, id: InstrumentId): void {
  this.playerVisuals[player]?.dispose();
  this.playerInstruments[player] = id;

  if (id === 'starlace') {
    this.playerVisuals[player] = new Starlace(this.scene, this.paneDock, `starlace-${player}`, {
      palette: player,
      title: `Starlace (${player === 'local' ? 'Local' : 'Partner'})`,
      onPluck: pluck => {
        this.handSynth.triggerStarlacePluck(player, pluck.frequency, pluck.velocity, pluck.nodeIndex, pluck.x, pluck.y);
      },
    });
  } else {
    this.playerVisuals[player] = new Drum(this.scene, this.paneDock, `drum-${player}`, {
      palette: player,
      title: `Drum (${player === 'local' ? 'Local' : 'Partner'})`,
      camera: player === 'local' ? this.camera : undefined,
      canvas: player === 'local' ? this.canvas : undefined,
      onHit: hit => {
        this.handSynth.triggerOrbHit(player, hit.frequency, hit.velocity, hit.orbIndex);
      },
      onGesture: gesture => {
        this.handSynth.setOrbGesture(player, gesture);
      },
    });
  }
  this.handSynth.setInstrument(player, id);
}
```

(The `triggerOrbHit`/`setOrbGesture` calls in the synth keep their names for now — they're internal and we'll address renames within `handSynth.ts` only if it ships errors.)

- Remove any references to `installLoomVisuals` and rename to `installDrumVisuals` (or just inline the two `installPlayerVisual` calls).

- Update `setPlayerInstrument`:

```ts
setPlayerInstrument(player: PlayerSlot, id: string): void {
  if (!isInstrumentId(id)) return;
  if (this.playerInstruments[player] === id) return;
  this.installPlayerVisual(player, id);
}
```

(unchanged behavior — `isInstrumentId` is now narrow.)

- [ ] **Step 1.5 — Update `handSynth.ts` to drop loom/chime.**

In `src/game/handSynth.ts`:

- Find every `case 'loom':` and `case 'chime':` branch and remove them along with their dependent state. Search-driven cleanup is OK here — if `tsc` is clean after, the cleanup is complete.
- The `'orbs'` and `'orbDrums'` internal references stay as-is for now. The user-facing instrument id is `'drum'` but the synth's internal names don't need to match.
- Verify `setInstrument(player, id: InstrumentId)` only handles `'drum'` and `'starlace'`. If the switch statement still has `'loom'`/`'chime'` cases, delete them. Add a fallthrough so an unknown id (defensive) defaults to drum behavior — but since `InstrumentId` is narrowed at the type level, this is mostly belt-and-suspenders.
- Check `getVoiceState` — confirm the `'loom'`/`'chime'` paths are removed.

The diff here is mechanical; don't introduce new logic.

- [ ] **Step 1.6 — Update `multiplayer.ts`.**

In `src/game/multiplayer.ts`:

- Change `localInstrument` default `'loom'` → `'drum'`.
- Change `partnerInstrument` default `'loom'` → `'drum'`.
- In `onDisconnect`, where it resets partner instrument to `'loom'`, change to `'drum'`.
- Add `import { normalizeInstrumentId } from './instruments';` at the top.
- Where the multiplayer client *reads* the partner's instrument from incoming Spacetime updates, normalize the incoming value through `normalizeInstrumentId(...)` before storing/dispatching. Search for assignments to `this.partnerInstrument =` and wrap the right-hand side. Same for any acceptance of an incoming `localInstrument` from the server (so a stale persisted value doesn't poison startup).

Don't touch the robot opposite-instrument logic in this task — that comes in Task 2.

- [ ] **Step 1.7 — Update `Hud.ts` and `InstrumentPicker`.**

In `src/hud/Hud.ts`:

- Change `private localInstrument: InstrumentId = 'loom';` → `'drum'`.
- Change `private partnerInstrument: InstrumentId = 'loom';` → `'drum'`.
- The picker iterates `INSTRUMENT_IDS` so it'll naturally render only two buttons. Verify visually after the build.
- In `applyPlaques`, `INSTRUMENTS[this.localInstrument].label` will produce `'Drum'` or `'Starlace'`. No code change needed.

In `src/hud/components/InstrumentPicker.ts`: no code change required. Verify it still compiles.

- [ ] **Step 1.8 — Build & visual smoke.**

Run dev server (project uses Vite — `npm run dev`). In the browser:

- Page loads without console errors.
- Title plaque shows "Drum" as default instrument.
- The picker shows exactly two icons (drum + starlace).
- Clicking starlace switches to the (still-old-harp) visual.
- Center of cabin is empty space — no `CenterStage` artifacts.
- No regression: hand tracking, orb-hit audio, and starlace-pluck audio all still work as before.

If anything errors, fix before continuing.

- [ ] **Step 1.9 — Commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
cleanup: narrow to drum + starlace, delete CenterStage and dead instruments

InstrumentId narrows to 'drum' | 'starlace' with normalizeInstrumentId
mapping legacy ids ('loom', 'chime', 'orbs') to 'drum'. OrbDrums →
Drum, StarlaceHarp → Starlace (file moves; visuals unchanged for now).
HarmonicLoom, WindChime, CenterStage deleted. Game.ts and handSynth.ts
shrink their branch tables; multiplayer normalizes incoming partner
instrument values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — RoundDirector module + Game wiring + robot opposite-instrument

**Files:**
- Create: `src/game/RoundDirector.ts`
- Modify: `src/game/Game.ts`, `src/game/multiplayer.ts`

**Goal:** Continuous `playing → dissolving → playing` cycle running off the existing render loop. Robot partner picks opposite of local. Round state observable so subsystems can react.

- [ ] **Step 2.1 — Create `RoundDirector.ts`.**

Create `src/game/RoundDirector.ts` with the full content below:

```ts
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';

export const ROUND_DEFS = {
  roundDuration:    { default: 30,   min: 10,  max: 120, step: 1,   label: 'round seconds' },
  dissolveDuration: { default: 1.5,  min: 0.5, max: 4,   step: 0.1, label: 'dissolve seconds' },
} as const;

export type RoundParams = ParamsOf<typeof ROUND_DEFS>;

export type RoundState = 'idle' | 'playing' | 'dissolving';

export type RoundSnapshot = {
  state: RoundState;
  /** Seconds since the current state started. */
  inState: number;
  /** Seconds since the current `playing` round began (carries through `dissolving`). */
  roundElapsed: number;
  /** 0..1 progress through the configured `roundDuration` while playing; 1 once dissolving. */
  progress: number;
  /** Configured durations at the moment of snapshot. */
  roundDuration: number;
  dissolveDuration: number;
  /** Monotonically increasing round counter; bumps on each `playing` start. */
  roundIndex: number;
};

type StateListener = (snapshot: RoundSnapshot) => void;
type EdgeListener = () => void;

export class RoundDirector {
  readonly params: RoundParams;
  private state: RoundState = 'idle';
  private inState = 0;
  private roundElapsed = 0;
  private roundIndex = 0;
  private stateListeners = new Set<StateListener>();
  private playingStartListeners = new Set<EdgeListener>();
  private dissolvingStartListeners = new Set<EdgeListener>();
  private registered?: ReturnType<typeof registerTweaks<typeof ROUND_DEFS>>;

  constructor(paneDock?: HTMLElement) {
    this.params = { ...Object.fromEntries(Object.entries(ROUND_DEFS).map(([k, d]) => [k, d.default])) } as RoundParams;
    this.registered = registerTweaks(paneDock, 'round', ROUND_DEFS, {
      title: 'Round',
      params: this.params,
    });
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'playing';
    this.inState = 0;
    this.roundElapsed = 0;
    this.roundIndex += 1;
    this.broadcast();
    for (const l of this.playingStartListeners) l();
  }

  /** Drive the state machine. Call once per frame from Game.update. */
  tick(delta: number): RoundSnapshot {
    if (this.state === 'idle') return this.snapshot();
    this.inState += delta;

    if (this.state === 'playing') {
      this.roundElapsed += delta;
      if (this.roundElapsed >= this.params.roundDuration) {
        this.state = 'dissolving';
        this.inState = 0;
        for (const l of this.dissolvingStartListeners) l();
      }
    } else if (this.state === 'dissolving') {
      this.roundElapsed += delta;
      if (this.inState >= this.params.dissolveDuration) {
        this.state = 'playing';
        this.inState = 0;
        this.roundElapsed = 0;
        this.roundIndex += 1;
        for (const l of this.playingStartListeners) l();
      }
    }

    this.broadcast();
    return this.snapshot();
  }

  snapshot(): RoundSnapshot {
    const progress = this.state === 'playing'
      ? Math.min(1, this.roundElapsed / Math.max(0.001, this.params.roundDuration))
      : (this.state === 'dissolving' ? 1 : 0);
    return {
      state: this.state,
      inState: this.inState,
      roundElapsed: this.roundElapsed,
      progress,
      roundDuration: this.params.roundDuration,
      dissolveDuration: this.params.dissolveDuration,
      roundIndex: this.roundIndex,
    };
  }

  onState(listener: StateListener): void {
    this.stateListeners.add(listener);
    listener(this.snapshot());
  }

  onPlayingStart(listener: EdgeListener): void {
    this.playingStartListeners.add(listener);
  }

  onDissolvingStart(listener: EdgeListener): void {
    this.dissolvingStartListeners.add(listener);
  }

  dispose(): void {
    this.registered?.dispose();
    this.stateListeners.clear();
    this.playingStartListeners.clear();
    this.dissolvingStartListeners.clear();
  }

  private broadcast(): void {
    const s = this.snapshot();
    for (const l of this.stateListeners) l(s);
  }
}
```

- [ ] **Step 2.2 — Wire RoundDirector into `Game.ts`.**

Add the field, instantiate it in `start()`, drive it in `update()`, expose its snapshot:

```ts
// At top
import { RoundDirector } from './RoundDirector';

// As class field
private roundDirector!: RoundDirector;

// In start(), after this.particles.initialize(...)
this.roundDirector = new RoundDirector(this.paneDock);
this.roundDirector.start();

// In update(), after computing delta but before any subsystems that care
const round = this.roundDirector.tick(delta);

// In dispose()
this.roundDirector.dispose();
```

`round` will be passed to `EnergySculptor` later.

- [ ] **Step 2.3 — Robot picks opposite instrument; queued application at boundary.**

The robot partner is picked when `partnerPresent === false`. When solo, the partner instrument should be the *opposite* of the local instrument. Apply the swap at round boundaries — not mid-round — so the archetype doesn't shift while building.

In `src/game/multiplayer.ts`:

- Add a private field `private pendingPartnerInstrumentForRobot: string | null = null;`.
- Add a private method `applyRobotPartnerInstrument(local: string): void` that computes the opposite and stages it:

```ts
import { isInstrumentId, normalizeInstrumentId, type InstrumentId } from './instruments';

private oppositeInstrument(id: string): InstrumentId {
  const norm = normalizeInstrumentId(id);
  return norm === 'drum' ? 'starlace' : 'drum';
}

/**
 * Set the partner instrument used while we're solo (no real partner online).
 * Stages the value; consumers should accept it on a round boundary.
 */
private setRobotPartnerInstrument(id: InstrumentId): void {
  if (this.partnerIdentityHex !== null) return; // real partner present — ignore
  this.partnerInstrument = id;
  for (const listener of this.partnerInstrumentListeners) listener(id);
}
```

- In `acceptLocalInstrument`, after dispatching listeners, *if there is no real partner online*, call `this.setRobotPartnerInstrument(this.oppositeInstrument(instrumentId))`.
- In `onDisconnect` and `onPartnerIdentity(null)` paths, also re-derive partner instrument as opposite of local instead of resetting to `'drum'` blindly.

That covers the "robot is opposite" rule. The "swap at round boundary" gate lives in `Game.ts`:

In `Game.ts`:

```ts
// Class field
private pendingPartnerInstrument: InstrumentId | null = null;

// In constructor / setupMultiplayer wiring (where you currently subscribe to onPartnerInstrumentChange)
this.multiplayer.onPartnerInstrumentChange(id => {
  const norm = isInstrumentId(id) ? id : normalizeInstrumentId(id);
  // Solo / robot path: partner instrument changes are queued so the sculpture
  // archetype doesn't switch mid-round. Real-partner changes also queue —
  // they're rare and a 1-round delay is invisible to players.
  this.pendingPartnerInstrument = norm;
});

// In start(), after roundDirector exists:
this.roundDirector.onPlayingStart(() => {
  if (this.pendingPartnerInstrument && this.pendingPartnerInstrument !== this.playerInstruments.remote) {
    this.installPlayerVisual('remote', this.pendingPartnerInstrument);
  }
  this.pendingPartnerInstrument = null;
});
```

Apply the local player's own instrument changes immediately as before — only the partner is gated.

Add the imports as needed.

- [ ] **Step 2.4 — Smoke test.**

Run dev server. Open browser:

- Console should be clean.
- Add a temporary log inside `onPlayingStart` (`console.log('[round]', round.roundIndex)`) and watch it tick every `roundDuration` (default 30s) seconds.
- Open the tweakpane "Round" folder. Reduce `roundDuration` to 5s. Confirm round-start fires every 5s. Reset to 30 (or hit `r`).
- Switch local instrument from drum to starlace. Confirm the partner (robot) visual swaps to drum *only* on the next round boundary, not mid-round. (Watch for the visual change at the timer boundary.)

Remove the temporary log.

- [ ] **Step 2.5 — Commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
round: add RoundDirector with continuous playing/dissolving cycle

Tweakable roundDuration (default 30s) and dissolveDuration (default
1.5s). Robot partner picks the opposite instrument of the local
player; partner instrument swaps are queued and applied at round
boundary so an in-progress sculpture doesn't change archetype mid-build.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — EnergySculptor TSL compute scaffold

**Files:**
- Create: `src/game/sculptor/EnergyEmitter.ts`, `src/game/EnergySculptor.ts`
- Modify: `src/game/Game.ts`

**Goal:** Compute particle pool exists at the center of the scene. Particles can be emitted from arbitrary world positions with a target near center. Compute pass integrates, applies a simple central pull, ages them out. No archetypes, cross-currents, dissolve, or timer ring yet — those are layered on later.

- [ ] **Step 3.1 — `EnergyEmitter.ts` shared interface.**

Create `src/game/sculptor/EnergyEmitter.ts`:

```ts
import type * as THREE from 'three/webgpu';

export type ParticleKind = 'drum' | 'starlace';

/**
 * Discrete emit request handed from an instrument to the sculptor each frame.
 * Position is world-space; color is sRGB 0..1.
 */
export type EmitRequest = {
  kind: ParticleKind;
  /** World-space origin of the burst. */
  origin: THREE.Vector3;
  /** Initial direction bias (will be normalized; combined with attractor pull). */
  direction: THREE.Vector3;
  /** RGB 0..1. */
  color: { r: number; g: number; b: number };
  /** How many particles to spawn (clamped by free-list availability). */
  count: number;
  /** 0..1 — bigger size + brighter. */
  intensity: number;
  /** Per-particle initial speed in world units / second. */
  speed: number;
  /** Lifetime seconds before the particle fades. */
  lifetime: number;
};

/**
 * Implemented by EnergySculptor; consumed by instrument visuals.
 */
export interface EnergySink {
  emit(req: EmitRequest): void;
  /** Spatial target the emitters bias toward. */
  readonly center: THREE.Vector3;
}
```

- [ ] **Step 3.2 — `EnergySculptor.ts` skeleton.**

Create `src/game/EnergySculptor.ts` modeled after `LinkParticles` in `src/game/particles.ts`. The pool stores per-particle `position`, `velocity`, `color`, `seed` (a stable random for shading), and `life` (0 = dead, >0 = alive seconds remaining). Emit appends to a CPU staging queue; once per frame we drain up to the pool's free count, write into `instancedArray`s through TSL uniforms (using a "write index" + small batch uniforms), run the integrate compute, then render.

There are several valid ways to write into a TSL `instancedArray` from JS; the simplest that matches the project's existing patterns:

- Maintain a CPU mirror `Float32Array` for each attribute.
- Each frame, walk the free-list, mutate the CPU mirror for new particles and dead particles, then upload via `instancedArray.value = ...` (the TSL helper exposes the underlying buffer; use whatever the existing `particles.ts` pattern allows). If the project's TSL version doesn't support direct buffer upload, use the alternative: have the compute step itself read an "emit queue" `instancedArray` of pending requests (size 256) and consume entries.

Recommendation: **CPU-driven emit + GPU-driven integration.** Author the file as follows; adjust the upload path to whatever the installed `three/webgpu` version supports — check the `LinkParticles` patterns first, which already does `this.start.value = ...` and runs compute.

Suggested skeleton (fill in TSL details to match the surrounding code's style — mirror `LinkParticles` exactly for compute construction):

```ts
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, vec3, float } from 'three/tsl';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { EmitRequest, EnergySink, ParticleKind } from './sculptor/EnergyEmitter';

export const SCULPTOR_DEFS = {
  particlePoolSize:     { default: 12288, min: 4096, max: 24576, step: 256, label: 'particle pool' },
  attractorStrength:    { default: 1.5,   min: 0,    max: 4,    step: 0.05, label: 'attractor strength' },
  drumColor:            { type: 'color', default: '#ff9a3c', label: 'drum tint' },
  starlaceColor:        { type: 'color', default: '#ff8cf0', label: 'starlace tint' },
} as const;
export type SculptorParams = ParamsOf<typeof SCULPTOR_DEFS>;

type TslComputeNode = any;

export class EnergySculptor implements EnergySink {
  readonly center: THREE.Vector3;
  readonly params: SculptorParams;

  private renderer!: THREE.WebGPURenderer;
  private mesh!: THREE.InstancedMesh;
  // Mirror buffers — particle state. Dead = life <= 0.
  private positionMirror!: Float32Array; // length = pool * 3
  private velocityMirror!: Float32Array;
  private colorMirror!: Float32Array;
  private lifeMirror!: Float32Array;     // length = pool * 2 (current, max)
  private kindMirror!: Float32Array;     // length = pool, 0 = drum, 1 = starlace
  // TSL bindings — built from mirrors.
  private positions!: any;
  private velocities!: any;
  private colors!: any;
  private lifes!: any;
  private kinds!: any;
  private centerUniform = uniform(new THREE.Vector3());
  private deltaUniform = uniform(0);
  private attractorStrength = uniform(1.5);
  private computeIntegrate!: TslComputeNode;
  private freeList: number[] = [];
  private pendingEmits: EmitRequest[] = [];
  private registered?: ReturnType<typeof registerTweaks<typeof SCULPTOR_DEFS>>;
  private gpuActive = true;

  constructor(scene: THREE.Scene, center: THREE.Vector3, paneDock?: HTMLElement) {
    this.center = center.clone();
    this.params = { ...Object.fromEntries(Object.entries(SCULPTOR_DEFS).map(([k, d]) => [k, d.default])) } as SculptorParams;
    this.centerUniform.value.copy(this.center);
    this.attractorStrength.value = this.params.attractorStrength;

    this.allocatePool(this.params.particlePoolSize, scene);

    this.registered = registerTweaks(paneDock, 'energySculptor', SCULPTOR_DEFS, {
      title: 'Energy Sculptor',
      params: this.params,
      onChange: {
        attractorStrength: v => { this.attractorStrength.value = v; },
        // pool resize requires reallocation; defer to next dissolve so we don't
        // glitch live particles. For now, ignore live changes — tweak takes
        // effect on next reload.
      },
    });
  }

  initialize(renderer: THREE.WebGPURenderer): void {
    this.renderer = renderer;
    // Run a no-op compute once to warm the pipeline (matches LinkParticles pattern).
    if (this.gpuActive) {
      try { renderer.compute(this.computeIntegrate); }
      catch (e) { console.warn('EnergySculptor compute init failed', e); this.gpuActive = false; }
    }
  }

  emit(req: EmitRequest): void {
    this.pendingEmits.push(req);
  }

  /** Per-frame tick. Drains emits, runs compute, ages particles. */
  update(delta: number): void {
    this.drainEmits();
    this.deltaUniform.value = delta;
    if (this.gpuActive) {
      try { this.renderer.compute(this.computeIntegrate); }
      catch (e) { console.warn('EnergySculptor compute failed', e); this.gpuActive = false; }
    }
    // Recycle dead particles back into the free list. We sample `lifeMirror`
    // by relying on the integrate compute to write back life — handled by
    // having the compute also write into a CPU-readable buffer or by tracking
    // ages on the CPU. Simplest path: track ages on CPU too (small cost),
    // and use the GPU only for visible motion.
    this.recycleDead(delta);
  }

  dispose(): void {
    this.registered?.dispose();
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh.removeFromParent();
    }
  }

  // ----- internals -----

  private allocatePool(size: number, scene: THREE.Scene): void {
    this.positionMirror = new Float32Array(size * 3);
    this.velocityMirror = new Float32Array(size * 3);
    this.colorMirror = new Float32Array(size * 3);
    this.lifeMirror = new Float32Array(size * 2); // [current, max]
    this.kindMirror = new Float32Array(size);
    this.freeList = [];
    for (let i = 0; i < size; i += 1) this.freeList.push(i);

    this.positions = instancedArray(size, 'vec3');
    this.velocities = instancedArray(size, 'vec3');
    this.colors = instancedArray(size, 'vec3');
    this.lifes = instancedArray(size, 'vec2');
    this.kinds = instancedArray(size, 'float');

    this.computeIntegrate = Fn(() => {
      const pos = this.positions.element(instanceIndex);
      const vel = this.velocities.element(instanceIndex);
      const life = this.lifes.element(instanceIndex);
      const toCenter = this.centerUniform.sub(pos);
      const dist = toCenter.length().max(0.001);
      const dir = toCenter.div(dist);
      const pull = dir.mul(this.attractorStrength).mul(this.deltaUniform);
      const newVel = vel.add(pull).mul(0.985);
      const newPos = pos.add(newVel.mul(this.deltaUniform));
      pos.assign(newPos);
      vel.assign(newVel);
      life.x = life.x.sub(this.deltaUniform).max(0);
    })().compute(size) as TslComputeNode;

    const geometry = new THREE.SphereGeometry(0.012, 5, 4);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    material.positionNode = this.positions.element(instanceIndex);
    material.colorNode = this.colors.element(instanceIndex);
    // Hide dead particles by collapsing them to zero size via opacity.
    material.opacityNode = this.lifes.element(instanceIndex).x.div(this.lifes.element(instanceIndex).y.max(0.001)).clamp(0, 1).mul(0.85);

    this.mesh = new THREE.InstancedMesh(geometry, material, size);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 32;
    scene.add(this.mesh);
  }

  private drainEmits(): void {
    if (this.pendingEmits.length === 0) return;
    const pending = this.pendingEmits;
    this.pendingEmits = [];
    for (const req of pending) {
      const allowed = Math.min(req.count, this.freeList.length);
      for (let i = 0; i < allowed; i += 1) {
        const idx = this.freeList.pop()!;
        // Compute initial velocity = direction * speed.
        const vx = req.direction.x * req.speed;
        const vy = req.direction.y * req.speed;
        const vz = req.direction.z * req.speed;
        const px = req.origin.x;
        const py = req.origin.y;
        const pz = req.origin.z;
        const o3 = idx * 3;
        const o2 = idx * 2;
        this.positionMirror[o3] = px;
        this.positionMirror[o3 + 1] = py;
        this.positionMirror[o3 + 2] = pz;
        this.velocityMirror[o3] = vx;
        this.velocityMirror[o3 + 1] = vy;
        this.velocityMirror[o3 + 2] = vz;
        this.colorMirror[o3] = req.color.r;
        this.colorMirror[o3 + 1] = req.color.g;
        this.colorMirror[o3 + 2] = req.color.b;
        this.lifeMirror[o2] = req.lifetime;
        this.lifeMirror[o2 + 1] = req.lifetime;
        this.kindMirror[idx] = req.kind === 'drum' ? 0 : 1;
        // Upload only this slot. The TSL instancedArray exposes a CPU-side
        // .array we can write to (mirrors three.js InstancedBufferAttribute).
        // If the version installed doesn't expose this, we'll upload the full
        // mirrors once per frame in update() instead.
      }
    }
    this.uploadDirtyMirrors();
  }

  private uploadDirtyMirrors(): void {
    // Push mirror state into the TSL storage buffers. Naïve "push all" is
    // fine — these are <1MB at default pool size.
    if (typeof this.positions.value !== 'undefined') {
      this.positions.value = this.positionMirror;
      this.velocities.value = this.velocityMirror;
      this.colors.value = this.colorMirror;
      this.lifes.value = this.lifeMirror;
      this.kinds.value = this.kindMirror;
    }
    // If the TSL API surface differs, replace this with whatever
    // mechanism `LinkParticles` uses to push uniforms. The integrate compute
    // pass will read whatever the underlying storage is bound to.
  }

  private recycleDead(delta: number): void {
    // Mirror the GPU's life decrement on the CPU so the free-list stays
    // accurate without a GPU readback. Both paths use the same `delta`.
    const size = this.lifeMirror.length / 2;
    for (let i = 0; i < size; i += 1) {
      const o2 = i * 2;
      if (this.lifeMirror[o2] > 0) {
        this.lifeMirror[o2] -= delta;
        if (this.lifeMirror[o2] <= 0) {
          this.lifeMirror[o2] = 0;
          this.freeList.push(i);
        }
      }
    }
  }
}
```

**Note on TSL API specifics:** the exact API for writing into an `instancedArray` from JS varies by `three/webgpu` build. Before claiming this task done, open `src/game/particles.ts` and confirm whichever pattern it uses (`uniformArray.value = ...` vs `instancedArray` mirrors a buffer attribute); use the same pattern in `EnergySculptor`. If a direct write isn't supported, switch to a "shared StorageBuffer" pattern: build the attribute from a `THREE.InstancedBufferAttribute` and pass it in via `instancedArray(attribute)`. The exact path matters less than ending with: dirty mirrors land on the GPU each frame.

- [ ] **Step 3.3 — Wire EnergySculptor into Game.ts.**

```ts
// At top
import { EnergySculptor } from './EnergySculptor';

// As field
private sculptor!: EnergySculptor;

// In start(), after roundDirector creation:
this.sculptor = new EnergySculptor(this.scene, this.sculptureTarget, this.paneDock);
this.sculptor.initialize(this.renderer);

// In update(), after roundDirector.tick(...)
this.sculptor.update(delta);

// In dispose()
this.sculptor.dispose();
```

Pass `this.sculptor` to `installPlayerVisual` so the instruments can call `.emit()`. Update the signature:

```ts
private installPlayerVisual(player: PlayerSlot, id: InstrumentId): void {
  // ...existing code...
  if (id === 'starlace') {
    this.playerVisuals[player] = new Starlace(this.scene, this.paneDock, `starlace-${player}`, {
      // ...
      sculptor: this.sculptor,
    });
  } else {
    this.playerVisuals[player] = new Drum(this.scene, this.paneDock, `drum-${player}`, {
      // ...
      sculptor: this.sculptor,
    });
  }
}
```

Add the `sculptor?: EnergySink` field to `DrumOptions` and `StarlaceOptions`. Don't *consume* it yet — that's Task 4. Just thread it through.

- [ ] **Step 3.4 — Smoke test.**

Run dev server. The center should look the same as after Task 1 (empty), but no console errors. The `Energy Sculptor` folder should appear in tweakpane and contain `particle pool`, `attractor strength`, two color swatches.

If the build errors on TSL specifics, troubleshoot against `src/game/particles.ts` for the working pattern. Don't move on until clean.

- [ ] **Step 3.5 — Commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
sculptor: add EnergySculptor TSL compute scaffold

12k-particle pool with central pull, age-based recycling, color
storage, and tweakable attractor strength. Threads the EnergySink
contract through Drum and Starlace constructor options without
consumers yet — emitters land in Task 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Drum emitter + Starlace constellation rewrite + emitter

**Files:**
- Modify: `src/game/visuals/Drum.ts`
- Rewrite: `src/game/visuals/Starlace.ts`
- Add: `src/game/visuals/starlace/StarlaceConstellation.ts` (helper for the visual rewrite)

**Goal:** Drum emits warm spark clusters on hit. Starlace shows the constellation visual matching the user's reference image; plucking emits color-tinted streaks. Keyboard input bound to middle row for both instruments.

- [ ] **Step 4.1 — Drum emitter.**

In `src/game/visuals/Drum.ts`:

- Add `sculptor?: EnergySink` to `DrumOptions` and store it on the class.
- Find the function that runs when an orb is hit (where `onHit` is currently invoked). After the `onHit` callback, also call `this.emitSparks(hit)` if `this.sculptor` is set.

```ts
import type { EnergySink } from '../sculptor/EnergyEmitter';

// inside the class
private sculptor?: EnergySink;
private sparkColor = { r: 1.0, g: 0.605, b: 0.235 }; // matches DRUM_DEFS.rimColor lightened
private static SPARK_DIRECTION_TMP = new THREE.Vector3();

private emitSparks(hit: { worldPosition: THREE.Vector3; velocity: number }): void {
  if (!this.sculptor) return;
  const sink = this.sculptor;
  const speed = 0.9 + hit.velocity * 1.4;
  const count = 40 + Math.floor(hit.velocity * 40);
  // Direction: mostly toward sculptor center with a small randomized cone.
  const dir = Drum.SPARK_DIRECTION_TMP.copy(sink.center).sub(hit.worldPosition);
  if (dir.lengthSq() < 1e-4) dir.set(0, 0.1, 0);
  dir.normalize();
  // Wiggle direction per particle by emitting in small batches with perturbed dirs.
  // Simplest: emit one batch with the central direction; the integrator's
  // attractor pull adds variation as particles fly. If sparks look too uniform,
  // split into 4 batches of count/4 with perturbed directions later.
  sink.emit({
    kind: 'drum',
    origin: hit.worldPosition.clone(),
    direction: dir.clone(),
    color: this.sparkColor,
    count,
    intensity: 0.6 + hit.velocity * 0.4,
    speed,
    lifetime: 1.2 + hit.velocity * 0.6,
  });
}
```

Look in the existing Drum (formerly OrbDrums) source for where the `OrbHit` is constructed and where `onHit?.(hit)` is invoked. Augment that path: capture the world-space contact position into `hit.worldPosition` and pass it along. If the existing `OrbHit` type doesn't include world position, add it:

```ts
export type OrbHit = {
  orbIndex: number;
  frequency: number;
  velocity: number;
  worldPosition: THREE.Vector3; // NEW
};
```

Update the call site that emits `onHit` to populate `worldPosition` from whichever vector represents the strike point in world space. Then either pass the hit to `this.emitSparks(hit)` directly inside the same code path or do it from `Game.ts` via the existing `onHit` callback (cleaner: do it here, in the visual; `Game.ts` just supplies the sink).

- [ ] **Step 4.2 — Drum keyboard binding.**

In `Drum.ts`, register a keydown listener on `window` (only when this Drum is the local player's — `palette === 'local'`). Map middle row to the existing `ORB_HZ` indices in pitch order:

```ts
private static KEY_MAP: ReadonlyMap<string, number> = new Map([
  ['a', 0], ['s', 1], ['d', 2], ['f', 3],
  ['g', 4], ['h', 5], ['j', 6], ['k', 7], ['l', 8],
]);

private onKeyDown = (e: KeyboardEvent): void => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (this.palette !== 'local') return;
  const idx = Drum.KEY_MAP.get(e.key.toLowerCase());
  if (idx === undefined) return;
  // Trigger a synthetic hit: pick a strike position on the orb's surface
  // (use the camera-facing forward + small offset per index for spread).
  const hit = this.makeKeyboardHit(idx);
  this.invokeHit(hit); // calls this.options.onHit + this.emitSparks
};
```

Add `palette: DrumPalette` capture in the constructor; add `window.addEventListener('keydown', this.onKeyDown)` in the constructor (palette === 'local' only) and `removeEventListener` in `dispose()`.

`makeKeyboardHit(idx)` constructs an `OrbHit` with the ORB_HZ frequency at index, a fixed velocity (e.g. 0.65), and a `worldPosition` placed on the orb's surface — orient the strike point so each of the 8 keys corresponds to a slightly different point on the orb (e.g. spread along the orb's rim). The exact strike-point placement isn't critical; it just needs to look like a hit and emit toward center.

`invokeHit(hit)` is a small helper that consolidates the pre-existing "trigger audio + visual ripple + onHit callback + emit sparks" sequence so keyboard hits and physical hits share the same code path.

Mouse-click already works through the existing canvas hit logic. Don't add new mouse handling.

- [ ] **Step 4.3 — Starlace visual rewrite — constellation.**

This is the largest single piece of visual work in the plan. Open the user reference image at `/Users/eric/Library/Application Support/CleanShot/media/media_YhEDlUUD6e/CleanShot 2026-04-28 at 18.28.43@2x.png` to keep it in mind.

Replace the **entire body** of `src/game/visuals/Starlace.ts`. Treat it as a fresh file. The shape:

```ts
import * as THREE from 'three/webgpu';
import { Fn, color, float, hash, instancedArray, instanceIndex, mix, time, uniform, vec3 } from 'three/tsl';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { HandContactPoint, PlayerVisual, VoiceState } from '../instruments';
import type { EnergySink } from '../sculptor/EnergyEmitter';
import { clamp } from '../math';

export const STARLACE_DEFS = {
  nodeCount:        { default: 36,    min: 18,   max: 60,   step: 1,     label: 'node count' },
  clusterRadius:    { default: 0.34,  min: 0.12, max: 0.7,  step: 0.005, label: 'cluster radius' },
  clusterFlatness:  { default: 0.55,  min: 0.2,  max: 1,    step: 0.01,  label: 'flatness' },
  nodeSize:         { default: 0.022, min: 0.008,max: 0.06, step: 0.001, label: 'node size' },
  haloSize:         { default: 0.06,  min: 0.02, max: 0.18, step: 0.001, label: 'halo size' },
  linkOpacity:      { default: 0.32,  min: 0,    max: 1,    step: 0.01,  label: 'link opacity' },
  linkActive:       { default: 0.85,  min: 0,    max: 1,    step: 0.01,  label: 'link active' },
  linkSpan:         { default: 0.18,  min: 0.06, max: 0.4,  step: 0.005, label: 'link reach' },
  moteCount:        { default: 80,    min: 0,    max: 200,  step: 5,     label: 'ambient motes' },
  moteSize:         { default: 0.008, min: 0.002,max: 0.03, step: 0.001, label: 'mote size' },
  pluckRadius:      { default: 0.06,  min: 0.02, max: 0.18, step: 0.001, label: 'pluck radius' },
  paletteA:         { type: 'color', default: '#ff5ad6', label: 'magenta' },
  paletteB:         { type: 'color', default: '#56e1ff', label: 'cyan' },
  paletteC:         { type: 'color', default: '#ffc55a', label: 'amber' },
} as const;
export type StarlaceParams = ParamsOf<typeof STARLACE_DEFS>;

export type StarlacePluck = {
  nodeIndex: number;
  frequency: number;
  velocity: number;
  /** Local 0..1 within the cluster (used by handSynth for filter routing). */
  x: number;
  y: number;
};

type StarlacePalette = 'local' | 'remote';

export type StarlaceOptions = {
  palette?: StarlacePalette;
  title?: string;
  sculptor?: EnergySink;
  onPluck?: (event: StarlacePluck) => void;
};

export class Starlace implements PlayerVisual {
  // Public state
  readonly mesh: THREE.Group;
  readonly params: StarlaceParams;

  // Authored constellation: positions, pitch index, palette index, neighbor list.
  // Generated at construction with a deterministic seed per palette.
  // ... fields, see implementation guidance below ...
}
```

**Layout generation.** At construction:

- Pick `nodeCount` 3D positions inside a flattened ellipsoid (`radius` × `radius` × `radius * clusterFlatness`) — use a halton/sobol-ish sequence or random rejection-sampling with minimum-distance to avoid clumping.
- Bias point count toward a radial gradient (denser near center, sparser at edges) so the cluster reads as a star-cluster shape.
- Assign each node a pitch from a pentatonic scale spread (e.g. 32 notes from D3 to D6) — keep the existing scale logic from the old harp if it's already pleasant.
- Assign each node a palette index 0/1/2 (magenta / cyan / amber) — interleave so neighbors aren't always the same color.
- Build a neighbor list per node: for each node, find every other node within `linkSpan` distance. Cap each node at ~6 neighbors to keep the graph readable.

**Rendering.**

- **Nodes:** an `InstancedMesh` of small spheres positioned via TSL `positionNode` reading from an `instancedArray<vec3>` of node positions (keeps positions on the GPU, lets per-node activity lighting be cheap).
- **Halos:** a second `InstancedMesh` (or a sprite layer) at the same positions, larger size, additive blend, opacity driven by per-node activity (a TSL uniform `activeNodes: instancedArray('float', nodeCount)` decremented over time).
- **Links:** a `LineSegments` with two endpoints per neighbor pair. Vertex colors blend the two endpoint palette colors. Brightness driven by `(activity[a] + activity[b]) * 0.5`. Use additive blending.
- **Motes:** a third `InstancedMesh` of `moteCount` tiny spheres at random positions inside `clusterRadius * 1.4`, animated with a slow drift via a TSL compute pass (mirror `LinkParticles` for the pattern).

**Interaction.**

- Hand contacts: same approach as the old harp — for each finger contact, find the nearest node within `pluckRadius`, fire a pluck if not already plucked this frame.
- Mouse: raycast from the camera through the cursor, intersect a virtual sphere at the cluster center, find nearest node.
- Keyboard: middle row mapped to the first 8 nodes in pitch order.

**Pluck behavior.**

```ts
private invokePluck(nodeIdx: number, velocity: number): void {
  const node = this.nodes[nodeIdx];
  this.activityMirror[nodeIdx] = 1.0;
  // Propagate a wave to neighbors (visible)
  for (const n of node.neighbors) {
    this.activityMirror[n] = Math.max(this.activityMirror[n], 0.55);
  }
  this.options.onPluck?.({
    nodeIndex: nodeIdx,
    frequency: node.frequency,
    velocity,
    x: node.localX,
    y: node.localY,
  });
  this.emitStreak(node, velocity);
}

private emitStreak(node: StarNode, velocity: number): void {
  if (!this.sculptor) return;
  const sink = this.sculptor;
  const dir = sink.center.clone().sub(node.worldPosition);
  if (dir.lengthSq() < 1e-4) dir.set(0, 0.1, 0);
  dir.normalize();
  sink.emit({
    kind: 'starlace',
    origin: node.worldPosition.clone(),
    direction: dir,
    color: node.color01, // {r,g,b} 0..1 from palette
    count: 22,
    intensity: 0.5 + velocity * 0.5,
    speed: 1.1 + velocity * 0.6,
    lifetime: 1.6 + velocity * 0.4,
  });
}
```

**Per-frame update:**

- Decay every `activityMirror[i]` by `delta * 1.4` (clamped at 0).
- Push `activityMirror` into the GPU `activeNodes` storage.
- Update node halo opacities and link brightnesses via TSL nodes that read `activeNodes`.
- Drift motes (TSL compute step or simple CPU update of a position attribute — pick whichever is closer to existing patterns; motes don't need to scale with node count so CPU-update is fine).

**Bloom.** The project's renderer doesn't currently apply post-processing bloom (verify by searching `bloom` in the repo). If absent, fake bloom by stacking three layers per node — small bright sphere, medium soft sprite (alpha glow texture), large soft sprite. The existing `CenterStage` had a `makeRadialGlowTexture` that's now deleted; copy that helper over into `src/game/sculptor/glowTexture.ts` and use it for the halo sprites.

- [ ] **Step 4.4 — Restore `makeRadialGlowTexture` helper.**

Create `src/game/sculptor/glowTexture.ts` containing the `makeRadialGlowTexture(size = 256)` function copied verbatim from the deleted `CenterStage.ts` (it was at the bottom of that file). Export it. Both `Starlace` (for halos) and the eventual sculptor center glow can use it.

- [ ] **Step 4.5 — Smoke test the constellation.**

Run dev server. With Starlace selected:

- The cluster should look like a 3D mesh of glowing nodes connected by faint lines, visibly multi-color, with ambient motes drifting.
- Hovering a hand or clicking near a node should light it and its neighbors briefly.
- Pressing `A`-`L` (middle row) should pluck the first 8 nodes audibly + visually.
- Each pluck should emit a small color streak of particles toward the center, where the integrator will pull them in.
- Drum side: hitting an orb (hand or mouse) should emit a warm spark cluster traveling toward center.
- Particles arriving at center should slowly accumulate; the central pull will hold them, but with no archetype yet they'll just blob.

If the visual look is far from the reference, iterate on the tweakpane params (`linkOpacity`, `haloSize`, palette) to get closer. Authored values can change later.

- [ ] **Step 4.6 — Commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
visuals: drum sparks + starlace constellation rewrite

Drum emits a warm spark cluster on each hit (hand, mouse, or middle-row
key A-L); particles fly toward sculptor center. Starlace replaced with
3D constellation matching the reference: ~36 nodes, multi-color palette
(magenta/cyan/amber), neighbor links that brighten on activity, ambient
floating motes, faked-bloom halos. Plucking emits a color-tinted streak.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Three archetype attractors

**Files:**
- Create: `src/game/sculptor/archetypeShared.ts`
- Create: `src/game/sculptor/archetypes/drumDrum.ts`, `melodyMelody.ts`, `drumMelody.ts`
- Modify: `src/game/EnergySculptor.ts`, `src/game/Game.ts`

**Goal:** Particles aren't just pulled to a point — they're pulled toward archetype-specific shapes, so the duo's pairing visibly determines the sculpture's silhouette.

- [ ] **Step 5.1 — Shared archetype types.**

Create `src/game/sculptor/archetypeShared.ts`:

```ts
import * as THREE from 'three/webgpu';
import type { ParticleKind } from './EnergyEmitter';

export type ArchetypeId = 'drumDrum' | 'melodyMelody' | 'drumMelody';

/**
 * Per-archetype shape sampler.
 * Given a normalized index 0..1 (stable per particle), a round progress 0..1,
 * and a per-particle seed, returns a target world-space offset relative to the
 * sculptor center. Particles attract toward this point instead of the center.
 */
export type ShapeSampler = (
  particleNorm: number,
  roundProgress: number,
  seed: number,
  kind: ParticleKind,
  out: THREE.Vector3,
) => THREE.Vector3;

/**
 * Per-archetype directional flow bias applied to particle velocity.
 * Returns a vec3 in world units.
 */
export type FlowSampler = (
  position: THREE.Vector3,
  roundProgress: number,
  out: THREE.Vector3,
) => THREE.Vector3;

export type Archetype = {
  id: ArchetypeId;
  shape: ShapeSampler;
  flow: FlowSampler;
  /** Hint for the dispatcher: which pair triggers this archetype. */
  pair: { a: ParticleKind; b: ParticleKind };
};

export function pickArchetype(localKind: ParticleKind, partnerKind: ParticleKind): ArchetypeId {
  if (localKind === 'drum' && partnerKind === 'drum') return 'drumDrum';
  if (localKind === 'starlace' && partnerKind === 'starlace') return 'melodyMelody';
  return 'drumMelody';
}
```

- [ ] **Step 5.2 — drumDrum archetype (Stalagmite tower).**

Create `src/game/sculptor/archetypes/drumDrum.ts`:

```ts
import * as THREE from 'three/webgpu';
import type { Archetype } from '../archetypeShared';

const TAU = Math.PI * 2;

export const drumDrum: Archetype = {
  id: 'drumDrum',
  pair: { a: 'drum', b: 'drum' },
  shape: (n, t, seed, _kind, out) => {
    // Vertical stalagmite: height grows with t; particles distribute over the
    // tower's exterior. n in 0..1 maps to height with some clustering near
    // beat-bands (using seed for jitter).
    const height = 1.4 * t;
    const y = n * height;
    const banding = 0.06 * Math.sin(n * 18 + seed * 7.3);
    const radius = (0.16 + banding) * (1 - n * 0.6);
    const angle = (n + seed * 0.13) * TAU * 4;
    out.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    return out;
  },
  flow: (p, _t, out) => {
    out.set(0, 0.6, 0); // upward bias
    return out;
  },
};
```

- [ ] **Step 5.3 — melodyMelody archetype (Woven braid).**

Create `src/game/sculptor/archetypes/melodyMelody.ts`:

```ts
import * as THREE from 'three/webgpu';
import type { Archetype } from '../archetypeShared';

const TAU = Math.PI * 2;

export const melodyMelody: Archetype = {
  id: 'melodyMelody',
  pair: { a: 'starlace', b: 'starlace' },
  shape: (n, t, seed, kind, out) => {
    // Two intertwining helices, each kind biased to one strand.
    // Span a horizontal axis (-w..+w) and braid in y/z.
    const w = 0.6 * (0.4 + 0.6 * t);
    const x = (n - 0.5) * 2 * w;
    const phase = n * TAU * 3 + (kind === 'starlace' ? 0 : Math.PI);
    const r = 0.18 + 0.04 * Math.sin(seed * 11.4);
    out.set(x, Math.sin(phase) * r, Math.cos(phase) * r);
    return out;
  },
  flow: (p, _t, out) => {
    out.set(-p.z * 0.4, 0, p.x * 0.4); // gentle horizontal swirl
    return out;
  },
};
```

- [ ] **Step 5.4 — drumMelody archetype (Halo'd column).**

Create `src/game/sculptor/archetypes/drumMelody.ts`:

```ts
import * as THREE from 'three/webgpu';
import type { Archetype } from '../archetypeShared';

const TAU = Math.PI * 2;

export const drumMelody: Archetype = {
  id: 'drumMelody',
  pair: { a: 'drum', b: 'starlace' },
  shape: (n, t, seed, kind, out) => {
    if (kind === 'drum') {
      // Central rising column.
      const height = 1.5 * t;
      const y = n * height;
      const r = 0.05 + 0.04 * Math.sin(n * 24 + seed * 5);
      const angle = (n + seed * 0.21) * TAU * 6;
      out.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
    } else {
      // Orbiting halo of starlace streaks around the column.
      const angle = (n + seed * 0.17) * TAU * 3;
      const haloRadius = 0.34 + 0.05 * Math.sin(seed * 9);
      const elev = (n - 0.5) * 1.2 * t;
      out.set(Math.cos(angle) * haloRadius, 0.7 * t + elev, Math.sin(angle) * haloRadius);
    }
    return out;
  },
  flow: (p, _t, out) => {
    // Drum particles get upward bias; starlace particles get tangential swirl.
    // Approximate via position: closer to y-axis = column = upward; further = halo = swirl.
    const r2 = p.x * p.x + p.z * p.z;
    if (r2 < 0.04) {
      out.set(0, 0.5, 0);
    } else {
      out.set(-p.z * 0.7, 0.1, p.x * 0.7);
    }
    return out;
  },
};
```

- [ ] **Step 5.5 — Wire archetypes into EnergySculptor.**

In `EnergySculptor.ts`:

- Import the three archetype modules + `pickArchetype` + `Archetype`.
- Add a field `private currentArchetype: Archetype = drumMelody;` (default).
- Add a public method `setArchetype(id: ArchetypeId): void` that switches the field.
- Each emitted particle now needs a stable `targetOffset` — the position from `archetype.shape(...)` cached at emit time. The simplest path: keep the CPU evaluation per-emit since each emit is small (≤80 particles per call). Add a `targetMirror: Float32Array` (size pool * 3) and write into it during `drainEmits`:

```ts
const norm = Math.random(); // stable per particle once written
const seed = Math.random();
this.currentArchetype.shape(norm, this.roundProgress, seed, req.kind, this.tmpVec);
// Convert from local archetype space (origin = 0,0,0 at sculpture center) to world:
this.tmpVec.add(this.center);
this.targetMirror[o3] = this.tmpVec.x;
this.targetMirror[o3 + 1] = this.tmpVec.y;
this.targetMirror[o3 + 2] = this.tmpVec.z;
```

(Track `this.roundProgress` via a setter `setRoundProgress(p: number): void` called from `Game.update` each frame from the round director snapshot.)

- Replace the integrate compute pass: instead of pulling toward a single `centerUniform`, pull toward each particle's `targetOffset` (an `instancedArray('vec3')` mirror named `targets`). The structure:

```ts
this.computeIntegrate = Fn(() => {
  const pos = this.positions.element(instanceIndex);
  const vel = this.velocities.element(instanceIndex);
  const tgt = this.targets.element(instanceIndex);
  const life = this.lifes.element(instanceIndex);
  const toTarget = tgt.sub(pos);
  const dist = toTarget.length().max(0.001);
  const dir = toTarget.div(dist);
  const pull = dir.mul(this.attractorStrength).mul(this.deltaUniform);
  const newVel = vel.add(pull).mul(0.985);
  const newPos = pos.add(newVel.mul(this.deltaUniform));
  pos.assign(newPos);
  vel.assign(newVel);
  life.x = life.x.sub(this.deltaUniform).max(0);
})().compute(size) as TslComputeNode;
```

- (Flow bias is intentionally deferred to a later pass — adding a per-particle flow read in compute would require uploading a sampled vector field every frame. For now, the shape attractor is enough; flow can be applied as a CPU bias on initial emit velocity by calling `archetype.flow(origin, t)` and adding it to `req.direction`.)

- [ ] **Step 5.6 — Drive archetype selection from Game.ts.**

```ts
// In Game.ts start() after sculptor + roundDirector exist:
const updateArchetype = () => {
  const local = this.playerInstruments.local === 'starlace' ? 'starlace' : 'drum';
  const remote = this.playerInstruments.remote === 'starlace' ? 'starlace' : 'drum';
  this.sculptor.setArchetype(pickArchetype(local, remote));
};
this.roundDirector.onPlayingStart(() => updateArchetype());
updateArchetype();

// In update(), after roundDirector.tick():
this.sculptor.setRoundProgress(round.progress);
```

- [ ] **Step 5.7 — Smoke test.**

Run dev server. Without changing instruments (default drum + drum since solo robot will pick opposite — wait — robot picks opposite, so default solo is drum + starlace = drumMelody):

- The solo default sculpture should be the halo'd column (drum + melody) — a vertical column of warm drum sparks with a swirling halo of multicolor starlace streaks.
- Switch local to starlace; partner robot becomes drum at the next boundary; archetype stays `drumMelody`.
- Force both sides drum (temporarily edit `Game.ts` to pin partner to `'drum'`, or open two browser tabs and have both pick drum) — sculpture should switch to `drumDrum` (a vertical tower) at the boundary.
- Same for both starlace → braid.

The shapes will look rough; the goal here is *legible silhouette*. Tune later.

- [ ] **Step 5.8 — Commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
sculptor: three pairing archetypes drive sculpture silhouette

drumDrum tower, melodyMelody braid, drumMelody halo'd column. Each
particle locks a target offset at emit time from the active archetype's
shape sampler; integrator pulls toward that target instead of a single
center point. Archetype is selected on each round-playing-start edge
based on current player instruments.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Cross-currents + duet bonus + synchrony ring

**Files:**
- Modify: `src/game/EnergySculptor.ts`, `src/game/Game.ts`

**Goal:** Players feel each other in flight (cross-currents) and get visible reward for syncing (duet bonus + ring pulse).

- [ ] **Step 6.1 — Cross-current force.**

Cross-currents perturb each particle by the *other* kind's local density. Implementation:

- Maintain two coarse 3D density grids, e.g. 8×8×8, centered on the sculptor center, spanning ~1.5m on each side. One grid for drum, one for starlace.
- Each frame, after `drainEmits` and before compute:
  - CPU side: walk the position mirror, increment the appropriate grid cell. Decay the grid by ~0.85 per frame so it's a recent presence map.
  - Upload both grids as `uniformArray('float', 512)` (8³).
- Add to integrate compute: sample the *other* kind's grid at the particle's position and add a deflection vector toward higher density (so the streams "bend" around each other). Strength scaled by `crossCurrentStrength` uniform.

Add the tweak param:

```ts
crossCurrentStrength: { default: 0.35, min: 0, max: 1, step: 0.01, label: 'cross-current' },
```

This is the one task in the plan that's likely to need iteration to feel right. Authoring: try `0.35` for default; if drum sparks visibly bend through the starlace halo on solo, ship it.

- [ ] **Step 6.2 — Duet synchrony detection.**

In `Game.ts`:

- Track timestamps of last drum hit and last starlace pluck (across both players combined — a global "anyone hit a drum / anyone plucked starlace"):

```ts
private lastDrumHitAt = -10;
private lastStarlacePluckAt = -10;
private lastSynchronyAt = -10;

// In Drum's onHit callback (passed via installPlayerVisual):
onHit: hit => {
  this.handSynth.triggerOrbHit(player, hit.frequency, hit.velocity, hit.orbIndex);
  this.lastDrumHitAt = performance.now() / 1000;
  this.checkSynchrony();
}

// In Starlace's onPluck callback similarly:
onPluck: pluck => {
  this.handSynth.triggerStarlacePluck(...);
  this.lastStarlacePluckAt = performance.now() / 1000;
  this.checkSynchrony();
}

private checkSynchrony(): void {
  const now = performance.now() / 1000;
  if (Math.abs(this.lastDrumHitAt - this.lastStarlacePluckAt) < 0.4 &&
      now - this.lastSynchronyAt > 0.25) {
    this.lastSynchronyAt = now;
    this.sculptor.fireSynchrony();
  }
}
```

- [ ] **Step 6.3 — Sculptor synchrony effects.**

In `EnergySculptor.ts`:

- Add `fireSynchrony(): void`. Implementation:
  - Set a `synchronyBoost` uniform to 1, decaying back to 0 over ~0.5s.
  - Spawn a "synchrony ring" — a thin torus or expanding ring sprite at the sculptor center, scaling outward to ~1.2m and fading over 0.8s. Use a small additive-blended `THREE.Mesh` with `RingGeometry`, opacity modulated in `update()`.
- In the integrate compute, add `synchronyBoost * gainPerFrame` to each particle's pull toward target, so the sculpture momentarily contracts/densifies.
- In emitters (Drum/Starlace), check `sculptor.synchronyBoost` (expose via getter) when emitting; if > 0.3, multiply count and intensity by `(1 + duetBonusGain)`. Add the param:

```ts
duetBonusGain: { default: 1.2, min: 0, max: 2, step: 0.05, label: 'duet bonus' },
```

- [ ] **Step 6.4 — Smoke test.**

Run dev server with default solo (drum + robot starlace). The robot will play steady-ish; the local player can hit drum keys.

- Hit the drum on a beat that overlaps with one of the robot starlace's plucks (timing approximate). A faint white ring should pulse outward; the next sparks should be brighter and slightly larger. The sculpture's central column should briefly densify.
- If synchrony fires too often (e.g. every drum hit), reduce the 0.4s window or raise the 0.25s minimum gap.

- [ ] **Step 6.5 — Commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
sculptor: cross-currents and duet synchrony

Each particle deflects from the other instrument's local density
(coarse 8³ presence grid uploaded each frame). Duet synchrony fires
when a drum hit and starlace pluck occur within 0.4s: emitters
amplify the next bursts, sculptor briefly tightens its attractor pull,
and a ring sprite pulses out from the center as visible reward.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 — Dissolve transition + in-world timer ring

**Files:**
- Modify: `src/game/EnergySculptor.ts`, `src/game/Game.ts`

**Goal:** At each round boundary, the current sculpture visibly dissolves outward and is replaced by a fresh one. A glowing ring around the sculpture acts as the round timer.

- [ ] **Step 7.1 — Dissolve mode in compute.**

Add a `dissolveMode` uniform (float 0..1) to `EnergySculptor`. When >0, the integrate compute switches behavior:

- Velocity gets an outward burst from center: `vel += (pos - center).normalize() * dissolveBurstSpeed * delta`.
- Life decays at `(1 + 4 * dissolveMode) * delta` so particles age out within the dissolve window.

Public API:

```ts
beginDissolve(): void { this.dissolveMode.value = 1; }
endDissolve(): void { this.dissolveMode.value = 0; }
```

In `Game.ts`:

```ts
this.roundDirector.onDissolvingStart(() => this.sculptor.beginDissolve());
this.roundDirector.onPlayingStart(() => this.sculptor.endDissolve());
```

Add the burst speed tweak:

```ts
dissolveBurstSpeed: { default: 3, min: 0, max: 8, step: 0.1, label: 'dissolve burst' },
```

During dissolve, suppress `emit()` requests inside the sculptor (drop them on the floor) so particles emitted from instruments don't immediately get blown away — they'll start arriving cleanly at the next `playing` start.

- [ ] **Step 7.2 — In-world timer ring.**

In `EnergySculptor.ts`, add a `THREE.Mesh` with `RingGeometry(innerRadius, outerRadius, segments)` (e.g. 0.42 / 0.46 / 64), additive-blend, oriented to face the player camera. Each frame:

- Update the ring's `material.opacity` based on round state: `0.45` while playing, `0.15` while dissolving, `0.0` when idle.
- Use a TSL `colorNode` that varies along the ring's circumference, masking out segments past the round progress angle. Simplest: make the ring itself a `THREE.Mesh` with a custom `MeshBasicNodeMaterial` and a `progressUniform`; in TSL, fragment color is `lerp(ringColor, transparent, step(progressUniform, normalizedAngle))`.

Implementation pattern:

```ts
import { Fn, vec4, vec3, float, uv, smoothstep, mix } from 'three/tsl';
const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.46, 96), new THREE.MeshBasicNodeMaterial({
  transparent: true,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  depthWrite: false,
}));
ring.rotation.x = Math.PI / 2; // lay flat — adjust based on camera angle
const progress = uniform(0); // 0..1
ring.material.colorNode = vec3(1.0, 0.95, 0.78);
ring.material.opacityNode = smoothstep(progress, progress.add(0.04), uv().x);
// uv().x of a RingGeometry runs 0..1 around the ring (verify; if not, use atan2 of pos.xz)
```

If `uv().x` doesn't run 0..1 around the ring in the project's three version, fall back to `atan2(positionLocal.z, positionLocal.x).div(TAU).add(0.5)` for the angle.

`Game.ts` updates the progress uniform every frame:

```ts
this.sculptor.setRoundProgress(round.progress);
```

(Already wired in Task 5 — the same call now also drives the ring.)

- [ ] **Step 7.3 — Smoke test.**

Run dev server.

- A faint horizontal ring should be visible around the sculpture base.
- The ring should "fill" or "deplete" over the round duration. (Acceptance: it visibly changes over the round; depletion direction is fine either way as long as it's monotonic.)
- At the boundary: ring goes dim; existing particles burst outward; after ~1.5s, fresh particles start arriving and the ring resets.
- If anything looks broken, tune in tweakpane (`dissolveBurstSpeed`, `dissolveDuration`).

- [ ] **Step 7.4 — Commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
sculptor: dissolve transition + in-world timer ring

At each round boundary, particles get an outward burst with accelerated
aging; new emits are suppressed during the dissolve window. A glowing
ring laid flat around the sculpture base depletes over the configured
roundDuration so players see the timer in-world without HUD overlay.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8 — Final pass: tweakpane sweep, verification, polish

**Files:** any from prior tasks; primary: `src/game/EnergySculptor.ts`, archetypes, `src/game/RoundDirector.ts`

**Goal:** Every spec verification line passes; tweakpane changes propagate cleanly; `r` reset works.

- [ ] **Step 8.1 — Per-archetype tweak params.**

For each of the three archetype modules, expose a small `*_DEFS` and use `registerTweaks` for shape-scale, flow-strength, and any color-blend bias. Pattern:

```ts
// In drumDrum.ts
import { registerTweaks } from '../../../hud/tweakDefs';
export const DRUM_DRUM_DEFS = {
  height:      { default: 1.4, min: 0.4, max: 3, step: 0.05, label: 'tower height' },
  baseRadius:  { default: 0.16, min: 0.04, max: 0.4, step: 0.005, label: 'base radius' },
  flowUp:      { default: 0.6, min: 0, max: 2, step: 0.02, label: 'flow up' },
} as const;
```

Have each archetype expose a `register(paneDock, params)` function called by `EnergySculptor` once on construction. The shape/flow samplers read from the params closure. Don't worry about preserving sampler purity — they're reset across rounds anyway.

- [ ] **Step 8.2 — Verify the spec verification list.**

For each line of the spec's Testing section, run the dev server and verify:

- [ ] Build runs clean (`tsc`, Vite); cold load shows no console errors.
- [ ] Drum hits visibly emit warm spark clusters that travel to + feed the sculpture.
- [ ] Starlace plucks emit color-tinted star-streaks that travel to + feed the sculpture.
- [ ] Sculpture archetype matches the current pairing (drum+drum tower vs melody+melody braid vs duet halo'd column).
- [ ] Round timer ring depletes over `roundDuration`; sculpture dissolves at the boundary; new sculpture begins immediately.
- [ ] Robot partner picks the opposite instrument and the swap takes effect at the next boundary, not mid-round.
- [ ] Duet synchrony ring fires when drum + starlace events align within ~0.4s.
- [ ] Tweakpane changes to `roundDuration`, `dissolveDuration`, `particlePoolSize`, `crossCurrentStrength`, `duetBonusGain` all visibly affect behavior live.
- [ ] Pressing `r` in debug mode (with DevOverlay open via `/`) resets all new params to defaults.

If any line fails: fix the bug, commit the fix in a small follow-up, re-verify.

- [ ] **Step 8.3 — Final cleanup pass.**

- Search the codebase for stale `'loom'`, `'chime'`, `'orbs'` references; eliminate any remaining ones outside `normalizeInstrumentId`.
- Remove any temporary `console.log` statements introduced during testing.
- Ensure every new file's exports are imported somewhere; tree-shake unused exports.
- Verify the project's existing eslint/tsc passes (`npm run typecheck` or equivalent — check `package.json` for the project's verification script).

- [ ] **Step 8.4 — Final commit.**

```bash
git add -A
git commit -m "$(cat <<'EOF'
sculptor: per-archetype tweaks and final cleanup pass

Each archetype exposes shape/flow tunables under its own tweakpane
folder. Verified the full spec verification list. Removed remaining
references to retired loom/chime/orbs outside normalizeInstrumentId.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Risks & follow-ups (informational)

- **TSL writeable storage buffers.** The CPU-mirror upload path in Task 3 assumes the installed `three/webgpu` version exposes a writable `instancedArray.value`. If not, fall back to backing each `instancedArray` with a `THREE.InstancedBufferAttribute` and writing `attribute.needsUpdate = true` after mirror mutations. Pattern lives in `src/game/particles.ts` — mirror it.
- **Cross-current grid bandwidth.** Uploading two 512-float arrays per frame is fine on desktop GPUs but may be the largest per-frame upload on mobile. If profiling flags it, drop grid resolution to 6³ or update every other frame.
- **Bloom.** If the rendered look feels flat, post-process bloom is a meaningful follow-up — out of scope for this plan but signaled.
- **Pool resize.** Tweakpane changes to `particlePoolSize` are deferred (no live realloc). Document this in the tweakpane label or accept the page-reload requirement.
