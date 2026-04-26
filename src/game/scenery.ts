import * as THREE from 'three/webgpu';
import { Fn, color, float, floor, fract, mix, smoothstep, time, uniform, uv } from 'three/tsl';
import { makeParams, registerTweaks } from '../hud/tweakDefs';
import { clamp } from './math';
import {
  BiomeScheduler,
  silhouetteParams,
  type SilhouetteParams,
} from './biomes';
import { BiomeLayers } from './biomeLayers';
import { FOREGROUND_BIOMES, BACKGROUND_BIOMES, type ForegroundBiomeId, type BackgroundBiomeId, type MagicEvent } from './biomes';
import { SpriteAtlas } from './spriteAtlas';
import { WaterStrip } from './waterStrip';
import { SkyLife } from './skyLife';
import { timeOfDayPhase } from './biomes';
import { Weather } from './weather';

const FG_OPTIONS: Record<string, string> = (() => {
  const o: Record<string, string> = { auto: 'auto' };
  for (const id of Object.keys(FOREGROUND_BIOMES)) o[id] = id;
  return o;
})();
const BG_OPTIONS: Record<string, string> = (() => {
  const o: Record<string, string> = { auto: 'auto' };
  for (const id of Object.keys(BACKGROUND_BIOMES)) o[id] = id;
  return o;
})();

export const SCENERY_DEFS = {
  cycleLengthSeconds: { default: 180,  min: 30,  max: 600,  step: 1,     label: 'day/night sec' },
  cycleOffset:        { default: 0.08, min: 0,   max: 1,    step: 0.001, label: 'cycle offset' },
  trainSpeed:         { default: 1.1,  min: 0,   max: 3,    step: 0.01,  label: 'train speed' },
  hillAmplitude:      { default: 1.0,  min: 0.1, max: 2.0,  step: 0.01,  label: 'hill shape' },
  auroraIntensity:    { default: 0.76, min: 0,   max: 1.8,  step: 0.01,  label: 'aurora' },
  starIntensity:      { default: 0.78, min: 0,   max: 1,    step: 0.01,  label: 'stars' },
  moonSize:           { default: 0.34, min: 0.12, max: 0.58, step: 0.01, label: 'moon size' },
  moonPhase:          { type: 'string', default: '', readonly: true, label: 'moon phase' },

  foreground:      { type: 'select', default: 'auto', options: FG_OPTIONS, folder: 'Biomes' },
  background:      { type: 'select', default: 'auto', options: BG_OPTIONS, folder: 'Biomes' },
  transitionSpeed: { default: 1, min: 0.1, max: 10, step: 0.1,  folder: 'Biomes' },
  recencyPenalty:  { default: 1, min: 0,   max: 2,  step: 0.05, folder: 'Biomes' },
} as const;

type Atmosphere = {
  background: THREE.Color;
  daylight: number;
  night: number;
};

export type SceneryOptions = {
  roomSeed: number;
};

interface BackgroundPanel {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  side: number;
  scrollOffset: number;
  segments: number;
  width: number;
  panelHeight: number;
}

const fullTurn = Math.PI * 2;
const BG_WIDTH = 12.4;
const BG_SEGMENTS = 312;
const BG_PANEL_HEIGHT = 1.6;
const BG_BASE_Y = 0.12;

export class ScenerySystem {
  readonly params = makeParams(SCENERY_DEFS);
  private registered?: ReturnType<typeof registerTweaks<typeof SCENERY_DEFS>>;
  private root = new THREE.Group();
  private skyNight = uniform(0);
  private skySunset = uniform(0);
  private auroraStrength = uniform(0);
  private starStrength = uniform(0);
  private moonCos = uniform(0);
  private moonSign = uniform(1);
  private moonVisibility = uniform(0);
  private sunVisibility = uniform(1);
  private sunPosX = uniform(0.82);
  private sunPosY = uniform(0.62);
  private moonPosX = uniform(0.42);
  private moonPosY = uniform(0.68);
  private moonRadius = uniform(0.085);
  private moonRadiusInv = uniform(11.76);
  private skyTravel = uniform(0);

  // Biome background uniforms
  private bgFromColor = uniform(new THREE.Color(0x3d654a));
  private bgToColor = uniform(new THREE.Color(0x3d654a));
  private bgMixT = uniform(0);
  private bgSnowThreshold = uniform(2);
  private bgSnowTint = uniform(new THREE.Color(0xf2f5f8));
  private bgSnowMix = uniform(0);
  private bgFog = uniform(0.4);
  private bgShimmer = uniform(0);

