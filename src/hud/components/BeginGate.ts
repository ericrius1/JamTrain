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

    // Layered backdrop sits above the 3D canvas so the cabin doesn't bleed
    // through. Texture + warm vignette match the in-game brass aesthetic.
    const backdrop = document.createElement('div');
    backdrop.className = 'begin-backdrop';
    this.el.appendChild(backdrop);

    const stage = document.createElement('div');
    stage.className = 'begin-stage';
    this.el.appendChild(stage);

    // Hero artwork — solar-steampunk lion DJ. The image is what the
    // copy refers to ("best experienced with headphones") so it carries
    // most of the visual weight on this screen.
    const hero = document.createElement('div');
    hero.className = 'begin-hero';
    const heroImg = document.createElement('img');
    heroImg.src = '/intro-lion.png';
    heroImg.alt = '';
    heroImg.draggable = false;
    hero.appendChild(heroImg);
    stage.appendChild(hero);

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

    const headphones = document.createElement('div');
    headphones.className = 'begin-headphones';
    headphones.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
        <path d="M4 14h3v6H5a1 1 0 0 1-1-1z" />
        <path d="M20 14h-3v6h2a1 1 0 0 0 1-1z" />
      </svg>
      <span>Best experienced with headphones</span>
    `;
    plaque.appendChild(headphones);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = 'awaken the cabin — your browser will ask for webcam access to track your hands';
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
    this.input.classList.add('is-suggestion');
    this.input.addEventListener('input', () => {
      this.input.value = this.input.value.toUpperCase();
      this.input.classList.remove('is-suggestion');
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
      this.input.classList.add('is-suggestion');
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

    stage.appendChild(plaque);

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
