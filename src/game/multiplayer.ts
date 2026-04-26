import { Identity } from 'spacetimedb';
import { DbConnection, tables, type ErrorContext } from '../module_bindings';
import type { Player, WebrtcSignal } from '../module_bindings/types';
import { pickRandomRoomName, sanitizeRoomName } from './roomNames';
import type { ConnectionState } from './types';

type StateListener = (state: ConnectionState) => void;
type RoomListener = (roomId: string) => void;
type PlayerEventListener = (player: { id: string; displayName: string }) => void;
type PartnerListener = (name: string | null) => void;
type SeatListener = (localSeat: number, partnerSeat: number) => void;
type SignalListener = (signal: { id: bigint; senderId: string; kind: string; payload: string }) => void;
type PartnerIdentityListener = (identityHex: string | null) => void;
type InstrumentListener = (instrumentId: string) => void;

const SPACETIME_URI = 'wss://maincloud.spacetimedb.com';
const SPACETIME_DATABASE = 'jam-train';
const TOKEN_STORAGE_KEY = 'jam-train-spacetime-token';

export class MultiplayerClient {
  localId = `local-${crypto.randomUUID()}`;
  // Defaults to seat 0 until the server confirms an assignment. Partner seat
  // is always the opposite — we only have two seats per cabin.
  localSeatIndex = 0;
  partnerSeatIndex = 1;
  private connection?: DbConnection;
  private connectionState: ConnectionState = 'local';
  private stateListeners = new Set<StateListener>();
  private roomListeners = new Set<RoomListener>();
  private joinListeners = new Set<PlayerEventListener>();
  private leaveListeners = new Set<PlayerEventListener>();
  private partnerListeners = new Set<PartnerListener>();
  private seatListeners = new Set<SeatListener>();
  // Identities of every player we've ever seen in our current room. Survives
  // online/offline toggles — we only forget a player when they actually
  // change rooms or get fully deleted (explicit leave_room).
  private knownPlayers = new Map<string, string>();
  private partnerName: string | null = null;
  private partnerIdentityHex: string | null = null;
  private signalListeners = new Set<SignalListener>();
  private partnerIdentityListeners = new Set<PartnerIdentityListener>();
  private localInstrument: string = 'flute';
  private partnerInstrument: string = 'flute';
  private localInstrumentListeners = new Set<InstrumentListener>();
  private partnerInstrumentListeners = new Set<InstrumentListener>();
  private subscriptionApplied = false;
  private roomId: string;
  private displayName: string;
  // Empty string when the user landed without a URL room — signals the
  // server to auto-pair instead of creating a fresh empty room with our
  // randomly-picked display name.
  private bootPreferredRoom: string;
  private reconnectTimer = 0;
  private reconnectAttempts = 0;
  private disposed = false;

  constructor(urlRoom: string, displayName: string) {
    const sanitized = sanitizeRoomName(urlRoom);
    this.bootPreferredRoom = sanitized;
    this.roomId = sanitized || pickRandomRoomName();
    this.displayName = displayName;
  }

  onStateChange(listener: StateListener): void {
    this.stateListeners.add(listener);
    listener(this.connectionState);
  }

  onAssignedRoom(listener: RoomListener): void {
    // Fires only when the server confirms an assignment — not for the
    // cosmetic random name we used before connecting.
    this.roomListeners.add(listener);
  }

  onPlayerJoined(listener: PlayerEventListener): void {
    this.joinListeners.add(listener);
  }

  onPlayerLeft(listener: PlayerEventListener): void {
    this.leaveListeners.add(listener);
  }

  onPartnerChange(listener: PartnerListener): void {
    // Fires whenever the "partner present in our cabin and online" state
    // changes — independent of join/leave toasts. Also fires immediately
    // with the current value so the consumer can sync UI on subscribe.
    this.partnerListeners.add(listener);
    listener(this.partnerName);
  }

  onSeatChange(listener: SeatListener): void {
    this.seatListeners.add(listener);
    listener(this.localSeatIndex, this.partnerSeatIndex);
  }

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

  onLocalInstrumentChange(listener: InstrumentListener): void {
    this.localInstrumentListeners.add(listener);
    listener(this.localInstrument);
  }

  onPartnerInstrumentChange(listener: InstrumentListener): void {
    this.partnerInstrumentListeners.add(listener);
    listener(this.partnerInstrument);
  }

  getLocalInstrument(): string {
    return this.localInstrument;
  }

  getPartnerInstrument(): string {
    return this.partnerInstrument;
  }

  async setLocalInstrument(instrumentId: string): Promise<void> {
    if (this.localInstrument === instrumentId) return;
    this.localInstrument = instrumentId;
    for (const listener of this.localInstrumentListeners) listener(instrumentId);
    if (!this.connection?.isActive) return;
    try {
      await this.connection.reducers.updateInstrument({ instrument: instrumentId });
    } catch (err) {
      console.warn('[jam-train] update_instrument failed', err);
    }
  }

