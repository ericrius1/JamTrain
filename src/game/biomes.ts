import { streamFor } from './seedRandom';
import type { AtlasId } from './spriteAtlas';

export type ForegroundBiomeId =
  | 'hills' | 'forest' | 'meadow' | 'lake' | 'coast' | 'snowfield' | 'farmland';

export type BackgroundBiomeId =
  | 'distantHills' | 'snowMountains' | 'oceanHorizon' | 'mesa' | 'fogForest';

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';

export interface SpriteBand {
  atlas: AtlasId;
  density: number;            // sprites per unit width
  yJitter: number;
  sizeRange: [number, number];
  layer: 'foreground' | 'midground';
}

export interface ForegroundBiome {
  id: ForegroundBiomeId;
  groundColor: { day: number; night: number };
  ridge: { amplitude: number; frequency: number; baseY: number };
  sprites: SpriteBand[];
  water?: { coverage: number; reflectionTint: number };
  villageLights?: { density: number; clusterTightness: number };
  weatherBias: { rain: number; snow: number };
  birdBias: number;
  birdPalette: 'default' | 'seabird';
  timeOfDayBias: Record<TimeOfDay, number>;
}

export interface BackgroundBiome {
  id: BackgroundBiomeId;
  color: { day: number; night: number };
  fogStrength: number;
  snowCap?: { threshold: number; tint: number };
  shimmer?: { amount: number };
  timeOfDayBias: Record<TimeOfDay, number>;
}

export interface BiomeWindow<T> {
  from: T;
  to: T;
  startedAt: number;       // shared seconds since epoch
  duration: number;        // total window incl. crossfade tail
  crossfade: number;       // seconds of tail used to lerp into `to`
}

export interface WeatherWindow {
  startTime: number;
  rampIn: number;
  hold: number;
  rampOut: number;
  rainPeak: number;
  snowPeak: number;
  cloudCoverPeak: number;
  lightningEvents: LightningEvent[];
}

export interface LightningEvent {
  time: number;
  seed: number;
}

export interface MagicEvent {
  kind: 'shootingStar' | 'balloon' | 'whale' | 'plane';
  startTime: number;
  duration: number;
  sideHint: -1 | 1;
  seed: number;
}

