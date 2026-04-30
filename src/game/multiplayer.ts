import { Identity } from 'spacetimedb';
import { DbConnection, tables, type ErrorContext } from '../module_bindings';
import type { Player, WebrtcSignal } from '../module_bindings/types';
import { CREATURE_IDS, type CreatureId } from './creatures';
import { INSTRUMENT_IDS, normalizeInstrumentId, type InstrumentId } from './instruments';
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
type CreatureListener = (creatureId: string) => void;

const SPACETIME_URI = 'wss://maincloud.spacetimedb.com';
const SPACETIME_DATABASE = 'jam-train';
const TOKEN_STORAGE_KEY = 'jam-train-spacetime-token';
const ROBOT_PARTNER_CREATURE = 'robot';
const SERVER_DEFAULT_INSTRUMENT: InstrumentId = 'orb';
const SERVER_DEFAULT_CREATURE: CreatureId = 'lion';

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
  private localInstrument: InstrumentId = SERVER_DEFAULT_INSTRUMENT;
  private localInstrumentDirty = false;
  private localInstrumentExplicit = false;
  private partnerInstrument: InstrumentId = 'starlace';
  private localInstrumentListeners = new Set<InstrumentListener>();
  private partnerInstrumentListeners = new Set<InstrumentListener>();
  private localCreature: CreatureId = SERVER_DEFAULT_CREATURE;
  // True once the client has chosen a creature locally (auto-pick or HUD).
  // SpacetimeDB stores the published value but no longer assigns random
  // loadouts itself.
  private localCreatureDirty = false;
  private localCreatureExplicit = false;
  private partnerCreature: string = ROBOT_PARTNER_CREATURE;
  private localCreatureListeners = new Set<CreatureListener>();
  private partnerCreatureListeners = new Set<CreatureListener>();
  private subscriptionApplied = false;
  private ownPlayerAccepted = false;
  private initialSyncResolved = false;
  private initialSyncWaiters = new Set<() => void>();
  // Wall-clock ms set on each successful connect. Signals with createdAt
  // older than this are stale (left over from a previous session that didn't
  // get a clean disconnect-cleanup) and we drop them rather than feed them
  // to the WebRTC state machine where they cause peer-connection thrash.
  private connectedAtMs = 0;
  private roomId: string;
  private lastEmittedRoomId: string | null = null;
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
    this.localInstrument = this.pickRandomInstrument();
    this.localInstrumentDirty = true;
    this.partnerInstrument = this.oppositeInstrument(this.localInstrument);
    this.localCreature = this.pickRandomCreature();
    this.localCreatureDirty = true;
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

  waitForInitialSync(): Promise<void> {
    if (this.initialSyncResolved) return Promise.resolve();
    return new Promise(resolve => {
      this.initialSyncWaiters.add(resolve);
    });
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
    this.localInstrumentExplicit = true;
    this.localInstrumentDirty = true;
    this.acceptLocalInstrument(instrumentId);
    await this.pushLocalInstrument();
  }

  private acceptLocalInstrument(instrumentId: string): void {
    const norm = normalizeInstrumentId(instrumentId);
    if (this.localInstrument === norm) return;
    this.localInstrument = norm;
    for (const listener of this.localInstrumentListeners) listener(norm);
    // While solo (no real partner online), the robot mirrors the opposite
    // instrument so the duet pairing always holds.
    if (this.partnerIdentityHex === null) {
      const robot = this.oppositeInstrument(norm);
      if (this.partnerInstrument !== robot) {
        this.partnerInstrument = robot;
        for (const l of this.partnerInstrumentListeners) l(robot);
      }
    }
  }

  private acceptServerLocalInstrument(instrumentId: string): void {
    const norm = normalizeInstrumentId(instrumentId);
    if (this.localInstrumentDirty && this.localInstrumentExplicit && norm !== this.localInstrument) return;
    this.acceptLocalInstrument(norm);
    this.localInstrumentDirty = false;
  }

  private oppositeInstrument(id: InstrumentId): InstrumentId {
    return id === 'orb' ? 'starlace' : 'orb';
  }

  private async pushLocalInstrument(): Promise<void> {
    if (!this.connection?.isActive) return;
    try {
      await this.connection.reducers.updateInstrument({ instrument: this.localInstrument });
    } catch (err) {
      console.warn('[jam-train] update_instrument failed', err);
    }
  }

  onLocalCreatureChange(listener: CreatureListener): void {
    this.localCreatureListeners.add(listener);
    listener(this.localCreature);
  }

  onPartnerCreatureChange(listener: CreatureListener): void {
    this.partnerCreatureListeners.add(listener);
    listener(this.partnerCreature);
  }

  getLocalCreature(): string {
    return this.localCreature;
  }

  getPartnerCreature(): string {
    return this.partnerCreature;
  }

  async setLocalCreature(creatureId: string): Promise<void> {
    this.localCreatureExplicit = true;
    this.localCreatureDirty = true;
    this.acceptLocalCreature(creatureId);
    await this.pushLocalCreature();
  }

  private acceptLocalCreature(creatureId: string): void {
    const next = this.normalizeCreature(creatureId);
    if (this.localCreature === next) return;
    this.localCreature = next;
    for (const listener of this.localCreatureListeners) listener(next);
  }

  private acceptServerLocalCreature(creatureId: string): void {
    if (!creatureId) return;
    const next = this.normalizeCreature(creatureId);
    if (this.localCreatureDirty && this.localCreatureExplicit && next !== this.localCreature) return;
    this.acceptLocalCreature(next);
    this.localCreatureDirty = false;
  }

  private async pushLocalCreature(): Promise<void> {
    if (!this.connection?.isActive) return;
    try {
      await this.connection.reducers.updateCreature({ creature: this.localCreature });
    } catch (err) {
      console.warn('[jam-train] update_creature failed', err);
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
      // Use a dedicated reducer rather than re-issuing request_seat — the
      // latter recomputes seat index and could even bounce the user to a
      // different room if the current cabin was full at that exact moment.
      void this.connection.reducers.updateDisplayName({ displayName: next })
        .catch(err => console.warn('[jam-train] update_display_name failed', err));
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
          this.connectedAtMs = Date.now();
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
          this.resolveInitialSync();
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
          // While disconnected we present the robot partner; default it to the
          // opposite of the local instrument so the duet pairing still holds.
          const robotPartner = this.oppositeInstrument(this.localInstrument);
          if (this.partnerInstrument !== robotPartner) {
            this.partnerInstrument = robotPartner;
            for (const listener of this.partnerInstrumentListeners) listener(robotPartner);
          }
          if (this.partnerCreature !== ROBOT_PARTNER_CREATURE) {
            this.partnerCreature = ROBOT_PARTNER_CREATURE;
            for (const listener of this.partnerCreatureListeners) listener(ROBOT_PARTNER_CREATURE);
          }
          this.setState('local');
          this.resolveInitialSync();
          this.scheduleReconnect();
        })
        .build();
    } catch (error) {
      console.warn('SpacetimeDB client failed to start; using local fallback', error);
      this.setState('local');
      this.resolveInitialSync();
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
    // Just disconnect — don't call leave_room. The server's on_disconnect
    // hook intentionally keeps the player row alive (marking it offline) so
    // a brief disconnect/reconnect doesn't show the partner a leave + rejoin
    // toast on every page reload. leave_room stays reserved for an explicit
    // user action (the future Disembark button).
    this.connection?.disconnect();
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
        instrument: this.localInstrument,
        creature: this.localCreature,
        instrumentAuto: !this.localInstrumentExplicit,
        creatureAuto: !this.localCreatureExplicit,
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
            this.acceptOwnPlayer(row);
          }
        }
        // Pass 2: track who's already in the cabin (silent — no toasts;
        // subscriptionApplied is still false at this point).
        this.rebuildKnownPlayers();
        this.subscriptionApplied = true;
        // Pick/publish the local loadout after we can see whether a partner
        // is already in this cabin. The reducer only stores choices; it does
        // not roll random loadouts.
        const corrections = this.ensureInitialLocalLoadout();
        // Now sync the partner plaque with whoever's actually online here.
        this.updatePartner();
        // Push when the user explicitly chose, OR when ensureInitialLocalLoadout
        // had to correct a clash with the partner. Without the latter, an
        // auto-paired client whose server row already conflicts with the
        // partner would render the corrected creature locally but leave the
        // mismatched value in the DB, so other clients still see the clash.
        if ((this.localInstrumentDirty && this.localInstrumentExplicit) || corrections.instrument) {
          void this.pushLocalInstrument();
        }
        if ((this.localCreatureDirty && this.localCreatureExplicit) || corrections.creature) {
          void this.pushLocalCreature();
        }
        this.maybeResolveInitialSync();
        console.info('[jam-train] subscription applied; room', this.roomId, 'partners', this.knownPlayers.size);
      })
      .onError(ctx => {
        console.warn('SpacetimeDB subscription failed', ctx.event);
      })
      .subscribe([tables.player, tables.webrtcSignal]);
  }

  private ensureInitialLocalLoadout(): { instrument: boolean; creature: boolean } {
    const partner = this.findOnlinePartnerRow();
    let instrumentCorrected = false;
    let creatureCorrected = false;

    if (partner && !this.localInstrumentExplicit) {
      const next = this.oppositeInstrument(normalizeInstrumentId(partner.instrument));
      if (next !== this.localInstrument) {
        this.localInstrumentDirty = true;
        this.acceptLocalInstrument(next);
        instrumentCorrected = true;
      }
    } else if (!this.localInstrumentDirty && this.localInstrument === SERVER_DEFAULT_INSTRUMENT) {
      const next = this.pickRandomInstrument();
      this.localInstrumentDirty = true;
      this.acceptLocalInstrument(next);
    }

    if (partner && !this.localCreatureExplicit) {
      const partnerCreature = this.normalizeCreature(partner.creature);
      if (partnerCreature === this.localCreature) {
        const next = this.pickRandomCreature(partnerCreature);
        this.localCreatureDirty = true;
        this.acceptLocalCreature(next);
        creatureCorrected = true;
      }
    } else if (!this.localCreatureDirty && this.localCreature === SERVER_DEFAULT_CREATURE) {
      const next = this.pickRandomCreature();
      this.localCreatureDirty = true;
      this.acceptLocalCreature(next);
    }

    return { instrument: instrumentCorrected, creature: creatureCorrected };
  }

  private findOnlinePartnerRow(): Player | null {
    if (!this.connection) return null;
    for (const row of this.connection.db.player.iter()) {
      const id = row.identity.toHexString();
      if (id === this.localId) continue;
      if (row.roomId !== this.roomId) continue;
      if (!row.online) continue;
      return row;
    }
    return null;
  }

  private pickRandomInstrument(): InstrumentId {
    return this.randomChoice(INSTRUMENT_IDS);
  }

  private pickRandomCreature(exclude?: string): CreatureId {
    const excluded = CREATURE_IDS.includes(exclude as CreatureId) ? exclude as CreatureId : null;
    const pool = excluded ? CREATURE_IDS.filter(id => id !== excluded) : CREATURE_IDS;
    return this.randomChoice(pool.length > 0 ? pool : CREATURE_IDS);
  }

  private randomChoice<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)] ?? items[0];
  }

  private normalizeCreature(value: string | undefined | null): CreatureId {
    return CREATURE_IDS.includes(value as CreatureId) ? value as CreatureId : SERVER_DEFAULT_CREATURE;
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
    let realPartnerInstrument: InstrumentId | null = null;
    let nextCreature: string = ROBOT_PARTNER_CREATURE;
    const partner = this.findOnlinePartnerRow();
    if (partner) {
      nextName = partner.displayName || 'Player';
      nextIdentity = partner.identity.toHexString();
      realPartnerInstrument = normalizeInstrumentId(partner.instrument);
      nextCreature = this.normalizeCreature(partner.creature);
    }

    const partnerIdentityChanged = nextIdentity !== this.partnerIdentityHex;
    if (partnerIdentityChanged) {
      this.partnerIdentityHex = nextIdentity;
      for (const listener of this.partnerIdentityListeners) listener(nextIdentity);
    }

    // No real partner online → fall back to the robot, mirroring the opposite
    // of the local instrument so the duet pairing always holds.
    const nextInstrument: InstrumentId = realPartnerInstrument ?? this.oppositeInstrument(this.localInstrument);
    if (nextInstrument !== this.partnerInstrument) {
      this.partnerInstrument = nextInstrument;
      for (const listener of this.partnerInstrumentListeners) listener(nextInstrument);
    }

    if (nextCreature !== this.partnerCreature) {
      this.partnerCreature = nextCreature;
      for (const listener of this.partnerCreatureListeners) listener(nextCreature);
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
    // Stale-signal guard: anything stamped before our current session began
    // is a leftover from a prior client session whose disconnect didn't get
    // a chance to clean up. Replaying it would point our fresh peer
    // connection at a state that no longer exists, so consume + drop.
    // Allow a small clock-skew slack (5s) for SpacetimeDB / browser drift.
    if (this.connectedAtMs > 0) {
      const createdMs = Number(row.createdAt.toMillis());
      if (Number.isFinite(createdMs) && createdMs < this.connectedAtMs - 5000) {
        console.info('[webrtc] dropping stale signal', row.kind, 'from prior session');
        void this.consumeWebrtcSignal(row.id);
        return;
      }
    }
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
    this.setRoomId(row.roomId, { emitIfSame: true });
    this.setLocalSeat(row.seatIndex);
    this.acceptServerLocalInstrument(row.instrument || '');
    this.acceptServerLocalCreature(row.creature || '');
    this.ownPlayerAccepted = true;
    this.maybeResolveInitialSync();
  }

  private setLocalSeat(seatIndex: number): void {
    const local = seatIndex === 1 ? 1 : 0;
    const partner = local === 0 ? 1 : 0;
    if (local === this.localSeatIndex && partner === this.partnerSeatIndex) return;
    this.localSeatIndex = local;
    this.partnerSeatIndex = partner;
    for (const listener of this.seatListeners) listener(local, partner);
  }

  private setRoomId(nextRoom: string, opts: { emitIfSame?: boolean } = {}): void {
    const sanitized = sanitizeRoomName(nextRoom);
    if (!sanitized) return;
    const changed = sanitized !== this.roomId;
    if (changed) {
      this.roomId = sanitized;
      // After moving rooms, recompute who's already here so we don't toast
      // them as if they just boarded.
      this.rebuildKnownPlayers();
    }
    const shouldEmit = changed || (opts.emitIfSame === true && this.lastEmittedRoomId !== sanitized);
    if (!shouldEmit) return;
    this.lastEmittedRoomId = sanitized;
    for (const listener of this.roomListeners) listener(this.roomId);
  }

  private setState(state: ConnectionState): void {
    this.connectionState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private maybeResolveInitialSync(): void {
    if (this.subscriptionApplied && this.ownPlayerAccepted) {
      this.resolveInitialSync();
    }
  }

  private resolveInitialSync(): void {
    if (this.initialSyncResolved) return;
    this.initialSyncResolved = true;
    const waiters = [...this.initialSyncWaiters];
    this.initialSyncWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}
