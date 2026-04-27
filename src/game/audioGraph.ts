export type ToneModule = typeof import('tone');

type AudioBusName = 'backing' | 'instruments' | 'effects';

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

    this.running = true;
    return Tone;
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
