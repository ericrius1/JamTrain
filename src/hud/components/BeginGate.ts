import { appendRivets } from './Rivets';

const SOLARPUNK_NAMES = [
  'AVA', 'SOLAS', 'AMARA', 'LUMEN', 'IRIS', 'NOVA', 'ORION', 'HELIO',
  'AETHER', 'CINDER', 'EMBER', 'CALLA', 'KAIRO', 'VESPER', 'ZENITH',
  'ASTRA', 'WREN', 'MOSS', 'RHEA', 'OSLA',
];

function pickName(): string {
  return SOLARPUNK_NAMES[Math.floor(Math.random() * SOLARPUNK_NAMES.length)];
}

export class BeginGate {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private btn: HTMLButtonElement;
  private rerollBtn: HTMLButtonElement;
  private errEl: HTMLElement;
  private busy = false;

  constructor(opts: { onBegin: (name: string) => Promise<void> | void }) {
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
    title.textContent = 'Jam Train';
    plaque.appendChild(title);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = 'awaken the cabin — camera & audio';
    plaque.appendChild(body);

    const nameLabel = document.createElement('div');
    nameLabel.className = 'eyebrow';
    nameLabel.style.fontSize = '10px';
    nameLabel.style.marginTop = '4px';
    nameLabel.textContent = 'Conductor';
    plaque.appendChild(nameLabel);

    const nameRow = document.createElement('div');
    nameRow.className = 'begin-name-row';
    this.input = document.createElement('input');
    this.input.className = 'begin-name-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.maxLength = 24;
    this.input.value = pickName();
    this.input.addEventListener('input', () => {
      this.input.value = this.input.value.toUpperCase();
    });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.btn.click();
      }
    });

    this.rerollBtn = document.createElement('button');
    this.rerollBtn.className = 'btn ghost begin-reroll';
    this.rerollBtn.type = 'button';
    this.rerollBtn.title = 'reroll a name';
    this.rerollBtn.textContent = '↻';
    this.rerollBtn.addEventListener('click', () => {
      let next = pickName();
      // Avoid the obvious case of rolling the same name twice in a row.
      if (next === this.input.value && SOLARPUNK_NAMES.length > 1) {
        next = pickName();
      }
      this.input.value = next;
      this.input.focus();
      this.input.select();
    });

    nameRow.append(this.input, this.rerollBtn);
    plaque.appendChild(nameRow);

    this.btn = document.createElement('button');
    this.btn.className = 'btn primary begin-start';
    this.btn.textContent = 'Start';
    this.btn.addEventListener('click', async () => {
      if (this.busy) return;
      const name = this.input.value.trim();
      if (!name) {
        this.errEl.textContent = 'name is required';
        this.input.focus();
        return;
      }
      this.busy = true;
      this.btn.disabled = true;
      this.input.disabled = true;
      this.rerollBtn.disabled = true;
      this.btn.textContent = 'Awakening…';
      this.errEl.textContent = '';
      try {
        await opts.onBegin(name);
        this.dismiss();
      } catch (err) {
        this.busy = false;
        this.btn.disabled = false;
        this.input.disabled = false;
        this.rerollBtn.disabled = false;
        this.btn.textContent = 'Try Again';
        this.errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    });
    plaque.appendChild(this.btn);

    this.errEl = document.createElement('div');
    this.errEl.className = 'err';
    plaque.appendChild(this.errEl);

    this.el.appendChild(plaque);

    // Defer focus until after the gate is mounted; selecting lets the user
    // overwrite the suggestion just by typing.
    queueMicrotask(() => {
      this.input.focus();
      this.input.select();
    });
  }

  private dismiss(): void {
    this.el.classList.add('fade-out');
    setTimeout(() => this.el.remove(), 420);
  }
}
