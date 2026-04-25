import { clamp, distance } from './math';
import { fingerNames, handednesses, type PlayerPose } from './types';

const scale = ['C3', 'D3', 'F3', 'G3', 'A3', 'C4', 'D4', 'F4', 'G4', 'A4', 'C5', 'D5'];

export class AudioEngine {
  private tone?: typeof import('tone');
  private synth?: any;
  private bass?: any;
  private filter?: any;
  private delay?: any;
  private reverb?: any;
  private lastStep = -1;
  private running = false;

  constructor(private statusTarget?: HTMLElement) {
    this.publish();
  }

  async start(): Promise<void> {
    if (this.running) return;

    const Tone = await import('tone');
    this.tone = Tone;
    await Tone.start();
    this.reverb = new Tone.Reverb({ decay: 4.8, wet: 0.28 }).toDestination();
    this.delay = new Tone.PingPongDelay({ delayTime: '8n', feedback: 0.34, wet: 0.18 }).connect(this.reverb);
    this.filter = new Tone.Filter({ frequency: 1800, type: 'lowpass', rolloff: -12 }).connect(this.delay);
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.012, decay: 0.16, sustain: 0.2, release: 0.65 },
    }).connect(this.filter);
    this.bass = new Tone.MembraneSynth({
      pitchDecay: 0.02,
      octaves: 3,
      envelope: { attack: 0.004, decay: 0.3, sustain: 0.01, release: 0.4 },
    }).toDestination();

    Tone.Transport.bpm.value = 94;
    Tone.Transport.start();
    this.running = true;
    this.publish();
  }

  update(local: PlayerPose, remote: PlayerPose, time: number): void {
    if (!this.running || !this.synth || !this.filter || !this.tone) return;

    const step = Math.floor(time * 8);
    const localTips = this.collectTips(local);
    const remoteTips = this.collectTips(remote);
    const averageDistance =
      localTips.reduce((sum, point, index) => sum + distance(point, remoteTips[index % remoteTips.length]), 0) /
      Math.max(localTips.length, 1);

    const brightness = clamp(averageDistance / 2.5, 0, 1);
    this.filter.frequency.rampTo(700 + brightness * 4200, 0.08);
    this.delay?.set({ feedback: 0.18 + brightness * 0.32, wet: 0.12 + brightness * 0.18 });
    this.reverb?.set({ wet: 0.18 + (1 - brightness) * 0.18 });

    if (step === this.lastStep) return;
    this.lastStep = step;

    const now = this.tone.now();
    const hand = handednesses[step % handednesses.length];
    const finger = fingerNames[Math.floor(step / 2) % fingerNames.length];
    const localFinger = local.hands[hand].fingers[finger];
    const remoteFinger = remote.hands[hand].fingers[finger];
    const linkLength = distance(localFinger.tip, remoteFinger.tip);
    const noteIndex = Math.floor(clamp(localFinger.tip.y + remoteFinger.tip.y, 0, 2.8) * 3.4 + step) % scale.length;
    const velocity = clamp(0.24 + (1 - localFinger.curl) * 0.45 + clamp(linkLength / 3, 0, 0.28), 0.16, 0.92);

    this.synth.triggerAttackRelease(scale[noteIndex], '16n', now, velocity);
    if (step % 8 === 0 && this.bass) {
      this.bass.triggerAttackRelease(scale[Math.max(0, noteIndex - 5)], '8n', now, 0.38 + brightness * 0.16);
    }
  }

  private collectTips(pose: PlayerPose) {
    return handednesses.flatMap(hand => fingerNames.map(finger => pose.hands[hand].fingers[finger].tip));
  }

  private publish(): void {
    if (this.statusTarget) this.statusTarget.textContent = this.running ? 'music: live' : 'music: muted';
  }
}
