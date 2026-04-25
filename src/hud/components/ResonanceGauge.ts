import { appendRivets } from './Rivets';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Scenario = 'solo' | 'paired';

export class ResonanceGauge {
  readonly el: HTMLElement;
  private stampEl: HTMLElement;
  private bodyEl: HTMLElement;
  private needleEl: SVGGElement;
  private latencyEl: HTMLElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'plaque resonance-gauge';
    appendRivets(this.el);

    const row = document.createElement('div');
    row.className = 'gauge-row';
    this.el.appendChild(row);

    const copy = document.createElement('div');
    copy.className = 'gauge-copy';
    this.stampEl = document.createElement('div');
    this.stampEl.className = 'stamp';
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'body';
    copy.append(this.stampEl, this.bodyEl);
    row.appendChild(copy);

    const dial = document.createElement('div');
    dial.className = 'gauge-dial';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '86');
    svg.setAttribute('height', '86');
    svg.setAttribute('viewBox', '0 0 86 86');

    // Outer ring + recess
    svg.appendChild(this.circle(43, 43, 40, '#1a120a', '#8c6a2e', 2));
    svg.appendChild(this.circle(43, 43, 38, 'none', 'rgba(246,179,51,0.25)', 1));

    // Arc track
    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute('d', 'M 13 60 A 32 32 0 1 1 73 60');
    arc.setAttribute('stroke', 'rgba(0,0,0,0.5)');
    arc.setAttribute('stroke-width', '3');
    arc.setAttribute('fill', 'none');
    svg.appendChild(arc);

    // Tick marks
    for (let i = 0; i < 13; i += 1) {
      const a = ((-120 + i * 20) * Math.PI) / 180;
      const x1 = 43 + Math.cos(a) * 28;
      const y1 = 43 + Math.sin(a) * 28;
      const r2 = i % 3 === 0 ? 22 : 25;
      const x2 = 43 + Math.cos(a) * r2;
      const y2 = 43 + Math.sin(a) * r2;
      const tick = document.createElementNS(SVG_NS, 'line');
      tick.setAttribute('x1', String(x1));
      tick.setAttribute('y1', String(y1));
      tick.setAttribute('x2', String(x2));
      tick.setAttribute('y2', String(y2));
      tick.setAttribute('stroke', 'var(--brass)');
      tick.setAttribute('stroke-width', i % 3 === 0 ? '1.4' : '0.8');
      svg.appendChild(tick);
    }

    // Danger / patina zones
    const danger = document.createElementNS(SVG_NS, 'path');
    danger.setAttribute('d', 'M 43 43 L 13 60 A 32 32 0 0 1 23 21 Z');
    danger.setAttribute('fill', 'rgba(204,74,44,0.18)');
    svg.appendChild(danger);
    const patina = document.createElementNS(SVG_NS, 'path');
    patina.setAttribute('d', 'M 43 43 L 63 21 A 32 32 0 0 1 73 60 Z');
    patina.setAttribute('fill', 'rgba(111,191,168,0.16)');
    svg.appendChild(patina);

    // Needle group (rotated to angle)
    this.needleEl = document.createElementNS(SVG_NS, 'g') as SVGGElement;
    this.needleEl.classList.add('needle');
    const stem = document.createElementNS(SVG_NS, 'line');
    stem.setAttribute('x1', '43'); stem.setAttribute('y1', '43');
    stem.setAttribute('x2', '43'); stem.setAttribute('y2', '14');
    stem.setAttribute('stroke', 'var(--sun)');
    stem.setAttribute('stroke-width', '2');
    stem.setAttribute('stroke-linecap', 'round');
    this.needleEl.appendChild(stem);
    const tail = document.createElementNS(SVG_NS, 'line');
    tail.setAttribute('x1', '43'); tail.setAttribute('y1', '43');
    tail.setAttribute('x2', '43'); tail.setAttribute('y2', '50');
    tail.setAttribute('stroke', 'var(--sun-2)');
    tail.setAttribute('stroke-width', '3');
    tail.setAttribute('stroke-linecap', 'round');
    this.needleEl.appendChild(tail);
    svg.appendChild(this.needleEl);

    // Hub
    svg.appendChild(this.circle(43, 43, 4, '#3a2812', '#c89a4b', 1));
    const hub = document.createElementNS(SVG_NS, 'circle');
    hub.setAttribute('cx', '43'); hub.setAttribute('cy', '43');
    hub.setAttribute('r', '1.5'); hub.setAttribute('fill', 'var(--sun)');
    svg.appendChild(hub);

    dial.appendChild(svg);
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'RESONANCE';
    dial.appendChild(label);
    row.appendChild(dial);

    this.latencyEl = document.createElement('div');
    this.latencyEl.className = 'gauge-latency';
    this.latencyEl.style.display = 'none';
    this.el.appendChild(this.latencyEl);

    this.setScenario('solo');
  }

  setScenario(scenario: Scenario, peerName?: string, latencyMs?: number): void {
    const isSolo = scenario === 'solo';
    const value = isSolo ? 0.32 : 0.86;
    const angle = -120 + value * 240;
    this.needleEl.style.transform = `rotate(${angle}deg)`;

    this.stampEl.textContent = isSolo ? '· Solo Voyage ·' : '· Duet ·';
    if (isSolo) {
      this.bodyEl.innerHTML = 'The seat across <br>holds an automaton.';
      this.latencyEl.style.display = 'none';
    } else {
      const name = peerName ?? 'A friend';
      this.bodyEl.innerHTML = `${escapeHtml(name)} is aboard. <br>The cabin breathes.`;
      this.latencyEl.style.display = '';
      const handle = (peerName ?? 'peer').toLowerCase();
      const latency = latencyMs ?? 38;
      this.latencyEl.textContent = `spacetime · ${handle} · ${latency}ms`;
    }
  }

  private circle(cx: number, cy: number, r: number, fill: string, stroke: string, sw: number): SVGCircleElement {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    c.setAttribute('fill', fill);
    c.setAttribute('stroke', stroke);
    c.setAttribute('stroke-width', String(sw));
    return c;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
