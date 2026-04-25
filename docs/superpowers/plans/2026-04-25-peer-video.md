# Peer Video & Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two players in the same JamTrain cabin see and hear each other via WebRTC, with SpacetimeDB carrying offer/answer/ICE signaling. The local player's video keeps the existing landmark overlay; the remote video is shown raw. Engine Room drawer is hidden.

**Architecture:** New `webrtc_signal` table + two reducers in SpacetimeDB. Client adds a `WebRTCClient` that wraps `RTCPeerConnection`, reuses the existing `getUserMedia` stream from `HandTracker` (extended to also capture audio with a video-only fallback), and is mounted by `Game`. The Hud renders two `VideoPanel` instances (generalized from `CameraDebug`), swapped left/right based on local seat. Every WebRTC failure path is `try`/`catch`-isolated and logged with a `[webrtc]` tag — the rest of the game stays alive.

**Tech Stack:** TypeScript, Vite, SpacetimeDB v2.1, native browser `RTCPeerConnection`, Three.js (untouched), `@svenflow/micro-handpose` (untouched).

**No test runner is configured in this repo.** Verification is `npm run build` (which runs `tsc --noEmit && vite build`) plus manual browser checks. Steps include explicit checkpoints for both.

---

## Task 1: Add `webrtc_signal` table & reducers in the SpacetimeDB module

**Files:**
- Modify: `spacetimedb/src/index.ts`

- [ ] **Step 1: Add the table definition**

Open `spacetimedb/src/index.ts`. After the `handState` table block, add:

```ts
const webrtcSignal = table(
  {
    name: 'webrtc_signal',
    public: true,
    indexes: [
      {
        accessor: 'webrtc_signal_recipient',
        name: 'webrtc_signal_recipient',
        algorithm: 'btree',
        columns: ['recipientId'],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.string(),
    senderId: t.identity(),
    recipientId: t.identity(),
    kind: t.string(),
    payload: t.string(),
    createdAt: t.timestamp(),
  }
);
```

Add `webrtcSignal` to the `schema({ ... })` call so it becomes:

```ts
const spacetimedb = schema({
  player,
  handState,
  webrtcSignal,
});
```

- [ ] **Step 2: Add `send_webrtc_signal` reducer**

Append after the existing `update_pose` reducer:

```ts
const ALLOWED_SIGNAL_KINDS = new Set(['offer', 'answer', 'ice']);

export const send_webrtc_signal = spacetimedb.reducer(
  {
    recipientId: t.identity(),
    kind: t.string(),
    payload: t.string(),
  },
  (ctx, { recipientId, kind, payload }) => {
    if (!ALLOWED_SIGNAL_KINDS.has(kind)) {
      throw new SenderError(`invalid signal kind: ${kind}`);
    }
    if (payload.length > 16000) {
      throw new SenderError('signal payload too large');
    }

    const playerRow = ctx.db.player.identity.find(ctx.sender);
    if (!playerRow) throw new SenderError('sender has no player row');

    ctx.db.webrtcSignal.insert({
      id: 0n,
      roomId: playerRow.roomId,
      senderId: ctx.sender,
      recipientId,
      kind,
      payload,
      createdAt: ctx.timestamp,
    });
  }
);
```

- [ ] **Step 3: Add `consume_webrtc_signal` reducer**

```ts
export const consume_webrtc_signal = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    const row = ctx.db.webrtcSignal.id.find(id);
    if (!row) return;
    if (!row.recipientId.isEqual(ctx.sender)) {
      throw new SenderError('not authorized to consume this signal');
    }
    ctx.db.webrtcSignal.id.delete(id);
  }
);
```

- [ ] **Step 4: Extend `on_disconnect` to clean up signals**

Replace the existing `on_disconnect` body:

```ts
export const on_disconnect = spacetimedb.clientDisconnected(ctx => {
  const playerRow = ctx.db.player.identity.find(ctx.sender);
  if (playerRow) {
    ctx.db.player.identity.update({
      ...playerRow,
      online: false,
      updatedAt: ctx.timestamp,
    });
  }

  for (const row of ctx.db.webrtcSignal.iter()) {
    if (row.senderId.isEqual(ctx.sender) || row.recipientId.isEqual(ctx.sender)) {
      ctx.db.webrtcSignal.id.delete(row.id);
    }
  }
});
```

- [ ] **Step 5: Commit**

```bash
git add spacetimedb/src/index.ts
git commit -m "feat(spacetime): add webrtc_signal table + send/consume reducers"
```

---

## Task 2: Publish module & regenerate TypeScript bindings

**Files:**
- Modify: `src/module_bindings/**` (auto-generated)

- [ ] **Step 1: Publish to maincloud**

