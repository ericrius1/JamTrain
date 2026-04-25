import { appendRivets } from './Rivets';

export class BeginGate {
  readonly el: HTMLElement;
  private btn: HTMLButtonElement;
  private errEl: HTMLElement;
  private busy = false;

  constructor(opts: { onBegin: () => Promise<void> | void }) {
    this.el = document.createElement('div');
    this.el.className = 'begin-gate';

    const plaque = document.createElement('div');
    plaque.className = 'plaque begin-plaque';
    appendRivets(plaque);

    const stamp = document.createElement('div');
    stamp.className = 'stamp';
    stamp.textContent = '· The ·';
    plaque.appendChild(stamp);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Aura Cabin';
    plaque.appendChild(title);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = 'awaken the cabin — camera & audio';
    plaque.appendChild(body);

    this.btn = document.createElement('button');
    this.btn.className = 'btn primary';
    this.btn.textContent = 'Begin';
    this.btn.addEventListener('click', async () => {
      if (this.busy) return;
      this.busy = true;
      this.btn.disabled = true;
      this.btn.textContent = 'Awakening…';
      this.errEl.textContent = '';
      try {
        await opts.onBegin();
        this.dismiss();
      } catch (err) {
        this.busy = false;
        this.btn.disabled = false;
        this.btn.textContent = 'Try Again';
        this.errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    });
    plaque.appendChild(this.btn);

    this.errEl = document.createElement('div');
    this.errEl.className = 'err';
    plaque.appendChild(this.errEl);

    this.el.appendChild(plaque);
  }

  private dismiss(): void {
    this.el.classList.add('fade-out');
    setTimeout(() => this.el.remove(), 420);
  }
}
