import { appendRivets } from './Rivets';

export class TitlePlaque {
  readonly el: HTMLElement;
  private roomEl: HTMLElement;
  private lineEl: HTMLElement;
  private roomValue: string;
  private onRoomChange: (room: string) => void;

  constructor(opts: { room: string; line: string; onRoomChange: (room: string) => void }) {
    this.roomValue = opts.room;
    this.onRoomChange = opts.onRoomChange;

    this.el = document.createElement('div');
    this.el.className = 'plaque title-plaque';
    appendRivets(this.el);

    const stamp = document.createElement('div');
    stamp.className = 'stamp';
    stamp.style.marginBottom = '6px';
    stamp.textContent = '· The ·';
    this.el.appendChild(stamp);

    const name = document.createElement('div');
    name.className = 'title-name';
    name.innerHTML = 'Jam&nbsp;Train';
    this.el.appendChild(name);

    const tagline = document.createElement('div');
    tagline.className = 'title-tagline';
    tagline.textContent = 'a duet for fingertips & sunlight';
    this.el.appendChild(tagline);

    const hr = document.createElement('div');
    hr.className = 'hline';
    hr.style.margin = '12px 0 10px';
    this.el.appendChild(hr);

    const footer = document.createElement('div');
    footer.className = 'title-footer';

    const cabinCol = document.createElement('div');
    const cabinLabel = document.createElement('div');
    cabinLabel.className = 'label';
    cabinLabel.textContent = 'Destination';
    cabinCol.appendChild(cabinLabel);
    this.roomEl = document.createElement('div');
    this.roomEl.className = 'room';
    this.roomEl.title = 'click to change room';
    this.roomEl.textContent = this.roomValue;
    this.roomEl.addEventListener('click', () => this.beginEdit());
    cabinCol.appendChild(this.roomEl);

    const lineCol = document.createElement('div');
    lineCol.style.textAlign = 'right';
    const lineLabel = document.createElement('div');
    lineLabel.className = 'label';
    lineLabel.textContent = 'Line';
    lineCol.appendChild(lineLabel);
    this.lineEl = document.createElement('div');
    this.lineEl.className = 'line';
    this.lineEl.textContent = opts.line;
    lineCol.appendChild(this.lineEl);

    footer.append(cabinCol, lineCol);
    this.el.appendChild(footer);
  }

  setRoom(room: string): void {
    this.roomValue = room;
    this.roomEl.textContent = room;
  }

  setLine(line: string): void {
    this.lineEl.textContent = line;
  }

  private beginEdit(): void {
    this.roomEl.textContent = '';
    const input = document.createElement('input');
    input.value = this.roomValue;
    input.spellcheck = false;
    input.autocomplete = 'off';
    this.roomEl.appendChild(input);
    input.focus();
    input.select();

    const commit = (save: boolean) => {
      const next = input.value.trim();
      input.remove();
      if (save && next && next !== this.roomValue) {
        this.roomValue = next;
        this.onRoomChange(next);
      }
      this.roomEl.textContent = this.roomValue;
    };

    input.addEventListener('blur', () => commit(true));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
  }
}
