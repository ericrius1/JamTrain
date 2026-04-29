import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import { JamAudioGraph } from './audioGraph';
import { getBackingDay, getBackingNight, type JamChordVoicing } from './harmony';
import { keyDirector } from './keyDirector';
import { clamp, distance } from './math';
import { fingerNames, handednesses, type HandPose, type PlayerPose, type Vec3Data } from './types';

export const AUDIO_DEFS = {
  // Driven by the mixer panel's persisted avPrefs.backingVolume (see main.ts).
  // Persisting separately lets the dev slider diverge from the mixer on reload.
  masterGain:         { default: 0.35, min: 0,    max: 1,    step: 0.01, label: 'master', persisted: false },
  chordCycleSeconds:  { default: 12,   min: 4,    max: 120,  step: 1,    label: 'chord seconds' },
  attackSeconds:      { default: 1.4,  min: 0.2,  max: 8,    step: 0.1,  label: 'attack sec' },
  releaseSeconds:     { default: 4.0,  min: 1,    max: 14,   step: 0.1,  label: 'release sec' },
  filterMaxHz:        { default: 2200, min: 1200, max: 8000, step: 50,   label: 'filter ceil' },
  reverbWetRange:     { default: 0.08, min: 0,    max: 0.6,  step: 0.01, label: 'verb mod' },
  padLevelDb:         { default: -6,   min: -40,  max: 6,    step: 0.5,  label: 'pad dB' },
  muteHandModulation: { type: 'boolean', default: false, label: 'mute hands' },
  drumLevelDb:        { default: -7,   min: -40,  max: 6,    step: 0.5,  label: 'drums dB' },
  drumBpm:            { default: 78,   min: 50,   max: 110,  step: 1,    label: 'drums BPM' },
  drumEbbPeriod:      { default: 90,   min: 20,   max: 360,  step: 1,    label: 'drum ebb sec' },
  drumEbbFloor:       { default: 0.85, min: 0,    max: 1,    step: 0.01, label: 'drum ebb floor' },
  muteDrums:          { type: 'boolean', default: false, label: 'mute drums' },
} as const;

export type AudioParams = ParamsOf<typeof AUDIO_DEFS>;

const PARAM_RAMP = 0.12;
const PRESENCE_THRESHOLD = 0.2;
const REST_HAND_HEIGHT = 1.0;
const STAT_SMOOTH_SECONDS = 1.2;
const PRESENCE_ATTACK_SECONDS = 0.6;
const PRESENCE_RELEASE_SECONDS = 2.5;

