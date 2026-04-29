import type { InstrumentId } from '../../game/instruments';
import {
  DRUM_DEFAULT_BASE_ROW,
  drumKeyLabelsForOrbCount,
  drumOrbCountForBaseRow,
} from '../../game/drumControls';

const STORAGE_KEY = 'jamtrain.controlsPanel.collapsed';
const DEFAULT_DRUM_ORB_COUNT = drumOrbCountForBaseRow(DRUM_DEFAULT_BASE_ROW);
const TOUCH_QUERY = '(max-width: 768px), (pointer: coarse) and (hover: none)';

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

const STARLACE_CONTROLS: ControlsContent = {
  blurb: 'Sweep the constellation to sing.',
  rows: [
    { keys: ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'], hint: 'climb the scale' },
    { keys: ['Mouse'], hint: 'glide across the stars' },
    { keys: ['Hands'], hint: 'pinch and trace the lace' },
  ],
};

const STARLACE_TOUCH_CONTROLS: ControlsContent = {
  blurb: 'Swipe across the lace to sing.',
  rows: [{ keys: ['Swipe'], hint: 'across the stars' }],
};

function drumTouchControls(orbCount: number): ControlsContent {
  const hint = orbCount === 1 ? 'across the pad' : `across the ${orbCount} pads`;
  return {
    blurb: 'Swipe across the piano pads to play.',
    rows: [{ keys: ['Swipe'], hint }],
  };
}

export class ControlsPanel {
  readonly el: HTMLDetailsElement;
  private summaryTitleEl: HTMLSpanElement;
  private bodyEl: HTMLDivElement;
  private current: InstrumentId = 'drum';
  private drumOrbCount = DEFAULT_DRUM_ORB_COUNT;
  private touchMql?: MediaQueryList;
  private touchListener?: () => void;

  constructor(opts: { initial: InstrumentId }) {
    this.current = opts.initial;

    this.el = document.createElement('details');
    this.el.className = 'controls-panel plaque';
    // Default closed on touch/narrow viewports — the bottom-rail hint already
    // tells the user how to play; opening is opt-in.
    const touch = matchMedia(TOUCH_QUERY).matches;
    this.el.open = touch ? false : readCollapsedState() === false;

    if (typeof matchMedia === 'function') {
      this.touchMql = matchMedia(TOUCH_QUERY);
      this.touchListener = () => this.render();
      this.touchMql.addEventListener('change', this.touchListener);
    }

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

  setDrumOrbCount(count: number): void {
    const next = Math.max(1, Math.floor(count));
    if (next === this.drumOrbCount) return;
    this.drumOrbCount = next;
    if (this.current === 'drum') this.render();
  }

  private render(): void {
    const touch = this.touchMql?.matches ?? matchMedia(TOUCH_QUERY).matches;
    const content = this.current === 'drum'
      ? (touch ? drumTouchControls(this.drumOrbCount) : drumControlsForOrbCount(this.drumOrbCount))
      : (touch ? STARLACE_TOUCH_CONTROLS : STARLACE_CONTROLS);
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

function drumControlsForOrbCount(orbCount: number): ControlsContent {
  const keys = drumKeyLabelsForOrbCount(orbCount);
  const keyCount = keys.length;
  const hint = keyCount >= orbCount
    ? (orbCount === 1 ? 'play the pad' : `play all ${orbCount} pads`)
    : `play ${keyCount} of ${orbCount} pads`;

  return {
    blurb: 'Strike the piano pads to play.',
    rows: [
      { keys, hint },
      { keys: ['Mouse'], hint: 'click or drag through a pad' },
      { keys: ['Hands'], hint: 'reach forward through any pad' },
    ],
  };
}

function buildRow(entry: ControlEntry): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'controls-panel-row';

  const keysEl = document.createElement('div');
  keysEl.className = entry.keys.length > 10 ? 'controls-panel-keys dense' : 'controls-panel-keys';
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
  return id === 'drum' ? 'Piano Pads' : 'Starlace';
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
