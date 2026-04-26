import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import { clamp } from './math';
import type { HandPose, PlayerPose } from './types';

export const HAND_SYNTH_DEFS = {
  enabled:      { type: 'boolean', default: true,  label: 'enabled' },
  volumeDb:     { default: -6,     min: -40, max: 6,    step: 0.5,  label: 'volume dB' },
  filterMinHz:  { default: 280,    min: 80,  max: 2000, step: 10,   label: 'filter min Hz' },
  filterMaxHz:  { default: 5800,   min: 800, max: 9000, step: 50,   label: 'filter max Hz' },
  filterQ:      { default: 1.4,    min: 0.5, max: 8,    step: 0.1,  label: 'filter Q' },
  attack:       { default: 0.20,   min: 0.01, max: 2,   step: 0.01, label: 'attack sec' },
  release:      { default: 1.6,    min: 0.1, max: 5,    step: 0.05, label: 'release sec' },
  vibratoHz:    { default: 4.5,    min: 0,   max: 9,    step: 0.1,  label: 'vibrato Hz' },
  vibratoDepth: { default: 0.04,   min: 0,   max: 0.2,  step: 0.005,label: 'vibrato depth' },
  mouseEnabled: { type: 'boolean', default: true,  label: 'mouse plays' },
} as const;

export type HandSynthParams = ParamsOf<typeof HAND_SYNTH_DEFS>;

// A minor pentatonic, two octaves. Sits well over both bass-ambience
// palettes (F major / A minor at night, G major / D major by day) because
// its tones are common to both keys.
const SCALE_NOTES: string[] = ['A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5'];

const PRESENCE_THRESHOLD = 0.5;
const PARAM_RAMP = 0.08;
const MOUSE_IDLE_TIMEOUT = 1.2;

// Hand world-space normalization. Palms typically span x ≈ -0.6..+0.6 and
// y ≈ 0.4..1.8 in the tracker's coordinate frame.
const HAND_X_RANGE = 0.6;
const HAND_Y_LOW = 0.4;
const HAND_Y_HIGH = 1.8;

type SourceKey = 'left' | 'right' | 'mouse';
const SOURCE_KEYS: SourceKey[] = ['left', 'right', 'mouse'];

type SourceState = {
  synth: any;
  vibrato: any;
  filter: any;
  gain: any;
  active: boolean;
  currentNoteIdx: number;
};

// Deadband around each note boundary (in scale-step units) so a hand resting
// near a boundary doesn't flicker between two pitches.
const NOTE_HYSTERESIS = 0.18;

type Coords = { xN: number; yN: number };

export class HandSynthEngine {
  private tone?: typeof import('tone');
  private running = false;
  private master?: any;

  private sources: Record<SourceKey, SourceState | null> = {
    left: null,
    right: null,
    mouse: null,
  };

  private mouseXN = 0.5;
  private mouseYN = 0.5;
  private elapsed = 0;
  private mouseLastAt = -Infinity;
  private mouseListener?: (e: PointerEvent) => void;

  private params: HandSynthParams = {
    enabled: HAND_SYNTH_DEFS.enabled.default,
    volumeDb: HAND_SYNTH_DEFS.volumeDb.default,
    filterMinHz: HAND_SYNTH_DEFS.filterMinHz.default,
    filterMaxHz: HAND_SYNTH_DEFS.filterMaxHz.default,
    filterQ: HAND_SYNTH_DEFS.filterQ.default,
    attack: HAND_SYNTH_DEFS.attack.default,
    release: HAND_SYNTH_DEFS.release.default,
    vibratoHz: HAND_SYNTH_DEFS.vibratoHz.default,
    vibratoDepth: HAND_SYNTH_DEFS.vibratoDepth.default,
    mouseEnabled: HAND_SYNTH_DEFS.mouseEnabled.default,
  };

  private registered?: ReturnType<typeof registerTweaks<typeof HAND_SYNTH_DEFS>>;

  constructor(
    private canvas: HTMLCanvasElement,
    private paneDock?: HTMLElement
  ) {
    this.attachMouseListener();
  }

  async start(): Promise<void> {
    if (this.running) return;
    const Tone = await import('tone');
    this.tone = Tone;
    await Tone.start();

    this.master = new Tone.Gain(Tone.dbToGain(this.params.volumeDb)).toDestination();

    for (const key of SOURCE_KEYS) {
      this.sources[key] = this.createSource();
    }

    this.attachPane();
    this.running = true;
  }

  update(local: PlayerPose, delta: number): void {
    if (!this.running || !this.tone) return;
    this.elapsed += delta;

    if (!this.params.enabled) {
      this.silenceAll();
      return;
    }

    const left = local.hands.left;
    const right = local.hands.right;

    this.updateSource('left',  left.confidence  > PRESENCE_THRESHOLD ? this.handCoords(left)  : null);
    this.updateSource('right', right.confidence > PRESENCE_THRESHOLD ? this.handCoords(right) : null);

    const mouseFresh =
      this.params.mouseEnabled && (this.elapsed - this.mouseLastAt) < MOUSE_IDLE_TIMEOUT;
    this.updateSource('mouse', mouseFresh ? { xN: this.mouseXN, yN: this.mouseYN } : null);

    this.master.gain.rampTo(this.tone.dbToGain(this.params.volumeDb), PARAM_RAMP);
  }

