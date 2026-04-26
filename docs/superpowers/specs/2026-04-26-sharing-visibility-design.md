# Sharing Visibility — Design

## Problem

The current Camera / Share Video / Mic toolbar uses opacity (`0.7` off vs `1.0` on) and a brass→gold color shift to indicate state. In practice this is too subtle: users have mistakenly believed they were sharing camera with a partner when they weren't. The off state reads as "available but quiet," not "off."

There is also no signal in the local video preview itself about whether the partner can actually see you. Sharing failure is silent.

## Goals

- Make the on/off state of all three toolbar buttons unambiguous at a glance.
- When a partner is in the room and the local user is not sharing video, surface that fact directly on the local video preview so it can't be missed.

## Non-goals

- Mic-off signaling on the video preview. The partner will tell you if they can't hear you; visual silence is the bigger problem. Mic state is communicated through the toolbar button only.
- Any change to remote panel rendering.
- Any change to the underlying WebRTC track-management logic.
- Any change to how camera state drives the existing "Camera Off" placeholder overlay.

## Design

### 1. Toolbar button off-state

Today (`src/hud/style.css` lines 635–716):
- Off: `opacity: 0.7`, `color: var(--text-dim)`, soft inner gold shadow.
- On (`.enabled`): `opacity: 1`, `color: var(--sun)`, gold glow shadow.

New off-state styling:
- **Icon swap.** Each button's SVG has a paired "off" variant with a diagonal slash drawn through the glyph in the same stroke style — `EMPTY_CAMERA_SVG`-style line work. New constants in `src/hud/components/VideoPanel.ts`:
  - `CAMERA_OFF_SVG` — camera body with diagonal slash.
  - `SHARE_OFF_SVG` — eye glyph with diagonal slash.
  - `MIC_OFF_SVG` — mic with diagonal slash.
- **Color.** Off-state slash and label tint to a muted alert red. Add `--alert: #c75a4a` to the existing CSS custom-property block so it's reusable. Saturation kept low to fit the brass-and-parchment palette.
- **Opacity.** Off-state opacity becomes `1.0` — the meaning changes, not the prominence. Hover styling collapses to match the new on/off semantics.
- **Inner glow.** Drop the warm `inset 0 1px 0 rgba(246, 179, 51, 0.20)` highlight from the off state so off-buttons no longer read as "on-ish."
- **On state stays.** `.enabled` keeps today's gold + glow look unchanged.

The toolbar's progressive-disclosure behavior (`data-stage="share"` hidden until camera is on) is preserved.

`makeToolbarButton` is extended to accept both an `iconOn` and `iconOff` SVG. The state setters (`setCameraEnabled`, `setShareVideoEnabled`, `setMicEnabled`) swap the inner SVG in addition to toggling the `.enabled` class.

### 2. "Partner can't see you" overlay

A new ribbon element is rendered inside the local `VideoPanel` wrapper.

**Visibility rule** (all three must be true):
- `partnerPresent === true`
- `cameraEnabled === true`
- `shareVideoEnabled === false`

If camera is off, the existing `.video-panel-empty` overlay already covers the panel; the ribbon stays hidden so overlays don't stack.

**Visual:**
- Horizontal ribbon spanning the panel's full width, vertically centered, ~28% of panel height.
- Background: `rgba(0, 0, 0, 0.7)` with a 1px brass border on top and bottom (`var(--brass-2)`) so the live preview remains visible above and below.
- Centered content stacked vertically:
  - Slashed-eye SVG (~24px), in the alert-red tint.
  - Headline: `PARTNER CAN'T SEE YOU` — `IM Fell English SC`, uppercase, alert-red, letter-spacing matched to the toolbar buttons.
  - Subline: `Tap Share Video to share your camera` — `JetBrains Mono`, parchment.
- `pointer-events: none` — purely informational; the actionable target is the toolbar button above.
- Sits above the video and landmark canvas (`z-index` higher than canvas, lower than toolbar).
- Fades in/out over ~200ms when the visibility rule flips, so it doesn't pop when a partner joins or when Share Video is toggled.

**Markup:** New `<div class="video-panel-share-warn">` built in `buildShareWarnOverlay()`, appended to the wrapper after the empty overlay in the local-mode branch of the constructor.

### 3. Wiring

Existing wiring:
- `main.ts:162` — `game.onPartnerChange(name => hud.setPartner(name))`.
- `Hud.setPartner(name)` already maintains `partnerPresent` for the net-row HUD (`src/hud/Hud.ts:241–246`).
- `Hud.setShareVideoEnabled` already forwards to `localPanel` (`src/hud/Hud.ts:192–194`).

Additions:
- `VideoPanel.setPartnerPresent(present: boolean)` — local-mode only; stores the flag and calls a private `recomputeShareWarn()` that ANDs `partnerPresent && cameraEnabled && !shareVideoEnabled` and toggles a `.visible` class on the ribbon.
- `setCameraEnabled` and `setShareVideoEnabled` also call `recomputeShareWarn()` so any flag change updates the overlay.
- `Hud.setPartner` (existing) extended by one line to call `this.localPanel.setPartnerPresent(this.partnerPresent)` after updating `partnerPresent`.

No new state in `Game.ts` or `webrtc.ts`. No new event plumbing in `main.ts`.

## File touchpoints

- `src/hud/components/VideoPanel.ts` — new SVG constants, `iconOn`/`iconOff` in `makeToolbarButton`, `buildShareWarnOverlay`, `setPartnerPresent`, `recomputeShareWarn`, icon swaps in the three setters.
- `src/hud/Hud.ts` — one-line forward inside `setPartner`.
- `src/hud/style.css` — alert color custom property, off-state restyle for `.video-panel-toolbar-btn`, new `.video-panel-share-warn` rules.

## Out of scope / deferred

- Mic-off ribbon or badge on the local panel.
- Any "partner can't hear you" surfacing.
- Changes to remote panel placeholder copy.
- Telemetry / analytics on toggle usage.
