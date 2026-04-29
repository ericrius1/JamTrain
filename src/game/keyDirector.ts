import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';

export type Mode = 'major';

export type Key = {
  root: number; // 0-11 pitch class (C=0, D=2, ...)
  mode: Mode;
};

export type KeyChange = {
  current: Key;
  previous: Key;
  step: number;
};

export const KEY_DIRECTOR_DEFS = {
  lockedKey: { type: 'string', default: 'C major', readonly: true, label: 'locked key' },
} as const;

export type KeyDirectorParams = ParamsOf<typeof KEY_DIRECTOR_DEFS>;

export const LOCKED_C_MAJOR_KEY: Key = { root: 0, mode: 'major' };

type ChangeListener = (change: KeyChange) => void;

class KeyDirector {
  readonly params: KeyDirectorParams;
  private current: Key = LOCKED_C_MAJOR_KEY;
  private previous: Key = LOCKED_C_MAJOR_KEY;
  private listeners = new Set<ChangeListener>();
  private registered?: ReturnType<typeof registerTweaks<typeof KEY_DIRECTOR_DEFS>>;

  constructor() {
    this.params = { lockedKey: KEY_DIRECTOR_DEFS.lockedKey.default };
  }

  attachPane(paneDock?: HTMLElement): void {
    if (this.registered) return;
    this.registered = registerTweaks(paneDock, 'keyDirector', KEY_DIRECTOR_DEFS, {
      title: 'Key lock',
      params: this.params,
    });
  }

  setRoomSeed(_seed: number): void {
    this.setLockedKey();
  }

  setRoom(_roomId: string): void {
    this.setLockedKey();
  }

  getCurrent(): Key {
    return this.current;
  }

  getPrevious(): Key {
    return this.previous;
  }

  getStep(): number {
    return 0;
  }

  // The backing track is in C major, so the old per-room key tour is disabled
  // until the track/key relationship is made configurable.
  onChordBoundary(): void {
    this.setLockedKey();
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    listener({ current: this.current, previous: this.previous, step: 0 });
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.registered?.dispose();
    this.listeners.clear();
  }

  private setLockedKey(): void {
    this.previous = this.current;
    this.current = LOCKED_C_MAJOR_KEY;
    this.broadcast();
  }

  private broadcast(): void {
    const change: KeyChange = { current: this.current, previous: this.previous, step: 0 };
    for (const l of this.listeners) l(change);
  }
}

export const keyDirector = new KeyDirector();
