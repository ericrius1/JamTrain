import { appendRivets } from './Rivets';

export class CaptureControl {
  readonly el: HTMLElement;
  private btn: HTMLButtonElement;
  private elapsedPlaque: HTMLElement;
  private timerEl: HTMLElement;
  private recording = false;
  private startedAt = 0;
  private rafHandle = 0;

  constructor(opts: { onToggle?: (recording: boolean) => void } = {}) {
    this.el = document.createElement('div');
    this.el.className = 'capture-host';

    this.elapsedPlaque = document.createElement('div');
    this.elapsedPlaque.className = 'plaque capture-elapsed rise';
    this.elapsedPlaque.style.display = 'none';
    appendRivets(this.elapsedPlaque);

    const lamp = document.createElement('span');
    lamp.className = 'lamp danger rec-pulse';
    this.timerEl = document.createElement('span');
    this.timerEl.className = 'timer';
    this.timerEl.innerHTML = '00:00<span class="cs">.00</span>';
    const v = document.createElement('span'); v.className = 'vline'; v.style.height = '18px';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'eyebrow';
    eyebrow.style.fontSize = '9px';
    eyebrow.innerHTML = 'Pressing the&nbsp;moment';
    this.elapsedPlaque.append(lamp, this.timerEl, v, eyebrow);
    this.el.appendChild(this.elapsedPlaque);

    this.btn = document.createElement('button');
    this.btn.className = 'btn';
    this.btn.style.display = 'flex';
    this.btn.style.alignItems = 'center';
    this.btn.style.gap = '10px';
    this.renderBtn();
    this.btn.addEventListener('click', () => {
      this.recording = !this.recording;
      this.renderBtn();
      if (this.recording) {
        this.elapsedPlaque.style.display = '';
        this.startedAt = performance.now();
        this.tick();
      } else {
        this.elapsedPlaque.style.display = 'none';
        cancelAnimationFrame(this.rafHandle);
      }
      opts.onToggle?.(this.recording);
    });
    this.el.appendChild(this.btn);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
  }

  private renderBtn(): void {
    this.btn.classList.toggle('primary', this.recording);
    const glyph = this.recording
      ? '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" fill="currentColor"/></svg>'
      : '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.5" fill="currentColor"/></svg>';
    this.btn.innerHTML = `${glyph}<span>${this.recording ? 'Seal Pressing' : 'Press Aura'}</span>`;
  }

  private tick = (): void => {
    if (!this.recording) return;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const mm = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const ss = Math.floor(elapsed % 60).toString().padStart(2, '0');
    const cs = Math.floor((elapsed % 1) * 100).toString().padStart(2, '0');
    this.timerEl.innerHTML = `${mm}:${ss}<span class="cs">.${cs}</span>`;
    this.rafHandle = requestAnimationFrame(this.tick);
  };
}
