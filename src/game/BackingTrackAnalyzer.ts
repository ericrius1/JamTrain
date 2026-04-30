// FFT analyzer that taps the backing-track <audio> element through a
// MediaElementAudioSource and detects sub-bass onsets. Each tick returns a
// beat event when the low-band envelope spikes above the running mean — used
// to fire ripples through the EnergySculptor field.

import { isDebugVisible } from '../hud/debugMode';

const FFT_SIZE = 2048;
const LOW_BAND_HZ_MIN = 30;
const LOW_BAND_HZ_MAX = 180;
const DEBUG_BAR_COUNT = 12;
const BEAT_FLASH_MS = 220;
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
  private sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
  private bins?: Uint8Array<ArrayBuffer>;
  private lowBinStart = 0;
  private lowBinEnd = 0;
  private envShort = 0;
  private envLong = 0;
  private lastBeatAt = -Infinity;
  private gestureResumeInstalled = false;
  private readonly handleGestureResume = (): void => this.tryResume();

  private debugRoot?: HTMLDivElement;
  private debugStatusEl?: HTMLDivElement;
  private debugBarEls: HTMLDivElement[] = [];
  private debugLastBeatAt = -Infinity;
  private debugLastIntensity = 0;

  attach(audio: HTMLAudioElement): boolean {
    try {
      this.ensureGraph();
      const analyser = this.analyser;
      const ctx = this.ctx;
      if (!analyser || !ctx) return false;

      let src = this.sources.get(audio);
      if (!src) {
        src = ctx.createMediaElementSource(audio);
        this.sources.set(audio, src);
      }
      if (this.source !== src) {
        try {
          this.source?.disconnect();
        } catch {
          // Some browsers throw when disconnecting a node with no outputs.
        }
        src.connect(analyser);
        this.source = src;
        this.resetEnvelope();
      }
      this.tryResume();
      this.installGestureResume();
      return true;
    } catch (err) {
      console.warn('[backing-track-analyzer] attach failed', err);
      return false;
    }
  }

  private ensureGraph(): void {
    if (this.ctx && this.analyser && this.bins) return;
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
    const ctx = new Ctor();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.55;
    analyser.connect(ctx.destination);
    const binSize = ctx.sampleRate / FFT_SIZE;
    this.lowBinStart = Math.max(1, Math.floor(LOW_BAND_HZ_MIN / binSize));
    this.lowBinEnd = Math.min(analyser.frequencyBinCount - 1, Math.ceil(LOW_BAND_HZ_MAX / binSize));
    this.bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.ctx = ctx;
    this.analyser = analyser;
  }

  tick(nowMs: number): BackingTrackBeat | null {
    const analyser = this.analyser;
    const bins = this.bins;
    if (!analyser || !bins) {
      this.updateDebug(nowMs, null);
      return null;
    }
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
    let beat: BackingTrackBeat | null = null;
    if (sinceLast >= MIN_BEAT_INTERVAL_MS && this.envShort > BEAT_FLOOR && ratio > BEAT_RATIO) {
      this.lastBeatAt = nowMs;
      const intensity = clamp01((ratio - 1) * 0.7 + (this.envShort - BEAT_FLOOR));
      beat = { intensity, lowEnergy: this.envShort };
      this.debugLastBeatAt = nowMs;
      this.debugLastIntensity = intensity;
    }
    this.updateDebug(nowMs, { lowEnergy, ratio });
    return beat;
  }

  private tryResume(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    void ctx.resume().catch(() => {});
  }

  private installGestureResume(): void {
    if (this.gestureResumeInstalled) return;
    this.gestureResumeInstalled = true;
    window.addEventListener('pointerdown', this.handleGestureResume, { passive: true });
    window.addEventListener('keydown', this.handleGestureResume);
  }

  private resetEnvelope(): void {
    this.envShort = 0;
    this.envLong = 0;
    this.lastBeatAt = -Infinity;
  }

  attachPane(dock: HTMLElement): void {
    if (this.debugRoot) return;
    const root = document.createElement('div');
    root.className = 'attractor-debug-message bass-fft-debug';
    root.style.display = 'none';

    const title = document.createElement('div');
    title.textContent = 'Bass FFT (sub ~30-180Hz)';
    title.style.fontWeight = '600';
    title.style.marginBottom = '4px';
    root.appendChild(title);

    const barsRow = document.createElement('div');
    barsRow.style.display = 'flex';
    barsRow.style.gap = '2px';
    barsRow.style.alignItems = 'flex-end';
    barsRow.style.height = '34px';
    barsRow.style.marginBottom = '4px';
    for (let i = 0; i < DEBUG_BAR_COUNT; i += 1) {
      const bar = document.createElement('div');
      bar.style.flex = '1';
      bar.style.height = '0%';
      bar.style.minHeight = '1px';
      bar.style.background = 'rgba(122, 220, 200, 0.78)';
      bar.style.borderRadius = '1px';
      barsRow.appendChild(bar);
      this.debugBarEls.push(bar);
    }
    root.appendChild(barsRow);

    const status = document.createElement('div');
    status.style.fontSize = '10.5px';
    status.style.lineHeight = '1.35';
    status.style.whiteSpace = 'pre-line';
    root.appendChild(status);

    const summary = dock.querySelector('.tweak-pane-dock-summary');
    const anchor = summary?.nextSibling ?? null;
    dock.insertBefore(root, anchor);

    this.debugRoot = root;
    this.debugStatusEl = status;
  }

  private updateDebug(nowMs: number, sample: { lowEnergy: number; ratio: number } | null): void {
    const root = this.debugRoot;
    if (!root) return;
    const visible = isDebugVisible();
    if (!visible) {
      if (root.style.display !== 'none') root.style.display = 'none';
      return;
    }
    if (root.style.display === 'none') root.style.display = '';

    const bins = this.bins;
    if (bins && this.debugBarEls.length > 0) {
      const span = Math.max(1, this.lowBinEnd - this.lowBinStart + 1);
      const stride = span / DEBUG_BAR_COUNT;
      for (let b = 0; b < DEBUG_BAR_COUNT; b += 1) {
        const start = this.lowBinStart + Math.floor(b * stride);
        const end = Math.min(this.lowBinEnd, this.lowBinStart + Math.floor((b + 1) * stride) - 1);
        let s = 0;
        let n = 0;
        for (let i = start; i <= end; i += 1) {
          s += bins[i];
          n += 1;
        }
        const v = n > 0 ? s / n / 255 : 0;
        this.debugBarEls[b].style.height = `${Math.round(v * 100)}%`;
      }
    }

    const sinceBeat = nowMs - this.debugLastBeatAt;
    const flashing = sinceBeat < BEAT_FLASH_MS;
    root.style.borderColor = flashing
      ? `rgba(255, 220, 130, ${0.85 - sinceBeat / BEAT_FLASH_MS * 0.6})`
      : 'rgba(111, 191, 168, 0.42)';
    root.style.boxShadow = flashing
      ? `0 0 18px rgba(255, 200, 110, ${0.55 - sinceBeat / BEAT_FLASH_MS * 0.5})`
      : '';

    const status = this.debugStatusEl;
    if (status) {
      const e = sample?.lowEnergy ?? 0;
      const r = sample?.ratio ?? 0;
      const lastBeatStr = Number.isFinite(this.debugLastBeatAt)
        ? `${(sinceBeat / 1000).toFixed(2)}s ago @ ${this.debugLastIntensity.toFixed(2)}`
        : 'none yet';
      status.textContent =
        `now ${e.toFixed(3)}  envS ${this.envShort.toFixed(3)}  envL ${this.envLong.toFixed(3)}\n`
        + `ratio ${r.toFixed(2)} (>${BEAT_RATIO} & envS>${BEAT_FLOOR} fires)\n`
        + `last beat: ${lastBeatStr}`;
    }
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
    this.sources = new WeakMap();
    this.bins = undefined;
    if (this.gestureResumeInstalled) {
      window.removeEventListener('pointerdown', this.handleGestureResume);
      window.removeEventListener('keydown', this.handleGestureResume);
    }
    this.gestureResumeInstalled = false;
    this.debugRoot?.remove();
    this.debugRoot = undefined;
    this.debugStatusEl = undefined;
    this.debugBarEls = [];
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
