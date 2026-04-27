import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import { JamAudioGraph } from './audioGraph';
import { clamp, distance } from './math';
import { fingerNames, handednesses, type HandPose, type PlayerPose, type Vec3Data } from './types';

export const AUDIO_DEFS = {
  masterGain:         { default: 0.35, min: 0,    max: 1,    step: 0.01, label: 'master' },
  chordCycleSeconds:  { default: 35,   min: 8,    max: 120,  step: 1,    label: 'chord seconds' },
  attackSeconds:      { default: 1.6,  min: 0.2,  max: 6,    step: 0.1,  label: 'attack sec' },
  releaseSeconds:     { default: 5.5,  min: 1,    max: 12,   step: 0.1,  label: 'release sec' },
  filterMaxHz:        { default: 3000, min: 1500, max: 8000, step: 50,   label: 'filter ceil' },
  reverbWetRange:     { default: 0.18, min: 0,    max: 0.6,  step: 0.01, label: 'verb mod' },
  shimmerMaxDb:       { default: -18,  min: -30,  max: 0,    step: 0.5,  label: 'shimmer dB' },
  muteHandModulation: { type: 'boolean', default: false, label: 'mute hands' },
  drumLevelDb:        { default: -3,   min: -40,  max: 6,    step: 0.5,  label: 'drums dB' },
  drumBpm:            { default: 74,   min: 50,   max: 110,  step: 1,    label: 'drums BPM' },
  drumEbbPeriod:      { default: 78,   min: 20,   max: 240,  step: 1,    label: 'drum ebb sec' },
  muteDrums:          { type: 'boolean', default: false, label: 'mute drums' },
} as const;

export type AudioParams = ParamsOf<typeof AUDIO_DEFS>;

type ChordVoicing = {
  voices: [string, string, string];
  drone: string;
};

// Cozy mysterious — F major / A minor area, voice-led for smooth glides.
const PALETTE_A_NIGHT: ChordVoicing[] = [
  { voices: ['A3', 'C4', 'E4'], drone: 'F2' }, // Fmaj7
  { voices: ['C4', 'E4', 'G4'], drone: 'A2' }, // Am9
  { voices: ['D4', 'F4', 'A4'], drone: 'D2' }, // Dm11
  { voices: ['B3', 'E4', 'G4'], drone: 'C2' }, // Cmaj9
];

// Cozy bright — G major / D major area, higher voicings for daylight warmth.
const PALETTE_B_DAY: ChordVoicing[] = [
  { voices: ['D4', 'F#4', 'B4'], drone: 'G2' }, // Gmaj7
  { voices: ['D4', 'G4', 'B4'], drone: 'E2' }, // Em11
  { voices: ['E4', 'G4', 'B4'], drone: 'C2' }, // Cmaj9
  { voices: ['D4', 'F#4', 'A4'], drone: 'D2' }, // Dadd9
];

const PARAM_RAMP = 0.12;
const PRESENCE_THRESHOLD = 0.2;
const REST_HAND_HEIGHT = 1.0;
const STAT_SMOOTH_SECONDS = 1.2;
const PRESENCE_ATTACK_SECONDS = 0.6;
const PRESENCE_RELEASE_SECONDS = 2.5;

const BASE_FILTER_HZ = 1500;
const BASE_REVERB_WET = 0.35;
const BASE_CHORUS_WET = 0.25;
const BASE_PAN = 0;

export class AudioEngine {
  private tone?: typeof import('tone');
  private running = false;

  // Two voice banks per layer alternate on each chord change. The new bank
  // attacks into the new chord while the old bank releases into its tail —
  // crossfading whole chords like sustaining a piano across changes.
  private bedABanks: any[][] = [[], []];
  private bedBBanks: any[][] = [[], []];
  private droneABanks: any[] = [];
  private droneBBanks: any[] = [];
  private subABanks: any[] = [];
  private subBBanks: any[] = [];
  private shimmerBanks: any[] = [];
  private bankIndex = 0;

  private bedAGain?: any;
  private bedBGain?: any;
  private shimmerGain?: any;
  private master?: any;

  private filter?: any;
  private chorus?: any;
  private delay?: any;
  private reverb?: any;
  private panner?: any;
  private compressor?: any;

  private chordIndex = 0;
  private chordPhase = 0;
  private registered?: ReturnType<typeof registerTweaks<typeof AUDIO_DEFS>>;

