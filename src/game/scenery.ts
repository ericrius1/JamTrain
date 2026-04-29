import * as THREE from 'three/webgpu';
import { makeParams, registerTweaks } from '../hud/tweakDefs';
import { clamp } from './math';
import {
  BiomeScheduler,
  timeOfDayPhase,
  type ForegroundBiomeId,
  type MagicEvent,
} from './biomes';
import { SpriteAtlas } from './spriteAtlas';
import { SkyLife } from './skyLife';
import { streamFor } from './seedRandom';

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
type PaintedTerrainChunk = (typeof PAINTED_TERRAIN_CHUNKS)[number];
type PaintedTerrainChunkId = PaintedTerrainChunk['id'];
type PaintedTerrainSelection = 'auto' | PaintedTerrainChunkId;

const PAINTED_TERRAIN_OPTIONS: Record<string, PaintedTerrainSelection> = (() => {
  const options: Record<string, PaintedTerrainSelection> = { auto: 'auto' };
  for (const chunk of PAINTED_TERRAIN_CHUNKS) {
    options[chunk.id.replaceAll('-', ' ')] = chunk.id;
  }
  return options;
})();

const PAINTED_TERRAIN_FOREGROUND_HINTS: Record<PaintedTerrainChunkId, ForegroundBiomeId> = {
  'alpine-lake': 'lake',
  'fog-forest': 'forest',
  'snow-peaks': 'snowfield',
  'red-mesa': 'hills',
  'coastal-lake': 'lake',
  'meadow-fields': 'meadow',
  'cypress-wetland': 'lake',
  'autumn-moor': 'farmland',
  'basalt-coast': 'coast',
  'lavender-steppe': 'meadow',
  'crystal-ravine': 'hills',
};

const PAINTED_TERRAIN_SEQUENCE = [
  0, 1, 6, 4, 8, 2, 10, 7, 5, 9, 3,
  1, 0, 4, 6, 5, 7, 10, 2, 8, 9, 3,
] as const;
const PAINTED_TERRAIN_CHUNK_WIDTH = 12.6;
const PAINTED_TERRAIN_BLEND_WIDTH = 2.4;
const PAINTED_TERRAIN_CHUNK_STRIDE = PAINTED_TERRAIN_CHUNK_WIDTH - PAINTED_TERRAIN_BLEND_WIDTH;
const PAINTED_TERRAIN_HEIGHT = 3.80;
const PAINTED_TERRAIN_X_DISTANCE = 4.20;
const PAINTED_TERRAIN_Y = 0.85;
const PAINTED_TERRAIN_LOOP_SECONDS_AT_MAX_SPEED = 360;
const PAINTED_TERRAIN_MAX_SPEED = 3;
const PAINTED_TERRAIN_VISIBLE_PANELS = 2;
const PAINTED_TERRAIN_ROOM_SEED_KEY = 0x5c3e9a;

