export type ToneModule = typeof import('tone');

type AudioBusName = 'instruments' | 'effects';

/**
 * Owns the one graph that is allowed to touch Tone's destination. Feature
 * engines get buses, then the final compressor/limiter sees the real sum.
 *
 * Output routing: instead of going to AudioContext.destination directly, the
 * limiter feeds a MediaStreamAudioDestinationNode that's piped through a
 * same-page RTCPeerConnection loopback into a hidden <audio> element. That
 * detour exists for one reason — Chrome's AEC reference signal does NOT
 * include AudioContext.destination, so without this hop the partner's WebRTC
 * AEC can't subtract instrument bleed from the mic and produces crackle (or
 * flat-out echo if AEC is disabled). The <audio> element path IS in the AEC
 * reference, so the partner's mic stays clean.
 */
export class JamAudioGraph {
  private tone?: ToneModule;
  private running = false;

  private instrumentBus?: any;
  private effectsBus?: any;
  private master?: any;
  private compressor?: any;
  private limiter?: any;

  // AEC-loopback plumbing. All local; never crosses the network.
  private aecSource?: RTCPeerConnection;
  private aecSink?: RTCPeerConnection;
  private aecAudio?: HTMLAudioElement;
  private aecGestureHandler?: () => void;

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

    this.limiter = new Tone.Limiter(-3);
    this.compressor = new Tone.Compressor({
      threshold: -16,
      ratio: 3,
      attack: 0.015,
      release: 0.18,
      knee: 8,
    }).connect(this.limiter);
    this.master = new Tone.Gain(0.92).connect(this.compressor);

    this.instrumentBus = new Tone.Gain(1).connect(this.master);
    this.effectsBus = new Tone.Gain(0.85).connect(this.master);

    await this.routeOutputForAEC();
    this.attachStateRecovery();

    this.running = true;
    return Tone;
  }

  // Wires limiter → MediaStreamAudioDestinationNode → loopback PC pair →
  // <audio> element. Falls back to limiter.toDestination() if any of the
  // WebRTC machinery is missing/throws so we never end up silent.
  private async routeOutputForAEC(): Promise<void> {
    if (!this.tone || !this.limiter) return;
    const ctx = (this.tone.getContext() as unknown as { rawContext: AudioContext }).rawContext;
    if (!ctx || typeof RTCPeerConnection === 'undefined') {
      this.limiter.toDestination();
      return;
    }

    let dest: MediaStreamAudioDestinationNode;
    let source: RTCPeerConnection;
    let sink: RTCPeerConnection;
    try {
      dest = ctx.createMediaStreamDestination();
      this.limiter.connect(dest);
      source = new RTCPeerConnection();
      sink = new RTCPeerConnection();
    } catch (err) {
      console.warn('[audioGraph] AEC loopback setup failed; using direct destination', err);
      this.limiter.toDestination();
      return;
    }

    this.aecSource = source;
    this.aecSink = sink;

    source.onicecandidate = e => {
      if (e.candidate) void sink.addIceCandidate(e.candidate).catch(() => {/* ignore */});
    };
    sink.onicecandidate = e => {
      if (e.candidate) void source.addIceCandidate(e.candidate).catch(() => {/* ignore */});
    };

    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    this.aecAudio = audio;

    sink.ontrack = e => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      this.tryPlayLoopbackAudio();
    };

    for (const track of dest.stream.getAudioTracks()) {
      // 'music' tells the loopback's Opus instance to optimize for fidelity
      // rather than speech intelligibility — no point compressing the music
      // hard before it just plays back through a hidden <audio> element.
      track.contentHint = 'music';
      source.addTrack(track, dest.stream);
    }

    try {
      const offer = await source.createOffer();
      await source.setLocalDescription(offer);
      await sink.setRemoteDescription(offer);
      const answer = await sink.createAnswer();
      await sink.setLocalDescription(answer);
      await source.setRemoteDescription(answer);
    } catch (err) {
      console.warn('[audioGraph] AEC loopback negotiation failed; falling back', err);
      this.teardownAecLoopback();
      this.limiter.toDestination();
    }
  }

  private tryPlayLoopbackAudio(): void {
    const audio = this.aecAudio;
    if (!audio) return;
    audio.play().catch(err => {
      // Autoplay policy can reject the first call until a user gesture lands.
      // Re-arm on the next pointer/key event and try again then.
      console.info('[audioGraph] loopback audio play() deferred', err?.name);
      if (this.aecGestureHandler) return;
      const retry = () => {
        audio.play()
          .then(() => {
            window.removeEventListener('pointerdown', retry);
            window.removeEventListener('keydown', retry);
            this.aecGestureHandler = undefined;
          })
          .catch(() => { /* try again on the next gesture */ });
      };
      this.aecGestureHandler = retry;
      window.addEventListener('pointerdown', retry, { passive: true });
      window.addEventListener('keydown', retry);
    });
  }

  private teardownAecLoopback(): void {
    if (this.aecGestureHandler) {
      window.removeEventListener('pointerdown', this.aecGestureHandler);
      window.removeEventListener('keydown', this.aecGestureHandler);
      this.aecGestureHandler = undefined;
    }
    try { this.aecSource?.close(); } catch { /* ignore */ }
    try { this.aecSink?.close(); } catch { /* ignore */ }
    if (this.aecAudio) {
      this.aecAudio.srcObject = null;
      this.aecAudio.remove();
    }
    this.aecSource = undefined;
    this.aecSink = undefined;
    this.aecAudio = undefined;
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
    const bus = name === 'instruments' ? this.instrumentBus : this.effectsBus;
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
    this.teardownAecLoopback();
    this.instrumentBus?.dispose?.();
    this.effectsBus?.dispose?.();
    this.master?.dispose?.();
    this.compressor?.dispose?.();
    this.limiter?.dispose?.();
    this.instrumentBus = undefined;
    this.effectsBus = undefined;
    this.master = undefined;
    this.compressor = undefined;
    this.limiter = undefined;
  }
}
