export type ToneModule = typeof import('tone');

type AudioBusName = 'instruments' | 'effects';

export type InstrumentFxParams = {
  reverbWet: number;
  reverbDecay: number;
  reverbPreDelay: number;
  delayWet: number;
  delayTime: number;
  delayFeedback: number;
};

const DEFAULT_INSTRUMENT_FX: InstrumentFxParams = {
  reverbWet: 0.22,
  reverbDecay: 2.2,
  reverbPreDelay: 0.01,
  delayWet: 0.18,
  delayTime: 0.32,
  delayFeedback: 0.35,
};

const FX_RAMP = 0.05;

/**
 * Owns the one graph that is allowed to touch Tone's destination. Feature
 * engines get buses, then the final compressor/limiter sees the real sum.
 */
export class JamAudioGraph {
  private tone?: ToneModule;
  private running = false;

  private instrumentBus?: any;
  private instrumentDelay?: any;
  private instrumentReverb?: any;
  private effectsBus?: any;
  private master?: any;
  private compressor?: any;
  private limiter?: any;

  private fxParams: InstrumentFxParams = { ...DEFAULT_INSTRUMENT_FX };

  // Snapshot of the master gain at the moment we mute for backgrounding, so
  // we can restore the same value on resume regardless of whether anything
  // else was modulating it. Some browsers don't promptly silence already-
  // attacked notes when the AudioContext is suspended, so we hard-mute too.
  private masterGainBeforeMute?: number;

  // Tracked refs for the listeners attached in attachStateRecovery so dispose
  // (or a future re-start) can remove them rather than stack new ones.
  private stateRecoveryCtx?: AudioContext;
  private onStateChange?: () => void;
  private onGesture?: () => void;

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

    this.instrumentReverb = new Tone.Reverb({
      decay: this.fxParams.reverbDecay,
      preDelay: this.fxParams.reverbPreDelay,
      wet: this.fxParams.reverbWet,
    }).connect(this.master);
    this.instrumentDelay = new Tone.FeedbackDelay({
      delayTime: this.fxParams.delayTime,
      feedback: this.fxParams.delayFeedback,
      wet: this.fxParams.delayWet,
    }).connect(this.instrumentReverb);
    this.instrumentBus = new Tone.Gain(1).connect(this.instrumentDelay);
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
    // Guard against double-attach (e.g., dispose+start cycle) which would
    // otherwise stack a fresh trio of listeners every time.
    this.detachStateRecovery();
    const tryResume = () => {
      if (ctx.state === 'running') return;
      if (typeof document !== 'undefined' && document.hidden) return;
      ctx.resume().catch(err => {
        console.warn('[audioGraph] auto-resume failed', err);
      });
    };
    const onGesture = () => tryResume();
    ctx.addEventListener('statechange', tryResume);
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture);
    this.stateRecoveryCtx = ctx;
    this.onStateChange = tryResume;
    this.onGesture = onGesture;
  }

  private detachStateRecovery(): void {
    if (this.stateRecoveryCtx && this.onStateChange) {
      this.stateRecoveryCtx.removeEventListener('statechange', this.onStateChange);
    }
    if (this.onGesture) {
      window.removeEventListener('pointerdown', this.onGesture);
      window.removeEventListener('keydown', this.onGesture);
    }
    this.stateRecoveryCtx = undefined;
    this.onStateChange = undefined;
    this.onGesture = undefined;
  }

  getBus(name: AudioBusName): any {
    const bus = name === 'instruments' ? this.instrumentBus : this.effectsBus;
    if (!bus) throw new Error(`JamAudioGraph: ${name} bus requested before start()`);
    return bus;
  }

  getRawEffectsInput(): AudioNode | null {
    return (this.effectsBus?.input as AudioNode | undefined) ?? null;
  }

  setInstrumentFxParam<K extends keyof InstrumentFxParams>(name: K, value: InstrumentFxParams[K]): void {
    this.fxParams[name] = value;
    const reverb = this.instrumentReverb;
    const delay = this.instrumentDelay;
    switch (name) {
      case 'reverbWet':
        reverb?.wet.rampTo(value, FX_RAMP);
        break;
      case 'reverbDecay':
        // Reverb.decay rebuilds the impulse response — only set when running
        // to avoid churn before start().
        if (reverb) reverb.decay = value;
        break;
      case 'reverbPreDelay':
        if (reverb) reverb.preDelay = value;
        break;
      case 'delayWet':
        delay?.wet.rampTo(value, FX_RAMP);
        break;
      case 'delayTime':
        delay?.delayTime.rampTo(value, FX_RAMP);
        break;
      case 'delayFeedback':
        delay?.feedback.rampTo(value, FX_RAMP);
        break;
    }
  }

  async setSuspended(suspended: boolean): Promise<void> {
    if (!this.tone) return;
    const ctx = (this.tone.getContext() as unknown as { rawContext: AudioContext }).rawContext;
    if (!ctx) return;
    const transport = this.tone.getTransport();
    try {
      if (suspended) {
        // Hard-mute the master bus first so already-attacked notes go silent
        // instantly. ctx.suspend() doesn't reliably stop sustaining notes
        // across all browsers, but a gain of 0 always does.
        if (this.master && this.masterGainBeforeMute === undefined) {
          this.masterGainBeforeMute = this.master.gain.value;
          this.master.gain.cancelScheduledValues(0);
          this.master.gain.value = 0;
        }
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
    this.detachStateRecovery();
    this.instrumentBus?.dispose?.();
    this.instrumentDelay?.dispose?.();
    this.instrumentReverb?.dispose?.();
    this.effectsBus?.dispose?.();
    this.master?.dispose?.();
    this.compressor?.dispose?.();
    this.limiter?.dispose?.();
    this.instrumentBus = undefined;
    this.instrumentDelay = undefined;
    this.instrumentReverb = undefined;
    this.effectsBus = undefined;
    this.master = undefined;
    this.compressor = undefined;
    this.limiter = undefined;
  }
}
