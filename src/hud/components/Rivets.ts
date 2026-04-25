export function appendRivets(host: HTMLElement): void {
  for (const corner of ['tl', 'tr', 'bl', 'br'] as const) {
    const rivet = document.createElement('span');
    rivet.className = `rivet ${corner}`;
    host.appendChild(rivet);
  }
}
