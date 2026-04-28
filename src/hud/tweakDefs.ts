import { FolderApi, Pane } from 'tweakpane';

/* ================================================================
   Declarative tweakpane params
   ----------------------------------------------------------------
   Each module exports a frozen DEFS object keeping value + metadata
   (default, min/max/step, folder, hidden, etc.) co-located. The
   helper below builds the params object, wires it to a Pane, and
   transparently persists changes to localStorage. Pressing R while
   the DevOverlay is visible restores every registered module to
   its in-code defaults.
   ================================================================ */

export type NumberDef = {
  type?: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
  options?: Record<string, number>;
  hidden?: boolean;
  folder?: string;
  label?: string;
};

export type BoolDef = {
  type: 'boolean';
  default: boolean;
  hidden?: boolean;
  folder?: string;
  label?: string;
};

export type ColorDef = {
  type: 'color';
  default: string;
  hidden?: boolean;
  folder?: string;
  label?: string;
};

export type SelectDef<V extends string = string> = {
  type: 'select';
  default: V;
  options: Record<string, V>;
  hidden?: boolean;
  folder?: string;
  label?: string;
};

export type StringDef = {
  type: 'string';
  default: string;
  readonly?: boolean;
  hidden?: boolean;
  folder?: string;
  label?: string;
};

export type Def = NumberDef | BoolDef | ColorDef | SelectDef | StringDef;

type Widen<T> = T extends number ? number
  : T extends boolean ? boolean
  : T extends string ? string
  : T;

export type ParamsOf<T extends Record<string, Def>> = {
  -readonly [K in keyof T]: Widen<T[K]['default']>;
};

export function makeParams<T extends Record<string, Def>>(defs: T): ParamsOf<T> {
  const params = {} as ParamsOf<T>;
  for (const k in defs) (params as Record<string, unknown>)[k] = defs[k].default;
  return params;
}

/* ----------- localStorage ----------- */

const KEY_PREFIX = 'jam-train-tweaks:';

function storageKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

function readOverrides(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function writeOverrides(key: string, params: Record<string, unknown>): void {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(params));
  } catch {
    // Quota or private mode — silently ignore; the in-memory params still work.
  }
}

function clearOverrides(key: string): void {
  try { localStorage.removeItem(storageKey(key)); } catch { /* noop */ }
}

/* ----------- Global registry for R-reset ----------- */

type ResetEntry = { key: string; reset: () => void };
const resetRegistry = new Set<ResetEntry>();

export function resetAllTweaks(): void {
  for (const e of resetRegistry) {
    try { e.reset(); } catch (err) {
      console.warn(`[tweakDefs] reset failed for ${e.key}`, err);
    }
  }
}

/** Register a non-tweakpane reset hook (e.g. mixer panel sliders) so it fires
 *  alongside the tweakpane-bound resets when the user presses R. */
export function registerResetHook(key: string, reset: () => void): () => void {
  const entry: ResetEntry = { key, reset };
  resetRegistry.add(entry);
  return () => { resetRegistry.delete(entry); };
}

/* ----------- Bind ----------- */

export type RegisterOptions<T extends Record<string, Def>> = {
  title: string;
  expanded?: boolean;
  /** Reuse an existing params object instead of creating a new one. Useful for
   *  modules whose params reference is exported and consumed elsewhere. */
  params?: ParamsOf<T>;
  /** Per-key callback fired on every change (and once at startup so persisted
   *  values propagate downstream into uniforms / dependent objects). */
  onChange?: { [K in keyof T]?: (value: ParamsOf<T>[K]) => void };
  /** Extra buttons grouped by folder. `folder: undefined` puts the button at the top level. */
  buttons?: Array<{ folder?: string; title: string; onClick: () => void }>;
};

export type RegisterResult<T extends Record<string, Def>> = {
  params: ParamsOf<T>;
  pane?: Pane;
  /** Restore params to their code defaults (without going through the global R reset). */
  reset: () => void;
  dispose: () => void;
};

