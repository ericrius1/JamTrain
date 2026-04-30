/* ================================================================
   Declarative runtime params
   ----------------------------------------------------------------
   Each module exports a frozen DEFS object keeping value + metadata
   (default, min/max/step, folder, hidden, etc.) co-located. The
   helper below keeps the params object and reset registry in one
   place without mounting any dev controls.
   ================================================================ */

export type NumberDef = {
  type?: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
  options?: Record<string, number>;
  hidden?: boolean;
  persisted?: boolean;
  folder?: string;
  label?: string;
};

export type BoolDef = {
  type: 'boolean';
  default: boolean;
  hidden?: boolean;
  persisted?: boolean;
  folder?: string;
  label?: string;
};

export type ColorDef = {
  type: 'color';
  default: string;
  hidden?: boolean;
  persisted?: boolean;
  folder?: string;
  label?: string;
};

export type SelectDef<V extends string = string> = {
  type: 'select';
  default: V;
  options: Record<string, V>;
  hidden?: boolean;
  persisted?: boolean;
  folder?: string;
  label?: string;
};

export type StringDef = {
  type: 'string';
  default: string;
  readonly?: boolean;
  hidden?: boolean;
  persisted?: boolean;
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

type ResetEntry = { key: string; reset: () => void };
const resetRegistry = new Set<ResetEntry>();

export function resetAllTweaks(): void {
  for (const e of resetRegistry) {
    try { e.reset(); } catch (err) {
      console.warn(`[runtimeParams] reset failed for ${e.key}`, err);
    }
  }
}

/** Register a reset hook (e.g. mixer panel sliders) so it fires alongside the
 *  runtime param resets when the user presses R. */
export function registerResetHook(key: string, reset: () => void): () => void {
  const entry: ResetEntry = { key, reset };
  resetRegistry.add(entry);
  return () => { resetRegistry.delete(entry); };
}

export type RegisterOptions<T extends Record<string, Def>> = {
  title: string;
  expanded?: boolean;
  /** Reuse an existing params object instead of creating a new one. Useful for
   *  modules whose params reference is exported and consumed elsewhere. */
  params?: ParamsOf<T>;
  /** Per-key callback fired once at startup and again whenever reset() runs. */
  onChange?: { [K in keyof T]?: (value: ParamsOf<T>[K]) => void };
  /** Kept for legacy call sites; no UI is mounted for these buttons. */
  buttons?: Array<{ folder?: string; title: string; onClick: () => void }>;
};

export type RegisterResult<T extends Record<string, Def>> = {
  params: ParamsOf<T>;
  /** Restore params to their code defaults (without going through the global R reset). */
  reset: () => void;
  dispose: () => void;
};

export function registerTweaks<T extends Record<string, Def>>(
  _paneDock: HTMLElement | undefined,
  key: string,
  defs: T,
  opts: RegisterOptions<T>,
): RegisterResult<T> {
  const params = opts.params ?? makeParams(defs);

  const fireChange = <K extends keyof T>(name: K, value: ParamsOf<T>[K]) => {
    const cb = opts.onChange?.[name];
    if (cb) cb(value);
  };

  for (const k in defs) {
    if (opts.onChange?.[k]) fireChange(k, params[k] as ParamsOf<T>[typeof k]);
  }

  const reset = () => {
    for (const k in defs) {
      (params as Record<string, unknown>)[k] = defs[k].default;
    }
    for (const k in defs) {
      if (opts.onChange?.[k]) fireChange(k, params[k] as ParamsOf<T>[typeof k]);
    }
  };

  const entry: ResetEntry = { key, reset };
  resetRegistry.add(entry);

  return {
    params,
    reset,
    dispose: () => {
      resetRegistry.delete(entry);
    },
  };
}
