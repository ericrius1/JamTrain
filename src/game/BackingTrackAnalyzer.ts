// FFT analyzer that taps the backing-track <audio> element through a
// MediaElementAudioSource and detects sub-bass onsets. Each tick returns a
// beat event when the low-band envelope spikes above the running mean — used
// to fire ripples through the EnergySculptor field.

const FFT_SIZE = 2048;
const LOW_BAND_HZ_MIN = 30;
const LOW_BAND_HZ_MAX = 180;
// EMA coefficients: short envelope tracks the current bar; long envelope is
// the slow baseline we compare against to find onsets.
const ENV_ATTACK = 0.45;
const ENV_DECAY = 0.04;
const BEAT_RATIO = 1.40;
const BEAT_FLOOR = 0.18;
const MIN_BEAT_INTERVAL_MS = 220;

export type BackingTrackBeat = {
  intensity: number;
  lowEnergy: number;
};

export class BackingTrackAnalyzer {
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private source?: MediaElementAudioSourceNode;
  private bins?: Uint8Array<ArrayBuffer>;
  private lowBinStart = 0;
  private lowBinEnd = 0;
  private envShort = 0;
  private envLong = 0;
  private lastBeatAt = -Infinity;
  private attached = false;

  attach(audio: HTMLAudioElement): boolean {
    if (this.attached) return true;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
      const ctx = new Ctor();
      const src = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.55;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      const binSize = ctx.sampleRate / FFT_SIZE;
      this.lowBinStart = Math.max(1, Math.floor(LOW_BAND_HZ_MIN / binSize));
      this.lowBinEnd = Math.min(analyser.frequencyBinCount - 1, Math.ceil(LOW_BAND_HZ_MAX / binSize));
      this.bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      this.ctx = ctx;
      this.source = src;
      this.analyser = analyser;
      this.attached = true;
      this.tryResume();
      this.installGestureResume();
      return true;
    } catch (err) {
      console.warn('[backing-track-analyzer] attach failed', err);
      return false;
    }
  }

  tick(nowMs: number): BackingTrackBeat | null {
    const analyser = this.analyser;
    const bins = this.bins;
    if (!analyser || !bins) return null;
    analyser.getByteFrequencyData(bins);
    let sum = 0;
    let count = 0;
    for (let i = this.lowBinStart; i <= this.lowBinEnd; i += 1) {
      sum += bins[i];
      count += 1;
    }
    const lowEnergy = count > 0 ? sum / count / 255 : 0;
    this.envShort = this.envShort * (1 - ENV_ATTACK) + lowEnergy * ENV_ATTACK;
    this.envLong = this.envLong * (1 - ENV_DECAY) + lowEnergy * ENV_DECAY;
    const ratio = this.envLong > 1e-4 ? this.envShort / this.envLong : 0;
    const sinceLast = nowMs - this.lastBeatAt;
    if (sinceLast >= MIN_BEAT_INTERVAL_MS && this.envShort > BEAT_FLOOR && ratio > BEAT_RATIO) {
      this.lastBeatAt = nowMs;
      const intensity = clamp01((ratio - 1) * 0.7 + (this.envShort - BEAT_FLOOR));
      return { intensity, lowEnergy: this.envShort };
    }
    return null;
  }

  private tryResume(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    void ctx.resume().catch(() => {});
  }

  private installGestureResume(): void {
    const onGesture = (): void => this.tryResume();
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture);
  }

  dispose(): void {
    try {
      this.analyser?.disconnect();
      this.source?.disconnect();
    } catch {
      // Safari can throw if the node was already torn down by ctx.close().
    }
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
    this.analyser = undefined;
    this.source = undefined;
    this.bins = undefined;
    this.attached = false;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