  // Lo-fi drum kit. Tight + dry, routed straight to the compressor so the
  // hand-modulated lowpass and big reverb don't smear the transients.
  private kick?: any;
  private snare?: any;
  private hihat?: any;
  private snareFilter?: any;
  private hatFilter?: any;
  private drumGain?: any;
  private drumSeq?: any;
  private elapsed = 0;
  private kickAt = -Infinity;
  private snareAt = -Infinity;

  // Smoothed input stats — drift slowly so hand-loss does not snap.
  private smoothed = {
    avgX: 0,
    avgY: REST_HAND_HEIGHT,
    avgCurl: 0.5,
    spread: 0,
    presence: 0,
  };

  private params: AudioParams = {
    masterGain: AUDIO_DEFS.masterGain.default,
    chordCycleSeconds: AUDIO_DEFS.chordCycleSeconds.default,
    attackSeconds: AUDIO_DEFS.attackSeconds.default,
    releaseSeconds: AUDIO_DEFS.releaseSeconds.default,
    filterMaxHz: AUDIO_DEFS.filterMaxHz.default,
    reverbWetRange: AUDIO_DEFS.reverbWetRange.default,
    shimmerMaxDb: AUDIO_DEFS.shimmerMaxDb.default,
    muteHandModulation: AUDIO_DEFS.muteHandModulation.default,
    drumLevelDb: AUDIO_DEFS.drumLevelDb.default,
    drumBpm: AUDIO_DEFS.drumBpm.default,
    drumEbbPeriod: AUDIO_DEFS.drumEbbPeriod.default,
    muteDrums: AUDIO_DEFS.muteDrums.default,
  };

  constructor(
    private audioGraph: JamAudioGraph,
    private statusTarget?: HTMLElement,
    private paneDock?: HTMLElement
  ) {
    this.publish();
  }

  async start(): Promise<void> {
    if (this.running) return;

    const Tone = await this.audioGraph.start();
    this.tone = Tone;

    // Tame voice-stacking buildup before it hits the master fader. Threshold
    // is set high enough that quiet passages pass through clean and only
    // crowded chord transitions get gently squeezed.
    this.master = new Tone.Gain(this.params.masterGain).connect(this.audioGraph.getBus('backing'));
    this.compressor = new Tone.Compressor({
      threshold: -18,
      ratio: 4,
      attack: 0.05,
      release: 0.3,
      knee: 6,
    }).connect(this.master);
    this.panner = new Tone.Panner(BASE_PAN).connect(this.compressor);
    this.reverb = new Tone.Reverb({ decay: 9, wet: BASE_REVERB_WET }).connect(this.panner);
    this.delay = new Tone.PingPongDelay({ delayTime: '4n.', feedback: 0.28, wet: 0.12 }).connect(this.reverb);
    this.chorus = new Tone.Chorus({ frequency: 0.25, delayTime: 6, depth: 0.4, wet: BASE_CHORUS_WET })
      .start()
      .connect(this.delay);
    this.filter = new Tone.Filter({ frequency: BASE_FILTER_HZ, type: 'lowpass', rolloff: -24 }).connect(this.chorus);

    this.bedAGain = new Tone.Gain(1).connect(this.filter);
    this.bedBGain = new Tone.Gain(0).connect(this.filter);
    this.shimmerGain = new Tone.Gain(0).connect(this.filter);

    const padOptions = {
      oscillator: { type: 'fattriangle', count: 3, spread: 14 } as any,
      envelope: { attack: this.params.attackSeconds, decay: 0.4, sustain: 1.0, release: this.params.releaseSeconds },
      volume: -14,
    };
    // Per-voice attenuation: top of each chord (voices[2]) sits well below the
    // lower two so the music doesn't fight speech-band frequencies.
    const padVoiceVolumesDb = [-12, -14, -22];
    const subOptions = {
      oscillator: { type: 'fattriangle', count: 3, spread: 14 } as any,
      envelope: { attack: this.params.attackSeconds, decay: 0.4, sustain: 1.0, release: this.params.releaseSeconds },
      volume: -16,
    };
    const droneOptions = {
      oscillator: { type: 'sine' } as any,
      envelope: { attack: this.params.attackSeconds * 1.5, decay: 0.4, sustain: 1.0, release: this.params.releaseSeconds * 1.3 },
      volume: -12,
    };
    const shimmerOptions = {
      oscillator: { type: 'triangle' } as any,
      envelope: { attack: this.params.attackSeconds * 1.8, decay: 0.4, sustain: 1.0, release: this.params.releaseSeconds * 0.7 },
      volume: -16,
    };

    for (let bank = 0; bank < 2; bank++) {
      this.bedABanks[bank] = padVoiceVolumesDb.map(v =>
        new Tone.Synth({ ...padOptions, volume: v }).connect(this.bedAGain)
      );
      this.bedBBanks[bank] = padVoiceVolumesDb.map(v =>
        new Tone.Synth({ ...padOptions, volume: v }).connect(this.bedBGain)
      );
      this.droneABanks[bank] = new Tone.Synth(droneOptions).connect(this.bedAGain);
      this.droneBBanks[bank] = new Tone.Synth(droneOptions).connect(this.bedBGain);
      this.subABanks[bank] = new Tone.Synth(subOptions).connect(this.bedAGain);
      this.subBBanks[bank] = new Tone.Synth(subOptions).connect(this.bedBGain);
      this.shimmerBanks[bank] = new Tone.Synth(shimmerOptions).connect(this.shimmerGain);
    }

    const initial = this.currentChord();
    const b = this.bankIndex;
    initial.a.voices.forEach((note, i) => this.bedABanks[b][i].triggerAttack(note));
    initial.b.voices.forEach((note, i) => this.bedBBanks[b][i].triggerAttack(note));
    this.droneABanks[b].triggerAttack(initial.a.drone);
    this.droneBBanks[b].triggerAttack(initial.b.drone);
    this.subABanks[b].triggerAttack(transposeOctaveDown(initial.a.voices[0]));
    this.subBBanks[b].triggerAttack(transposeOctaveDown(initial.b.voices[0]));
    this.shimmerBanks[b].triggerAttack(this.shimmerNote());

    this.setupDrums(Tone);

    this.attachPane();
    this.running = true;
    this.publish();
  }

