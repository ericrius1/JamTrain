import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import { clamp } from './math';
import type { HandPose, PlayerPose } from './types';
import type { InstrumentId, VoiceState } from './instruments';
import { voiceStateZero } from './instruments';

export const HAND_SYNTH_DEFS = {
  enabled:       { type: 'boolean', default: true,  label: 'enabled' },
  volumeDb:      { default: -16,   min: -40, max: 6,    step: 0.5,  label: 'volume dB' },
  filterMinHz:   { default: 260,   min: 80,  max: 2000, step: 10,   label: 'filter min Hz' },
  filterMaxHz:   { default: 6400,  min: 800, max: 9000, step: 50,   label: 'filter max Hz' },
  filterQ:       { default: 1.2,   min: 0.4, max: 8,    step: 0.1,  label: 'filter Q' },
  attack:        { default: 0.11,  min: 0.01, max: 2,   step: 0.01, label: 'attack sec' },
  release:       { default: 1.85,  min: 0.1, max: 5,    step: 0.05, label: 'release sec' },
  shimmer:       { default: 0.38,  min: 0,   max: 1,    step: 0.01, label: 'shimmer' },
  reverbWetMax:  { default: 0.86,  min: 0,   max: 1,    step: 0.01, label: 'space max' },
  pluckDb:       { default: -9,    min: -24, max: 4,    step: 0.5,  label: 'attack dB' },
  duetDb:        { default: -19,   min: -36, max: 0,    step: 0.5,  label: 'duet dB' },
  mouseEnabled:  { type: 'boolean', default: true,  label: 'mouse plays' },
  chimeDb:       { default: 4,     min: -30, max: 12,   step: 0.5,  label: 'chime dB' },
  chimeWarmthMin:{ default: 600,   min: 120, max: 3000, step: 10,   label: 'chime warmth min Hz' },
  chimeWarmthMax:{ default: 6800,  min: 1200, max: 12000, step: 50, label: 'chime warmth max Hz' },
} as const;

export type HandSynthParams = ParamsOf<typeof HAND_SYNTH_DEFS>;

// D major pentatonic plus color tones. It stays consonant against the train
// bed but gives enough stepwise motion for the visual strings to feel played.
const SCALE_NOTES_LOCAL: string[] = ['D3', 'E3', 'F#3', 'A3', 'B3', 'D4', 'E4', 'F#4', 'A4', 'B4', 'D5', 'E5'];
const SCALE_NOTES_REMOTE: string[] = SCALE_NOTES_LOCAL.map(transposeOctaveDown);
const DUET_NOTES: string[] = ['D2', 'A2', 'D3', 'E3', 'F#3', 'A3', 'B3', 'D4', 'E4', 'A4', 'D5', 'E5'];

const PRESENCE_THRESHOLD = 0.5;
const PARAM_RAMP = 0.08;
const MOUSE_IDLE_TIMEOUT = 1.2;
const HAND_X_RANGE = 0.6;
const HAND_Y_LOW = 0.4;
const HAND_Y_HIGH = 1.8;
const NOTE_HYSTERESIS = 0.18;

type PlayerKey = 'local' | 'remote';
const PLAYER_KEYS: PlayerKey[] = ['local', 'remote'];

type Coords = { xN: number; yN: number };
type Input = {
  pitch: Coords;
  expression: Coords | null;
  handDistance: number;
  bothHands: boolean;
};

type Voice = {
  scale: string[];
  mainSynth: any;
  shimmerSynth: any;
  pluckSynth: any;
  filter: any;
  panner: any;
  dryGain: any;
  wetSend: any;
  shimmerGain: any;
  pluckGain: any;
  reverb: any;
  reverbReturn: any;
  active: boolean;
  currentNoteIdx: number;
  pulse: number;
  energy: number;
  pitch: number;
  expression: number;
  tension: number;
};

type ChimeVoice = {
  synth: any;       // Tone.PolySynth(Tone.FMSynth) — bell-like
  filter: any;      // lowpass, freq driven by warmth
  panner: any;
  dryGain: any;     // gated to 0 when this player isn't on chime
  wetSend: any;     // into reverb
  reverb: any;
  reverbReturn: any;
  pulse: number;
  energy: number;
  warmth: number;
  lastHitCount: number;
  decay: number;    // accumulates over time, used for gentle energy drift
  lastNoteIdx: number;
};

