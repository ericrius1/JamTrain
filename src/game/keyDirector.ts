import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import { hashString, streamFor } from './seedRandom';

export type Mode = 'majorPent' | 'minorPent';

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
  chordCyclesPerKey: { default: 4, min: 1, max: 12, step: 1, label: 'chord cycles per key' },
} as const;

export type KeyDirectorParams = ParamsOf<typeof KEY_DIRECTOR_DEFS>;

const DEFAULT_KEY: Key = { root: 2, mode: 'majorPent' };

// Curated starting keys — selected to sit near the existing D-major-pentatonic
// register so the playable range stays in a comfortable hand-tracked band and
// the bed doesn't drift too dark or too bright on a fresh cabin.
const SEED_KEYS: readonly Key[] = [
  { root: 2,  mode: 'majorPent' }, // D maj
  { root: 9,  mode: 'majorPent' }, // A maj
  { root: 7,  mode: 'majorPent' }, // G maj
  { root: 4,  mode: 'majorPent' }, // E maj
  { root: 11, mode: 'majorPent' }, // B maj
  { root: 11, mode: 'minorPent' }, // B min
  { root: 9,  mode: 'minorPent' }, // A min
  { root: 4,  mode: 'minorPent' }, // E min
  { root: 6,  mode: 'majorPent' }, // F# maj
  { root: 6,  mode: 'minorPent' }, // F# min
];

type Move =
  | { kind: 'shiftRoot'; semitones: number }
  | { kind: 'parallelMode' } // same root, swap major/minor pent
  | { kind: 'relativeMode' } // major <-> relative minor (down minor 3rd / up minor 3rd)
  | { kind: 'mediant'; semitones: number };

// Weighted move bag — adds up to ~100 conceptually. Close moves dominate; the
// emotional-turn moves (parallel-mode flip, mediant) are rarer so they feel earned.
const MOVES: { weight: number; move: Move }[] = [
  // Close diatonic moves (60% total)
  { weight: 18, move: { kind: 'shiftRoot', semitones: 7 } },   // up perfect 5th (V)
  { weight: 16, move: { kind: 'shiftRoot', semitones: -7 } },  // down 5th (IV)
  { weight: 14, move: { kind: 'shiftRoot', semitones: 5 } },   // up 4th
  { weight: 12, move: { kind: 'relativeMode' } },              // relative major/minor

  // Mode color shifts (25% total)
  { weight: 15, move: { kind: 'parallelMode' } },              // bright<->moody, same root

  // Emotional turns (15% total)
  { weight: 6,  move: { kind: 'mediant', semitones: 4 } },     // up major 3rd (chromatic mediant)
  { weight: 5,  move: { kind: 'mediant', semitones: -4 } },    // down major 3rd
  { weight: 4,  move: { kind: 'shiftRoot', semitones: 2 } },   // step up whole tone
];

const MODE_FROM_RELATIVE: Record<Mode, { mode: Mode; rootShift: number }> = {
  majorPent: { mode: 'minorPent', rootShift: -3 }, // D maj -> b min
  minorPent: { mode: 'majorPent', rootShift: 3 },  // a min -> C maj
};

function pickWeighted<T extends { weight: number }>(rng: () => number, bag: readonly T[]): T {
  const total = bag.reduce((sum, e) => sum + e.weight, 0);
  let r = rng() * total;
  for (const e of bag) {
    r -= e.weight;
    if (r <= 0) return e;
  }
  return bag[bag.length - 1];
}

function applyMove(key: Key, move: Move): Key {
  const root = ((n: number) => ((n % 12) + 12) % 12);
  switch (move.kind) {
    case 'shiftRoot':
      return { root: root(key.root + move.semitones), mode: key.mode };
    case 'parallelMode':
      return { root: key.root, mode: key.mode === 'majorPent' ? 'minorPent' : 'majorPent' };
    case 'relativeMode': {
      const rel = MODE_FROM_RELATIVE[key.mode];
      return { root: root(key.root + rel.rootShift), mode: rel.mode };
    }
    case 'mediant':
      return { root: root(key.root + move.semitones), mode: key.mode };
  }
}

function pickSeedKey(roomSeed: number): Key {
  const rng = streamFor(roomSeed, 0);
  return SEED_KEYS[Math.floor(rng() * SEED_KEYS.length)];
}

// Deterministic walk from the seed key. Both clients with the same roomSeed
// compute identical keys for any step. Walk is recomputed from step 0 each call
// (cheap — step counts stay in the dozens).
function walkTour(roomSeed: number, step: number): Key {
  let key = pickSeedKey(roomSeed);
  for (let i = 1; i <= step; i += 1) {
    const rng = streamFor(roomSeed, i);
    let next = key;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const move = pickWeighted(rng, MOVES).move;
      next = applyMove(key, move);
      if (next.root !== key.root || next.mode !== key.mode) break;
    }
    key = next;
  }
  return key;
}

type ChangeListener = (change: KeyChange) => void;

class KeyDirector {
  readonly params: KeyDirectorParams;
  private roomSeed = 0;
  private step = 0;
  private chordsSinceChange = 0;
  private current: Key = DEFAULT_KEY;
  private previous: Key = DEFAULT_KEY;
  private listeners = new Set<ChangeListener>();
  private registered?: ReturnType<typeof registerTweaks<typeof KEY_DIRECTOR_DEFS>>;

  constructor() {
    this.params = { ...Object.fromEntries(Object.entries(KEY_DIRECTOR_DEFS).map(([k, d]) => [k, d.default])) } as KeyDirectorParams;
  }

  attachPane(paneDock?: HTMLElement): void {
    if (this.registered) return;
    this.registered = registerTweaks(paneDock, 'keyDirector', KEY_DIRECTOR_DEFS, {
      title: 'Key tour',
      params: this.params,
    });
  }

  setRoomSeed(seed: number): void {
    if (seed === this.roomSeed && this.step === 0) return;
    this.roomSeed = seed >>> 0;
    this.step = 0;
    this.chordsSinceChange = 0;
    this.previous = this.current;
    this.current = walkTour(this.roomSeed, 0);
    this.broadcast();
  }

  setRoom(roomId: string): void {
    this.setRoomSeed(hashString(roomId));
  }

  getCurrent(): Key {
    return this.current;
  }

  getPrevious(): Key {
    return this.previous;
  }

  getStep(): number {
    return this.step;
  }

  // Called by audio.ts each time the chord cycle wraps. After
  // chordCyclesPerKey wraps we step the tour to a new key.
  onChordBoundary(): void {
    this.chordsSinceChange += 1;
    if (this.chordsSinceChange >= Math.max(1, Math.floor(this.params.chordCyclesPerKey))) {
      this.chordsSinceChange = 0;
      this.step += 1;
      this.previous = this.current;
      this.current = walkTour(this.roomSeed, this.step);
      this.broadcast();
    }
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    listener({ current: this.current, previous: this.previous, step: this.step });
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.registered?.dispose();
    this.listeners.clear();
  }

  private broadcast(): void {
    const change: KeyChange = { current: this.current, previous: this.previous, step: this.step };
    for (const l of this.listeners) l(change);
  }
}

export const keyDirector = new KeyDirector();