export const SCENERY_DEFS = {
  cycleLengthSeconds:    { default: 240,  min: 30, max: 600, step: 1,     label: 'day/night sec' },
  cycleOffset:           { default: 0.50, min: 0,  max: 1,   step: 0.001, label: 'cycle offset' },
  trainSpeed:            { default: 1.1,  min: 0,  max: 3,   step: 0.01,  label: 'train speed' },
  paintedTerrainOpacity: { default: 0.92, min: 0,  max: 1,   step: 0.01,  label: 'painted layer' },
  foreground:            { type: 'select', default: 'auto', options: PAINTED_TERRAIN_OPTIONS, folder: 'Biomes' },
  transitionSpeed:       { default: 1,    min: 0.1, max: 10, step: 0.1,   folder: 'Biomes' },
  recencyPenalty:        { default: 1,    min: 0,   max: 2,  step: 0.05,  folder: 'Biomes' },
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

interface PaintedTerrainPanel {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  material: THREE.MeshBasicMaterial;
  sequenceOffset: number;
  sequenceIndex: number;
  texture?: THREE.Texture;
}

const fullTurn = Math.PI * 2;

export class ScenerySystem {
  readonly params = makeParams(SCENERY_DEFS);
  private registered?: ReturnType<typeof registerTweaks<typeof SCENERY_DEFS>>;
  private root = new THREE.Group();
  private scheduler!: BiomeScheduler;
  private atlas!: SpriteAtlas;
  private skyLife!: SkyLife;
  private onThunder?: (delay: number) => void;
  private paintedTerrainGeometry?: THREE.PlaneGeometry;
  private paintedTerrainAlphaTexture?: THREE.CanvasTexture;
  private paintedTerrainPanels: PaintedTerrainPanel[] = [];
  private paintedTerrainDistance = 0;
  private paintedTerrainLoader?: THREE.TextureLoader;
  private paintedTerrainSelection: PaintedTerrainSelection = 'auto';
  private paintedTerrainTextureCache = new Map<PaintedTerrainChunkId, THREE.Texture>();
  private readonly paintedTerrainTint = new THREE.Color(0xffffff);
  private readonly paintedTerrainNightTint = new THREE.Color(0x3a2a22);
  private readonly paintedTerrainDuskTint = new THREE.Color(0xffb261);
  private readonly atmosphereDayColor = new THREE.Color(0x6f4d2c);
  private readonly atmosphereDuskColor = new THREE.Color(0x7a3f2e);
  private readonly atmosphereNightColor = new THREE.Color(0x070503);
  private readonly atmosphereUnderwaterColor = new THREE.Color(0x031b2a);
  private readonly cycleStartedAt = Date.now() / 1000;
  private lastCycle = 0;
  private atmosphere = {
    background: new THREE.Color(0x10202d),
    daylight: 1,
    night: 0,
    underwater: 0,
  };
  private roomSeed: number;
  private skyLifeEnabled = false;

  constructor(
    private scene: THREE.Scene,
    paneContainer: HTMLElement | undefined,
    options: SceneryOptions
  ) {
    this.roomSeed = options.roomSeed;

    this.scheduler = new BiomeScheduler(
      this.roomSeed,
      () => Date.now() / 1000,
      () => this.lastCycle,
    );

    this.registered = registerTweaks(paneContainer, 'scenery-v4', SCENERY_DEFS, {
      title: 'Scenery',
      params: this.params,
      onChange: {
        foreground:      v => { this.setPaintedTerrainSelection(v as PaintedTerrainSelection); },
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
  }

  build(): void {
    this.root.name = 'procedural-scenery';
    this.createPaintedTerrain();
    this.atlas = new SpriteAtlas();
    this.skyLife = new SkyLife(
      this.scene,
      this.atlas,
      this.scheduler,
      this.roomSeed,
    );
    this.skyLife.build();
    this.scene.add(this.root);
  }

  // Defaults to false so the world doesn't sprout flocks while the user is
  // still on the intro screen — Game flips this on after All Aboard so the
  // sky comes alive at the same moment the lights come up.
  setSkyLifeEnabled(enabled: boolean): void {
    this.skyLifeEnabled = enabled;
  }

  setRoomSeed(seed: number): void {
    this.roomSeed = seed;
    this.scheduler.setSeed(seed);
    this.skyLife?.setSeed(seed);
    if (this.paintedTerrainSelection === 'auto') {
      this.seedPaintedTerrainStart();
      this.updatePaintedTerrainPanels();
    }
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
    const sunrise = Math.exp(-Math.pow(cycle / 0.095, 2));
    const sunset = Math.exp(-Math.pow((cycle - 0.5) / 0.105, 2));
    const goldenHour = clamp(Math.max(sunrise, sunset), 0, 1);
    const speed = this.params.trainSpeed;
    const underwater = 0;

    this.updatePaintedTerrain(delta, speed, daylight, night, goldenHour);

    if (this.skyLife && this.skyLifeEnabled) {
      const fg = this.scheduler.foreground();
      const currentFg = fg.t < 0.5 ? fg.from : fg.to;
      this.skyLife.update(delta, {
        daylight,
        goldenHour,
        cloudCover: 0,
        rainAmount: 0,
        phase: timeOfDayPhase(cycle),
        currentForegroundId: this.paintedTerrainForegroundHint() ?? currentFg.id,
      });
    }

    this.atmosphere.background
      .copy(this.atmosphereNightColor)
      .lerp(this.atmosphereDayColor, daylight)
      .lerp(this.atmosphereDuskColor, goldenHour * 0.35)
      .lerp(this.atmosphereUnderwaterColor, underwater * 0.82);
    this.atmosphere.daylight = daylight;
    this.atmosphere.night = night;
    this.atmosphere.underwater = underwater;
    return this.atmosphere;
  }

  dispose(): void {
    this.registered?.dispose();
    this.disposePaintedTerrain();
  }

  private createPaintedTerrain(): void {
    this.paintedTerrainLoader = new THREE.TextureLoader();
    this.paintedTerrainGeometry = new THREE.PlaneGeometry(PAINTED_TERRAIN_CHUNK_WIDTH, PAINTED_TERRAIN_HEIGHT);
    this.paintedTerrainAlphaTexture = this.createPaintedTerrainAlphaTexture();
    this.seedPaintedTerrainStart();

    for (let sequenceOffset = 0; sequenceOffset < PAINTED_TERRAIN_VISIBLE_PANELS; sequenceOffset += 1) {
      const material = new THREE.MeshBasicMaterial({
        alphaMap: this.paintedTerrainAlphaTexture,
        color: 0xffffff,
        transparent: true,
        opacity: this.params.paintedTerrainOpacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.paintedTerrainGeometry, material);
      mesh.rotation.y = Math.PI / 2;
      mesh.position.set(-PAINTED_TERRAIN_X_DISTANCE, PAINTED_TERRAIN_Y, 0);
      mesh.renderOrder = -31 + sequenceOffset * 0.001;
      mesh.frustumCulled = false;
      this.paintedTerrainPanels.push({ mesh, material, sequenceOffset, sequenceIndex: -1 });
      this.root.add(mesh);
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

  private updatePaintedTerrain(
    delta: number,
    speed: number,
    daylight: number,
    night: number,
    goldenHour: number,
  ): void {
    const loopLength = this.paintedTerrainLoopLength();
    if (loopLength > 0 && this.paintedTerrainSelection === 'auto') {
      const speedFactor = clamp(speed, 0, PAINTED_TERRAIN_MAX_SPEED) / PAINTED_TERRAIN_MAX_SPEED;
      const transitionSpeed = Math.max(0.05, this.params.transitionSpeed);
      const deltaDistance = delta * speedFactor * transitionSpeed * loopLength / PAINTED_TERRAIN_LOOP_SECONDS_AT_MAX_SPEED;
      this.paintedTerrainDistance = (this.paintedTerrainDistance + deltaDistance) % loopLength;
      this.updatePaintedTerrainPanels();
    }

    this.paintedTerrainTint
      .set(0xffffff)
      .lerp(this.paintedTerrainNightTint, night * 0.68)
      .lerp(this.paintedTerrainDuskTint, goldenHour * 0.16);

    const opacity = this.params.paintedTerrainOpacity * (0.78 + daylight * 0.22);
    for (const panel of this.paintedTerrainPanels) {
      panel.material.color.copy(this.paintedTerrainTint);
      panel.material.opacity = opacity;
    }
  }

  private updatePaintedTerrainPanels(): void {
    const loopLength = this.paintedTerrainLoopLength();
    if (loopLength <= 0) return;

    const sequenceLength = PAINTED_TERRAIN_SEQUENCE.length;
    const currentIndex = this.paintedTerrainCurrentSequenceIndex();
    const localDistance = this.paintedTerrainSelection === 'auto'
      ? this.paintedTerrainDistance % PAINTED_TERRAIN_CHUNK_STRIDE
      : 0;

    for (const panel of this.paintedTerrainPanels) {
      const sequenceIndex = (currentIndex + panel.sequenceOffset) % sequenceLength;
      if (panel.sequenceIndex !== sequenceIndex) {
        this.assignPaintedTerrainTexture(panel, sequenceIndex);
      }
      panel.mesh.position.z = panel.sequenceOffset * PAINTED_TERRAIN_CHUNK_STRIDE - localDistance;
    }
  }

  private assignPaintedTerrainTexture(panel: PaintedTerrainPanel, sequenceIndex: number): void {
    const chunkIndex = PAINTED_TERRAIN_SEQUENCE[sequenceIndex];
    const chunk = PAINTED_TERRAIN_CHUNKS[chunkIndex];
    const texture = this.getPaintedTerrainTexture(chunk);
    if (!texture) return;

    panel.sequenceIndex = sequenceIndex;
    panel.texture = texture;
    panel.material.map = texture;
    panel.material.needsUpdate = true;
    panel.mesh.name = `painted-far-terrain-${chunk.id}`;
  }

  private getPaintedTerrainTexture(chunk: PaintedTerrainChunk): THREE.Texture | undefined {
    const cached = this.paintedTerrainTextureCache.get(chunk.id);
    if (cached) return cached;

    const loader = this.paintedTerrainLoader;
    if (!loader) return undefined;

    const texture = loader.load(chunk.texture, tex => {
      this.configurePaintedTerrainTexture(tex);
      tex.needsUpdate = true;
    });
    this.configurePaintedTerrainTexture(texture);
    this.paintedTerrainTextureCache.set(chunk.id, texture);
    return texture;
  }

  private setPaintedTerrainSelection(selection: PaintedTerrainSelection): void {
    this.paintedTerrainSelection = isPaintedTerrainSelection(selection) ? selection : 'auto';
    this.scheduler.overrides.forceForeground = this.paintedTerrainForegroundHint();

    if (this.paintedTerrainSelection !== 'auto') {
      const sequenceIndex = this.sequenceIndexForPaintedTerrainChunk(this.paintedTerrainSelection);
      this.paintedTerrainDistance = sequenceIndex * PAINTED_TERRAIN_CHUNK_STRIDE;
    }

    this.updatePaintedTerrainPanels();
  }

  private paintedTerrainCurrentSequenceIndex(): number {
    if (this.paintedTerrainSelection !== 'auto') {
      return this.sequenceIndexForPaintedTerrainChunk(this.paintedTerrainSelection);
    }
    return Math.floor(this.paintedTerrainDistance / PAINTED_TERRAIN_CHUNK_STRIDE) % PAINTED_TERRAIN_SEQUENCE.length;
  }

  private paintedTerrainForegroundHint(): ForegroundBiomeId | undefined {
    if (this.paintedTerrainSelection === 'auto') return undefined;
    return PAINTED_TERRAIN_FOREGROUND_HINTS[this.paintedTerrainSelection];
  }

  private sequenceIndexForPaintedTerrainChunk(id: PaintedTerrainChunkId): number {
    const chunkIndex = PAINTED_TERRAIN_CHUNKS.findIndex(chunk => chunk.id === id);
    const sequenceIndex = PAINTED_TERRAIN_SEQUENCE.findIndex(index => index === chunkIndex);
    return Math.max(0, sequenceIndex);
  }

  private configurePaintedTerrainTexture(texture: THREE.Texture): void {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = true;
  }

  private paintedTerrainLoopLength(): number {
    return PAINTED_TERRAIN_CHUNK_STRIDE * PAINTED_TERRAIN_SEQUENCE.length;
  }

  private seedPaintedTerrainStart(): void {
    const rand = streamFor(this.roomSeed, PAINTED_TERRAIN_ROOM_SEED_KEY);
    const sequenceIndex = Math.floor(rand() * PAINTED_TERRAIN_SEQUENCE.length) % PAINTED_TERRAIN_SEQUENCE.length;
    this.paintedTerrainDistance = sequenceIndex * PAINTED_TERRAIN_CHUNK_STRIDE;
  }

  private disposePaintedTerrain(): void {
    for (const panel of this.paintedTerrainPanels) {
      this.root.remove(panel.mesh);
      panel.material.dispose();
    }
    this.paintedTerrainPanels = [];
    for (const texture of this.paintedTerrainTextureCache.values()) texture.dispose();
    this.paintedTerrainTextureCache.clear();
    this.paintedTerrainGeometry?.dispose();
    this.paintedTerrainAlphaTexture?.dispose();
    this.paintedTerrainGeometry = undefined;
    this.paintedTerrainAlphaTexture = undefined;
    this.paintedTerrainLoader = undefined;
  }

}

function isPaintedTerrainSelection(value: string): value is PaintedTerrainSelection {
  return value === 'auto' || PAINTED_TERRAIN_CHUNKS.some(chunk => chunk.id === value);
}
