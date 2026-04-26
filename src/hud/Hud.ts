import './style.css';
import { TitlePlaque } from './components/TitlePlaque';
import { PlayerPlaque } from './components/PlayerPlaque';
import type { CameraMode } from './components/EngineRoomDrawer';
import { VideoPanel } from './components/VideoPanel';
import type { HandTracker } from '../game/handTracking';
import { createCornerFiligree } from './components/CornerFiligree';
import { BeginGate } from './components/BeginGate';
import { SharePopover } from './components/SharePopover';
import { AnnouncementToast } from './components/AnnouncementToast';
import { MixerPanel } from './components/MixerPanel';

// Default mix balance. Synth (Music) sits a few dB above the backing so
// melody pokes through accompaniment; both have plenty of slider headroom
// to push higher or back off entirely.
export const DEFAULT_BACKING_VOLUME = 0.55;
export const DEFAULT_MUSIC_VOLUME = 0.55;
export const DEFAULT_VOICE_VOLUME = 1.0;

// Instrument labels shown on the plaques. Both players are in the same
// pentatonic scale (handled in handSynth.ts) so the plaque just calls out
// what each player is voicing.
const LOCAL_INSTRUMENT = 'Cedar Flute';
const REMOTE_INSTRUMENT = 'Velvet Keys';

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
  private localPanel: VideoPanel;
  private remotePanel: VideoPanel;
  private mixerPanel: MixerPanel;
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
  private localSeat = 0;
  private conductorName = 'AVA';
  private partnerName: string | null = null;

  constructor(opts: { room: string; callbacks: HudCallbacks }) {
    const stageWrap = document.getElementById('stage-wrap');
    const stage = document.getElementById('stage');
    const ui = document.getElementById('ui');
    if (!stageWrap || !stage || !ui) {
      throw new Error('Hud: required #stage-wrap / #stage / #ui mounts missing');
    }
    this.stageEl = stage;
    this.uiEl = ui;

    // Vignette overlay sits on #stage-wrap so it spans the full viewport
    // (the canvas now fills the viewport too; #stage is just a sized frame
    // for HUD layout).
    this.vignetteEl = document.createElement('div');
    this.vignetteEl.id = 'vignette';
    const scene = document.getElementById('scene');
    if (scene && scene.parentElement === stageWrap) {
      stageWrap.insertBefore(this.vignetteEl, scene.nextSibling);
    } else {
      stageWrap.appendChild(this.vignetteEl);
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
      voice: LOCAL_INSTRUMENT,
      kind: 'conductor',
    });
    this.uiEl.appendChild(this.playerLeft.el);

    this.playerRight = new PlayerPlaque({
      side: 'right',
      name: 'KORO·v3',
      voice: REMOTE_INSTRUMENT,
      kind: 'automaton',
    });
    this.uiEl.appendChild(this.playerRight.el);

    // Engine Room drawer is hidden for now while we surface peer-video
    // panels. Keep the file around in case we want it back.
    // this.drawer = new EngineRoomDrawer({
    //   onRecalibrate: opts.callbacks.onRecalibrate,
    //   onDisembark: opts.callbacks.onDisembark,
    //   onCameraMode: opts.callbacks.onCameraMode,
    // });
    // this.uiEl.appendChild(this.drawer.el);
    void opts.callbacks.onRecalibrate;
    void opts.callbacks.onDisembark;
    void opts.callbacks.onCameraMode;

    this.localPanel = new VideoPanel(stageWrap, { side: 'left', mode: 'local' });
    this.remotePanel = new VideoPanel(stageWrap, { side: 'right', mode: 'remote' });

    this.mixerPanel = new MixerPanel({
      backing: DEFAULT_BACKING_VOLUME,
      music: DEFAULT_MUSIC_VOLUME,
      voice: DEFAULT_VOICE_VOLUME,
    });
    this.remotePanel.setRemoteVolume(DEFAULT_VOICE_VOLUME);
    this.uiEl.appendChild(this.mixerPanel.el);

    this.currentRoom = opts.room;
    this.renderNetRow();

    this.beginGate = new BeginGate({
      onBegin: async name => {
        this.setConductorName(name);
        await opts.callbacks.onBegin(name);
      },
    });
    stageWrap.appendChild(this.beginGate.el);

    this.resizeHandler = () => this.fitStage();
    window.addEventListener('resize', this.resizeHandler);
    this.fitStage();
  }

  setConductorName(name: string): void {
    this.conductorName = name;
    this.applyPlaques();
  }

  setLocalSeat(seatIndex: number): void {
    const next = seatIndex === 1 ? 1 : 0;
    if (next === this.localSeat) return;
    this.localSeat = next;
    this.applyPlaques();
    this.localPanel.setSide(next === 0 ? 'left' : 'right');
    this.remotePanel.setSide(next === 0 ? 'right' : 'left');
  }

  setHandTracker(tracker: HandTracker): void {
    this.localPanel.setHandTracker(tracker);
  }

  setRemoteStream(stream: MediaStream | null): void {
    this.remotePanel.setStream(stream);
  }

  setMicEnabled(enabled: boolean): void {
    this.localPanel.setMicEnabled(enabled);
  }

  setCameraEnabled(enabled: boolean): void {
    this.localPanel.setCameraEnabled(enabled);
  }

  setShareVideoEnabled(enabled: boolean): void {
    this.localPanel.setShareVideoEnabled(enabled);
  }

  onMicToggle(listener: () => void): void {
    this.localPanel.onMicClick(listener);
  }

  onCameraToggle(listener: () => void): void {
    this.localPanel.onCameraClick(listener);
  }

  onShareVideoToggle(listener: () => void): void {
    this.localPanel.onShareVideoClick(listener);
  }

  setMixerValues(backing: number, music: number, voice: number): void {
    this.mixerPanel.setBackingVolume(backing);
    this.mixerPanel.setMusicVolume(music);
    this.mixerPanel.setVoiceVolume(voice);
  }

  setRemoteVolume(volume: number): void {
    this.remotePanel.setRemoteVolume(volume);
  }

  onBackingVolumeChange(listener: (value: number) => void): void {
    this.mixerPanel.onBackingChange(listener);
  }

  onMusicVolumeChange(listener: (value: number) => void): void {
    this.mixerPanel.onMusicChange(listener);
  }

  onVoiceVolumeChange(listener: (value: number) => void): void {
    this.mixerPanel.onVoiceChange(listener);
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
    this.partnerName = name;
    this.partnerPresent = !!name;
    this.applyPlaques();
    this.renderNetRow();
    this.localPanel.setPartnerPresent(this.partnerPresent);
  }

  private applyPlaques(): void {
    const localPlaque = this.localSeat === 0 ? this.playerLeft : this.playerRight;
    const partnerPlaque = this.localSeat === 0 ? this.playerRight : this.playerLeft;

    localPlaque.set({
      name: this.conductorName,
      voice: LOCAL_INSTRUMENT,
      kind: 'conductor',
    });

    if (this.partnerName) {
      partnerPlaque.set({
        name: this.partnerName.toUpperCase(),
        voice: REMOTE_INSTRUMENT,
        kind: 'conductor',
      });
    } else {
      partnerPlaque.set({
        name: 'KORO·v3',
        voice: REMOTE_INSTRUMENT,
        kind: 'automaton',
      });
    }
  }

  setConnection(state: string): void {
    this.currentConnection = state;
    this.renderNetRow();
  }

  private renderNetRow(): void {
    // Drawer hidden — net status currently un-surfaced in the UI. Logged so
    // it's still recoverable from devtools.
    const parts: string[] = [this.currentConnection];
    if (this.currentRoom) parts.push(this.currentRoom);
    if (this.currentConnection === 'spacetime') {
      parts.push(this.partnerPresent ? 'paired' : 'solo');
    }
    console.debug('[hud] net', parts.join(' · '));
  }

  setInputStatus(text: string): void {
    void text;
  }

  setMusicStatus(text: string): void {
    void text;
  }

  setCameraMode(mode: CameraMode): void {
    void mode;
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.sharePopover.dispose();
    this.announcement.dispose();
    this.localPanel.dispose();
    this.remotePanel.dispose();
  }

  private fitStage(): void {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const s = Math.min(sw / 1920, sh / 1014);
    this.stageEl.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
}
