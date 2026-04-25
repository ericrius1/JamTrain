import { DbConnection, tables, type ErrorContext } from '../module_bindings';
import type { HandState, Player } from '../module_bindings/types';
import { parsePose, serializePose } from './pose';
import { pickRandomRoomName, sanitizeRoomName } from './roomNames';
import type { ConnectionState, PlayerPose } from './types';

type StateListener = (state: ConnectionState) => void;
type RoomListener = (roomId: string) => void;
type PlayerEventListener = (player: { id: string; displayName: string }) => void;

const SPACETIME_URI = 'wss://maincloud.spacetimedb.com';
const SPACETIME_DATABASE = 'jam-train';

export class MultiplayerClient {
  localId = `local-${crypto.randomUUID()}`;
  private connection?: DbConnection;
  private connectionState: ConnectionState = 'local';
  private remotePose?: PlayerPose;
  private lastSendAt = 0;
  private channel?: BroadcastChannel;
  private stateListeners = new Set<StateListener>();
  private roomListeners = new Set<RoomListener>();
  private joinListeners = new Set<PlayerEventListener>();
  private knownPlayers = new Set<string>();
  private subscriptionApplied = false;
  private roomId: string;
  private displayName: string;
  // Empty string when the user landed without a URL room — signals the
  // server to auto-pair instead of creating a fresh empty room with our
  // randomly-picked display name.
  private bootPreferredRoom: string;

