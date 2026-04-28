import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import { JamAudioGraph } from './audioGraph';
import { clamp } from './math';
import type { HandPose, PlayerPose } from './types';
import type { InstrumentId, OrbGestureState, VoiceState } from './instruments';
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
  orbDb:         { default: 2,     min: -30, max: 12,   step: 0.5,  label: 'orb dB' },
  orbDecay:      { default: 2.4,   min: 0.4, max: 6,    step: 0.05, label: 'orb decay s' },
  orbHarmonics:  { default: 0.55,  min: 0,   max: 1,    step: 0.01, label: 'orb partials' },
  starlaceDb:    { default: 1,     min: -30, max: 12,   step: 0.5,  label: 'starlace dB' },
  starlaceDecay: { default: 3.2,   min: 0.6, max: 8,    step: 0.05, label: 'starlace decay s' },
  starlaceGlow:  { default: 0.62,  min: 0,   max: 1,    step: 0.01, label: 'starlace glow' },
} as const;

export type HandSynthParams = ParamsOf<typeof HAND_SYNTH_DEFS>;

// D major pentatonic plus color tones. It stays consonant against the train
// bed but gives enough stepwise motion for the visual strings to feel played.
const SCALE_NOTES_LOCAL: string[] = ['D3', 'E3', 'F#3', 'A3', 'B3', 'D4', 'E4', 'F#4', 'A4', 'B4', 'D5', 'E5'];
const SCALE_NOTES_REMOTE: string[] = SCALE_NOTES_LOCAL.map(transposeOctaveDown);
const DUET_NOTES: string[] = ['D2', 'A2', 'D3', 'E3', 'F#3', 'A3', 'B3', 'D4', 'E4', 'A4', 'D5', 'E5'];
const ORB_GESTURE_NOTES: string[] = ['D2', 'A2', 'D3', 'F3', 'G3', 'A3', 'C4', 'D4', 'F4', 'G4', 'A4', 'C5', 'D5'];
const STARLACE_NOTES: string[] = ['D3', 'E3', 'F#3', 'A3', 'B3', 'D4', 'E4', 'F#4', 'A4', 'B4', 'D5', 'E5', 'F#5', 'A5'];

const PRESENCE_THRESHOLD = 0.5;
const PARAM_RAMP = 0.08;
const MOUSE_IDLE_TIMEOUT = 1.2;
const HAND_X_RANGE = 0.6;
const HAND_Y_LOW = 0.4;
const HAND_Y_HIGH = 1.8;
const NOTE_HYSTERESIS = 0.18;
const HIT_BUDGET_WINDOW = 0.2;
const CHIME_MAX_HITS_PER_WINDOW = 6;
const CHIME_MAX_ACTIVE_VOICES = 12;
const ORB_MAX_HITS_PER_WINDOW = 5;
const ORB_MAX_ACTIVE_VOICES = 8;
const STARLACE_MAX_HITS_PER_WINDOW = 8;
const STARLACE_MAX_ACTIVE_VOICES = 14;

type PlayerKey = 'local' | 'remote';
const PLAYER_KEYS: PlayerKey[] = ['local', 'remote'];

type Coords = { xN: number; yN: number };
type Input = {
  pitch: Coords;
  expression: Coords | null;
  handDistance: number;
  bothHands: boolean;
};

