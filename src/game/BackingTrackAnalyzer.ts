// FFT analyzer that taps the backing-track <audio> element through a
// MediaElementAudioSource and detects sub-bass onsets. Each tick returns a
// beat event when the low-band envelope spikes above the running mean — used
// to fire ripples through the EnergySculptor field. All thresholds and the
// downstream impulse shape are exposed in the FFT pulse tweakpane folder.

import { isDebugVisible } from '../hud/debugMode';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { EnergySculptor } from './EnergySculptor';

const FFT_SIZE = 2048;
const DEBUG_BAR_COUNT = 12;
const BEAT_FLASH_MS = 220;
const BLINK_HOLD_MS = 110;
const BLINK_FADE_MS = 280;

export const FFT_PULSE_DEFS = {
  enabled:        { type: 'boolean' as const, default: true,                       folder: 'Detection', label: 'enabled' },
  bandHzMin:      { default: 30,    min: 10,    max: 200,  step: 1,                folder: 'Detection', label: 'low Hz' },
  bandHzMax:      { default: 180,   min: 40,    max: 600,  step: 1,                folder: 'Detection', label: 'high Hz' },
  envAttack:      { default: 0.45,  min: 0.05,  max: 1,    step: 0.01,             folder: 'Detection', label: 'env attack' },
  envDecay:       { default: 0.04,  min: 0.005, max: 0.5,  step: 0.005,            folder: 'Detection', label: 'env decay' },
  beatRatio:      { default: 1.1,  min: 1.05,  max: 3,    step: 0.01,             folder: 'Detection', label: 'beat ratio' },
  beatFloor:      { default: 0.18,  min: 0,     max: 1,    step: 0.01,             folder: 'Detection', label: 'beat floor' },
  minIntervalMs:  { default: 220,   min: 60,    max: 1500, step: 10,               folder: 'Detection', label: 'min ms' },
  sensitivity:    { default: 1.0,   min: 0.1,   max: 3,    step: 0.05,             folder: 'Detection', label: 'sensitivity' },

  pulseSpeed:     { default: 15,  min: 0.05,  max: 20,    step: 0.01,             folder: 'Pulse', label: 'speed m/s' },
  pulseWidth:     { default: 0.32,  min: 0.02,  max: 1.0,  step: 0.005,            folder: 'Pulse', label: 'shell width' },
  pulseAmplitude: { default: 2.20,  min: 0,     max: 10,   step: 0.05,             folder: 'Pulse', label: 'strength' },
  pulseLifetime:  { default: 2.5,   min: 0.3,   max: 8,    step: 0.05,             folder: 'Pulse', label: 'lifetime s' },
} as const;

