import { Pane } from 'tweakpane';
import { clamp, distance } from './math';
import { fingerNames, handednesses, type HandPose, type PlayerPose, type Vec3Data } from './types';

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

  private chordIndex = 0;
  private chordPhase = 0;
  private pane?: Pane;

  // Smoothed input stats — drift slowly so hand-loss does not snap.
  private smoothed = {
    avgX: 0,
    avgY: REST_HAND_HEIGHT,
    avgCurl: 0.5,
    spread: 0,
    presence: 0,
  };

  private params = {
    masterGain: 0.6,
    chordCycleSeconds: 35,
    attackSeconds: 1.6,
    releaseSeconds: 5.5,
    filterMaxHz: 3000,
    reverbWetRange: 0.18,
    shimmerMaxDb: -10,
    muteHandModulation: false,
  };

  constructor(
    private statusTarget?: HTMLElement,
    private paneDock?: HTMLElement
  ) {
    this.publish();
  }

  async start(): Promise<void> {
    if (this.running) return;

    const Tone = await import('tone');
    this.tone = Tone;
    await Tone.start();

    this.master = new Tone.Gain(this.params.masterGain).toDestination();
    this.panner = new Tone.Panner(BASE_PAN).connect(this.master);
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
    const droneOptions = {
      oscillator: { type: 'sine' } as any,
      envelope: { attack: this.params.attackSeconds * 1.5, decay: 0.4, sustain: 1.0, release: this.params.releaseSeconds * 1.3 },
      volume: -8,
    };
    const shimmerOptions = {
      oscillator: { type: 'triangle' } as any,
      envelope: { attack: this.params.attackSeconds * 1.8, decay: 0.4, sustain: 1.0, release: this.params.releaseSeconds * 0.7 },
      volume: -16,
    };

    for (let bank = 0; bank < 2; bank++) {
      this.bedABanks[bank] = [0, 1, 2].map(() => new Tone.Synth(padOptions).connect(this.bedAGain));
      this.bedBBanks[bank] = [0, 1, 2].map(() => new Tone.Synth(padOptions).connect(this.bedBGain));
      this.droneABanks[bank] = new Tone.Synth(droneOptions).connect(this.bedAGain);
      this.droneBBanks[bank] = new Tone.Synth(droneOptions).connect(this.bedBGain);
      this.shimmerBanks[bank] = new Tone.Synth(shimmerOptions).connect(this.shimmerGain);
    }

    const initial = this.currentChord();
    const b = this.bankIndex;
    initial.a.voices.forEach((note, i) => this.bedABanks[b][i].triggerAttack(note));
    initial.b.voices.forEach((note, i) => this.bedBBanks[b][i].triggerAttack(note));
    this.droneABanks[b].triggerAttack(initial.a.drone);
    this.droneBBanks[b].triggerAttack(initial.b.drone);
    this.shimmerBanks[b].triggerAttack(this.shimmerNote());

    this.attachPane();
    this.running = true;
    this.publish();
  }

  update(local: PlayerPose, remote: PlayerPose, daylight: number, delta: number): void {
    if (!this.running || !this.tone) return;

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
      src.connect(lp).connect(convolver).connect(gain).connect(ctx.destination);
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
    this.master?.dispose?.();
    this.pane?.dispose();
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
    this.shimmerBanks[oldBank]?.triggerRelease();

    a.voices.forEach((note, i) => this.bedABanks[newBank][i].triggerAttack(note));
    b.voices.forEach((note, i) => this.bedBBanks[newBank][i].triggerAttack(note));
    this.droneABanks[newBank]?.triggerAttack(a.drone);
    this.droneBBanks[newBank]?.triggerAttack(b.drone);
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
    if (!this.paneDock) return;
    const container = document.createElement('div');
    this.paneDock.appendChild(container);
    this.pane = new Pane({ title: 'Audio', container });
    this.pane.expanded = false;

    this.pane.addBinding(this.params, 'masterGain', { label: 'master', min: 0, max: 1, step: 0.01 });
    this.pane.addBinding(this.params, 'chordCycleSeconds', { label: 'chord seconds', min: 8, max: 120, step: 1 });
    this.pane
      .addBinding(this.params, 'attackSeconds', { label: 'attack sec', min: 0.2, max: 6, step: 0.1 })
      .on('change', () => this.applyEnvelopeUpdate());
    this.pane
      .addBinding(this.params, 'releaseSeconds', { label: 'release sec', min: 1, max: 12, step: 0.1 })
      .on('change', () => this.applyEnvelopeUpdate());
    this.pane.addBinding(this.params, 'filterMaxHz', { label: 'filter ceil', min: 1500, max: 8000, step: 50 });
    this.pane.addBinding(this.params, 'reverbWetRange', { label: 'verb mod', min: 0, max: 0.6, step: 0.01 });
    this.pane.addBinding(this.params, 'shimmerMaxDb', { label: 'shimmer dB', min: -30, max: 0, step: 0.5 });
    this.pane.addBinding(this.params, 'muteHandModulation', { label: 'mute hands' });
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
