import { appendRivets } from './Rivets';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Note = { x: number; who: 'you' | 'peer'; pitch: number; life: number };

export class HarmonyBand {
  readonly el: HTMLElement;
  private keyEl: HTMLElement;
  private bpmEl: HTMLElement;
  private ribbon: SVGSVGElement;
  private notesGroup: SVGGElement;
  private notes: Note[] = [];
  private rafHandle = 0;
  private lastTick = performance.now();
  // TODO: wire to Tone.js note events
  private mockGen = true;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'plaque harmony-band';
    appendRivets(this.el);

    const header = document.createElement('div');
    header.className = 'harmony-header';

    const keyGroup = document.createElement('div');
    keyGroup.className = 'key-group';
    const keyStamp = document.createElement('span');
    keyStamp.className = 'stamp';
    keyStamp.textContent = 'Key';
    this.keyEl = document.createElement('span');
    this.keyEl.className = 'key-name';
    this.keyEl.textContent = 'D DORIAN';
    keyGroup.append(keyStamp, this.keyEl);

    const meta = document.createElement('div');
    meta.className = 'meta-group';
    this.bpmEl = document.createElement('span');
    this.bpmEl.className = 'meta-num';
    this.bpmEl.textContent = '92';
    const bpmLabel = document.createElement('span');
    bpmLabel.className = 'meta-label';
    bpmLabel.textContent = 'BPM';
    const v1 = document.createElement('span'); v1.className = 'vline'; v1.style.height = '16px';
    const meter = document.createElement('span');
    meter.className = 'meta-num'; meter.textContent = '4/4';
    const v2 = document.createElement('span'); v2.className = 'vline'; v2.style.height = '16px';
    const weaving = document.createElement('span');
    weaving.className = 'weaving';
    const lamp = document.createElement('span'); lamp.className = 'lamp pulse';
    const word = document.createElement('span'); word.textContent = 'weaving';
    weaving.append(lamp, word);
    meta.append(this.bpmEl, bpmLabel, v1, meter, v2, weaving);

    header.append(keyGroup, meta);
    this.el.appendChild(header);

    // Note ribbon
    this.ribbon = document.createElementNS(SVG_NS, 'svg');
    this.ribbon.setAttribute('width', '100%');
    this.ribbon.setAttribute('height', '58');
    this.ribbon.setAttribute('viewBox', '0 0 720 58');
    this.ribbon.setAttribute('preserveAspectRatio', 'none');
    this.ribbon.style.display = 'block';

    const defs = document.createElementNS(SVG_NS, 'defs');
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', 'harmony-rule');
    grad.setAttribute('x1', '0'); grad.setAttribute('x2', '1');
    for (const [off, col] of [['0%', 'rgba(200,154,75,0)'], ['50%', 'rgba(200,154,75,0.5)'], ['100%', 'rgba(200,154,75,0)']] as const) {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', off);
      stop.setAttribute('stop-color', col);
      grad.appendChild(stop);
    }
    defs.appendChild(grad);
    this.ribbon.appendChild(defs);

    const horizon = document.createElementNS(SVG_NS, 'line');
    horizon.setAttribute('x1', '0'); horizon.setAttribute('y1', '29');
    horizon.setAttribute('x2', '720'); horizon.setAttribute('y2', '29');
    horizon.setAttribute('stroke', 'url(#harmony-rule)');
    horizon.setAttribute('stroke-width', '1.5');
    this.ribbon.appendChild(horizon);

    const dashed = document.createElementNS(SVG_NS, 'line');
    dashed.setAttribute('x1', '0'); dashed.setAttribute('y1', '29');
    dashed.setAttribute('x2', '720'); dashed.setAttribute('y2', '29');
    dashed.setAttribute('stroke', 'rgba(246,179,51,0.18)');
    dashed.setAttribute('stroke-dasharray', '2 5');
    this.ribbon.appendChild(dashed);

