import { JamAudioGraph } from './audioGraph';
import {
  getDuetNotes,
  getOrbGestureNotes,
  getPlayableNotesLocal,
  getPlayableNotesRemote,
  getStarlaceChords,
  getStarlaceNotes,
  type JamStarlaceChord,
} from './harmony';
import { keyDirector } from './keyDirector';
import { clamp } from './math';
import type { HandPose, PlayerPose } from './types';
import type { InstrumentId, OrbEnvelopeSettings, OrbGestureState, VoiceState } from './instruments';
import { DEFAULT_ORB_ENVELOPE, voiceStateZero } from './instruments';

// All playable voices use the shared Jam Train scale so the visual hit
// instruments and sustained synth layers stay melodically locked together.

const PRESENCE_THRESHOLD = 0.5;
const PARAM_RAMP = 0.08;
const MOUSE_IDLE_TIMEOUT = 1.2;
const HAND_X_RANGE = 0.6;
const HAND_Y_LOW = 0.4;
const HAND_Y_HIGH = 1.8;
const NOTE_HYSTERESIS = 0.18;
const HIT_BUDGET_WINDOW = 0.2;
const ORB_MAX_HITS_PER_WINDOW = 12;
const ORB_MAX_ACTIVE_VOICES = 24;
const ORB_OUTPUT_LIMITER_DB = -9;
const STARLACE_MAX_HITS_PER_WINDOW = 5;
const STARLACE_MAX_ACTIVE_VOICES = 40;
const STARLACE_GLINT_MAX_ACTIVE_VOICES = 10;
const MAX_PENDING_ORB_HITS = 12;
const ORB_OCTAVE_MULTIPLIER = 2;
const VOICE_RELEASE_MARGIN = 0.08;

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

type PendingOrbHit = {
  player: PlayerKey;
  frequency: number;
  velocity: number;
  orbIndex: number;
};

type StarlacePluckOptions = {
  chordRootIndex?: number;
  chordSize?: number;
  phraseStep?: number;
};

type OrbNoteLedgerEntry = {
  frequency: number;
  octaveHz: number;
  releaseAt: number;
};

