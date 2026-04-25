import { appendRivets } from './Rivets';
import { pickRandomRoomName, sanitizeRoomName } from '../../game/roomNames';
import { shareUrlFor } from '../../game/router';

export type SharePopoverCallbacks = {
  onRoomChange: (room: string) => void;
};

export class SharePopover {
  readonly el: HTMLElement;
  private callbacks: SharePopoverCallbacks;
  private input!: HTMLInputElement;
  private urlPrefix!: HTMLSpanElement;
  private copyBtn!: HTMLButtonElement;
  private toast!: HTMLDivElement;
  private isOpen = false;
  private currentRoom: string;
  private onDocClick = (e: MouseEvent) => {
    const target = e.target as Node;
    if (this.el.contains(target)) return;
    this.close();
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
  };

  constructor(currentRoom: string, callbacks: SharePopoverCallbacks) {
    this.callbacks = callbacks;
    this.currentRoom = currentRoom;

    this.el = document.createElement('div');
    this.el.className = 'plaque share-popover hidden';
    appendRivets(this.el);
    this.render();
  }

  setRoom(room: string): void {
    this.currentRoom = room;
    if (document.activeElement !== this.input) {
      this.input.value = room;
    }
    this.refreshUrlPrefix();
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.el.classList.remove('hidden');
    this.input.value = this.currentRoom;
    this.refreshUrlPrefix();
    setTimeout(() => {
      document.addEventListener('mousedown', this.onDocClick);
      document.addEventListener('keydown', this.onKey);
    }, 0);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.add('hidden');
    document.removeEventListener('mousedown', this.onDocClick);
    document.removeEventListener('keydown', this.onKey);
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  dispose(): void {
    document.removeEventListener('mousedown', this.onDocClick);
    document.removeEventListener('keydown', this.onKey);
  }

  private render(): void {
    const header = document.createElement('div');
    header.className = 'header';
    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = '· Share this jam ·';
    header.appendChild(stamp);
    this.el.appendChild(header);

    const hr = document.createElement('div');
    hr.className = 'hline';
    hr.style.margin = '6px 0 12px';
    this.el.appendChild(hr);

    const urlRow = document.createElement('div');
    urlRow.className = 'share-url-row';

    this.urlPrefix = document.createElement('span');
    this.urlPrefix.className = 'share-url-prefix';
    urlRow.appendChild(this.urlPrefix);

    this.input = document.createElement('input');
    this.input.className = 'share-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.value = this.currentRoom;
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitInput();
      }
    });
    this.input.addEventListener('blur', () => this.commitInput());
    urlRow.appendChild(this.input);

    this.copyBtn = document.createElement('button');
    this.copyBtn.className = 'btn share-copy';
    this.copyBtn.title = 'Copy link';
    this.copyBtn.textContent = '📋';
    this.copyBtn.addEventListener('click', () => this.copyShareUrl());
    urlRow.appendChild(this.copyBtn);

    this.el.appendChild(urlRow);

    const surprise = document.createElement('button');
    surprise.className = 'btn ghost share-surprise';
    surprise.textContent = '↻ Surprise me';
    surprise.addEventListener('click', () => {
      const next = pickRandomRoomName(this.currentRoom);
      this.input.value = next;
      this.refreshUrlPrefix();
    });
    this.el.appendChild(surprise);

    const hint = document.createElement('div');
    hint.className = 'share-hint';
    hint.textContent = 'Send the link to a friend — they jam in the empty seat. If two people are already there, they get a fresh cabin.';
    this.el.appendChild(hint);

    this.toast = document.createElement('div');
    this.toast.className = 'share-toast';
    this.el.appendChild(this.toast);
  }

  private commitInput(): void {
    const next = sanitizeRoomName(this.input.value);
    if (!next) {
      this.input.value = this.currentRoom;
      return;
    }
    if (next === this.currentRoom) return;
    this.callbacks.onRoomChange(next);
  }

  private refreshUrlPrefix(): void {
    this.urlPrefix.textContent = `${window.location.host}/`;
  }

  private async copyShareUrl(): Promise<void> {
    const target = sanitizeRoomName(this.input.value) || this.currentRoom;
    const url = shareUrlFor(target);
    try {
      await navigator.clipboard.writeText(url);
      this.flashToast('Link copied');
    } catch {
      // Fallback: select the input so user can copy manually.
      this.input.select();
      this.flashToast('Press ⌘C to copy');
    }
  }

  private flashToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('visible');
    window.setTimeout(() => this.toast.classList.remove('visible'), 1400);
  }
}
