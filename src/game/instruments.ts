import type * as THREE from 'three/webgpu';

export type InstrumentId = 'flute' | 'bell' | 'sparks';

export const INSTRUMENT_IDS: readonly InstrumentId[] = ['flute', 'bell', 'sparks'];

export type VoiceState = {
  /** True between attack and release for at least one held note. */
  active: boolean;
  /** 0..1 — sustained energy. Smoothed over time. */
  energy: number;
  /** 0..1 — short-decay spike on note attacks. */
  pulse: number;
};

export const voiceStateZero = (): VoiceState => ({ active: false, energy: 0, pulse: 0 });

export type InstrumentMeta = {
  id: InstrumentId;
  /** Human-friendly name for plaques and tooltips. */
  label: string;
  /** Single-line subtitle / personality blurb. */
  subtitle: string;
  /** Inline SVG markup for the picker icon. Sized 24×24. */
  iconSvg: string;
  /** Primary color for the picker chip ring + glow. CSS color string. */
  color: string;
};

export const INSTRUMENTS: Record<InstrumentId, InstrumentMeta> = {
  flute: {
    id: 'flute',
    label: 'Cedar Flute',
    subtitle: 'ribbon · airy',
    color: '#52e2ff',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 12 Q 8 6 12 12 T 21 12"/></svg>`,
  },
  bell: {
    id: 'bell',
    label: 'Velvet Bell',
    subtitle: 'bloom · warm',
    color: '#ff7ad6',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="9" opacity="0.4"/></svg>`,
  },
  sparks: {
    id: 'sparks',
    label: 'Golden Sigil',
    subtitle: 'filigree · radiant',
    color: '#f6bd4b',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><ellipse cx="12" cy="12" rx="8" ry="3.4"/><ellipse cx="12" cy="12" rx="8" ry="3.4" transform="rotate(58 12 12)"/><ellipse cx="12" cy="12" rx="8" ry="3.4" transform="rotate(-58 12 12)"/></svg>`,
  },
};

export function isInstrumentId(value: string): value is InstrumentId {
  return value === 'flute' || value === 'bell' || value === 'sparks';
}

/**
 * Per-player visual contract: each instrument's between-hands renderer
 * implements this. Positions are world-space THREE.Vector3.
 */
export interface PlayerVisual {
  update(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3, voice: VoiceState, delta: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Center-stage contribution contract: each instrument's center renderer
 * implements this. CenterStage drives them with the smoothed voice state of
 * the player who selected this instrument.
 */
export interface CenterContribution {
  update(voice: VoiceState, delta: number, elapsed: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
