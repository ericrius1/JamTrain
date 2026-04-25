/**
 * Top-center transient banner — used today for "X has boarded the jam train"
 * but generic enough for other ephemeral notices later.
 */
export class AnnouncementToast {
  readonly el: HTMLDivElement;
  private hideTimer = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'announcement-toast hidden';
  }

  show(text: string, durationMs = 3200): void {
    this.el.textContent = text;
    this.el.classList.remove('hidden');
    // Force reflow so re-show retriggers the entry transition.
    void this.el.offsetWidth;
    this.el.classList.add('visible');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), durationMs);
  }

  hide(): void {
    this.el.classList.remove('visible');
    window.setTimeout(() => {
      if (!this.el.classList.contains('visible')) this.el.classList.add('hidden');
    }, 600);
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer);
    this.el.remove();
  }
}
