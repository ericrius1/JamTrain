# TrainJam HUD — Aura Cabin Port

Port the high-fidelity solar-steampunk HUD from `~/Downloads/design_handoff_trainjam_hud/` (React reference) into the existing Vite + TypeScript + Three.js project as **vanilla TS DOM**. Replace the current minimal top-left HUD entirely. Add a `/` keybinding that toggles a dev overlay (Tweakpane dock + `stats.js`).

## Stack & Layout

- Vanilla TS + DOM + SVG. No React.
- New dep: `stats.js` (+ `@types/stats.js` if available).
- Stage: 1920×1014 inner stage scaled by `min(viewportW/1920, viewportH/1014)`, letterboxed over the canvas.
- HUD container: `position:absolute; inset:0; pointer-events:none`; children opt in.
- **Center axis sacred** — no HUD elements over the table or aura ring (the existing prototype's edge-only layout is hard).
- Google Fonts: Fraunces, IM Fell English, IM Fell English SC, JetBrains Mono.

## Components (each owns its DOM, exposes typed setters)

1. **TitlePlaque** (top-left) — brand, room, line. `setRoom`, `setLine`.
2. **ResonanceGauge** (top-right) — copy + 86px gauge dial; `setScenario('solo'|'paired', peerName?, latencyMs?)`. Needle spring `cubic-bezier(.5,1.6,.4,.9)` 1.6s.
3. **PlayerPlaque** (×2, left + right mid) — **simplified: stamp + name + voice + medallion only**. **No fingertip lanterns / hand strip / divider.**
4. **HarmonyBand** (bottom-center) — Key, BPM, 4/4, weaving lamp, note ribbon, you/peer legend.
5. **EngineRoomDrawer** (bottom-left) — closed: brass key button. Open: Camera/Audio/Hands/Net rows, **Recalibrate** + **Disembark** action buttons, **Game/Orbit** segmented row.
6. **CaptureControl** (bottom-right) — Press Aura toggle; while recording shows elapsed `MM:SS.cc` plaque.
7. **CornerFiligree** — 4 corners, decorative.
8. **BeginGate** — initial centered overlay with one **Begin** button (see below).

## Single Start Gate

- On first load, a centered brass plaque overlay covers the stage with a single **Begin** brass key button.
- Click → calls one entry on `Game` that does both `startCamera()` + `startAudio()` in the same user gesture.
- On success: overlay fades out (~400ms) and never returns.
- On failure: overlay shows error stamp + retry.
- Post-start, `Recalibrate` (in Engine Room) is the only re-trigger for camera/calibration.

## Dev Overlay (`/` toggle)

- A `DevOverlay` controller toggles **Tweakpane dock visibility** + **stats.js panel** together.
- Both **off** by default.
- Keybinding: `keydown` `/`. Ignored when `event.target` is `<input>`, `<textarea>`, or `[contenteditable]`.
- `stats.js`: top-right of the **viewport** (above the gauge, `z-index: 1000`). Default panel 0 (FPS); cycle on click.
- Tweakpane dock currently top-right; collides with the Resonance Gauge. Move dock to `top: 220px; right: 24px` so it sits below the gauge when visible.

## Wiring — Real vs Mock

**Real**:
- `room` — Engine Room Net row, click-to-edit; routes through `Game.setRoom`.
- Connection state from `Game.multiplayer` → drives latency line / Net row text.
- `Recording` on/off — local state in `CaptureControl`.
- Camera mode (Game/Orbit) — calls existing `Game.setCameraMode`.
- Begin button → `Game.startCamera()` + `Game.startAudio()`.

**Mock animated** (with `// TODO: wire to <source>` comments):
- Scenario solo/paired (toggle in tweakpane for now — SpacetimeDB peer presence not tracked yet).
- Note ribbon (~0.55 prob/120ms, life decays 0.03/tick, drift 0.005/tick, cap 30 — matches reference behavior).
- Key/BPM defaults: `D DORIAN` / `92`.
- Latency display (38ms placeholder).

**Removed per request**: hand confidence (no Fingertip Lanterns block, no `LOST` state, no MicroPose lamp meter).

## Files

**New**:
- `src/hud/Hud.ts` — root coordinator
- `src/hud/components/TitlePlaque.ts`
- `src/hud/components/ResonanceGauge.ts`
- `src/hud/components/PlayerPlaque.ts`
- `src/hud/components/HarmonyBand.ts`
- `src/hud/components/EngineRoomDrawer.ts`
- `src/hud/components/CaptureControl.ts`
- `src/hud/components/CornerFiligree.ts`
- `src/hud/components/BeginGate.ts`
- `src/hud/components/Medallion.ts` (sun + cog SVG)
- `src/hud/components/Sunburst.ts` (decorative SVG)
- `src/hud/components/Rivets.ts` (4-corner rivet helper)
- `src/hud/DevOverlay.ts` — `/` toggle, owns tweakpane dock visibility + stats.js
- `src/hud/style.css` — design tokens, plaque chrome, rivets, lamps, buttons, animations

**Modify**:
- `index.html` — font link; swap markup to `<div id="stage-wrap"><div id="stage"><canvas id="scene"/><div id="ui"/></div></div>` with HUD mount inside.
- `src/main.ts` — instantiate `Hud`, wire to `Game`, bind `/`.
- `src/game/Game.ts` — expose pane dock element to `Hud` (so `DevOverlay` can hide/show it). Minimal change.
- `src/style.css` — drop the old `.hud`, `.brand`, `.pill`, `.meter`, `.icon-button`, `.segmented`, `.tweak-pane-dock` styles. Keep `#scene` baseline.

## Out of Scope (mock or stubbed; explicit TODO comments)

- Real peer presence over SpacetimeDB.
- Real Tone.js note events feeding the ribbon.
- Real `MediaRecorder` capture (button toggles UI only).
- Real hand-tracking lost/found state (component removed entirely).
- `prefers-reduced-motion` — single CSS guard for the `spin-slow` / `pulse` / `flicker` animations.

## Acceptance

- HUD visually matches the reference layout at 1920×1014; scales correctly when window resizes.
- Pre-start: only Begin overlay is interactive.
- Post-start: Begin overlay gone; HUD chrome + scene visible.
- `/` toggles tweakpane + stats.js together; both default off.
- Existing `Game` functionality (room change, camera mode, audio + camera start) still works through new HUD entry points.
- No console errors. `npm run build` (`tsc --noEmit && vite build`) passes.
