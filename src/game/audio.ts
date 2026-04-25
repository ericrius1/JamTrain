import { Pane } from 'tweakpane';
import { clamp, distance } from './math';
import { fingerNames, handednesses, type HandPose, type PlayerPose, type Vec3Data } from './types';

type ChordVoicing = {
  voices: [string, string, string];
  drone: string;
};

const PALETTE_A_NIGHT: ChordVoicing[] = [
  { voices: ['A3', 'C4', 'E4'], drone: 'A2' },
  { voices: ['F3', 'A3', 'C4'], drone: 'F2' },
  { voices: ['C4', 'E4', 'G4'], drone: 'C2' },
  { voices: ['G3', 'C4', 'D4'], drone: 'G2' },
];

const PALETTE_B_DAY: ChordVoicing[] = [
  { voices: ['D4', 'F#4', 'A4'], drone: 'D2' },
  { voices: ['A3', 'C#4', 'E4'], drone: 'A2' },
  { voices: ['E4', 'F#4', 'B4'], drone: 'E2' },
  { voices: ['F#3', 'A3', 'C#4'], drone: 'F#2' },
];

const PARAM_RAMP = 0.12;
const PRESENCE_THRESHOLD = 0.2;
const REST_HAND_HEIGHT = 1.0;
const PRESENCE_SMOOTHING_SECONDS = 1.5;

export class AudioEngine {
  private tone?: typeof import('tone');
  private running = false;

  private bedAVoices: any[] = [];
  private bedBVoices: any[] = [];
  private droneA?: any;
  private droneB?: any;
  private shimmer?: any;

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
  private smoothedPresence = 0;
  private pane?: Pane;

  private params = {
    masterGain: 0.6,
    chordCycleSeconds: 35,
    portamentoSeconds: 4,
    filterMinHz: 400,
    filterMaxHz: 5500,
    reverbMinWet: 0.18,
    reverbMaxWet: 0.55,
    shimmerMaxDb: -8,
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
    this.panner = new Tone.Panner(0).connect(this.master);
    this.reverb = new Tone.Reverb({ decay: 7, wet: 0.32 }).connect(this.panner);
    this.delay = new Tone.PingPongDelay({ delayTime: '8n.', feedback: 0.32, wet: 0.16 }).connect(this.reverb);
    this.chorus = new Tone.Chorus({ frequency: 0.35, delayTime: 4, depth: 0.5, wet: 0.4 })
      .start()
      .connect(this.delay);
    this.filter = new Tone.Filter({ frequency: 1100, type: 'lowpass', rolloff: -24 }).connect(this.chorus);

    this.bedAGain = new Tone.Gain(1).connect(this.filter);
    this.bedBGain = new Tone.Gain(0).connect(this.filter);
    this.shimmerGain = new Tone.Gain(0).connect(this.filter);

    const padOptions = {
      oscillator: { type: 'fatsawtooth', count: 3, spread: 28 } as any,
      envelope: { attack: 2.4, decay: 0.6, sustain: 1.0, release: 5.0 },
      portamento: this.params.portamentoSeconds,
      volume: -16,
    };
    const droneOptions = {
      oscillator: { type: 'fatsine', count: 2, spread: 8 } as any,
      envelope: { attack: 3.2, decay: 0.4, sustain: 1.0, release: 6.0 },
      portamento: this.params.portamentoSeconds,
      volume: -10,
    };
    const shimmerOptions = {
      oscillator: { type: 'triangle' } as any,
      envelope: { attack: 1.8, decay: 0.4, sustain: 1.0, release: 4.0 },
      portamento: this.params.portamentoSeconds,
      volume: -12,
    };

    const initial = this.currentChord();
    this.bedAVoices = initial.a.voices.map(note => {
      const v = new Tone.Synth(padOptions).connect(this.bedAGain);
      v.triggerAttack(note);
      return v;
    });
    this.bedBVoices = initial.b.voices.map(note => {
      const v = new Tone.Synth(padOptions).connect(this.bedBGain);
      v.triggerAttack(note);
      return v;
    });
    this.droneA = new Tone.Synth(droneOptions).connect(this.bedAGain);
    this.droneA.triggerAttack(initial.a.drone);
    this.droneB = new Tone.Synth(droneOptions).connect(this.bedBGain);
    this.droneB.triggerAttack(initial.b.drone);

    this.shimmer = new Tone.Synth(shimmerOptions).connect(this.shimmerGain);
    this.shimmer.triggerAttack(this.shimmerNote());

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

    if (this.params.muteHandModulation) {
      this.applyRest();
      return;
    }

    const stats = this.computeHandStats(local, remote);

    const heightT = clamp((stats.avgY - 0.6) / 1.4, 0, 1);
    const filterHz = this.params.filterMinHz + (this.params.filterMaxHz - this.params.filterMinHz) * heightT;
    this.filter.frequency.rampTo(filterHz, PARAM_RAMP);

    const panT = clamp(stats.avgX / 0.5, -1, 1) * 0.7;
    this.panner.pan.rampTo(panT, PARAM_RAMP);

    const reverbWet =
      this.params.reverbMinWet + (this.params.reverbMaxWet - this.params.reverbMinWet) * stats.avgCurl;
    this.reverb.wet.rampTo(reverbWet, PARAM_RAMP);

    const swellGain = this.params.masterGain * (0.55 + 0.45 * stats.spread);
    this.master.gain.rampTo(swellGain, PARAM_RAMP);
    this.chorus.wet.rampTo(0.2 + 0.6 * stats.spread, PARAM_RAMP);

    const presenceLerp = Math.min(1, delta / PRESENCE_SMOOTHING_SECONDS);
    this.smoothedPresence += (stats.presence - this.smoothedPresence) * presenceLerp;
    const shimmerLinear = this.smoothedPresence * this.tone.dbToGain(this.params.shimmerMaxDb);
    this.shimmerGain.gain.rampTo(shimmerLinear, PARAM_RAMP);
  }