type HitBudget = {
  windowStart: number;
  used: number;
  dropped: number;
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

type OrbVoice = {
  // Hang-drum-style additive synth: fundamental FM voice for body/octave +
  // a parallel sine voice at the compound-fifth partial for the
  // characteristic ringing top end.
  fund: any;        // Tone.PolySynth(Tone.FMSynth) — fundamental + octave
  fifth: any;       // Tone.PolySynth(Tone.Synth) — compound fifth partial (1.5x octave)
  auraSynth: any;   // held molten core voice
  subSynth: any;    // deep center pressure
  shimmerSynth: any;// fast-motion glass layer
  auraGain: any;
  subGain: any;
  shimmerGain: any;
  filter: any;      // gentle lowpass — keeps the metal warm, not glassy
  panner: any;
  dryGain: any;
  wetSend: any;
  reverb: any;
  reverbReturn: any;
  pulse: number;
  energy: number;
  pitch: number;
  expression: number;
  tension: number;
  gestureActive: boolean;
  gestureNote: string;
  lastSparkAt: number;
  lastHitCount: number;
  lastNoteIdx: number;
};

type StarlaceVoice = {
  pluck: any;       // Tone.PolySynth(Tone.FMSynth) — luminous string plucks
  glint: any;       // high octave spark on fast swipes
  auraSynth: any;   // sustained pad that blooms from repeated star hits
  auraGain: any;
  filter: any;
  panner: any;
  dryGain: any;
  wetSend: any;
  reverb: any;
  reverbReturn: any;
  pulse: number;
  energy: number;
  pitch: number;
  expression: number;
  tension: number;
  auraActive: boolean;
  auraNote: string;
  lastHitCount: number;
  lastNoteIdx: number;
};

export class HandSynthEngine {
  private tone?: typeof import('tone');
  private running = false;

  private master?: any;
  private voices: Record<PlayerKey, Voice | null> = { local: null, remote: null };
  private chimeVoices: Record<PlayerKey, ChimeVoice | null> = { local: null, remote: null };
  private orbVoices: Record<PlayerKey, OrbVoice | null> = { local: null, remote: null };
  private starlaceVoices: Record<PlayerKey, StarlaceVoice | null> = { local: null, remote: null };
  private chimeBudgets: Record<PlayerKey, HitBudget> = {
    local: { windowStart: 0, used: 0, dropped: 0 },
    remote: { windowStart: 0, used: 0, dropped: 0 },
  };
  private orbBudgets: Record<PlayerKey, HitBudget> = {
    local: { windowStart: 0, used: 0, dropped: 0 },
    remote: { windowStart: 0, used: 0, dropped: 0 },
  };
  private starlaceBudgets: Record<PlayerKey, HitBudget> = {
    local: { windowStart: 0, used: 0, dropped: 0 },
    remote: { windowStart: 0, used: 0, dropped: 0 },
  };
  private orbGestures: Record<PlayerKey, OrbGestureState> = {
    local: inactiveOrbGesture(),
    remote: inactiveOrbGesture(),
  };
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
  private hitBudgetLogAt = 0;
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
    orbDb: HAND_SYNTH_DEFS.orbDb.default,
    orbDecay: HAND_SYNTH_DEFS.orbDecay.default,
    orbHarmonics: HAND_SYNTH_DEFS.orbHarmonics.default,
    starlaceDb: HAND_SYNTH_DEFS.starlaceDb.default,
    starlaceDecay: HAND_SYNTH_DEFS.starlaceDecay.default,
    starlaceGlow: HAND_SYNTH_DEFS.starlaceGlow.default,
  };

  private registered?: ReturnType<typeof registerTweaks<typeof HAND_SYNTH_DEFS>>;

  constructor(
    private audioGraph: JamAudioGraph,
    private canvas: HTMLCanvasElement,
    private paneDock?: HTMLElement
  ) {
    this.attachMouseListener();
  }

  getProfileLabel(player: PlayerKey): string {
    const id = this.pendingInstruments[player];
    if (id === 'chime') return 'Wind Chime';
    if (id === 'orbs') return 'Ripple Orb';
    return 'Aurora Loom';
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
    if (instrument === 'orbs') {
      const o = this.orbVoices[player];
      if (!o) return voiceStateZero();
      return {
        active: o.energy > 0.02,
        energy: o.energy,
        pulse: o.pulse,
        pitch: o.pitch,
        expression: o.expression,
        tension: o.tension,
        noteIndex: o.lastNoteIdx,
        noteCount: ORB_GESTURE_NOTES.length,
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
    const Tone = await this.audioGraph.start();
    this.tone = Tone;

    this.master = new Tone.Gain(Tone.dbToGain(this.params.volumeDb)).connect(this.audioGraph.getBus('instruments'));

    for (const key of PLAYER_KEYS) this.ensureInstrumentVoice(key);
    this.createDuetResonator();
    // Apply initial instrument routing so a stored non-loom instrument starts
    // with only its selected chain audible.
    this.applyInstrumentRouting('local');
    this.applyInstrumentRouting('remote');

    await Promise.all(
      [
        ...PLAYER_KEYS.map(key => this.voices[key]?.reverb?.ready),
        ...PLAYER_KEYS.map(key => this.chimeVoices[key]?.reverb?.ready),
        ...PLAYER_KEYS.map(key => this.orbVoices[key]?.reverb?.ready),
      ]
        .filter(Boolean)
    );

    this.attachPane();
    this.running = true;
  }

  update(local: PlayerPose, remote: PlayerPose, delta: number): void {
    if (!this.running || !this.tone) return;
    this.elapsed += delta;

    if (!this.params.enabled) {
      for (const key of PLAYER_KEYS) {
        this.silenceVoice(key);
        this.silenceChime(key);
        this.silenceOrb(key);
      }
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
        this.ensureChimeVoice(key);
        this.silenceVoice(key);
        this.updateChimeVoice(key, delta);
      } else if (instrument === 'orbs') {
        this.ensureOrbVoice(key);
        this.silenceVoice(key);
        this.updateOrbVoice(key, delta);
      } else {
        this.ensureLoomVoice(key);
        const input = key === 'local' ? localInput : remoteInput;
        this.updateVoice(key, input, delta);
      }
    }
    this.updateDuetResonator(delta);

    this.master.gain.rampTo(this.tone.dbToGain(this.params.volumeDb), PARAM_RAMP);
    this.reportHitBudgetDrops();
  }

  getNotePulse(): number {
    let max = 0;
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (v && v.pulse > max) max = v.pulse;
      const c = this.chimeVoices[key];
      if (c && c.pulse > max) max = c.pulse;
      const o = this.orbVoices[key];
      if (o && o.pulse > max) max = o.pulse;
    }
    return max;
  }

  silenceAll(): void {
    for (const key of PLAYER_KEYS) {
      this.silenceVoice(key);
      this.silenceChime(key);
      this.silenceOrb(key);
    }
    this.releaseDuet(true);
  }

  setMuted(player: PlayerKey, muted: boolean): void {
    if (this.muted[player] === muted) return;
    this.muted[player] = muted;
    if (muted) {
      this.silenceVoice(player);
      this.silenceChime(player);
      this.silenceOrb(player);
    } else {
      this.applyInstrumentRouting(player);
    }
  }

  setInstrument(player: PlayerKey, id: InstrumentId): void {
    if (this.pendingInstruments[player] === id) return;
    this.pendingInstruments[player] = id;
    // Hard-silence the previous chain immediately; updateVoice/updateChimeVoice/
    // updateOrbVoice will bring the new chain to life on the next frame.
    this.silenceVoice(player);
    this.silenceChime(player);
    this.silenceOrb(player);
    if (this.running) this.ensureInstrumentVoice(player);
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

    if (id === 'orbs' && this.running && this.tone) {
      const orb = this.orbVoices[player];
      if (orb) {
        try {
          orb.dryGain.gain.cancelScheduledValues?.(this.tone.now());
          orb.dryGain.gain.setValueAtTime?.(0.95, this.tone.now());
        } catch { /* fallback to ramp */ }
        try {
          this.fireOrbHit(orb, 220, 0.7);
          console.debug('[handSynth] orb test ping fired', { player });
        } catch (err) {
          console.warn('[handSynth] orb test ping failed', err);
        }
      }
    }
  }

  private ensureInstrumentVoice(player: PlayerKey): void {
    const instrument = this.pendingInstruments[player];
    if (instrument === 'chime') this.ensureChimeVoice(player);
    else if (instrument === 'orbs') this.ensureOrbVoice(player);
    else this.ensureLoomVoice(player);
  }

  private ensureLoomVoice(player: PlayerKey): Voice | null {
    if (!this.tone || !this.master) return null;
    if (!this.voices[player]) {
      this.voices[player] = this.createVoice(player, player === 'local' ? SCALE_NOTES_LOCAL : SCALE_NOTES_REMOTE);
    }
    return this.voices[player];
  }

  private ensureChimeVoice(player: PlayerKey): ChimeVoice | null {
    if (!this.tone || !this.master) return null;
    if (!this.chimeVoices[player]) this.chimeVoices[player] = this.createChimeVoice(player);
    return this.chimeVoices[player];
  }

  private ensureOrbVoice(player: PlayerKey): OrbVoice | null {
    if (!this.tone || !this.master) return null;
    if (!this.orbVoices[player]) this.orbVoices[player] = this.createOrbVoice(player);
    return this.orbVoices[player];
  }

  private allowHit(budget: HitBudget, maxHits: number, activeVoices: number, maxActiveVoices: number): boolean {
    const now = this.elapsed;
    if (now - budget.windowStart >= HIT_BUDGET_WINDOW) {
      budget.windowStart = now;
      budget.used = 0;
    }
    if (budget.used >= maxHits || activeVoices >= maxActiveVoices) {
      budget.dropped += 1;
      return false;
    }
    budget.used += 1;
    return true;
  }

  private reportHitBudgetDrops(): void {
    if (this.elapsed - this.hitBudgetLogAt < 4) return;
    const chimeDropped = this.chimeBudgets.local.dropped + this.chimeBudgets.remote.dropped;
    const orbDropped = this.orbBudgets.local.dropped + this.orbBudgets.remote.dropped;
    if (chimeDropped > 0 || orbDropped > 0) {
      console.debug('[handSynth] dropped excess hit events', { chimeDropped, orbDropped });
      for (const key of PLAYER_KEYS) {
        this.chimeBudgets[key].dropped = 0;
        this.orbBudgets[key].dropped = 0;
      }
    }
    this.hitBudgetLogAt = this.elapsed;
  }

  /** Called by the WindChime visual when two gems collide or a gem is poked.
   *  Triggers a brief bell on the chime voice for the given player. */
  triggerChimeHit(player: PlayerKey, frequency: number, velocity: number, gemIndex = -1): void {
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
    const chime = this.ensureChimeVoice(player);
    if (!chime) return;
    if (!Number.isFinite(frequency) || frequency <= 0) return;
    if (!this.allowHit(this.chimeBudgets[player], CHIME_MAX_HITS_PER_WINDOW, chime.synth?.activeVoices ?? 0, CHIME_MAX_ACTIVE_VOICES)) {
      return;
    }
    const v = clamp(velocity, 0, 1);
    // Velocity floor at 0.4 so a soft brush still gives an audible bell.
    const synthVel = 0.4 + v * 0.6;
    try {
      const now = this.tone.now();
      chime.dryGain.gain.cancelScheduledValues?.(now);
      chime.dryGain.gain.setValueAtTime?.(0.95, now);
      chime.wetSend.gain.rampTo(clamp(0.22 + chime.energy * 0.6, 0, 1) * this.params.reverbWetMax, 0.02);
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
    chime.lastNoteIdx = gemIndex >= 0 ? gemIndex % 32 : chime.lastHitCount % 32;
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

  setOrbGesture(player: PlayerKey, gesture: OrbGestureState): void {
    this.orbGestures[player] = {
      active: gesture.active,
      x: clamp(gesture.x, -1, 1),
      y: clamp(gesture.y, -1, 1),
      z: clamp(gesture.z, -1, 1),
      depth: clamp(gesture.depth, 0, 1),
      radius: clamp(gesture.radius, 0, 1),
      speed: clamp(gesture.speed, 0, 1),
      angle: Number.isFinite(gesture.angle) ? gesture.angle : 0,
      intensity: clamp(gesture.intensity, 0, 1),
    };
  }

  /** Called by the OrbDrums visual when an orb is struck. Rings the
   *  hang-drum voice for the given player. */
  triggerOrbHit(player: PlayerKey, frequency: number, velocity: number, orbIndex: number): void {
    if (!this.running || !this.tone) {
      if (!this._loggedOrbBlock) {
        console.warn('[handSynth] orb hit blocked: audio not started yet');
        this._loggedOrbBlock = true;
      }
      return;
    }
    if (this.muted[player]) return;
    if (this.pendingInstruments[player] !== 'orbs') return;
    const orb = this.ensureOrbVoice(player);
    if (!orb) return;
    const activeVoices = Math.max(orb.fund?.activeVoices ?? 0, orb.fifth?.activeVoices ?? 0);
    if (!this.allowHit(this.orbBudgets[player], ORB_MAX_HITS_PER_WINDOW, activeVoices, ORB_MAX_ACTIVE_VOICES)) {
      return;
    }
    const v = clamp(velocity, 0, 1);
    this.fireOrbHit(orb, frequency, v);
    if (!this._loggedOrbFirstHit) {
      console.debug('[handSynth] first orb hit', { player, frequency, velocity: v });
      this._loggedOrbFirstHit = true;
    }
    orb.pulse = Math.min(1, orb.pulse + 0.55 + v * 0.45);
    orb.energy = Math.min(1, orb.energy + 0.18 + v * 0.22);
    orb.lastNoteIdx = orbIndex;
    orb.lastHitCount += 1;
  }
  private _loggedOrbFirstHit = false;
  private _loggedOrbBlock = false;

  getActivity(): number {
    let local = this.voices.local?.energy ?? 0;
    let remote = this.voices.remote?.energy ?? 0;
    local = Math.max(local, this.chimeVoices.local?.energy ?? 0);
    remote = Math.max(remote, this.chimeVoices.remote?.energy ?? 0);
    local = Math.max(local, this.orbVoices.local?.energy ?? 0);
    remote = Math.max(remote, this.orbVoices.remote?.energy ?? 0);
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
      const o = this.orbVoices[key];
      if (o) {
        this.disposeOrbVoice(o);
        this.orbVoices[key] = null;
      }
    }
    this.releaseDuet(true);
    this.duetSynth?.dispose?.();
    this.duetFilter?.dispose?.();
    this.duetGain?.dispose?.();
    this.master?.dispose?.();
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
    synth.maxPolyphony = CHIME_MAX_ACTIVE_VOICES;

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
    const orb = this.orbVoices[player];
    if (instrument === 'chime') {
      if (voice) this.releaseVoice(voice, false);
      if (orb) this.silenceOrb(player);
    } else if (instrument === 'orbs') {
      if (voice) this.releaseVoice(voice, false);
      if (chime) this.silenceChime(player);
    } else {
      if (chime) this.silenceChime(player);
      if (orb) this.silenceOrb(player);
    }
  }

  private createOrbVoice(key: PlayerKey): OrbVoice {
    const Tone = this.tone!;
    const panner = new Tone.Panner(key === 'local' ? -0.15 : 0.15).connect(this.master);
    const dryGain = new Tone.Gain(0).connect(panner);
    const reverbReturn = new Tone.Gain(0.7).connect(panner);
    const reverb = new Tone.Reverb({
      decay: 5.4,
      preDelay: 0.018,
      wet: 1,
    }).connect(reverbReturn);
    const wetSend = new Tone.Gain(0).connect(reverb);
    const filter = new Tone.Filter({
      frequency: 5200,
      type: 'lowpass',
      rolloff: -12,
      Q: 0.5,
    });
    filter.connect(dryGain);
    filter.connect(wetSend);

    // Fundamental + octave partial (FM with harmonicity=2 gives strong octave).
    // Fast attack + medium-long exponential decay = handpan body.
    const fund = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 2,
      modulationIndex: 6,
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: this.params.orbDecay, sustain: 0, release: this.params.orbDecay * 0.6 },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.5 },
      volume: this.params.orbDb,
    }).connect(filter);
    fund.maxPolyphony = ORB_MAX_ACTIVE_VOICES;

    // Compound-fifth partial — sine voice +19 semitones (octave + perfect
    // fifth) at lower volume, scaled by the harmonics knob. This is the
    // classic shimmer that distinguishes a hang from a plain bell.
    const fifth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.003, decay: this.params.orbDecay * 0.7, sustain: 0, release: this.params.orbDecay * 0.4 },
      volume: this.params.orbDb - 14,
    }).connect(filter);
    fifth.maxPolyphony = ORB_MAX_ACTIVE_VOICES;

    const auraGain = new Tone.Gain(0).connect(filter);
    const subGain = new Tone.Gain(0).connect(filter);
    const shimmerGain = new Tone.Gain(0).connect(filter);

    const auraSynth = new Tone.Synth({
      oscillator: { type: 'fatsine4', count: 4, spread: 22 } as any,
      envelope: { attack: 0.18, decay: 0.34, sustain: 0.82, release: 1.45 },
      portamento: 0.075,
      volume: this.params.orbDb - 8,
    }).connect(auraGain);

    const subSynth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.30, decay: 0.28, sustain: 0.74, release: 1.8 },
      portamento: 0.12,
      volume: this.params.orbDb - 12,
    }).connect(subGain);

    const shimmerSynth = new Tone.Synth({
      oscillator: { type: 'triangle8' } as any,
      envelope: { attack: 0.055, decay: 0.22, sustain: 0.42, release: 0.85 },
      portamento: 0.045,
      volume: this.params.orbDb - 18,
    }).connect(shimmerGain);

    return {
      fund,
      fifth,
      auraSynth,
      subSynth,
      shimmerSynth,
      auraGain,
      subGain,
      shimmerGain,
      filter,
      panner,
      dryGain,
      wetSend,
      reverb,
      reverbReturn,
      pulse: 0,
      energy: 0,
      pitch: 0.5,
      expression: 0.5,
      tension: 0.35,
      gestureActive: false,
      gestureNote: '',
      lastSparkAt: -Infinity,
      lastHitCount: 0,
      lastNoteIdx: -1,
    };
  }

  private updateOrbVoice(player: PlayerKey, delta: number): void {
    const orb = this.orbVoices[player];
    if (!orb || !this.tone) return;
    if (this.muted[player]) {
      this.silenceOrb(player);
      return;
    }

    const gesture = this.orbGestures[player];
    const gestureActive = gesture.active && this.pendingInstruments[player] === 'orbs';
    if (gestureActive) {
      const angleN = (gesture.angle + Math.PI) / (Math.PI * 2);
      const heightN = clamp(gesture.y * 0.5 + 0.5, 0, 1);
      const speed = clamp(gesture.speed, 0, 1);
      const depth = clamp(gesture.depth, 0, 1);
      const radial = clamp(gesture.radius, 0, 1);
      const pitchT = clamp(heightN * 0.42 + angleN * 0.24 + depth * 0.24 + speed * 0.10, 0, 1);
      const noteIndex = pickNoteIndex(pitchT, orb.lastNoteIdx, ORB_GESTURE_NOTES.length);
      const note = ORB_GESTURE_NOTES[noteIndex];
      const subNote = transposeInterval(note, -12);
      const shimmerNote = transposeInterval(note, speed > 0.62 ? 19 : 12);

      if (!orb.gestureActive) {
        try {
          orb.auraSynth.triggerAttack(note);
          orb.subSynth.triggerAttack(subNote);
          orb.shimmerSynth.triggerAttack(shimmerNote);
        } catch (err) {
          console.warn('[handSynth] orb gesture attack failed', err);
        }
        orb.gestureActive = true;
      } else if (note !== orb.gestureNote) {
        try {
          orb.auraSynth.setNote(note);
          orb.subSynth.setNote(subNote);
          orb.shimmerSynth.setNote(shimmerNote);
        } catch (err) {
          console.warn('[handSynth] orb gesture retune failed', err);
        }
      } else {
        try {
          orb.auraSynth.setNote(note);
          orb.subSynth.setNote(subNote);
          orb.shimmerSynth.setNote(shimmerNote);
        } catch { /* best-effort continuous retune */ }
      }

      const fineBend = gesture.x * 18 + gesture.z * 9 + speed * 16;
      try {
        orb.auraSynth.detune?.rampTo?.(fineBend, PARAM_RAMP);
        orb.subSynth.detune?.rampTo?.(fineBend * 0.35, PARAM_RAMP * 1.5);
        orb.shimmerSynth.detune?.rampTo?.(fineBend * 1.8, PARAM_RAMP);
      } catch { /* detune is optional on Tone nodes */ }

      const aura = clamp(0.06 + depth * 0.38 + speed * 0.20 + gesture.intensity * 0.12, 0, 0.72);
      const sub = clamp(depth * depth * 0.40 + (1 - radial) * 0.12, 0, 0.50);
      const shimmer = clamp(speed * 0.36 + Math.max(0, gesture.y) * 0.10, 0, 0.46);
      orb.auraGain.gain.rampTo(aura, PARAM_RAMP);
      orb.subGain.gain.rampTo(sub, PARAM_RAMP * 1.4);
      orb.shimmerGain.gain.rampTo(shimmer, PARAM_RAMP);

      const filterHz = 420 + depth * 1800 + speed * 5600 + heightN * 1200;
      orb.filter.frequency.rampTo(clamp(filterHz, 240, 9200), PARAM_RAMP);
      orb.filter.Q.rampTo(0.45 + depth * 1.1 + speed * 3.2, PARAM_RAMP);
      orb.panner.pan.rampTo(clamp((player === 'local' ? -0.10 : 0.10) + gesture.x * 0.36, -0.85, 0.85), PARAM_RAMP);

      const sparkGap = 0.16 - speed * 0.085;
      if (speed > 0.58 && this.elapsed - orb.lastSparkAt > sparkGap) {
        try {
          const sparkVel = clamp(0.18 + speed * 0.72 + depth * 0.12, 0, 1);
          orb.fifth.triggerAttackRelease(shimmerNote, '16n', undefined, sparkVel * 0.42);
        } catch { /* spark is ornamental */ }
        orb.lastSparkAt = this.elapsed;
        orb.pulse = Math.max(orb.pulse, clamp(0.35 + speed * 0.5, 0, 1));
      }

      orb.gestureNote = note;
      orb.lastNoteIdx = noteIndex;
      orb.pitch += (pitchT - orb.pitch) * (1 - Math.exp(-delta * 10));
      orb.expression += (depth - orb.expression) * (1 - Math.exp(-delta * 8));
      orb.tension += (speed - orb.tension) * (1 - Math.exp(-delta * 9));
      const targetEnergy = clamp(0.12 + depth * 0.42 + speed * 0.46 + gesture.intensity * 0.20, 0, 1);
      orb.energy += (targetEnergy - orb.energy) * (1 - Math.exp(-delta * 7));
      orb.pulse = Math.max(0, orb.pulse - delta * 2.2);
    } else {
      this.releaseOrbGesture(orb, false);
      orb.energy += (0 - orb.energy) * (1 - Math.exp(-delta * 3.6));
      orb.tension += (0.35 - orb.tension) * (1 - Math.exp(-delta * 4));
      orb.pulse = Math.max(0, orb.pulse - delta * 3.0);
    }

    // Wet send rises with energy — more reverb tail when actively playing.
    const wet = clamp(0.24 + orb.energy * 0.58 + (gestureActive ? gesture.depth * 0.16 : 0), 0, 1);
    orb.wetSend.gain.rampTo(wet * this.params.reverbWetMax, PARAM_RAMP * 2);
    orb.dryGain.gain.rampTo(0.95, PARAM_RAMP);
  }

  private silenceOrb(player: PlayerKey): void {
    const orb = this.orbVoices[player];
    if (!orb) return;
    this.releaseOrbGesture(orb, true);
    try { orb.fund.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    try { orb.fifth.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    this.setGainNow(orb.dryGain, 0);
    this.setGainNow(orb.wetSend, 0);
    orb.pulse = 0;
    orb.energy = 0;
  }

  private releaseOrbGesture(orb: OrbVoice, immediate: boolean): void {
    if (!orb.gestureActive && !immediate) {
      orb.auraGain.gain.rampTo(0, PARAM_RAMP * 2);
      orb.subGain.gain.rampTo(0, PARAM_RAMP * 2);
      orb.shimmerGain.gain.rampTo(0, PARAM_RAMP * 2);
      return;
    }
    try {
      orb.auraSynth.triggerRelease?.(this.tone?.now?.());
      orb.subSynth.triggerRelease?.(this.tone?.now?.());
      orb.shimmerSynth.triggerRelease?.(this.tone?.now?.());
    } catch (err) {
      console.warn('[handSynth] orb gesture release failed', err);
    }
    if (immediate) {
      this.setGainNow(orb.auraGain, 0);
      this.setGainNow(orb.subGain, 0);
      this.setGainNow(orb.shimmerGain, 0);
    } else {
      orb.auraGain.gain.rampTo(0, PARAM_RAMP * 2);
      orb.subGain.gain.rampTo(0, PARAM_RAMP * 2);
      orb.shimmerGain.gain.rampTo(0, PARAM_RAMP * 2);
    }
    orb.gestureActive = false;
    orb.gestureNote = '';
  }

  private disposeOrbVoice(orb: OrbVoice): void {
    this.releaseOrbGesture(orb, true);
    try { orb.fund?.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    try { orb.fifth?.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    orb.fund?.dispose?.();
    orb.fifth?.dispose?.();
    orb.auraSynth?.dispose?.();
    orb.subSynth?.dispose?.();
    orb.shimmerSynth?.dispose?.();
    orb.auraGain?.dispose?.();
    orb.subGain?.dispose?.();
    orb.shimmerGain?.dispose?.();
    orb.filter?.dispose?.();
    orb.panner?.dispose?.();
    orb.dryGain?.dispose?.();
    orb.wetSend?.dispose?.();
    orb.reverb?.dispose?.();
    orb.reverbReturn?.dispose?.();
  }

  private fireOrbHit(orb: OrbVoice, frequency: number, velocity: number): void {
    // Velocity floor at 0.35 so a soft tap still rings audibly.
    const synthVel = 0.35 + velocity * 0.65;
    const fifthHz = frequency * 3.0; // octave + fifth (3x fundamental)
    const harmonics = clamp(this.params.orbHarmonics, 0, 1);
    try {
      orb.fund.triggerAttackRelease(frequency, this.params.orbDecay, undefined, synthVel);
      if (harmonics > 0.02) {
        orb.fifth.triggerAttackRelease(fifthHz, this.params.orbDecay * 0.7, undefined, synthVel * harmonics * 0.55);
      }
    } catch (err) {
      console.warn('[handSynth] orb trigger failed', err);
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
        orbDb:   () => this.applyOrbVolume(),
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

  private applyOrbVolume(): void {
    for (const key of PLAYER_KEYS) {
      const o = this.orbVoices[key];
      if (o?.fund?.volume) o.fund.volume.rampTo(this.params.orbDb, PARAM_RAMP);
      if (o?.fifth?.volume) o.fifth.volume.rampTo(this.params.orbDb - 14, PARAM_RAMP);
      if (o?.auraSynth?.volume) o.auraSynth.volume.rampTo(this.params.orbDb - 8, PARAM_RAMP);
      if (o?.subSynth?.volume) o.subSynth.volume.rampTo(this.params.orbDb - 12, PARAM_RAMP);
      if (o?.shimmerSynth?.volume) o.shimmerSynth.volume.rampTo(this.params.orbDb - 18, PARAM_RAMP);
    }
  }
}

function inactiveOrbGesture(): OrbGestureState {
  return {
    active: false,
    x: 0,
    y: 0,
    z: 0,
    depth: 0,
    radius: 0,
    speed: 0,
    angle: 0,
    intensity: 0,
  };
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