  private bgPanels: BackgroundPanel[] = [];
  private scheduler!: BiomeScheduler;
  private atlas!: SpriteAtlas;
  private layers!: BiomeLayers;
  private water!: WaterStrip;
  private skyLife!: SkyLife;
  private weather!: Weather;
  private onThunder?: (delay: number) => void;
  private lastCycle = 0;
  private atmosphere = {
    background: new THREE.Color(0x10202d),
    daylight: 1,
    night: 0,
  };
  private roomSeed: number;

  constructor(
    private scene: THREE.Scene,
    paneContainer: HTMLElement | undefined,
    options: SceneryOptions
  ) {
    this.roomSeed = options.roomSeed;
    const moonPhase = getMoonPhase(new Date());
    this.moonCos.value = Math.cos(moonPhase.phase * fullTurn);
    this.moonSign.value = moonPhase.phase < 0.5 ? 1 : -1;

    this.scheduler = new BiomeScheduler(
      this.roomSeed,
      () => Date.now() / 1000,
      () => this.lastCycle,
    );

    this.registered = registerTweaks(paneContainer, 'scenery', SCENERY_DEFS, {
      title: 'Scenery',
      params: this.params,
      onChange: {
        foreground:      v => { this.scheduler.overrides.forceForeground = v === 'auto' ? undefined : v as ForegroundBiomeId; },
        background:      v => { this.scheduler.overrides.forceBackground = v === 'auto' ? undefined : v as BackgroundBiomeId; },
        transitionSpeed: v => { this.scheduler.overrides.transitionSpeedMul = v; },
        recencyPenalty:  v => { this.scheduler.overrides.recencyPenaltyStrength = v; },
      },
      buttons: [
        { folder: 'Weather',  title: 'trigger lightning', onClick: () => this.scheduler.triggerLightningNow(Date.now() / 1000) },
        ...(['shootingStar', 'balloon', 'whale', 'plane'] as const).map(kind => ({
          folder: 'Sky life',
          title: ({ shootingStar: 'shooting star', balloon: 'hot air balloon', whale: 'whale spout', plane: 'distant plane' } as Record<string, string>)[kind],
          onClick: () => this.scheduler.triggerMagic(kind as MagicEvent['kind'], Date.now() / 1000),
        })),
      ],
    });

    // moonPhase is computed at construction (current real-world moon) and never
    // edited by the user — overwrite anything localStorage tried to restore.
    this.params.moonPhase = moonPhase.name;
    this.registered?.pane?.refresh();
  }

  build(): void {
    this.root.name = 'procedural-scenery';
    this.createSky();
    this.createBackground();
    this.atlas = new SpriteAtlas();
    this.layers = new BiomeLayers(this.scene, this.atlas, this.scheduler, this.roomSeed);
    this.layers.build();
    this.water = new WaterStrip(this.scene);
    this.water.build();
    this.skyLife = new SkyLife(
      this.scene,
      this.atlas,
      this.scheduler,
      this.roomSeed,
      () => Date.now() / 1000,
    );
    this.skyLife.build();
    this.weather = new Weather(
      this.scene,
      this.scheduler,
      () => Date.now() / 1000,
      delay => this.onThunder?.(delay),
    );
    this.weather.build();
    this.scene.add(this.root);
  }

  setThunderHandler(handler: (delaySeconds: number) => void): void {
    this.onThunder = handler;
  }

  setRoomSeed(seed: number): void {
    this.roomSeed = seed;
    this.scheduler.setSeed(seed);
    this.layers?.setSeed(seed);
    this.skyLife?.setSeed(seed);
  }

  getRoomSeed(): number {
    return this.roomSeed;
  }

  getScheduler(): BiomeScheduler {
    return this.scheduler;
  }

