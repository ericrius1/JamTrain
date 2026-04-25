import './style.css';
import { Game } from './game/Game';
import { Hud } from './hud/Hud';
import { DevOverlay } from './hud/DevOverlay';
import { onUrlRoomChange, readRoomFromUrl, writeRoomToUrl } from './game/router';

// Persisted toggle state (camera / share-video / mic). Browser permission
// itself is sticky on the same origin, so re-enabling on next load just
// flips track.enabled — no second prompt.
const PREFS_KEY = 'jam-train-av-prefs';
type AvPrefs = { camera: boolean; shareVideo: boolean; mic: boolean };
const loadPrefs = (): AvPrefs => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { camera: false, shareVideo: false, mic: false };
    const parsed = JSON.parse(raw) as Partial<AvPrefs>;
    return {
      camera: !!parsed.camera,
      shareVideo: !!parsed.shareVideo,
      mic: !!parsed.mic,
    };
  } catch {
    return { camera: false, shareVideo: false, mic: false };
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

      // Restore the previous session's toggle preferences. Browser permission
      // is already granted (no prompt), so this is just flipping the saved
      // tracks on. shareVideo only makes sense if camera is on too — we save
      // the user's intent either way and apply it on the WebRTC clone.
      game.setCameraEnabled(avPrefs.camera);
      game.setMicEnabled(avPrefs.mic);
      game.setShareVideoEnabled(avPrefs.shareVideo);
      hud.setCameraEnabled(avPrefs.camera);
      hud.setMicEnabled(avPrefs.mic);
      hud.setShareVideoEnabled(avPrefs.shareVideo);

      started = true;
    },
    onRoomChange: room => {
      game.setRoom(room);
      hud.setRoom(room);
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
});

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

onUrlRoomChange(room => {
  // Browser back/forward → re-issue request_seat for the new path.
  game.setRoom(room);
  hud.setRoom(room);
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
  () => game.getSceneVertexCount(),
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
  avPrefs.shareVideo = next;
  savePrefs(avPrefs);
});
hud.onMicToggle(() => {
  const next = !game.getMicEnabled();
  game.setMicEnabled(next);
  hud.setMicEnabled(next);
  avPrefs.mic = next;
  savePrefs(avPrefs);
});

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
