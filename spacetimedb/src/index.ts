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

function nextSeatIndex(ctx: any, roomId: string): number {
  let takenSeat0 = false;
  let takenSeat1 = false;

  for (const row of ctx.db.player.player_room_id.filter(roomId)) {
    if (row.identity.isEqual(ctx.sender)) continue;
    if (row.seatIndex === 0) takenSeat0 = true;
    if (row.seatIndex === 1) takenSeat1 = true;
  }

  if (!takenSeat0) return 0;
  if (!takenSeat1) return 1;
  return 1;
}

export const join_room = spacetimedb.reducer(
  { roomId: t.string(), displayName: t.string() },
  (ctx, { roomId, displayName }) => {
    if (roomId.trim().length === 0) throw new SenderError('roomId required');

    const existing = ctx.db.player.identity.find(ctx.sender);
    const cleanName = displayName.trim().slice(0, 32) || 'Player';

    if (existing) {
      ctx.db.player.identity.update({
        ...existing,
        roomId,
        displayName: cleanName,
        online: true,
        updatedAt: ctx.timestamp,
      });
      return;
    }

    ctx.db.player.insert({
      identity: ctx.sender,
      roomId,
      displayName: cleanName,
      seatIndex: nextSeatIndex(ctx, roomId),
      online: true,
      connectedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

export const update_pose = spacetimedb.reducer(
  { roomId: t.string(), poseJson: t.string() },
  (ctx, { roomId, poseJson }) => {
    if (roomId.trim().length === 0) throw new SenderError('roomId required');
    if (poseJson.length > 24000) throw new SenderError('pose payload too large');

    const playerRow = ctx.db.player.identity.find(ctx.sender);
    if (!playerRow) {
      ctx.db.player.insert({
        identity: ctx.sender,
        roomId,
        displayName: 'Player',
        seatIndex: nextSeatIndex(ctx, roomId),
        online: true,
        connectedAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    } else {
      ctx.db.player.identity.update({
        ...playerRow,
        roomId,
        online: true,
        updatedAt: ctx.timestamp,
      });
    }

    const existingPose = ctx.db.handState.identity.find(ctx.sender);
    if (existingPose) {
      ctx.db.handState.identity.update({
        ...existingPose,
        roomId,
        poseJson,
        updatedAt: ctx.timestamp,
      });
      return;
    }

    ctx.db.handState.insert({
      identity: ctx.sender,
      roomId,
      poseJson,
      updatedAt: ctx.timestamp,
    });
  }
);

export const leave_room = spacetimedb.reducer(ctx => {
  ctx.db.handState.identity.delete(ctx.sender);
  ctx.db.player.identity.delete(ctx.sender);
});

export const on_disconnect = spacetimedb.clientDisconnected(ctx => {
  ctx.db.handState.identity.delete(ctx.sender);
  ctx.db.player.identity.delete(ctx.sender);
});