  update(delta: number, _elapsed: number): Atmosphere {
    const wallElapsed = Date.now() / 1000;
    const cycle = ((wallElapsed / Math.max(this.params.cycleLengthSeconds, 1) + this.params.cycleOffset) % 1 + 1) % 1;
    this.lastCycle = cycle;
    const sunWave = Math.sin(cycle * fullTurn);
    const daylight = clamp(sunWave * 0.58 + 0.48, 0, 1);
    const night = 1 - daylight;
    const moonNight = smoothstepScalar(0.12, 0.34, -sunWave);
    const sunArc = Math.sin(cycle * fullTurn);
    const moonCycle = (cycle + 0.5) % 1;
    const moonArc = Math.sin(moonCycle * fullTurn);
    const sunrise = Math.exp(-Math.pow(cycle / 0.095, 2));
    const sunset = Math.exp(-Math.pow((cycle - 0.5) / 0.105, 2));
    const goldenHour = clamp(Math.max(sunrise, sunset), 0, 1);
    const speed = this.params.trainSpeed;

    this.skyNight.value = night;
    this.skySunset.value = goldenHour;
    const auroraVisibility = clamp(night + goldenHour * 0.55, 0, 1);
    this.auroraStrength.value = auroraVisibility * this.params.auroraIntensity;
    this.starStrength.value = clamp(night + goldenHour * 0.25, 0, 1) * this.params.starIntensity;
    this.moonVisibility.value = moonNight * clamp(0.35 + this.params.starIntensity * 0.65, 0, 1);
    this.sunVisibility.value = daylight;
    this.sunPosX.value = 0.88 - cycle * 0.76;
    this.sunPosY.value = 0.46 + clamp(sunArc, 0, 1) * 0.34;
    this.moonPosX.value = 0.88 - moonCycle * 0.76;
    this.moonPosY.value = 0.50 + clamp(moonArc, 0, 1) * 0.34;
    this.moonRadius.value = clamp(this.params.moonSize * 0.24, 0.035, 0.14);
    this.moonRadiusInv.value = 1 / this.moonRadius.value;
    this.skyTravel.value += delta * speed;

    this.updateBackground(delta, speed, daylight);
    this.layers?.update(delta, speed, { daylight, nightAmount: night });
    if (this.water) {
      const fg = this.scheduler.foreground();
      this.water.update(fg.t < 0.5 ? fg.from : fg.to, delta);
    }
    if (this.skyLife) {
      const fg = this.scheduler.foreground();
      const bg = this.scheduler.background();
      const currentFg = fg.t < 0.5 ? fg.from : fg.to;
      const currentBg = bg.t < 0.5 ? bg.from : bg.to;
      const weatherNow = this.scheduler.weatherAt((Date.now() - this.epochMs) / 1000);
      this.skyLife.update(delta, {
        daylight,
        goldenHour,
        cloudCover: weatherNow.cloudCover,
        rainAmount: weatherNow.rain,
        phase: timeOfDayPhase(cycle),
        currentForegroundId: currentFg.id,
      });
      this.weather?.update(delta, { fgBiome: currentFg, bgBiome: currentBg });
    }

    const dayColor = new THREE.Color(0x2f6172);
    const duskColor = new THREE.Color(0x4d3158);
    const nightColor = new THREE.Color(0x071013);
    this.atmosphere.background.copy(nightColor).lerp(dayColor, daylight).lerp(duskColor, goldenHour * 0.35);
    this.atmosphere.daylight = daylight;
    this.atmosphere.night = night;
    return this.atmosphere;
  }

  dispose(): void {
    this.registered?.dispose();
  }

