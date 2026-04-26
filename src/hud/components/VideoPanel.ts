import type { HandTracker } from '../../game/handTracking';
import type { Handedness } from '../../game/types';

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const COLORS: Record<Handedness, { stroke: string; fill: string; label: string }> = {
  left:  { stroke: '#52e2ff', fill: '#aef0ff', label: 'L' },
  right: { stroke: '#ff7ad6', fill: '#ffd2ec', label: 'R' },
};

type VideoPanelMode = 'local' | 'remote';
type VideoPanelSide = 'left' | 'right';

const CAMERA_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="6.5" width="13" height="11" rx="1.5"/>
  <path d="M15.5 10.5l5.5-3v9l-5.5-3z"/>
</svg>`;

const SHARE_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
  <circle cx="12" cy="12" r="3"/>
</svg>`;

const MIC_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3" width="6" height="12" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <line x1="12" y1="18" x2="12" y2="22"/>
  <line x1="8.5" y1="22" x2="15.5" y2="22"/>
</svg>`;

const EMPTY_CAMERA_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="6.5" width="13" height="11" rx="1.5"/>
  <path d="M15.5 10.5l5.5-3v9l-5.5-3z"/>
</svg>`;

const CAMERA_OFF_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="6.5" width="13" height="11" rx="1.5"/>
  <path d="M15.5 10.5l5.5-3v9l-5.5-3z"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;

const SHARE_OFF_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
  <circle cx="12" cy="12" r="3"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;

const MIC_OFF_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3" width="6" height="12" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <line x1="12" y1="18" x2="12" y2="22"/>
  <line x1="8.5" y1="22" x2="15.5" y2="22"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;

const PARTNER_BLIND_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
  <circle cx="12" cy="12" r="3"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;

export class VideoPanel {
  private wrapper: HTMLDivElement;
  private video: HTMLVideoElement;
  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D;
  private label: HTMLDivElement;
  private rafHandle = 0;
  private streamBound = false;
  private handTracker?: HandTracker;
  private mode: VideoPanelMode;
  private cameraButton?: HTMLButtonElement;
  private shareButton?: HTMLButtonElement;
  private micButton?: HTMLButtonElement;
  private emptyOverlay?: HTMLDivElement;
  private toolbar?: HTMLDivElement;
  private hintEl?: HTMLDivElement;
  private cameraListeners = new Set<() => void>();
  private shareVideoListeners = new Set<() => void>();
  private micListeners = new Set<() => void>();

  constructor(parent: HTMLElement, opts: { side: VideoPanelSide; mode: VideoPanelMode }) {
    this.mode = opts.mode;

    this.wrapper = document.createElement('div');
    this.wrapper.className = `video-panel ${opts.side} mode-${opts.mode}`;

    this.video = document.createElement('video');
    this.video.muted = opts.mode === 'local';
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.wrapper.appendChild(this.video);

    if (opts.mode === 'local') {
      this.canvas = document.createElement('canvas');
      this.wrapper.appendChild(this.canvas);
      const ctx = this.canvas.getContext('2d');
      if (!ctx) throw new Error('VideoPanel: 2d context unavailable');
      this.ctx = ctx;

      this.buildLocalControls();
      this.buildEmptyOverlay();
    }

    this.label = document.createElement('div');
    this.label.className = 'video-panel-label';
    this.label.textContent = opts.mode === 'local' ? 'you · waiting' : 'partner · waiting';
    this.wrapper.appendChild(this.label);

    // Remote panel stays hidden until the partner actually shares a stream —
    // otherwise it sits there as an empty black box covering the bottom-right
    // corner of the scene before anyone else has even joined.
    if (opts.mode === 'remote') {
      this.wrapper.classList.add('hidden');
    }

    parent.appendChild(this.wrapper);
  }

  private buildLocalControls(): void {
    const toolbar = document.createElement('div');
    toolbar.className = 'video-panel-toolbar';
    this.toolbar = toolbar;

    this.cameraButton = makeToolbarButton({
      label: 'Camera',
      title: 'Turn on your camera so the game can track your hands.',
      icon: CAMERA_SVG,
      onClick: () => { for (const l of this.cameraListeners) l(); },
    });
    this.shareButton = makeToolbarButton({
      label: 'Share Video',
      title: 'Optional — let your partner see your camera feed.',
      icon: SHARE_SVG,
      onClick: () => { for (const l of this.shareVideoListeners) l(); },
    });
    this.micButton = makeToolbarButton({
      label: 'Mic',
      title: 'Optional — let your partner hear you.',
      icon: MIC_SVG,
      onClick: () => { for (const l of this.micListeners) l(); },
    });
    // Share + Mic appear only after Camera is on (progressive disclosure).
    this.shareButton.dataset.stage = 'share';
    this.micButton.dataset.stage = 'share';

    toolbar.append(this.cameraButton, this.shareButton, this.micButton);

    const hint = document.createElement('div');
    hint.className = 'video-panel-toolbar-hint';
    hint.textContent = 'Tap Camera to track your hands · You can play without it with mouse/trackpad';
    toolbar.appendChild(hint);
    this.hintEl = hint;

    this.wrapper.appendChild(toolbar);
  }