export const FOREGROUND_BIOMES: Record<ForegroundBiomeId, ForegroundBiome> = {
  hills: {
    id: 'hills',
    groundColor: { day: 0x4a7d4d, night: 0x132018 },
    ridge: { amplitude: 0.18, frequency: 1.3, baseY: 0.42 },
    sprites: [
      { atlas: 'deciduousRound', density: 0.5, yJitter: 0.02, sizeRange: [0.18, 0.30], layer: 'midground' },
    ],
    weatherBias: { rain: 0.4, snow: 0.05 },
    birdBias: 1.0,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.0, night: 1.0 },
  },
  forest: {
    id: 'forest',
    groundColor: { day: 0x1f3a26, night: 0x0a1410 },
    ridge: { amplitude: 0.12, frequency: 1.6, baseY: 0.40 },
    sprites: [
      { atlas: 'pineTall',  density: 1.6, yJitter: 0.03, sizeRange: [0.30, 0.55], layer: 'foreground' },
      { atlas: 'pineShort', density: 1.1, yJitter: 0.02, sizeRange: [0.22, 0.36], layer: 'midground' },
    ],
    weatherBias: { rain: 0.7, snow: 0.10 },
    birdBias: 1.4,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.2, day: 1.0, dusk: 1.2, night: 0.9 },
  },
  meadow: {
    id: 'meadow',
    groundColor: { day: 0x6da55a, night: 0x16241a },
    ridge: { amplitude: 0.10, frequency: 1.0, baseY: 0.38 },
    sprites: [
      { atlas: 'deciduousRound', density: 0.3,  yJitter: 0.02, sizeRange: [0.20, 0.34], layer: 'midground' },
      { atlas: 'cottage',        density: 0.18, yJitter: 0.0,  sizeRange: [0.16, 0.22], layer: 'foreground' },
    ],
    villageLights: { density: 0.55, clusterTightness: 0.18 },
    weatherBias: { rain: 0.45, snow: 0.05 },
    birdBias: 0.8,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 0.9, day: 1.0, dusk: 1.4, night: 1.4 },
  },
  lake: {
    id: 'lake',
    groundColor: { day: 0x315a4a, night: 0x0d1a18 },
    ridge: { amplitude: 0.06, frequency: 0.8, baseY: 0.34 },
    sprites: [
      { atlas: 'reeds',     density: 0.9, yJitter: 0.01, sizeRange: [0.10, 0.18], layer: 'foreground' },
      { atlas: 'cattail',   density: 0.4, yJitter: 0.01, sizeRange: [0.10, 0.16], layer: 'foreground' },
      { atlas: 'pineShort', density: 0.4, yJitter: 0.02, sizeRange: [0.20, 0.32], layer: 'midground' },
    ],
    water: { coverage: 0.7, reflectionTint: 0xb6d6e6 },
    weatherBias: { rain: 0.55, snow: 0.05 },
    birdBias: 1.1,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.3, day: 1.0, dusk: 1.4, night: 0.9 },
  },
  coast: {
    id: 'coast',
    groundColor: { day: 0xc8b88a, night: 0x1f1c14 },
    ridge: { amplitude: 0.05, frequency: 0.6, baseY: 0.32 },
    sprites: [
      { atlas: 'lighthouse', density: 0.06, yJitter: 0.0,  sizeRange: [0.30, 0.42], layer: 'midground' },
      { atlas: 'sailboat',   density: 0.10, yJitter: 0.04, sizeRange: [0.10, 0.16], layer: 'midground' },
    ],
    water: { coverage: 1.0, reflectionTint: 0xc8d8e8 },
    weatherBias: { rain: 0.5, snow: 0.0 },
    birdBias: 1.3,
    birdPalette: 'seabird',
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.6, night: 0.9 },
  },
  snowfield: {
    id: 'snowfield',
    groundColor: { day: 0xe5edf0, night: 0x182028 },
    ridge: { amplitude: 0.14, frequency: 1.2, baseY: 0.40 },
    sprites: [
      { atlas: 'pineTall',  density: 0.7, yJitter: 0.02, sizeRange: [0.28, 0.48], layer: 'foreground' },
      { atlas: 'pineShort', density: 0.5, yJitter: 0.02, sizeRange: [0.20, 0.32], layer: 'midground' },
    ],
    weatherBias: { rain: 0.05, snow: 0.95 },
    birdBias: 0.4,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.2, day: 1.0, dusk: 1.0, night: 0.9 },
  },
  farmland: {
    id: 'farmland',
    groundColor: { day: 0x8a7a3a, night: 0x1f1c12 },
    ridge: { amplitude: 0.08, frequency: 0.9, baseY: 0.36 },
    sprites: [
      { atlas: 'fencePost', density: 1.4,  yJitter: 0.01, sizeRange: [0.10, 0.16], layer: 'foreground' },
      { atlas: 'haystack',  density: 0.4,  yJitter: 0.01, sizeRange: [0.12, 0.20], layer: 'midground' },
      { atlas: 'barn',      density: 0.10, yJitter: 0.0,  sizeRange: [0.20, 0.30], layer: 'midground' },
      { atlas: 'silo',      density: 0.06, yJitter: 0.0,  sizeRange: [0.18, 0.26], layer: 'midground' },
    ],
    weatherBias: { rain: 0.5, snow: 0.05 },
    birdBias: 1.0,
    birdPalette: 'default',
    timeOfDayBias: { dawn: 1.0, day: 1.2, dusk: 1.1, night: 0.8 },
  },
};

export const BACKGROUND_BIOMES: Record<BackgroundBiomeId, BackgroundBiome> = {
  distantHills: {
    id: 'distantHills',
    color: { day: 0x3d654a, night: 0x101920 },
    fogStrength: 0.35,
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.0, night: 1.0 },
  },
  snowMountains: {
    id: 'snowMountains',
    color: { day: 0x4d5a6a, night: 0x10171f },
    fogStrength: 0.45,
    snowCap: { threshold: 0.55, tint: 0xf2f5f8 },
    timeOfDayBias: { dawn: 1.6, day: 1.0, dusk: 1.0, night: 1.0 },
  },
  oceanHorizon: {
    id: 'oceanHorizon',
    color: { day: 0x2a4f6a, night: 0x081016 },
    fogStrength: 0.55,
    shimmer: { amount: 0.6 },
    timeOfDayBias: { dawn: 1.0, day: 1.0, dusk: 1.7, night: 0.9 },
  },
  mesa: {
    id: 'mesa',
    color: { day: 0x8a4a2c, night: 0x1a1008 },
    fogStrength: 0.40,
    timeOfDayBias: { dawn: 1.0, day: 1.2, dusk: 1.4, night: 0.9 },
  },
  fogForest: {
    id: 'fogForest',
    color: { day: 0x2a3a30, night: 0x0c130f },
    fogStrength: 0.75,
    timeOfDayBias: { dawn: 1.4, day: 1.0, dusk: 1.0, night: 1.0 },
  },
};

