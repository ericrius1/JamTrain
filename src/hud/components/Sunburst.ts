const SVG_NS = 'http://www.w3.org/2000/svg';

export function createSunburst(opts: {
  size?: number;
  color?: string;
  rays?: number;
  opacity?: number;
} = {}): SVGSVGElement {
  const size = opts.size ?? 120;
  const color = opts.color ?? 'var(--sun)';
  const rays = opts.rays ?? 16;
  const opacity = opts.opacity ?? 0.4;

  const r1 = size * 0.18;
  const r2 = size * 0.48;
  const c = size / 2;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.style.display = 'block';

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('opacity', String(opacity));

  for (let i = 0; i < rays; i += 1) {
    const a = (i / rays) * Math.PI * 2;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(c + Math.cos(a) * r1));
    line.setAttribute('y1', String(c + Math.sin(a) * r1));
    line.setAttribute('x2', String(c + Math.cos(a) * r2));
    line.setAttribute('y2', String(c + Math.sin(a) * r2));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1');
    g.appendChild(line);
  }

  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', String(c));
  ring.setAttribute('cy', String(c));
  ring.setAttribute('r', String(r1 - 2));
  ring.setAttribute('stroke', color);
  ring.setAttribute('fill', 'none');
  g.appendChild(ring);

  svg.appendChild(g);
  return svg;
}
