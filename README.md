# Jam Train

A browser-based hand-tracked music/rhythm experience. Wave your hands in front of your webcam to drive the game; jump online to share a room with another player.

Built with Three.js, Tone.js, MediaPipe-style hand pose tracking, and [SpacetimeDB](https://spacetimedb.com/) for multiplayer.

## Prerequisites

- **Node.js** 20+ and **npm**
- A **webcam** (optional — the game falls back to simulated hands if you skip camera permission)
- **SpacetimeDB CLI** (only required for multiplayer). Install from <https://spacetimedb.com/install>:
  ```sh
  curl -sSf https://install.spacetimedb.com | sh
  ```
  Verify with `spacetime --version`.

## Install

```sh
npm install
```

## Run single-player (no SpacetimeDB)

This is the fastest way to try the game. Multiplayer will silently fall back to a local-only mode if it can't reach SpacetimeDB.

```sh
npm run dev
```

Open <http://localhost:5173> (Vite will print the exact URL). Click **Camera** to enable hand tracking and **Audio** to start the music.

The connection pill in the HUD will read `local` — that's expected without a SpacetimeDB server.

## Run multiplayer

Multiplayer needs three things running:

1. A local SpacetimeDB server
2. The `jam-train` module published to that server
3. The Vite dev server

The simplest path is two terminals:

### Terminal 1 — SpacetimeDB server

```sh
npm run spacetime:start
```

This starts SpacetimeDB on `127.0.0.1:3000` in in-memory mode. Leave it running.

### Terminal 2 — module + web app

```sh
npm run spacetime:dev
```

This builds and publishes the `jam-train` module to your local SpacetimeDB, regenerates the TypeScript bindings in `src/module_bindings/`, and then runs `npm run dev`.

When the web app comes up, the HUD's connection pill should switch from `local` → `connecting` → `spacetime`. Type the same room name (e.g. `cabin-01`) in two browser tabs — or share your LAN IP with another machine — and you'll see the other player's hands.

### Useful variants

- `npm run spacetime:server` — publish the module without starting the web app (handy if you want to run `npm run dev` separately).
- `npm run spacetime:generate` — regenerate `src/module_bindings/` from `spacetimedb/src/index.ts` after changing the schema.

## Configuration

Multiplayer endpoints come from `.env.local` (already checked in for local dev):

```
VITE_SPACETIMEDB_HOST=http://127.0.0.1:3000
VITE_SPACETIMEDB_DB_NAME=jam-train
```

Override `VITE_STDB_URI` (use `ws://` or `wss://`) and `VITE_STDB_DATABASE` to point at a different SpacetimeDB deployment.

## Build

```sh
npm run build      # type-check + production build to dist/
npm run preview    # serve the built app
```

## Project layout

- `src/main.ts`, `src/game/` — Three.js client, hand tracking, audio, multiplayer client
- `src/module_bindings/` — generated SpacetimeDB client bindings (do not edit by hand)
- `spacetimedb/src/index.ts` — SpacetimeDB module: `player` and `hand_state` tables plus reducers
- `spacetime.json`, `spacetime.local.json` — SpacetimeDB CLI config

## Troubleshooting

- **HUD stuck on `local` during multiplayer:** make sure `npm run spacetime:start` is still running and that `npm run spacetime:server` (or `spacetime:dev`) finished publishing without errors.
- **`spacetime: command not found`:** install the CLI (see Prerequisites) and reopen your shell.
- **Camera permission denied:** the game keeps running with simulated hand poses; click **Camera** again after granting permission to switch to the real webcam.
- **Stale bindings after editing the module:** rerun `npm run spacetime:generate`.