```bash
npm run spacetime:publish
```

Expected: `spacetime publish ... -y && npm run spacetime:generate` finishes without error and writes new files under `src/module_bindings/`. New files should include `send_webrtc_signal_reducer.ts`, `consume_webrtc_signal_reducer.ts`, `webrtc_signal_table.ts`. The `index.ts` adds entries for the new reducers and table.

- [ ] **Step 2: Sanity-check the generated bindings**

```bash
ls src/module_bindings/ | grep webrtc
```

Expected output includes `send_webrtc_signal_reducer.ts`, `consume_webrtc_signal_reducer.ts`, `webrtc_signal_table.ts`.

```bash
grep -E "webrtcSignal|sendWebrtcSignal|consumeWebrtcSignal" src/module_bindings/index.ts
```

Expected: matches showing the camelCase reducer names + `webrtcSignal` table entry.

- [ ] **Step 3: Confirm types compile**

```bash
npx tsc --noEmit
```

Expected: no errors. (Existing TS state should already be clean.)

- [ ] **Step 4: Commit**

```bash
git add src/module_bindings spacetimedb/dist
git commit -m "chore(bindings): regenerate after webrtc_signal addition"
```

---

## Task 3: HandTracker captures audio + exposes the stream

**Files:**
- Modify: `src/game/handTracking.ts`

- [ ] **Step 1: Capture audio alongside video, with audio fallback**

Replace the body of `startCamera()` so it requests audio and degrades to video-only if the mic prompt fails:

```ts
async startCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    this.mode = 'error';
    this.status = 'hands: no camera';
    this.publishStatus();
    return;
  }

  const baseConstraints: MediaStreamConstraints = {
    video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
    audio: true,
  };

  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia(baseConstraints);
  } catch (err) {
    console.warn('[webrtc] mic+camera request failed; retrying video-only',
      (err as Error)?.name, (err as Error)?.message);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        ...baseConstraints,
        audio: false,
      });
      console.warn('[webrtc] mic unavailable; webrtc will be video-only');
    } catch (err2) {
      console.warn('[webrtc] camera unavailable; webrtc disabled', err2);
      this.mode = 'error';
      this.status = 'hands: simulated';
      this.publishStatus();
      return;
    }
  }

  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    video.style.display = 'none';
    document.body.appendChild(video);
    await video.play();

    const { createHandpose } = await import('@svenflow/micro-handpose');
    this.detector = await createHandpose({ maxHands: 2, scoreThreshold: 0.45 });
    this.video = video;
    this.mode = 'camera';
    this.status = 'hands: camera';
    this.publishStatus();
  } catch (error) {
    console.warn('Hand tracking fell back to simulation', error);
    this.mode = 'error';
    this.status = 'hands: simulated';
    this.publishStatus();
  }
}
```

- [ ] **Step 2: Add `getStream()` accessor**

Just below the existing `getVideo()` method:

```ts
getStream(): MediaStream | undefined {
  const src = this.video?.srcObject;
  return src instanceof MediaStream ? src : undefined;
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/game/handTracking.ts
git commit -m "feat(handtracking): capture audio + expose MediaStream for webrtc"
```

---

## Task 4: MultiplayerClient — partner identity, signal pump, reducer helpers

**Files:**
- Modify: `src/game/multiplayer.ts`

- [ ] **Step 1: Import the generated signal type**

At the top of the file, change the type import to include `WebrtcSignal`:

```ts
import type { HandState, Player, WebrtcSignal } from '../module_bindings/types';
```

(If the generated type name differs — check `src/module_bindings/types.ts` after Task 2 — use the actual exported name.)

- [ ] **Step 2: Add listener types and partner-identity tracking**

Below the existing listener type aliases, add:

```ts
type SignalListener = (signal: { id: bigint; senderId: string; kind: string; payload: string }) => void;
type PartnerIdentityListener = (identityHex: string | null) => void;
```

Add private state at the bottom of the class field list:

```ts
private signalListeners = new Set<SignalListener>();
private partnerIdentityListeners = new Set<PartnerIdentityListener>();
private partnerIdentityHex: string | null = null;
```

- [ ] **Step 3: Add public subscribe/send/consume methods**

Add these public methods next to the existing `onPartnerChange` etc.:

