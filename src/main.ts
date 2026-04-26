import './style.css';
import { Game } from './game/Game';

window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});

import { Hud, DEFAULT_BACKING_VOLUME, DEFAULT_MUSIC_VOLUME, DEFAULT_VOICE_VOLUME } from './hud/Hud';
import { DevOverlay } from './hud/DevOverlay';
import { onUrlRoomChange, readRoomFromUrl, writeRoomToUrl } from './game/router';
import { isInstrumentId, type InstrumentId } from './game/instruments';
import { isCreatureId, type CreatureId } from './game/creatures';

const LOCAL_INSTRUMENT_KEY = 'jam-train.local-instrument';
const LOCAL_CREATURE_KEY = 'jam-train.local-creature';

// Persisted toggle state. Camera and volumes survive across sessions; share-
// video and mic are intentionally NOT persisted — every new cabin entry is a
// fresh opt-in to sharing your video/audio with whoever is in the room.
// Browser permission itself is sticky on the same origin, so re-enabling on
// next load just flips track.enabled — no second prompt.
const PREFS_KEY = 'jam-train-av-prefs';
type AvPrefs = {
  camera: boolean;
  backingVolume: number;
  musicVolume: number;
  voiceVolume: number;
};
const clampUnit = (n: unknown, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
};
const loadPrefs = (): AvPrefs => {
  const defaults: AvPrefs = {
    camera: false,
    backingVolume: DEFAULT_BACKING_VOLUME,
    musicVolume: DEFAULT_MUSIC_VOLUME,
    voiceVolume: DEFAULT_VOICE_VOLUME,
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AvPrefs>;
    return {
      camera: !!parsed.camera,
      backingVolume: clampUnit(parsed.backingVolume, DEFAULT_BACKING_VOLUME),
      musicVolume: clampUnit(parsed.musicVolume, DEFAULT_MUSIC_VOLUME),
      voiceVolume: clampUnit(parsed.voiceVolume, DEFAULT_VOICE_VOLUME),
    };
  } catch {
    return defaults;
  }
};
const savePrefs = (prefs: AvPrefs): void => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage may be disabled — non-fatal */
  }
};
const avPrefs = loadPrefs();

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) {
  throw new Error('Jam Train: #scene canvas missing');
}

// First path segment of the URL is treated as a room hint. The server may
// re-assign us elsewhere if the requested room is full, or auto-pair us
// into someone else's solo room if the URL is empty.
const urlRoom = readRoomFromUrl();

// Game still expects HTMLElement sinks for connection / hand / music status.
// We give it hidden detached spans and observe their text changes to push
// updates into the new HUD without changing the Game / Audio / HandTracker
// public APIs.
const sink = (id: string): HTMLSpanElement => {
  const span = document.createElement('span');
  span.id = id;
  span.style.display = 'none';
  document.body.appendChild(span);
  return span;
};
const connectionSink = sink('hud-connection-sink');
const inputSink = sink('hud-input-sink');
const musicSink = sink('hud-music-sink');

const game = new Game(canvas, urlRoom, {
  connectionStatus: connectionSink,
  inputStatus: inputSink,
  musicStatus: musicSink,
});

// The multiplayer client filled in a random room name for cosmetic display
// when the URL was empty; the server will re-assign us once we connect.
const initialDisplayRoom = game.getRoom();

let started = false;

const hud = new Hud({
  room: initialDisplayRoom,
  callbacks: {
    onBegin: async conductorName => {
      // Single user-gesture entry. Camera + mic permission prompts may fire
      // (the browser remembers the grant for next time, so subsequent loads
      // skip them). Multiplayer connect is also deferred to this gesture so
      // no network activity happens before the user opts in.
      game.setDisplayName(conductorName);
      await game.startCamera();
      await game.startAudio();
      game.connectMultiplayer();

      // Restore camera (browser permission is sticky, so this just flips the
      // saved track on with no prompt). Share-video and mic always start off
      // on cabin entry — re-sharing is an explicit per-cabin opt-in.
      game.setCameraEnabled(avPrefs.camera);
      game.setMicEnabled(false);
      game.setShareVideoEnabled(false);
      hud.setCameraEnabled(avPrefs.camera);
      hud.setMicEnabled(false);
      hud.setShareVideoEnabled(false);

      game.setBackingVolume(avPrefs.backingVolume);
      game.setMusicVolume(avPrefs.musicVolume);
      hud.setRemoteVolume(avPrefs.voiceVolume);
      hud.setMixerValues(avPrefs.backingVolume, avPrefs.musicVolume, avPrefs.voiceVolume);

      started = true;
    },
    onRoomChange: room => {
      game.setRoom(room);
      hud.setRoom(room);
      resetShareAndMic();
    },
    onRecalibrate: () => {
      // TODO: hand tracker exposes no public recalibrate(); restart camera as
      //       the closest analogue for now.
      void game.startCamera();
    },
    onDisembark: () => {
      // TODO: wire to multiplayer.leave() once SpacetimeDB exposes one.
      console.info('Disembark requested (no-op until multiplayer.leave is added)');
    },
    onCameraMode: mode => {
      game.setCameraMode(mode);
    },
  },
});