type NoteLedgerEntry = {
  note: string;
  releaseAt: number;
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

type OrbVoice = {
  // Analog-piano-pad voice: a mellow FM tine, a soft octave body, and held
  // gesture pads. Field names stay stable because the visual still emits orb
  // events and existing tweak storage uses the orb keys.
  fund: any;        // Tone.PolySynth(Tone.FMSynth) — mellow piano tine
  fifth: any;       // Tone.PolySynth(Tone.Synth) — soft octave/body partial
  auraSynth: any;   // held piano pad voice
  subSynth: any;    // quiet lower octave support
  shimmerSynth: any;// gentle upper pad layer
  chorus: any;
  auraGain: any;
  subGain: any;
  shimmerGain: any;
  filter: any;      // gentle lowpass — keeps the pad warm, not glassy
  panner: any;
  limiter: any;
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
  plucks: any[];    // Tone.PluckSynth pool — nylon-string attacks
  pluckCursor: number;
  body: any;        // Tone.PolySynth(Tone.Synth) — warm guitar body resonance
  glint: any;       // quiet nail/string edge on stronger gestures
  auraSynth: any;   // sustained sympathetic body resonance
  auraGain: any;
  filter: any;
  panner: any;
  dryGain: any;
  wetSend: any;
  echo: any;
  reverb: any;
  reverbReturn: any;
  pulse: number;
  energy: number;
  pitch: number;
  expression: number;
  tension: number;
  auraActive: boolean;
  auraChordKey: string;
  lastHitCount: number;
  lastNoteIdx: number;
  lastChordIndex: number;
  lastChordNotes: string[];
  lastAudioAt: number;
  lastAuraRetuneAt: number;
};

export class HandSynthEngine {
  private tone?: typeof import('tone');
  private running = false;

  private master?: any;
  private voices: Record<PlayerKey, Voice | null> = { local: null, remote: null };
  private orbVoices: Record<PlayerKey, OrbVoice | null> = { local: null, remote: null };
  private starlaceVoices: Record<PlayerKey, StarlaceVoice | null> = { local: null, remote: null };
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
  private orbHeldNotes: Record<PlayerKey, Map<string, { frequency: number; octaveHz: number; orbIndex: number }>> = {
    local: new Map(),
    remote: new Map(),
  };
  private orbTransientNotes: Record<PlayerKey, OrbNoteLedgerEntry[]> = {
    local: [],
    remote: [],
  };
  private starlaceTransientNotes: Record<PlayerKey, NoteLedgerEntry[]> = {
    local: [],
    remote: [],
  };
  private starlaceGlintNotes: Record<PlayerKey, NoteLedgerEntry[]> = {
    local: [],
    remote: [],
  };
  private pendingOrbHits: PendingOrbHit[] = [];
  private pendingInstruments: Record<PlayerKey, InstrumentId> = { local: 'drum', remote: 'drum' };
  private muted: Record<PlayerKey, boolean> = { local: false, remote: false };
  private robotPartnerActive = false;
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
  private mouseInputEnabled = true;
  private mouseListener?: (e: PointerEvent) => void;

  private params = {
    enabled: true,
    volumeDb: -6,
    filterMinHz: 260,
    filterMaxHz: 6400,
    filterQ: 1.2,
    attack: 0.11,
    release: 1.85,
    shimmer: 0.38,
    reverbWetMax: 0.80,
    pluckDb: -9,
    duetDb: -19,
    mouseEnabled: true,
    orbDb: -5,
    orbHarmonics: 0.24,
    starlaceDb: -2,
    starlaceAttack: 0.006,
    starlaceHold: 0.56,
    starlaceDecay: 1.85,
    starlaceSustain: 0.16,
    starlaceNoteGap: 0.18,
    starlaceRichness: 0.48,
    starlaceVoiceCap: 30,
    starlaceBrightness: 0.46,
    starlaceOvertones: 0.42,
    starlaceGlint: 0.20,
    starlaceGlow: 0.50,
    starlaceSpace: 0.86,
  };

  // Cached note tables for the current key — refreshed by the KeyDirector
  // subscription so consumers (voices, orb gestures, starlace, duet) see new
  // pitches as soon as the tour steps to a new key.
  private playableLocal: string[] = getPlayableNotesLocal(keyDirector.getCurrent());
  private playableRemote: string[] = getPlayableNotesRemote(keyDirector.getCurrent());
  private duetNotes: string[] = getDuetNotes(keyDirector.getCurrent());
  private orbGestureNotes: string[] = getOrbGestureNotes(keyDirector.getCurrent());
  private starlaceNotes: string[] = getStarlaceNotes(keyDirector.getCurrent());
  private starlaceChords: JamStarlaceChord[] = getStarlaceChords(keyDirector.getCurrent());
  private keyUnsubscribe?: () => void;

  constructor(
    private audioGraph: JamAudioGraph,
    private canvas: HTMLCanvasElement
  ) {
    this.attachMouseListener();
    this.keyUnsubscribe = keyDirector.onChange(({ current }) => {
      this.playableLocal = getPlayableNotesLocal(current);
      this.playableRemote = getPlayableNotesRemote(current);
      this.duetNotes = getDuetNotes(current);
      this.orbGestureNotes = getOrbGestureNotes(current);
      this.starlaceNotes = getStarlaceNotes(current);
      this.starlaceChords = getStarlaceChords(current);
      // Existing voices keep singing notes they already triggered (they decay
      // out on their old key). New strikes pick up the new scale via the
      // refreshed `voice.scale` reference below.
      const lv = this.voices.local;
      if (lv) lv.scale = this.playableLocal;
      const rv = this.voices.remote;
      if (rv) rv.scale = this.playableRemote;
    });
  }

  getProfileLabel(player: PlayerKey): string {
    const id = this.pendingInstruments[player];
    if (id === 'starlace') return 'Starlace';
    return 'Piano Pads';
  }

  getInstrument(player: PlayerKey): InstrumentId {
    return this.pendingInstruments[player];
  }

  setMouseInputEnabled(enabled: boolean): void {
    if (this.mouseInputEnabled === enabled) return;
    this.mouseInputEnabled = enabled;
    this.clearMouseState();
  }

  getVoiceState(player: PlayerKey): VoiceState {
    const instrument = this.pendingInstruments[player];
    if (instrument === 'starlace') {
      const s = this.starlaceVoices[player];
      if (!s) return voiceStateZero();
      return {
        active: s.energy > 0.02,
        energy: s.energy,
        pulse: s.pulse,
        pitch: s.pitch,
        expression: s.expression,
        tension: s.tension,
        noteIndex: s.lastNoteIdx,
        noteCount: this.starlaceNotes.length,
      };
    }
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
      noteCount: this.orbGestureNotes.length,
    };
  }

  setMasterGain(value: number): void {
    // Keep the middle of the mixer usable while letting 100% reach the graph
    // at unity; the final compressor/limiter catches summed peaks.
    const MAX_SYNTH_GAIN = 1.0;
    const CURVE_EXP = 1.2;
    const v = value <= 0 ? 0 : Math.min(1, value);
    const linear = MAX_SYNTH_GAIN * Math.pow(v, CURVE_EXP);
    this.params.volumeDb = linear > 0.0001 ? 20 * Math.log10(linear) : -60;
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
    this.running = true;
    this.flushPendingOrbHits();

    await Promise.all(
      [
        ...PLAYER_KEYS.map(key => this.voices[key]?.reverb?.ready),
        ...PLAYER_KEYS.map(key => this.orbVoices[key]?.reverb?.ready),
        ...PLAYER_KEYS.map(key => this.starlaceVoices[key]?.reverb?.ready),
      ]
        .filter(Boolean)
    );
  }

  update(local: PlayerPose, remote: PlayerPose, delta: number): void {
    if (!this.running || !this.tone) return;
    this.elapsed += delta;
    this.pruneVoiceLedgers();

    if (!this.params.enabled) {
      for (const key of PLAYER_KEYS) {
        this.silenceVoice(key);
        this.silenceOrb(key);
        this.silenceStarlace(key);
      }
      this.updateDuetResonator(delta);
      return;
    }

    const mouseAgeSec = (performance.now() - this.mouseLastAtMs) / 1000;
    const mouseFresh = this.mouseInputEnabled && this.params.mouseEnabled && mouseAgeSec < MOUSE_IDLE_TIMEOUT;
    const localInput = this.resolveInput(local, mouseFresh ? { xN: this.mouseXN, yN: this.mouseYN } : null);
    const remoteInput = this.resolveInput(remote, null);

    for (const key of PLAYER_KEYS) {
      const instrument = this.pendingInstruments[key];
      if (instrument === 'starlace') {
        this.ensureStarlaceVoice(key);
        this.updateStarlaceVoice(key, delta);
      } else {
        this.ensureOrbVoice(key);
        this.updateOrbVoice(key, delta);
      }
    }
    void localInput;
    void remoteInput;
    this.updateDuetResonator(delta);

    this.master.gain.rampTo(this.tone.dbToGain(this.params.volumeDb), PARAM_RAMP);
    this.reportHitBudgetDrops();
  }

  getNotePulse(): number {
    let max = 0;
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (v && v.pulse > max) max = v.pulse;
      const o = this.orbVoices[key];
      if (o && o.pulse > max) max = o.pulse;
      const s = this.starlaceVoices[key];
      if (s && s.pulse > max) max = s.pulse;
    }
    return max;
  }

  silenceAll(): void {
    for (const key of PLAYER_KEYS) {
      this.silenceVoice(key);
      this.silenceOrb(key);
      this.silenceStarlace(key);
    }
    this.releaseDuet(true);
  }

  setMuted(player: PlayerKey, muted: boolean): void {
    if (this.muted[player] === muted) return;
    this.muted[player] = muted;
    if (muted) {
      this.silenceVoice(player);
      this.silenceOrb(player);
      this.silenceStarlace(player);
    } else {
      this.applyInstrumentRouting(player);
    }
  }

  setRobotPartnerActive(active: boolean): void {
    this.robotPartnerActive = active;
  }

  setInstrument(player: PlayerKey, id: InstrumentId): void {
    if (this.pendingInstruments[player] === id) return;
    this.pendingInstruments[player] = id;
    // Hard-silence the previous chain immediately; updateOrbVoice/
    // updateStarlaceVoice will bring the new chain to life on the next frame.
    this.silenceVoice(player);
    this.silenceOrb(player);
    this.silenceStarlace(player);
    if (this.running) this.ensureInstrumentVoice(player);
    this.applyInstrumentRouting(player);

    if (id === 'drum' && this.running && this.tone) {
      const orb = this.orbVoices[player];
      if (orb) {
        try {
          orb.dryGain.gain.cancelScheduledValues?.(this.tone.now());
          orb.dryGain.gain.setValueAtTime?.(0.95, this.tone.now());
        } catch { /* fallback to ramp */ }
        try {
          this.fireOrbHit(orb, 220, 0.7);
          console.debug('[handSynth] piano pad test ping fired', { player });
        } catch (err) {
          console.warn('[handSynth] piano pad test ping failed', err);
        }
      }
    }

    if (id === 'starlace' && this.running && this.tone) {
      const starlace = this.starlaceVoices[player];
      if (starlace) {
        try {
          starlace.dryGain.gain.cancelScheduledValues?.(this.tone.now());
          starlace.dryGain.gain.setValueAtTime?.(0.95, this.tone.now());
        } catch { /* fallback to ramp */ }
        try {
          this.fireStarlaceChord(starlace, this.starlaceChordForIndex(7), 0.7);
          console.debug('[handSynth] starlace test ping fired', { player });
        } catch (err) {
          console.warn('[handSynth] starlace test ping failed', err);
        }
      }
    }
  }

  private ensureInstrumentVoice(player: PlayerKey): void {
    const instrument = this.pendingInstruments[player];
    if (instrument === 'starlace') this.ensureStarlaceVoice(player);
    else this.ensureOrbVoice(player);
  }

  private ensureLoomVoice(player: PlayerKey): Voice | null {
    if (!this.tone || !this.master) return null;
    if (!this.voices[player]) {
      this.voices[player] = this.createVoice(player, player === 'local' ? this.playableLocal : this.playableRemote);
    }
    return this.voices[player];
  }

  private ensureOrbVoice(player: PlayerKey): OrbVoice | null {
    if (!this.tone || !this.master) return null;
    if (!this.orbVoices[player]) this.orbVoices[player] = this.createOrbVoice(player);
    return this.orbVoices[player];
  }

  private ensureStarlaceVoice(player: PlayerKey): StarlaceVoice | null {
    if (!this.tone || !this.master) return null;
    if (!this.starlaceVoices[player]) this.starlaceVoices[player] = this.createStarlaceVoice(player);
    return this.starlaceVoices[player];
  }

  private allowHit(budget: HitBudget, maxHits: number): boolean {
    const now = this.elapsed;
    if (now - budget.windowStart >= HIT_BUDGET_WINDOW) {
      budget.windowStart = now;
      budget.used = 0;
    }
    if (budget.used >= maxHits) {
      budget.dropped += 1;
      return false;
    }
    budget.used += 1;
    return true;
  }

  private reportHitBudgetDrops(): void {
    if (this.elapsed - this.hitBudgetLogAt < 4) return;
    const orbDropped = this.orbBudgets.local.dropped + this.orbBudgets.remote.dropped;
    const starlaceDropped = this.starlaceBudgets.local.dropped + this.starlaceBudgets.remote.dropped;
    if (orbDropped > 0 || starlaceDropped > 0) {
      console.debug('[handSynth] dropped excess hit events', { orbDropped, starlaceDropped });
      for (const key of PLAYER_KEYS) {
        this.orbBudgets[key].dropped = 0;
        this.starlaceBudgets[key].dropped = 0;
      }
    }
    this.hitBudgetLogAt = this.elapsed;
  }

  private pruneVoiceLedgers(): void {
    for (const key of PLAYER_KEYS) {
      this.orbTransientNotes[key] = this.orbTransientNotes[key].filter(entry => entry.releaseAt > this.elapsed);
      this.starlaceTransientNotes[key] = this.starlaceTransientNotes[key].filter(entry => entry.releaseAt > this.elapsed);
      this.starlaceGlintNotes[key] = this.starlaceGlintNotes[key].filter(entry => entry.releaseAt > this.elapsed);
    }
  }

  private reserveOrbVoiceRoom(player: PlayerKey, orb: OrbVoice, needed: number): void {
    if (needed <= 0) return;
    let active = Math.max(orb.fund?.activeVoices ?? 0, orb.fifth?.activeVoices ?? 0);
    while (active + needed > ORB_MAX_ACTIVE_VOICES) {
      if (this.releaseOldestOrbTransient(player, orb) || this.releaseOldestOrbHeld(player, orb)) {
        active = Math.max(0, active - 1);
        continue;
      }
      break;
    }
  }

  private releaseOldestOrbTransient(player: PlayerKey, orb: OrbVoice): boolean {
    const entry = this.orbTransientNotes[player].shift();
    if (!entry) return false;
    const now = this.tone?.now?.();
    try { orb.fund.triggerRelease(entry.frequency, now); } catch { /* best-effort voice steal */ }
    try { orb.fifth.triggerRelease(entry.octaveHz, now); } catch { /* best-effort voice steal */ }
    return true;
  }

  private releaseOldestOrbHeld(player: PlayerKey, orb: OrbVoice): boolean {
    const first = this.orbHeldNotes[player].entries().next();
    if (first.done) return false;
    const [sourceId, held] = first.value;
    this.orbHeldNotes[player].delete(sourceId);
    const now = this.tone?.now?.();
    try { orb.fund.triggerRelease(held.frequency, now); } catch { /* best-effort voice steal */ }
    try { orb.fifth.triggerRelease(held.octaveHz, now); } catch { /* best-effort voice steal */ }
    return true;
  }

  private rememberOrbTransient(player: PlayerKey, frequency: number, octaveHz: number, releaseAt: number): void {
    this.orbTransientNotes[player].push({ frequency, octaveHz, releaseAt });
  }

  private reserveStarlaceVoiceRoom(player: PlayerKey, starlace: StarlaceVoice, neededPluck: number, neededGlint: number): void {
    const cap = this.starlaceVoiceCap();
    let activePlucks = this.starlaceTransientNotes[player].length;
    while (activePlucks + neededPluck > cap) {
      if (!this.releaseOldestStarlaceNote(player, starlace)) break;
      activePlucks = Math.max(0, activePlucks - 1);
    }

    const glintCap = Math.min(STARLACE_GLINT_MAX_ACTIVE_VOICES, Math.max(4, Math.ceil(cap * 0.35)));
    let activeGlints = starlace.glint?.activeVoices ?? 0;
    while (activeGlints + neededGlint > glintCap) {
      if (!this.releaseOldestStarlaceGlint(player, starlace)) break;
      activeGlints = Math.max(0, activeGlints - 1);
    }
  }

  private releaseOldestStarlaceNote(player: PlayerKey, starlace: StarlaceVoice): boolean {
    const entry = this.starlaceTransientNotes[player].shift();
    if (!entry) return false;
    try { starlace.body.triggerRelease(entry.note, this.tone?.now?.()); } catch { /* best-effort voice steal */ }
    return true;
  }

  private releaseOldestStarlaceGlint(player: PlayerKey, starlace: StarlaceVoice): boolean {
    const entry = this.starlaceGlintNotes[player].shift();
    if (!entry) return false;
    try { starlace.glint.triggerRelease(entry.note, this.tone?.now?.()); } catch { /* best-effort voice steal */ }
    return true;
  }

  private rememberStarlaceTransient(player: PlayerKey, notes: readonly string[], releaseAt: number): void {
    for (const note of notes) this.starlaceTransientNotes[player].push({ note, releaseAt });
  }

  private rememberStarlaceGlint(player: PlayerKey, note: string, releaseAt: number): void {
    this.starlaceGlintNotes[player].push({ note, releaseAt });
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

  /** Called by the Piano Pads visual when an orb is struck. Rings the
   *  analog-piano-pad voice for the given player. */
  triggerOrbHit(
    player: PlayerKey,
    frequency: number,
    velocity: number,
    orbIndex: number,
    envelope: OrbEnvelopeSettings = DEFAULT_ORB_ENVELOPE,
  ): void {
    if (!this.running || !this.tone) {
      this.queuePendingOrbHit(player, frequency, velocity, orbIndex);
      if (!this._loggedOrbBlock) {
        console.debug('[handSynth] orb hit queued until audio starts');
        this._loggedOrbBlock = true;
      }
      return;
    }
    if (this.muted[player]) return;
    if (this.pendingInstruments[player] !== 'drum') return;
    const orb = this.ensureOrbVoice(player);
    if (!orb) return;
    if (!this.allowHit(this.orbBudgets[player], ORB_MAX_HITS_PER_WINDOW)) {
      return;
    }
    const v = clamp(velocity, 0, 1);
    this.reserveOrbVoiceRoom(player, orb, 1);
    const duration = this.fireOrbHit(orb, frequency, v, envelope);
    this.rememberOrbTransient(player, frequency, frequency * ORB_OCTAVE_MULTIPLIER, this.elapsed + duration + Math.max(0.002, envelope.release) + VOICE_RELEASE_MARGIN);
    if (!this._loggedOrbFirstHit) {
      console.debug('[handSynth] first orb hit', { player, frequency, velocity: v });
      this._loggedOrbFirstHit = true;
    }
    orb.pulse = Math.min(1, orb.pulse + 0.55 + v * 0.45);
    orb.energy = Math.min(1, orb.energy + 0.18 + v * 0.22);
    orb.lastNoteIdx = orbIndex;
    orb.lastHitCount += 1;
  }

  triggerOrbNoteOn(
    player: PlayerKey,
    sourceId: string,
    frequency: number,
    velocity: number,
    orbIndex: number,
    envelope: OrbEnvelopeSettings = DEFAULT_ORB_ENVELOPE,
  ): void {
    if (!this.running || !this.tone) return;
    if (this.muted[player]) return;
    if (this.pendingInstruments[player] !== 'drum') return;
    if (this.orbHeldNotes[player].has(sourceId)) return;
    const orb = this.ensureOrbVoice(player);
    if (!orb) return;
    if (!this.allowHit(this.orbBudgets[player], ORB_MAX_HITS_PER_WINDOW)) {
      return;
    }
    const v = clamp(velocity, 0, 1);
    this.applyOrbEnvelope(orb, envelope);
    this.reserveOrbVoiceRoom(player, orb, 1);
    this.fireOrbNoteAttack(orb, frequency, v);
    this.orbHeldNotes[player].set(sourceId, {
      frequency,
      octaveHz: frequency * ORB_OCTAVE_MULTIPLIER,
      orbIndex,
    });
    orb.pulse = Math.min(1, orb.pulse + 0.55 + v * 0.45);
    orb.energy = Math.min(1, orb.energy + 0.20 + v * 0.25);
    orb.lastNoteIdx = orbIndex;
    orb.lastHitCount += 1;
  }

  triggerOrbNoteOff(
    player: PlayerKey,
    sourceId: string,
    envelope: OrbEnvelopeSettings = DEFAULT_ORB_ENVELOPE,
  ): void {
    const held = this.orbHeldNotes[player].get(sourceId);
    if (!held) return;
    this.orbHeldNotes[player].delete(sourceId);
    const orb = this.orbVoices[player];
    if (!orb || !this.tone) return;
    this.applyOrbEnvelope(orb, envelope);
    try {
      orb.fund.triggerRelease(held.frequency, this.tone.now());
      orb.fifth.triggerRelease(held.octaveHz, this.tone.now());
    } catch (err) {
      console.warn('[handSynth] orb release failed', err);
    }
  }
  private _loggedOrbFirstHit = false;
  private _loggedOrbBlock = false;

  private queuePendingOrbHit(player: PlayerKey, frequency: number, velocity: number, orbIndex: number): void {
    this.pendingOrbHits.push({ player, frequency, velocity, orbIndex });
    if (this.pendingOrbHits.length > MAX_PENDING_ORB_HITS) {
      this.pendingOrbHits.splice(0, this.pendingOrbHits.length - MAX_PENDING_ORB_HITS);
    }
  }

  private flushPendingOrbHits(): void {
    if (this.pendingOrbHits.length === 0) return;
    const hits = this.pendingOrbHits.splice(0);
    for (const hit of hits) {
      this.triggerOrbHit(hit.player, hit.frequency, hit.velocity, hit.orbIndex);
    }
  }

  /** Called by the Starlace Harp visual when a hand sweeps through a star node. */
  triggerStarlacePluck(
    player: PlayerKey,
    frequency: number,
    velocity: number,
    nodeIndex: number,
    x = 0.5,
    y = 0.5,
    noteIndex = -1,
    options: StarlacePluckOptions = {},
  ): void {
    if (!this.running || !this.tone) {
      if (!this._loggedStarlaceBlock) {
        console.warn('[handSynth] starlace pluck blocked: audio not started yet');
        this._loggedStarlaceBlock = true;
      }
      return;
    }
    if (this.muted[player]) return;
    if (this.pendingInstruments[player] !== 'starlace') return;
    const starlace = this.ensureStarlaceVoice(player);
    if (!starlace) return;
    if (!Number.isFinite(frequency) || frequency <= 0) return;

    const v = clamp(velocity, 0, 1);
    const requestedChordSize = this.resolveStarlaceChordSize(options.chordSize);
    const rootIndex = this.resolveStarlaceRootIndex(options.chordRootIndex ?? noteIndex, nodeIndex, starlace.lastHitCount);
    const chordIndex = requestedChordSize
      ? rootIndex
      : this.resolveStarlaceChordIndex(noteIndex, nodeIndex, starlace.lastHitCount);
    const chord = requestedChordSize
      ? this.starlaceChordFromRoot(rootIndex, requestedChordSize)
      : this.starlaceChordForIndex(chordIndex);
    this.absorbStarlaceGesture(starlace, v, x, y);

    const robotFill = this.isRobotPartner(player);
    const heldPhrase = Number.isFinite(options.phraseStep);
    const noteGapScale = robotFill ? 1.65 : (heldPhrase ? 0.50 : 1);
    const noteGap = Math.max(0.04, this.params.starlaceNoteGap * noteGapScale);
    if (this.elapsed - starlace.lastAudioAt < noteGap) return;

    const playableChord = this.starlacePlayableChord(chord, v, requestedChordSize);
    if (playableChord.length === 0) return;
    const maxHits = robotFill ? 3 : STARLACE_MAX_HITS_PER_WINDOW;
    if (!this.allowHit(this.starlaceBudgets[player], maxHits)) {
      return;
    }

    const glintActive = playableChord.length > 1 && clamp(this.params.starlaceGlint, 0, 1) > 0.01;
    this.reserveStarlaceVoiceRoom(player, starlace, playableChord.length, glintActive ? 1 : 0);
    this.fireStarlaceChord(starlace, playableChord, v);
    this.rememberStarlaceTransient(
      player,
      playableChord,
      this.elapsed + Math.max(0.10, this.params.starlaceHold) + Math.max(0.35, this.params.starlaceDecay) + VOICE_RELEASE_MARGIN,
    );
    if (glintActive) {
      this.rememberStarlaceGlint(
        player,
        this.starlaceGlintNote(playableChord),
        this.elapsed + Math.max(0.28, this.params.starlaceHold * 0.65) + Math.max(0.3, this.params.starlaceDecay * 0.25) + VOICE_RELEASE_MARGIN,
      );
    }
    starlace.lastAudioAt = this.elapsed;
    starlace.lastNoteIdx = rootIndex % this.starlaceNotes.length;
    starlace.lastChordIndex = chordIndex;
    starlace.lastChordNotes = [...playableChord];
    if (!this._loggedStarlaceFirstHit) {
      console.debug('[handSynth] first starlace chord', { player, chord: playableChord, frequency, velocity: v, phraseStep: options.phraseStep });
      this._loggedStarlaceFirstHit = true;
    }
  }
  private _loggedStarlaceFirstHit = false;
  private _loggedStarlaceBlock = false;

  private isRobotPartner(player: PlayerKey): boolean {
    return player === 'remote' && this.robotPartnerActive;
  }

  private absorbStarlaceGesture(starlace: StarlaceVoice, velocity: number, x: number, y: number): void {
    starlace.pulse = Math.min(1, starlace.pulse + 0.58 + velocity * 0.42);
    starlace.energy = Math.min(1, starlace.energy + 0.20 + velocity * 0.23);
    starlace.pitch += (clamp(y, 0, 1) - starlace.pitch) * 0.72;
    starlace.expression += (clamp(x, 0, 1) - starlace.expression) * 0.62;
    starlace.tension = Math.min(1, starlace.tension + 0.28 + velocity * 0.34);
    starlace.lastHitCount += 1;
  }

  getActivity(): number {
    let local = this.voices.local?.energy ?? 0;
    let remote = this.voices.remote?.energy ?? 0;
    local = Math.max(local, this.orbVoices.local?.energy ?? 0);
    remote = Math.max(remote, this.orbVoices.remote?.energy ?? 0);
    local = Math.max(local, this.starlaceVoices.local?.energy ?? 0);
    remote = Math.max(remote, this.starlaceVoices.remote?.energy ?? 0);
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
      const o = this.orbVoices[key];
      if (o) {
        this.disposeOrbVoice(o);
        this.orbVoices[key] = null;
      }
      const s = this.starlaceVoices[key];
      if (s) {
        this.disposeStarlaceVoice(s);
        this.starlaceVoices[key] = null;
      }
    }
    this.releaseDuet(true);
    this.duetSynth?.dispose?.();
    this.duetFilter?.dispose?.();
    this.duetGain?.dispose?.();
    this.master?.dispose?.();
    this.keyUnsubscribe?.();
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

  private applyInstrumentRouting(player: PlayerKey): void {
    if (!this.running) return;
    const instrument = this.pendingInstruments[player];
    const voice = this.voices[player];
    const orb = this.orbVoices[player];
    const starlace = this.starlaceVoices[player];
    if (voice) this.releaseVoice(voice, false);
    if (instrument === 'starlace') {
      if (orb) this.silenceOrb(player);
    } else {
      if (starlace) this.silenceStarlace(player);
    }
  }

  private createOrbVoice(key: PlayerKey): OrbVoice {
    const Tone = this.tone!;
    const panner = new Tone.Panner(key === 'local' ? -0.15 : 0.15).connect(this.master);
    const limiter = new Tone.Limiter(ORB_OUTPUT_LIMITER_DB).connect(panner);
    const dryGain = new Tone.Gain(0).connect(limiter);
    const reverbReturn = new Tone.Gain(0.58).connect(limiter);
    const reverb = new Tone.Reverb({
      decay: 4.6,
      preDelay: 0.026,
      wet: 1,
    }).connect(reverbReturn);
    const wetSend = new Tone.Gain(0).connect(reverb);
    const filter = new Tone.Filter({
      frequency: 3400,
      type: 'lowpass',
      rolloff: -12,
      Q: 0.68,
    });
    const chorus = new Tone.Chorus(0.72, 2.8, 0.28).connect(dryGain);
    chorus.wet.value = 0.24;
    chorus.start();
    filter.connect(chorus);
    filter.connect(wetSend);

    // Mellow electric/analog-piano tine: low FM index, quick modulation decay,
    // and a long release so the orb grid reads as pads instead of percussion.
    const fund = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 1.48,
      modulationIndex: 1.12,
      oscillator: { type: 'triangle' },
      envelope: {
        attack: DEFAULT_ORB_ENVELOPE.attack,
        decay: DEFAULT_ORB_ENVELOPE.decay,
        sustain: DEFAULT_ORB_ENVELOPE.sustain,
        release: DEFAULT_ORB_ENVELOPE.release,
      },
      modulation: { type: 'sine' },
      modulationEnvelope: { attack: 0.002, decay: 0.32, sustain: 0, release: 0.18 },
      volume: this.params.orbDb,
    }).connect(filter);
    fund.maxPolyphony = ORB_MAX_ACTIVE_VOICES;

    // Soft octave/body partial. The harmonics knob now acts like piano tine
    // color rather than a metallic fifth.
    const fifth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'fatsine4', count: 2, spread: 11 } as any,
      envelope: {
        attack: DEFAULT_ORB_ENVELOPE.attack * 1.25,
        decay: DEFAULT_ORB_ENVELOPE.decay * 1.1,
        sustain: Math.max(0.50, DEFAULT_ORB_ENVELOPE.sustain * 0.78),
        release: DEFAULT_ORB_ENVELOPE.release * 0.9,
      },
      volume: this.params.orbDb - 17,
    }).connect(filter);
    fifth.maxPolyphony = ORB_MAX_ACTIVE_VOICES;

    const auraGain = new Tone.Gain(0).connect(filter);
    const subGain = new Tone.Gain(0).connect(filter);
    const shimmerGain = new Tone.Gain(0).connect(filter);

    const auraSynth = new Tone.Synth({
      oscillator: { type: 'fatsine4', count: 4, spread: 18 } as any,
      envelope: { attack: 0.18, decay: 0.54, sustain: 0.72, release: 2.35 },
      portamento: 0.12,
      volume: this.params.orbDb - 8,
    }).connect(auraGain);

    const subSynth = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.34, decay: 0.32, sustain: 0.56, release: 2.2 },
      portamento: 0.14,
      volume: this.params.orbDb - 20,
    }).connect(subGain);

    const shimmerSynth = new Tone.Synth({
      oscillator: { type: 'triangle4' } as any,
      envelope: { attack: 0.12, decay: 0.48, sustain: 0.34, release: 1.6 },
      portamento: 0.08,
      volume: this.params.orbDb - 24,
    }).connect(shimmerGain);

    return {
      fund,
      fifth,
      auraSynth,
      subSynth,
      shimmerSynth,
      chorus,
      auraGain,
      subGain,
      shimmerGain,
      filter,
      panner,
      limiter,
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
    const gestureActive = gesture.active && this.pendingInstruments[player] === 'drum';
    if (gestureActive) {
      const angleN = (gesture.angle + Math.PI) / (Math.PI * 2);
      const heightN = clamp(gesture.y * 0.5 + 0.5, 0, 1);
      const speed = clamp(gesture.speed, 0, 1);
      const depth = clamp(gesture.depth, 0, 1);
      const radial = clamp(gesture.radius, 0, 1);
      const pitchT = clamp(heightN * 0.42 + angleN * 0.24 + depth * 0.24 + speed * 0.10, 0, 1);
      const noteIndex = pickNoteIndex(pitchT, orb.lastNoteIdx, this.orbGestureNotes.length);
      const note = this.orbGestureNotes[noteIndex];
      const subNote = transposeInterval(note, -12);
      const shimmerNote = transposeInterval(note, 12);

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
        // Only retune on actual note change. Calling setNote every frame
        // saturates the AudioParam event queue and eventually silences the
        // voice — happens after long sessions of slow hover.
        try {
          orb.auraSynth.setNote(note);
          orb.subSynth.setNote(subNote);
          orb.shimmerSynth.setNote(shimmerNote);
        } catch (err) {
          console.warn('[handSynth] orb gesture retune failed', err);
        }
      }

      const fineBend = gesture.x * 3.5 + gesture.z * 2 + speed * 2.5;
      try {
        orb.auraSynth.detune?.rampTo?.(fineBend, PARAM_RAMP);
        orb.subSynth.detune?.rampTo?.(fineBend * 0.35, PARAM_RAMP * 1.5);
        orb.shimmerSynth.detune?.rampTo?.(fineBend * 1.15, PARAM_RAMP);
      } catch { /* detune is optional on Tone nodes */ }

      const aura = clamp(0.08 + depth * 0.30 + speed * 0.08 + gesture.intensity * 0.08, 0, 0.50);
      const sub = clamp(depth * depth * 0.18 + (1 - radial) * 0.05, 0, 0.24);
      const shimmer = clamp(speed * 0.12 + Math.max(0, gesture.y) * 0.05 + gesture.intensity * 0.05, 0, 0.18);
      orb.auraGain.gain.rampTo(aura, PARAM_RAMP);
      orb.subGain.gain.rampTo(sub, PARAM_RAMP * 1.4);
      orb.shimmerGain.gain.rampTo(shimmer, PARAM_RAMP);

      const filterHz = 520 + depth * 1150 + speed * 2400 + heightN * 820;
      orb.filter.frequency.rampTo(clamp(filterHz, 420, 5600), PARAM_RAMP);
      orb.filter.Q.rampTo(0.62 + depth * 0.42 + speed * 0.75, PARAM_RAMP);
      orb.panner.pan.rampTo(clamp((player === 'local' ? -0.10 : 0.10) + gesture.x * 0.36, -0.85, 0.85), PARAM_RAMP);

      const sparkGap = 0.22 - speed * 0.09;
      if (speed > 0.58 && this.elapsed - orb.lastSparkAt > sparkGap) {
        try {
          const sparkVel = clamp(0.18 + speed * 0.72 + depth * 0.12, 0, 1);
          orb.fifth.triggerAttackRelease(shimmerNote, '8n', undefined, sparkVel * 0.22);
        } catch { /* spark is ornamental */ }
        orb.lastSparkAt = this.elapsed;
        orb.pulse = Math.max(orb.pulse, clamp(0.26 + speed * 0.42, 0, 1));
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
    const wet = clamp(0.22 + orb.energy * 0.42 + (gestureActive ? gesture.depth * 0.10 : 0), 0, 0.82);
    orb.wetSend.gain.rampTo(wet * this.params.reverbWetMax, PARAM_RAMP * 2);
    orb.dryGain.gain.rampTo(0.82, PARAM_RAMP);
  }

  private silenceOrb(player: PlayerKey): void {
    const orb = this.orbVoices[player];
    if (!orb) return;
    this.releaseOrbGesture(orb, true);
    try { orb.fund.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    try { orb.fifth.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    this.orbHeldNotes[player].clear();
    this.orbTransientNotes[player].length = 0;
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
    orb.chorus?.dispose?.();
    orb.auraGain?.dispose?.();
    orb.subGain?.dispose?.();
    orb.shimmerGain?.dispose?.();
    orb.filter?.dispose?.();
    orb.panner?.dispose?.();
    orb.limiter?.dispose?.();
    orb.dryGain?.dispose?.();
    orb.wetSend?.dispose?.();
    orb.reverb?.dispose?.();
    orb.reverbReturn?.dispose?.();
  }

  private fireOrbHit(
    orb: OrbVoice,
    frequency: number,
    velocity: number,
    envelope: OrbEnvelopeSettings = DEFAULT_ORB_ENVELOPE,
  ): number {
    // Velocity floor at 0.35 so a soft tap still rings audibly.
    const synthVel = 0.30 + velocity * 0.58;
    const octaveHz = frequency * ORB_OCTAVE_MULTIPLIER;
    const harmonics = clamp(this.params.orbHarmonics, 0, 1);
    try {
      this.applyOrbEnvelope(orb, envelope);
      const duration = Math.max(0.08, envelope.attack + envelope.decay + 0.035);
      orb.fund.triggerAttackRelease(frequency, duration, undefined, synthVel);
      if (harmonics > 0.02) {
        orb.fifth.triggerAttackRelease(octaveHz, duration * 0.92, undefined, synthVel * harmonics * 0.34);
      }
      return duration;
    } catch (err) {
      console.warn('[handSynth] orb trigger failed', err);
    }
    return Math.max(0.08, envelope.attack + envelope.decay + 0.035);
  }

  private fireOrbNoteAttack(orb: OrbVoice, frequency: number, velocity: number): void {
    const synthVel = 0.30 + velocity * 0.58;
    const octaveHz = frequency * ORB_OCTAVE_MULTIPLIER;
    const harmonics = clamp(this.params.orbHarmonics, 0, 1);
    try {
      orb.fund.triggerAttack(frequency, undefined, synthVel);
      if (harmonics > 0.02) {
        orb.fifth.triggerAttack(octaveHz, undefined, synthVel * harmonics * 0.34);
      }
    } catch (err) {
      console.warn('[handSynth] orb note attack failed', err);
    }
  }

  private applyOrbEnvelope(
    orb: OrbVoice,
    envelope: OrbEnvelopeSettings = DEFAULT_ORB_ENVELOPE,
  ): void {
    const attack = Math.max(0.002, envelope.attack);
    const decay = Math.max(0.002, envelope.decay);
    const sustain = clamp(envelope.sustain, 0, 1);
    const release = Math.max(0.002, envelope.release);
    const fifthEnvelope = {
      attack: attack * 1.25,
      decay: decay * 1.1,
      sustain: Math.max(0.50, sustain * 0.78),
      release: release * 0.9,
    };

    orb.fund.set?.({ envelope: { attack, decay, sustain, release } });
    orb.fifth.set?.({ envelope: fifthEnvelope });

    for (const voice of Object.values(orb.fund.voices ?? {}) as any[]) {
      if (!voice?.envelope) continue;
      voice.envelope.attack = attack;
      voice.envelope.decay = decay;
      voice.envelope.sustain = sustain;
      voice.envelope.release = release;
    }
    for (const voice of Object.values(orb.fifth.voices ?? {}) as any[]) {
      if (!voice?.envelope) continue;
      voice.envelope.attack = fifthEnvelope.attack;
      voice.envelope.decay = fifthEnvelope.decay;
      voice.envelope.sustain = fifthEnvelope.sustain;
      voice.envelope.release = fifthEnvelope.release;
    }
  }

  private createStarlaceVoice(key: PlayerKey): StarlaceVoice {
    const Tone = this.tone!;
    const panner = new Tone.Panner(key === 'local' ? -0.20 : 0.20).connect(this.master);
    const dryGain = new Tone.Gain(0).connect(panner);
    const reverbReturn = new Tone.Gain(0.64).connect(panner);
    const reverb = new Tone.Reverb({
      decay: 5.8,
      preDelay: 0.035,
      wet: 1,
    }).connect(reverbReturn);
    const echo = new Tone.FeedbackDelay({
      delayTime: 0.215,
      feedback: 0.23,
      wet: 0.72,
    }).connect(reverb);
    const wetSend = new Tone.Gain(0);
    wetSend.connect(reverb);
    wetSend.connect(echo);
    const filter = new Tone.Filter({
      frequency: 5200,
      type: 'lowpass',
      rolloff: -12,
      Q: 0.72,
    });
    filter.connect(dryGain);
    filter.connect(wetSend);

    const plucks = Array.from({ length: STARLACE_MAX_ACTIVE_VOICES }, () => {
      const voice = new Tone.PluckSynth({
        attackNoise: this.starlaceAttackNoise(),
        dampening: this.starlaceDampening(),
        resonance: this.starlaceResonance(),
        release: this.starlacePluckRelease(),
      }).connect(filter);
      voice.volume.value = this.params.starlaceDb - 6;
      return voice;
    });

    const body = new Tone.PolySynth({
      maxPolyphony: STARLACE_MAX_ACTIVE_VOICES,
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'triangle4' } as any,
        envelope: {
          attack: Math.max(0.002, this.params.starlaceAttack),
          decay: 0.12,
          sustain: clamp(this.params.starlaceSustain, 0.02, 0.36),
          release: Math.max(0.32, this.params.starlaceDecay * 0.34),
        },
      },
    } as any).connect(filter);
    body.volume.value = this.params.starlaceDb - 13;
    body.maxPolyphony = STARLACE_MAX_ACTIVE_VOICES;

    const glint = new Tone.PolySynth({
      maxPolyphony: STARLACE_GLINT_MAX_ACTIVE_VOICES,
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'sine8' } as any,
        envelope: {
          attack: 0.001,
          decay: 0.075,
          sustain: 0,
          release: 0.12,
        },
      },
    } as any).connect(filter);
    glint.volume.value = this.params.starlaceDb + this.starlaceGlintDbOffset();
    glint.maxPolyphony = STARLACE_GLINT_MAX_ACTIVE_VOICES;

    const auraGain = new Tone.Gain(0).connect(filter);
    const auraSynth = new Tone.PolySynth({
      maxPolyphony: 12,
      voice: Tone.Synth,
      options: {
        oscillator: { type: 'triangle2' } as any,
        envelope: { attack: 0.44, decay: 0.48, sustain: 0.42, release: Math.max(1.8, this.params.starlaceDecay * 0.95) },
        portamento: 0.06,
      },
    } as any).connect(auraGain);
    auraSynth.volume.value = this.params.starlaceDb - 21;
    auraSynth.maxPolyphony = 12;

    return {
      plucks,
      pluckCursor: 0,
      body,
      glint,
      auraSynth,
      auraGain,
      filter,
      panner,
      dryGain,
      wetSend,
      echo,
      reverb,
      reverbReturn,
      pulse: 0,
      energy: 0,
      pitch: 0.5,
      expression: 0.5,
      tension: 0.35,
      auraActive: false,
      auraChordKey: '',
      lastHitCount: 0,
      lastNoteIdx: -1,
      lastChordIndex: -1,
      lastChordNotes: [],
      lastAudioAt: -Infinity,
      lastAuraRetuneAt: -Infinity,
    };
  }

  private updateStarlaceVoice(player: PlayerKey, delta: number): void {
    const starlace = this.starlaceVoices[player];
    if (!starlace || !this.tone) return;
    if (this.muted[player]) {
      this.silenceStarlace(player);
      return;
    }

    const auraChordIndex = starlace.lastChordIndex >= 0
      ? starlace.lastChordIndex
      : this.resolveStarlaceChordIndex(starlace.lastNoteIdx, -1, starlace.lastHitCount);
    const auraChord = starlace.lastChordNotes.length > 0
      ? starlace.lastChordNotes
      : this.starlaceChordForIndex(auraChordIndex);
    const auraChordKey = auraChord.join('|');
    if (starlace.energy > 0.08) {
      if (!starlace.auraActive) {
        try {
          starlace.auraSynth.triggerAttack(auraChord);
        } catch (err) {
          console.warn('[handSynth] starlace aura attack failed', err);
        }
        starlace.auraActive = true;
        starlace.auraChordKey = auraChordKey;
        starlace.lastAuraRetuneAt = this.elapsed;
      } else if (
        auraChordKey !== starlace.auraChordKey &&
        this.elapsed - starlace.lastAuraRetuneAt >= Math.max(0.55, this.params.starlaceNoteGap * 2.5)
      ) {
        try {
          starlace.auraSynth.releaseAll?.(this.tone.now());
          starlace.auraSynth.triggerAttack(auraChord, this.tone.now() + 0.015);
        } catch { /* best-effort retune */ }
        starlace.auraChordKey = auraChordKey;
        starlace.lastAuraRetuneAt = this.elapsed;
      }
    } else {
      this.releaseStarlaceAura(starlace, false);
    }

    const glow = clamp(this.params.starlaceGlow, 0, 1);
    const brightness = clamp(this.params.starlaceBrightness, 0, 1);
    const space = clamp(this.params.starlaceSpace, 0, 1.5);
    const filterHz = (
      1250 +
      starlace.expression * 820 +
      starlace.energy * 1700 +
      starlace.tension * 760
    ) * (0.72 + brightness * 0.58);
    starlace.filter.frequency.rampTo(clamp(filterHz, 850, 6400), PARAM_RAMP);
    starlace.filter.Q.rampTo(0.76 + starlace.tension * 1.15, PARAM_RAMP);
    starlace.panner.pan.rampTo(clamp((player === 'local' ? -0.18 : 0.18) + (starlace.expression - 0.5) * 0.32, -0.85, 0.85), PARAM_RAMP);
    starlace.auraGain.gain.rampTo(clamp(starlace.energy * (0.08 + glow * 0.14), 0, 0.24), PARAM_RAMP * 2);
    starlace.wetSend.gain.rampTo(clamp(0.15 + starlace.energy * 0.34 + glow * 0.10, 0, 0.76) * this.params.reverbWetMax * space, PARAM_RAMP * 2);
    starlace.echo.feedback.rampTo?.(clamp(0.16 + starlace.energy * 0.16 + space * 0.07, 0.12, 0.38), PARAM_RAMP * 2);
    starlace.dryGain.gain.rampTo(0.92, PARAM_RAMP);

    starlace.pulse = Math.max(0, starlace.pulse - delta * 3.0);
    starlace.energy += (0 - starlace.energy) * (1 - Math.exp(-delta * 2.8));
    starlace.tension += (0.35 - starlace.tension) * (1 - Math.exp(-delta * 4.5));
  }

  private silenceStarlace(player: PlayerKey): void {
    const starlace = this.starlaceVoices[player];
    if (!starlace) return;
    this.releaseStarlaceAura(starlace, true);
    for (const pluck of starlace.plucks) {
      try { pluck.triggerRelease?.(this.tone?.now?.()); } catch { /* noop */ }
    }
    try { starlace.body.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    try { starlace.glint.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    this.starlaceTransientNotes[player].length = 0;
    this.starlaceGlintNotes[player].length = 0;
    this.setGainNow(starlace.dryGain, 0);
    this.setGainNow(starlace.wetSend, 0);
    starlace.pulse = 0;
    starlace.energy = 0;
    starlace.lastChordNotes = [];
  }

  private releaseStarlaceAura(starlace: StarlaceVoice, immediate: boolean): void {
    if (!starlace.auraActive && !immediate) {
      starlace.auraGain.gain.rampTo(0, PARAM_RAMP * 2);
      return;
    }
    try {
      starlace.auraSynth.releaseAll?.(this.tone?.now?.());
    } catch (err) {
      console.warn('[handSynth] starlace aura release failed', err);
    }
    if (immediate) this.setGainNow(starlace.auraGain, 0);
    else starlace.auraGain.gain.rampTo(0, PARAM_RAMP * 2);
    starlace.auraActive = false;
    starlace.auraChordKey = '';
  }

  private disposeStarlaceVoice(starlace: StarlaceVoice): void {
    this.releaseStarlaceAura(starlace, true);
    for (const pluck of starlace.plucks) {
      try { pluck.triggerRelease?.(this.tone?.now?.()); } catch { /* noop */ }
    }
    try { starlace.body?.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    try { starlace.glint?.releaseAll?.(this.tone?.now?.()); } catch { /* noop */ }
    for (const pluck of starlace.plucks) pluck?.dispose?.();
    starlace.body?.dispose?.();
    starlace.glint?.dispose?.();
    starlace.auraSynth?.dispose?.();
    starlace.auraGain?.dispose?.();
    starlace.filter?.dispose?.();
    starlace.panner?.dispose?.();
    starlace.dryGain?.dispose?.();
    starlace.wetSend?.dispose?.();
    starlace.echo?.dispose?.();
    starlace.reverb?.dispose?.();
    starlace.reverbReturn?.dispose?.();
  }

  private fireStarlaceChord(starlace: StarlaceVoice, chord: readonly string[], velocity: number): void {
    const synthVel = 0.32 + velocity * 0.68;
    const glintNote = this.starlaceGlintNote(chord);
    const glint = clamp(this.params.starlaceGlint, 0, 1);
    const now = this.tone?.now?.() ?? undefined;
    const orderedChord = starlace.lastHitCount % 4 === 2 ? [...chord].reverse() : [...chord];
    const strumGap = orderedChord.length > 1 ? 0.009 + velocity * 0.010 : 0;
    const hold = Math.max(0.12, this.params.starlaceHold);
    const bodyHold = Math.max(0.16, hold * 0.72);
    try {
      for (let i = 0; i < orderedChord.length; i += 1) {
        const note = orderedChord[i];
        const at = now === undefined ? undefined : now + i * strumGap;
        const pluck = this.nextStarlacePluck(starlace);
        if (pluck) {
          pluck.attackNoise = this.starlaceAttackNoise();
          pluck.dampening = this.starlaceDampening();
          pluck.resonance = this.starlaceResonance();
          pluck.release = this.starlacePluckRelease();
          this.setParamNow(pluck.volume, this.starlacePluckDb(velocity, i));
          pluck.triggerAttack(note, at);
          pluck.triggerRelease(at === undefined ? undefined : at + hold);
        }
        starlace.body.triggerAttackRelease(note, bodyHold, at === undefined ? undefined : at + 0.004, synthVel * (0.18 + velocity * 0.20));
      }
      if (orderedChord.length > 1 && glint > 0.01) {
        starlace.glint.triggerAttackRelease(
          glintNote,
          0.12,
          now === undefined ? undefined : now + orderedChord.length * strumGap + 0.006,
          synthVel * (0.035 + glint * 0.12),
        );
      }
    } catch (err) {
      console.warn('[handSynth] starlace trigger failed', err);
    }
  }

  private starlacePlayableChord(chord: readonly string[], velocity: number, requestedCount?: 1 | 2 | 3): readonly string[] {
    if (requestedCount !== undefined) {
      return chord.slice(0, clamp(requestedCount, 1, Math.min(3, chord.length)));
    }
    const richness = clamp(this.params.starlaceRichness, 0, 1);
    const wantsTriad = chord.length >= 3 && richness + velocity * 0.55 > 0.84;
    const desiredCount = wantsTriad ? 3 : 2;
    const noteCount = Math.min(desiredCount, chord.length);
    return chord.slice(0, Math.max(2, noteCount));
  }

  private starlaceVoiceCap(): number {
    return Math.floor(clamp(this.params.starlaceVoiceCap, 10, STARLACE_MAX_ACTIVE_VOICES));
  }

  private nextStarlacePluck(starlace: StarlaceVoice): any | null {
    const cap = Math.min(this.starlaceVoiceCap(), starlace.plucks.length);
    if (cap <= 0) return null;
    const pluck = starlace.plucks[starlace.pluckCursor % cap];
    starlace.pluckCursor = (starlace.pluckCursor + 1) % cap;
    return pluck;
  }

  private starlaceDampening(): number {
    const brightness = clamp(this.params.starlaceBrightness, 0, 1);
    const overtones = clamp(this.params.starlaceOvertones, 0, 1);
    return 2400 + brightness * 1250 + overtones * 1900;
  }

  private starlaceResonance(): number {
    const sustain = clamp(this.params.starlaceSustain, 0.02, 0.82);
    const glow = clamp(this.params.starlaceGlow, 0, 1);
    return clamp(0.56 + sustain * 0.22 + glow * 0.10, 0.52, 0.86);
  }

  private starlaceAttackNoise(): number {
    return 0.58 + clamp(this.params.starlaceOvertones, 0, 1) * 0.56;
  }

  private starlacePluckRelease(): number {
    return Math.max(0.26, this.params.starlaceDecay * 0.42);
  }

  private starlacePluckDb(velocity: number, order: number): number {
    const dynamicDip = (1 - clamp(velocity, 0, 1)) * 9.5;
    const rolledChordDip = Math.min(order, 3) * 1.3;
    return this.params.starlaceDb - 2.5 - dynamicDip - rolledChordDip;
  }

  private starlaceGlintDbOffset(): number {
    return -34 + clamp(this.params.starlaceGlint, 0, 1) * 14;
  }

  private resolveStarlaceChordIndex(noteIndex: number, nodeIndex: number, fallback: number): number {
    const raw = Number.isFinite(noteIndex) && noteIndex >= 0
      ? noteIndex
      : Number.isFinite(nodeIndex) && nodeIndex >= 0
        ? nodeIndex
        : fallback;
    return positiveModulo(Math.floor(raw), this.starlaceChords.length);
  }

  private resolveStarlaceRootIndex(noteIndex: number, nodeIndex: number, fallback: number): number {
    const raw = Number.isFinite(noteIndex) && noteIndex >= 0
      ? noteIndex
      : Number.isFinite(nodeIndex) && nodeIndex >= 0
        ? nodeIndex
        : fallback;
    return positiveModulo(Math.floor(raw), this.starlaceNotes.length);
  }

  private resolveStarlaceChordSize(value: number | undefined): 1 | 2 | 3 | undefined {
    if (!Number.isFinite(value)) return undefined;
    return clamp(Math.round(value ?? 0), 1, 3) as 1 | 2 | 3;
  }

  private starlaceChordForIndex(index: number): readonly string[] {
    return this.starlaceChords[positiveModulo(index, this.starlaceChords.length)] ?? ['C4', 'E4', 'G4'];
  }

  private starlaceChordFromRoot(rootIndex: number, noteCount: 1 | 2 | 3): readonly string[] {
    const root = clamp(rootIndex, 0, this.starlaceNotes.length - 1);
    const offsets = noteCount === 1 ? [0] : noteCount === 2 ? [0, 2] : [0, 2, 4];
    const notes: string[] = [];
    for (const offset of offsets) {
      let index = root + offset;
      if (index >= this.starlaceNotes.length) index = root - offset;
      index = clamp(index, 0, this.starlaceNotes.length - 1);
      const note = this.starlaceNotes[index];
      if (note && !notes.includes(note)) notes.push(note);
    }
    return notes.length > 0 ? notes : [this.starlaceNotes[root] ?? 'C4'];
  }

  private starlaceGlintNote(chord: readonly string[]): string {
    const top = chord[chord.length - 1] ?? 'A4';
    const match = top.match(/^([A-G]#?)(-?\d+)$/);
    if (!match) return top;
    const [, name, octaveText] = match;
    const octave = Number(octaveText);
    if (!Number.isFinite(octave) || octave >= 5) return top;
    return `${name}${octave + 1}`;
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
    const note = this.duetNotes[clamp(avgIdx, 0, this.duetNotes.length - 1)];
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

  private setParamNow(param: any, value: number): void {
    if (!param) return;
    try {
      const now = this.tone?.now?.() ?? 0;
      param.cancelScheduledValues?.(now);
      if (typeof param.setValueAtTime === 'function') param.setValueAtTime(value, now);
      else param.value = value;
    } catch {
      try { param.value = value; } catch { /* noop */ }
    }
  }

  private attachMouseListener(): void {
    this.mouseListener = (e: PointerEvent) => {
      if (!this.mouseInputEnabled) return;
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

  private clearMouseState(): void {
    this.mouseXN = 0.5;
    this.mouseYN = 0.5;
    this.mouseLastAtMs = -Infinity;
  }

}

function positiveModulo(value: number, modulus: number): number {
  if (modulus <= 0) return 0;
  return ((value % modulus) + modulus) % modulus;
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
