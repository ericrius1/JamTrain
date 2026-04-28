import type * as THREE from 'three/webgpu';
import type { FingerJointName, FingerName, Handedness } from './types';

export type InstrumentId = 'drum' | 'starlace';

export const INSTRUMENT_IDS: readonly InstrumentId[] = ['drum', 'starlace'];

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
  drum: {
    id: 'drum',
    label: 'Drum',
    subtitle: 'rhythm · pulse · spark',
    color: '#ff9a3c',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="9" rx="8" ry="2.4"/><path d="M4 9v6c0 1.32 3.6 2.4 8 2.4s8-1.08 8-2.4V9"/><path d="M8.5 11.4l1.4 2.6M15.5 11.4l-1.4 2.6"/></svg>`,
  },
  starlace: {
    id: 'starlace',
    label: 'Starlace',
    subtitle: 'melody · constellation · glissando',
    color: '#ff8cf0',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7.5 10 4l5.6 2.7 3.9 4.8-2.2 5.6-6 2.9-5.8-2.4-2-5.4 1-4.7Z"/><path d="M4.5 7.5 11.3 20M10 4l1.3 16M15.6 6.7l-10.1 10.9M19.5 11.5 5.5 17.6M4.5 7.5l15 4M10 4l7.3 13.1"/><circle cx="4.5" cy="7.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.6" cy="6.7" r="1.15" fill="currentColor" stroke="none"/><circle cx="19.5" cy="11.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="17.3" cy="17.1" r="1.15" fill="currentColor" stroke="none"/><circle cx="11.3" cy="20" r="1.15" fill="currentColor" stroke="none"/><circle cx="5.5" cy="17.6" r="1.15" fill="currentColor" stroke="none"/></svg>`,
  },
};

export function isInstrumentId(value: string): value is InstrumentId {
  return value === 'drum' || value === 'starlace';
}

/**
 * Map any string (including legacy 'loom'/'chime'/'orbs') to a valid
 * InstrumentId. Used at every read boundary that might receive stale data
 * (e.g. SpacetimeDB partner instrument from an older client).
 */
export function normalizeInstrumentId(value: string | undefined | null): InstrumentId {
  if (value === 'starlace') return 'starlace';
  return 'drum';
}

/**
 * Per-player visual contract. Positions are world-space THREE.Vector3.
 */
export interface PlayerVisual {
  readonly mesh: THREE.Object3D;
  update(
    leftPalm: THREE.Vector3,
    rightPalm: THREE.Vector3,
    voice: VoiceState,
    delta: number,
    contacts?: readonly HandContactPoint[],
  ): void;
  setAnchor(anchor: THREE.Vector3): void;
  setVisible(visible: boolean): void;
  /** Hide the visual without an animation — used at construction time before
   *  the intro animation kicks in. */
  startHidden(): void;
  /** Animate the instrument into existence. Safe to call multiple times. */
  playIntroAnimation(): void;
  /** Animate the instrument out. Promise resolves when the visual is fully
   *  hidden so the caller can dispose / swap. */
  playOutroAnimation(): Promise<void>;
  dispose(): void;
}
