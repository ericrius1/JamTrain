# Peer Video & Audio (WebRTC + SpacetimeDB signaling)

Status: Draft
Owner: Eric
Date: 2026-04-25

## Goal

Two players in the same Jam Train cabin should hear each other and see each other's webcams in real time. The local player's video keeps the existing hand-landmark overlay; the remote video is shown raw. Engine Room debug drawer is hidden for now.

WebRTC handles the media. SpacetimeDB handles signaling — no extra services beyond what's already deployed.

## Non-goals

- TURN relay (we ship STUN-only; symmetric-NAT pairs will fail to connect — they get the existing experience).
- Hand-landmark overlay on the remote video.
- Mic-mute / camera-mute UI controls.
- Recording, multi-party (>2), or screen sharing.
- Reviving the Engine Room drawer's recalibrate / disembark / camera-mode controls. The drawer mount is commented out and lives behind whatever we add later.

## Hard requirement: graceful degradation

If WebRTC fails at any stage (mic permission denied, peer connection negotiation error, ICE failure, signaling reducer error, table subscription drop, browser without RTCPeerConnection, etc.), the rest of the game must keep working: hand tracking, 3D rigs, plasma orb, SpacetimeDB pose sync, audio engine, HUD. The peer-video subsystem is strictly additive.

Concretely:
- All WebRTC code is wrapped so a thrown error never escapes into the game loop.
- Failures log to `console.warn` / `console.error` with enough detail to debug post-hoc (see Logging below).
- A WebRTC failure does **not** disable hand tracking, even if the failure occurs while reusing the shared MediaStream. If audio capture fails, video must still work for hand tracking.
- If `getUserMedia` fails for audio, we retry with video-only (so hand tracking still works) and log that mic was unavailable.

## Architecture

### Components

```
┌─────────────────────────┐
│  HandTracker            │ owns getUserMedia stream (video + audio)
│  - getVideo(): video el │ video element used for hand detection
│  - getStream(): stream  │ exposes MediaStream for WebRTC reuse
└──────┬──────────────────┘
       │
       ├─────────────── used as RTCPeerConnection.addTrack source
       │
┌──────▼──────────────────┐         ┌──────────────────────────┐
│  WebRTCClient           │◄───────►│  MultiplayerClient       │
│  - peerConnection       │ signals │  - sendSignal(...)       │
│  - localStream getter   │         │  - onSignal(listener)    │
│  - onRemoteStream(cb)   │         │  - consumeSignal(id)     │
│  - dispose()            │         │  - getPartnerIdentity()  │
└──────┬──────────────────┘         └──────────┬───────────────┘
       │                                       │
       │ remote MediaStream                    │ subscribes to webrtc_signal
       │                                       │ rows where recipientId == us
       ▼                                       ▼
┌─────────────────────────┐       ┌──────────────────────────────┐
│  VideoPanel(remote)     │       │  SpacetimeDB                 │
│  - srcObject = stream   │       │  - webrtc_signal table       │
│  - audio enabled        │       │  - send_webrtc_signal        │
└─────────────────────────┘       │  - consume_webrtc_signal     │
                                  └──────────────────────────────┘
┌─────────────────────────┐
│  VideoPanel(local)      │ binds to handTracker.getVideo().srcObject
│  - landmark overlay     │ existing CameraDebug logic
│  - audio muted          │ (it's our own audio, no echo)
└─────────────────────────┘
```

### File changes

New files:
- `src/game/webrtc.ts` — `WebRTCClient` class.

Renamed:
- `src/hud/components/CameraDebug.ts` → `src/hud/components/VideoPanel.ts` — generalized to `mode: 'local' | 'remote'`.

Modified:
- `spacetimedb/src/index.ts` — add `webrtc_signal` table, `send_webrtc_signal` reducer, `consume_webrtc_signal` reducer, extend `on_disconnect` to clean up signal rows.
- `src/module_bindings/*` — regenerated bindings.
- `src/game/multiplayer.ts` — partner identity tracking, signal subscription/dispatch, send/consume helpers.
- `src/game/handTracking.ts` — `getUserMedia({ audio: true, video: ... })` with audio-fallback to video-only; expose `getStream()`.
- `src/game/Game.ts` — own a `WebRTCClient`, expose `onRemoteStream(listener)`.
- `src/hud/Hud.ts` — comment out `EngineRoomDrawer` instantiation; mount local + remote `VideoPanel`s; swap-by-seat.
- `src/hud/style.css` — `.video-panel.left` / `.video-panel.right` corner positioning.
- `src/main.ts` — wire `game.onRemoteStream` → `hud.setRemoteStream`; remove the standalone dev-toggled `CameraDebug` mount (now permanently shown via Hud); drop the `DevOverlay` `onToggle` callback (it was only used to show/hide the dev camera debug).

