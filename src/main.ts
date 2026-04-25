import './style.css';
import { Game } from './game/Game';
import { Hud } from './hud/Hud';
import { DevOverlay } from './hud/DevOverlay';
import { CameraDebug } from './hud/components/CameraDebug';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) {
  throw new Error('Jam Train: #scene canvas missing');
}

// Destination is the first path segment of the URL — jamtrain.to/<destination>.
// Falls back to a default when none is provided.
const initialRoom = window.location.pathname.split('/').filter(Boolean)[0] ?? 'cabin-01';

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

const game = new Game(canvas, initialRoom, {
  connectionStatus: connectionSink,
  inputStatus: inputSink,
  musicStatus: musicSink,
});

let started = false;

const hud = new Hud({
  room: initialRoom,
  callbacks: {
    onBegin: async _conductorName => {
      // Single user-gesture entry. Camera prompt fires here (webcam only —
      // audio is synthesized output, no mic needed). Multiplayer connect is
      // also deferred to this gesture so no network activity happens before
      // the user opts in.
      await game.startCamera();
      await game.startAudio();
      game.connectMultiplayer();
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

const observe = (el: HTMLElement, push: (text: string) => void): MutationObserver => {
  const obs = new MutationObserver(() => push(el.textContent ?? ''));
  obs.observe(el, { childList: true, characterData: true, subtree: true });
  return obs;
};
observe(connectionSink, text => hud.setConnection(text));
observe(inputSink,      text => hud.setInputStatus(text));
observe(musicSink,      text => hud.setMusicStatus(text));

const cameraDebugMount = document.getElementById('stage') ?? document.body;
const cameraDebug = new CameraDebug(cameraDebugMount, game.handTracker);
const dev = new DevOverlay(game.paneDock, visible => cameraDebug.setVisible(visible));

void game.start();

window.addEventListener('beforeunload', () => {
  hud.dispose();
  dev.dispose();
  cameraDebug.dispose();
  game.dispose();
});

// Silence unused-warning while `started` is held for future wiring (e.g.
// disabling Begin re-entry, gating recalibrate behavior).
void started;