export class HandSynthEngine {
  private tone?: typeof import('tone');
  private running = false;

  private master?: any;
  private limiter?: any;
  private voices: Record<PlayerKey, Voice | null> = { local: null, remote: null };
  private chimeVoices: Record<PlayerKey, ChimeVoice | null> = { local: null, remote: null };
  private pendingInstruments: Record<PlayerKey, InstrumentId> = { local: 'loom', remote: 'loom' };
  private muted: Record<PlayerKey, boolean> = { local: false, remote: false };
  private duetSynth?: any;
  private duetFilter?: any;
  private duetGain?: any;
  private duetActive = false;
  private duetNote = '';

  private mouseXN = 0.5;
  private mouseYN = 0.5;
  private elapsed = 0;
  private mouseLastAtMs = -Infinity;
  private mouseListener?: (e: PointerEvent) => void;

  private params: HandSynthParams = {
    enabled: HAND_SYNTH_DEFS.enabled.default,
    volumeDb: HAND_SYNTH_DEFS.volumeDb.default,
    filterMinHz: HAND_SYNTH_DEFS.filterMinHz.default,
    filterMaxHz: HAND_SYNTH_DEFS.filterMaxHz.default,
    filterQ: HAND_SYNTH_DEFS.filterQ.default,
    attack: HAND_SYNTH_DEFS.attack.default,
    release: HAND_SYNTH_DEFS.release.default,
    shimmer: HAND_SYNTH_DEFS.shimmer.default,
    reverbWetMax: HAND_SYNTH_DEFS.reverbWetMax.default,
    pluckDb: HAND_SYNTH_DEFS.pluckDb.default,
    duetDb: HAND_SYNTH_DEFS.duetDb.default,
    mouseEnabled: HAND_SYNTH_DEFS.mouseEnabled.default,
    chimeDb: HAND_SYNTH_DEFS.chimeDb.default,
    chimeWarmthMin: HAND_SYNTH_DEFS.chimeWarmthMin.default,
    chimeWarmthMax: HAND_SYNTH_DEFS.chimeWarmthMax.default,
  };

  private registered?: ReturnType<typeof registerTweaks<typeof HAND_SYNTH_DEFS>>;

  constructor(
    private canvas: HTMLCanvasElement,
    private paneDock?: HTMLElement
  ) {
    this.attachMouseListener();
  }

  getProfileLabel(player: PlayerKey): string {
    return this.pendingInstruments[player] === 'chime' ? 'Wind Chime' : 'Aurora Loom';
  }

  getInstrument(player: PlayerKey): InstrumentId {
    return this.pendingInstruments[player];
  }

  getVoiceState(player: PlayerKey): VoiceState {
    const instrument = this.pendingInstruments[player];
    if (instrument === 'chime') {
      const c = this.chimeVoices[player];
      if (!c) return voiceStateZero();
      return {
        active: c.energy > 0.02,
        energy: c.energy,
        pulse: c.pulse,
        // Map warmth (left-hand y, 0..1) onto the existing pitch slot so
        // the chime visual driven off voice still reads "high vs low".
        pitch: c.warmth,
        expression: c.warmth,
        tension: clamp(c.energy * 1.4, 0, 1),
        noteIndex: c.lastNoteIdx,
        noteCount: 32,
      };
    }
    const v = this.voices[player];
    if (!v) return voiceStateZero();
    return {
      active: v.active,
      energy: v.energy,
      pulse: v.pulse,
      pitch: v.pitch,
      expression: v.expression,
      tension: v.tension,
      noteIndex: v.currentNoteIdx,
      noteCount: v.scale.length,
    };
  }

  setMasterGain(value: number): void {
    const MAX_SYNTH_GAIN = 0.35;
    const CURVE_EXP = 2.5;
    const v = value <= 0 ? 0 : Math.min(1, value);
    const linear = MAX_SYNTH_GAIN * Math.pow(v, CURVE_EXP);
    this.params.volumeDb = linear > 0.0001 ? 20 * Math.log10(linear) : -60;
    this.registered?.pane?.refresh();
  }

