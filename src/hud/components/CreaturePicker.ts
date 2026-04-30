import { CREATURE_IDS, CREATURES, type CreatureId } from '../../game/creatures';
import { preloadCreatureAssets } from '../../game/rig/illustratedPuppets';

export type CreaturePickerOpts = {
  side: 'left' | 'right';
  initial: CreatureId;
  readonly?: boolean;
};

export class CreaturePicker {
  readonly el: HTMLDivElement;
  private buttons: Record<CreatureId, HTMLButtonElement>;
  private current: CreatureId;
  private readonlyMode: boolean;
  private listeners = new Set<(id: CreatureId) => void>();

  constructor(opts: CreaturePickerOpts) {
    this.current = opts.initial;
    this.readonlyMode = opts.readonly ?? false;

    this.el = document.createElement('div');
    this.el.className = `creature-picker ${opts.side}${this.readonlyMode ? ' readonly' : ''}`;

    this.buttons = {} as Record<CreatureId, HTMLButtonElement>;
    for (const id of CREATURE_IDS) {
      const meta = CREATURES[id];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'creature-picker-btn';
      btn.title = `${meta.label} — ${meta.subtitle}`;
      btn.style.setProperty('--creature-color', meta.color);
      btn.innerHTML = meta.iconSvg;
      btn.disabled = this.readonlyMode;
      btn.addEventListener('click', () => {
        if (this.readonlyMode) return;
        this.setSelected(id, true);
      });
      // Warm the browser cache for this creature's WebPs as soon as the
      // user hovers, so the click → setCreature texture fetch is instant.
      // Idempotent: repeated enters dedupe via preloadCreatureAssets.
      btn.addEventListener('pointerenter', () => {
        if (this.readonlyMode) return;
        void preloadCreatureAssets(id);
      });
      this.buttons[id] = btn;
      this.el.appendChild(btn);
    }
    this.refresh();
  }

  setSelected(id: CreatureId, fireListeners = false): void {
    if (this.current === id && !fireListeners) return;
    this.current = id;
    this.refresh();
    if (fireListeners) {
      for (const l of this.listeners) l(id);
    }
  }

  getSelected(): CreatureId {
    return this.current;
  }

  setReadonly(readonly: boolean): void {
    this.readonlyMode = readonly;
    this.el.classList.toggle('readonly', readonly);
    for (const id of CREATURE_IDS) this.buttons[id].disabled = readonly;
  }

  onSelect(listener: (id: CreatureId) => void): void {
    this.listeners.add(listener);
  }

  dispose(): void {
    this.el.remove();
    this.listeners.clear();
  }

  private refresh(): void {
    for (const id of CREATURE_IDS) {
      this.buttons[id].classList.toggle('active', id === this.current);
    }
  }
}
