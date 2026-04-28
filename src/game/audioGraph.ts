export type ToneModule = typeof import('tone');

type AudioBusName = 'backing' | 'instruments' | 'effects';

export const SPECTRUM_BAND_COUNT = 8;

export type MusicSpectrum = {
  // Smoothed band magnitudes in [0,1]. Index 0 = lows, last = highs.
  levels: Float32Array;
  // Transient component per band — current level minus its slow-running
  // baseline, half-wave rectified to [0,1]. Spikes on attacks.
  pulses: Float32Array;
  // Broadband mix energy in [0,1]. Convenient global gain.
  overall: number;
};

/**
 * Owns the one graph that is allowed to touch Tone's destination. Feature
 * engines get buses, then the final compressor/limiter sees the real sum.
 */
export class JamAudioGraph {
  private tone?: ToneModule;
  private running = false;

  private backingBus?: any;
  private instrumentBus?: any;
  private effectsBus?: any;
  private master?: any;
  private compressor?: any;
  private limiter?: any;

  // Mix-tap analyser. Sees backing + instruments + effects (everything that
  // routes through the master gain), so the spectrum reflects the full song
  // including whatever the players are doing.
  private analyser?: AnalyserNode;
  private analyserBytes?: Uint8Array<ArrayBuffer>;
  // Aggregated, smoothed band data — read by visuals each frame.
  private spectrumLevels = new Float32Array(SPECTRUM_BAND_COUNT);
  private spectrumPulses = new Float32Array(SPECTRUM_BAND_COUNT);
  // Slow-running per-band baseline used to derive transient pulses.
  private spectrumBaseline = new Float32Array(SPECTRUM_BAND_COUNT);
  // Cached bin-range mapping per band (computed once we know sampleRate).
  private bandStart = new Int32Array(SPECTRUM_BAND_COUNT);
  private bandEnd = new Int32Array(SPECTRUM_BAND_COUNT);
  private spectrumOverall = 0;

  async start(): Promise<ToneModule> {
    if (this.running && this.tone) return this.tone;

    const Tone = await import('tone');
    this.tone = Tone;
    await Tone.start();

    this.limiter = new Tone.Limiter(-3).toDestination();
    this.compressor = new Tone.Compressor({
      threshold: -16,
      ratio: 3,
      attack: 0.015,
      release: 0.18,
      knee: 8,
    }).connect(this.limiter);
    this.master = new Tone.Gain(0.92).connect(this.compressor);

    this.backingBus = new Tone.Gain(1).connect(this.master);
    this.instrumentBus = new Tone.Gain(1).connect(this.master);
    this.effectsBus = new Tone.Gain(0.85).connect(this.master);

    this.attachAnalyser();

    this.running = true;
    return Tone;
  }

  private attachAnalyser(): void {
    if (!this.tone || !this.master) return;
    const ctx = (this.tone.getContext() as unknown as { rawContext: AudioContext }).rawContext;
    if (!ctx) return;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    // Tap the master sum (post bus mix, pre dynamics) so the spectrum doesn't
    // get squashed flat by the limiter. Master is a Tone.Gain; its raw output
    // node hangs off `.output`.
    const masterOut = (this.master.output as AudioNode | undefined) ?? (this.master as unknown as AudioNode);
    masterOut.connect(analyser);
    this.analyser = analyser;
    // Construct on a real ArrayBuffer (not ArrayBufferLike) so the resulting
    // Uint8Array is accepted by analyser.getByteFrequencyData under TS's
    // current AudioContext typings.
    this.analyserBytes = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.computeBandRanges(ctx.sampleRate, analyser.frequencyBinCount);
  }

  private computeBandRanges(sampleRate: number, binCount: number): void {
    // Log-spaced bands from 40 Hz to 12 kHz. Each band sums the magnitudes of
    // the bins inside its [lo, hi] frequency window.
    const nyquist = sampleRate * 0.5;
    const minHz = 40;
    const maxHz = Math.min(12000, nyquist * 0.95);
    const logMin = Math.log(minHz);
    const logMax = Math.log(maxHz);
    for (let i = 0; i < SPECTRUM_BAND_COUNT; i += 1) {
      const lo = Math.exp(logMin + ((logMax - logMin) * i) / SPECTRUM_BAND_COUNT);
      const hi = Math.exp(logMin + ((logMax - logMin) * (i + 1)) / SPECTRUM_BAND_COUNT);
      const start = Math.max(0, Math.floor((lo / nyquist) * binCount));
      const end = Math.min(binCount, Math.max(start + 1, Math.ceil((hi / nyquist) * binCount)));
      this.bandStart[i] = start;
      this.bandEnd[i] = end;
    }
  }

