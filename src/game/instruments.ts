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
    label: 'Glass Sparks',
    subtitle: 'particles · crystalline',
    color: '#f7cf72',
    iconSvg: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.4"/><circle cx="10" cy="9" r="1"/><circle cx="13" cy="14" r="1.2"/><circle cx="16" cy="10" r="1"/><circle cx="19" cy="13" r="1.4"/></svg>`,
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
