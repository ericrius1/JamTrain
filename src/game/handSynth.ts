import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import { clamp } from './math';
import type { HandPose, PlayerPose } from './types';
import type { InstrumentId } from './instruments';

export const HAND_SYNTH_DEFS = {
  enabled:       { type: 'boolean', default: true,  label: 'enabled' },
  volumeDb:      { default: -16,   min: -40, max: 6,    step: 0.5,  label: 'volume dB' },
  filterMinHz:   { default: 320,   min: 80,  max: 2000, step: 10,   label: 'filter min Hz' },
  filterMaxHz:   { default: 5800,  min: 800, max: 9000, step: 50,   label: 'filter max Hz' },
  filterQ:       { default: 1.4,   min: 0.5, max: 8,    step: 0.1,  label: 'filter Q' },
  attack:        { default: 0.20,  min: 0.01, max: 2,   step: 0.01, label: 'attack sec' },
  release:       { default: 1.6,   min: 0.1, max: 5,    step: 0.05, label: 'release sec' },
  vibratoHz:     { default: 4.5,   min: 0,   max: 9,    step: 0.1,  label: 'flute vib Hz' },
  vibratoDepth:  { default: 0.04,  min: 0,   max: 0.2,  step: 0.005,label: 'flute vib depth' },
  reverbWetMax:  { default: 0.85,  min: 0,   max: 1,    step: 0.01, label: 'reverb max' },
  rhodesVolDb:   { default: -3,    min: -24, max: 6,    step: 0.5,  label: 'rhodes dB' },
  mouseEnabled:  { type: 'boolean', default: true,  label: 'mouse plays' },
} as const;

export type HandSynthParams = ParamsOf<typeof HAND_SYNTH_DEFS>;

// A minor pentatonic, two octaves. Sits well over both bass-ambience
// palettes (F major / A minor at night, G major / D major by day) because
// its tones are common to both keys.
const SCALE_NOTES_LOCAL: string[] = ['A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5'];
const SCALE_NOTES_REMOTE: string[] = SCALE_NOTES_LOCAL.map(transposeOctaveDown);

