import type { InstrumentId } from '../../game/instruments';

const STORAGE_KEY = 'jamtrain.controlsPanel.collapsed';

type ControlEntry = {
  /** Lead glyph(s) — usually keycap letters but can be any short token. */
  keys: string[];
  /** Plain-language description of what the keys do. */
  hint: string;
};

type ControlsContent = {
  blurb: string;
  rows: ControlEntry[];
};

const DRUM_CONTROLS: ControlsContent = {
  blurb: 'Strike the orbs to play.',
  rows: [
    { keys: ['A', 'S', 'D', 'F', 'G'], hint: 'play the five orbs' },
    { keys: ['Mouse'], hint: 'click or drag through an orb' },
    { keys: ['Hands'], hint: 'reach forward through any orb' },
  ],
};

const STARLACE_CONTROLS: ControlsContent = {
  blurb: 'Sweep the constellation to sing.',
  rows: [
    { keys: ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'], hint: 'climb the scale' },
    { keys: ['Mouse'], hint: 'glide across the stars' },
    { keys: ['Hands'], hint: 'pinch and trace the lace' },
  ],
};

const CONTENT: Record<InstrumentId, ControlsContent> = {
  drum: DRUM_CONTROLS,
  starlace: STARLACE_CONTROLS,
};

export class ControlsPanel {
  readonly el: HTMLDetailsElement;
  private summaryTitleEl: HTMLSpanElement;
  private bodyEl: HTMLDivElement;
  private current: InstrumentId = 'drum';

  constructor(opts: { initial: InstrumentId }) {
    this.current = opts.initial;

    this.el = document.createElement('details');
    this.el.className = 'controls-panel plaque';
    this.el.open = readCollapsedState() === false;

    const summary = document.createElement('summary');
    summary.className = 'controls-panel-summary';

    const titleWrap = document.createElement('span');
    titleWrap.className = 'controls-panel-summary-title';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'controls-panel-eyebrow';
    eyebrow.textContent = 'Controls';
    this.summaryTitleEl = document.createElement('span');
    this.summaryTitleEl.className = 'controls-panel-instrument';
    titleWrap.appendChild(eyebrow);
    titleWrap.appendChild(this.summaryTitleEl);
    summary.appendChild(titleWrap);

    const chevron = document.createElement('span');
    chevron.className = 'controls-panel-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    summary.appendChild(chevron);

    this.el.appendChild(summary);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'controls-panel-body';
    this.el.appendChild(this.bodyEl);

    this.el.addEventListener('toggle', () => {
      writeCollapsedState(!this.el.open);
    });

    this.render();
  }

  setInstrument(id: InstrumentId): void {
    if (id === this.current) return;
    this.current = id;
    this.render();
  }

  private render(): void {
    const content = CONTENT[this.current];
    this.summaryTitleEl.textContent = labelFor(this.current);

    this.bodyEl.replaceChildren();

    const blurb = document.createElement('div');
    blurb.className = 'controls-panel-blurb';
    blurb.textContent = content.blurb;
    this.bodyEl.appendChild(blurb);

    const list = document.createElement('div');
    list.className = 'controls-panel-list';
    for (const entry of content.rows) {
      list.appendChild(buildRow(entry));
    }
    this.bodyEl.appendChild(list);
  }
}

function buildRow(entry: ControlEntry): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'controls-panel-row';

  const keysEl = document.createElement('div');
  keysEl.className = 'controls-panel-keys';
  for (const key of entry.keys) {
    const kbd = document.createElement('kbd');
    kbd.className = key.length > 1 ? 'controls-panel-key wide' : 'controls-panel-key';
    kbd.textContent = key;
    keysEl.appendChild(kbd);
  }
  row.appendChild(keysEl);

  const hint = document.createElement('span');
  hint.className = 'controls-panel-hint';
  hint.textContent = entry.hint;
  row.appendChild(hint);

  return row;
}

function labelFor(id: InstrumentId): string {
  return id === 'drum' ? 'Drum' : 'Starlace';
}

function readCollapsedState(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsedState(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore — preference is non-critical
  }
}
