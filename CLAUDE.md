# JamTrain

## Debug mode

**Debug mode = DevOverlay visible**, toggled with the `/` key.

Everything debug-only is gated by the same toggle:

- Tweakpane controls
- Stats.js panel
- Special key activations (e.g. `c` cycles camera, `r` resets tweak params to code defaults)
- Any future dev-only HUD pieces

When adding a new dev affordance, hang it off the existing `/` toggle rather than introducing a separate debug flag or query param.

## Tweakable params

All modules expose tweakable params via the shared `*_DEFS` pattern (see `src/hud/tweakDefs.ts`). Each param entry carries `{ default, min, max, step, hidden? }` — the actual values stay co-located with their metadata, not buried in `addBinding` boilerplate.

- Changes are persisted to `localStorage` automatically (per module key).
- Pressing `r` while debug mode is active resets every module's params back to the in-code defaults and clears persisted state.
