const DEFAULT_FADE_MS = 3000;
const NEXT_TRACK_PRELOAD_SECONDS = 20;
// The mastered MP3s are denser than the played instruments, so low mixer
// values need to fall away faster than a raw HTMLMediaElement volume scalar.
const BACKING_TRACK_MAX_MEDIA_VOLUME = 0.75;
const BACKING_TRACK_VOLUME_EXPONENT = 1.6;

type BackingTrack = {
  id: string;
  src: string;
  title: string;
  bpm: number;
  beatOffsetSeconds: number;
  key: string;
};

const TRAIN_BACKING_TRACKS: readonly BackingTrack[] = [
  {
    id: 'train1',
    src: '/backing_tracks/Train1.mp3',
    title: 'Midnight Train Glass',
    bpm: 76,
    beatOffsetSeconds: 0.07,
    key: 'C major',
  },
  {
    id: 'train2',
    src: '/backing_tracks/Train2.mp3',
    title: 'Midnight Rail Drift',
    bpm: 123.05,
    beatOffsetSeconds: 0.05,
    key: 'C major',
  },
];

export class BackingTrackRotation {
  private readonly tracks: readonly BackingTrack[];
  private readonly audioElements = new Map<number, HTMLAudioElement>();
  private readonly preparedTrackIndexes = new Set<number>();
  private readonly audioElementListeners = new Set<(audio: HTMLAudioElement) => void>();
  private activeAudio?: HTMLAudioElement;
  private currentIndex = 0;
  private volume = toMediaVolume(0.55);
  private fadeRaf = 0;
  private playToken = 0;
  private fading = false;

  constructor(tracks: readonly BackingTrack[] = TRAIN_BACKING_TRACKS) {
    if (tracks.length === 0) {
      throw new Error('BackingTrackRotation requires at least one track');
    }
    this.tracks = tracks;
  }

  getAudioElement(): HTMLAudioElement | undefined {
    return this.activeAudio;
  }

  onAudioElementChange(listener: (audio: HTMLAudioElement) => void): () => void {
    this.audioElementListeners.add(listener);
    if (this.activeAudio) listener(this.activeAudio);
    return () => {
      this.audioElementListeners.delete(listener);
    };
  }

  setVolume(value: number): void {
    this.volume = toMediaVolume(value);
    for (const audio of this.audioElements.values()) {
      if (audio === this.activeAudio && this.fading) continue;
      audio.volume = this.volume;
    }
  }

  async playWithFadeIn(durationMs = DEFAULT_FADE_MS): Promise<void> {
    await this.playCurrent(durationMs);
  }

  stop(): void {
    this.playToken++;
    this.cancelFade();
    this.fading = false;
    this.currentIndex = 0;
    this.preparedTrackIndexes.clear();
    for (const audio of this.audioElements.values()) {
      audio.pause();
      audio.volume = 0;
      this.seekToStart(audio);
    }
  }

  dispose(): void {
    this.stop();
    for (const audio of this.audioElements.values()) {
      audio.removeAttribute('src');
      audio.load();
    }
    this.audioElements.clear();
    this.audioElementListeners.clear();
    this.activeAudio = undefined;
  }

  private async playCurrent(durationMs: number): Promise<void> {
    const audio = this.ensureTrackSource(this.currentIndex, 'none');
    if (!audio.paused && !audio.ended) return;

    const token = ++this.playToken;
    this.cancelFade();
    this.fading = false;
    audio.volume = durationMs > 0 ? 0 : this.volume;
    this.setActiveAudio(audio);

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

  private ensureTrackSource(index: number, preload: 'none' | 'auto'): HTMLAudioElement {
    const audio = this.ensureTrackAudio(index);
    const track = this.tracks[index];
    if (audio.getAttribute('src') !== track.src) {
      audio.preload = preload;
      audio.src = track.src;
    } else if (preload === 'auto' && audio.preload !== 'auto') {
      audio.preload = 'auto';
    }
    audio.dataset.trackId = track.id;
    audio.dataset.trackTitle = track.title;
    audio.dataset.trackBpm = String(track.bpm);
    audio.dataset.beatOffsetSeconds = String(track.beatOffsetSeconds);
    audio.dataset.trackKey = track.key;
    return audio;
  }

  private ensureTrackAudio(index: number): HTMLAudioElement {
    const existing = this.audioElements.get(index);
    if (existing) return existing;

    const audio = document.createElement('audio');
    audio.preload = 'none';
    audio.volume = 0;
    audio.addEventListener('ended', () => this.handleEnded(index, audio));
    audio.addEventListener('timeupdate', () => this.preloadNextIfNearEnd(index, audio));
    audio.addEventListener('loadedmetadata', () => this.preloadNextIfNearEnd(index, audio));
    audio.addEventListener('durationchange', () => this.preloadNextIfNearEnd(index, audio));
    this.audioElements.set(index, audio);
    return audio;
  }

  private preloadNextIfNearEnd(index: number, audio: HTMLAudioElement): void {
    if (index !== this.currentIndex || audio !== this.activeAudio) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    if (audio.duration - audio.currentTime > NEXT_TRACK_PRELOAD_SECONDS) return;

    const nextIndex = this.nextIndex(index);
    if (this.preparedTrackIndexes.has(nextIndex)) return;
    const nextAudio = this.ensureTrackSource(nextIndex, 'auto');
    this.preparedTrackIndexes.add(nextIndex);
    try {
      nextAudio.load();
    } catch {
      // load() is best-effort; play() will request the media again if needed.
    }
  }

  private handleEnded(index: number, audio: HTMLAudioElement): void {
    if (index !== this.currentIndex || audio !== this.activeAudio) return;
    this.cancelFade();
    this.fading = false;
    audio.pause();
    this.seekToStart(audio);
    this.currentIndex = this.nextIndex(index);
    void this.playCurrent(0).catch(err => {
      console.warn('[jam-train] backing track rotation failed', err);
    });
  }

  private nextIndex(index: number): number {
    return (index + 1) % this.tracks.length;
  }

  private setActiveAudio(audio: HTMLAudioElement): void {
    if (audio === this.activeAudio) return;
    this.activeAudio = audio;
    for (const listener of this.audioElementListeners) listener(audio);
  }

  private seekToStart(audio: HTMLAudioElement): void {
    try {
      audio.currentTime = 0;
    } catch {
      // Some browsers reject seeking before metadata is available.
    }
  }

  private fadeIn(token: number, durationMs: number): void {
    const audio = this.activeAudio;
    if (!audio) return;
    if (durationMs <= 0) {
      audio.volume = this.volume;
      return;
    }

    this.fading = true;
    const startedAt = performance.now();
    const tick = (now: number) => {
      if (token !== this.playToken || !this.activeAudio || this.activeAudio.paused) {
        this.fading = false;
        this.fadeRaf = 0;
        return;
      }

      const progress = Math.min(1, (now - startedAt) / durationMs);
      this.activeAudio.volume = clamp01(this.volume * progress);
      if (progress < 1) {
        this.fadeRaf = window.requestAnimationFrame(tick);
      } else {
        this.fading = false;
        this.fadeRaf = 0;
        this.activeAudio.volume = this.volume;
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

function toMediaVolume(sliderValue: number): number {
  const v = clamp01(sliderValue);
  return BACKING_TRACK_MAX_MEDIA_VOLUME * Math.pow(v, BACKING_TRACK_VOLUME_EXPONENT);
}