  async start(): Promise<void> {
    if (this.running) return;
    const Tone = await import('tone');
    this.tone = Tone;
    await Tone.start();

    this.limiter = new Tone.Limiter(-6).toDestination();
    this.master = new Tone.Gain(Tone.dbToGain(this.params.volumeDb)).connect(this.limiter);

    this.voices.local = this.createVoice('local', SCALE_NOTES_LOCAL);
    this.voices.remote = this.createVoice('remote', SCALE_NOTES_REMOTE);
    this.chimeVoices.local = this.createChimeVoice('local');
    this.chimeVoices.remote = this.createChimeVoice('remote');
    this.createDuetResonator();
    // Apply initial instrument routing — we created both voice chains active,
    // so silence the inactive one to avoid double output.
    this.applyInstrumentRouting('local');
    this.applyInstrumentRouting('remote');

    await Promise.all(
      PLAYER_KEYS
        .map(key => this.voices[key]?.reverb?.ready)
        .filter(Boolean)
    );

    this.attachPane();
    this.running = true;
  }

  update(local: PlayerPose, remote: PlayerPose, delta: number): void {
    if (!this.running || !this.tone) return;
    this.elapsed += delta;

    if (!this.params.enabled) {
      for (const key of PLAYER_KEYS) this.silenceVoice(key);
      this.updateDuetResonator(delta);
      return;
    }

    const mouseAgeSec = (performance.now() - this.mouseLastAtMs) / 1000;
    const mouseFresh = this.params.mouseEnabled && mouseAgeSec < MOUSE_IDLE_TIMEOUT;
    const localInput = this.resolveInput(local, mouseFresh ? { xN: this.mouseXN, yN: this.mouseYN } : null);
    const remoteInput = this.resolveInput(remote, null);

    for (const key of PLAYER_KEYS) {
      const instrument = this.pendingInstruments[key];
      if (instrument === 'chime') {
        // Loom voice held silent; chime updates only the filter/wet from warmth.
        this.silenceVoice(key);
        this.updateChimeVoice(key, delta);
      } else {
        const input = key === 'local' ? localInput : remoteInput;
        this.updateVoice(key, input, delta);
      }
    }
    this.updateDuetResonator(delta);

    this.master.gain.rampTo(this.tone.dbToGain(this.params.volumeDb), PARAM_RAMP);
  }

