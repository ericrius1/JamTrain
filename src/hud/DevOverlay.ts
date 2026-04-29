import Stats from 'stats.js';
import { resetAllTweaks } from './tweakDefs';

export class DevOverlay {
  private paneDock: HTMLElement;
  private stats: Stats;
  private statsContainer: HTMLElement;
  private visible = false;
  private rafHandle = 0;
  private keyHandler: (e: KeyboardEvent) => void;
  private onToggle?: (visible: boolean) => void;
  private onCameraCycle?: () => void;

  constructor(
    paneDock: HTMLElement,
    onToggle?: (visible: boolean) => void,
    onCameraCycle?: () => void,
  ) {
    this.paneDock = paneDock;
    this.onToggle = onToggle;
    this.onCameraCycle = onCameraCycle;
    this.paneDock.classList.add('hidden');

    this.stats = new Stats();
    this.stats.showPanel(0); // 0: fps, 1: ms, 2: mb (if available)
    this.statsContainer = document.createElement('div');
    this.statsContainer.id = 'stats-panel';
    this.statsContainer.classList.add('hidden');
    this.statsContainer.appendChild(this.stats.dom);
    // Stats.js sets `position: fixed` on its dom; override to play with our wrapper
    this.stats.dom.style.position = 'static';

    document.body.appendChild(this.statsContainer);

    this.keyHandler = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        (target instanceof HTMLElement && target.isContentEditable)
      )) return;
      if (e.key === '/') {
        e.preventDefault();
        this.toggle();
        return;
      }
      if (this.visible && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        this.onCameraCycle?.();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        resetAllTweaks();
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.paneDock.classList.toggle('hidden', !this.visible);
    this.statsContainer.classList.toggle('hidden', !this.visible);
    if (this.visible) {
      this.tick();
    } else {
      cancelAnimationFrame(this.rafHandle);
    }
    this.onToggle?.(this.visible);
  }

  isVisible(): boolean {
    return this.visible;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keyHandler);
    cancelAnimationFrame(this.rafHandle);
    this.statsContainer.remove();
  }

  private tick = (): void => {
    this.stats.update();
    this.rafHandle = requestAnimationFrame(this.tick);
  };
}