```ts
onSignal(listener: SignalListener): void {
  this.signalListeners.add(listener);
}

onPartnerIdentity(listener: PartnerIdentityListener): void {
  this.partnerIdentityListeners.add(listener);
  listener(this.partnerIdentityHex);
}

getPartnerIdentity(): string | null {
  return this.partnerIdentityHex;
}

async sendWebrtcSignal(recipientHex: string, kind: string, payload: string): Promise<void> {
  if (!this.connection?.isActive) {
    console.warn('[webrtc] send_signal skipped: spacetime not connected');
    return;
  }
  try {
    const { Identity } = await import('spacetimedb');
    await this.connection.reducers.sendWebrtcSignal({
      recipientId: Identity.fromString(recipientHex),
      kind,
      payload,
    });
  } catch (err) {
    console.warn('[webrtc] send_signal failed', { kind, error: err });
  }
}

async consumeWebrtcSignal(id: bigint): Promise<void> {
  if (!this.connection?.isActive) return;
  try {
    await this.connection.reducers.consumeWebrtcSignal({ id });
  } catch (err) {
    console.warn('[webrtc] consume_signal failed', { id: id.toString(), error: err });
  }
}
```

- [ ] **Step 4: Subscribe to the new table and dispatch arriving signals**

In `registerSpacetimeHandlers`, find the `subscriptionBuilder().subscribe([tables.handState, tables.player])` call and replace with:

```ts
.subscribe([tables.handState, tables.player, tables.webrtcSignal]);
```

In the same method, add row handlers (place them next to the `handState` and `player` handlers):

```ts
conn.db.webrtcSignal.onInsert((_ctx, row) => this.acceptSignal(row));
conn.db.webrtcSignal.onUpdate((_ctx, _oldRow, row) => this.acceptSignal(row));
```

- [ ] **Step 5: Implement `acceptSignal`**

Add private method:

```ts
private acceptSignal(row: WebrtcSignal): void {
  const recipientHex = row.recipientId.toHexString();
  if (recipientHex !== this.localId) return;
  if (row.roomId !== this.roomId) return;
  const senderHex = row.senderId.toHexString();
  console.debug('[webrtc] recv', row.kind, 'from', senderHex.slice(0, 10));
  for (const listener of this.signalListeners) {
    listener({
      id: row.id,
      senderId: senderHex,
      kind: row.kind,
      payload: row.payload,
    });
  }
}
```

- [ ] **Step 6: Track partner identity changes**

Modify `updatePartner()` to also publish identity. Replace its body with:

```ts
private updatePartner(): void {
  let nextName: string | null = null;
  let nextIdentity: string | null = null;
  if (this.connection) {
    for (const row of this.connection.db.player.iter()) {
      const id = row.identity.toHexString();
      if (id === this.localId) continue;
      if (row.roomId !== this.roomId) continue;
      if (!row.online) continue;
      nextName = row.displayName || 'Player';
      nextIdentity = id;
      break;
    }
  }

  if (nextIdentity !== this.partnerIdentityHex) {
    this.partnerIdentityHex = nextIdentity;
    for (const listener of this.partnerIdentityListeners) listener(nextIdentity);
  }

  if (nextName === this.partnerName) return;
  this.partnerName = nextName;
  console.info('[jam-train] partner change ->', nextName);
  for (const listener of this.partnerListeners) listener(nextName);
}
```

- [ ] **Step 7: Reset partner identity on disconnect**

In `onDisconnect` handler within `connect()`, after the existing partner-name reset logic, add:

```ts
if (this.partnerIdentityHex !== null) {
  this.partnerIdentityHex = null;
  for (const listener of this.partnerIdentityListeners) listener(null);
}
```

- [ ] **Step 8: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/game/multiplayer.ts
git commit -m "feat(multiplayer): partner identity tracking + webrtc signal pump"
```

---

## Task 5: Create `WebRTCClient`

**Files:**
- Create: `src/game/webrtc.ts`

- [ ] **Step 1: Write the file**

```ts
import type { MultiplayerClient } from './multiplayer';