  getNotePulse(): number {
    let max = 0;
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (v && v.pulse > max) max = v.pulse;
      const c = this.chimeVoices[key];
      if (c && c.pulse > max) max = c.pulse;
    }
    return max;
  }

  silenceAll(): void {
    for (const key of PLAYER_KEYS) {
      this.silenceVoice(key);
      this.silenceChime(key);
    }
    this.releaseDuet(true);
  }

  setMuted(player: PlayerKey, muted: boolean): void {
    if (this.muted[player] === muted) return;
    this.muted[player] = muted;
    if (muted) {
      this.silenceVoice(player);
      this.silenceChime(player);
    } else {
      this.applyInstrumentRouting(player);
    }
  }

  setInstrument(player: PlayerKey, id: InstrumentId): void {
    if (this.pendingInstruments[player] === id) return;
    this.pendingInstruments[player] = id;
    // Hard-silence the previous chain immediately; updateVoice/updateChimeVoice
    // will bring the new chain to life on the next frame.
    this.silenceVoice(player);
    this.silenceChime(player);
    this.applyInstrumentRouting(player);

    // Audible confirmation when switching to chime — fires one bell so the
    // user can verify the audio chain works without depending on motion-driven
    // collisions. Only when audio is running.
    if (id === 'chime' && this.running && this.tone) {
      const chime = this.chimeVoices[player];
      if (chime) {
        // Bring dry path up immediately so the test ping isn't swallowed by
        // the gain ramp on the first updateChimeVoice() pass.
        try {
          chime.dryGain.gain.cancelScheduledValues?.(this.tone.now());
          chime.dryGain.gain.setValueAtTime?.(0.95, this.tone.now());
        } catch { /* fallback to ramp via updateChimeVoice */ }
        try {
          chime.synth.triggerAttackRelease(528, '4n', undefined, 0.9);
          console.debug('[handSynth] chime test ping fired', { player });
        } catch (err) {
          console.warn('[handSynth] chime test ping failed', err);
        }
      }
    }
  }

  /** Called by the WindChime visual when two gems collide or a gem is poked.
   *  Triggers a brief bell on the chime voice for the given player. */
  triggerChimeHit(player: PlayerKey, frequency: number, velocity: number): void {
    if (!this.running || !this.tone) {
      // Surface this once so it's debuggable from devtools — silent failures
      // here are the most common reason a player reports "no sound".
      if (!this._loggedChimeBlock) {
        console.warn('[handSynth] chime hit blocked: audio not started yet');
        this._loggedChimeBlock = true;
      }
      return;
    }
    if (this.muted[player]) return;
    if (this.pendingInstruments[player] !== 'chime') return;
    const chime = this.chimeVoices[player];
    if (!chime) return;
    const v = clamp(velocity, 0, 1);
    // Velocity floor at 0.4 so a soft brush still gives an audible bell.
    const synthVel = 0.4 + v * 0.6;
    try {
      chime.synth.triggerAttackRelease(frequency, '4n', undefined, synthVel);
    } catch (err) {
      console.warn('[handSynth] chime trigger failed', err);
      return;
    }
    if (!this._loggedChimeFirstHit) {
      console.debug('[handSynth] first chime hit', { player, frequency, velocity: synthVel });
      this._loggedChimeFirstHit = true;
    }
    chime.pulse = Math.min(1, chime.pulse + 0.55 + v * 0.45);
    chime.energy = Math.min(1, chime.energy + 0.14 + v * 0.18);
    chime.lastNoteIdx = chime.lastHitCount % 32;
    chime.lastHitCount += 1;
  }
  private _loggedChimeFirstHit = false;
  private _loggedChimeBlock = false;

  /** Set the left-hand-driven warmth for a player's chime voice. 0 = darker,
   *  1 = brighter. Smoothing is handled internally. */
  setChimeWarmth(player: PlayerKey, warmth: number): void {
    const chime = this.chimeVoices[player];
    if (!chime) return;
    chime.warmth = clamp(warmth, 0, 1);
  }

  getActivity(): number {
    let local = this.voices.local?.energy ?? 0;
    let remote = this.voices.remote?.energy ?? 0;
    local = Math.max(local, this.chimeVoices.local?.energy ?? 0);
    remote = Math.max(remote, this.chimeVoices.remote?.energy ?? 0);
    return clamp((local + remote) * 0.5, 0, 1);
  }

  dispose(): void {
    if (this.mouseListener) {
      this.canvas.removeEventListener('pointermove', this.mouseListener);
      this.mouseListener = undefined;
    }
    if (!this.running) return;
    this.running = false;
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (v) {
        this.disposeVoice(v);
        this.voices[key] = null;
      }
      const c = this.chimeVoices[key];
      if (c) {
        this.disposeChimeVoice(c);
        this.chimeVoices[key] = null;
      }
    }
    this.releaseDuet(true);
    this.duetSynth?.dispose?.();
    this.duetFilter?.dispose?.();
    this.duetGain?.dispose?.();
    this.master?.dispose?.();
    this.limiter?.dispose?.();
    this.registered?.dispose();
  }

  private createVoice(key: PlayerKey, scale: string[]): Voice {
    const Tone = this.tone!;
    const panner = new Tone.Panner(key === 'local' ? -0.28 : 0.28).connect(this.master);
    const dryGain = new Tone.Gain(0).connect(panner);
    const reverbReturn = new Tone.Gain(0.62).connect(panner);
    const reverb = new Tone.Reverb({
      decay: 4.8,
      preDelay: 0.025,
      wet: 1,
    }).connect(reverbReturn);
    const wetSend = new Tone.Gain(0).connect(reverb);
    const filter = new Tone.Filter({
      frequency: this.params.filterMinHz,
      type: 'lowpass',
      rolloff: -12,
      Q: this.params.filterQ,
    });
    filter.connect(dryGain);
    filter.connect(wetSend);

    const shimmerGain = new Tone.Gain(this.params.shimmer * 0.28).connect(filter);
    const pluckGain = new Tone.Gain(Tone.dbToGain(this.params.pluckDb)).connect(filter);

    const mainSynth = new Tone.Synth({
      oscillator: { type: 'fatsine4', count: 3, spread: 18 } as any,
      envelope: {
        attack: this.params.attack,
        decay: 0.22,
        sustain: 0.78,
        release: this.params.release,
      },
      portamento: 0.06,
      volume: -2,
    }).connect(filter);

    const shimmerSynth = new Tone.Synth({
      oscillator: { type: 'triangle8' } as any,
      envelope: {
        attack: Math.max(0.08, this.params.attack * 1.7),
        decay: 0.35,
        sustain: 0.46,
        release: this.params.release * 1.25,
      },
      portamento: 0.08,
      volume: -12,
    }).connect(shimmerGain);

    const pluckSynth = new Tone.PluckSynth({
      attackNoise: 0.8,
      dampening: 3400,
      resonance: 0.88,
      release: 1.15,
      volume: 0,
    }).connect(pluckGain);

    return {
      scale,
      mainSynth,
      shimmerSynth,
      pluckSynth,
      filter,
      panner,
      dryGain,
      wetSend,
      shimmerGain,
      pluckGain,
      reverb,
      reverbReturn,
      active: false,
      currentNoteIdx: -1,
      pulse: 0,
      energy: 0,
      pitch: 0.5,
      expression: 0.5,
      tension: 0.35,
    };
  }

  private createChimeVoice(key: PlayerKey): ChimeVoice {
    const Tone = this.tone!;
    const panner = new Tone.Panner(key === 'local' ? -0.18 : 0.18).connect(this.master);
    const dryGain = new Tone.Gain(0).connect(panner);
    const reverbReturn = new Tone.Gain(0.55).connect(panner);
    const reverb = new Tone.Reverb({
      decay: 6.5,
      preDelay: 0.02,
      wet: 1,
    }).connect(reverbReturn);
    const wetSend = new Tone.Gain(0).connect(reverb);
    const filter = new Tone.Filter({
      frequency: this.params.chimeWarmthMin,
      type: 'lowpass',
      rolloff: -12,
      Q: 0.6,
    });
    filter.connect(dryGain);
    filter.connect(wetSend);

    // FM bell — short percussive attack, long decay. The harmonicity & mod
    // index are tuned to a glassy chime tone that blends with the loom but
    // reads as distinct.
    const synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 11,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.001, decay: 1.6, sustain: 0, release: 1.8 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.2 },
      volume: this.params.chimeDb,
    }).connect(filter);

    return {
      synth,
      filter,
      panner,
      dryGain,
      wetSend,
      reverb,
      reverbReturn,
      pulse: 0,
      energy: 0,
      warmth: 0.5,
      lastHitCount: 0,
      decay: 0,
      lastNoteIdx: -1,
    };
  }

  private updateChimeVoice(player: PlayerKey, delta: number): void {
    const chime = this.chimeVoices[player];
    if (!chime || !this.tone) return;
    if (this.muted[player]) {
      this.silenceChime(player);
      return;
    }

    // Filter cutoff from warmth — exponential mapping so low warmth doesn't
    // sound choked.
    const warmth = clamp(chime.warmth, 0, 1);
    const minHz = this.params.chimeWarmthMin;
    const maxHz = this.params.chimeWarmthMax;
    const cutoff = minHz * Math.pow(maxHz / minHz, warmth);
    chime.filter.frequency.rampTo(cutoff, PARAM_RAMP);

    // Wet send rises with energy — more reverb tail when actively playing.
    const wet = clamp(0.18 + chime.energy * 0.6, 0, 1);
    chime.wetSend.gain.rampTo(wet * this.params.reverbWetMax, PARAM_RAMP * 2);
    chime.dryGain.gain.rampTo(0.95, PARAM_RAMP);

    // Decay pulse and energy each frame.
    chime.pulse = Math.max(0, chime.pulse - delta * 3.4);
    chime.energy = Math.max(0, chime.energy - delta * 0.55);
  }

  private silenceChime(player: PlayerKey): void {
    const chime = this.chimeVoices[player];
    if (!chime) return;
    try {
      chime.synth.releaseAll?.(this.tone?.now?.());
    } catch (err) {
      console.warn('[handSynth] chime releaseAll failed', err);
    }
    this.setGainNow(chime.dryGain, 0);
    this.setGainNow(chime.wetSend, 0);
    chime.pulse = 0;
    chime.energy = 0;
  }

  private disposeChimeVoice(chime: ChimeVoice): void {
    try { chime.synth?.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    chime.synth?.dispose?.();
    chime.filter?.dispose?.();
    chime.panner?.dispose?.();
    chime.dryGain?.dispose?.();
    chime.wetSend?.dispose?.();
    chime.reverb?.dispose?.();
    chime.reverbReturn?.dispose?.();
  }

  private applyInstrumentRouting(player: PlayerKey): void {
    if (!this.running) return;
    const instrument = this.pendingInstruments[player];
    const voice = this.voices[player];
    const chime = this.chimeVoices[player];
    if (instrument === 'chime') {
      // Loom chain held at zero; chime chain is brought up by updateChimeVoice.
      if (voice) {
        this.releaseVoice(voice, false);
      }
    } else {
      if (chime) {
        this.silenceChime(player);
      }
    }
  }

  private createDuetResonator(): void {
    const Tone = this.tone!;
    this.duetGain = new Tone.Gain(0).connect(this.master);
    this.duetFilter = new Tone.Filter({
      frequency: 900,
      type: 'lowpass',
      rolloff: -12,
      Q: 0.8,
    }).connect(this.duetGain);
    this.duetSynth = new Tone.Synth({
      oscillator: { type: 'sine' } as any,
      envelope: {
        attack: 0.65,
        decay: 0.45,
        sustain: 0.52,
        release: 2.4,
      },
      portamento: 0.12,
      volume: this.params.duetDb,
    }).connect(this.duetFilter);
  }

  private resolveInput(pose: PlayerPose, mouse: Coords | null): Input | null {
    const left = pose.hands.left;
    const right = pose.hands.right;
    const lOn = left.confidence > PRESENCE_THRESHOLD;
    const rOn = right.confidence > PRESENCE_THRESHOLD;

    if (rOn && lOn) {
      return {
        pitch: handCoords(right),
        expression: handCoords(left),
        handDistance: palmDistance(left, right),
        bothHands: true,
      };
    }
    if (rOn) {
      return { pitch: handCoords(right), expression: null, handDistance: 0.42, bothHands: false };
    }
    if (lOn) {
      return { pitch: handCoords(left), expression: null, handDistance: 0.42, bothHands: false };
    }
    if (mouse) {
      return { pitch: mouse, expression: null, handDistance: 0.42, bothHands: false };
    }
    return null;
  }

  private updateVoice(key: PlayerKey, input: Input | null, delta: number): void {
    const voice = this.voices[key];
    if (!voice) return;

    voice.pulse = Math.max(0, voice.pulse - delta * 3.2);

    if (this.muted[key] || !input) {
      this.silenceVoice(key);
      this.decayVoiceState(voice, delta);
      return;
    }

    const { pitch, expression } = input;
    const expressionY = expression?.yN ?? pitch.xN;
    const expressionX = expression?.xN ?? 0.35;
    const tension = clamp((input.handDistance - 0.16) / 0.78, 0, 1);
    const brightness = clamp(0.12 + pitch.xN * 0.22 + expressionY * 0.58 + tension * 0.24, 0, 1);
    const filterHz = this.params.filterMinHz + brightness * (this.params.filterMaxHz - this.params.filterMinHz);
    const wet = clamp(0.18 + expressionX * 0.68 + (input.bothHands ? tension * 0.12 : 0), 0, 1);
    const shimmer = clamp(this.params.shimmer * (0.22 + expressionY * 0.62 + tension * 0.34), 0, 1);
    const panBase = key === 'local' ? -0.28 : 0.28;

    voice.filter.frequency.rampTo(filterHz, PARAM_RAMP);
    voice.filter.Q.rampTo(this.params.filterQ + tension * 0.55, PARAM_RAMP);
    voice.wetSend.gain.rampTo(wet * this.params.reverbWetMax, PARAM_RAMP * 2);
    voice.dryGain.gain.rampTo(0.9, PARAM_RAMP);
    voice.shimmerGain.gain.rampTo(shimmer * 0.38, PARAM_RAMP);
    voice.pluckGain.gain.rampTo(this.tone!.dbToGain(this.params.pluckDb + tension * 3), PARAM_RAMP);
    voice.panner.pan.rampTo(clamp(panBase + (pitch.xN - 0.5) * 0.18, -0.85, 0.85), PARAM_RAMP);

    const idx = pickNoteIndex(pitch.yN, voice.currentNoteIdx, voice.scale.length);
    const note = voice.scale[idx];
    const shimmerNote = transposeInterval(note, 12);

    if (!voice.active) {
      voice.mainSynth.triggerAttack(note);
      voice.shimmerSynth.triggerAttack(shimmerNote);
      voice.pluckSynth.triggerAttack(note);
      voice.currentNoteIdx = idx;
      voice.active = true;
      voice.pulse = 1;
    } else if (idx !== voice.currentNoteIdx) {
      voice.mainSynth.setNote(note);
      voice.shimmerSynth.setNote(shimmerNote);
      voice.pluckSynth.triggerAttack(note);
      voice.currentNoteIdx = idx;
      voice.pulse = Math.max(voice.pulse, 0.78);
    }

    voice.pitch += (pitch.yN - voice.pitch) * (1 - Math.exp(-delta * 10));
    voice.expression += (expressionY - voice.expression) * (1 - Math.exp(-delta * 9));
    voice.tension += (tension - voice.tension) * (1 - Math.exp(-delta * 8));
    voice.energy += (1 - voice.energy) * (1 - Math.exp(-delta * 6));
  }

  private decayVoiceState(voice: Voice, delta: number): void {
    voice.energy += (0 - voice.energy) * (1 - Math.exp(-delta * 4.5));
    voice.tension += (0.35 - voice.tension) * (1 - Math.exp(-delta * 4));
  }

  private updateDuetResonator(delta: number): void {
    const local = this.voices.local;
    const remote = this.voices.remote;
    if (!local || !remote || !this.duetSynth || !this.duetGain || !this.duetFilter || !this.tone) return;

    const duet = local.active && remote.active ? Math.min(local.energy, remote.energy) : 0;
    const targetGain = duet > 0.08 ? this.tone.dbToGain(this.params.duetDb) * duet : 0;
    this.duetGain.gain.rampTo(targetGain, PARAM_RAMP * 2);
    this.duetFilter.frequency.rampTo(520 + (local.expression + remote.expression) * 780 + duet * 620, PARAM_RAMP * 2);

    if (duet <= 0.08) {
      this.releaseDuet(false);
      return;
    }

    const avgIdx = Math.round(((local.currentNoteIdx < 0 ? 0 : local.currentNoteIdx) + (remote.currentNoteIdx < 0 ? 0 : remote.currentNoteIdx)) * 0.5);
    const note = DUET_NOTES[clamp(avgIdx, 0, DUET_NOTES.length - 1)];
    if (!this.duetActive) {
      this.duetSynth.triggerAttack(note);
      this.duetNote = note;
      this.duetActive = true;
    } else if (note !== this.duetNote) {
      this.duetSynth.setNote(note);
      this.duetNote = note;
    }

    void delta;
  }

  private releaseDuet(immediate: boolean): void {
    if (!this.duetActive && !immediate) return;
    try {
      this.duetSynth?.triggerRelease?.(this.tone?.now?.());
    } catch (err) {
      console.warn('[handSynth] duet release failed', err);
    }
    if (immediate) this.setGainNow(this.duetGain, 0);
    this.duetActive = false;
    this.duetNote = '';
  }

  private silenceVoice(key: PlayerKey): void {
    const voice = this.voices[key];
    if (!voice) return;
    this.releaseVoice(voice, false);
  }

  private releaseVoice(voice: Voice, immediate: boolean): void {
    if (!voice.active && !immediate) return;
    try {
      voice.mainSynth.triggerRelease?.(this.tone?.now?.());
      voice.shimmerSynth.triggerRelease?.(this.tone?.now?.());
      voice.pluckSynth.triggerRelease?.(this.tone?.now?.());
    } catch (err) {
      console.warn('[handSynth] triggerRelease failed', err);
    }
    if (immediate) {
      this.setGainNow(voice.dryGain, 0);
      this.setGainNow(voice.wetSend, 0);
      this.setGainNow(voice.shimmerGain, 0);
      this.setGainNow(voice.pluckGain, 0);
    } else {
      voice.dryGain.gain.rampTo(0, PARAM_RAMP * 2);
      voice.wetSend.gain.rampTo(0, PARAM_RAMP * 2);
      voice.shimmerGain.gain.rampTo(0, PARAM_RAMP * 2);
      voice.pluckGain.gain.rampTo(0, PARAM_RAMP * 2);
    }
    voice.active = false;
    voice.currentNoteIdx = -1;
  }

  private disposeVoice(voice: Voice): void {
    this.releaseVoice(voice, true);
    voice.mainSynth?.dispose?.();
    voice.shimmerSynth?.dispose?.();
    voice.pluckSynth?.dispose?.();
    voice.filter?.dispose?.();
    voice.panner?.dispose?.();
    voice.dryGain?.dispose?.();
    voice.wetSend?.dispose?.();
    voice.shimmerGain?.dispose?.();
    voice.pluckGain?.dispose?.();
    voice.reverb?.dispose?.();
    voice.reverbReturn?.dispose?.();
  }

  private setGainNow(node: any, value: number): void {
    const gain = node?.gain;
    if (!gain) return;
    try {
      const now = this.tone?.now?.() ?? 0;
      gain.cancelScheduledValues?.(now);
      if (typeof gain.setValueAtTime === 'function') gain.setValueAtTime(value, now);
      else gain.value = value;
    } catch {
      try { gain.value = value; } catch { /* noop */ }
    }
  }

  private attachMouseListener(): void {
    this.mouseListener = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const xN = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const yN = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
      this.mouseXN = xN;
      this.mouseYN = yN;
      this.mouseLastAtMs = performance.now();
    };
    this.canvas.addEventListener('pointermove', this.mouseListener);
  }

  private attachPane(): void {
    if (!this.paneDock || this.registered) return;
    this.registered = registerTweaks(this.paneDock, 'handSynth', HAND_SYNTH_DEFS, {
      title: 'Hand Synth',
      params: this.params,
      onChange: {
        attack:  () => this.applyEnvelope(),
        release: () => this.applyEnvelope(),
        shimmer: () => this.applyShimmer(),
        pluckDb: () => this.applyPluckGain(),
        duetDb:  () => this.applyDuetVolume(),
        chimeDb: () => this.applyChimeVolume(),
      },
    });
  }

  private applyEnvelope(): void {
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (!v) continue;
      v.mainSynth.envelope.attack = this.params.attack;
      v.mainSynth.envelope.release = this.params.release;
      v.shimmerSynth.envelope.attack = Math.max(0.08, this.params.attack * 1.7);
      v.shimmerSynth.envelope.release = this.params.release * 1.25;
    }
  }

  private applyShimmer(): void {
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (!v) continue;
      v.shimmerGain.gain.rampTo(this.params.shimmer * 0.28, PARAM_RAMP);
    }
  }

  private applyPluckGain(): void {
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (!v) continue;
      v.pluckGain.gain.rampTo(this.tone?.dbToGain(this.params.pluckDb) ?? 0.25, PARAM_RAMP);
    }
  }

  private applyDuetVolume(): void {
    if (this.duetSynth?.volume) this.duetSynth.volume.rampTo(this.params.duetDb, PARAM_RAMP);
  }

  private applyChimeVolume(): void {
    for (const key of PLAYER_KEYS) {
      const c = this.chimeVoices[key];
      if (c?.synth?.volume) c.synth.volume.rampTo(this.params.chimeDb, PARAM_RAMP);
    }
  }
}

