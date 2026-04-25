import './style.css';
import { TitlePlaque } from './components/TitlePlaque';
import { PlayerPlaque } from './components/PlayerPlaque';
import { EngineRoomDrawer, type CameraMode } from './components/EngineRoomDrawer';
import { createCornerFiligree } from './components/CornerFiligree';
import { BeginGate } from './components/BeginGate';
import { SharePopover } from './components/SharePopover';
import { AnnouncementToast } from './components/AnnouncementToast';

export type HudCallbacks = {
  onBegin: (conductorName: string) => Promise<void> | void;
  onRoomChange: (room: string) => void;
  onRecalibrate: () => void;
  onDisembark: () => void;
  onCameraMode: (mode: CameraMode) => void;
};

export class Hud {
  private stageEl: HTMLElement;
  private uiEl: HTMLElement;
  private vignetteEl: HTMLElement;
  private title: TitlePlaque;
  private playerLeft: PlayerPlaque;
  private playerRight: PlayerPlaque;
  private drawer: EngineRoomDrawer;
  private beginGate?: BeginGate;
  private sharePopover: SharePopover;
  private shareButton: HTMLButtonElement;
  private announcement: AnnouncementToast;
  private resizeHandler: () => void;
  // Net-row state. Tracked separately so setRoom / setConnection / setPartner
  // can each update their own slice without clobbering the others.
  private currentConnection = 'connecting';
  private currentRoom = '';
  private partnerPresent = false;

  constructor(opts: { room: string; callbacks: HudCallbacks }) {
    const stageWrap = document.getElementById('stage-wrap');
    const stage = document.getElementById('stage');
    const ui = document.getElementById('ui');
    if (!stageWrap || !stage || !ui) {
      throw new Error('Hud: required #stage-wrap / #stage / #ui mounts missing');
    }
    this.stageEl = stage;
    this.uiEl = ui;

    // Vignette overlay between scene and UI
    this.vignetteEl = document.createElement('div');
    this.vignetteEl.id = 'vignette';
    const scene = document.getElementById('scene');
    if (scene && scene.parentElement === stage) {
      stage.insertBefore(this.vignetteEl, scene.nextSibling);
    } else {
      stage.appendChild(this.vignetteEl);
    }

    // Decorative corners (under interactive plaques)
    this.uiEl.appendChild(createCornerFiligree());

    this.title = new TitlePlaque({
      room: opts.room,
      line: 'NORTHBOUND · 22:14',
      onRoomChange: opts.callbacks.onRoomChange,
    });
    this.uiEl.appendChild(this.title.el);

    this.sharePopover = new SharePopover(opts.room, {
      onRoomChange: room => opts.callbacks.onRoomChange(room),
    });
    this.uiEl.appendChild(this.sharePopover.el);

    this.shareButton = document.createElement('button');
    this.shareButton.className = 'btn share-button';
    this.shareButton.textContent = 'Share';
    this.shareButton.addEventListener('click', e => {
      e.stopPropagation();
      this.sharePopover.toggle();
    });
    this.uiEl.appendChild(this.shareButton);

    this.announcement = new AnnouncementToast();
    this.uiEl.appendChild(this.announcement.el);

    this.playerLeft = new PlayerPlaque({
      side: 'left',
      name: 'AVA',
      voice: 'Glass Bells · Ionian',
      kind: 'conductor',
    });
    this.uiEl.appendChild(this.playerLeft.el);

    this.playerRight = new PlayerPlaque({
      side: 'right',
      name: 'KORO·v3',
      voice: 'Wire Loom · Lydian',
      kind: 'automaton',
    });
    this.uiEl.appendChild(this.playerRight.el);

    this.drawer = new EngineRoomDrawer({
      onRecalibrate: opts.callbacks.onRecalibrate,
      onDisembark: opts.callbacks.onDisembark,
      onCameraMode: opts.callbacks.onCameraMode,
    });
    this.uiEl.appendChild(this.drawer.el);
    this.currentRoom = opts.room;
    this.renderNetRow();

    this.beginGate = new BeginGate({
      onBegin: async name => {
        this.setConductorName(name);
        await opts.callbacks.onBegin(name);
      },
    });
    stage.appendChild(this.beginGate.el);

    this.resizeHandler = () => this.fitStage();
    window.addEventListener('resize', this.resizeHandler);
    this.fitStage();
  }

  setConductorName(name: string): void {
    this.playerLeft.set({
      name,
      voice: 'Glass Bells · Ionian',
      kind: 'conductor',
    });
  }

  setRoom(room: string): void {
    this.currentRoom = room;
    this.title.setRoom(room);
    this.sharePopover.setRoom(room);
    this.renderNetRow();
  }

  announce(text: string): void {
    this.announcement.show(text);
  }

  setPartner(name: string | null): void {
    this.partnerPresent = !!name;
    if (name) {
      this.playerRight.set({
        name: name.toUpperCase(),
        voice: 'Live hands · improvising',
        kind: 'passenger',
      });
    } else {
      this.playerRight.set({
        name: 'KORO·v3',
        voice: 'Wire Loom · Lydian',
        kind: 'automaton',
      });
    }
    this.renderNetRow();
  }

  setConnection(state: string): void {
    this.currentConnection = state;
    this.renderNetRow();
  }

  private renderNetRow(): void {
    const parts: string[] = [this.currentConnection];
    if (this.currentRoom) parts.push(this.currentRoom);
    if (this.currentConnection === 'spacetime') {
      parts.push(this.partnerPresent ? 'paired' : 'solo');
    }
    this.drawer.setRow('Net', parts.join(' · '));
  }

  setInputStatus(text: string): void {
    this.drawer.setRow('Hands', text);
  }

  setMusicStatus(text: string): void {
    this.drawer.setRow('Audio Out', text);
  }

  setCameraMode(mode: CameraMode): void {
    this.drawer.setCameraMode(mode);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.sharePopover.dispose();
    this.announcement.dispose();
  }

  private fitStage(): void {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const s = Math.min(sw / 1920, sh / 1014);
    this.stageEl.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
}
