import { appendRivets } from './Rivets';
import { createMedallion } from './Medallion';

export type PlayerSide = 'left' | 'right';
export type PlayerKind = 'conductor' | 'passenger' | 'automaton';

export class PlayerPlaque {
  readonly el: HTMLElement;
  private side: PlayerSide;
  private medallionWrap: HTMLElement;
  private stampEl: HTMLElement;
  private nameEl: HTMLElement;
  private voiceEl: HTMLElement;
  private currentRobot: boolean;

  constructor(opts: {
    side: PlayerSide;
    name: string;
    voice: string;
    kind: PlayerKind;
  }) {
    this.side = opts.side;
    this.currentRobot = opts.kind === 'automaton';

    this.el = document.createElement('div');
    this.el.className = `plaque player-plaque ${opts.side}`;
    appendRivets(this.el);

    this.medallionWrap = document.createElement('div');
    this.medallionWrap.className = 'medallion';
    this.medallionWrap.appendChild(createMedallion(this.currentRobot));
    this.el.appendChild(this.medallionWrap);

    this.stampEl = document.createElement('div');
    this.stampEl.className = 'stamp';
    this.stampEl.textContent = stampFor(opts.kind);
    this.el.appendChild(this.stampEl);

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'name';
    this.nameEl.textContent = opts.name;
    this.el.appendChild(this.nameEl);

    this.voiceEl = document.createElement('div');
    this.voiceEl.className = 'voice';
    this.voiceEl.textContent = opts.voice;
    this.el.appendChild(this.voiceEl);
  }

  set(opts: { name: string; voice: string; kind: PlayerKind }): void {
    this.nameEl.textContent = opts.name;
    this.voiceEl.textContent = opts.voice;
    this.stampEl.textContent = stampFor(opts.kind);
    const robot = opts.kind === 'automaton';
    if (robot !== this.currentRobot) {
      this.currentRobot = robot;
      this.medallionWrap.replaceChildren(createMedallion(robot));
    }
  }
}

function stampFor(kind: PlayerKind): string {
  switch (kind) {
    case 'conductor':  return '· Conductor ·';
    case 'passenger':  return '· Passenger ·';
    case 'automaton':  return '· Automaton ·';
  }
}
