const SVG_NS = 'http://www.w3.org/2000/svg';

export function createCornerFiligree(): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 56 56');
    svg.setAttribute('class', `corner-filigree ${corner}`);

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', 'var(--brass)');
    g.setAttribute('stroke-width', '1');

    const p1 = document.createElementNS(SVG_NS, 'path');
    p1.setAttribute('d', 'M0 18 L0 0 L18 0');
    g.appendChild(p1);

    const p2 = document.createElementNS(SVG_NS, 'path');
    p2.setAttribute('d', 'M4 22 Q 10 10 22 4');
    p2.setAttribute('stroke-opacity', '0.5');
    g.appendChild(p2);

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', '6');
    dot.setAttribute('cy', '6');
    dot.setAttribute('r', '2');
    dot.setAttribute('fill', 'var(--sun)');
    dot.setAttribute('stroke', 'none');
    dot.setAttribute('opacity', '0.7');
    g.appendChild(dot);

    svg.appendChild(g);
    frag.appendChild(svg);
  }
  return frag;
}
