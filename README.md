# Jam Train

A browser-based hand-tracked music/rhythm experience. Wave your hands in front of your webcam to drive the game; jump online to share a room with another player.

Built with Three.js, Tone.js, MediaPipe-style hand pose tracking, and [SpacetimeDB](https://spacetimedb.com/) for multiplayer.

## Prerequisites

- **Node.js** 20+ and **npm**
- A **webcam** (optional — the game falls back to simulated hands if you skip camera permission)

Multiplayer is hosted on [SpacetimeDB Maincloud](https://spacetimedb.com/maincloud) and is wired up by default. There is nothing to install or run locally for it.

## Run

```sh
npm install
npm run dev
```

Open <http://localhost:5173> (Vite will print the exact URL). Click **Camera** to enable hand tracking and **Audio** to start the music.

The HUD's connection pill should switch from `local` → `connecting` → `spacetime` once the maincloud connection is established. Type the same room name (e.g. `cabin-01`) in two browser tabs — or share the deployed URL with another player — and you'll see the other player's hands.

If maincloud is unreachable the client silently falls back to a local-only mode (the pill stays on `local`); the game still works, you just won't see remote players.

## Build

```sh
npm run build      # type-check + production build to dist/
npm run preview    # serve the built app
```

The production build connects to the same maincloud database as local dev, so deploys to Vercel (or anywhere else) work without any environment configuration.

## Updating the SpacetimeDB module

The module source lives in `spacetimedb/src/index.ts`. After changing the schema or reducers:

```sh
npm run spacetime:publish
```

This publishes the module to maincloud (database name: `jam-train`) and regenerates the TypeScript bindings in `src/module_bindings/`.

You'll need the SpacetimeDB CLI for this step — install it from <https://spacetimedb.com/install>:

```sh
curl -sSf https://install.spacetimedb.com | sh
```

Then `spacetime login` once to authenticate against maincloud.

## Project layout

- `src/main.ts`, `src/game/` — Three.js client, hand tracking, audio, multiplayer client
- `src/module_bindings/` — generated SpacetimeDB client bindings (do not edit by hand)
- `spacetimedb/src/index.ts` — SpacetimeDB module: `player` and `hand_state` tables plus reducers
- `spacetime.json` — SpacetimeDB CLI config (points at maincloud)

## Troubleshooting

- **HUD stuck on `local`:** maincloud may be down or your network is blocking WebSockets. The game still works, just without a remote player.
- **Camera permission denied:** the game keeps running with simulated hand poses; click **Camera** again after granting permission to switch to the real webcam.
- **Stale bindings after editing the module:** rerun `npm run spacetime:publish` (or `npm run spacetime:generate` if the module is already published).