export interface SilhouetteParams {
  amp: number;
  freq: number;
  base: number;
  amp2: number;
  freq2: number;
  mesa: number;     // 0/1 flag — quantize x to step buckets
}

export function silhouetteParams(b: BackgroundBiome): SilhouetteParams {
  switch (b.id) {
    case 'distantHills':  return { amp: 0.08, freq: 1.2, base: 0.42, amp2: 0.04, freq2: 2.7, mesa: 0 };
    case 'snowMountains': return { amp: 0.30, freq: 0.8, base: 0.55, amp2: 0.10, freq2: 1.9, mesa: 0 };
    case 'oceanHorizon':  return { amp: 0.0,  freq: 1.0, base: 0.30, amp2: 0.0,  freq2: 1.0, mesa: 0 };
    case 'mesa':          return { amp: 0.20, freq: 0.8, base: 0.40, amp2: 0.0,  freq2: 1.0, mesa: 1 };
    case 'fogForest':     return { amp: 0.06, freq: 2.4, base: 0.48, amp2: 0.03, freq2: 5.1, mesa: 0 };
  }
}

export function timeOfDayPhase(cycle: number): TimeOfDay {
  if (cycle < 0.10 || cycle > 0.90) return 'dawn';
  if (cycle < 0.45) return 'day';
  if (cycle < 0.55) return 'dusk';
  return 'night';
}

export interface SchedulerOverrides {
  forceForeground?: ForegroundBiomeId;
  forceBackground?: BackgroundBiomeId;
  transitionSpeedMul: number;
  recencyPenaltyStrength: number;
}

export class BiomeScheduler {
  overrides: SchedulerOverrides = { transitionSpeedMul: 1, recencyPenaltyStrength: 1 };

  private fgWindow!: BiomeWindow<ForegroundBiome>;
  private bgWindow!: BiomeWindow<BackgroundBiome>;
  private weather: WeatherWindow[] = [];
  private magic: MagicEvent[] = [];
  private fgRecency = new Map<ForegroundBiomeId, number>();
  private bgRecency = new Map<BackgroundBiomeId, number>();
  private fgEventIndex = 0;
  private bgEventIndex = 0;
  private weatherEventIndex = 0;
  private magicEventIndex = 0;

  constructor(
    private seed: number,
    private getEpochSeconds: () => number,
    private getCycle: () => number,
  ) {
    const t = this.getEpochSeconds();
    this.fgWindow = this.makeFgWindow(t, this.pickFg(), this.pickFg());
    this.bgWindow = this.makeBgWindow(t, this.pickBg(), this.pickBg());
    this.scheduleNextWeather(t);
    this.scheduleNextMagic(t);
  }

  setSeed(seed: number): void {
    this.seed = seed;
  }

  foreground(): { from: ForegroundBiome; to: ForegroundBiome; t: number } {
    if (this.overrides.forceForeground) {
      const b = FOREGROUND_BIOMES[this.overrides.forceForeground];
      return { from: b, to: b, t: 0 };
    }
    const now = this.getEpochSeconds();
    if (now > this.fgWindow.startedAt + this.fgWindow.duration) {
      const next = this.pickFg();
      this.fgWindow = this.makeFgWindow(now, this.fgWindow.to, next);
    }
    const elapsed = now - this.fgWindow.startedAt;
    const fadeStart = this.fgWindow.duration - this.fgWindow.crossfade;
    const t = elapsed < fadeStart ? 0 : Math.min(1, (elapsed - fadeStart) / this.fgWindow.crossfade);
    return { from: this.fgWindow.from, to: this.fgWindow.to, t };
  }

  background(): { from: BackgroundBiome; to: BackgroundBiome; t: number } {
    if (this.overrides.forceBackground) {
      const b = BACKGROUND_BIOMES[this.overrides.forceBackground];
      return { from: b, to: b, t: 0 };
    }
    const now = this.getEpochSeconds();
    if (now > this.bgWindow.startedAt + this.bgWindow.duration) {
      const next = this.pickBg();
      this.bgWindow = this.makeBgWindow(now, this.bgWindow.to, next);
    }
    const elapsed = now - this.bgWindow.startedAt;
    const fadeStart = this.bgWindow.duration - this.bgWindow.crossfade;
    const t = elapsed < fadeStart ? 0 : Math.min(1, (elapsed - fadeStart) / this.bgWindow.crossfade);
    return { from: this.bgWindow.from, to: this.bgWindow.to, t };
  }