  private buildEmptyOverlay(): void {
    const empty = document.createElement('div');
    empty.className = 'video-panel-empty';
    empty.innerHTML = `
      <div class="icon">${EMPTY_CAMERA_SVG}</div>
      <div class="heading">· Camera Off ·</div>
      <div class="subhead">Tap <em>Camera</em> above to track your hands</div>
      <div class="hint">You can still play without it — pointer-driven hands work too.</div>
    `;
    this.wrapper.appendChild(empty);
    this.emptyOverlay = empty;
  }

  setCameraEnabled(enabled: boolean): void {
    this.cameraButton?.classList.toggle('enabled', enabled);
    this.emptyOverlay?.classList.toggle('hidden', enabled);
    this.toolbar?.classList.toggle('share-revealed', enabled);
    if (this.hintEl) {
      this.hintEl.textContent = enabled
        ? 'Want your partner to see and hear you? Toggle Share Video / Mic →'
        : 'Tap Camera to track your hands · You can play without it with mouse/trackpad';
    }
  }

  setShareVideoEnabled(enabled: boolean): void {
    this.shareButton?.classList.toggle('enabled', enabled);
  }

  setMicEnabled(enabled: boolean): void {
    this.micButton?.classList.toggle('enabled', enabled);
  }

  onCameraClick(listener: () => void): void {
    this.cameraListeners.add(listener);
  }

  onShareVideoClick(listener: () => void): void {
    this.shareVideoListeners.add(listener);
  }

  onMicClick(listener: () => void): void {
    this.micListeners.add(listener);
  }

  setHandTracker(tracker: HandTracker): void {
    if (this.mode !== 'local') return;
    this.handTracker = tracker;
    this.tickLocal();
  }

  setRemoteVolume(volume: number): void {
    if (this.mode !== 'remote') return;
    this.video.volume = Math.max(0, Math.min(1, volume));
  }

  setStream(stream: MediaStream | null): void {
    if (this.mode !== 'remote') return;
    if (stream) {
      const tracks = stream.getTracks().map(t => `${t.kind}/${t.id.slice(0, 6)}/enabled=${t.enabled}/muted=${t.muted}`);
      console.info('[webrtc] remote panel setStream', tracks);
    } else {
      console.info('[webrtc] remote panel setStream(null)');
    }
    this.video.srcObject = stream;
    if (stream) {
      this.video.play()
        .then(() => console.info('[webrtc] remote video play() resolved'))
        .catch(err => console.warn('[webrtc] remote video play() rejected', err?.name, err?.message));
      this.label.textContent = 'partner · live';
      this.wrapper.classList.remove('hidden');
    } else {
      this.label.textContent = 'partner · waiting';
      this.wrapper.classList.add('hidden');
    }
  }

  setSide(side: VideoPanelSide): void {
    this.wrapper.classList.remove('left', 'right');
    this.wrapper.classList.add(side);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
    this.video.srcObject = null;
    this.wrapper.remove();
  }

  private tickLocal = (): void => {
    if (this.mode !== 'local') return;
    this.bindLocalStream();
    this.draw();
    this.rafHandle = requestAnimationFrame(this.tickLocal);
  };

  private bindLocalStream(): void {
    if (this.streamBound) return;
    const source = this.handTracker?.getVideo();
    if (!source?.srcObject) return;
    this.video.srcObject = source.srcObject;
    void this.video.play().catch(() => {});
    this.streamBound = true;
  }

  private draw(): void {
    if (!this.ctx || !this.canvas || !this.handTracker) return;

    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) {
      this.label.textContent = 'you · no signal';
      return;
    }

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const detections = this.handTracker.getDetections();
    if (detections.length === 0) {
      this.label.textContent = 'you · 0 hands';
      return;
    }

    for (const det of detections) {
      const color = COLORS[det.handedness];
      ctx.strokeStyle = color.stroke;
      ctx.fillStyle = color.fill;
      ctx.lineWidth = Math.max(2, Math.round(w / 320));

      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = det.landmarks[a];
        const pb = det.landmarks[b];
        if (!pa || !pb) continue;
        ctx.moveTo(pa.x * w, pa.y * h);
        ctx.lineTo(pb.x * w, pb.y * h);
      }
      ctx.stroke();

      const radius = Math.max(3, Math.round(w / 220));
      for (const lm of det.landmarks) {
        ctx.beginPath();
        ctx.arc(lm.x * w, lm.y * h, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      const wrist = det.landmarks[0];
      if (wrist) {
        ctx.font = `${Math.round(w / 24)}px 'JetBrains Mono', monospace`;
        ctx.fillStyle = color.stroke;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3;
        const text = `${color.label} ${(det.score * 100).toFixed(0)}%`;
        const tx = wrist.x * w + 12;
        const ty = wrist.y * h - 8;
        ctx.strokeText(text, tx, ty);
        ctx.fillText(text, tx, ty);
      }
    }

    const counts = detections.reduce(
      (acc, d) => ((acc[d.handedness] = (acc[d.handedness] ?? 0) + 1), acc),
      {} as Record<Handedness, number>
    );
    this.label.textContent = `you · L:${counts.left ?? 0} R:${counts.right ?? 0}`;
  }
}

function makeToolbarButton(opts: {
  label: string;
  title: string;
  icon: string;
  onClick: () => void;
}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'video-panel-toolbar-btn';
  btn.title = opts.title;
  btn.setAttribute('aria-label', opts.label);
  btn.innerHTML = `${opts.icon}<span>${opts.label}</span>`;
  btn.addEventListener('click', opts.onClick);
  return btn;
}