hud.setCameraMode('game');

// Sync URL ↔ HUD ↔ multiplayer with the server's assigned room.
game.onAssignedRoom(room => {
  writeRoomToUrl(room);
  hud.setRoom(room);
  resetShareAndMic();
});

// Reset share-video + mic to off whenever we enter a new cabin. Privacy:
// don't carry an opt-in to share with one room into another. Camera stays
// as-is so hand tracking isn't interrupted.
function resetShareAndMic(): void {
  if (game.getShareVideoEnabled()) {
    game.setShareVideoEnabled(false);
    hud.setShareVideoEnabled(false);
  }
  if (game.getMicEnabled()) {
    game.setMicEnabled(false);
    hud.setMicEnabled(false);
  }
}

// Boarding toast — fires only on a *new* arrival in our cabin (post-subscribe).
// Existing partners that were already in the cabin when we boarded are silent.
game.onPlayerJoined(player => {
  const name = player.displayName?.trim() || 'A traveler';
  hud.announce(`${name} has boarded the jam train`);
});

// Partner name plaque — fires whenever the live partner state changes,
// including initial sync when we join an already-occupied cabin. This is
// independent of toast logic so the right plaque always reflects reality.
game.onPartnerChange(name => {
  hud.setPartner(name);
});

// Seat assignment — server-assigned by join order. First joiner gets seat 0
// (left), second gets seat 1 (right). The HUD swaps which plaque shows the
// local conductor vs the partner so each player sees themselves on their side.
game.onSeatChange(localSeat => {
  hud.setLocalSeat(localSeat);
});

// Local picker change → local synth/visual swap + sync over multiplayer.
hud.onLocalInstrumentChange(id => {
  game.setPlayerInstrument('local', id);
  void game.multiplayer.setLocalInstrument(id);
  localStorage.setItem(LOCAL_INSTRUMENT_KEY, id);
});

// Local instrument arrives from server (e.g. our row's persisted value):
game.multiplayer.onLocalInstrumentChange(id => {
  if (!isInstrumentId(id)) return;
  hud.setLocalInstrument(id);
  game.setPlayerInstrument('local', id);
});

// Partner picker mirror:
game.multiplayer.onPartnerInstrumentChange(id => {
  if (!isInstrumentId(id)) return;
  hud.setPartnerInstrument(id);
  game.setPlayerInstrument('remote', id);
});

// Auto-default for second player + persistence:
const stored = localStorage.getItem(LOCAL_INSTRUMENT_KEY);
const hasStored = stored !== null && isInstrumentId(stored);

let firstPartnerSeen = false;
game.multiplayer.onPartnerInstrumentChange(id => {
  if (firstPartnerSeen) return;
  if (hasStored) { firstPartnerSeen = true; return; }
  if (!isInstrumentId(id)) return;
  // Pick the first instrument that isn't the partner's.
  const choices: InstrumentId[] = ['flute', 'bell', 'sparks'];
  const pick = choices.find(c => c !== id) ?? 'flute';
  firstPartnerSeen = true;
  hud.setLocalInstrument(pick);
  game.setPlayerInstrument('local', pick);
  void game.multiplayer.setLocalInstrument(pick);
  localStorage.setItem(LOCAL_INSTRUMENT_KEY, pick);
});

// On boot, if we DO have a stored value, apply it immediately and push to server.
if (hasStored) {
  const id = stored as InstrumentId;
  hud.setLocalInstrument(id);
  game.setPlayerInstrument('local', id);
  void game.multiplayer.setLocalInstrument(id);
}

// ─── Creature wiring ──────────────────────────────────────────────────────
// Local picker change → local rig swap + sync over multiplayer.
hud.onLocalCreatureChange(id => {
  game.setPlayerCreature('local', id);
  void game.multiplayer.setLocalCreature(id);
  localStorage.setItem(LOCAL_CREATURE_KEY, id);
});

// Local creature arrives from server (e.g. our row's persisted value):
game.multiplayer.onLocalCreatureChange(id => {
  if (!isCreatureId(id)) return;
  hud.setLocalCreature(id);
  game.setPlayerCreature('local', id);
});

