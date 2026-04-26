import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { Handedness } from './types';

export const HAND_FILTER_DEFS = {
  enabled:          { type: 'boolean', default: true,   label: 'kalman on' },
  processNoise:     { default: 0.005,  min: 0.0001, max: 0.1, step: 0.0001, label: 'process Q' },
  measurementNoise: { default: 0.06,   min: 0.001,  max: 0.5, step: 0.001,  label: 'measure R' },
} as const;

const LANDMARK_COUNT = 21;

class Kalman1D {
  private x = 0;
  private p = 1;
  private initialized = false;

  reset(): void {
    this.initialized = false;
    this.p = 1;
  }

  step(measurement: number, q: number, r: number): number {
    if (!this.initialized) {
      this.x = measurement;
      this.p = 1;
      this.initialized = true;
      return measurement;
    }
    // Predict (constant-position model).
    this.p = this.p + q;
    // Update.
    const k = this.p / (this.p + r);
    this.x = this.x + k * (measurement - this.x);
    this.p = (1 - k) * this.p;
    return this.x;
  }
}

type LandmarkFilters = {
  x: Kalman1D[];
  y: Kalman1D[];
  z: Kalman1D[];
};

function makeLandmarkFilters(): LandmarkFilters {
  return {
    x: Array.from({ length: LANDMARK_COUNT }, () => new Kalman1D()),
    y: Array.from({ length: LANDMARK_COUNT }, () => new Kalman1D()),
    z: Array.from({ length: LANDMARK_COUNT }, () => new Kalman1D()),
  };
}

export type HandFilterParams = ParamsOf<typeof HAND_FILTER_DEFS>;

export type FilterableLandmark = { x: number; y: number; z?: number };

export class HandFilter {
  private filters: Record<Handedness, LandmarkFilters> = {
    left: makeLandmarkFilters(),
    right: makeLandmarkFilters(),
  };
  private params: HandFilterParams = {
    enabled: HAND_FILTER_DEFS.enabled.default,
    processNoise: HAND_FILTER_DEFS.processNoise.default,
    measurementNoise: HAND_FILTER_DEFS.measurementNoise.default,
  };
  private registered?: ReturnType<typeof registerTweaks<typeof HAND_FILTER_DEFS>>;

  applyToLandmarks(handedness: Handedness, landmarks: FilterableLandmark[]): FilterableLandmark[] {
    if (!this.params.enabled) return landmarks;
    const f = this.filters[handedness];
    const q = this.params.processNoise;
    const r = this.params.measurementNoise;
    const out: FilterableLandmark[] = [];
    for (let i = 0; i < landmarks.length; i += 1) {
      const lm = landmarks[i];
      const idx = i < LANDMARK_COUNT ? i : i % LANDMARK_COUNT;
      out.push({
        x: f.x[idx].step(lm.x, q, r),
        y: f.y[idx].step(lm.y, q, r),
        z: lm.z !== undefined ? f.z[idx].step(lm.z, q, r) : undefined,
      });
    }
    return out;
  }

  applyToKeypoints(
    handedness: Handedness,
    keypoints: Record<string, FilterableLandmark>
  ): Record<string, FilterableLandmark> {
    if (!this.params.enabled) return keypoints;
    const out: Record<string, FilterableLandmark> = {};
    const f = this.filters[handedness];
    const q = this.params.processNoise;
    const r = this.params.measurementNoise;
    let idx = 0;
    for (const key of Object.keys(keypoints)) {
      const lm = keypoints[key];
      const slot = idx % LANDMARK_COUNT;
      out[key] = {
        x: f.x[slot].step(lm.x, q, r),
        y: f.y[slot].step(lm.y, q, r),
        z: lm.z !== undefined ? f.z[slot].step(lm.z, q, r) : undefined,
      };
      idx += 1;
    }
    return out;
  }

  resetHand(handedness: Handedness): void {
    const f = this.filters[handedness];
    for (const arr of [f.x, f.y, f.z]) {
      for (const k of arr) k.reset();
    }
  }

  attachPane(paneDock: HTMLElement): void {
    if (this.registered) return;
    this.registered = registerTweaks(paneDock, 'handFilter', HAND_FILTER_DEFS, {
      title: 'Hand Smoothing',
      params: this.params,
      buttons: [
        { title: 'reset filters', onClick: () => { this.resetHand('left'); this.resetHand('right'); } },
      ],
    });
  }

  dispose(): void {
    this.registered?.dispose();
    this.registered = undefined;
  }
}
