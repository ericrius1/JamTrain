const DEFAULT_FADE_MS = 3000;

export class MidnightTrainStream {
  private audio?: HTMLAudioElement;
  private volume = 0.55;
  private fadeRaf = 0;
  private playToken = 0;
  private fading = false;

  constructor(private readonly src: string) {}

  setVolume(value: number): void {
    this.volume = clamp01(value);
    if (this.audio && !this.fading && !this.audio.paused) {
      this.audio.volume = this.volume;
    }
  }

  async playWithFadeIn(durationMs = DEFAULT_FADE_MS): Promise<void> {
    const audio = this.ensureAudio();
    if (!audio.paused && !audio.ended) return;

    const token = ++this.playToken;
    this.cancelFade();
    this.fading = false;
    audio.volume = 0;

    try {
      await audio.play();
    } catch (err) {
      if (token === this.playToken) {
        this.fading = false;
        audio.pause();
        throw err;
      }
      return;
    }

    if (token !== this.playToken) return;
    this.fadeIn(token, Math.max(0, durationMs));
  }

  stop(): void {
    this.playToken++;
    this.cancelFade();
    this.fading = false;
    if (!this.audio) return;
    this.audio.pause();
    this.audio.volume = 0;
    try {
      this.audio.currentTime = 0;
    } catch {
      // Some browsers reject seeking before metadata is available.
    }
  }

  dispose(): void {
    this.stop();
    if (!this.audio) return;
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio = undefined;
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio(this.src);
    audio.preload = 'none';
    audio.volume = 0;
    audio.addEventListener('ended', () => {
      this.cancelFade();
      this.fading = false;
    });
    this.audio = audio;
    return audio;
  }

  private fadeIn(token: number, durationMs: number): void {
    const audio = this.audio;
    if (!audio) return;
    if (durationMs <= 0) {
      audio.volume = this.volume;
      return;
    }

    this.fading = true;
    const startedAt = performance.now();
    const tick = (now: number) => {
      if (token !== this.playToken || !this.audio || this.audio.paused) {
        this.fading = false;
        this.fadeRaf = 0;
        return;
      }

      const progress = Math.min(1, (now - startedAt) / durationMs);
      this.audio.volume = clamp01(this.volume * progress);
      if (progress < 1) {
        this.fadeRaf = window.requestAnimationFrame(tick);
      } else {
        this.fading = false;
        this.fadeRaf = 0;
        this.audio.volume = this.volume;
      }
    };

    this.fadeRaf = window.requestAnimationFrame(tick);
  }

  private cancelFade(): void {
    if (!this.fadeRaf) return;
    window.cancelAnimationFrame(this.fadeRaf);
    this.fadeRaf = 0;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