  weatherAt(now: number): {
    rain: number;
    snow: number;
    cloudCover: number;
    lightning: LightningEvent[];
  } {
    while (this.weather.length > 0) {
      const w = this.weather[0];
      if (w.startTime + w.rampIn + w.hold + w.rampOut < now - 5) {
        this.weather.shift();
      } else {
        break;
      }
    }
    if (this.weather.length < 2) this.scheduleNextWeather(now);

    let rain = 0, snow = 0, cloudCover = 0;
    const lightning: LightningEvent[] = [];
    for (const w of this.weather) {
      const local = now - w.startTime;
      if (local < 0) continue;
      let envelope = 0;
      if (local < w.rampIn) envelope = local / w.rampIn;
      else if (local < w.rampIn + w.hold) envelope = 1;
      else if (local < w.rampIn + w.hold + w.rampOut) envelope = 1 - (local - w.rampIn - w.hold) / w.rampOut;
      else continue;
      rain = Math.max(rain, envelope * w.rainPeak);
      snow = Math.max(snow, envelope * w.snowPeak);
      cloudCover = Math.max(cloudCover, envelope * w.cloudCoverPeak);
      for (const ev of w.lightningEvents) {
        if (ev.time >= now - 1.5 && ev.time < now + 4) lightning.push(ev);
      }
    }
    return { rain, snow, cloudCover, lightning };
  }

  magicAt(now: number): MagicEvent[] {
    while (this.magic.length > 0 && this.magic[0].startTime + this.magic[0].duration < now - 5) {
      this.magic.shift();
    }
    if (this.magic.length < 3) this.scheduleNextMagic(now);
    return this.magic.filter(m => m.startTime <= now && m.startTime + m.duration > now);
  }

  triggerLightningNow(now: number): void {
    const seed = Math.floor(Math.random() * 0xffffff);
    if (this.weather.length === 0) {
      this.weather.push({
        startTime: now - 0.01,
        rampIn: 0.2,
        hold: 1.5,
        rampOut: 1.0,
        rainPeak: 0.4,
        snowPeak: 0,
        cloudCoverPeak: 0.4,
        lightningEvents: [{ time: now + 0.1, seed }],
      });
    } else {
      this.weather[0].lightningEvents.push({ time: now + 0.1, seed });
    }
  }

  triggerMagic(kind: MagicEvent['kind'], now: number): void {
    const duration =
      kind === 'shootingStar' ? 1.4 :
      kind === 'balloon' ? 60 :
      kind === 'whale' ? 4.0 :
      30;
    this.magic.push({
      kind, startTime: now + 0.1, duration,
      sideHint: Math.random() < 0.5 ? -1 : 1,
      seed: Math.floor(Math.random() * 0xffffff),
    });
  }

  // ---- internals ----

  private pickFg(): ForegroundBiome {
    const rand = streamFor(this.seed, this.fgEventIndex);
    this.fgEventIndex += 1;
    const phase = timeOfDayPhase(this.getCycle());
    const ids = Object.keys(FOREGROUND_BIOMES) as ForegroundBiomeId[];
    const weights = ids.map(id => {
      const b = FOREGROUND_BIOMES[id];
      const recency = this.fgRecency.get(id) ?? 0;
      const recencyPenalty = Math.max(0, 1 - recency * 0.4 * this.overrides.recencyPenaltyStrength);
      return b.timeOfDayBias[phase] * recencyPenalty;
    });
    const id = weightedPick(ids, weights, rand());
    for (const k of this.fgRecency.keys()) {
      this.fgRecency.set(k, Math.max(0, (this.fgRecency.get(k)! - 0.5)));
    }
    this.fgRecency.set(id, 3);
    return FOREGROUND_BIOMES[id];
  }

  private pickBg(): BackgroundBiome {
    const rand = streamFor(this.seed ^ 0xb19e5, this.bgEventIndex);
    this.bgEventIndex += 1;
    const phase = timeOfDayPhase(this.getCycle());
    const ids = Object.keys(BACKGROUND_BIOMES) as BackgroundBiomeId[];
    const weights = ids.map(id => {
      const b = BACKGROUND_BIOMES[id];
      const recency = this.bgRecency.get(id) ?? 0;
      return b.timeOfDayBias[phase] * Math.max(0, 1 - recency * 0.5 * this.overrides.recencyPenaltyStrength);
    });
    const id = weightedPick(ids, weights, rand());
    for (const k of this.bgRecency.keys()) {
      this.bgRecency.set(k, Math.max(0, (this.bgRecency.get(k)! - 0.4)));
    }
    this.bgRecency.set(id, 3);
    return BACKGROUND_BIOMES[id];
  }