export type FftPulseParams = ParamsOf<typeof FFT_PULSE_DEFS>;

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

  private params: FftPulseParams = Object.fromEntries(
    Object.entries(FFT_PULSE_DEFS).map(([k, d]) => [k, d.default]),
  ) as FftPulseParams;
  private registered?: ReturnType<typeof registerTweaks<typeof FFT_PULSE_DEFS>>;
  private sculptor?: EnergySculptor;

  private debugRoot?: HTMLDivElement;
  private debugStatusEl?: HTMLDivElement;
  private debugBlinkEl?: HTMLDivElement;
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
    this.bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.ctx = ctx;
    this.analyser = analyser;
    this.recomputeLowBand();
  }

  private recomputeLowBand(): void {
    const ctx = this.ctx;
    const analyser = this.analyser;
    if (!ctx || !analyser) return;
    const binSize = ctx.sampleRate / FFT_SIZE;
    const min = Math.min(this.params.bandHzMin, this.params.bandHzMax);
    const max = Math.max(this.params.bandHzMin, this.params.bandHzMax);
    this.lowBinStart = Math.max(1, Math.floor(min / binSize));
    this.lowBinEnd = Math.min(analyser.frequencyBinCount - 1, Math.ceil(max / binSize));
    if (this.lowBinEnd < this.lowBinStart) this.lowBinEnd = this.lowBinStart;
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
    const attack = clamp01(this.params.envAttack);
    const decay = clamp01(this.params.envDecay);
    this.envShort = this.envShort * (1 - attack) + lowEnergy * attack;
    this.envLong = this.envLong * (1 - decay) + lowEnergy * decay;
    const ratio = this.envLong > 1e-4 ? this.envShort / this.envLong : 0;
    const sinceLast = nowMs - this.lastBeatAt;
    let beat: BackingTrackBeat | null = null;
    if (
      this.params.enabled
      && sinceLast >= this.params.minIntervalMs
      && this.envShort > this.params.beatFloor
      && ratio > this.params.beatRatio
    ) {
      this.lastBeatAt = nowMs;
      const raw = (ratio - 1) * 0.7 + (this.envShort - this.params.beatFloor);
      const intensity = clamp01(raw * Math.max(0.05, this.params.sensitivity));
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

  setSculptor(sculptor?: EnergySculptor): void {
    this.sculptor = sculptor;
  }

  attachPane(dock: HTMLElement, sculptor?: EnergySculptor): void {
    this.sculptor = sculptor;
    if (!this.debugRoot) this.buildDebugPanel(dock);
    if (this.registered) return;
    this.registered = registerTweaks(dock, 'fftPulseV1', FFT_PULSE_DEFS, {
      title: 'FFT pulse',
      params: this.params,
      onChange: {
        bandHzMin: () => this.recomputeLowBand(),
        bandHzMax: () => this.recomputeLowBand(),
        pulseSpeed: v => this.sculptor?.setRippleShape({ speed: v }),
        pulseWidth: v => this.sculptor?.setRippleShape({ width: v }),
        pulseAmplitude: v => this.sculptor?.setRippleShape({ amplitude: v }),
        pulseLifetime: v => this.sculptor?.setRippleShape({ lifetime: v }),
      },
    });
  }

  private buildDebugPanel(dock: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'attractor-debug-message bass-fft-debug';
    root.style.display = 'none';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.gap = '8px';
    header.style.marginBottom = '4px';

    const title = document.createElement('div');
    title.textContent = 'FFT pulse';
    title.style.fontWeight = '600';
    header.appendChild(title);
    root.appendChild(header);

    // Floating beat LED — pinned to viewport (not the scrolling dock) so it
    // stays visible no matter how far the user has scrolled the tweakpane.
    const blink = document.createElement('div');
    blink.className = 'fft-pulse-beat-led';
    blink.style.display = 'none';
    blink.style.position = 'fixed';
    blink.style.top = '32px';
    blink.style.right = '316px';
    blink.style.width = '22px';
    blink.style.height = '22px';
    blink.style.borderRadius = '50%';
    blink.style.background = 'rgba(40, 60, 50, 0.45)';
    blink.style.border = '1px solid rgba(120, 200, 160, 0.55)';
    blink.style.boxShadow = 'none';
    blink.style.zIndex = '20';
    blink.style.pointerEvents = 'none';
    blink.title = 'FFT pulse beat';
    document.body.appendChild(blink);

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
    this.debugBlinkEl = blink;
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

    // Big green blink: solid hot during BLINK_HOLD_MS, then linear fade to
    // resting dim ring over BLINK_FADE_MS. Always visible (in debug mode), so
    // the hit registers even when the user isn't looking at the bars.
    const blink = this.debugBlinkEl;
    if (blink) {
      const dim = 'rgba(40, 60, 50, 0.45)';
      const dimBorder = '1px solid rgba(120, 200, 160, 0.55)';
      if (sinceBeat < BLINK_HOLD_MS + BLINK_FADE_MS) {
        const fade = sinceBeat < BLINK_HOLD_MS
          ? 1
          : 1 - (sinceBeat - BLINK_HOLD_MS) / BLINK_FADE_MS;
        const a = clamp01(fade);
        blink.style.background = `rgba(70, 255, 140, ${0.35 + 0.55 * a})`;
        blink.style.border = `1px solid rgba(140, 255, 170, ${0.5 + 0.5 * a})`;
        blink.style.boxShadow = `0 0 ${Math.round(4 + 14 * a)}px rgba(80, 255, 150, ${0.35 + 0.55 * a})`;
      } else {
        blink.style.background = dim;
        blink.style.border = dimBorder;
        blink.style.boxShadow = 'none';
      }
    }

    const status = this.debugStatusEl;
    if (status) {
      const e = sample?.lowEnergy ?? 0;
      const r = sample?.ratio ?? 0;
      const lastBeatStr = Number.isFinite(this.debugLastBeatAt)
        ? `${(sinceBeat / 1000).toFixed(2)}s ago @ ${this.debugLastIntensity.toFixed(2)}`
        : 'none yet';
      const enabledTag = this.params.enabled ? '' : ' [DISABLED]';
      status.textContent =
        `now ${e.toFixed(3)}  envS ${this.envShort.toFixed(3)}  envL ${this.envLong.toFixed(3)}\n`
        + `ratio ${r.toFixed(2)} (>${this.params.beatRatio.toFixed(2)} & envS>${this.params.beatFloor.toFixed(2)} fires)${enabledTag}\n`
        + `band ${Math.round(this.params.bandHzMin)}-${Math.round(this.params.bandHzMax)}Hz  bins ${this.lowBinStart}-${this.lowBinEnd}\n`
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
    this.registered?.dispose();
    this.registered = undefined;
    this.debugRoot?.remove();
    this.debugRoot = undefined;
    this.debugStatusEl = undefined;
    this.debugBlinkEl = undefined;
    this.debugBarEls = [];
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