type RemoteStreamListener = (stream: MediaStream | null) => void;
type StreamProvider = () => MediaStream | undefined;
type SeatProvider = () => number;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export class WebRTCClient {
  private pc?: RTCPeerConnection;
  private remoteStream?: MediaStream;
  private remoteListeners = new Set<RemoteStreamListener>();
  private partnerIdentity: string | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private signalUnsubscribe?: () => void;
  private disposed = false;

  constructor(
    private multiplayer: MultiplayerClient,
    private getLocalStream: StreamProvider,
    private getLocalSeat: SeatProvider
  ) {
    if (typeof RTCPeerConnection === 'undefined') {
      console.warn('[webrtc] RTCPeerConnection not supported in this browser');
      return;
    }

    multiplayer.onPartnerIdentity(identity => {
      this.partnerIdentity = identity;
      this.handlePartnerChange();
    });

    multiplayer.onSignal(signal => {
      void this.handleSignal(signal);
    });
  }

  onRemoteStream(listener: RemoteStreamListener): void {
    this.remoteListeners.add(listener);
    listener(this.remoteStream ?? null);
  }

  /** Called by Game when the local stream becomes available. */
  notifyLocalStreamReady(): void {
    if (this.partnerIdentity && !this.pc) this.maybeStartNegotiation();
  }

  dispose(): void {
    this.disposed = true;
    console.info('[webrtc] tearing down peer connection (reason: dispose)');
    this.teardownPeer();
  }

  private handlePartnerChange(): void {
    if (!this.partnerIdentity) {
      console.info('[webrtc] partner left; tearing down peer connection');
      this.teardownPeer();
      return;
    }
    if (this.pc) {
      console.info('[webrtc] partner changed; resetting peer connection');
      this.teardownPeer();
    }
    this.maybeStartNegotiation();
  }

  private maybeStartNegotiation(): void {
    if (this.disposed) return;
    if (!this.partnerIdentity) {
      console.info('[webrtc] role: waiting (no partner identity)');
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') return;

    const isOfferer = this.getLocalSeat() === 0;
    console.info('[webrtc] role:', isOfferer ? 'offerer' : 'answerer');

    this.pc = this.createPeerConnection();
    if (!this.pc) return;

    if (!this.attachLocalTracks(this.pc)) {
      console.warn('[webrtc] no local stream yet; deferring negotiation');
      this.teardownPeer();
      return;
    }

    if (isOfferer) {
      void this.createAndSendOffer();
    }
  }

  private createPeerConnection(): RTCPeerConnection | undefined {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (err) {
      console.error('[webrtc] failed to construct RTCPeerConnection', err);
      return undefined;
    }

    pc.ontrack = event => {
      const [stream] = event.streams;
      if (!stream) return;
      console.info('[webrtc] received remote track', event.track.kind, event.track.id);
      this.remoteStream = stream;
      for (const listener of this.remoteListeners) listener(stream);
    };

    pc.onicecandidate = event => {
      if (!event.candidate || !this.partnerIdentity) return;
      void this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'ice',
        JSON.stringify(event.candidate.toJSON())
      );
    };

    pc.oniceconnectionstatechange = () => {
      console.info('[webrtc] iceConnectionState', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.error('[webrtc] connection failed; common cause is symmetric NAT (no TURN configured)');
      }
    };

    pc.onconnectionstatechange = () => {
      console.info('[webrtc] connectionState', pc.connectionState);
    };

    return pc;
  }

  private attachLocalTracks(pc: RTCPeerConnection): boolean {
    const stream = this.getLocalStream();
    if (!stream) return false;
    for (const track of stream.getTracks()) {
      try {
        pc.addTrack(track, stream);
      } catch (err) {
        console.warn('[webrtc] addTrack failed', track.kind, err);
      }
    }
    return true;
  }

  private async createAndSendOffer(): Promise<void> {
    if (!this.pc || !this.partnerIdentity) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'offer',
        JSON.stringify(offer)
      );
    } catch (err) {
      console.error('[webrtc] createOffer/setLocalDescription failed', err);
      this.teardownPeer();
    }
  }

  private async handleSignal(signal: {
    id: bigint;
    senderId: string;
    kind: string;
    payload: string;
  }): Promise<void> {
    if (this.disposed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(signal.payload);
    } catch (err) {
      console.warn('[webrtc] malformed payload', signal.kind, err);
      await this.multiplayer.consumeWebrtcSignal(signal.id);
      return;
    }

    try {
      if (signal.kind === 'offer') {
        await this.handleOffer(parsed as RTCSessionDescriptionInit);
      } else if (signal.kind === 'answer') {
        await this.handleAnswer(parsed as RTCSessionDescriptionInit);
      } else if (signal.kind === 'ice') {
        await this.handleIce(parsed as RTCIceCandidateInit);
      } else {
        console.warn('[webrtc] unknown signal kind', signal.kind);
      }
    } catch (err) {
      console.error('[webrtc] handleSignal', signal.kind, 'failed', err);
    } finally {
      await this.multiplayer.consumeWebrtcSignal(signal.id);
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) {
      this.pc = this.createPeerConnection();
      if (!this.pc) return;
      this.attachLocalTracks(this.pc);
    }
    await this.pc.setRemoteDescription(offer);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (this.partnerIdentity) {
      await this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'answer',
        JSON.stringify(answer)
      );
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
  }

  private async handleIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingIceCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('[webrtc] addIceCandidate failed', err);
    }
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc) return;
    const queued = this.pendingIceCandidates;
    this.pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[webrtc] queued addIceCandidate failed', err);
      }
    }
  }

  private teardownPeer(): void {
    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch (err) {
        console.warn('[webrtc] error during dispose', err);
      }
      this.pc = undefined;
    }
    this.remoteDescriptionSet = false;
    this.pendingIceCandidates = [];
    if (this.remoteStream) {
      this.remoteStream = undefined;
      for (const listener of this.remoteListeners) listener(null);
    }
  }
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. (Note: `WebRTCClient` is not yet wired into `Game`; it just needs to compile.)

