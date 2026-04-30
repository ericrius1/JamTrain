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

function findOnlinePartner(ctx: any, roomId: string): any | null {
  for (const row of ctx.db.player.player_room_id.filter(roomId)) {
    if (row.identity.isEqual(ctx.sender)) continue;
    if (!row.online) continue;
    return row;
  }
  return null;
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

const DEFAULT_INSTRUMENT = 'orb';
const DEFAULT_CREATURE = 'lion';
// Legacy 'oar' / 'drum' kept in the allowlist so older clients can keep
// talking to the server until they refresh. The server normalizes them to
// 'orb' before persisting so all readers see the new id.
const ALLOWED_INSTRUMENTS = new Set(['orb', 'starlace', 'oar', 'drum']);
const INSTRUMENT_ALIASES: Record<string, string> = { oar: 'orb', drum: 'orb' };
const ALLOWED_CREATURES = new Set(['lion', 'elk', 'fox', 'rabbit', 'giraffe', 'robot']);
const SEAT_CREATURES = new Set(['lion', 'elk', 'fox', 'rabbit', 'giraffe']);

function cleanSeatInstrument(instrument: string): string | null {
  const clean = instrument.trim().toLowerCase();
  if (!ALLOWED_INSTRUMENTS.has(clean)) return null;
  return INSTRUMENT_ALIASES[clean] ?? clean;
}

function cleanSeatCreature(creature: string): string | null {
  const clean = creature.trim().toLowerCase();
  return SEAT_CREATURES.has(clean) ? clean : null;
}

function oppositeSeatInstrument(instrument: string): string {
  return cleanSeatInstrument(instrument) === 'starlace' ? 'orb' : 'starlace';
}

function firstDifferentSeatCreature(creature: string): string {
  const clean = cleanSeatCreature(creature) ?? DEFAULT_CREATURE;
  for (const candidate of SEAT_CREATURES) {
    if (candidate !== clean) return candidate;
  }
  return DEFAULT_CREATURE;
}

export const request_seat = spacetimedb.reducer(
  {
    preferredRoom: t.string(),
    fallbackName: t.string(),
    displayName: t.string(),
    instrument: t.string(),
    creature: t.string(),
    instrumentAuto: t.bool(),
    creatureAuto: t.bool(),
  },
  (ctx, { preferredRoom, fallbackName, displayName, instrument, creature, instrumentAuto, creatureAuto }) => {
    const cleanName = displayName.trim().slice(0, 32) || 'Player';
    const cleanFallback = sanitizeRoom(fallbackName) || 'cabin';
    const cleanPreferred = sanitizeRoom(preferredRoom);
    const requestedInstrument = cleanSeatInstrument(instrument);
    const requestedCreature = cleanSeatCreature(creature);

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
    const partner = findOnlinePartner(ctx, target);

    if (existing) {
      const baseInstrument = (requestedInstrument ?? existing.instrument) || DEFAULT_INSTRUMENT;
      const baseCreature = (requestedCreature ?? existing.creature) || DEFAULT_CREATURE;
      // When auto-paired, never let our loadout match the partner's. Applies
      // both to a fresh cabin entry and to a reconnect into an already-populated
      // cabin where our previous (now-conflicting) row would otherwise persist.
      const nextInstrument =
        instrumentAuto && partner && partner.instrument === baseInstrument
          ? oppositeSeatInstrument(partner.instrument)
          : baseInstrument;
      const nextCreature =
        creatureAuto && partner && partner.creature === baseCreature
          ? firstDifferentSeatCreature(partner.creature)
          : baseCreature;
      ctx.db.player.identity.update({
        ...existing,
        roomId: target,
        displayName: cleanName,
        seatIndex,
        online: true,
        instrument: nextInstrument,
        creature: nextCreature,
        updatedAt: ctx.timestamp,
      });
      return;
    }

    const baseInsertInstrument = requestedInstrument ?? DEFAULT_INSTRUMENT;
    const baseInsertCreature = requestedCreature ?? DEFAULT_CREATURE;
    const initialInstrument =
      instrumentAuto && partner && partner.instrument === baseInsertInstrument
        ? oppositeSeatInstrument(partner.instrument)
        : baseInsertInstrument;
    const initialCreature =
      creatureAuto && partner && partner.creature === baseInsertCreature
        ? firstDifferentSeatCreature(partner.creature)
        : baseInsertCreature;

    ctx.db.player.insert({
      identity: ctx.sender,
      roomId: target,
      displayName: cleanName,
      seatIndex,
      online: true,
      instrument: initialInstrument,
      creature: initialCreature,
      connectedAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
  }
);

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

// Dedicated display-name update so renames don't run through request_seat,
// which would also recompute seat index and could even bounce the user to a
// different room if their current cabin was full at that exact moment.
export const update_display_name = spacetimedb.reducer(
  { displayName: t.string() },
  (ctx, { displayName }) => {
    const cleanName = displayName.trim().slice(0, 32) || 'Player';
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    if (row.displayName === cleanName) return;
    ctx.db.player.identity.update({
      ...row,
      displayName: cleanName,
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