  /**
   * Sample the FFT and update smoothed band levels + transient pulses.
   * Called from the main game tick. Cheap: one analyser read + a few short
   * loops over fixed-size arrays.
   */
  updateSpectrum(delta: number): MusicSpectrum {
    const result: MusicSpectrum = {
      levels: this.spectrumLevels,
      pulses: this.spectrumPulses,
      overall: this.spectrumOverall,
    };
    if (!this.analyser || !this.analyserBytes) return result;

    this.analyser.getByteFrequencyData(this.analyserBytes);
    const bytes = this.analyserBytes;

    // Per-frame smoothing toward instantaneous magnitude. Faster attack than
    // release so peaks read clearly without strobing.
    const dt = Math.max(0.001, Math.min(0.1, delta));
    const attackK = 1 - Math.exp(-dt / 0.04);
    const releaseK = 1 - Math.exp(-dt / 0.18);
    const baselineK = 1 - Math.exp(-dt / 0.55);

    let overall = 0;
    for (let b = 0; b < SPECTRUM_BAND_COUNT; b += 1) {
      const start = this.bandStart[b];
      const end = this.bandEnd[b];
      let sum = 0;
      for (let i = start; i < end; i += 1) sum += bytes[i];
      const avg = sum / Math.max(1, end - start) / 255; // normalize to 0..1
      // Perceptual lift — bins read pretty quiet in linear space.
      const shaped = Math.pow(avg, 0.7);
      const prev = this.spectrumLevels[b];
      const k = shaped > prev ? attackK : releaseK;
      const next = prev + (shaped - prev) * k;
      this.spectrumLevels[b] = next;

      const baseline = this.spectrumBaseline[b];
      this.spectrumBaseline[b] = baseline + (next - baseline) * baselineK;
      const pulse = next - this.spectrumBaseline[b];
      this.spectrumPulses[b] = pulse > 0 ? Math.min(1, pulse * 2.6) : 0;

      overall += next;
    }
    this.spectrumOverall = Math.min(1, overall / SPECTRUM_BAND_COUNT);
    result.overall = this.spectrumOverall;
    return result;
  }

  getSpectrum(): MusicSpectrum {
    return {
      levels: this.spectrumLevels,
      pulses: this.spectrumPulses,
      overall: this.spectrumOverall,
    };
  }

  getBus(name: AudioBusName): any {
    const bus = name === 'backing'
      ? this.backingBus
      : name === 'instruments'
        ? this.instrumentBus
        : this.effectsBus;
    if (!bus) throw new Error(`JamAudioGraph: ${name} bus requested before start()`);
    return bus;
  }

  getRawEffectsInput(): AudioNode | null {
    return (this.effectsBus?.input as AudioNode | undefined) ?? null;
  }

  async setSuspended(suspended: boolean): Promise<void> {
    if (!this.tone) return;
    const ctx = (this.tone.getContext() as unknown as { rawContext: AudioContext }).rawContext;
    if (!ctx) return;
    try {
      if (suspended && ctx.state === 'running') await ctx.suspend();
      else if (!suspended && ctx.state === 'suspended') await ctx.resume();
    } catch (e) {
      console.warn('audio suspend toggle failed', e);
    }
  }

  dispose(): void {
    if (!this.running) return;
    this.running = false;
    try { this.analyser?.disconnect(); } catch { /* analyser may be detached */ }
    this.analyser = undefined;
    this.analyserBytes = undefined;
    this.backingBus?.dispose?.();
    this.instrumentBus?.dispose?.();
    this.effectsBus?.dispose?.();
    this.master?.dispose?.();
    this.compressor?.dispose?.();
    this.limiter?.dispose?.();
    this.backingBus = undefined;
    this.instrumentBus = undefined;
    this.effectsBus = undefined;
    this.master = undefined;
    this.compressor = undefined;
    this.limiter = undefined;
  }
}