function octaveShift(notes: string[], shift: number): string[] {
  return notes.map(n => {
    const m = n.match(/^([A-G]#?)(-?\d+)$/);
    if (!m) return n;
    return `${m[1]}${Number(m[2]) + shift}`;
  });
}

const PRESENCE_THRESHOLD = 0.5;
const PARAM_RAMP = 0.08;
const MOUSE_IDLE_TIMEOUT = 1.2;

// Hand world-space normalization. Palms typically span x ≈ -0.6..+0.6 and
// y ≈ 0.4..1.8 in the tracker's coordinate frame.
const HAND_X_RANGE = 0.6;
const HAND_Y_LOW = 0.4;
const HAND_Y_HIGH = 1.8;

// Deadband around each note boundary (in scale-step units) so a hand resting
// near a boundary doesn't flicker between two pitches.
const NOTE_HYSTERESIS = 0.18;

type Profile = InstrumentId;  // 'flute' | 'bell' | 'sparks'
export const PROFILE_LABELS: Record<Profile, string> = {
  flute: 'Cedar Flute',
  bell: 'Velvet Bell',
  sparks: 'Glass Sparks',
};

const PROFILE_SCALES: Record<Profile, string[]> = {
  flute: SCALE_NOTES_LOCAL,
  bell: SCALE_NOTES_REMOTE,             // octave-down for warmth
  sparks: octaveShift(SCALE_NOTES_LOCAL, +1), // octave-up for crystalline shimmer
};

type PlayerKey = 'local' | 'remote';
const PLAYER_KEYS: PlayerKey[] = ['local', 'remote'];

type Coords = { xN: number; yN: number };
type Input = { pitch: Coords; expression: Coords | null };

type Voice = {
  profile: Profile;
  scale: string[];
  synth: any;
  filter: any;
  vibrato?: any;
  panner: any;
  dryGain: any;
  wetSend: any;
  active: boolean;
  currentNoteIdx: number;
  pulse: number;
};

export class HandSynthEngine {
  private tone?: typeof import('tone');
  private running = false;

  private master?: any;
  private limiter?: any;
  private reverb?: any;
  private reverbReturn?: any;

  private voices: Record<PlayerKey, Voice | null> = { local: null, remote: null };
  private pendingInstruments: Record<PlayerKey, InstrumentId> = { local: 'flute', remote: 'bell' };

  private mouseXN = 0.5;
  private mouseYN = 0.5;
  private elapsed = 0;
  // Wall-clock timestamp (seconds) of the last mousemove. Wall-clock — not
  // the game's elapsed — so that a tab hide (which freezes the rAF loop)
  // doesn't preserve "fresh mouse" state forever.
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
    vibratoHz: HAND_SYNTH_DEFS.vibratoHz.default,
    vibratoDepth: HAND_SYNTH_DEFS.vibratoDepth.default,
    reverbWetMax: HAND_SYNTH_DEFS.reverbWetMax.default,
    rhodesVolDb: HAND_SYNTH_DEFS.rhodesVolDb.default,
    mouseEnabled: HAND_SYNTH_DEFS.mouseEnabled.default,
  };

  private registered?: ReturnType<typeof registerTweaks<typeof HAND_SYNTH_DEFS>>;

  constructor(
    private canvas: HTMLCanvasElement,
    private paneDock?: HTMLElement
  ) {
    this.attachMouseListener();
  }

  getProfileLabel(player: PlayerKey): string {
    const profile = this.voices[player]?.profile ?? this.pendingInstruments[player];
    return PROFILE_LABELS[profile];
  }

  getInstrument(player: PlayerKey): InstrumentId {
    return this.voices[player]?.profile ?? this.pendingInstruments[player];
  }

  getVoiceState(player: PlayerKey): { active: boolean; energy: number; pulse: number } {
    const v = this.voices[player];
    if (!v) return { active: false, energy: 0, pulse: 0 };
    return { active: v.active, energy: v.active ? 1 : 0, pulse: v.pulse };
  }

  // Music slider (synth voices). Slider 0..1 → curved dB into volumeDb.
  // Calibrated so the synth sits a few dB above the bed at default mix —
  // melody should poke through accompaniment.
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

    // Hard-limit the synth bus so retriggering mallets and ringing filters
    // can never crackle the destination, even when summed with the bed +
    // drums coming from the AudioEngine on the same context.
    this.limiter = new Tone.Limiter(-6).toDestination();
    this.master = new Tone.Gain(Tone.dbToGain(this.params.volumeDb)).connect(this.limiter);

    // One shared reverb the two voices send into. Wet level per voice is set
    // by that voice's expression hand (X axis), not by the reverb's own wet.
    this.reverb = new Tone.Reverb({ decay: 4.5, preDelay: 0.02, wet: 1 });
    await this.reverb.generate?.();
    this.reverbReturn = new Tone.Gain(0.55).connect(this.master);
    this.reverb.connect(this.reverbReturn);

    this.voices.local = this.createVoice(this.pendingInstruments.local, PROFILE_SCALES[this.pendingInstruments.local]);
    this.voices.remote = this.createVoice(this.pendingInstruments.remote, PROFILE_SCALES[this.pendingInstruments.remote]);

    this.attachPane();
    this.running = true;
  }

  update(local: PlayerPose, remote: PlayerPose, delta: number): void {
    if (!this.running || !this.tone) return;
    this.elapsed += delta;

    if (!this.params.enabled) {
      for (const key of PLAYER_KEYS) this.silenceVoice(key);
      return;
    }

    const mouseAgeSec = (performance.now() - this.mouseLastAtMs) / 1000;
    const mouseFresh = this.params.mouseEnabled && mouseAgeSec < MOUSE_IDLE_TIMEOUT;
    const localInput = this.resolveInput(local, mouseFresh ? { xN: this.mouseXN, yN: this.mouseYN } : null);
    const remoteInput = this.resolveInput(remote, null);

    this.updateVoice('local', localInput, delta);
    this.updateVoice('remote', remoteInput, delta);

    this.master.gain.rampTo(this.tone.dbToGain(this.params.volumeDb), PARAM_RAMP);
  }

  // 0..1 spike on each note attack/change, decaying. Visuals layer this on
  // top of the drum pulse for a unified beat-driven shimmer.
  getNotePulse(): number {
    let max = 0;
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (v && v.pulse > max) max = v.pulse;
    }
    return max;
  }

  // Force-release every voice. Called on tab hide so a held note doesn't
  // ring forever if the rAF loop pauses while a hand was triggering.
  silenceAll(): void {
    for (const key of PLAYER_KEYS) this.silenceVoice(key);
  }

  setInstrument(player: PlayerKey, id: InstrumentId): void {
    if (!this.running || !this.tone) {
      // Defer until start(); we can read the desired instrument at start time.
      this.pendingInstruments[player] = id;
      return;
    }
    const current = this.voices[player];
    if (current?.profile === id) return;
    // Gracefully release any held note on the outgoing voice before disposing.
    if (current) {
      if (current.active) current.synth.triggerRelease();
      current.synth?.dispose?.();
      current.vibrato?.dispose?.();
      current.filter?.dispose?.();
      current.panner?.dispose?.();
      current.dryGain?.dispose?.();
      current.wetSend?.dispose?.();
    }
    this.voices[player] = this.createVoice(id, PROFILE_SCALES[id]);
  }

  // 0..1 — fraction of voices currently held. Useful for sustained
  // reactivity (e.g., "are people jamming right now?").
  getActivity(): number {
    let count = 0;
    for (const key of PLAYER_KEYS) {
      if (this.voices[key]?.active) count += 1;
    }
    return count / PLAYER_KEYS.length;
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
      if (!v) continue;
      v.synth?.dispose?.();
      v.vibrato?.dispose?.();
      v.filter?.dispose?.();
      v.panner?.dispose?.();
      v.dryGain?.dispose?.();
      v.wetSend?.dispose?.();
      this.voices[key] = null;
    }
    this.reverbReturn?.dispose?.();
    this.reverb?.dispose?.();
    this.master?.dispose?.();
    this.limiter?.dispose?.();
    this.registered?.dispose();
  }

  private createVoice(profile: Profile, scale: string[]): Voice {
    const Tone = this.tone!;
    const pan = profile === 'flute' ? -0.35 : profile === 'bell' ? 0.35 : 0;
    const panner = new Tone.Panner(pan).connect(this.master);
    const dryGain = new Tone.Gain(0).connect(panner);
    const wetSend = new Tone.Gain(0).connect(this.reverb);
    const filter = new Tone.Filter({
      frequency: this.params.filterMinHz,
      type: 'lowpass',
      rolloff: -12,
      Q: this.params.filterQ,
    });
    filter.connect(dryGain);
    filter.connect(wetSend);

    let synth: any;
    let vibrato: any;

    if (profile === 'flute') {
      vibrato = new Tone.Vibrato({
        frequency: this.params.vibratoHz,
        depth: this.params.vibratoDepth,
      }).connect(filter);
      synth = new Tone.Synth({
        oscillator: { type: 'triangle' } as any,
        envelope: {
          attack: this.params.attack,
          decay: 0.3,
          sustain: 0.95,
          release: this.params.release,
        },
        portamento: 0,
        volume: 0,
      }).connect(vibrato);
    } else if (profile === 'bell') {
      synth = new Tone.FMSynth({
        harmonicity: 1,
        modulationIndex: 4.5,
        oscillator: { type: 'sine' } as any,
        envelope: { attack: 0.005, decay: 0.9, sustain: 0.35, release: 1.4 },
        modulation: { type: 'sine' } as any,
        modulationEnvelope: { attack: 0.002, decay: 0.6, sustain: 0, release: 0.5 },
        portamento: 0,
        volume: this.params.rhodesVolDb,
      }).connect(filter);
    } else {
      // sparks: PluckSynth (Karplus-Strong) into the shared shimmer reverb. The
      // synth itself is bright and short; sustain is provided by the reverb tail.
      synth = new Tone.PluckSynth({
        attackNoise: 1.2,
        dampening: 4200,
        resonance: 0.92,
        release: 1.4,
        volume: this.params.rhodesVolDb + 2,
      }).connect(filter);
    }

    return {
      profile,
      scale,
      synth,
      filter,
      vibrato,
      panner,
      dryGain,
      wetSend,
      active: false,
      currentNoteIdx: -1,
      pulse: 0,
    };
  }

  // Decide which hand plays pitch and which (if any) modulates expression.
  // Right hand is the "playing" hand by default; if only the left hand is
  // visible, it takes over pitch and there's no expression modulator.
  private resolveInput(pose: PlayerPose, mouse: Coords | null): Input | null {
    const left = pose.hands.left;
    const right = pose.hands.right;
    const lOn = left.confidence > PRESENCE_THRESHOLD;
    const rOn = right.confidence > PRESENCE_THRESHOLD;

    if (rOn && lOn) {
      return { pitch: handCoords(right), expression: handCoords(left) };
    }
    if (rOn) {
      return { pitch: handCoords(right), expression: null };
    }
    if (lOn) {
      return { pitch: handCoords(left), expression: null };
    }
    if (mouse) {
      return { pitch: mouse, expression: null };
    }
    return null;
  }

  private updateVoice(key: PlayerKey, input: Input | null, delta: number): void {
    const voice = this.voices[key];
    if (!voice) return;

    // Pulse always decays on every frame regardless of input state.
    voice.pulse = Math.max(0, voice.pulse - delta * 3);

    if (!input) {
      this.silenceVoice(key);
      return;
    }

    const { pitch, expression } = input;

    // Filter cutoff: prefer expression hand Y; fall back to playing hand X.
    const filterT = expression ? expression.yN : pitch.xN;
    const filterHz =
      this.params.filterMinHz + filterT * (this.params.filterMaxHz - this.params.filterMinHz);
    voice.filter.frequency.rampTo(filterHz, PARAM_RAMP);
    voice.filter.Q.rampTo(this.params.filterQ, PARAM_RAMP);

    // Reverb send: from expression hand X (no expression hand → dry).
    const wetT = expression ? expression.xN : 0;
    voice.wetSend.gain.rampTo(wetT * this.params.reverbWetMax, PARAM_RAMP * 2);
    voice.dryGain.gain.rampTo(1, PARAM_RAMP);

    const idx = pickNoteIndex(pitch.yN, voice.currentNoteIdx);
    const note = voice.scale[idx];

    if (!voice.active) {
      voice.synth.triggerAttack(note);
      voice.currentNoteIdx = idx;
      voice.active = true;
      voice.pulse = 1;
    } else if (idx !== voice.currentNoteIdx) {
      // bell/sparks re-attacks each note (mallet); flute glides between holes via
      // setNote so the breath stays continuous.
      if (voice.profile === 'bell' || voice.profile === 'sparks') {
        voice.synth.triggerAttack(note);
      } else {
        voice.synth.setNote(note);
      }
      voice.currentNoteIdx = idx;
      voice.pulse = Math.max(voice.pulse, voice.profile !== 'flute' ? 1 : 0.5);
    }
  }

  private silenceVoice(key: PlayerKey): void {
    const voice = this.voices[key];
    if (!voice || !voice.active) return;
    voice.synth.triggerRelease();
    voice.dryGain.gain.rampTo(0, PARAM_RAMP * 2);
    voice.wetSend.gain.rampTo(0, PARAM_RAMP * 2);
    voice.active = false;
    voice.currentNoteIdx = -1;
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
        attack:       () => this.applyEnvelope(),
        release:      () => this.applyEnvelope(),
        vibratoHz:    () => this.applyVibrato(),
        vibratoDepth: () => this.applyVibrato(),
        rhodesVolDb:  () => this.applyRhodesVolume(),
      },
    });
  }

  private applyEnvelope(): void {
    for (const key of PLAYER_KEYS) {
      const v = this.voices[key];
      if (!v) continue;
      // PluckSynth (sparks) has no .envelope — its decay shape comes from
      // attackNoise/dampening/resonance, not an ADSR.
      if (v.profile === 'sparks') continue;
      v.synth.envelope.attack = v.profile === 'bell' ? Math.min(0.05, this.params.attack) : this.params.attack;
      v.synth.envelope.release = this.params.release;
    }
  }

  private applyVibrato(): void {
    const v = this.voices.local;
    if (!v?.vibrato) return;
    v.vibrato.frequency.rampTo(this.params.vibratoHz, PARAM_RAMP);
    v.vibrato.depth.rampTo(this.params.vibratoDepth, PARAM_RAMP);
  }

  private applyRhodesVolume(): void {
    const v = this.voices.remote;
    if (!v) return;
    v.synth.volume.rampTo(this.params.rhodesVolDb, PARAM_RAMP);
  }
}

function handCoords(hand: HandPose): Coords {
  const xN = clamp((hand.palm.x + HAND_X_RANGE) / (HAND_X_RANGE * 2), 0, 1);
  const yN = clamp((hand.palm.y - HAND_Y_LOW) / (HAND_Y_HIGH - HAND_Y_LOW), 0, 1);
  return { xN, yN };
}

// Pick a discrete scale step from a normalized 0..1 y position. Adds a small
// hysteresis band around each boundary so a hand hovering near the edge
// doesn't ping-pong between two pitches.
function pickNoteIndex(yN: number, currentIdx: number): number {
  const N = SCALE_NOTES_LOCAL.length;
  const continuous = clamp(yN * N, 0, N - 0.0001);
  if (currentIdx < 0) return Math.floor(continuous);
  if (continuous > currentIdx + 1 + NOTE_HYSTERESIS) {
    return Math.min(N - 1, Math.floor(continuous));
  }
  if (continuous < currentIdx - NOTE_HYSTERESIS) {
    return Math.max(0, Math.floor(continuous));
  }
  return currentIdx;
}

function transposeOctaveDown(note: string): string {
  const match = note.match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return note;
  const [, name, octave] = match;
  return `${name}${Number(octave) - 1}`;
}