  constructor(urlRoom: string, displayName: string) {
    const sanitized = sanitizeRoomName(urlRoom);
    this.bootPreferredRoom = sanitized;
    this.roomId = sanitized || pickRandomRoomName();
    this.displayName = displayName;
    this.openBroadcastChannel();
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

  getRoom(): string {
    return this.roomId;
  }

  connect(): void {
    this.setState('connecting');

    try {
      this.connection = DbConnection.builder()
        .withUri(SPACETIME_URI)
        .withDatabaseName(SPACETIME_DATABASE)
        // No token persistence: every connection (every tab, every reload)
        // gets a brand-new SpacetimeDB identity. Two tabs sharing localStorage
        // would otherwise collapse onto a single identity and never see each
        // other as separate players.
        .withLightMode(true)
        .onConnect((conn, identity, _token) => {
          this.localId = identity.toHexString();
          console.info('[jam-train] spacetime identity', this.localId);
          this.registerSpacetimeHandlers(conn);
          this.requestSeat(this.bootPreferredRoom);
          this.setState('spacetime');
        })
        .onConnectError((_ctx: ErrorContext, error: Error) => {
          console.warn('SpacetimeDB connection unavailable; using local fallback', error);
          this.setState('local');
        })
        .onDisconnect(() => {
          this.setState('local');
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
    if (sanitized && sanitized !== this.roomId) {
      this.remotePose = undefined;
    }
    if (this.connection?.isActive) {
      this.requestSeat(sanitized);
    } else if (sanitized) {
      this.setRoomId(sanitized);
    }
  }

  updateDisplayName(displayName: string): void {
    this.displayName = displayName;
  }

  sendPose(pose: PlayerPose, time: number): void {
    if (time - this.lastSendAt < 0.055) return;
    this.lastSendAt = time;
    const poseJson = serializePose({ ...pose, id: this.localId, roomId: this.roomId });

    this.channel?.postMessage({
      type: 'pose',
      roomId: this.roomId,
      id: this.localId,
      poseJson,
      sentAt: Date.now(),
    });

    if (this.connection?.isActive) {
      void this.connection.reducers.updatePose({ roomId: this.roomId, poseJson }).catch(error => {
        console.warn('SpacetimeDB pose update failed', error);
      });
    }
  }

  getRemotePose(now = Date.now()): PlayerPose | undefined {
    if (!this.remotePose) return undefined;
    return now - this.remotePose.updatedAt < 3000 ? this.remotePose : undefined;
  }

  getState(): ConnectionState {
    return this.connectionState;
  }

  dispose(): void {
    this.channel?.close();
    if (this.connection?.isActive) {
      void this.connection.reducers.leaveRoom({}).finally(() => this.connection?.disconnect());
    } else {
      this.connection?.disconnect();
    }
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
    conn.db.handState.onInsert((_ctx, row) => this.acceptHandState(row));
    conn.db.handState.onUpdate((_ctx, _oldRow, row) => this.acceptHandState(row));
    conn.db.handState.onDelete((_ctx, row) => {
      const identity = row.identity.toHexString();
      if (this.remotePose?.id === identity) this.remotePose = undefined;
    });
    conn.db.player.onInsert((_ctx, row) => {
      this.acceptOwnPlayer(row);
      this.maybeAnnouncePlayer(row);
    });
    conn.db.player.onUpdate((_ctx, _oldRow, row) => {
      this.acceptOwnPlayer(row);
      this.maybeAnnouncePlayer(row);
    });
    conn.db.player.onDelete((_ctx, row) => {
      this.knownPlayers.delete(row.identity.toHexString());
    });
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        for (const row of conn.db.player.iter()) {
          this.knownPlayers.add(row.identity.toHexString());
          this.acceptOwnPlayer(row);
        }
        for (const row of conn.db.handState.iter()) this.acceptHandState(row);
        this.subscriptionApplied = true;
      })
      .onError(ctx => {
        console.warn('SpacetimeDB subscription failed', ctx.event);
      })
      .subscribe([tables.handState, tables.player]);
  }

  private maybeAnnouncePlayer(row: Player): void {
    const id = row.identity.toHexString();
    if (id === this.localId) return;

    const inOurRoom = row.roomId === this.roomId;
    const wasInOurRoom = this.knownPlayers.has(id);

    if (inOurRoom && !wasInOurRoom) {
      this.knownPlayers.add(id);
      // Players already present at subscription time are silently absorbed
      // — they were in the cabin before we boarded.
      if (!this.subscriptionApplied) return;
      for (const listener of this.joinListeners) {
        listener({ id, displayName: row.displayName });
      }
    } else if (!inOurRoom && wasInOurRoom) {
      this.knownPlayers.delete(id);
    }
  }

  private rebuildKnownPlayers(): void {
    this.knownPlayers.clear();
    if (!this.connection) return;
    for (const row of this.connection.db.player.iter()) {
      const id = row.identity.toHexString();
      if (id !== this.localId && row.roomId === this.roomId) {
        this.knownPlayers.add(id);
      }
    }
  }

  private acceptOwnPlayer(row: Player): void {
    if (row.identity.toHexString() !== this.localId) return;
    this.setRoomId(row.roomId);
  }

  private acceptHandState(row: HandState): void {
    if (row.roomId !== this.roomId) return;
    const id = row.identity.toHexString();
    if (id === this.localId) return;
    const pose = parsePose(row.poseJson);
    if (!pose) return;
    this.remotePose = {
      ...pose,
      id,
      roomId: row.roomId,
      seatIndex: 1,
      updatedAt: Date.now(),
    };
  }

  private setRoomId(nextRoom: string): void {
    const sanitized = sanitizeRoomName(nextRoom);
    if (!sanitized || sanitized === this.roomId) return;
    this.roomId = sanitized;
    this.remotePose = undefined;
    this.openBroadcastChannel();
    // After moving rooms, recompute who's already here so we don't toast
    // them as if they just boarded.
    this.rebuildKnownPlayers();
    for (const listener of this.roomListeners) listener(this.roomId);
  }

  private openBroadcastChannel(): void {
    this.channel?.close();
    if (!('BroadcastChannel' in window)) return;
    this.channel = new BroadcastChannel(`jam-train-${this.roomId}`);
    this.channel.onmessage = event => {
      const data = event.data as { type?: string; roomId?: string; id?: string; poseJson?: string; sentAt?: number };
      if (data.type !== 'pose' || data.roomId !== this.roomId || data.id === this.localId || !data.poseJson) return;
      const pose = parsePose(data.poseJson);
      if (!pose) return;
      this.remotePose = {
        ...pose,
        id: data.id ?? pose.id,
        roomId: this.roomId,
        seatIndex: 1,
        updatedAt: data.sentAt ?? Date.now(),
      };
    };
  }

  private setState(state: ConnectionState): void {
    this.connectionState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