  dispose(): void {
    if (!this.running) return;
    this.running = false;
    const all = [...this.bedAVoices, ...this.bedBVoices, this.droneA, this.droneB, this.shimmer];
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

  private applyRest(): void {
    if (!this.tone) return;
    this.filter.frequency.rampTo(1100, PARAM_RAMP);
    this.reverb.wet.rampTo(0.32, PARAM_RAMP);
    this.panner.pan.rampTo(0, PARAM_RAMP);
    this.chorus.wet.rampTo(0.4, PARAM_RAMP);
    this.master.gain.rampTo(this.params.masterGain * 0.7, PARAM_RAMP);
    this.shimmerGain.gain.rampTo(0, PARAM_RAMP);
  }

  private advanceChord(): void {
    const portamento = this.params.portamentoSeconds;
    const { a, b } = this.currentChord();
    this.bedAVoices.forEach((v, i) => {
      v.set({ portamento });
      v.setNote(a.voices[i]);
    });
    this.bedBVoices.forEach((v, i) => {
      v.set({ portamento });
      v.setNote(b.voices[i]);
    });
    this.droneA?.set({ portamento });
    this.droneA?.setNote(a.drone);
    this.droneB?.set({ portamento });
    this.droneB?.setNote(b.drone);
    this.shimmer?.set({ portamento });
    this.shimmer?.setNote(this.shimmerNote());
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
      .addBinding(this.params, 'portamentoSeconds', { label: 'glide sec', min: 0.1, max: 8, step: 0.1 })
      .on('change', () => this.advanceChord());
    this.pane.addBinding(this.params, 'filterMinHz', { label: 'filter min', min: 80, max: 2000, step: 10 });
    this.pane.addBinding(this.params, 'filterMaxHz', { label: 'filter max', min: 1000, max: 12000, step: 50 });
    this.pane.addBinding(this.params, 'reverbMinWet', { label: 'verb min', min: 0, max: 1, step: 0.01 });
    this.pane.addBinding(this.params, 'reverbMaxWet', { label: 'verb max', min: 0, max: 1, step: 0.01 });
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
