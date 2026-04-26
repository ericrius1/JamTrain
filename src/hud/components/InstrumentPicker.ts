import { INSTRUMENT_IDS, INSTRUMENTS, type InstrumentId } from '../../game/instruments';

export type InstrumentPickerOpts = {
  side: 'left' | 'right';
  initial: InstrumentId;
  readonly?: boolean;
};

export class InstrumentPicker {
  readonly el: HTMLDivElement;
  private buttons: Record<InstrumentId, HTMLButtonElement>;
  private current: InstrumentId;
  private readonlyMode: boolean;
  private listeners = new Set<(id: InstrumentId) => void>();

  constructor(opts: InstrumentPickerOpts) {
    this.current = opts.initial;
    this.readonlyMode = opts.readonly ?? false;

    this.el = document.createElement('div');
    this.el.className = `instrument-picker ${opts.side}${this.readonlyMode ? ' readonly' : ''}`;

    this.buttons = {} as Record<InstrumentId, HTMLButtonElement>;
    for (const id of INSTRUMENT_IDS) {
      const meta = INSTRUMENTS[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'instrument-picker-btn';
      btn.title = `${meta.label} — ${meta.subtitle}`;
      btn.style.setProperty('--instrument-color', meta.color);
      btn.innerHTML = meta.iconSvg;
      btn.disabled = this.readonlyMode;
      btn.addEventListener('click', () => {
        if (this.readonlyMode) return;
        this.setSelected(id, true);
      });
      this.buttons[id] = btn;
      this.el.appendChild(btn);
    }
    this.refresh();
  }

  setSelected(id: InstrumentId, fireListeners = false): void {
    if (this.current === id && !fireListeners) return;
    this.current = id;
    this.refresh();
    if (fireListeners) {
      for (const l of this.listeners) l(id);
    }
  }

  getSelected(): InstrumentId {
    return this.current;
  }

  setReadonly(readonly: boolean): void {
    this.readonlyMode = readonly;
    this.el.classList.toggle('readonly', readonly);
    for (const id of INSTRUMENT_IDS) this.buttons[id].disabled = readonly;
  }

  onSelect(listener: (id: InstrumentId) => void): void {
    this.listeners.add(listener);
  }

  dispose(): void {
    this.el.remove();
    this.listeners.clear();
  }

  private refresh(): void {
    for (const id of INSTRUMENT_IDS) {
      this.buttons[id].classList.toggle('active', id === this.current);
    }
  }
}