function handCoords(hand: HandPose): Coords {
  const xN = clamp((hand.palm.x + HAND_X_RANGE) / (HAND_X_RANGE * 2), 0, 1);
  const yN = clamp((hand.palm.y - HAND_Y_LOW) / (HAND_Y_HIGH - HAND_Y_LOW), 0, 1);
  return { xN, yN };
}

function palmDistance(left: HandPose, right: HandPose): number {
  const x = left.palm.x - right.palm.x;
  const y = left.palm.y - right.palm.y;
  const z = left.palm.z - right.palm.z;
  return Math.sqrt(x * x + y * y + z * z);
}

function pickNoteIndex(yN: number, currentIdx: number, noteCount: number): number {
  const continuous = clamp(yN * noteCount, 0, noteCount - 0.0001);
  if (currentIdx < 0) return Math.floor(continuous);
  if (continuous > currentIdx + 1 + NOTE_HYSTERESIS) {
    return Math.min(noteCount - 1, Math.floor(continuous));
  }
  if (continuous < currentIdx - NOTE_HYSTERESIS) {
    return Math.max(0, Math.floor(continuous));
  }
  return currentIdx;
}

function transposeOctaveDown(note: string): string {
  return transposeInterval(note, -12);
}

function transposeInterval(note: string, semitones: number): string {
  const match = note.match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return note;
  const chroma: Record<string, number> = {
    C: 0,
    'C#': 1,
    D: 2,
    'D#': 3,
    E: 4,
    F: 5,
    'F#': 6,
    G: 7,
    'G#': 8,
    A: 9,
    'A#': 10,
    B: 11,
  };
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const [, name, octaveRaw] = match;
  const midi = (Number(octaveRaw) + 1) * 12 + chroma[name] + semitones;
  const nextName = names[((midi % 12) + 12) % 12];
  const nextOctave = Math.floor(midi / 12) - 1;
  return `${nextName}${nextOctave}`;
}
