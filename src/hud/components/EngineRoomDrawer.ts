import { appendRivets } from './Rivets';

export type CameraMode = 'game' | 'orbit';

export type EngineRoomCallbacks = {
  onRecalibrate: () => void;
  onDisembark: () => void;
  onCameraMode: (mode: CameraMode) => void;
};

const ROW_DEFS: Array<[string, string]> = [
  ['Camera',    'FaceTime HD · 1080p'],
  ['Audio Out', 'AirPods Pro · stereo'],
  ['Hands',     'Micro-Pose · web'],
  ['Net',       'spacetime · cabin-01'],
];

export class EngineRoomDrawer {
  readonly el: HTMLElement;
  private callbacks: EngineRoomCallbacks;
  private open = false;
  private rowValueEls = new Map<string, HTMLElement>();
  private gameBtn?: HTMLButtonElement;
  private orbitBtn?: HTMLButtonElement;
  private currentMode: CameraMode = 'game';

  constructor(callbacks: EngineRoomCallbacks) {
    this.callbacks = callbacks;
    this.el = document.createElement('div');
    this.el.className = 'engine-room-host';
    this.render();
  }

  setRow(key: string, value: string): void {
    const el = this.rowValueEls.get(key);
    if (el) el.textContent = value;
  }

  setCameraMode(mode: CameraMode): void {
    this.currentMode = mode;
    this.gameBtn?.classList.toggle('active', mode === 'game');
    this.orbitBtn?.classList.toggle('active', mode === 'orbit');
  }

  private render(): void {
    this.el.replaceChildren();
    if (this.open) this.renderOpen(); else this.renderClosed();
  }

  private renderClosed(): void {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.gap = '10px';
    btn.innerHTML = `${cogSvg()}Engine Room`;
    btn.addEventListener('click', () => { this.open = true; this.render(); });
    this.el.appendChild(btn);
  }

  private renderOpen(): void {
    const plaque = document.createElement('div');
    plaque.className = 'plaque engine-room-drawer rise';
    appendRivets(plaque);

    const header = document.createElement('div');
    header.className = 'header';
    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = '· Engine Room ·';
    const close = document.createElement('button');
    close.className = 'btn ghost';
    close.style.padding = '4px 10px';
    close.textContent = 'Close';
    close.addEventListener('click', () => { this.open = false; this.render(); });
    header.append(stamp, close);
    plaque.appendChild(header);

    const hr1 = document.createElement('div');
    hr1.className = 'hline';
    hr1.style.marginBottom = '10px';
    plaque.appendChild(hr1);

    this.rowValueEls.clear();
    for (const [k, v] of ROW_DEFS) {
      const row = document.createElement('div');
      row.className = 'row';
      const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
      const vs = document.createElement('span'); vs.className = 'v'; vs.textContent = v;
      row.append(ks, vs);
      plaque.appendChild(row);
      this.rowValueEls.set(k, vs);
    }

    const hr2 = document.createElement('div');
    hr2.className = 'hline';
    hr2.style.margin = '10px 0';
    plaque.appendChild(hr2);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const recal = document.createElement('button');
    recal.className = 'btn';
    recal.textContent = 'Recalibrate';
    recal.addEventListener('click', () => this.callbacks.onRecalibrate());
    const disembark = document.createElement('button');
    disembark.className = 'btn';
    disembark.textContent = 'Disembark';
    disembark.addEventListener('click', () => this.callbacks.onDisembark());
    actions.append(recal, disembark);
    plaque.appendChild(actions);

    const seg = document.createElement('div');
    seg.className = 'seg';
    this.gameBtn = document.createElement('button');
    this.gameBtn.textContent = 'Game';
    this.gameBtn.addEventListener('click', () => {
      this.setCameraMode('game');
      this.callbacks.onCameraMode('game');
    });
    this.orbitBtn = document.createElement('button');
    this.orbitBtn.textContent = 'Orbit';
    this.orbitBtn.addEventListener('click', () => {
      this.setCameraMode('orbit');
      this.callbacks.onCameraMode('orbit');
    });
    seg.append(this.gameBtn, this.orbitBtn);
    plaque.appendChild(seg);
    this.setCameraMode(this.currentMode);

    this.el.appendChild(plaque);
  }
}

function cogSvg(): string {
  let lines = '';
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    const x1 = 7 + Math.cos(a) * 5.5;
    const y1 = 7 + Math.sin(a) * 5.5;
    const x2 = 7 + Math.cos(a) * 6.8;
    const y2 = 7 + Math.sin(a) * 6.8;
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  return `
    <svg width="14" height="14" viewBox="0 0 14 14" class="spin-slow" style="transform-origin:center">
      <g fill="none" stroke="currentColor" stroke-width="1">
        <circle cx="7" cy="7" r="2.5"/>
        <circle cx="7" cy="7" r="5.5"/>
        ${lines}
      </g>
    </svg>`;
}