  private setupDrums(Tone: typeof import('tone')): void {
    // Drums sit dry on the compressor bus — they bypass the lowpass + chorus +
    // big reverb so the transients stay tight and the lo-fi groove doesn't
    // smear into the bass ambience.
    this.drumGain = new Tone.Gain(0).connect(this.compressor);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 5,
      oscillator: { type: 'sine' } as any,
      envelope: { attack: 0.001, decay: 0.45, sustain: 0.01, release: 1.0 },
      volume: -8,
    }).connect(this.drumGain);

    // Bandpass-filtered pink noise → soft brushed snare.
    this.snareFilter = new Tone.Filter({ frequency: 2200, type: 'bandpass', Q: 1.1 }).connect(this.drumGain);
    this.snare = new Tone.NoiseSynth({
      noise: { type: 'pink' } as any,
      envelope: { attack: 0.005, decay: 0.16, sustain: 0, release: 0.16 },
      volume: -14,
    }).connect(this.snareFilter);

    // Highpass white-noise tick — barely-there shaker / closed hat.
    this.hatFilter = new Tone.Filter({ frequency: 7200, type: 'highpass', Q: 0.7 }).connect(this.drumGain);
    this.hihat = new Tone.NoiseSynth({
      noise: { type: 'white' } as any,
      envelope: { attack: 0.003, decay: 0.04, sustain: 0, release: 0.04 },
      volume: -28,
    }).connect(this.hatFilter);

    Tone.getTransport().bpm.value = this.params.drumBpm;
    Tone.getTransport().swing = 0.18;
    Tone.getTransport().swingSubdivision = '16n';

    // 16-step lofi pattern. Numbers are velocities (0 = rest).
    //               1   e   &   a   2   e   &   a   3   e   &   a   4   e   &   a
    const KICK   = [0.95,   0,   0,   0,    0,   0, 0.7,   0,    0,   0,   0,   0,    0,   0,   0,   0];
    const SNARE  = [   0,   0,   0,   0, 0.65,   0,   0,   0,    0,   0,   0,   0, 0.65,   0,   0,   0];
    const HAT    = [   0, 0.5,   0, 0.45,    0, 0.5,   0, 0.45,    0, 0.5,   0, 0.45,    0, 0.5,   0, 0.45];

    this.drumSeq = new Tone.Sequence((time: number, step: number) => {
      const kv = KICK[step];
      const sv = SNARE[step];
      const hv = HAT[step];
      if (kv) {
        this.kick?.triggerAttackRelease('C2', '8n', time, kv);
        this.kickAt = this.elapsed;
      }
      if (sv) {
        this.snare?.triggerAttackRelease('16n', time, sv);
        this.snareAt = this.elapsed;
      }
      if (hv) {
        this.hihat?.triggerAttackRelease('32n', time, hv);
      }
    }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], '16n');
    this.drumSeq.start(0);
    Tone.getTransport().start('+0.1');
  }

  update(local: PlayerPose, remote: PlayerPose, daylight: number, delta: number): void {
    if (!this.running || !this.tone) return;

    this.elapsed += delta;
    this.chordPhase += delta;
    if (this.chordPhase >= this.params.chordCycleSeconds) {
      this.chordPhase = 0;
      this.chordIndex = (this.chordIndex + 1) % PALETTE_A_NIGHT.length;
      this.advanceChord();
    }

    const dayT = clamp(daylight, 0, 1);
    this.bedAGain.gain.rampTo(1 - dayT, PARAM_RAMP);
    this.bedBGain.gain.rampTo(dayT, PARAM_RAMP);

    const stats = this.computeHandStats(local, remote);

    // Smooth the stats. Presence uses asymmetric attack/release so hand
    // appearance feels responsive but disappearance fades gently.
    const k = 1 - Math.exp(-delta / STAT_SMOOTH_SECONDS);
    this.smoothed.avgX += (stats.avgX - this.smoothed.avgX) * k;
    this.smoothed.avgY += (stats.avgY - this.smoothed.avgY) * k;
    this.smoothed.avgCurl += (stats.avgCurl - this.smoothed.avgCurl) * k;
    this.smoothed.spread += (stats.spread - this.smoothed.spread) * k;

    const presenceTau =
      stats.presence > this.smoothed.presence ? PRESENCE_ATTACK_SECONDS : PRESENCE_RELEASE_SECONDS;
    const pk = 1 - Math.exp(-delta / presenceTau);
    this.smoothed.presence += (stats.presence - this.smoothed.presence) * pk;

    // Hand modulation acts as an additive layer on top of cozy baselines.
    // When presence → 0, every modulator → 0 and the bed sits at its baseline.
    const p = this.params.muteHandModulation ? 0 : this.smoothed.presence;

    const heightT = clamp((this.smoothed.avgY - 0.6) / 1.4, 0, 1);
    const filterMod = (heightT - 0.3) * (this.params.filterMaxHz - BASE_FILTER_HZ) * p;
    this.filter.frequency.rampTo(BASE_FILTER_HZ + filterMod, PARAM_RAMP);

    const panMod = clamp(this.smoothed.avgX / 0.5, -1, 1) * 0.55 * p;
    this.panner.pan.rampTo(BASE_PAN + panMod, PARAM_RAMP);

    const wetMod = (this.smoothed.avgCurl - 0.5) * this.params.reverbWetRange * p;
    this.reverb.wet.rampTo(BASE_REVERB_WET + wetMod, PARAM_RAMP);

    // Swell only adds gain — never dips below baseline. Same for chorus.
    const swellAdd = this.smoothed.spread * 0.25 * p;
    this.master.gain.rampTo(this.params.masterGain * (0.85 + swellAdd), PARAM_RAMP);
    this.chorus.wet.rampTo(BASE_CHORUS_WET + this.smoothed.spread * 0.35 * p, PARAM_RAMP);

    const shimmerLinear = p * this.tone.dbToGain(this.params.shimmerMaxDb);
    this.shimmerGain.gain.rampTo(shimmerLinear, PARAM_RAMP);

    // Drums ebb in and out over a slow cosine bell so the train moves through
    // jam phases — quiet a while, then a soft groove builds and recedes.
    if (this.drumGain) {
      const period = Math.max(8, this.params.drumEbbPeriod);
      const t = (this.elapsed % period) / period;
      const bell = (1 - Math.cos(t * Math.PI * 2)) * 0.5; // 0..1..0 over period
      const ebbT = Math.pow(bell, 1.4); // bias slightly toward quiet
      const muted = this.params.muteDrums ? 0 : 1;
      const drumLinear = ebbT * muted * this.tone.dbToGain(this.params.drumLevelDb);
      this.drumGain.gain.rampTo(drumLinear, PARAM_RAMP * 4);
    }
  }

  // 0..1 spike on each drum hit, decaying. Visuals layer this for cozy
  // beat-driven pulses that don't read as harsh strobing.
  getDrumPulse(): number {
    if (!this.running) return 0;
    const ageK = Math.max(0, this.elapsed - this.kickAt);
    const ageS = Math.max(0, this.elapsed - this.snareAt);
    const k = Math.exp(-ageK * 6);
    const s = Math.exp(-ageS * 4) * 0.55;
    return Math.min(1, k + s);
  }

  // Smoothed daylight-independent activity level — useful for "is the music
  // currently playing" cues like cabin light intensity.
  getDrumLevel(): number {
    if (!this.running || !this.drumGain) return 0;
    const period = Math.max(8, this.params.drumEbbPeriod);
    const t = (this.elapsed % period) / period;
    const bell = (1 - Math.cos(t * Math.PI * 2)) * 0.5;
    return this.params.muteDrums ? 0 : Math.pow(bell, 1.4);
  }

  // Backing slider (bed + drums). Independent from the player synth's mix
  // slider — that lives on HandSynthEngine.
  setMasterGain(value: number): void {
    const MAX_MUSIC_GAIN = 0.22;
    const CURVE_EXP = 2.5;
    const v = value <= 0 ? 0 : Math.min(1, value);
    this.params.masterGain = MAX_MUSIC_GAIN * Math.pow(v, CURVE_EXP);
    this.registered?.pane?.refresh();
  }

  getMasterGain(): number {
    return this.params.masterGain;
  }

  // Cozy lo-fi thunder: short low-passed noise burst with a long convolution
  // reverb tail. Generated procedurally so the project stays asset-free.
  playThunder(delaySeconds = 1.0): void {
    if (!this.running || !this.tone) return;
    try {
      const ctx = (this.tone.getContext() as unknown as { rawContext: AudioContext }).rawContext;
      if (!ctx) return;
      const dur = 2.6;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) {
        const env = Math.pow(1 - i / data.length, 1.4);
        data[i] = (Math.random() * 2 - 1) * env;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      lp.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0.10;
      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx, 2.4, 1.6);
      const destination = this.audioGraph.getRawEffectsInput();
      if (!destination) return;
      src.connect(lp).connect(convolver).connect(gain).connect(destination);
      src.start(ctx.currentTime + delaySeconds);
    } catch (e) {
      console.warn('thunder failed', e);
    }
  }

  dispose(): void {
    if (!this.running) return;
    this.running = false;
    const all = [
      ...this.bedABanks.flat(),
      ...this.bedBBanks.flat(),
      ...this.droneABanks,
      ...this.droneBBanks,
      ...this.subABanks,
      ...this.subBBanks,
      ...this.shimmerBanks,
    ];
    for (const v of all) v?.dispose?.();
    this.bedAGain?.dispose?.();
    this.bedBGain?.dispose?.();
    this.shimmerGain?.dispose?.();
    this.filter?.dispose?.();
    this.chorus?.dispose?.();
    this.delay?.dispose?.();
    this.reverb?.dispose?.();
    this.panner?.dispose?.();
    this.compressor?.dispose?.();
    this.master?.dispose?.();
    this.drumSeq?.dispose?.();
    this.kick?.dispose?.();
    this.snare?.dispose?.();
    this.hihat?.dispose?.();
    this.snareFilter?.dispose?.();
    this.hatFilter?.dispose?.();
    this.drumGain?.dispose?.();
    this.registered?.dispose();
    this.publish();
  }

  private advanceChord(): void {
    const oldBank = this.bankIndex;
    const newBank = 1 - oldBank;
    const { a, b } = this.currentChord();

    // Old bank releases into its long tail; new bank attacks into the new chord.
    this.bedABanks[oldBank].forEach(v => v.triggerRelease());
    this.bedBBanks[oldBank].forEach(v => v.triggerRelease());
    this.droneABanks[oldBank]?.triggerRelease();
    this.droneBBanks[oldBank]?.triggerRelease();
    this.subABanks[oldBank]?.triggerRelease();
    this.subBBanks[oldBank]?.triggerRelease();
    this.shimmerBanks[oldBank]?.triggerRelease();

    a.voices.forEach((note, i) => this.bedABanks[newBank][i].triggerAttack(note));
    b.voices.forEach((note, i) => this.bedBBanks[newBank][i].triggerAttack(note));
    this.droneABanks[newBank]?.triggerAttack(a.drone);
    this.droneBBanks[newBank]?.triggerAttack(b.drone);
    this.subABanks[newBank]?.triggerAttack(transposeOctaveDown(a.voices[0]));
    this.subBBanks[newBank]?.triggerAttack(transposeOctaveDown(b.voices[0]));
    this.shimmerBanks[newBank]?.triggerAttack(this.shimmerNote());

    this.bankIndex = newBank;
  }

  private applyEnvelopeUpdate(): void {
    const a = this.params.attackSeconds;
    const r = this.params.releaseSeconds;
    const allPads = [...this.bedABanks.flat(), ...this.bedBBanks.flat()];
    for (const v of allPads) {
      v.envelope.attack = a;
      v.envelope.release = r;
    }
    for (const v of this.droneABanks.concat(this.droneBBanks)) {
      v.envelope.attack = a * 1.5;
      v.envelope.release = r * 1.3;
    }
    for (const v of this.subABanks.concat(this.subBBanks)) {
      v.envelope.attack = a;
      v.envelope.release = r;
    }
    for (const v of this.shimmerBanks) {
      v.envelope.attack = a * 1.8;
      v.envelope.release = r * 0.7;
    }
  }

  private currentChord(): { a: ChordVoicing; b: ChordVoicing } {
    return { a: PALETTE_A_NIGHT[this.chordIndex], b: PALETTE_B_DAY[this.chordIndex] };
  }

  private shimmerNote(): string {
    const top = PALETTE_B_DAY[this.chordIndex].voices[2];
    return transposeOctaveUp(top);
  }

  private computeHandStats(local: PlayerPose, remote: PlayerPose) {
    const allHands: HandPose[] = [
      ...handednesses.map(h => local.hands[h]),
      ...handednesses.map(h => remote.hands[h]),
    ];
    const tracked = allHands.filter(h => h.confidence > PRESENCE_THRESHOLD);

    let avgX = 0;
    let avgY = REST_HAND_HEIGHT;
    let avgCurl = 0.5;
    if (tracked.length > 0) {
      avgX = tracked.reduce((s, h) => s + h.palm.x, 0) / tracked.length;
      avgY = tracked.reduce((s, h) => s + h.palm.y, 0) / tracked.length;
      avgCurl = tracked.reduce((s, h) => s + averageCurl(h), 0) / tracked.length;
    }

    let spread = 0;
    const localCentroid = handCentroid(local);
    const remoteCentroid = handCentroid(remote);
    if (localCentroid && remoteCentroid) {
      spread = clamp(distance(localCentroid, remoteCentroid) / 1.5, 0, 1);
    } else {
      const lh = local.hands.left;
      const rh = local.hands.right;
      if (lh.confidence > PRESENCE_THRESHOLD && rh.confidence > PRESENCE_THRESHOLD) {
        spread = clamp(distance(lh.palm, rh.palm) / 1.0, 0, 1);
      }
    }

    const presence = clamp(allHands.reduce((s, h) => s + h.confidence, 0) / 4, 0, 1);

    return { avgX, avgY, avgCurl, spread, presence };
  }

  private attachPane(): void {
    if (!this.paneDock || this.registered) return;
    this.registered = registerTweaks(this.paneDock, 'audio', AUDIO_DEFS, {
      title: 'Audio',
      params: this.params,
      onChange: {
        attackSeconds:  () => this.applyEnvelopeUpdate(),
        releaseSeconds: () => this.applyEnvelopeUpdate(),
        drumBpm:        v => { this.tone?.getTransport().bpm.rampTo(v, 1); },
      },
    });
  }

  private publish(): void {
    if (this.statusTarget) this.statusTarget.textContent = this.running ? 'music: live' : 'music: muted';
  }
}