  async sendWebrtcSignal(recipientHex: string, kind: string, payload: string): Promise<void> {
    if (!this.connection?.isActive) {
      console.warn('[webrtc] send_signal skipped: spacetime not connected');
      return;
    }
    try {
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

  setDisplayName(displayName: string): void {
    const next = displayName.trim() || 'Player';
    if (next === this.displayName) return;
    this.displayName = next;
    if (this.connection?.isActive) {
      // Re-issue request_seat so the server picks up the new name.
      this.requestSeat(this.roomId);
    }
  }

  getRoom(): string {
    return this.roomId;
  }

  connect(): void {
    this.setState('connecting');

    try {
      this.connection = DbConnection.builder()
        .withUri(SPACETIME_URI)
        .withDatabaseName(SPACETIME_DATABASE)
        // sessionStorage is per-tab — different tabs get different identities
        // (so they show up as distinct players), but a reconnect within the
        // same tab reuses the token, so the partner sees a brief disconnect
        // rather than a player leaving and a different player arriving.
        .withToken(sessionStorage.getItem(TOKEN_STORAGE_KEY) || undefined)
        .onConnect((conn, identity, token) => {
          this.localId = identity.toHexString();
          sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
          const isReconnect = this.reconnectAttempts > 0;
          this.reconnectAttempts = 0;
          console.info('[jam-train] connected; identity', this.localId, isReconnect ? '(reconnect)' : '(initial)');
          this.registerSpacetimeHandlers(conn);
          // On reconnect, prefer rejoining the room we were last in so we
          // converge back on the same cabin. On the very first connect, use
          // the URL-derived preference (empty → server auto-pairs).
          this.requestSeat(isReconnect ? this.roomId : this.bootPreferredRoom);
          this.setState('spacetime');
        })
        .onConnectError((_ctx: ErrorContext, error: Error) => {
          console.warn('[jam-train] connect error', error);
          this.setState('local');
          this.scheduleReconnect();
        })
        .onDisconnect((_ctx: ErrorContext, error?: Error) => {
          console.warn('[jam-train] disconnected', error);
          this.subscriptionApplied = false;
          this.knownPlayers.clear();
          // Reset partner-name plaque while we're offline.
          if (this.partnerName !== null) {
            this.partnerName = null;
            for (const listener of this.partnerListeners) listener(null);
          }
          if (this.partnerIdentityHex !== null) {
            this.partnerIdentityHex = null;
            for (const listener of this.partnerIdentityListeners) listener(null);
          }
          if (this.partnerInstrument !== 'flute') {
            this.partnerInstrument = 'flute';
            for (const listener of this.partnerInstrumentListeners) listener('flute');
          }
          this.setState('local');
          this.scheduleReconnect();
        })
        .build();
    } catch (error) {
      console.warn('SpacetimeDB client failed to start; using local fallback', error);
      this.setState('local');
    }
  }

  /** Request a seat in `preferredRoom` (or auto-pair if empty). */
  requestRoom(preferredRoom: string): void {
    const sanitized = sanitizeRoomName(preferredRoom);
    if (this.connection?.isActive) {
      this.requestSeat(sanitized);
    } else if (sanitized) {
      this.setRoomId(sanitized);
    }
  }

  updateDisplayName(displayName: string): void {
    this.displayName = displayName;
  }

  getState(): ConnectionState {
    return this.connectionState;
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.reconnectTimer);
    if (this.connection?.isActive) {
      void this.connection.reducers.leaveRoom({}).finally(() => this.connection?.disconnect());
    } else {
      this.connection?.disconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    window.clearTimeout(this.reconnectTimer);
    const attempt = ++this.reconnectAttempts;
    const delayMs = Math.min(15000, 500 * Math.pow(1.6, Math.min(attempt, 8)));
    console.info('[jam-train] reconnecting in', Math.round(delayMs), 'ms (attempt', attempt + ')');
    this.reconnectTimer = window.setTimeout(() => {
      this.connection = undefined;
      this.connect();
    }, delayMs);
  }

  private requestSeat(preferredRoom: string): void {
    if (!this.connection?.isActive) return;
    void this.connection.reducers
      .requestSeat({
        preferredRoom: sanitizeRoomName(preferredRoom),
        fallbackName: pickRandomRoomName(this.roomId),
        displayName: this.displayName,
      })
      .catch(error => console.warn('SpacetimeDB request_seat failed', error));
  }

  private registerSpacetimeHandlers(conn: DbConnection): void {
    conn.db.player.onInsert((_ctx, row) => {
      this.acceptOwnPlayer(row);
      this.maybeAnnouncePlayer(row);
    });
    conn.db.player.onUpdate((_ctx, _oldRow, row) => {
      this.acceptOwnPlayer(row);
      this.maybeAnnouncePlayer(row);
    });
    conn.db.player.onDelete((_ctx, row) => {
      const id = row.identity.toHexString();
      const name = this.knownPlayers.get(id);
      this.knownPlayers.delete(id);
      if (id !== this.localId && name !== undefined) {
        for (const listener of this.leaveListeners) {
          listener({ id, displayName: name });
        }
      }
    });
    conn.db.webrtcSignal.onInsert((_ctx, row) => this.acceptSignal(row));
    conn.db.webrtcSignal.onUpdate((_ctx, _oldRow, row) => this.acceptSignal(row));
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        // Pass 1: figure out which room the server actually placed us in.
        for (const row of conn.db.player.iter()) {
          if (row.identity.toHexString() === this.localId) {
            this.setRoomId(row.roomId);
          }
        }
        // Pass 2: track who's already in the cabin (silent — no toasts;
        // subscriptionApplied is still false at this point).
        this.rebuildKnownPlayers();
        this.subscriptionApplied = true;
        // Now sync the partner plaque with whoever's actually online here.
        this.updatePartner();
        console.info('[jam-train] subscription applied; room', this.roomId, 'partners', this.knownPlayers.size);
      })
      .onError(ctx => {
        console.warn('SpacetimeDB subscription failed', ctx.event);
      })
      .subscribe([tables.player, tables.webrtcSignal]);
  }