Untouched (stay reachable for later):
- `src/hud/components/EngineRoomDrawer.ts` — file kept; just not instantiated.
- `src/hud/DevOverlay.ts` — stays for the remaining tweakpane controls.

## Data flow

### Boot

1. User clicks Begin → `game.startCamera()` → `getUserMedia({ video, audio })`.
   - On success: HandTracker has a stream with both tracks.
   - On audio-denied: retry with `{ video, audio: false }`. Hand tracking proceeds; WebRTC will send video only and log the mic absence.
   - On video-denied: hand tracking falls back to simulated, WebRTC never starts (no stream). Existing simulated-hands flow stays intact.
2. `game.connectMultiplayer()` → `MultiplayerClient.connect()` (unchanged path).
3. After SpacetimeDB subscription is applied and partner identity is known, `WebRTCClient.maybeConnect()` runs.

### Negotiation

- **Initiator rule:** the player with `localSeatIndex === 0` creates the offer; seat 1 is passive. Deterministic, avoids glare.
- Initiator: `pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })`, `addTrack` for each track in local stream, `createOffer` → `setLocalDescription` → `send_webrtc_signal('offer', sdp)`.
- Each ICE candidate that fires before remote answer is queued and flushed once remote description is set; after that they go straight through `send_webrtc_signal('ice', candidate)`.
- Answerer: receives offer via subscription → `setRemoteDescription` → `addTrack` for local tracks → `createAnswer` → `setLocalDescription` → `send_webrtc_signal('answer', sdp)`.
- Both: receive ICE candidates via subscription, `addIceCandidate` (or queue if remote description not set yet).
- After consuming each signal row, call `consume_webrtc_signal(id)` to delete it.

### Lifecycle

- **Partner change:** when `MultiplayerClient.onPartnerChange` fires with a new identity (or null), tear down the existing `RTCPeerConnection`, then re-run `maybeConnect()` if there's a new partner.
- **Local disconnect:** `WebRTCClient.dispose()` closes the peer connection, stops senders. Tracks themselves are owned by HandTracker and stopped by it.
- **Server-side cleanup:** `on_disconnect` in `spacetimedb/src/index.ts` deletes any `webrtc_signal` rows where the disconnecting client is sender or recipient, so a reconnect doesn't replay stale offers.

## SpacetimeDB schema

```ts
const webrtcSignal = table(
  {
    name: 'webrtc_signal',
    public: true,
    indexes: [
      { accessor: 'webrtc_signal_recipient', name: 'webrtc_signal_recipient',
        algorithm: 'btree', columns: ['recipientId'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.string(),
    senderId: t.identity(),
    recipientId: t.identity(),
    kind: t.string(),       // 'offer' | 'answer' | 'ice'
    payload: t.string(),    // JSON-encoded SDP or RTCIceCandidateInit
    createdAt: t.timestamp(),
  }
);
```

Reducers:

- `send_webrtc_signal({ recipientId, kind, payload })`:
  - Looks up sender's `player.roomId`. If missing, throws `SenderError`.
  - Validates `payload.length <= 16000` (SDPs are ~3-4KB; ICE candidates are tiny).
  - Validates `kind` ∈ {'offer', 'answer', 'ice'}.
  - Inserts row.