function averageCurl(hand: HandPose): number {
  let sum = 0;
  for (const finger of fingerNames) sum += hand.fingers[finger].curl;
  return sum / fingerNames.length;
}

function handCentroid(player: PlayerPose): Vec3Data | null {
  const hands = handednesses.map(h => player.hands[h]).filter(h => h.confidence > PRESENCE_THRESHOLD);
  if (hands.length === 0) return null;
  const sum = hands.reduce(
    (acc, h) => ({ x: acc.x + h.palm.x, y: acc.y + h.palm.y, z: acc.z + h.palm.z }),
    { x: 0, y: 0, z: 0 }
  );
  return { x: sum.x / hands.length, y: sum.y / hands.length, z: sum.z / hands.length };
}

function transposeOctaveUp(note: string): string {
  const match = note.match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return note;
  const [, name, octave] = match;
  return `${name}${Number(octave) + 1}`;
}

function transposeOctaveDown(note: string): string {
  const match = note.match(/^([A-G]#?)(-?\d+)$/);
  if (!match) return note;
  const [, name, octave] = match;
  return `${name}${Number(octave) - 1}`;
}

function makeImpulseResponse(ctx: AudioContext, duration: number, decay: number): AudioBuffer {
  const len = ctx.sampleRate * duration;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c += 1) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}