// Partner creature mirror:
game.multiplayer.onPartnerCreatureChange(id => {
  if (!isCreatureId(id)) return;
  game.setPlayerCreature('remote', id);
});

// On boot, apply any stored local creature and push to server.
const storedCreature = localStorage.getItem(LOCAL_CREATURE_KEY);
if (storedCreature !== null && isCreatureId(storedCreature)) {
  const id = storedCreature as CreatureId;
  game.setPlayerCreature('local', id);
  void game.multiplayer.setLocalCreature(id);
}

onUrlRoomChange(room => {
  // Browser back/forward → re-issue request_seat for the new path.
  game.setRoom(room);
  hud.setRoom(room);
  resetShareAndMic();
});

const observe = (el: HTMLElement, push: (text: string) => void): MutationObserver => {
  const obs = new MutationObserver(() => push(el.textContent ?? ''));
  obs.observe(el, { childList: true, characterData: true, subtree: true });
  return obs;
};
observe(connectionSink, text => hud.setConnection(text));
observe(inputSink,      text => hud.setInputStatus(text));
observe(musicSink,      text => hud.setMusicStatus(text));

const dev = new DevOverlay(
  game.paneDock,
  visible => {
    if (!visible) game.setCameraMode('game');
  },
  () => {
    game.setCameraMode(game.getCameraMode() === 'game' ? 'orbit' : 'game');
  },
);

// Hand the local stream + remote stream into the HUD's video panels. The
// local panel binds to the HandTracker's video element (so it can also draw
// the landmark overlay); the remote panel re-binds whenever the WebRTC peer
// connection delivers (or drops) a remote MediaStream.
hud.setHandTracker(game.handTracker);
game.onRemoteStream(stream => {
  hud.setRemoteStream(stream);
});

// Three independent toggles on the local panel:
//   Camera       — enables the local hand-tracking feed (no partner share)
//   Share Video  — separately opts in to letting the partner see the camera
//   Mic          — opts in to letting the partner hear you
// Each click also persists to localStorage so next session restores it.
hud.onCameraToggle(() => {
  const next = !game.getCameraEnabled();
  game.setCameraEnabled(next);
  hud.setCameraEnabled(next);
  avPrefs.camera = next;
  savePrefs(avPrefs);
});
hud.onShareVideoToggle(() => {
  const next = !game.getShareVideoEnabled();
  game.setShareVideoEnabled(next);
  hud.setShareVideoEnabled(next);
});
hud.onMicToggle(() => {
  const next = !game.getMicEnabled();
  game.setMicEnabled(next);
  hud.setMicEnabled(next);
});
hud.onBackingVolumeChange(value => {
  game.setBackingVolume(value);
  avPrefs.backingVolume = value;
  savePrefs(avPrefs);
});

// Robot's hand-played instrument defaults to muted while iterating on
// instruments — easier to hear yourself. `m` toggles. Real partners always
// play; the toggle only gates the procedural robot fill-in.
window.addEventListener('keydown', e => {
  if (e.key !== 'm' && e.key !== 'M') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.matches('input, textarea, [contenteditable=true]')) return;
  if (!started) return;
  const next = !game.isRobotJamMuted();
  game.setRobotJamMuted(next);
  hud.announce(next ? 'robot muted' : 'robot jamming');
});
hud.onMusicVolumeChange(value => {
  game.setMusicVolume(value);
  avPrefs.musicVolume = value;
  savePrefs(avPrefs);
});
hud.onVoiceVolumeChange(value => {
  hud.setRemoteVolume(value);
  avPrefs.voiceVolume = value;
  savePrefs(avPrefs);
});

// Apply any persisted mixer values to the HUD immediately so the sliders
// reflect saved state from frame one (audio engine + music gain are applied
// after Begin in onBegin since they require a user gesture).
hud.setMixerValues(avPrefs.backingVolume, avPrefs.musicVolume, avPrefs.voiceVolume);
hud.setRemoteVolume(avPrefs.voiceVolume);

void game.start();

const marquee = '🚂 Jam Train ';
let marqueeOffset = 0;
const marqueeTimer = window.setInterval(() => {
  marqueeOffset = (marqueeOffset + 1) % marquee.length;
  document.title = marquee.slice(marqueeOffset) + marquee.slice(0, marqueeOffset);
}, 250);

window.addEventListener('beforeunload', () => {
  window.clearInterval(marqueeTimer);
  hud.dispose();
  dev.dispose();
  game.dispose();
});

// Silence unused-warning while `started` is held for future wiring (e.g.
// disabling Begin re-entry, gating recalibrate behavior).
void started;
