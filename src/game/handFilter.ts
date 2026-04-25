import { Pane } from 'tweakpane';
import type { Handedness } from './types';

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

export type HandFilterParams = {
  enabled: boolean;
  processNoise: number;
  measurementNoise: number;
};

export type FilterableLandmark = { x: number; y: number; z?: number };

export class HandFilter {
  private filters: Record<Handedness, LandmarkFilters> = {
    left: makeLandmarkFilters(),
    right: makeLandmarkFilters(),
  };
  private params: HandFilterParams = {
    enabled: true,
    processNoise: 0.005,
    measurementNoise: 0.06,
  };
  private pane?: Pane;

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
    if (this.pane) return;
    const container = document.createElement('div');
    paneDock.appendChild(container);
    this.pane = new Pane({ title: 'Hand Smoothing', container });
    this.pane.expanded = false;
    this.pane.addBinding(this.params, 'enabled', { label: 'kalman on' });
    this.pane.addBinding(this.params, 'processNoise', {
      label: 'process Q',
      min: 0.0001,
      max: 0.1,
      step: 0.0001,
    });
    this.pane.addBinding(this.params, 'measurementNoise', {
      label: 'measure R',
      min: 0.001,
      max: 0.5,
      step: 0.001,
    });
    this.pane
      .addButton({ title: 'reset filters' })
      .on('click', () => {
        this.resetHand('left');
        this.resetHand('right');
      });
  }

  dispose(): void {
    this.pane?.dispose();
    this.pane = undefined;
  }
}