  private createSky(): void {
    const material = this.createWindowSkyMaterial();
    for (const side of [-1]) {
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(11.6, 2.6), material);
      sky.rotation.y = Math.PI / 2;
      sky.position.set(side * 2.56, 1.6, 0);
      sky.renderOrder = -30;
      this.root.add(sky);
    }
  }

  private createBackground(): void {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = Fn(() => {
      const u = uv();
      const baseColor = mix(this.bgFromColor, this.bgToColor, this.bgMixT).toVar('bgBase');
      // Snow cap blend: vertices above snow threshold get tinted.
      const snow = smoothstep(this.bgSnowThreshold.sub(0.04), this.bgSnowThreshold.add(0.02), u.y).mul(this.bgSnowMix);
      baseColor.assign(mix(baseColor, this.bgSnowTint, snow));
      // Soft fog into the sky horizon at the top of the strip.
      const fogTint = mix(color(0xa9c4dc), color(0x0a1218), this.skyNight);
      baseColor.assign(mix(baseColor, fogTint, u.y.mul(this.bgFog).clamp(0, 1)));
      // Ocean shimmer band (applies at low u.y, dims into nothing higher up).
      const shimmerBand = float(1).sub(smoothstep(0.0, 0.18, u.y)).mul(this.bgShimmer).mul(0.45);
      baseColor.addAssign(color(0xb0d8e8).mul(shimmerBand));
      return baseColor;
    })();
    material.depthWrite = true;
    material.fog = false;

    for (const side of [-1]) {
      const panel = this.createBackgroundPanel(side, material);
      this.bgPanels.push(panel);
      this.root.add(panel.mesh);
    }
  }

  private createBackgroundPanel(side: number, material: THREE.Material): BackgroundPanel {
    const segments = BG_SEGMENTS;
    const width = BG_WIDTH;
    const panelHeight = BG_PANEL_HEIGHT;
    const positions = new Float32Array((segments + 1) * 2 * 3);
    const uvs = new Float32Array((segments + 1) * 2 * 2);
    const indices: number[] = [];

    for (let i = 0; i <= segments; i += 1) {
      const x = -width / 2 + (i / segments) * width;
      const bottomIndex = i * 2;
      const topIndex = bottomIndex + 1;
      positions[bottomIndex * 3] = x;
      positions[bottomIndex * 3 + 1] = BG_BASE_Y;
      positions[bottomIndex * 3 + 2] = 0;
      positions[topIndex * 3] = x;
      positions[topIndex * 3 + 1] = BG_BASE_Y + panelHeight;
      positions[topIndex * 3 + 2] = 0;
      uvs[bottomIndex * 2] = i / segments;
      uvs[bottomIndex * 2 + 1] = 0;
      uvs[topIndex * 2] = i / segments;
      uvs[topIndex * 2 + 1] = 1;

      if (i < segments) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, c, b, c, d, b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(side * 2.30, 0, 0);
    mesh.renderOrder = -20;

    return { mesh, geometry, side, scrollOffset: 0, segments, width, panelHeight };
  }

  private updateBackground(delta: number, speed: number, daylight: number): void {
    const { from, to, t } = this.scheduler.background();
    const fromParams = silhouetteParams(from);
    const toParams = silhouetteParams(to);

    // Lerp colors (respecting day/night within each biome).
    lerpHexInto(this.bgFromColor.value, from.color.night, from.color.day, daylight);
    lerpHexInto(this.bgToColor.value, to.color.night, to.color.day, daylight);
    this.bgMixT.value = t;

    // Snow cap: pick the larger snow contribution between from/to so transitions are smooth.
    const snowFrom = from.snowCap ? 1 - t : 0;
    const snowTo = to.snowCap ? t : 0;
    const snowMix = Math.max(snowFrom, snowTo);
    this.bgSnowMix.value = snowMix;
    if (snowMix > 0) {
      const cap = (to.snowCap ?? from.snowCap)!;
      this.bgSnowThreshold.value = cap.threshold;
      this.bgSnowTint.value.setHex(cap.tint);
    } else {
      this.bgSnowThreshold.value = 2;
    }

    // Shimmer & fog crossfade between from/to for visual continuity.
    const shimmerFrom = from.shimmer?.amount ?? 0;
    const shimmerTo = to.shimmer?.amount ?? 0;
    this.bgShimmer.value = shimmerFrom * (1 - t) + shimmerTo * t;
    this.bgFog.value = from.fogStrength * (1 - t) + to.fogStrength * t;

    for (const panel of this.bgPanels) {
      panel.scrollOffset += delta * speed * 0.42;
      this.updatePanelShape(panel, fromParams, toParams, t);
    }
  }

  private updatePanelShape(
    panel: BackgroundPanel,
    fromParams: SilhouetteParams,
    toParams: SilhouetteParams,
    t: number,
  ): void {
    const positions = panel.geometry.getAttribute('position') as THREE.BufferAttribute;
    const ampScale = this.params.hillAmplitude;
    for (let i = 0; i <= panel.segments; i += 1) {
      const localX = -panel.width / 2 + (i / panel.segments) * panel.width;
      const sampledX = localX - panel.scrollOffset;
      const fromH = silhouetteHeight(sampledX, fromParams) * ampScale;
      const toH = silhouetteHeight(sampledX, toParams) * ampScale;
      const h = fromH + (toH - fromH) * t;
      positions.setY(i * 2 + 1, BG_BASE_Y + Math.max(0.04, h));
    }
    positions.needsUpdate = true;
  }

  private createWindowSkyMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = Fn(() => {
      const u = uv();
      const y = u.y.mul(1.08).sub(0.18);
      const horizon = smoothstep(0.0, 0.72, y);

      const daySky = mix(color(0xf2a268), color(0x74c7ff), horizon);
      const duskSky = mix(color(0xff8d64), color(0x241b56), smoothstep(0.02, 0.82, y));
      const nightSky = mix(color(0x071018), color(0x173c61), horizon);
      const sky = mix(mix(daySky, duskSky, this.skySunset), nightSky, this.skyNight).toVar('windowSky');

      const belowMask = float(1).sub(smoothstep(0.19, 0.31, u.y));
      const ground = mix(color(0x57321f), color(0x050706), this.skyNight);
      sky.assign(mix(sky, ground, belowMask.mul(0.5)));

      const aspect = float(3.12);
      const sunDx = u.x.sub(this.sunPosX).mul(aspect);
      const sunDy = u.y.sub(this.sunPosY);
      const sunDist = sunDx.mul(sunDx).add(sunDy.mul(sunDy)).sqrt();
      const sunDisc = float(1).sub(smoothstep(0.034, 0.052, sunDist)).mul(this.sunVisibility);
      const sunHalo = float(1).sub(sunDist.mul(2.0)).max(0).pow(3.0).mul(this.sunVisibility);
      sky.addAssign(color(0xfff2bc).mul(sunDisc.mul(1.85)));
      sky.addAssign(color(0xff8d4f).mul(sunHalo.mul(0.72)));

      const moonDx = u.x.sub(this.moonPosX).mul(aspect);
      const moonDy = u.y.sub(this.moonPosY);
      const moonDist = moonDx.mul(moonDx).add(moonDy.mul(moonDy)).sqrt();
      const moonHalo = float(1).sub(moonDist.mul(3.6)).max(0).pow(2.4).mul(this.moonVisibility);
      sky.addAssign(color(0xbfd8ff).mul(moonHalo.mul(0.18)));

      const moonDisc = float(1).sub(smoothstep(this.moonRadius.mul(0.92), this.moonRadius, moonDist));
      const moonPx = moonDx.mul(this.moonRadiusInv);
      const moonPy = moonDy.mul(this.moonRadiusInv);
      const terminator = this.moonCos.mul(float(1).sub(moonPy.mul(moonPy)).max(0).sqrt());
      const lit = smoothstep(terminator.sub(0.035), terminator.add(0.035), moonPx.mul(this.moonSign));
      sky.assign(mix(sky, color(0xfff4cf), moonDisc.mul(lit).mul(this.moonVisibility)));

      const starMask = smoothstep(0.30, 0.50, u.y);

      const starX = u.x.add(this.skyTravel.mul(0.004)).mul(140.0);
      const starY = u.y.mul(58.0);
      const cellX = floor(starX);
      const cellY = floor(starY);
      const fracX = fract(starX);
      const fracY = fract(starY);
      const starHashBase = cellX.mul(12.9898).add(cellY.mul(78.233));
      const starHash = fract(starHashBase.sin().mul(43758.5453));
      const starBright = fract(starHashBase.mul(1.91).sin().mul(23421.631));
      const starDistX = fracX.sub(0.5);
      const starDistY = fracY.sub(0.5);
      const starDist = starDistX.mul(starDistX).add(starDistY.mul(starDistY)).sqrt();
      const starThreshold = float(1.004).sub(this.starStrength.mul(0.18));
      const starOn = smoothstep(starThreshold, starThreshold.add(0.004), starHash);
      const starCircle = float(1).sub(smoothstep(0.045, 0.16, starDist));
      const twinkle = starHash.mul(160.0).add(time.mul(0.65)).sin().mul(0.22).add(0.78);
      sky.addAssign(
        mix(color(0xe8efff), color(0xffdfa4), starBright.mul(0.45))
          .mul(starOn)
          .mul(starCircle)
          .mul(twinkle)
          .mul(starMask)
          .mul(this.starStrength)
          .mul(1.15)
      );

      const starX2 = u.x.add(this.skyTravel.mul(0.006)).mul(280.0);
      const starY2 = u.y.mul(112.0);
      const cellX2 = floor(starX2);
      const cellY2 = floor(starY2);
      const fracX2 = fract(starX2);
      const fracY2 = fract(starY2);
      const starHashBase2 = cellX2.mul(45.678).add(cellY2.mul(98.765));
      const starHash2 = fract(starHashBase2.sin().mul(17853.321));
      const starBright2 = fract(starHashBase2.mul(2.71).sin().mul(31247.159));
      const starDistX2 = fracX2.sub(0.5);
      const starDistY2 = fracY2.sub(0.5);
      const starDist2 = starDistX2.mul(starDistX2).add(starDistY2.mul(starDistY2)).sqrt();
      const starThreshold2 = float(1.005).sub(this.starStrength.mul(0.14));
      const starOn2 = smoothstep(starThreshold2, starThreshold2.add(0.005), starHash2);
      const starCircle2 = float(1).sub(smoothstep(0.07, 0.18, starDist2));
      const twinkle2 = starHash2.mul(120.0).add(time.mul(0.42)).sin().mul(0.18).add(0.82);
      sky.addAssign(
        mix(color(0xb8c8ff), color(0xffe2b0), starBright2.mul(0.4))
          .mul(starOn2)
          .mul(starCircle2)
          .mul(twinkle2)
          .mul(starMask)
          .mul(this.starStrength)
          .mul(0.55)
      );

      // Aurora curtains (unchanged from prior implementation).
      const aT = time.mul(0.42);
      const apx = u.x.mul(5.2).add(this.skyTravel.mul(0.032));
      const apy = u.y.mul(2.8);

      const warpA = apx.mul(0.7).add(apy.mul(0.5)).add(aT.mul(0.13)).sin().mul(1.4);
      const warpB = apy.mul(0.8).sub(apx.mul(0.6)).sub(aT.mul(0.11)).sin().mul(1.1);
      const awx = apx.add(warpA);
      const awy = apy.add(warpB);

      const c1 = awx.mul(1.0).add(awy.mul(0.7)).add(aT.mul(0.19)).sin();
      const c2 = awx.mul(2.3).sub(awy.mul(1.5)).sub(aT.mul(0.15)).sin();
      const c3 = awx.mul(4.7).add(awy.mul(3.1)).add(aT.mul(0.23)).sin();
      const curtain = c1.mul(0.45).add(c2.mul(0.30)).add(c3.mul(0.18));

      const auroraBright = curtain.mul(0.5).add(0.55).max(0).pow(2.0);

      const auroraRise = smoothstep(0.30, 0.46, u.y);
      const auroraFall = float(1).sub(smoothstep(0.86, 1.0, u.y));
      const auroraVert = auroraRise.mul(auroraFall);

      const auroraRays = awx.mul(11.0).add(awy.mul(7.5)).add(aT.mul(1.4)).sin().mul(0.10).add(0.90);
      const auroraPulse = aT.mul(0.5).add(apx.mul(0.3)).sin().mul(0.08).add(0.92);

      const auroraHFrac = smoothstep(0.30, 0.92, u.y);
      const auroraLow = mix(color(0x14ff5c), color(0x18c4c0), smoothstep(0.0, 0.4, auroraHFrac));
      const auroraColor = mix(auroraLow, color(0x9a32e0), smoothstep(0.4, 1.0, auroraHFrac));

      sky.addAssign(
        auroraColor
          .mul(auroraBright)
          .mul(auroraVert)
          .mul(auroraRays)
          .mul(auroraPulse)
          .mul(this.auroraStrength)
          .mul(0.7)
      );

      return sky;
    })();
    material.depthWrite = false;
    material.fog = false;

    return material;
  }
}

