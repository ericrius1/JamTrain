import './style.css';
import { Game } from './game/Game';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const roomInput = document.querySelector<HTMLInputElement>('#roomInput');
const cameraButton = document.querySelector<HTMLButtonElement>('#cameraButton');
const audioButton = document.querySelector<HTMLButtonElement>('#audioButton');
const gameCamButton = document.querySelector<HTMLButtonElement>('#gameCamButton');
const orbitCamButton = document.querySelector<HTMLButtonElement>('#orbitCamButton');
const connectionStatus = document.querySelector<HTMLElement>('#connectionStatus');
const inputStatus = document.querySelector<HTMLElement>('#inputStatus');
const musicStatus = document.querySelector<HTMLElement>('#musicStatus');

if (
  !canvas ||
  !roomInput ||
  !cameraButton ||
  !audioButton ||
  !gameCamButton ||
  !orbitCamButton ||
  !connectionStatus ||
  !inputStatus ||
  !musicStatus
) {
  throw new Error('Aura Cabin UI failed to mount.');
}

const game = new Game(canvas, roomInput.value, {
  connectionStatus,
  inputStatus,
  musicStatus,
});

cameraButton.addEventListener('click', () => {
  void game.startCamera();
});

audioButton.addEventListener('click', () => {
  void game.startAudio();
});

gameCamButton.addEventListener('click', () => {
  game.setCameraMode('game');
  gameCamButton.classList.add('segmented__button--active');
  orbitCamButton.classList.remove('segmented__button--active');
});

orbitCamButton.addEventListener('click', () => {
  game.setCameraMode('orbit');
  orbitCamButton.classList.add('segmented__button--active');
  gameCamButton.classList.remove('segmented__button--active');
});

roomInput.addEventListener('change', () => {
  game.setRoom(roomInput.value);
});

roomInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    roomInput.blur();
    game.setRoom(roomInput.value);
  }
});

void game.start();

window.addEventListener('beforeunload', () => {
  game.dispose();
});