export function registerTweaks<T extends Record<string, Def>>(
  paneDock: HTMLElement | undefined,
  key: string,
  defs: T,
  opts: RegisterOptions<T>,
): RegisterResult<T> {
  const params = opts.params ?? makeParams(defs);
  if (opts.params) {
    // Caller supplied a reference (e.g. handDepthConfig). Make sure it starts
    // from defaults before we layer persisted overrides on top.
    for (const k in defs) (params as Record<string, unknown>)[k] = defs[k].default;
  }

  // Apply persisted overrides (only known keys, only values of compatible primitive type).
  const overrides = readOverrides(key);
  if (overrides) {
    for (const k in defs) {
      if (!(k in overrides)) continue;
      const v = overrides[k];
      const def = defs[k];
      if (typeOfDef(def) !== typeof v) continue;
      (params as Record<string, unknown>)[k] = v;
    }
  }

  const fireChange = <K extends keyof T>(name: K, value: ParamsOf<T>[K]) => {
    const cb = opts.onChange?.[name];
    if (cb) cb(value);
  };

  // Push initial (possibly persisted) values downstream so consumers see the
  // restored state without us having to invoke the callbacks at the call site.
  for (const k in defs) {
    if (opts.onChange?.[k]) fireChange(k, params[k] as ParamsOf<T>[typeof k]);
  }

  let pane: Pane | undefined;
  let saveTimer: number | undefined;
  const scheduleSave = () => {
    if (saveTimer !== undefined) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      writeOverrides(key, params as Record<string, unknown>);
    }, 120);
  };

  if (paneDock) {
    const container = document.createElement('div');
    paneDock.appendChild(container);
    pane = new Pane({ title: opts.title, container });
    pane.expanded = opts.expanded ?? false;

    const folders = new Map<string, FolderApi>();
    const targetFor = (folderName?: string) => {
      if (!folderName) return pane!;
      let f = folders.get(folderName);
      if (!f) {
        f = pane!.addFolder({ title: folderName });
        folders.set(folderName, f);
      }
      return f;
    };

    for (const k in defs) {
      const def = defs[k];
      if (def.hidden) continue;

      const target = targetFor(def.folder);
      const bindOpts = bindingOptions(def);
      const binding = target.addBinding(params as Record<string, unknown>, k, bindOpts as never);

      // Tweakpane mutates params[k] in place before `change` fires, so we just
      // dispatch the latest value.
      binding.on('change', () => {
        scheduleSave();
        fireChange(k, params[k] as ParamsOf<T>[typeof k]);
      });
    }

    if (opts.buttons) {
      for (const btn of opts.buttons) {
        targetFor(btn.folder).addButton({ title: btn.title }).on('click', btn.onClick);
      }
    }
  }

  const reset = () => {
    for (const k in defs) {
      (params as Record<string, unknown>)[k] = defs[k].default;
    }
    clearOverrides(key);
    pane?.refresh();
    for (const k in defs) {
      if (opts.onChange?.[k]) fireChange(k, params[k] as ParamsOf<T>[typeof k]);
    }
  };

  const entry: ResetEntry = { key, reset };
  resetRegistry.add(entry);

  return {
    params,
    pane,
    reset,
    dispose: () => {
      resetRegistry.delete(entry);
      if (saveTimer !== undefined) {
        window.clearTimeout(saveTimer);
        writeOverrides(key, params as Record<string, unknown>);
      }
      pane?.dispose();
    },
  };
}

function typeOfDef(def: Def): 'number' | 'boolean' | 'string' {
  if (def.type === 'boolean') return 'boolean';
  if (def.type === 'color' || def.type === 'select' || def.type === 'string') return 'string';
  return 'number';
}

function bindingOptions(def: Def): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  if (def.label !== undefined) base.label = def.label;
  switch (def.type) {
    case 'boolean':
      return base;
    case 'color':
      // Tweakpane v4 auto-detects '#rrggbb' strings as color inputs.
      return base;
    case 'select':
      base.options = def.options;
      return base;
    case 'string':
      if (def.readonly) base.readonly = true;
      return base;
    default: {
      const n = def as NumberDef;
      if (n.options) base.options = n.options;
      if (n.min !== undefined) base.min = n.min;
      if (n.max !== undefined) base.max = n.max;
      if (n.step !== undefined) base.step = n.step;
      return base;
    }
  }
}
