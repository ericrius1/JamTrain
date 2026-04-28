import { SenderError, schema, table, t } from 'spacetimedb/server';

const player = table(
  {
    name: 'player',
    public: true,
    indexes: [{ accessor: 'player_room_id', name: 'player_room_id', algorithm: 'btree', columns: ['roomId'] }],
  },
  {
    identity: t.identity().primaryKey(),
    roomId: t.string(),
    displayName: t.string(),
    seatIndex: t.i32(),
    online: t.bool(),
    instrument: t.string(),
    connectedAt: t.timestamp(),
    updatedAt: t.timestamp(),
    creature: t.string().default('lion'),
  }
);

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

const spacetimedb = schema({
  player,
  webrtcSignal,
});

export default spacetimedb;

const ROOM_RE = /^[a-z0-9](-?[a-z0-9])*$/;

function sanitizeRoom(name: string): string {
  const trimmed = name.trim().toLowerCase().slice(0, 48);
  return ROOM_RE.test(trimmed) ? trimmed : '';
}

function nextSeatIndex(ctx: any, roomId: string): number {
  let takenSeat0 = false;
  let takenSeat1 = false;

  for (const row of ctx.db.player.player_room_id.filter(roomId)) {
    if (row.identity.isEqual(ctx.sender)) continue;
    if (!row.online) continue;
    if (row.seatIndex === 0) takenSeat0 = true;
    if (row.seatIndex === 1) takenSeat1 = true;
  }

  if (!takenSeat0) return 0;
  if (!takenSeat1) return 1;
  return 1;
}

function countOnlineOthers(ctx: any, roomId: string): number {
  let n = 0;
  for (const row of ctx.db.player.player_room_id.filter(roomId)) {
    if (row.identity.isEqual(ctx.sender)) continue;
    if (!row.online) continue;
    n++;
  }
  return n;
}

function findSoloRoom(ctx: any): string | null {
  const counts = new Map<string, number>();
  for (const row of ctx.db.player.iter()) {
    if (row.identity.isEqual(ctx.sender)) continue;
    if (!row.online) continue;
    counts.set(row.roomId, (counts.get(row.roomId) || 0) + 1);
  }
  for (const [roomId, count] of counts) {
    if (count === 1) return roomId;
  }
  return null;
}

function findAvailableVariant(ctx: any, baseName: string): string {
  if (countOnlineOthers(ctx, baseName) < 2) return baseName;
  for (let n = 2; n < 1000; n++) {
    const variant = `${baseName}-${n}`;
    if (countOnlineOthers(ctx, variant) < 2) return variant;
  }
  return baseName;
}

export const request_seat = spacetimedb.reducer(
  {
    preferredRoom: t.string(),
    fallbackName: t.string(),
    displayName: t.string(),
  },
  (ctx, { preferredRoom, fallbackName, displayName }) => {
    const cleanName = displayName.trim().slice(0, 32) || 'Player';
    const cleanFallback = sanitizeRoom(fallbackName) || 'cabin';
    const cleanPreferred = sanitizeRoom(preferredRoom);

    let target = '';
    if (cleanPreferred && countOnlineOthers(ctx, cleanPreferred) < 2) {
      target = cleanPreferred;
    }
    if (!target) {
      const solo = findSoloRoom(ctx);
      if (solo) target = solo;
    }
    if (!target) target = findAvailableVariant(ctx, cleanFallback);

    const seatIndex = nextSeatIndex(ctx, target);
    const existing = ctx.db.player.identity.find(ctx.sender);

    if (existing) {
      ctx.db.player.identity.update({
        ...existing,
        roomId: target,
        displayName: cleanName,
        seatIndex,
        online: true,
        instrument: existing.instrument || 'loom',
        creature: existing.creature || 'lion',
        updatedAt: ctx.timestamp,
      });
      return;
    }

    ctx.db.player.insert({
      identity: ctx.sender,
      roomId: target,
      displayName: cleanName,
      seatIndex,
      online: true,
      instrument: 'loom',
      creature: 'lion',
      connectedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

const ALLOWED_INSTRUMENTS = new Set(['loom', 'chime', 'orbs', 'starlace']);
const ALLOWED_CREATURES = new Set(['lion', 'human', 'elk', 'robot']);

export const update_instrument = spacetimedb.reducer(
  { instrument: t.string() },
  (ctx, { instrument }) => {
    if (!ALLOWED_INSTRUMENTS.has(instrument)) {
      throw new SenderError(`invalid instrument: ${instrument}`);
    }
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    ctx.db.player.identity.update({
      ...row,
      instrument,
      updatedAt: ctx.timestamp,
    });
  }
);

export const update_creature = spacetimedb.reducer(
  { creature: t.string() },
  (ctx, { creature }) => {
    if (!ALLOWED_CREATURES.has(creature)) {
      throw new SenderError(`invalid creature: ${creature}`);
    }
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    ctx.db.player.identity.update({
      ...row,
      creature,
      updatedAt: ctx.timestamp,
    });
  }
);

export const leave_room = spacetimedb.reducer(ctx => {
  ctx.db.player.identity.delete(ctx.sender);
});

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

export const on_disconnect = spacetimedb.clientDisconnected(ctx => {
  // Keep the player row around so a brief disconnect/reconnect doesn't appear
  // to the partner as a player leaving and rejoining (which would flash
  // their rig back to robot). Just mark them offline so matchmaking
  // doesn't pair new players with a ghost.
  const playerRow = ctx.db.player.identity.find(ctx.sender);
  if (playerRow) {
    ctx.db.player.identity.update({
      ...playerRow,
      online: false,
      updatedAt: ctx.timestamp,
    });
  }

  // Drop any pending WebRTC signals to or from this client so a reconnect
  // doesn't replay stale offers/answers.
  for (const row of ctx.db.webrtcSignal.iter()) {
    if (row.senderId.isEqual(ctx.sender) || row.recipientId.isEqual(ctx.sender)) {
      ctx.db.webrtcSignal.id.delete(row.id);
    }
  }
});
