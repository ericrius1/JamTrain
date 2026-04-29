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

  // Snapshot of the master gain at the moment we mute for backgrounding, so
  // we can restore the same value on resume regardless of whether anything
  // else was modulating it. Some browsers don't promptly silence already-
  // attacked notes when the AudioContext is suspended, so we hard-mute too.
  private masterGainBeforeMute?: number;

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

    this.attachStateRecovery();

    this.running = true;
    return Tone;
  }

  // Browsers can park an AudioContext in any of: 'running', 'suspended',
  // 'interrupted' (Mobile Safari while backgrounded), or 'closed'. We listen
  // for state changes and re-resume whenever the document is foreground+focused
  // and the context isn't running. Without this hook, returning from a long
  // background can leave audio permanently silent because setSuspended(false)
  // only acted on the explicit 'suspended' state.
  private attachStateRecovery(): void {
    if (!this.tone) return;
    const ctx = (this.tone.getContext() as unknown as { rawContext: AudioContext }).rawContext;
    if (!ctx) return;
    const tryResume = () => {
      if (ctx.state === 'running') return;
      if (typeof document !== 'undefined' && document.hidden) return;
      ctx.resume().catch(err => {
        console.warn('[audioGraph] auto-resume failed', err);
      });
    };
    ctx.addEventListener('statechange', tryResume);
    // Re-arm on the first user gesture after any drift — covers cases where
    // the browser refuses programmatic resume() until a fresh gesture lands.
    const onGesture = () => tryResume();
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture);
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
    const transport = this.tone.getTransport();
    try {
      if (suspended) {
        // Hard-mute the master bus first so already-attacked pad/drone notes
        // go silent instantly. ctx.suspend() doesn't reliably stop sustaining
        // notes across all browsers, but a gain of 0 always does.
        if (this.master && this.masterGainBeforeMute === undefined) {
          this.masterGainBeforeMute = this.master.gain.value;
          this.master.gain.cancelScheduledValues(0);
          this.master.gain.value = 0;
        }
        // Pause the Transport before suspending the context. Otherwise its
        // internal scheduler keeps queuing events against a frozen clock and
        // on resume those events fire in a burst (or throw inside the drum
        // sequence callback, killing scheduling outright).
        if (transport.state === 'started') transport.pause();
        if (ctx.state === 'running') await ctx.suspend();
      } else {
        // resume() is idempotent — call it for any non-running state. Mobile
        // Safari uses 'interrupted' rather than 'suspended' for background
        // tabs and the old equality check would silently no-op there.
        if (ctx.state !== 'running' && ctx.state !== 'closed') await ctx.resume();
        if (transport.state !== 'started') transport.start('+0.05');
        // Restore master gain after the context is running again. Short ramp
        // so we don't get a click on resume.
        if (this.master && this.masterGainBeforeMute !== undefined) {
          const target = this.masterGainBeforeMute;
          this.masterGainBeforeMute = undefined;
          this.master.gain.cancelScheduledValues(0);
          this.master.gain.rampTo(target, 0.04);
        }
      }
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
