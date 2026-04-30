# JamTrain

## Debug mode

**Debug mode = DevOverlay visible**, toggled with the `/` key.

Everything debug-only is gated by the same toggle:

- Stats.js panel
- Special key activations (e.g. `c` cycles camera)
- Any future dev-only HUD pieces

When adding a new dev affordance, hang it off the existing `/` toggle rather than introducing a separate debug flag or query param.

`r` is the one exception: it resets runtime params (including audio mixer sliders) to their in-code defaults and works regardless of debug-overlay visibility, so a stuck/misconfigured session can always be recovered without first opening the overlay.

## Tweakable params

All modules expose runtime params via the shared `*_DEFS` pattern (see `src/hud/tweakDefs.ts`). Each param entry carries `{ default, min, max, step, hidden? }` so values stay co-located with their metadata.

- Pressing `r` (any time, debug mode or not) resets every registered module's params back to the in-code defaults.


Make sure when you change instruments or things related to spacetime and how it syncs that you automatically push the new spacetime module or whatever you need to do for it to work deployed