const BASE_FILTER_HZ = 980;
const BASE_REVERB_WET = 0.50;
const BASE_CHORUS_WET = 0.10;
const BASE_PAN = 0;
const MAX_BED_PAN = 0.22;

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
  private bankIndex = 0;

  private bedAGain?: any;
  private bedBGain?: any;
  private padGain?: any;
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

  // Cached voicings for the current key. Refreshed when the key tour advances
  // so chord lookups stay cheap. The KeyDirector advances on chord boundaries
  // (driven from this engine), so the next chord we play picks up the new key.
  private nightVoicings: JamChordVoicing[] = getBackingNight(keyDirector.getCurrent());
  private dayVoicings: JamChordVoicing[] = getBackingDay(keyDirector.getCurrent());
  private keyUnsubscribe?: () => void;

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
  private playerActivity = 0;
  private smoothedPlayerActivity = 0;

  // Rhodes-style electric piano on each chord change. Bell-bright FM attack
  // that decays into the pad — the signature lo-fi "Rhodes hit, pad sustains
  // under it" texture. Lives on the bed gains so it crossfades day/night with
  // the rest of the harmonic layer.
  private epA?: any;
  private epB?: any;

  // Vinyl crackle: pink noise through a bandpass, sitting under everything
  // for that "playing on a record" texture. Always on once the engine starts.
  private vinyl?: any;
  private vinylFilter?: any;
  private vinylGain?: any;

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
    padLevelDb: AUDIO_DEFS.padLevelDb.default,
    muteHandModulation: AUDIO_DEFS.muteHandModulation.default,
    drumLevelDb: AUDIO_DEFS.drumLevelDb.default,
    drumBpm: AUDIO_DEFS.drumBpm.default,
    drumEbbPeriod: AUDIO_DEFS.drumEbbPeriod.default,
    drumEbbFloor: AUDIO_DEFS.drumEbbFloor.default,
    muteDrums: AUDIO_DEFS.muteDrums.default,
  };

  constructor(
    private audioGraph: JamAudioGraph,
    private statusTarget?: HTMLElement,
    private paneDock?: HTMLElement
  ) {
    this.publish();
    this.keyUnsubscribe = keyDirector.onChange(({ current }) => {
      this.nightVoicings = getBackingNight(current);
      this.dayVoicings = getBackingDay(current);
    });
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
      threshold: -22,
      ratio: 2.4,
      attack: 0.08,
      release: 0.65,
      knee: 10,
    }).connect(this.master);
    this.panner = new Tone.Panner(BASE_PAN).connect(this.compressor);
    this.reverb = new Tone.Reverb({ decay: 12.5, preDelay: 0.055, wet: BASE_REVERB_WET }).connect(this.panner);
    this.delay = new Tone.PingPongDelay({ delayTime: '2n.', feedback: 0.16, wet: 0.04 }).connect(this.reverb);
    this.chorus = new Tone.Chorus({ frequency: 0.11, delayTime: 8, depth: 0.18, wet: BASE_CHORUS_WET })
      .start()
      .connect(this.delay);
    this.filter = new Tone.Filter({ frequency: BASE_FILTER_HZ, type: 'lowpass', rolloff: -24 }).connect(this.chorus);

    // padGain is the user-facing backing-synth attenuator. Day/night crossfade
    // still happens at bedA/bedBGain; padGain sits downstream so one knob
    // governs the whole backing bed.
    this.padGain = new Tone.Gain(this.tone.dbToGain(this.params.padLevelDb)).connect(this.filter);
    this.bedAGain = new Tone.Gain(1).connect(this.padGain);
    this.bedBGain = new Tone.Gain(0).connect(this.padGain);

    const padOptions = {
      oscillator: { type: 'fatsine', count: 2, spread: 5 } as any,
      envelope: { attack: this.params.attackSeconds, decay: 0.8, sustain: 0.86, release: this.params.releaseSeconds },
      volume: -18,
    };
    // Single low pad voice — voices[1] and voices[2] were dropped along with
    // the octave-up shimmer to keep the backing in the warm low register.
    // Chord movement still comes through the drone + bass, with voices[0]
    // adding a soft pent-step color on top.
    const padVoiceVolumesDb = [-17];
    const subOptions = {
      oscillator: { type: 'sine' } as any,
      envelope: { attack: this.params.attackSeconds * 1.35, decay: 0.8, sustain: 0.74, release: this.params.releaseSeconds * 1.15 },
      volume: -21,
    };
    const droneOptions = {
      oscillator: { type: 'sine' } as any,
      envelope: { attack: this.params.attackSeconds * 1.6, decay: 0.8, sustain: 0.82, release: this.params.releaseSeconds * 1.25 },
      volume: -18,
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
    }

    // Soft felt-key bloom on each chord change. Kept deliberately quiet so it
    // marks harmonic movement without becoming a bright repeated hook.
    const epOptions = {
      harmonicity: 1.0,
      modulationIndex: 3.5,
      oscillator: { type: 'sine' } as any,
      modulation: { type: 'sine' } as any,
      envelope: { attack: 0.028, decay: 2.4, sustain: 0.02, release: 5.4 },
      modulationEnvelope: { attack: 0.018, decay: 1.1, sustain: 0, release: 0.6 },
    };
    this.epA = new Tone.PolySynth({ maxPolyphony: 24, voice: Tone.FMSynth, options: epOptions } as any);
    this.epA.volume.value = -18;
    this.epA.connect(this.bedAGain);
    this.epB = new Tone.PolySynth({ maxPolyphony: 24, voice: Tone.FMSynth, options: epOptions } as any);
    this.epB.volume.value = -18;
    this.epB.connect(this.bedBGain);

    // Vinyl crackle — bandpassed pink noise, sits well below the music. Skips
    // the lowpass/reverb chain so it stays clearly textural rather than
    // smeared into the pad.
    this.vinyl = new Tone.Noise({ type: 'pink', volume: -18 } as any);
    this.vinylFilter = new Tone.Filter({ frequency: 2600, type: 'bandpass', Q: 0.45 });
    this.vinylGain = new Tone.Gain(0.010).connect(this.compressor);
    this.vinyl.chain(this.vinylFilter, this.vinylGain);
    this.vinyl.start();

    const initial = this.currentChord();
    const b = this.bankIndex;
    this.bedABanks[b].forEach((synth, i) => synth.triggerAttack(initial.a.voices[i]));
    this.bedBBanks[b].forEach((synth, i) => synth.triggerAttack(initial.b.voices[i]));
    this.droneABanks[b].triggerAttack(initial.a.drone);
    this.droneBBanks[b].triggerAttack(initial.b.drone);
    this.subABanks[b].triggerAttack(initial.a.bass);
    this.subBBanks[b].triggerAttack(initial.b.bass);
    const epNotesA = initial.a.voices.slice(0, this.bedABanks[b].length);
    const epNotesB = initial.b.voices.slice(0, this.bedBBanks[b].length);
    this.epA.triggerAttackRelease(epNotesA, '9m', undefined, 0.30);
    this.epB.triggerAttackRelease(epNotesB, '9m', undefined, 0.30);

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
      octaves: 3.5,
      oscillator: { type: 'sine' } as any,
      envelope: { attack: 0.004, decay: 0.55, sustain: 0.01, release: 1.2 },
      volume: -12,
    }).connect(this.drumGain);

    // Bandpass-filtered pink noise → soft brushed snare.
    this.snareFilter = new Tone.Filter({ frequency: 1550, type: 'bandpass', Q: 0.75 }).connect(this.drumGain);
    this.snare = new Tone.NoiseSynth({
      noise: { type: 'pink' } as any,
      envelope: { attack: 0.012, decay: 0.22, sustain: 0, release: 0.22 },
      volume: -22,
    }).connect(this.snareFilter);

    // Highpass white-noise tick — barely-there shaker / closed hat.
    this.hatFilter = new Tone.Filter({ frequency: 5600, type: 'highpass', Q: 0.45 }).connect(this.drumGain);
    this.hihat = new Tone.NoiseSynth({
      noise: { type: 'pink' } as any,
      envelope: { attack: 0.006, decay: 0.08, sustain: 0, release: 0.08 },
      volume: -38,
    }).connect(this.hatFilter);

    Tone.getTransport().bpm.value = this.params.drumBpm;
    Tone.getTransport().swing = 0.24;
    Tone.getTransport().swingSubdivision = '16n';

    // 16-step lo-fi boom-bap. Strong kick on 1 + push into 3, snare on 2 & 4
    // with ghost notes around them, and hi-hat with accented "&"s on every
    // beat to give it that open-hat offbeat lift. Swing on the transport
    // pulls the e/a 16ths back for the laid-back lo-fi shuffle.
    //               1     e     &     a     2     e     &     a     3     e     &     a     4     e     &     a
    const KICK   = [0.85,    0,    0,    0,    0,    0,    0, 0.42, 0.62,    0,    0,    0,    0,    0,    0, 0.30];
    const SNARE  = [   0,    0,    0,    0, 0.62,    0,    0,    0,    0, 0.18,    0,    0, 0.62,    0, 0.28,    0];
    const HAT    = [0.26, 0.10, 0.34, 0.10, 0.22, 0.10, 0.34, 0.12, 0.26, 0.10, 0.34, 0.12, 0.22, 0.10, 0.34, 0.20];

    this.drumSeq = new Tone.Sequence((time: number, step: number) => {
      // Wrap the body — a thrown trigger here (e.g. on resume from a long
      // background, when scheduled events land in the past) would otherwise
      // bubble out of Tone's internal timer and silently kill the Sequence.
      try {
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
      } catch (err) {
        console.warn('[audio] drumSeq step failed', err);
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
      this.chordIndex = (this.chordIndex + 1) % this.nightVoicings.length;
      // Step the key tour at chord wraps. If a new key lands, advanceChord
      // below will read the freshly-cached voicings and crossfade into them
      // through the existing voice-bank machinery.
      if (this.chordIndex === 0) keyDirector.onChordBoundary();
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
    this.smoothedPlayerActivity += (this.playerActivity - this.smoothedPlayerActivity) * (1 - Math.exp(-delta / 0.55));

    // Hand modulation acts as an additive layer on top of cozy baselines.
    // When presence → 0, every modulator → 0 and the bed sits at its baseline.
    const p = this.params.muteHandModulation ? 0 : this.smoothed.presence;

    const heightT = clamp((this.smoothed.avgY - 0.6) / 1.4, 0, 1);
    const filterMod = (heightT - 0.3) * (this.params.filterMaxHz - BASE_FILTER_HZ) * p;
    this.filter.frequency.rampTo(BASE_FILTER_HZ + filterMod, PARAM_RAMP);

    const panMod = clamp(this.smoothed.avgX / 0.5, -1, 1) * MAX_BED_PAN * p;
    this.panner.pan.rampTo(BASE_PAN + panMod, PARAM_RAMP);

    const wetMod = (this.smoothed.avgCurl - 0.5) * this.params.reverbWetRange * p;
    const sharedSpaceLift = this.smoothedPlayerActivity * 0.035;
    this.reverb.wet.rampTo(BASE_REVERB_WET + wetMod + sharedSpaceLift, PARAM_RAMP);
    this.delay.wet.rampTo(0.04 + this.smoothedPlayerActivity * 0.025 + this.smoothed.spread * 0.015 * p, PARAM_RAMP);

    // Let active player notes sit forward by gently leaning the bed back,
    // while keeping enough swell that the backing still breathes with hands.
    const swellAdd = this.smoothed.spread * 0.25 * p;
    const activityDuck = 1 - this.smoothedPlayerActivity * 0.18;
    this.master.gain.rampTo(this.params.masterGain * (0.84 + swellAdd) * activityDuck, PARAM_RAMP);
    this.chorus.wet.rampTo(BASE_CHORUS_WET + this.smoothed.spread * 0.16 * p, PARAM_RAMP);

    // Drums breathe slowly between a floor and full volume — never silent, so
    // the cozy lo-fi pocket is always there but the room still has dynamics.
    if (this.drumGain) {
      const period = Math.max(8, this.params.drumEbbPeriod);
      const t = (this.elapsed % period) / period;
      const bell = (1 - Math.cos(t * Math.PI * 2)) * 0.5; // 0..1..0 over period
      const floor = clamp(this.params.drumEbbFloor, 0, 1);
      const ebbT = floor + (1 - floor) * bell;
      const muted = this.params.muteDrums ? 0 : 1;
      const drumLinear = ebbT * muted * this.tone.dbToGain(this.params.drumLevelDb) * (1 - this.smoothedPlayerActivity * 0.35);
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
    if (this.params.muteDrums) return 0;
    const floor = clamp(this.params.drumEbbFloor, 0, 1);
    return floor + (1 - floor) * bell;
  }

  getChordProgress(): number {
    return this.running ? clamp(this.chordPhase / Math.max(0.001, this.params.chordCycleSeconds), 0, 1) : 0;
  }

  getGroovePhase(): number {
    if (!this.running) return 0;
    const beats = this.elapsed * Math.max(1, this.params.drumBpm) / 60;
    return beats - Math.floor(beats);
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

  setPlayerActivity(value: number): void {
    this.playerActivity = clamp(value, 0, 1);
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
    ];
    for (const v of all) v?.dispose?.();
    this.bedAGain?.dispose?.();
    this.bedBGain?.dispose?.();
    this.padGain?.dispose?.();
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
    this.epA?.dispose?.();
    this.epB?.dispose?.();
    this.vinyl?.stop?.();
    this.vinyl?.dispose?.();
    this.vinylFilter?.dispose?.();
    this.vinylGain?.dispose?.();
    this.registered?.dispose();
    this.keyUnsubscribe?.();
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

    this.bedABanks[newBank].forEach((synth, i) => synth.triggerAttack(a.voices[i]));
    this.bedBBanks[newBank].forEach((synth, i) => synth.triggerAttack(b.voices[i]));
    this.droneABanks[newBank]?.triggerAttack(a.drone);
    this.droneBBanks[newBank]?.triggerAttack(b.drone);
    this.subABanks[newBank]?.triggerAttack(a.bass);
    this.subBBanks[newBank]?.triggerAttack(b.bass);
    const epNotesA = a.voices.slice(0, this.bedABanks[newBank].length);
    const epNotesB = b.voices.slice(0, this.bedBBanks[newBank].length);
    this.epA?.triggerAttackRelease(epNotesA, '9m', undefined, 0.28);
    this.epB?.triggerAttackRelease(epNotesB, '9m', undefined, 0.28);

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
      v.envelope.attack = a * 1.35;
      v.envelope.release = r * 1.15;
    }
  }

  private currentChord(): { a: JamChordVoicing; b: JamChordVoicing } {
    return { a: this.nightVoicings[this.chordIndex], b: this.dayVoicings[this.chordIndex] };
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
        padLevelDb:     v => { this.padGain?.gain.rampTo(this.tone?.dbToGain(v) ?? 1, 0.2); },
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
