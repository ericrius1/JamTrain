import './style.css';
import { TitlePlaque } from './components/TitlePlaque';
import { ResonanceGauge, type Scenario } from './components/ResonanceGauge';
import { PlayerPlaque } from './components/PlayerPlaque';
import { HarmonyBand } from './components/HarmonyBand';
import { EngineRoomDrawer, type CameraMode } from './components/EngineRoomDrawer';
import { CaptureControl } from './components/CaptureControl';
import { createCornerFiligree } from './components/CornerFiligree';
import { BeginGate } from './components/BeginGate';

export type HudCallbacks = {
  onBegin: () => Promise<void> | void;
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
  private gauge: ResonanceGauge;
  private playerLeft: PlayerPlaque;
  private playerRight: PlayerPlaque;
  private harmony: HarmonyBand;
  private drawer: EngineRoomDrawer;
  private capture: CaptureControl;
  private beginGate?: BeginGate;
  private resizeHandler: () => void;

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

    this.gauge = new ResonanceGauge();
    this.uiEl.appendChild(this.gauge.el);

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

    this.harmony = new HarmonyBand();
    this.uiEl.appendChild(this.harmony.el);

    this.drawer = new EngineRoomDrawer({
      onRecalibrate: opts.callbacks.onRecalibrate,
      onDisembark: opts.callbacks.onDisembark,
      onCameraMode: opts.callbacks.onCameraMode,
    });
    this.uiEl.appendChild(this.drawer.el);
    this.drawer.setRow('Net', `spacetime · ${opts.room}`);

    this.capture = new CaptureControl();
    this.uiEl.appendChild(this.capture.el);

    this.beginGate = new BeginGate({ onBegin: opts.callbacks.onBegin });
    stage.appendChild(this.beginGate.el);

    this.resizeHandler = () => this.fitStage();
    window.addEventListener('resize', this.resizeHandler);
    this.fitStage();
  }

  setRoom(room: string): void {
    this.title.setRoom(room);
    this.drawer.setRow('Net', `spacetime · ${room}`);
  }

  setConnection(state: string): void {
    // TODO: wire to peer presence (SpacetimeDB) — for now treat any connected
    //       state as paired. Until peer presence is tracked, keep solo.
    this.drawer.setRow('Net', `spacetime · ${state}`);
  }

  setInputStatus(text: string): void {
    this.drawer.setRow('Hands', text);
  }

  setMusicStatus(text: string): void {
    this.drawer.setRow('Audio Out', text);
  }

  setScenario(scenario: Scenario, peerName?: string, latencyMs?: number): void {
    this.gauge.setScenario(scenario, peerName, latencyMs);
    if (scenario === 'paired' && peerName) {
      this.playerRight.set({
        name: peerName,
        voice: 'Warm Pads · Dorian',
        kind: 'passenger',
      });
    } else {
      this.playerRight.set({
        name: 'KORO·v3',
        voice: 'Wire Loom · Lydian',
        kind: 'automaton',
      });
    }
  }

  setCameraMode(mode: CameraMode): void {
    this.drawer.setCameraMode(mode);
  }

  // TODO: hook to Tone.js synth attack
  pushNote(who: 'you' | 'peer', pitch: number): void {
    this.harmony.pushNote(who, pitch);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.harmony.dispose();
    this.capture.dispose();
  }

  private fitStage(): void {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const s = Math.min(sw / 1920, sh / 1014);
    this.stageEl.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
}