function silhouetteHeight(x: number, p: SilhouetteParams): number {
  const xs = p.mesa > 0.5 ? Math.floor(x * 0.8 + 0.5) / 0.8 : x;
  const primary = Math.sin(xs * p.freq) * p.amp;
  const secondary = Math.sin(xs * p.freq2 + 1.2) * p.amp2;
  // For mountain-style biomes, fold to give peakier ridges.
  const folded = p.amp > 0.2 ? Math.abs(primary) : primary;
  return p.base + folded + secondary;
}

function lerpHexInto(out: THREE.Color, fromHex: number, toHex: number, t: number): void {
  const fr = ((fromHex >> 16) & 0xff) / 255;
  const fg = ((fromHex >> 8) & 0xff) / 255;
  const fb = (fromHex & 0xff) / 255;
  const tr = ((toHex >> 16) & 0xff) / 255;
  const tg = ((toHex >> 8) & 0xff) / 255;
  const tb = (toHex & 0xff) / 255;
  out.setRGB(fr + (tr - fr) * t, fg + (tg - fg) * t, fb + (tb - fb) * t);
}

function getMoonPhase(date: Date): { phase: number; name: string } {
  const synodicMonth = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - knownNewMoon) / 86_400_000;
  const age = ((days % synodicMonth) + synodicMonth) % synodicMonth;
  const phase = age / synodicMonth;
  const names = [
    'new moon',
    'waxing crescent',
    'first quarter',
    'waxing gibbous',
    'full moon',
    'waning gibbous',
    'last quarter',
    'waning crescent',
  ];
  const index = Math.round(phase * 8) % 8;
  return { phase, name: names[index] };
}

function smoothstepScalar(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
