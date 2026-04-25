const SVG_NS = 'http://www.w3.org/2000/svg';

export function createMedallion(robot: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '44');
  svg.setAttribute('height', '44');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.style.filter = 'drop-shadow(0 2px 3px rgba(0,0,0,0.6))';

  const disc = document.createElementNS(SVG_NS, 'circle');
  disc.setAttribute('cx', '22');
  disc.setAttribute('cy', '22');
  disc.setAttribute('r', '20');
  disc.setAttribute('fill', '#1a120a');
  disc.setAttribute('stroke', '#8c6a2e');
  disc.setAttribute('stroke-width', '1.5');
  svg.appendChild(disc);

  const innerRing = document.createElementNS(SVG_NS, 'circle');
  innerRing.setAttribute('cx', '22');
  innerRing.setAttribute('cy', '22');
  innerRing.setAttribute('r', '18');
  innerRing.setAttribute('fill', 'none');
  innerRing.setAttribute('stroke', 'rgba(246,179,51,0.4)');
  innerRing.setAttribute('stroke-width', '0.6');
  svg.appendChild(innerRing);

  if (robot) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'spin-slow');
    g.style.transformOrigin = '22px 22px';

    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      const x = 22 + Math.cos(a) * 14;
      const y = 22 + Math.sin(a) * 14;
      const tooth = document.createElementNS(SVG_NS, 'rect');
      tooth.setAttribute('x', String(x - 1.5));
      tooth.setAttribute('y', String(y - 2.5));
      tooth.setAttribute('width', '3');
      tooth.setAttribute('height', '5');
      tooth.setAttribute('fill', 'var(--brass)');
      tooth.setAttribute('transform', `rotate(${(i / 10) * 360} ${x} ${y})`);
      g.appendChild(tooth);
    }

    const rim = document.createElementNS(SVG_NS, 'circle');
    rim.setAttribute('cx', '22');
    rim.setAttribute('cy', '22');
    rim.setAttribute('r', '10');
    rim.setAttribute('fill', 'none');
    rim.setAttribute('stroke', 'var(--brass)');
    rim.setAttribute('stroke-width', '1.2');
    g.appendChild(rim);

    const hub = document.createElementNS(SVG_NS, 'circle');
    hub.setAttribute('cx', '22');
    hub.setAttribute('cy', '22');
    hub.setAttribute('r', '3');
    hub.setAttribute('fill', 'var(--brass-3)');
    hub.setAttribute('stroke', 'var(--brass)');
    hub.setAttribute('stroke-width', '0.8');
    g.appendChild(hub);

    svg.appendChild(g);
  } else {
    const rays = document.createElementNS(SVG_NS, 'g');
    rays.setAttribute('class', 'spin-slow');
    rays.style.transformOrigin = '22px 22px';

    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      const x1 = 22 + Math.cos(a) * 9;
      const y1 = 22 + Math.sin(a) * 9;
      const x2 = 22 + Math.cos(a) * 15;
      const y2 = 22 + Math.sin(a) * 15;
      const ray = document.createElementNS(SVG_NS, 'line');
      ray.setAttribute('x1', String(x1));
      ray.setAttribute('y1', String(y1));
      ray.setAttribute('x2', String(x2));
      ray.setAttribute('y2', String(y2));
      ray.setAttribute('stroke', 'var(--sun)');
      ray.setAttribute('stroke-width', '1.2');
      ray.setAttribute('stroke-linecap', 'round');
      rays.appendChild(ray);
    }
    svg.appendChild(rays);

    const core = document.createElementNS(SVG_NS, 'circle');
    core.setAttribute('cx', '22');
    core.setAttribute('cy', '22');
    core.setAttribute('r', '7');
    core.setAttribute('fill', 'var(--sun)');
    svg.appendChild(core);

    const hot = document.createElementNS(SVG_NS, 'circle');
    hot.setAttribute('cx', '22');
    hot.setAttribute('cy', '22');
    hot.setAttribute('r', '5');
    hot.setAttribute('fill', 'var(--sun-2)');
    svg.appendChild(hot);
  }

  return svg;
}