- `consume_webrtc_signal({ id })`:
  - Loads row; if `row.recipientId !== ctx.sender`, throws (don't allow others to delete).
  - Deletes the row.

`on_disconnect` extension: iterate `webrtc_signal` and delete rows where `senderId === ctx.sender` or `recipientId === ctx.sender`.

Subscription: client adds `tables.webrtcSignal` to its existing subscription builder so signal rows arrive via the same mechanism as `player` and `hand_state`.

## VideoPanel component

Generalized from `CameraDebug`:

```ts
class VideoPanel {
  constructor(parent: HTMLElement, opts: {
    side: 'left' | 'right';
    mode: 'local' | 'remote';
  });
  setHandTracker(tracker: HandTracker): void;       // local mode only
  setStream(stream: MediaStream | null): void;      // remote mode
  setSide(side: 'left' | 'right'): void;            // for seat swaps
  dispose(): void;
}
```

- `local`: video muted, draws landmark overlay (existing CameraDebug logic), reads stream from `handTracker.getVideo().srcObject`.
- `remote`: video unmuted (this is the partner's voice), no overlay. Shows a "waiting for partner" placeholder when `stream` is null.

Both use the same CSS class `.video-panel` with `.left` / `.right` modifier. Approximate size: 320px wide, 16:9, bottom corner with 24px inset.

The existing standalone dev-only `CameraDebug` mount in `main.ts` is removed; the local panel is now permanent.

## HUD wiring

In `Hud`:

```ts
private localPanel: VideoPanel;
private remotePanel: VideoPanel;

setLocalSeat(seat: number) {
  this.localSeat = seat;
  this.applyPlaques();          // existing
  this.localPanel.setSide(seat === 0 ? 'left' : 'right');
  this.remotePanel.setSide(seat === 0 ? 'right' : 'left');
}

setRemoteStream(stream: MediaStream | null) {
  this.remotePanel.setStream(stream);
}
```

`EngineRoomDrawer` instantiation block is wrapped in `/* ... */` with a one-line note. The `setInputStatus` / `setMusicStatus` / `setConnection` methods short-circuit (still callable; they just no-op until the drawer comes back).

## Logging requirements

Every WebRTC failure path produces a console message tagged `[webrtc]` so we can grep. Format: `[webrtc] <stage>: <reason>` plus structured detail.

Stages and what we log:

- **getUserMedia audio:** if audio rejection, `console.warn('[webrtc] mic unavailable, retrying video-only', error.name, error.message)`.
- **getUserMedia video:** existing path already logs; add `[webrtc] camera unavailable; webrtc disabled` once HandTracker reports failure.
- **Browser feature check:** if `RTCPeerConnection` undefined, `console.warn('[webrtc] RTCPeerConnection not supported in this browser')` and never start.
- **Initiator decision:** `console.info('[webrtc] role: offerer | answerer | waiting (no partner identity)')`.
- **createOffer / createAnswer / setLocalDescription / setRemoteDescription / addIceCandidate:** wrap each in `try/catch`; log `console.error('[webrtc] <op> failed', error)` and abort the current negotiation (don't crash).
- **Signaling reducer call failures:** `connection.reducers.sendWebrtcSignal(...).catch(err => console.warn('[webrtc] send_signal failed', { kind, error: err }))`. The peer connection retries via ICE; we don't queue at the SpacetimeDB layer.
- **Subscription delivery:** when a signal row arrives, log `console.debug('[webrtc] recv', kind, 'from', senderShortId)`. When parsing payload fails, `console.warn('[webrtc] malformed payload', kind, error)`.
- **PeerConnection state changes:**
  - `pc.oniceconnectionstatechange` → `console.info('[webrtc] iceConnectionState', pc.iceConnectionState)`
  - `pc.onconnectionstatechange` → `console.info('[webrtc] connectionState', pc.connectionState)`
  - On `'failed'`: `console.error('[webrtc] connection failed; common cause is symmetric NAT (no TURN configured)')`.
- **Track event:** `console.info('[webrtc] received remote track', track.kind, track.id)`.
- **Teardown:** `console.info('[webrtc] tearing down peer connection (reason: <partner-change | dispose | failure>)')`.
- **Disposal errors:** swallow but log: `console.warn('[webrtc] error during dispose', error)`.

## Failure isolation testing checklist

- Browser without camera/mic permission: hand tracking falls back to simulated; HUD loads; no uncaught errors.
- Mic denied, camera allowed: hand tracking works; WebRTC sends video only; remote panel still shows partner if partner allowed both.
- Browser blocks RTCPeerConnection (Brave shields, etc.): warn logged; rest of game functional.
- Partner connects then disconnects: peer connection torn down; local game continues; remote panel shows placeholder.
- Network glitches dropping ICE: `iceConnectionState` flips to `disconnected`/`failed`; logged; game continues; reconnect attempt happens on next partner-change cycle.

## Open questions

None blocking. TURN can be added later by switching `iceServers` config; placement is one line.
