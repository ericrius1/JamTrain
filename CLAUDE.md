# JamTrain

## Debug mode

**Debug mode = DevOverlay visible**, toggled with the `/` key.

Everything debug-only is gated by the same toggle:

- Tweakpane controls
- Stats.js panel
- Special key activations (e.g. `c` cycles camera)
- Any future dev-only HUD pieces

When adding a new dev affordance, hang it off the existing `/` toggle rather than introducing a separate debug flag or query param.

All special keys (e.g. `c` camera cycle, `n` reset, `m` robot mute) are gated to debug mode so they're free to be used as instrument keys when debug is off.

## Tweakable params

All modules expose tweakable params via the shared `*_DEFS` pattern (see `src/hud/tweakDefs.ts`). Each param entry carries `{ default, min, max, step, hidden? }` — the actual values stay co-located with their metadata, not buried in `addBinding` boilerplate.

- Changes are persisted to `localStorage` automatically (per module key).
- Pressing `n` while debug mode is active resets every module's params back to the in-code defaults and clears persisted state.


Make sure when you change instruments or things related to spacetime and how it syncs that you automatically push the new spacetime module or whatever you need to do for it to work deployed