const MUSIC_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9 18V5l12-2v13"/>
  <circle cx="6" cy="18" r="3"/>
  <circle cx="18" cy="16" r="3"/>
</svg>`;

const BACKING_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 12h2l2-7 4 14 3-9 2 6 1-3h4"/>
</svg>`;

const VOICE_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3" width="6" height="12" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <line x1="12" y1="18" x2="12" y2="22"/>
  <line x1="8.5" y1="22" x2="15.5" y2="22"/>
</svg>`;

export class MixerPanel {
  readonly el: HTMLDivElement;
  private backingSlider: HTMLInputElement;
  private musicSlider: HTMLInputElement;
  private voiceSlider: HTMLInputElement;
  private backingValueEl: HTMLSpanElement;
  private musicValueEl: HTMLSpanElement;
  private voiceValueEl: HTMLSpanElement;
  private backingListeners = new Set<(value: number) => void>();
  private musicListeners = new Set<(value: number) => void>();
  private voiceListeners = new Set<(value: number) => void>();

  constructor(opts: { backing: number; music: number; voice: number }) {
    this.el = document.createElement('div');
    this.el.className = 'mixer-panel plaque';

    const title = document.createElement('div');
    title.className = 'mixer-panel-title';
    title.textContent = 'Mix';
    this.el.appendChild(title);

    const backingRow = this.buildRow({
      label: 'Backing',
      icon: BACKING_SVG,
      value: opts.backing,
    });
    this.backingSlider = backingRow.slider;
    this.backingValueEl = backingRow.value;
    this.backingSlider.addEventListener('input', () => {
      const v = this.readSlider(this.backingSlider);
      this.backingValueEl.textContent = formatPercent(v);
      for (const l of this.backingListeners) l(v);
    });
    this.el.appendChild(backingRow.row);

    const musicRow = this.buildRow({
      label: 'Music',
      icon: MUSIC_SVG,
      value: opts.music,
    });
    this.musicSlider = musicRow.slider;
    this.musicValueEl = musicRow.value;
    this.musicSlider.addEventListener('input', () => {
      const v = this.readSlider(this.musicSlider);
      this.musicValueEl.textContent = formatPercent(v);
      for (const l of this.musicListeners) l(v);
    });
    this.el.appendChild(musicRow.row);

    const voiceRow = this.buildRow({
      label: 'Voice',
      icon: VOICE_SVG,
      value: opts.voice,
    });
    this.voiceSlider = voiceRow.slider;
    this.voiceValueEl = voiceRow.value;
    this.voiceSlider.addEventListener('input', () => {
      const v = this.readSlider(this.voiceSlider);
      this.voiceValueEl.textContent = formatPercent(v);
      for (const l of this.voiceListeners) l(v);
    });
    this.el.appendChild(voiceRow.row);
  }

  setBackingVolume(value: number): void {
    this.writeSlider(this.backingSlider, value);
    this.backingValueEl.textContent = formatPercent(value);
  }

  setMusicVolume(value: number): void {
    this.writeSlider(this.musicSlider, value);
    this.musicValueEl.textContent = formatPercent(value);
  }

  setVoiceVolume(value: number): void {
    this.writeSlider(this.voiceSlider, value);
    this.voiceValueEl.textContent = formatPercent(value);
  }

  onBackingChange(listener: (value: number) => void): void {
    this.backingListeners.add(listener);
  }

  onMusicChange(listener: (value: number) => void): void {
    this.musicListeners.add(listener);
  }

  onVoiceChange(listener: (value: number) => void): void {
    this.voiceListeners.add(listener);
  }

  private buildRow(opts: { label: string; icon: string; value: number }): {
    row: HTMLDivElement;
    slider: HTMLInputElement;
    value: HTMLSpanElement;
  } {
    const row = document.createElement('div');
    row.className = 'mixer-panel-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'mixer-panel-label';
    labelEl.innerHTML = `${opts.icon}<span>${opts.label}</span>`;
    row.appendChild(labelEl);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.className = 'mixer-panel-slider';
    slider.setAttribute('aria-label', `${opts.label} volume`);
    slider.value = String(Math.round(clamp01(opts.value) * 100));
    row.appendChild(slider);

    const value = document.createElement('span');
    value.className = 'mixer-panel-value';
    value.textContent = formatPercent(clamp01(opts.value));
    row.appendChild(value);

    return { row, slider, value };
  }

  private readSlider(el: HTMLInputElement): number {
    return clamp01(Number(el.value) / 100);
  }

  private writeSlider(el: HTMLInputElement, value: number): void {
    el.value = String(Math.round(clamp01(value) * 100));
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function formatPercent(v: number): string {
  return `${Math.round(clamp01(v) * 100)}`;
}