  private maybeAnnouncePlayer(row: Player): void {
    const id = row.identity.toHexString();
    if (id === this.localId) {
      this.updatePartner();
      return;
    }

    const inOurRoom = row.roomId === this.roomId;
    const wasInOurRoom = this.knownPlayers.has(id);
    const name = row.displayName || 'Player';

    if (inOurRoom && !wasInOurRoom) {
      this.knownPlayers.set(id, name);
      // Players already present at subscription time are silently absorbed
      // — they were in the cabin before we boarded.
      if (this.subscriptionApplied) {
        console.info('[jam-train] player joined', id, name);
        for (const listener of this.joinListeners) {
          listener({ id, displayName: name });
        }
      }
    } else if (inOurRoom && wasInOurRoom) {
      // Same player still here — keep the name fresh in case they renamed.
      this.knownPlayers.set(id, name);
    } else if (!inOurRoom && wasInOurRoom) {
      // Real room move — they're gone from our cabin.
      this.knownPlayers.delete(id);
      for (const listener of this.leaveListeners) {
        listener({ id, displayName: name });
      }
    }

    this.updatePartner();
  }

  private rebuildKnownPlayers(): void {
    this.knownPlayers.clear();
    if (!this.connection) return;
    for (const row of this.connection.db.player.iter()) {
      const id = row.identity.toHexString();
      if (id !== this.localId && row.roomId === this.roomId) {
        this.knownPlayers.set(id, row.displayName || 'Player');
      }
    }
    this.updatePartner();
  }

  private updatePartner(): void {
    // The plaque/right-rig should reflect whether there's actually an
    // ONLINE partner in our cabin. Stale/offline rows don't count.
    let nextName: string | null = null;
    let nextIdentity: string | null = null;
    let nextInstrument: string = 'flute';
    if (this.connection) {
      for (const row of this.connection.db.player.iter()) {
        const id = row.identity.toHexString();
        if (id === this.localId) continue;
        if (row.roomId !== this.roomId) continue;
        if (!row.online) continue;
        nextName = row.displayName || 'Player';
        nextIdentity = id;
        nextInstrument = row.instrument || 'flute';
        break;
      }
    }

    if (nextIdentity !== this.partnerIdentityHex) {
      this.partnerIdentityHex = nextIdentity;
      for (const listener of this.partnerIdentityListeners) listener(nextIdentity);
    }

    if (nextInstrument !== this.partnerInstrument) {
      this.partnerInstrument = nextInstrument;
      for (const listener of this.partnerInstrumentListeners) listener(nextInstrument);
    }

    if (nextName === this.partnerName) return;
    this.partnerName = nextName;
    console.info('[jam-train] partner change ->', nextName);
    for (const listener of this.partnerListeners) listener(nextName);
  }

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

  private acceptOwnPlayer(row: Player): void {
    if (row.identity.toHexString() !== this.localId) return;
    this.setRoomId(row.roomId);
    this.setLocalSeat(row.seatIndex);
    if (row.instrument && row.instrument !== this.localInstrument) {
      this.localInstrument = row.instrument;
      for (const listener of this.localInstrumentListeners) listener(row.instrument);
    }
  }

  private setLocalSeat(seatIndex: number): void {
    const local = seatIndex === 1 ? 1 : 0;
    const partner = local === 0 ? 1 : 0;
    if (local === this.localSeatIndex && partner === this.partnerSeatIndex) return;
    this.localSeatIndex = local;
    this.partnerSeatIndex = partner;
    for (const listener of this.seatListeners) listener(local, partner);
  }

  private setRoomId(nextRoom: string): void {
    const sanitized = sanitizeRoomName(nextRoom);
    if (!sanitized || sanitized === this.roomId) return;
    this.roomId = sanitized;
    // After moving rooms, recompute who's already here so we don't toast
    // them as if they just boarded.
    this.rebuildKnownPlayers();
    for (const listener of this.roomListeners) listener(this.roomId);
  }

  private setState(state: ConnectionState): void {
    this.connectionState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
