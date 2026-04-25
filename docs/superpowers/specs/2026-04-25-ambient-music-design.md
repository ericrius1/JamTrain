# Ambient Music System Design

**Date:** 2026-04-25
**Status:** Approved
**Replaces:** Step-sequencer logic in `src/game/audio.ts`

## Goal

Replace the current 16th-note step sequencer with a continuous, always-sustaining
ambient soundscape whose timbre, swell, and brightness are modulated by hand and
finger pose in real time. The relationship between the player's body and the
sound should feel direct and continuous, not transactional or note-triggered.

## Motivation

The existing engine fires individual notes from a fixed scale on a clock. The
result is busy, machine-gun-like, and only loosely tied to the hands (hands
nudge a filter cutoff but the note onsets are clock-driven). Players cannot
hear what their hands are doing; they hear an unrelated arpeggio.

This design removes clock-triggered notes entirely. Voices sustain
indefinitely; the only changes are slow chord transitions and continuous
parameter modulation.

## Sound design

### Layers

Three internal layers, all continuous (no clock-triggered events):

1. **Pad bed (always on)** — three sustained synth voices forming the current
   chord (root, third, fifth). Voices use a portamento to glide pitch when the
   chord changes — no re-triggering.
2. **Drone sub (always on)** — a single low triangle/sine voice one octave
   below the chord root. Very quiet, slow amplitude LFO. Anchors the bed.
3. **Hands-presence shimmer (modulated)** — a brighter voice an octave above
   the pad bed, gain-gated by total hand presence (sum of both players'
   tracking confidence, smoothed). Fully silent when no hands are tracked;
   fades in over ~1.5 s when hands appear.

### FX chain (shared bus)

```
Pad voices ──┐
Drone     ──┼──► Filter (LP) ──► Chorus ──► PingPongDelay ──► Reverb ──► out
Shimmer   ──┘
```

- **Filter (LP)** — cutoff modulated by average hand height (Y).
- **Chorus** — depth/width modulated by inter-player hand distance.
- **PingPongDelay** — feedback gentle, mostly-static (subtle motion via curl).
- **Reverb** — long decay (~6–8 s); wet level modulated by average finger curl.

### Day/night palette crossfade

Two parallel pad beds run simultaneously. Their gains are crossfaded by the
existing `atmosphere.daylight` signal from `ScenerySystem`:

- **Bed A — Dark/contemplative (night).** Plays at gain `1 - daylight`.
  Chord cycle in A minor: `Am9 → Fmaj7 → Cmaj9 → Gsus4` (root notes
  A2/F2/C2/G2; voice roots one octave higher).
- **Bed B — Warm/wistful (day).** Plays at gain `daylight`. Chord cycle in
  D major: `Dmaj7 → Amaj9 → Esus2 → F#m11` (root notes D2/A2/E2/F#2).

Both beds advance through their chord cycle at the same tempo so dawn/dusk
crossfades expose a blended harmony rather than two unrelated progressions.

### Chord cycle tempo

One chord change every **35 seconds** (single value, not randomised).
Pitch glides between chords use ~4 s portamento, so the transition itself
covers most of the chord's first ten seconds.

## Hand mapping

All mappings are **continuous** and read every frame; no thresholds.

| Source                                      | Maps to                  | Range / behaviour                                          |
|---------------------------------------------|--------------------------|------------------------------------------------------------|
| Average hand height (Y) of all tracked hands | LP filter cutoff         | low Y → ~400 Hz (dark); high Y → ~5500 Hz (open)           |
| Average hand horizontal (X)                  | Stereo pan of pad bed    | left X → pan -0.7; right X → pan +0.7                      |
| Average finger curl across all tracked hands | Reverb wet               | curled (fist) → wet 0.55; open → wet 0.18                  |
| Distance between local and remote hand centroids | Chord swell + chorus depth | close → master gain 0.55, chorus depth 0.2; spread → master gain 1.0, chorus depth 0.7 |
| Total tracking confidence (presence)         | Shimmer voice gain       | 0 → muted; 1 → -8 dB                                       |

When a hand is not tracked (confidence ≈ 0), it contributes nothing to the
averages and the missing-hand "weight" effectively pulls the modulators toward
their rest values (mid-filter, centre pan, low reverb wet, no shimmer, low
swell). All modulator targets ramp with `Tone.Signal.rampTo(value, 0.12)` so
no parameter jumps audibly.

When a player joins or drops out entirely, those rest defaults take over
within ~1–2 s without any explicit state machine.

## Multiplayer behaviour

Both players contribute equally. Centroids and averages are computed over
**all tracked hands across both players**, weighted by per-hand `confidence`.
The "linking" metaphor surfaces in the chord-swell mapping: as the two
players' hands move apart, the chord opens up (louder, wider chorus).

If only the local player is tracked (no remote / robot pose contributing
hands with confidence > threshold), the inter-player distance modulator
falls back to **distance between the local player's two hands**, so a
single player still has a swell/openness control.

## Module structure

Single file: rewrite `src/game/audio.ts` in place. Export class `AudioEngine`
with the same `start()` / `dispose()` surface. Internal helpers
(`buildVoices`, `buildFx`, `computeMappings`, `advanceChord`) stay private.
Chord palettes live as exported constants at top-of-file.

The signature of `update()` changes from
`update(local, remote, time)` to `update(local, remote, daylight, delta)`.
Caller (`Game.update()`) passes `atmosphere.daylight` from the scenery
system and frame `delta`.

## Tweakpane controls (under existing dock)

A new `audio` folder, mirroring the orb/scenery pattern:

- `master gain` (0–1)
- `chord cycle seconds` (10–120, default 35)
- `portamento seconds` (0.1–8, default 4)
- `filter cutoff range` (min Hz / max Hz)
- `reverb wet range` (min / max)
- `shimmer max gain` (-30 dB – 0 dB)
- `mute hands modulation` (boolean — for tuning the rest bed in isolation)

## Out of scope

- No new visual changes (no spectrum visualizer, no orb audio coupling).
- No microphone input or external audio routing.
- No per-finger voice mapping (rejected during brainstorming).
- No drum/percussion layer.
- No save/restore of pane settings.

## Acceptance

The new system is acceptable when:

1. Loading the game with no camera / no hands produces a smooth, sustained
   ambient bed that audibly evolves chord-wise on a slow cycle.
2. Raising both hands together brightens the sound continuously with no
   clicking, retriggering, or step artefacts.
3. Spreading hands apart vs. together produces a continuous swell.
4. Curling fingers vs. opening them changes reverb wetness audibly.
5. Day↔night cycle in scenery audibly shifts the harmonic mood.
6. Removing hands from the camera frame causes the modulators to relax
   smoothly to rest values within ~2 s.
