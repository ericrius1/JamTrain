import type * as THREE from 'three/webgpu';
import type { FingerJointName, FingerName, Handedness } from './types';

export type InstrumentId = 'loom' | 'chime' | 'orbs';

export const INSTRUMENT_IDS: readonly InstrumentId[] = ['loom', 'chime', 'orbs'];

export type VoiceState = {
  /** True between attack and release for at least one held note. */
  active: boolean;
  /** 0..1 — sustained energy. Smoothed over time. */
  energy: number;
  /** 0..1 — short-decay spike on note attacks. */
  pulse: number;
  /** 0..1 — vertical playing-hand position mapped to pitch. */
  pitch: number;
  /** 0..1 — expression-hand position mapped to color/filter/resonance. */
  expression: number;
  /** 0..1 — distance between hands, mapped to string tension. */
  tension: number;
  /** Current scale index, or -1 when silent. */
  noteIndex: number;
  /** Number of notes available in the current scale. */
  noteCount: number;
};

export const voiceStateZero = (): VoiceState => ({
  active: false,
  energy: 0,
  pulse: 0,
  pitch: 0.5,
  expression: 0.5,
  tension: 0.35,
  noteIndex: -1,
  noteCount: 1,
});

export type HandContactPoint = {
  /** Stable within one player visual so velocity can be derived frame-to-frame. */
  id: string;
  hand: Handedness;
  kind: 'palm' | 'finger';
  finger?: FingerName;
  joint?: FingerJointName;
  /** World-space contact point. */
  position: THREE.Vector3;
};

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
  loom: {
    id: 'loom',
    label: 'Aurora Loom',
    subtitle: 'strings · waves · resonance',
    color: '#68f4ff',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7c4.4 3.8 11.6 3.8 16 0"/><path d="M4 12c4.4-3.8 11.6-3.8 16 0"/><path d="M4 17c4.4 3.8 11.6 3.8 16 0"/><path d="M7 4v16M17 4v16"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>`,
  },
  chime: {
    id: 'chime',
    label: 'Wind Chime',
    subtitle: 'ring · gems · wind',
    color: '#ffd166',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="1.8"/><path d="M6.4 6.6v6.5M9.4 6.9v9.2M12 7v11M14.6 6.9v9.2M17.6 6.6v6.5"/><circle cx="6.4" cy="13.6" r="1.05" fill="currentColor" stroke="none"/><circle cx="9.4" cy="16.6" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="18.4" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.6" cy="16.6" r="1.05" fill="currentColor" stroke="none"/><circle cx="17.6" cy="13.6" r="1.05" fill="currentColor" stroke="none"/></svg>`,
  },
  orbs: {
    id: 'orbs',
    label: 'Hang Orbs',
    subtitle: 'tap · steel · ripples',
    color: '#9be7ff',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.4" cy="9.4" r="2.6"/><circle cx="12" cy="6" r="2.6"/><circle cx="17.6" cy="9.4" r="2.6"/><circle cx="8.6" cy="16.6" r="2.6"/><circle cx="15.4" cy="16.6" r="2.6"/><circle cx="12" cy="6" r="0.9" fill="currentColor" stroke="none" opacity="0.7"/><circle cx="8.6" cy="16.6" r="0.9" fill="currentColor" stroke="none" opacity="0.7"/></svg>`,
  },
};

export function isInstrumentId(value: string): value is InstrumentId {
  return value === 'loom' || value === 'chime' || value === 'orbs';
}

/**
 * Per-player visual contract. Positions are world-space THREE.Vector3.
 */
export interface PlayerVisual {
  update(
    leftPalm: THREE.Vector3,
    rightPalm: THREE.Vector3,
    voice: VoiceState,
    delta: number,
    contacts?: readonly HandContactPoint[],
  ): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
