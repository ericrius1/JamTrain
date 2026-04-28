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
import { CloudCanopy } from './cloudCanopy';
import { UnderwaterRealm } from './underwaterRealm';

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

const TERRAIN_LAYER_MIN = 0;
const TERRAIN_LAYER_MAX = 9;
const TERRAIN_LAYER_DEFAULT = 0;
const PAINTED_TERRAIN_CHUNKS = [
  { id: 'alpine-lake', texture: '/scenery/far-terrain-chunk-01-alpine-lake.webp' },
  { id: 'fog-forest', texture: '/scenery/far-terrain-chunk-02-fog-forest.webp' },
  { id: 'snow-peaks', texture: '/scenery/far-terrain-chunk-03-snow-peaks.webp' },
  { id: 'red-mesa', texture: '/scenery/far-terrain-chunk-04-red-mesa.webp' },
  { id: 'coastal-lake', texture: '/scenery/far-terrain-chunk-05-coastal-lake.webp' },
  { id: 'meadow-fields', texture: '/scenery/far-terrain-chunk-06-meadow-fields.webp' },
  { id: 'cypress-wetland', texture: '/scenery/far-terrain-chunk-07-cypress-wetland.webp' },
  { id: 'autumn-moor', texture: '/scenery/far-terrain-chunk-08-autumn-moor.webp' },
  { id: 'basalt-coast', texture: '/scenery/far-terrain-chunk-09-basalt-coast.webp' },
  { id: 'lavender-steppe', texture: '/scenery/far-terrain-chunk-10-lavender-steppe.webp' },
  { id: 'crystal-ravine', texture: '/scenery/far-terrain-chunk-11-crystal-ravine.webp' },
] as const;
const PAINTED_TERRAIN_SEQUENCE = [
  0, 1, 6, 4, 8, 2, 10, 7, 5, 9, 3,
  1, 0, 4, 6, 5, 7, 10, 2, 8, 9, 3,
] as const;
const PAINTED_TERRAIN_CHUNK_WIDTH = 12.6;
const PAINTED_TERRAIN_BLEND_WIDTH = 2.4;
const PAINTED_TERRAIN_CHUNK_STRIDE = PAINTED_TERRAIN_CHUNK_WIDTH - PAINTED_TERRAIN_BLEND_WIDTH;
const PAINTED_TERRAIN_HEIGHT = 3.15;
const PAINTED_TERRAIN_X_DISTANCE = 4.86;
const PAINTED_TERRAIN_Y = 1.34;
const PAINTED_TERRAIN_LOOP_SECONDS_AT_MAX_SPEED = 360;
const PAINTED_TERRAIN_MAX_SPEED = 3;

export const SCENERY_DEFS = {
  cycleLengthSeconds: { default: 240,  min: 30,  max: 600,  step: 1,     label: 'day/night sec' },
  cycleOffset:        { default: 0.50, min: 0,   max: 1,    step: 0.001, label: 'cycle offset' },
  trainSpeed:         { default: 1.1,  min: 0,   max: 3,    step: 0.01,  label: 'train speed' },
  hillAmplitude:      { default: 1.18, min: 0.1, max: 2.0,  step: 0.01,  label: 'hill shape', folder: 'Terrain' },
  terrainLayers:      { default: TERRAIN_LAYER_DEFAULT, min: TERRAIN_LAYER_MIN, max: TERRAIN_LAYER_MAX, step: 1, label: 'proc layers', folder: 'Terrain' },
  paintedTerrainOpacity: { default: 0.92, min: 0, max: 1, step: 0.01, label: 'painted layer', folder: 'Terrain' },
  auroraIntensity:    { default: 0.42, min: 0,   max: 1.8,  step: 0.01,  label: 'aurora' },
  starIntensity:      { default: 0.9,  min: 0,   max: 1,    step: 0.01,  label: 'stars' },
  moonSize:           { default: 0.34, min: 0.12, max: 0.58, step: 0.01, label: 'moon size' },
  moonPhase:          { type: 'string', default: '', readonly: true, label: 'moon phase' },

  foreground:      { type: 'select', default: 'lake', options: FG_OPTIONS, folder: 'Biomes' },
  background:      { type: 'select', default: 'alpinePeaks', options: BG_OPTIONS, folder: 'Biomes' },
  transitionSpeed: { default: 1, min: 0.1, max: 10, step: 0.1,  folder: 'Biomes' },
  recencyPenalty:  { default: 1, min: 0,   max: 2,  step: 0.05, folder: 'Biomes' },
} as const;

