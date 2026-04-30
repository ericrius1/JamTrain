// Shared LFO read by both the orb voice (handSynth) and the orb particle
// streams (Orb.ts). Single source-of-truth so the audible filter movement and
// the visible wave packets stay phase-locked. Tick from the main loop once per
// frame; both audio and visual sides poll `value`/`unipolar` afterwards.

export type OrbLfoTarget = 'cutoff' | 'resonance';

class OrbLfo {
  rate = 1.5; // Hz
  depth = 0.55; // 0..1
  target: OrbLfoTarget = 'cutoff';
  streamWaveAmount = 0.7; // 0..1 — how strongly the LFO sculpts the particle stream

  private phase = 0; // radians
  value = 0; // sin(phase), -1..1
  unipolar = 0.5; // (value + 1) / 2

  tick(delta: number): void {
    if (delta <= 0) return;
    const TWO_PI = Math.PI * 2;
    this.phase = (this.phase + TWO_PI * this.rate * delta) % TWO_PI;
    this.value = Math.sin(this.phase);
    this.unipolar = (this.value + 1) * 0.5;
  }
}

export const orbLfo = new OrbLfo();
