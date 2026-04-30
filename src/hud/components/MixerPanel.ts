const MUSIC_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9 18V5l12-2v13"/>
  <circle cx="6" cy="18" r="3"/>
  <circle cx="18" cy="16" r="3"/>
</svg>`;

const TRACK_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 20 10 4"/>
  <path d="M17 20 14 4"/>
  <path d="M8 9h8"/>
  <path d="M7 14h10"/>
  <path d="M5 20h14"/>
</svg>`;

const VOICE_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3" width="6" height="12" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <line x1="12" y1="18" x2="12" y2="22"/>
  <line x1="8.5" y1="22" x2="15.5" y2="22"/>
</svg>`;

const MIDI_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="6" width="18" height="12" rx="1.5"/>
  <line x1="8" y1="6" x2="8" y2="13"/>
  <line x1="12" y1="6" x2="12" y2="13"/>
  <line x1="16" y1="6" x2="16" y2="13"/>
</svg>`;

export type MidiButtonState =
  | { kind: 'idle' }
  | { kind: 'unsupported' }
  | { kind: 'connecting' }
  | { kind: 'enabled'; inputs: string[] }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

export class MixerPanel {
  readonly el: HTMLDivElement;
  private musicSlider: HTMLInputElement;
  private starlaceSlider: HTMLInputElement;
  private orbSlider: HTMLInputElement;
  private backingSlider: HTMLInputElement;
  private voiceSlider: HTMLInputElement;
  private musicValueEl: HTMLSpanElement;
  private starlaceValueEl: HTMLSpanElement;
  private orbValueEl: HTMLSpanElement;
  private backingValueEl: HTMLSpanElement;
  private voiceValueEl: HTMLSpanElement;
  private musicListeners = new Set<(value: number) => void>();
  private starlaceListeners = new Set<(value: number) => void>();
  private orbListeners = new Set<(value: number) => void>();
  private backingListeners = new Set<(value: number) => void>();
  private voiceListeners = new Set<(value: number) => void>();
  private midiButton: HTMLButtonElement;
  private midiTooltip: HTMLSpanElement;
  private midiClickListeners = new Set<() => void>();
  private midiState: MidiButtonState = { kind: 'idle' };