type Atmosphere = {
  background: THREE.Color;
  daylight: number;
  night: number;
  underwater: number;
};

export type SceneryOptions = {
  roomSeed: number;
};

interface BackgroundPanel {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  layer: BackgroundDepthLayer;
  layerIndex: number;
  side: number;
  scrollOffset: number;
  segments: number;
  width: number;
  panelHeight: number;
}

interface BackgroundDepthLayer {
  id: string;
  xDistance: number;
  widthScale: number;
  heightScale: number;
  yOffset: number;
  frequencyScale: number;
  phaseOffset: number;
  scrollSpeed: number;
  mist: number;
  fogScale: number;
  brightness: number;
  alpha: number;
  snowBias: number;
  ridgeGlow: number;
  renderOrder: number;
}

interface BackgroundFogBand {
  y: number;
  height: number;
  intensity: number;
  drift: number;
  minLayers: number;
  renderOrder: number;
}

interface BackgroundFogPanel {
  mesh: THREE.Mesh;
  band: BackgroundFogBand;
  side: number;
}

interface PaintedTerrainPanel {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  sequenceIndex: number;
}

interface PaintedTerrainResource {
  material: THREE.MeshBasicMaterial;
  texture: THREE.Texture;
}

const fullTurn = Math.PI * 2;
const BG_WIDTH = 12.4;
const BG_SEGMENTS = 312;
const BG_PANEL_HEIGHT = 1.6;
const BG_BASE_Y = 0.12;
const BG_DEPTH_LAYERS: BackgroundDepthLayer[] = [
  {
    id: 'ghost-peaks',
    xDistance: 4.72,
    widthScale: 1.70,
    heightScale: 0.70,
    yOffset: 0.52,
    frequencyScale: 0.88,
    phaseOffset: 6.7,
    scrollSpeed: 0.045,
    mist: 0.84,
    fogScale: 1.92,
    brightness: 1.22,
    alpha: 0.40,
    snowBias: -0.12,
    ridgeGlow: 0.34,
    renderOrder: -28,
  },
  {
    id: 'distant-sawtooth',
    xDistance: 4.42,
    widthScale: 1.62,
    heightScale: 0.66,
    yOffset: 0.44,
    frequencyScale: 1.03,
    phaseOffset: 3.9,
    scrollSpeed: 0.065,
    mist: 0.76,
    fogScale: 1.68,
    brightness: 1.18,
    alpha: 0.46,
    snowBias: -0.08,
    ridgeGlow: 0.30,
    renderOrder: -27,
  },
  {
    id: 'far-peaks',
    xDistance: 4.12,
    widthScale: 1.54,
    heightScale: 0.60,
    yOffset: 0.34,
    frequencyScale: 1.18,
    phaseOffset: -1.5,
    scrollSpeed: 0.095,
    mist: 0.64,
    fogScale: 1.42,
    brightness: 1.10,
    alpha: 0.54,
    snowBias: -0.02,
    ridgeGlow: 0.24,
    renderOrder: -26,
  },
  {
    id: 'back-ridges',
    xDistance: 3.78,
    widthScale: 1.46,
    heightScale: 0.52,
    yOffset: 0.25,
    frequencyScale: 0.94,
    phaseOffset: 1.9,
    scrollSpeed: 0.135,
    mist: 0.50,
    fogScale: 1.18,
    brightness: 1.02,
    alpha: 0.64,
    snowBias: 0.04,
    ridgeGlow: 0.17,
    renderOrder: -25,
  },
  {
    id: 'middle-haze',
    xDistance: 3.45,
    widthScale: 1.38,
    heightScale: 0.46,
    yOffset: 0.16,
    frequencyScale: 1.08,
    phaseOffset: -3.7,
    scrollSpeed: 0.190,
    mist: 0.36,
    fogScale: 0.96,
    brightness: 0.94,
    alpha: 0.72,
    snowBias: 0.08,
    ridgeGlow: 0.10,
    renderOrder: -24,
  },
  {
    id: 'middle-hills',
    xDistance: 3.16,
    widthScale: 1.30,
    heightScale: 0.42,
    yOffset: 0.09,
    frequencyScale: 1.24,
    phaseOffset: 4.2,
    scrollSpeed: 0.255,
    mist: 0.24,
    fogScale: 0.78,
    brightness: 0.86,
    alpha: 0.80,
    snowBias: 0.18,
    ridgeGlow: 0.06,
    renderOrder: -23,
  },
  {
    id: 'near-folds',
    xDistance: 2.92,
    widthScale: 1.24,
    heightScale: 0.38,
    yOffset: 0.04,
    frequencyScale: 1.43,
    phaseOffset: -0.6,
    scrollSpeed: 0.320,
    mist: 0.13,
    fogScale: 0.62,
    brightness: 0.76,
    alpha: 0.88,
    snowBias: 0.30,
    ridgeGlow: 0.02,
    renderOrder: -22,
  },
  {
    id: 'front-valley',
    xDistance: 2.72,
    widthScale: 1.18,
    heightScale: 0.34,
    yOffset: -0.01,
    frequencyScale: 1.64,
    phaseOffset: -5.2,
    scrollSpeed: 0.390,
    mist: 0.06,
    fogScale: 0.48,
    brightness: 0.66,
    alpha: 0.94,
    snowBias: 0.42,
    ridgeGlow: 0.00,
    renderOrder: -21,
  },
  {
    id: 'window-edge',
    xDistance: 2.56,
    widthScale: 1.12,
    heightScale: 0.28,
    yOffset: -0.04,
    frequencyScale: 1.88,
    phaseOffset: 2.6,
    scrollSpeed: 0.455,
    mist: 0.02,
    fogScale: 0.34,
    brightness: 0.56,
    alpha: 0.96,
    snowBias: 0.54,
    ridgeGlow: 0.00,
    renderOrder: -20,
  },
];
const BG_FOG_BANDS: BackgroundFogBand[] = [
  { y: 1.22, height: 0.62, intensity: 0.22, drift: 0.014, minLayers: 7, renderOrder: -26.5 },
  { y: 0.94, height: 0.50, intensity: 0.30, drift: 0.020, minLayers: 5, renderOrder: -25.5 },
  { y: 0.68, height: 0.42, intensity: 0.32, drift: 0.028, minLayers: 4, renderOrder: -24.5 },
  { y: 0.48, height: 0.34, intensity: 0.24, drift: 0.038, minLayers: 3, renderOrder: -22.5 },
];

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
  private bgFogMeshes: BackgroundFogPanel[] = [];
  private scheduler!: BiomeScheduler;
  private atlas!: SpriteAtlas;
  private layers!: BiomeLayers;
  private water!: WaterStrip;
  private skyLife!: SkyLife;
  private weather!: Weather;
  private cloudCanopy!: CloudCanopy;
  private underwater!: UnderwaterRealm;
  private onThunder?: (delay: number) => void;
  private paintedTerrainGeometry?: THREE.PlaneGeometry;
  private paintedTerrainAlphaTexture?: THREE.CanvasTexture;
  private paintedTerrainResources: PaintedTerrainResource[] = [];
  private paintedTerrainPanels: PaintedTerrainPanel[] = [];
  private paintedTerrainDistance = 0;
  private readonly paintedTerrainTint = new THREE.Color(0xffffff);
  private readonly paintedTerrainNightTint = new THREE.Color(0x3a2a22);
  private readonly paintedTerrainDuskTint = new THREE.Color(0xffb261);
  private readonly cycleStartedAt = Date.now() / 1000;
  private lastCycle = 0;
  private atmosphere = {
    background: new THREE.Color(0x10202d),
    daylight: 1,
    night: 0,
    underwater: 0,
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

    this.registered = registerTweaks(paneContainer, 'scenery-v3', SCENERY_DEFS, {
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
    this.createPaintedTerrain();
    this.createBackground();
    this.atlas = new SpriteAtlas();
    this.layers = new BiomeLayers(this.scene, this.atlas, this.scheduler, this.roomSeed);
    this.layers.build();
    this.water = new WaterStrip(this.scene);
    this.water.build();
    this.underwater = new UnderwaterRealm(this.scene, this.roomSeed);
    this.underwater.build();
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
    this.cloudCanopy = new CloudCanopy(this.scene, {
      cloudCover: this.weather.cloudCover,
      rainAmount: this.weather.rainAmount,
      skyTravel: this.skyTravel,
      goldenHour: this.skySunset,
      skyNight: this.skyNight,
    });
    this.cloudCanopy.build();
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
    this.underwater?.setSeed(seed);
  }

  getRoomSeed(): number {
    return this.roomSeed;
  }

  getScheduler(): BiomeScheduler {
    return this.scheduler;
  }

  update(delta: number, _elapsed: number): Atmosphere {
    const wallElapsed = Date.now() / 1000;
    const cycleElapsed = wallElapsed - this.cycleStartedAt;
    const cycle = ((cycleElapsed / Math.max(this.params.cycleLengthSeconds, 1) + this.params.cycleOffset) % 1 + 1) % 1;
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

    const fg = this.scheduler.foreground();
    const underwater = biomeWindowWeight(fg, 'undersea');

    this.updateBackground(delta, speed, daylight);
    this.layers?.update(delta, speed, { daylight, nightAmount: night });
    if (this.water) {
      this.water.update(fg.t < 0.5 ? fg.from : fg.to, delta);
    }
    this.underwater?.update(delta, { presence: underwater, daylight, trainSpeed: speed });
    if (this.skyLife) {
      const bg = this.scheduler.background();
      const currentFg = fg.t < 0.5 ? fg.from : fg.to;
      const currentBg = bg.t < 0.5 ? bg.from : bg.to;
      const weatherNow = this.scheduler.weatherAt(Date.now() / 1000);
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

    const dayColor = new THREE.Color(0x6f4d2c);
    const duskColor = new THREE.Color(0x7a3f2e);
    const nightColor = new THREE.Color(0x070503);
    this.atmosphere.background.copy(nightColor).lerp(dayColor, daylight).lerp(duskColor, goldenHour * 0.35);
    this.atmosphere.background.lerp(new THREE.Color(0x031b2a), underwater * 0.82);
    this.atmosphere.daylight = daylight;
    this.atmosphere.night = night;
    this.atmosphere.underwater = underwater;
    return this.atmosphere;
  }

  dispose(): void {
    this.registered?.dispose();
    this.underwater?.dispose();
    this.disposePaintedTerrain();
  }

  private createSky(): void {
    const material = this.createWindowSkyMaterial();
    for (const side of [-1]) {
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(20.0, 4.4), material);
      sky.rotation.y = Math.PI / 2;
      sky.position.set(side * 4.95, 1.62, 0);
      sky.renderOrder = -32;
      this.root.add(sky);
    }
  }

  private createBackground(): void {
    for (const side of [-1]) {
      for (let layerIndex = 0; layerIndex < BG_DEPTH_LAYERS.length; layerIndex += 1) {
        const layer = BG_DEPTH_LAYERS[layerIndex];
        const material = this.createBackgroundLayerMaterial(layer);
        const panel = this.createBackgroundPanel(side, material, layer, layerIndex);
        this.bgPanels.push(panel);
        this.root.add(panel.mesh);
      }
      for (const band of BG_FOG_BANDS) {
        const mist = this.createBackgroundFogBand(side, band);
        this.bgFogMeshes.push({ mesh: mist, band, side });
        this.root.add(mist);
      }
    }
  }

  private createPaintedTerrain(): void {
    const loader = new THREE.TextureLoader();
    this.paintedTerrainGeometry = new THREE.PlaneGeometry(PAINTED_TERRAIN_CHUNK_WIDTH, PAINTED_TERRAIN_HEIGHT);
    this.paintedTerrainAlphaTexture = this.createPaintedTerrainAlphaTexture();

    this.paintedTerrainResources = PAINTED_TERRAIN_CHUNKS.map(chunk => {
      const texture = loader.load(chunk.texture, tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = true;

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        alphaMap: this.paintedTerrainAlphaTexture,
        color: 0xffffff,
        transparent: true,
        opacity: this.params.paintedTerrainOpacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      });

      return { material, texture };
    });

    for (const side of [-1]) {
      for (let sequenceIndex = 0; sequenceIndex < PAINTED_TERRAIN_SEQUENCE.length; sequenceIndex += 1) {
        const chunkIndex = PAINTED_TERRAIN_SEQUENCE[sequenceIndex];
        const chunk = PAINTED_TERRAIN_CHUNKS[chunkIndex];
        const resource = this.paintedTerrainResources[chunkIndex];
        const mesh = new THREE.Mesh(this.paintedTerrainGeometry, resource.material);
        mesh.name = `painted-far-terrain-${chunk.id}`;
        mesh.rotation.y = Math.PI / 2;
        mesh.position.set(side * PAINTED_TERRAIN_X_DISTANCE, PAINTED_TERRAIN_Y, 0);
        mesh.renderOrder = -31 + sequenceIndex * 0.001;
        mesh.frustumCulled = false;
        this.paintedTerrainPanels.push({ mesh, sequenceIndex });
        this.root.add(mesh);
      }
    }
    this.updatePaintedTerrainPanels();
  }

  private createPaintedTerrainAlphaTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for terrain alpha map');

    const fade = PAINTED_TERRAIN_BLEND_WIDTH / PAINTED_TERRAIN_CHUNK_WIDTH;
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, 'black');
    gradient.addColorStop(fade, 'white');
    gradient.addColorStop(1 - fade, 'white');
    gradient.addColorStop(1, 'black');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    return texture;
  }

  private createBackgroundLayerMaterial(layer: BackgroundDepthLayer): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = Fn(() => {
      const u = uv();
      const baseColor = mix(this.bgFromColor, this.bgToColor, this.bgMixT).toVar('bgBase');
      baseColor.assign(baseColor.mul(float(layer.brightness)));

      // Snow cap blend: vertices above snow threshold get tinted.
      const snowThreshold = this.bgSnowThreshold.add(float(layer.snowBias));
      const snow = smoothstep(snowThreshold.sub(0.04), snowThreshold.add(0.02), u.y).mul(this.bgSnowMix);
      baseColor.assign(mix(baseColor, this.bgSnowTint, snow));

      const coolMist = mix(color(0xa8b6b0), color(0x071014), this.skyNight);
      const fogTint = mix(coolMist, color(0xb46b36), this.skySunset.mul(0.36));
      const crestGlow = smoothstep(0.56, 0.96, u.y).mul(float(layer.ridgeGlow));
      const crestTint = mix(fogTint, this.bgSnowTint, this.bgSnowMix.mul(0.74).add(0.10).clamp(0, 1));
      baseColor.assign(mix(baseColor, fogTint, float(layer.mist * 0.74)));
      baseColor.assign(mix(baseColor, crestTint, crestGlow));
      baseColor.assign(mix(baseColor, fogTint, u.y.mul(this.bgFog).mul(float(layer.fogScale * 0.58)).clamp(0, 1)));

      // Ocean shimmer band (applies at low u.y, dims into nothing higher up).
      const shimmerBand = float(1).sub(smoothstep(0.0, 0.18, u.y)).mul(this.bgShimmer).mul(0.45);
      baseColor.addAssign(color(0xffcc74).mul(shimmerBand));
      return baseColor;
    })();
    material.opacityNode = Fn(() => float(layer.alpha))();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    return material;
  }

  private createBackgroundPanel(
    side: number,
    material: THREE.Material,
    layer: BackgroundDepthLayer,
    layerIndex: number,
  ): BackgroundPanel {
    const segments = BG_SEGMENTS;
    const width = BG_WIDTH * layer.widthScale;
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
    mesh.position.set(side * layer.xDistance, 0, 0);
    mesh.renderOrder = layer.renderOrder;
    mesh.frustumCulled = false;

    return { mesh, geometry, layer, layerIndex, side, scrollOffset: 0, segments, width, panelHeight };
  }

  private createBackgroundFogBand(side: number, band: BackgroundFogBand): THREE.Mesh {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;

    material.colorNode = Fn(() => {
      const coolMist = mix(color(0xa6b7af), color(0x071014), this.skyNight);
      return mix(coolMist, color(0xbf733c), this.skySunset.mul(0.36));
    })();

    material.opacityNode = Fn(() => {
      const u = uv();
      const verticalFade = smoothstep(0.00, 0.22, u.y)
        .mul(float(1).sub(smoothstep(0.78, 1.00, u.y)));
      const wispA = u.x.mul(13.0).add(time.mul(band.drift)).sin().mul(0.5).add(0.5);
      const wispB = u.x.mul(31.0).sub(time.mul(band.drift * 0.72)).sin().mul(0.5).add(0.5);
      const wisps = wispA.mul(0.45).add(wispB.mul(0.24)).add(0.34).clamp(0, 1);
      const weatherFog = this.bgFog.mul(0.54).add(0.16).clamp(0, 1);
      return verticalFade.mul(wisps).mul(weatherFog).mul(float(band.intensity * 0.72));
    })();

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BG_WIDTH, band.height), material);
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(side * 3.30, band.y, 0);
    mesh.renderOrder = band.renderOrder;
    mesh.frustumCulled = false;
    return mesh;
  }

  private updateBackground(delta: number, speed: number, daylight: number): void {
    const { from, to, t } = this.scheduler.background();
    const fromParams = silhouetteParams(from);
    const toParams = silhouetteParams(to);
    this.updatePaintedTerrain(delta, speed, daylight);

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

    const activeLayers = this.activeTerrainLayerCount();
    this.updateBackgroundVisibility(activeLayers);

    for (const panel of this.bgPanels) {
      if (!panel.mesh.visible) continue;
      panel.scrollOffset += delta * speed * panel.layer.scrollSpeed;
      this.updatePanelShape(panel, fromParams, toParams, t);
    }
  }

  private updatePaintedTerrain(delta: number, speed: number, daylight: number): void {
    const loopLength = this.paintedTerrainLoopLength();
    if (loopLength > 0) {
      const speedFactor = clamp(speed, 0, PAINTED_TERRAIN_MAX_SPEED) / PAINTED_TERRAIN_MAX_SPEED;
      const deltaDistance = delta * speedFactor * loopLength / PAINTED_TERRAIN_LOOP_SECONDS_AT_MAX_SPEED;
      this.paintedTerrainDistance = (this.paintedTerrainDistance + deltaDistance) % loopLength;
      this.updatePaintedTerrainPanels();
    }

    const night = this.skyNight.value;
    const goldenHour = this.skySunset.value;
    this.paintedTerrainTint
      .set(0xffffff)
      .lerp(this.paintedTerrainNightTint, night * 0.68)
      .lerp(this.paintedTerrainDuskTint, goldenHour * 0.16);

    const opacity = this.params.paintedTerrainOpacity * (0.78 + daylight * 0.22);
    for (const resource of this.paintedTerrainResources) {
      resource.material.color.copy(this.paintedTerrainTint);
      resource.material.opacity = opacity;
    }
  }

  private updatePaintedTerrainPanels(): void {
    const loopLength = this.paintedTerrainLoopLength();
    if (loopLength <= 0) return;

    for (const panel of this.paintedTerrainPanels) {
      const baseZ = panel.sequenceIndex * PAINTED_TERRAIN_CHUNK_STRIDE;
      const z = wrapCentered(baseZ - this.paintedTerrainDistance, loopLength);
      panel.mesh.position.z = z;
    }
  }

  private paintedTerrainLoopLength(): number {
    return PAINTED_TERRAIN_CHUNK_STRIDE * PAINTED_TERRAIN_SEQUENCE.length;
  }

  private disposePaintedTerrain(): void {
    for (const panel of this.paintedTerrainPanels) {
      this.root.remove(panel.mesh);
    }
    this.paintedTerrainPanels = [];
    for (const resource of this.paintedTerrainResources) {
      resource.material.dispose();
      resource.texture.dispose();
    }
    this.paintedTerrainResources = [];
    this.paintedTerrainGeometry?.dispose();
    this.paintedTerrainAlphaTexture?.dispose();
    this.paintedTerrainGeometry = undefined;
    this.paintedTerrainAlphaTexture = undefined;
  }

  private activeTerrainLayerCount(): number {
    return Math.round(clamp(this.params.terrainLayers, TERRAIN_LAYER_MIN, TERRAIN_LAYER_MAX));
  }

  private updateBackgroundVisibility(activeLayers: number): void {
    const firstActiveIndex = Math.max(0, BG_DEPTH_LAYERS.length - activeLayers);
    for (const panel of this.bgPanels) {
      panel.mesh.visible = panel.layerIndex >= firstActiveIndex;
    }
    for (const fog of this.bgFogMeshes) {
      fog.mesh.visible = activeLayers >= fog.band.minLayers;
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
      const sampledX = (localX - panel.scrollOffset) * panel.layer.frequencyScale + panel.layer.phaseOffset;
      const fromH = silhouetteHeight(sampledX, fromParams) * ampScale;
      const toH = silhouetteHeight(sampledX, toParams) * ampScale;
      const rawH = fromH + (toH - fromH) * t;
      const h = rawH * panel.layer.heightScale + panel.layer.yOffset;
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

      const daySky = mix(color(0xffb861), color(0xd89048), horizon);
      const duskSky = mix(color(0xff9b55), color(0x2b1817), smoothstep(0.02, 0.82, y));
      const nightSky = mix(color(0x060403), color(0x1d1713), horizon);
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

      const starX = u.x.add(this.skyTravel.mul(0.004)).mul(110.0);
      const starY = u.y.mul(46.0);
      const cellX = floor(starX);
      const cellY = floor(starY);
      const fracX = fract(starX);
      const fracY = fract(starY);
      const starHashBase = cellX.mul(12.9898).add(cellY.mul(78.233));
      const starHash = fract(starHashBase.sin().mul(43758.5453));
      const starBright = fract(starHashBase.mul(1.91).sin().mul(23421.631));
      const starJitterX = fract(starHashBase.mul(3.71).sin().mul(11971.123)).mul(0.7).add(0.15);
      const starJitterY = fract(starHashBase.mul(5.13).sin().mul(28371.221)).mul(0.7).add(0.15);
      const starSizeH = fract(starHashBase.mul(11.31).sin().mul(74121.871));
      const starHueH = fract(starHashBase.mul(7.13).sin().mul(91421.731));
      const starDistX = fracX.sub(starJitterX);
      const starDistY = fracY.sub(starJitterY);
      const starDist = starDistX.mul(starDistX).add(starDistY.mul(starDistY)).sqrt();
      const starThreshold = float(1.004).sub(this.starStrength.mul(0.20));
      const starOn = smoothstep(starThreshold, starThreshold.add(0.004), starHash);
      const innerR = float(0.02).add(starSizeH.mul(0.04));
      const outerR = innerR.add(float(0.07).add(starSizeH.mul(0.06)));
      const starCircle = float(1).sub(smoothstep(innerR, outerR, starDist));
      const twinkle = starHash.mul(160.0).add(time.mul(0.65)).sin().mul(0.22).add(0.78);
      const starColA = mix(color(0x8fb6ff), color(0xfff4e2), smoothstep(0.0, 0.55, starHueH));
      const starColor = mix(starColA, color(0xffb060), smoothstep(0.55, 1.0, starHueH));
      sky.addAssign(
        starColor
          .mul(float(0.85).add(starBright.mul(0.35)))
          .mul(starOn)
          .mul(starCircle)
          .mul(twinkle)
          .mul(starMask)
          .mul(this.starStrength)
          .mul(1.15)
      );

      const starX2 = u.x.add(this.skyTravel.mul(0.006)).mul(230.0);
      const starY2 = u.y.mul(95.0);
      const cellX2 = floor(starX2);
      const cellY2 = floor(starY2);
      const fracX2 = fract(starX2);
      const fracY2 = fract(starY2);
      const starHashBase2 = cellX2.mul(45.678).add(cellY2.mul(98.765));
      const starHash2 = fract(starHashBase2.sin().mul(17853.321));
      const starBright2 = fract(starHashBase2.mul(2.71).sin().mul(31247.159));
      const starJitterX2 = fract(starHashBase2.mul(4.27).sin().mul(13297.557)).mul(0.7).add(0.15);
      const starJitterY2 = fract(starHashBase2.mul(6.91).sin().mul(38713.117)).mul(0.7).add(0.15);
      const starHueH2 = fract(starHashBase2.mul(8.47).sin().mul(55217.443));
      const starDistX2 = fracX2.sub(starJitterX2);
      const starDistY2 = fracY2.sub(starJitterY2);
      const starDist2 = starDistX2.mul(starDistX2).add(starDistY2.mul(starDistY2)).sqrt();
      const starThreshold2 = float(1.005).sub(this.starStrength.mul(0.14));
      const starOn2 = smoothstep(starThreshold2, starThreshold2.add(0.005), starHash2);
      const starCircle2 = float(1).sub(smoothstep(0.04, 0.16, starDist2));
      const twinkle2 = starHash2.mul(120.0).add(time.mul(0.42)).sin().mul(0.18).add(0.82);
      const starColA2 = mix(color(0x7ea8ff), color(0xffe9c8), smoothstep(0.0, 0.55, starHueH2));
      const starColor2 = mix(starColA2, color(0xff9a55), smoothstep(0.55, 1.0, starHueH2));
      sky.addAssign(
        starColor2
          .mul(float(0.8).add(starBright2.mul(0.4)))
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
  if (p.style === 'peaks') {
    const broad = Math.pow(Math.abs(Math.sin(xs * p.freq + 0.24)), 1.85) * p.amp;
    const needles = Math.pow(Math.abs(Math.sin(xs * p.freq2 + 1.15)), 4.2) * p.amp2;
    const crags = Math.pow(Math.max(0, Math.sin(xs * p.freq2 * 1.64 + 0.45)), 6.0) * p.amp2 * 0.72;
    const saddles = Math.sin(xs * p.freq * 0.43 - 0.55) * p.amp * 0.10;
    const serration = Math.sin(xs * p.freq * 3.1 + 1.9) * p.amp * 0.045;
    return p.base + broad + needles + crags + saddles + serration;
  }
  if (p.style === 'flatLake') {
    const shore = Math.sin(xs * p.freq + 0.8) * p.amp;
    const lowIslands = Math.pow(Math.max(0, Math.sin(xs * p.freq2 + 1.35)), 2.8) * p.amp2;
    return p.base + shore + lowIslands;
  }
  if (p.style === 'mesa') {
    const shelves = Math.sin(xs * p.freq + 0.35) * p.amp;
    const smallBreaks = Math.sin(x * p.freq2 + 0.7) * p.amp2;
    return p.base + Math.max(0.02, shelves) + smallBreaks;
  }
  if (p.style === 'forest') {
    const rolling = Math.sin(xs * p.freq + 0.4) * p.amp;
    const canopy = Math.pow(Math.max(0, Math.sin(xs * p.freq2 + 0.2)), 2.4) * p.amp2;
    const softNoise = Math.sin(xs * 7.3 + 1.9) * p.amp2 * 0.18;
    return p.base + rolling + canopy + softNoise;
  }
  const primary = Math.sin(xs * p.freq + 0.15) * p.amp;
  const secondary = Math.sin(xs * p.freq2 + 1.2) * p.amp2;
  const detail = Math.sin(xs * 4.9 - 0.8) * p.amp * 0.06;
  return p.base + primary + secondary + detail;
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

function biomeWindowWeight(
  window: { from: { id: ForegroundBiomeId }; to: { id: ForegroundBiomeId }; t: number },
  id: ForegroundBiomeId,
): number {
  return (window.from.id === id ? 1 - window.t : 0) + (window.to.id === id ? window.t : 0);
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

function wrapCentered(value: number, length: number): number {
  return ((((value + length * 0.5) % length) + length) % length) - length * 0.5;
}
