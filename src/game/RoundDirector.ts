import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';

export const ROUND_DEFS = {
  roundDuration:    { default: 30,   min: 5,   max: 300, step: 1,   label: 'shape build seconds' },
  dissolveDuration: { default: 1.5,  min: 0.5, max: 4,   step: 0.1, label: 'dissolve seconds', hidden: true },
} as const;

export type RoundParams = ParamsOf<typeof ROUND_DEFS>;

export type RoundState = 'idle' | 'playing' | 'dissolving';

export type RoundSnapshot = {
  state: RoundState;
  inState: number;
  roundElapsed: number;
  progress: number;
  roundDuration: number;
  dissolveDuration: number;
  roundIndex: number;
};

type StateListener = (snapshot: RoundSnapshot) => void;
type EdgeListener = () => void;

export class RoundDirector {
  readonly params: RoundParams;
  private state: RoundState = 'idle';
  private inState = 0;
  private roundElapsed = 0;
  private roundIndex = 0;
  private stateListeners = new Set<StateListener>();
  private playingStartListeners = new Set<EdgeListener>();
  private dissolvingStartListeners = new Set<EdgeListener>();
  private registered?: ReturnType<typeof registerTweaks<typeof ROUND_DEFS>>;

  constructor(paneDock?: HTMLElement) {
    this.params = { ...Object.fromEntries(Object.entries(ROUND_DEFS).map(([k, d]) => [k, d.default])) } as RoundParams;
    this.registered = registerTweaks(paneDock, 'round', ROUND_DEFS, {
      title: 'Round',
      params: this.params,
    });
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'playing';
    this.inState = 0;
    this.roundElapsed = 0;
    this.roundIndex += 1;
    this.broadcast();
    for (const l of this.playingStartListeners) l();
  }

  tick(delta: number): RoundSnapshot {
    if (this.state === 'idle') return this.snapshot();
    this.inState += delta;
    if (this.state === 'playing') {
      this.roundElapsed += delta;
    } else if (this.state === 'dissolving') {
      this.roundElapsed += delta;
      if (this.inState >= this.params.dissolveDuration) {
        this.state = 'playing';
        this.inState = 0;
        this.roundElapsed = 0;
        this.roundIndex += 1;
        for (const l of this.playingStartListeners) l();
      }
    }
    this.broadcast();
    return this.snapshot();
  }

  snapshot(): RoundSnapshot {
    const progress = this.state === 'playing'
      ? this.roundElapsed / Math.max(0.001, this.params.roundDuration)
      : (this.state === 'dissolving' ? 1 : 0);
    return {
      state: this.state,
      inState: this.inState,
      roundElapsed: this.roundElapsed,
      progress,
      roundDuration: this.params.roundDuration,
      dissolveDuration: this.params.dissolveDuration,
      roundIndex: this.roundIndex,
    };
  }

  onState(listener: StateListener): void {
    this.stateListeners.add(listener);
    listener(this.snapshot());
  }

  onPlayingStart(listener: EdgeListener): void {
    this.playingStartListeners.add(listener);
  }

  onDissolvingStart(listener: EdgeListener): void {
    this.dissolvingStartListeners.add(listener);
  }

  dispose(): void {
    this.registered?.dispose();
    this.stateListeners.clear();
    this.playingStartListeners.clear();
    this.dissolvingStartListeners.clear();
  }

  private broadcast(): void {
    const s = this.snapshot();
    for (const l of this.stateListeners) l(s);
  }
}