  dispose(): void {
    if (this.mouseListener) {
      this.canvas.removeEventListener('pointermove', this.mouseListener);
      this.mouseListener = undefined;
    }
    if (!this.running) return;
    this.running = false;
    for (const key of SOURCE_KEYS) {
      const src = this.sources[key];
      if (!src) continue;
      src.synth?.dispose?.();
      src.vibrato?.dispose?.();
      src.filter?.dispose?.();
      src.gain?.dispose?.();
      this.sources[key] = null;
    }
    this.master?.dispose?.();
    this.registered?.dispose();
  }

  private createSource(): SourceState {
    const Tone = this.tone!;
    const gain = new Tone.Gain(0).connect(this.master);
    const filter = new Tone.Filter({
      frequency: this.params.filterMinHz,
      type: 'lowpass',
      rolloff: -12,
      Q: this.params.filterQ,
    }).connect(gain);
    // Subtle pitch wobble for a breathy, flute-like character.
    const vibrato = new Tone.Vibrato({
      frequency: this.params.vibratoHz,
      depth: this.params.vibratoDepth,
    }).connect(filter);
    const synth = new Tone.Synth({
      oscillator: { type: 'triangle' } as any,
      envelope: {
        attack: this.params.attack,
        decay: 0.3,
        sustain: 0.95,
        release: this.params.release,
      },
      // No portamento — pitch snaps between scale steps. A real pentatonic
      // flute can't play microtones between holes.
      portamento: 0,
      volume: 0,
    }).connect(vibrato);
    return { synth, vibrato, filter, gain, active: false, currentNoteIdx: -1 };
  }

  private handCoords(hand: HandPose): Coords {
    const xN = clamp((hand.palm.x + HAND_X_RANGE) / (HAND_X_RANGE * 2), 0, 1);
    const yN = clamp((hand.palm.y - HAND_Y_LOW) / (HAND_Y_HIGH - HAND_Y_LOW), 0, 1);
    return { xN, yN };
  }

  private updateSource(key: SourceKey, coords: Coords | null): void {
    const src = this.sources[key];
    if (!src) return;

    if (!coords) {
      if (src.active) {
        src.synth.triggerRelease();
        src.gain.gain.rampTo(0, PARAM_RAMP * 2);
        src.active = false;
        src.currentNoteIdx = -1;
      }
      return;
    }

    const filterHz =
      this.params.filterMinHz + coords.xN * (this.params.filterMaxHz - this.params.filterMinHz);
    src.filter.frequency.rampTo(filterHz, PARAM_RAMP);
    src.filter.Q.rampTo(this.params.filterQ, PARAM_RAMP);

    const idx = pickNoteIndex(coords.yN, src.currentNoteIdx);
    const note = SCALE_NOTES[idx];

    if (!src.active) {
      src.synth.triggerAttack(note);
      src.gain.gain.rampTo(1, PARAM_RAMP);
      src.currentNoteIdx = idx;
      src.active = true;
    } else if (idx !== src.currentNoteIdx) {
      src.synth.setNote(note);
      src.currentNoteIdx = idx;
    }
  }

  private silenceAll(): void {
    for (const key of SOURCE_KEYS) {
      const src = this.sources[key];
      if (src && src.active) {
        src.synth.triggerRelease();
        src.gain.gain.rampTo(0, PARAM_RAMP * 2);
        src.active = false;
      }
    }
  }

  private attachMouseListener(): void {
    this.mouseListener = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const xN = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      // Flip Y so screen-up = high notes, matching hand intuition.
      const yN = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
      this.mouseXN = xN;
      this.mouseYN = yN;
      this.mouseLastAt = this.elapsed;
    };
    this.canvas.addEventListener('pointermove', this.mouseListener);
  }

  private attachPane(): void {
    if (!this.paneDock || this.registered) return;
    this.registered = registerTweaks(this.paneDock, 'handSynth', HAND_SYNTH_DEFS, {
      title: 'Hand Synth',
      params: this.params,
      onChange: {
        attack:       () => this.applyEnvelope(),
        release:      () => this.applyEnvelope(),
        vibratoHz:    () => this.applyVibrato(),
        vibratoDepth: () => this.applyVibrato(),
      },
    });
  }

  private applyEnvelope(): void {
    for (const key of SOURCE_KEYS) {
      const src = this.sources[key];
      if (!src) continue;
      src.synth.envelope.attack = this.params.attack;
      src.synth.envelope.release = this.params.release;
    }
  }

  private applyVibrato(): void {
    for (const key of SOURCE_KEYS) {
      const src = this.sources[key];
      if (!src) continue;
      src.vibrato.frequency.rampTo(this.params.vibratoHz, PARAM_RAMP);
      src.vibrato.depth.rampTo(this.params.vibratoDepth, PARAM_RAMP);
    }
  }
}

// Pick a discrete scale step from a normalized 0..1 y position. Adds a small
// hysteresis band around each boundary so a hand hovering near the edge
// doesn't ping-pong between two pitches.
function pickNoteIndex(yN: number, currentIdx: number): number {
  const N = SCALE_NOTES.length;
  const continuous = clamp(yN * N, 0, N - 0.0001);
  const rawIdx = Math.floor(continuous);
  if (currentIdx < 0) return rawIdx;
  if (continuous > currentIdx + 1 + NOTE_HYSTERESIS) {
    return Math.min(N - 1, Math.floor(continuous));
  }
  if (continuous < currentIdx - NOTE_HYSTERESIS) {
    return Math.max(0, Math.floor(continuous));
  }
  return currentIdx;
}
