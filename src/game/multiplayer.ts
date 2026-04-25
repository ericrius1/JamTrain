import { DbConnection, tables, type ErrorContext } from '../module_bindings';
import type { HandState } from '../module_bindings/types';
import { parsePose, serializePose } from './pose';
import type { ConnectionState, PlayerPose } from './types';

type Listener = (state: ConnectionState) => void;

const SPACETIME_URI = 'wss://maincloud.spacetimedb.com';
const SPACETIME_DATABASE = 'jam-train';

const safeRoom = (roomId: string): string => roomId.trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48) || 'cabin-01';

export class MultiplayerClient {
  localId = `local-${crypto.randomUUID()}`;
  private connection?: DbConnection;
  private connectionState: ConnectionState = 'local';
  private remotePose?: PlayerPose;
  private lastSendAt = 0;
  private channel?: BroadcastChannel;
  private listeners = new Set<Listener>();
  private tokenKey = 'jam-train-spacetime-token';

  constructor(
    private roomId: string,
    private displayName: string
  ) {
    this.roomId = safeRoom(roomId);
    this.openBroadcastChannel();
  }

  onStateChange(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.connectionState);
  }

  connect(): void {
    this.setState('connecting');

    try {
      this.connection = DbConnection.builder()
        .withUri(SPACETIME_URI)
        .withDatabaseName(SPACETIME_DATABASE)
        .withToken(localStorage.getItem(this.tokenKey) || undefined)
        .withLightMode(true)
        .onConnect((conn, identity, token) => {
          this.localId = identity.toHexString();
          localStorage.setItem(this.tokenKey, token);
          this.registerSpacetimeHandlers(conn);
          void conn.reducers.joinRoom({ roomId: this.roomId, displayName: this.displayName });
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

  setRoom(roomId: string): void {
    const nextRoom = safeRoom(roomId);
    if (nextRoom === this.roomId) return;
    this.roomId = nextRoom;
    this.remotePose = undefined;
    this.openBroadcastChannel();
    if (this.connection?.isActive) {
      void this.connection.reducers.joinRoom({ roomId: this.roomId, displayName: this.displayName });
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

  private registerSpacetimeHandlers(conn: DbConnection): void {
    conn.db.handState.onInsert((_ctx, row) => this.acceptHandState(row));
    conn.db.handState.onUpdate((_ctx, _oldRow, row) => this.acceptHandState(row));
    conn.db.handState.onDelete((_ctx, row) => {
      const identity = row.identity.toHexString();
      if (this.remotePose?.id === identity) this.remotePose = undefined;
    });
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        for (const row of conn.db.handState.iter()) this.acceptHandState(row);
      })
      .onError(ctx => {
        console.warn('SpacetimeDB subscription failed', ctx.event);
      })
      .subscribe([tables.handState, tables.player]);
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
    for (const listener of this.listeners) listener(state);
  }
}
