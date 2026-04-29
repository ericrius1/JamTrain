// BeginGate — TrainJam intro / "press start" screen.
//
// Sits as a transparent overlay on top of the live (but dimmed) Three scene.
// The 1920×1014 stage scales to fit the viewport so the title, conductor
// field, and ember motes keep their designed proportions across sizes.

import './BeginGate.css';

const CONDUCTOR_NAMES = [
  'Solas', 'Ember', 'Vesper', 'Cinder', 'Halcyon',
  'Marrow', 'Lumen', 'Atlas', 'Foxglove', 'Tannhauser',
  'Zenith', 'Ferry', 'Briar', 'Quill', 'Sable',
  'Ava', 'Amara', 'Iris', 'Nova', 'Orion',
];

const STAGE_W = 1920;
const STAGE_H = 1014;

function pickName(exclude?: string): string {
  const pool = exclude
    ? CONDUCTOR_NAMES.filter(n => n !== exclude)
    : CONDUCTOR_NAMES;
  return pool[Math.floor(Math.random() * pool.length)] ?? CONDUCTOR_NAMES[0];
}

export class BeginGate {
  readonly el: HTMLElement;
  private stage: HTMLElement;
  private input: HTMLInputElement;
  private btn: HTMLButtonElement;
  private rerollBtn: HTMLButtonElement;
  private errEl: HTMLElement;
  private resizeHandler: () => void;
  private busy = false;

  constructor(opts: { onBegin: (name: string) => Promise<void> | void }) {
    this.el = document.createElement('div');
    this.el.className = 'begin-gate';

    this.stage = document.createElement('div');
    this.stage.className = 'begin-stage';
    this.el.appendChild(this.stage);

    // Soft vignette + top/bottom fades so title and conductor field stay
    // legible against whatever (dimmed) scenery is showing through.
    this.stage.appendChild(this.div('begin-vignette'));
    this.stage.appendChild(this.div('begin-top-fade'));
    this.stage.appendChild(this.div('begin-bottom-fade'));

    // Drifting embers (decorative). Deterministic positions/timing so the
    // composition feels designed rather than randomly noisy.
    this.stage.appendChild(this.buildEmbers());

    this.stage.appendChild(this.buildTopRail());

    const titleBlock = this.buildTitleBlock();
    this.stage.appendChild(titleBlock);

    const { field, input, reroll, button, err } = this.buildConductorField();
    this.stage.appendChild(field);

    this.input = input;
    this.rerollBtn = reroll;
    this.btn = button;
    this.errEl = err;

    this.btn.addEventListener('click', () => this.submit(opts.onBegin));
    this.rerollBtn.addEventListener('click', () => {
      this.input.value = pickName(this.input.value.trim());
      this.input.classList.add('is-suggestion');
      this.input.focus();
      this.input.select();
    });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit(opts.onBegin);
      }
    });

    this.resizeHandler = () => this.fit();
    window.addEventListener('resize', this.resizeHandler);
    this.fit();

    // Defer focus until after the gate is mounted. Selecting lets the user
    // overwrite the suggestion just by typing.
    queueMicrotask(() => {
      this.input.focus();
      this.input.select();
    });

    // Runtime prewarming is coordinated by main.ts so the intro can paint
    // before the Three/WebGPU graph starts loading.
  }

  private fit(): void {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    const s = Math.min(sw / STAGE_W, sh / STAGE_H);
    this.stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }

  private div(className: string): HTMLElement {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  private buildEmbers(): HTMLElement {
    const wrap = this.div('begin-embers');
    wrap.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 18; i++) {
      const dot = document.createElement('span');
      dot.className = 'begin-ember';
      const left = (i * 47 + 13) % 100;
      const dur = 9 + (i % 5) * 2;
      const delay = (i * 0.7) % 10;
      const size = 2 + (i % 3);
      dot.style.left = `${left}%`;
      dot.style.width = `${size}px`;
      dot.style.height = `${size}px`;
      dot.style.animationDuration = `${dur}s`;
      dot.style.animationDelay = `${delay}s`;
      wrap.appendChild(dot);
    }
    return wrap;
  }

  private buildTopRail(): HTMLElement {
    const rail = this.div('begin-top-rail begin-fade-down');

    const meta = document.createElement('span');
    meta.className = 'begin-meta-left';
    meta.textContent = 'AURA  ·  LINE  ·  №  VII';
    rail.appendChild(meta);

    const date = document.createElement('span');
    date.className = 'begin-meta-right';
    date.textContent = 'MMXXVI';
    rail.appendChild(date);

    return rail;
  }

  private buildTitleBlock(): HTMLElement {
    const block = this.div('begin-title-block begin-fade-down begin-delay-1');

    // const eyebrow = this.div('begin-eyebrow');
    // eyebrow.textContent = '·  THE  ·';
    // block.appendChild(eyebrow);

    const display = this.div('begin-display');
    display.textContent = 'Jam Train';
    block.appendChild(display);

    const tagline = this.div('begin-tagline');
    tagline.innerHTML = `
      <p>Jam with your hands, mouse/trackpad, or keyboard</p>
      <p>Share your room link with a friend to climb aboard and join the jam.</p>
    `;
    block.appendChild(tagline);

    return block;
  }

  private buildConductorField(): {
    field: HTMLElement;
    input: HTMLInputElement;
    reroll: HTMLButtonElement;
    button: HTMLButtonElement;
    err: HTMLElement;
  } {
    // Conductor control stack at the bottom of the stage:
    // label → input + ↻ → BEGIN → blurb. The whole stack reads as a single
    // "conductor" control.
    const field = this.div('begin-conductor-field begin-fade-up begin-delay-2');
    const label = this.div('begin-conductor-label');
    label.textContent = 'CONDUCTOR';
    field.appendChild(label);

    const inputRow = this.div('begin-conductor-input-row');
    // Invisible spacer mirroring the reroll button so the input centers on
    // the same vertical axis as the BEGIN button below it.
    const spacer = this.div('begin-conductor-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'begin-conductor-input is-suggestion';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.maxLength = 24;
    input.value = pickName();
    input.setAttribute('aria-label', 'Conductor name');
    // First keystroke promotes the suggestion to a real value (full color).
    input.addEventListener('input', () => {
      input.classList.remove('is-suggestion');
    });

    const reroll = document.createElement('button');
    reroll.type = 'button';
    reroll.className = 'begin-reroll';
    reroll.title = 'reroll a name';
    reroll.setAttribute('aria-label', 'Reshuffle conductor name');
    reroll.textContent = '↻';

    inputRow.append(spacer, input, reroll);
    field.appendChild(inputRow);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'begin-start';
    button.innerHTML = 'ALL ABOARD <span aria-hidden="true">▸</span>';
    field.appendChild(button);

  

    const err = this.div('begin-err');
    field.appendChild(err);

    return { field, input, reroll, button, err };
  }

  private async submit(onBegin: (name: string) => Promise<void> | void): Promise<void> {
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
      await onBegin(name);
      this.dismiss();
    } catch (err) {
      this.busy = false;
      this.btn.disabled = false;
      this.input.disabled = false;
      this.rerollBtn.disabled = false;
      this.btn.innerHTML = 'TRY AGAIN <span aria-hidden="true">▸</span>';
      this.errEl.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  private dismiss(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.el.classList.add('fade-out');
    setTimeout(() => this.el.remove(), 520);
  }
}