    for (let i = 0; i < 17; i += 1) {
      const tick = document.createElementNS(SVG_NS, 'line');
      tick.setAttribute('x1', String(i * 45)); tick.setAttribute('y1', '24');
      tick.setAttribute('x2', String(i * 45)); tick.setAttribute('y2', '34');
      tick.setAttribute('stroke', 'rgba(200,154,75,0.3)');
      tick.setAttribute('stroke-width', '0.8');
      this.ribbon.appendChild(tick);
    }

    this.notesGroup = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    this.ribbon.appendChild(this.notesGroup);
    this.el.appendChild(this.ribbon);

    const legend = document.createElement('div');
    legend.className = 'harmony-legend';
    const youSpan = document.createElement('span');
    const youSwatch = document.createElement('span'); youSwatch.className = 'swatch you';
    const youLabel = document.createElement('span'); youLabel.className = 'label'; youLabel.textContent = 'You';
    youSpan.append(youSwatch, youLabel);
    const peerSpan = document.createElement('span');
    const peerLabel = document.createElement('span'); peerLabel.className = 'label'; peerLabel.textContent = 'Their voice';
    const peerSwatch = document.createElement('span'); peerSwatch.className = 'swatch peer';
    peerSpan.append(peerLabel, peerSwatch);
    legend.append(youSpan, peerSpan);
    this.el.appendChild(legend);

    this.tick();
  }

  setKey(name: string): void { this.keyEl.textContent = name; }
  setBpm(bpm: number): void { this.bpmEl.textContent = String(bpm); }

  // TODO: call from Tone.js synth attack
  pushNote(who: 'you' | 'peer', pitch: number): void {
    this.notes.push({ x: 0, who, pitch, life: 1 });
    if (this.notes.length > 30) this.notes.shift();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafHandle);
  }

  private tick = (): void => {
    const now = performance.now();
    const elapsed = now - this.lastTick;
    if (elapsed >= 120) {
      this.lastTick = now;
      this.notes = this.notes
        .map(n => ({ ...n, life: n.life - 0.03, x: n.x + 0.005 }))
        .filter(n => n.life > 0 && n.x < 1.05);
      // Mock generator until Tone.js wiring is in place
      if (this.mockGen && Math.random() < 0.55) {
        this.notes.push({
          x: 0,
          who: Math.random() < 0.55 ? 'you' : 'peer',
          pitch: 0.25 + Math.random() * 0.55,
          life: 1,
        });
        if (this.notes.length > 30) this.notes.shift();
      }
      this.draw();
    }
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    this.notesGroup.replaceChildren();
    for (const n of this.notes) {
      const x = n.x * 720;
      const y = 29 - (n.pitch - 0.5) * 38;
      const color = n.who === 'you' ? 'var(--sun)' : 'var(--patina)';
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('opacity', String(n.life));

      const stem = document.createElementNS(SVG_NS, 'line');
      stem.setAttribute('x1', String(x)); stem.setAttribute('y1', '29');
      stem.setAttribute('x2', String(x)); stem.setAttribute('y2', String(y));
      stem.setAttribute('stroke', color);
      stem.setAttribute('stroke-width', '1');
      g.appendChild(stem);

      const ball = document.createElementNS(SVG_NS, 'circle');
      ball.setAttribute('cx', String(x)); ball.setAttribute('cy', String(y));
      ball.setAttribute('r', String(2 + n.life * 2));
      ball.setAttribute('fill', color);
      g.appendChild(ball);

      const halo = document.createElementNS(SVG_NS, 'circle');
      halo.setAttribute('cx', String(x)); halo.setAttribute('cy', String(y));
      halo.setAttribute('r', String(6 + (1 - n.life) * 12));
      halo.setAttribute('fill', 'none');
      halo.setAttribute('stroke', color);
      halo.setAttribute('stroke-opacity', String(n.life * 0.4));
      g.appendChild(halo);

      this.notesGroup.appendChild(g);
    }
  }
}