  private makeFgWindow(now: number, from: ForegroundBiome, to: ForegroundBiome): BiomeWindow<ForegroundBiome> {
    const rand = streamFor(this.seed ^ 0xfeeed, this.fgEventIndex);
    const duration = (90 + rand() * 90) / Math.max(0.05, this.overrides.transitionSpeedMul);
    return { from, to, startedAt: now, duration, crossfade: 12 };
  }

  private makeBgWindow(now: number, from: BackgroundBiome, to: BackgroundBiome): BiomeWindow<BackgroundBiome> {
    const rand = streamFor(this.seed ^ 0xbeed, this.bgEventIndex);
    const duration = (240 + rand() * 240) / Math.max(0.05, this.overrides.transitionSpeedMul);
    return { from, to, startedAt: now, duration, crossfade: 25 };
  }

  private scheduleNextWeather(now: number): void {
    const rand = streamFor(this.seed ^ 0xc100d, this.weatherEventIndex);
    this.weatherEventIndex += 1;
    const last = this.weather[this.weather.length - 1];
    const start = (last ? last.startTime + last.rampIn + last.hold + last.rampOut : now) + 60 + rand() * 180;
    const fg = this.fgWindow?.to ?? FOREGROUND_BIOMES.hills;
    const rainPeak = rand() < fg.weatherBias.rain ? 0.35 + rand() * 0.55 : 0;
    const snowPeak = rand() < fg.weatherBias.snow ? 0.4 + rand() * 0.5 : 0;
    const cloudCoverPeak = rainPeak > 0 || snowPeak > 0 ? 0.5 + rand() * 0.4 : rand() * 0.3;
    const hold = 60 + rand() * 60;
    const events: LightningEvent[] = [];
    if (rainPeak > 0.4) {
      let t = start + 12;
      while (t < start + 15 + hold) {
        events.push({ time: t, seed: Math.floor(rand() * 0xffffff) });
        t += 30 + rand() * 30;
      }
    }
    this.weather.push({
      startTime: start,
      rampIn: 15,
      hold,
      rampOut: 20,
      rainPeak,
      snowPeak,
      cloudCoverPeak,
      lightningEvents: events,
    });
  }

  private scheduleNextMagic(now: number): void {
    const rand = streamFor(this.seed ^ 0xa11a8, this.magicEventIndex);
    this.magicEventIndex += 1;
    const last = this.magic[this.magic.length - 1];
    const start = (last ? last.startTime + last.duration : now) + 60 + rand() * 240;
    const phase = timeOfDayPhase(this.getCycle());
    const fg = this.fgWindow?.to ?? FOREGROUND_BIOMES.hills;
    type Choice = { kind: MagicEvent['kind']; weight: number };
    const choices: Choice[] = [
      { kind: 'shootingStar', weight: phase === 'night' ? 1.5 : 0.0 },
      { kind: 'balloon',      weight: (phase === 'dawn' || phase === 'dusk') ? 0.6 : 0.05 },
      { kind: 'whale',        weight: fg.id === 'coast' ? 1.2 : 0.0 },
      { kind: 'plane',        weight: phase === 'night' ? 0.4 : 0.0 },
    ];
    const totalWeight = choices.reduce((s, c) => s + c.weight, 0);
    if (totalWeight <= 0) {
      // Defer — no magic appropriate right now; try again later
      this.magic.push({ kind: 'plane', startTime: start, duration: 0, sideHint: 1, seed: 0 });
      return;
    }
    const pick = weightedPick(choices, choices.map(c => c.weight), rand());
    const duration =
      pick.kind === 'shootingStar' ? 1.4 :
      pick.kind === 'balloon' ? 60 :
      pick.kind === 'whale' ? 4.0 :
      pick.kind === 'plane' ? 30 : 5;
    this.magic.push({
      kind: pick.kind,
      startTime: start,
      duration,
      sideHint: rand() < 0.5 ? -1 : 1,
      seed: Math.floor(rand() * 0xffffff),
    });
  }
}

function weightedPick<T>(items: T[], weights: number[], r: number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(r * items.length)];
  let cursor = r * total;
  for (let i = 0; i < items.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return items[i];
  }
  return items[items.length - 1];
}
