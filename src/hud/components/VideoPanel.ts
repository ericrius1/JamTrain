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
    }

    this.label = document.createElement('div');
    this.label.className = 'video-panel-label';
    this.label.textContent = opts.mode === 'local' ? 'you · waiting' : 'partner · waiting';
    this.wrapper.appendChild(this.label);

    parent.appendChild(this.wrapper);
  }

  setHandTracker(tracker: HandTracker): void {
    if (this.mode !== 'local') return;
    this.handTracker = tracker;
    this.tickLocal();
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
    } else {
      this.label.textContent = 'partner · waiting';
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