- [ ] **Step 3: Commit**

```bash
git add src/game/webrtc.ts
git commit -m "feat(webrtc): peer connection client with isolated failure paths"
```

---

## Task 6: Generalize `CameraDebug` → `VideoPanel`

**Files:**
- Create: `src/hud/components/VideoPanel.ts`
- Delete: `src/hud/components/CameraDebug.ts`

- [ ] **Step 1: Write `VideoPanel.ts`**

```ts
import type { HandTracker } from '../../game/handTracking';
import type { Handedness } from '../../game/types';

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const COLORS: Record<Handedness, { stroke: string; fill: string; label: string }> = {
  left:  { stroke: '#52e2ff', fill: '#aef0ff', label: 'L' },
  right: { stroke: '#ff7ad6', fill: '#ffd2ec', label: 'R' },
};

type VideoPanelMode = 'local' | 'remote';
type VideoPanelSide = 'left' | 'right';

export class VideoPanel {
  private wrapper: HTMLDivElement;
  private video: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private label: HTMLDivElement;
  private rafHandle = 0;
  private streamBound = false;
  private handTracker?: HandTracker;
  private mode: VideoPanelMode;

  constructor(parent: HTMLElement, opts: { side: VideoPanelSide; mode: VideoPanelMode }) {
    this.mode = opts.mode;

    this.wrapper = document.createElement('div');
    this.wrapper.className = `video-panel ${opts.side} mode-${opts.mode}`;

    this.video = document.createElement('video');
    this.video.muted = opts.mode === 'local';
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.wrapper.appendChild(this.video);

    if (opts.mode === 'local') {
      this.canvas = document.createElement('canvas');
      this.wrapper.appendChild(this.canvas);
      const ctx = this.canvas.getContext('2d');
      if (!ctx) throw new Error('VideoPanel: 2d context unavailable');
      this.ctx = ctx;
    }

    this.label = document.createElement('div');
    this.label.className = 'video-panel-label';
    this.label.textContent = opts.mode === 'local' ? 'you · waiting' : 'partner · waiting';
    this.wrapper.appendChild(this.label);

    parent.appendChild(this.wrapper);
  }

  setHandTracker(tracker: HandTracker): void {
    if (this.mode !== 'local') return;
    this.handTracker = tracker;
    this.tickLocal();
  }

  setStream(stream: MediaStream | null): void {
    if (this.mode !== 'remote') return;
    this.video.srcObject = stream;
    if (stream) {
      void this.video.play().catch(err => console.warn('[webrtc] remote video play failed', err));
      this.label.textContent = 'partner · live';
    } else {
      this.label.textContent = 'partner · waiting';
    }
  }

  setSide(side: VideoPanelSide): void {
    this.wrapper.classList.remove('left', 'right');
    this.wrapper.classList.add(side);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.video.srcObject = null;
    this.wrapper.remove();
  }

  private tickLocal = (): void => {
    if (this.mode !== 'local') return;
    this.bindLocalStream();
    this.draw();
    this.rafHandle = requestAnimationFrame(this.tickLocal);
  };

  private bindLocalStream(): void {
    if (this.streamBound) return;
    const source = this.handTracker?.getVideo();
    if (!source?.srcObject) return;
    this.video.srcObject = source.srcObject;
    void this.video.play().catch(() => {});
    this.streamBound = true;
  }

  private draw(): void {
    if (!this.ctx || !this.canvas || !this.handTracker) return;

    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) {
      this.label.textContent = 'you · no signal';
      return;
    }

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const detections = this.handTracker.getDetections();
    if (detections.length === 0) {
      this.label.textContent = 'you · 0 hands';
      return;
    }

    for (const det of detections) {
      const color = COLORS[det.handedness];
      ctx.strokeStyle = color.stroke;
      ctx.fillStyle = color.fill;
      ctx.lineWidth = Math.max(2, Math.round(w / 320));

      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = det.landmarks[a];
        const pb = det.landmarks[b];
        if (!pa || !pb) continue;
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
      }
      ctx.stroke();

      const radius = Math.max(3, Math.round(w / 220));
      for (const lm of det.landmarks) {
        ctx.beginPath();
        ctx.arc(lm.x * w, lm.y * h, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      const wrist = det.landmarks[0];
      if (wrist) {
        ctx.font = `${Math.round(w / 24)}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = color.stroke;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        const text = `${color.label} ${(det.score * 100).toFixed(0)}%`;
        const tx = wrist.x * w + 12;
        const ty = wrist.y * h - 8;
        ctx.strokeText(text, tx, ty);
        ctx.fillText(text, tx, ty);
      }
    }

    const counts = detections.reduce(
      (acc, d) => ((acc[d.handedness] = (acc[d.handedness] ?? 0) + 1), acc),
      {} as Record<Handedness, number>
    );
    this.label.textContent = `you · L:${counts.left ?? 0} R:${counts.right ?? 0}`;
  }
}
```

- [ ] **Step 2: Delete the old CameraDebug file**

```bash
git rm src/hud/components/CameraDebug.ts
```

- [ ] **Step 3: Type-check**

(There will still be one expected error: `main.ts` imports `CameraDebug`. We fix that in Task 9.)

```bash
npx tsc --noEmit
```

Expected: errors only in `src/main.ts` related to missing `CameraDebug` import; no other errors.

- [ ] **Step 4: Commit**

```bash
git add src/hud/components/VideoPanel.ts
git commit -m "feat(hud): VideoPanel component (replaces CameraDebug)"
```

---

## Task 7: Hud — comment out drawer, mount video panels, swap by seat

**Files:**
- Modify: `src/hud/Hud.ts`

- [ ] **Step 1: Replace imports + add VideoPanel import**

At the top, change the imports block. Replace:

```ts
import { EngineRoomDrawer, type CameraMode } from './components/EngineRoomDrawer';
```

with:

```ts
import type { CameraMode } from './components/EngineRoomDrawer';
import { VideoPanel } from './components/VideoPanel';
import type { HandTracker } from '../game/handTracking';
```

- [ ] **Step 2: Replace drawer field with video panels**

Find the `private drawer: EngineRoomDrawer;` field and replace with:

```ts
private localPanel: VideoPanel;
private remotePanel: VideoPanel;
```

- [ ] **Step 3: Replace drawer instantiation in the constructor**

Locate the block beginning `this.drawer = new EngineRoomDrawer({` (around lines 103-110) and replace it with:

```ts
// Engine Room drawer is hidden for now while we surface peer-video panels.
// Keep the file around in case we want it back.
// this.drawer = new EngineRoomDrawer({
//   onRecalibrate: opts.callbacks.onRecalibrate,
//   onDisembark: opts.callbacks.onDisembark,
//   onCameraMode: opts.callbacks.onCameraMode,
// });
// this.uiEl.appendChild(this.drawer.el);

this.localPanel = new VideoPanel(stage, { side: 'left', mode: 'local' });
this.remotePanel = new VideoPanel(stage, { side: 'right', mode: 'remote' });
```

- [ ] **Step 4: Stub out the status setters that wrote to the drawer**

Replace the three setters and `setCameraMode` with no-op bodies (the public signature stays so callers don't break):

```ts
setInputStatus(text: string): void {
  // engine room drawer hidden; status routed to console for now
  void text;
}

setMusicStatus(text: string): void {
  void text;
}

setCameraMode(mode: CameraMode): void {
  void mode;
}
```

Also remove the `this.drawer.setRow(...)` line in `renderNetRow()`. Replace its body with:

```ts
private renderNetRow(): void {
  // Drawer hidden — net status currently un-surfaced. Logging only so the
  // information is still recoverable from devtools.
  const parts: string[] = [this.currentConnection];
  if (this.currentRoom) parts.push(this.currentRoom);
  if (this.currentConnection === 'spacetime') {
    parts.push(this.partnerPresent ? 'paired' : 'solo');
  }
  console.debug('[hud] net', parts.join(' · '));
}
```

- [ ] **Step 5: Add swap-by-seat logic**

Find `setLocalSeat(seatIndex: number)` and replace its body with:

```ts
setLocalSeat(seatIndex: number): void {
  const next = seatIndex === 1 ? 1 : 0;
  if (next === this.localSeat) return;
  this.localSeat = next;
  this.applyPlaques();
  this.localPanel.setSide(next === 0 ? 'left' : 'right');
  this.remotePanel.setSide(next === 0 ? 'right' : 'left');
}
```

- [ ] **Step 6: Add `setHandTracker` and `setRemoteStream` methods**

Add these methods next to the existing `setRoom`:

```ts
setHandTracker(tracker: HandTracker): void {
  this.localPanel.setHandTracker(tracker);
}

setRemoteStream(stream: MediaStream | null): void {
  this.remotePanel.setStream(stream);
}
```

- [ ] **Step 7: Update `dispose()`**

Replace its body with:

```ts
dispose(): void {
  window.removeEventListener('resize', this.resizeHandler);
  this.sharePopover.dispose();
  this.announcement.dispose();
  this.localPanel.dispose();
  this.remotePanel.dispose();
}
```

- [ ] **Step 8: Type-check (expecting main.ts errors still)**

```bash
npx tsc --noEmit
```

Expected: errors only in `src/main.ts` (CameraDebug import, missing methods). All Hud-internal errors should be gone.

- [ ] **Step 9: Commit**

```bash
git add src/hud/Hud.ts
git commit -m "feat(hud): mount peer video panels; hide engine room drawer"
```

---

## Task 8: CSS for `.video-panel`

**Files:**
- Modify: `src/hud/style.css`

- [ ] **Step 1: Replace the camera-debug rules with video-panel rules**

Find the `.camera-debug { ... }` block (around line 517) and replace the whole `.camera-debug` cluster (everything from `/* Camera debug — bottom-center ... */` down to and including `.camera-debug.hidden { display: none; }`) with:

```css
/* Peer video panels — bottom corners under each seat's plaque. */
.video-panel {
  position: absolute;
  bottom: 24px;
  width: 320px;
  aspect-ratio: 16 / 9;
  z-index: 10;
  border: 1px solid rgba(239, 224, 191, 0.35);
  border-radius: 6px;
  overflow: hidden;
  background: #000;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.video-panel.left  { left: 24px; }
.video-panel.right { right: 24px; }
.video-panel video,
.video-panel canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.video-panel video { object-fit: cover; }
.video-panel.mode-local video { transform: scaleX(-1); }
.video-panel.mode-local canvas { transform: scaleX(-1); }
.video-panel-label {
  position: absolute;
  left: 8px;
  bottom: 6px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--parchment);
  background: rgba(0, 0, 0, 0.55);
  padding: 2px 6px;
  border-radius: 3px;
  letter-spacing: 0.04em;
}
```

(Note: we mirror the local video horizontally so it reads like a webcam to the user. Hand landmarks are also mirrored so they line up.)

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: same errors as before (only main.ts).

- [ ] **Step 3: Commit**

```bash
git add src/hud/style.css
git commit -m "feat(hud): style peer video panels"
```

---

## Task 9: Game — own a `WebRTCClient`, expose remote-stream stream

**Files:**
- Modify: `src/game/Game.ts`

- [ ] **Step 1: Import WebRTCClient**

Add to imports near the top:

```ts
import { WebRTCClient } from './webrtc';
```

- [ ] **Step 2: Add fields and a remote-stream listener set**

Just below `private multiplayer: MultiplayerClient;`:

```ts
private webrtc: WebRTCClient;
private remoteStreamListeners = new Set<(stream: MediaStream | null) => void>();
```

- [ ] **Step 3: Construct WebRTCClient in the constructor**

After the line `this.multiplayer = new MultiplayerClient(urlRoom, 'Player');` (and before any other `this.multiplayer.onStateChange` etc.), add:

```ts
this.webrtc = new WebRTCClient(
  this.multiplayer,
  () => this.handTracker.getStream(),
  () => this.multiplayer.localSeatIndex
);
this.webrtc.onRemoteStream(stream => {
  for (const listener of this.remoteStreamListeners) listener(stream);
});
```

- [ ] **Step 4: Notify webrtc when local stream is ready**

Modify `startCamera()` to:

```ts
async startCamera(): Promise<void> {
  await this.handTracker.startCamera();
  this.webrtc.notifyLocalStreamReady();
}
```

- [ ] **Step 5: Add `onRemoteStream` accessor**

Place it next to the other `on*` accessors:

```ts
onRemoteStream(listener: (stream: MediaStream | null) => void): void {
  this.remoteStreamListeners.add(listener);
}
```

- [ ] **Step 6: Tear down webrtc in `dispose()`**

In `dispose()`, after `this.multiplayer.dispose();` add:

```ts
this.webrtc.dispose();
```

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit
```

Expected: errors should now be confined to `src/main.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/game/Game.ts
git commit -m "feat(game): wire WebRTCClient + expose remote stream"
```

---

## Task 10: main.ts — wire it all together, remove old camera debug

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Replace the imports**

Replace the import lines:

```ts
import { CameraDebug } from './hud/components/CameraDebug';
```

→ remove that line entirely. Leave `DevOverlay` import as-is.

- [ ] **Step 2: Hand the local stream to the HUD**

After the line `void game.start();` (or anywhere after `hud` is constructed), insert:

```ts
hud.setHandTracker(game.handTracker);
game.onRemoteStream(stream => {
  hud.setRemoteStream(stream);
});
```

- [ ] **Step 3: Remove the old standalone camera debug mount**

Find the block:

```ts
const cameraDebugMount = document.getElementById('stage') ?? document.body;
const cameraDebug = new CameraDebug(cameraDebugMount, game.handTracker);
const dev = new DevOverlay(game.paneDock, visible => cameraDebug.setVisible(visible));
```

Replace with:

```ts
const dev = new DevOverlay(game.paneDock);
```

- [ ] **Step 4: Remove the matching cleanup line**

In the `beforeunload` handler, delete the line `cameraDebug.dispose();`.

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors anywhere.

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: `tsc --noEmit` passes and Vite emits a bundle without errors.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): mount video panels via Hud; drop dev camera overlay"
```

---

## Task 11: Manual verification

**Files:** none (browser checks only).

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

Open the printed URL (likely `http://localhost:5173`).

- [ ] **Step 2: Single-tab solo check (graceful degradation baseline)**

In the first browser tab:
- Click Begin. Approve camera + microphone prompts.
- Verify the local video panel appears in a bottom corner with hand landmarks drawn on top, mirrored.
- Open devtools console. Look for `[webrtc]` lines:
  - `[webrtc] role: ...` should appear once a partner is detected (won't appear yet — solo).
  - No `[webrtc]` errors should appear.
- Verify the 3D scene still animates and the plasma orb responds to your hands.

- [ ] **Step 3: Two-tab pair check**

Open a second normal tab to the same URL (no need for incognito since `sessionStorage` is per-tab — different identities).
- Click Begin in tab 2 and approve camera + mic.
- Within ~5 seconds, both tabs should:
  - Show the partner's video in the opposite bottom corner.
  - Play partner audio (you'll hear yourself echo across tabs — expected).
  - Log `[webrtc] role: offerer` (seat-0 tab) and `[webrtc] role: answerer` (seat-1 tab).
  - Log `[webrtc] iceConnectionState connected` then `[webrtc] connectionState connected`.
  - Log `[webrtc] received remote track audio` and `[webrtc] received remote track video`.
- The partner plaque should still update (this is unchanged behaviour).

- [ ] **Step 4: Mic-denied fallback**

Close one tab. In a fresh tab, deny the mic prompt (or use a profile where mic is blocked).
- Click Begin. Console should log `[webrtc] mic+camera request failed; retrying video-only` and `[webrtc] mic unavailable; webrtc will be video-only`.
- Local video panel still shows your camera + landmarks.
- 3D scene still responds to hands.
- If a partner connects, video appears (video-only direction); no crash.

- [ ] **Step 5: Camera-denied fallback**

Deny the camera prompt entirely.
- Console logs `[webrtc] camera unavailable; webrtc disabled`.
- Hand tracking falls back to simulated (existing behavior).
- HUD loads, 3D scene renders, no uncaught errors.

- [ ] **Step 6: Partner-leave teardown**

With two tabs paired, close one tab.
- The remaining tab should log `[webrtc] partner left; tearing down peer connection`.
- Remote video panel reverts to "partner · waiting".
- Local game continues working.

- [ ] **Step 7: Final commit if any tweaks**

If you adjusted CSS or labels during manual checks, commit them now:

```bash
git status
# only if there are changes:
git add -A
git commit -m "chore(peer-video): manual-verification tweaks"
```

---

## Self-review notes

**Spec coverage:**
- ✅ Hide Engine Room drawer: Task 7 step 3 comments out the instantiation; file kept.
- ✅ Local video panel under one player with overlays: Task 6 + Task 7 + Task 8 + Task 10.
- ✅ Remote video panel under other player: same tasks.
- ✅ Audio capture + audio fallback: Task 3.
- ✅ WebRTC w/ STUN-only: Task 5.
- ✅ SpacetimeDB signaling: Tasks 1, 2, 4.
- ✅ Initiator = seat 0: Task 5 step 1.
- ✅ Failure isolation: Task 3, Task 5 (`try`/`catch` wrapping; reducer-call `try`/`catch`; ICE-state logs; teardown on failure).
- ✅ Diagnostic logging contract: every stage in spec is covered with `[webrtc] ...` log lines in Task 3 and Task 5.
- ✅ `on_disconnect` cleans up signal rows: Task 1 step 4.
- ✅ Partner identity tracking: Task 4 step 6.

**Type consistency:** All cross-task references resolve — `getStream` (Task 3) used in Task 9; `onPartnerIdentity` (Task 4) used in Task 5; `setRemoteStream` and `setHandTracker` (Task 7) used in Task 10; `WebrtcSignal` import name dependent on the regenerated bindings (Task 4 step 1 notes the verification).
