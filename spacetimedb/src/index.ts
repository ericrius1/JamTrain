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
    connectedAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const handState = table(
  {
    name: 'hand_state',
    public: true,
    indexes: [{ accessor: 'hand_state_room_id', name: 'hand_state_room_id', algorithm: 'btree', columns: ['roomId'] }],
  },
  {
    identity: t.identity().primaryKey(),
    roomId: t.string(),
    poseJson: t.string(),
    updatedAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  player,
  handState,
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
    if (!target) target = cleanFallback;

    const seatIndex = nextSeatIndex(ctx, target);
    const existing = ctx.db.player.identity.find(ctx.sender);

    if (existing) {
      ctx.db.player.identity.update({
        ...existing,
        roomId: target,
        displayName: cleanName,
        seatIndex,
        online: true,
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
      connectedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

export const update_pose = spacetimedb.reducer(
  { roomId: t.string(), poseJson: t.string() },
  (ctx, { poseJson }) => {
    if (poseJson.length > 24000) throw new SenderError('pose payload too large');

    // The server owns the player's room assignment. The roomId argument is
    // ignored — clients only update poses for the room they were placed
    // into via request_seat. Stale poses (sent before the first
    // request_seat completes) are silently dropped.
    const playerRow = ctx.db.player.identity.find(ctx.sender);
    if (!playerRow) return;

    const room = playerRow.roomId;
    const existingPose = ctx.db.handState.identity.find(ctx.sender);
    if (existingPose) {
      ctx.db.handState.identity.update({
        ...existingPose,
        roomId: room,
        poseJson,
        updatedAt: ctx.timestamp,
      });
      return;
    }

    ctx.db.handState.insert({
      identity: ctx.sender,
      roomId: room,
      poseJson,
      updatedAt: ctx.timestamp,
    });
  }
);

export const leave_room = spacetimedb.reducer(ctx => {
  // Explicit leave (e.g., user clicks Disembark) — fully remove the rows.
  ctx.db.handState.identity.delete(ctx.sender);
  ctx.db.player.identity.delete(ctx.sender);
});

export const on_disconnect = spacetimedb.clientDisconnected(ctx => {
  // Keep the rows around so a brief disconnect/reconnect doesn't appear
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
});
