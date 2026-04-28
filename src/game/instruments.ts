import type * as THREE from 'three/webgpu';
import type { FingerJointName, FingerName, Handedness } from './types';

export type InstrumentId = 'loom' | 'chime' | 'orbs' | 'starlace';

export const INSTRUMENT_IDS: readonly InstrumentId[] = ['loom', 'chime', 'orbs', 'starlace'];

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

export type OrbGestureState = {
  active: boolean;
  /** Local orb coordinates normalized by radius, roughly -1..1. */
  x: number;
  y: number;
  z: number;
  /** 0 at the outer shell, 1 near the orb core. */
  depth: number;
  /** 0 near the core, 1 near the outer shell. */
  radius: number;
  /** 0..1 normalized pointer/contact speed. */
  speed: number;
  /** Azimuth around the orb in radians. */
  angle: number;
  /** 0..1 visual/audio energy for the current gesture sample. */
  intensity: number;
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
    label: 'Ripple Orb',
    subtitle: 'move · dive · resonate',
    color: '#9be7ff',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.2"/><circle cx="12" cy="12" r="3.2" opacity="0.7"/><path d="M4.8 12c3.4-2.3 10.1-2.3 14.4 0"/><path d="M4.8 12c3.4 2.3 10.1 2.3 14.4 0"/><circle cx="14.2" cy="9.2" r="1.1" fill="currentColor" stroke="none"/></svg>`,
  },
  starlace: {
    id: 'starlace',
    label: 'Starlace Harp',
    subtitle: 'swipe · stars · glissando',
    color: '#ff8cf0',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7.5 10 4l5.6 2.7 3.9 4.8-2.2 5.6-6 2.9-5.8-2.4-2-5.4 1-4.7Z"/><path d="M4.5 7.5 11.3 20M10 4l1.3 16M15.6 6.7l-10.1 10.9M19.5 11.5 5.5 17.6M4.5 7.5l15 4M10 4l7.3 13.1"/><circle cx="4.5" cy="7.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.6" cy="6.7" r="1.15" fill="currentColor" stroke="none"/><circle cx="19.5" cy="11.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="17.3" cy="17.1" r="1.15" fill="currentColor" stroke="none"/><circle cx="11.3" cy="20" r="1.15" fill="currentColor" stroke="none"/><circle cx="5.5" cy="17.6" r="1.15" fill="currentColor" stroke="none"/></svg>`,
  },
};

export function isInstrumentId(value: string): value is InstrumentId {
  return value === 'loom' || value === 'chime' || value === 'orbs' || value === 'starlace';
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