  constructor(opts: { music: number; starlace: number; orb: number; backing: number; voice: number }) {
    this.el = document.createElement('div');
    this.el.className = 'mixer-panel plaque';

    const titleRow = document.createElement('div');
    titleRow.className = 'mixer-panel-title-row';

    const title = document.createElement('div');
    title.className = 'mixer-panel-title';
    title.textContent = 'Mix';
    titleRow.appendChild(title);

    this.midiButton = document.createElement('button');
    this.midiButton.type = 'button';
    this.midiButton.className = 'mixer-panel-midi-button';
    this.midiButton.innerHTML = MIDI_SVG;
    this.midiButton.setAttribute('aria-label', 'Connect MIDI device');
    this.midiTooltip = document.createElement('span');
    this.midiTooltip.className = 'mixer-panel-midi-tooltip';
    this.midiButton.appendChild(this.midiTooltip);
    this.midiButton.addEventListener('click', e => {
      e.stopPropagation();
      if (this.midiState.kind === 'unsupported' || this.midiState.kind === 'connecting') return;
      for (const l of this.midiClickListeners) l();
    });
    titleRow.appendChild(this.midiButton);

    this.el.appendChild(titleRow);
    this.applyMidiState();

    const musicRow = this.buildRow({
      label: 'Instruments',
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

    const starlaceRow = this.buildRow({
      label: 'Starlace',
      icon: MUSIC_SVG,
      value: opts.starlace,
    });
    this.starlaceSlider = starlaceRow.slider;
    this.starlaceValueEl = starlaceRow.value;
    this.starlaceSlider.addEventListener('input', () => {
      const v = this.readSlider(this.starlaceSlider);
      this.starlaceValueEl.textContent = formatPercent(v);
      for (const l of this.starlaceListeners) l(v);
    });
    this.el.appendChild(starlaceRow.row);

    const orbRow = this.buildRow({
      label: 'Piano Pads',
      icon: MUSIC_SVG,
      value: opts.orb,
    });
    this.orbSlider = orbRow.slider;
    this.orbValueEl = orbRow.value;
    this.orbSlider.addEventListener('input', () => {
      const v = this.readSlider(this.orbSlider);
      this.orbValueEl.textContent = formatPercent(v);
      for (const l of this.orbListeners) l(v);
    });
    this.el.appendChild(orbRow.row);

    const backingRow = this.buildRow({
      label: 'Backing Track',
      ariaLabel: 'Backing track volume',
      icon: TRACK_SVG,
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

  setMusicVolume(value: number): void {
    this.writeSlider(this.musicSlider, value);
    this.musicValueEl.textContent = formatPercent(value);
  }

  setStarlaceVolume(value: number): void {
    this.writeSlider(this.starlaceSlider, value);
    this.starlaceValueEl.textContent = formatPercent(value);
  }

  setOrbVolume(value: number): void {
    this.writeSlider(this.orbSlider, value);
    this.orbValueEl.textContent = formatPercent(value);
  }

  setBackingVolume(value: number): void {
    this.writeSlider(this.backingSlider, value);
    this.backingValueEl.textContent = formatPercent(value);
  }

  setVoiceVolume(value: number): void {
    this.writeSlider(this.voiceSlider, value);
    this.voiceValueEl.textContent = formatPercent(value);
  }

  onMusicChange(listener: (value: number) => void): void {
    this.musicListeners.add(listener);
  }

  onStarlaceChange(listener: (value: number) => void): void {
    this.starlaceListeners.add(listener);
  }

  onOrbChange(listener: (value: number) => void): void {
    this.orbListeners.add(listener);
  }

  onBackingChange(listener: (value: number) => void): void {
    this.backingListeners.add(listener);
  }

  onVoiceChange(listener: (value: number) => void): void {
    this.voiceListeners.add(listener);
  }

  onMidiClick(listener: () => void): void {
    this.midiClickListeners.add(listener);
  }

  setMidiState(state: MidiButtonState): void {
    this.midiState = state;
    this.applyMidiState();
  }

  private applyMidiState(): void {
    const state = this.midiState;
    this.midiButton.classList.remove(
      'mixer-panel-midi-button--idle',
      'mixer-panel-midi-button--connecting',
      'mixer-panel-midi-button--enabled',
      'mixer-panel-midi-button--error',
      'mixer-panel-midi-button--disabled',
    );
    let tooltip: string;
    let modifier: string;
    let disabled = false;
    switch (state.kind) {
      case 'idle':
        tooltip = 'Connect MIDI device';
        modifier = 'mixer-panel-midi-button--idle';
        break;
      case 'connecting':
        tooltip = 'Requesting MIDI access…';
        modifier = 'mixer-panel-midi-button--connecting';
        disabled = true;
        break;
      case 'enabled':
        tooltip = state.inputs.length > 0
          ? `MIDI: ${state.inputs.join(', ')}`
          : 'MIDI ready — plug in a device';
        modifier = 'mixer-panel-midi-button--enabled';
        break;
      case 'denied':
        tooltip = 'MIDI access blocked. Allow it from the site settings to retry.';
        modifier = 'mixer-panel-midi-button--error';
        break;
      case 'unsupported':
        tooltip = 'Web MIDI not supported in this browser';
        modifier = 'mixer-panel-midi-button--disabled';
        disabled = true;
        break;
      case 'error':
        tooltip = `MIDI error: ${state.message}`;
        modifier = 'mixer-panel-midi-button--error';
        break;
    }
    this.midiButton.classList.add(modifier);
    this.midiButton.disabled = disabled;
    this.midiButton.setAttribute('aria-label', tooltip);
    this.midiTooltip.textContent = tooltip;
  }

  private buildRow(opts: { label: string; ariaLabel?: string; icon: string; value: number }): {
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
    slider.setAttribute('aria-label', opts.ariaLabel ?? `${opts.label} volume`);
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
