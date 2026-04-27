import * as THREE from 'three/webgpu';
import { SpriteAtlas, type AtlasId } from './spriteAtlas';
import {
  type BiomeScheduler,
  type ForegroundBiome,
  type ForegroundBiomeId,
  type SpriteBand,
} from './biomes';
import { streamFor } from './seedRandom';
import { appendSpriteShape, type ShapeBuffers } from './spriteShapes';

const LAYER_WIDTH = 12.4;
const HALF_WIDTH = LAYER_WIDTH * 0.5;

type LayerKind = 'foreground' | 'midground';

interface SpritePlacement {
  originX: number;
  baseY: number;
  scale: number;
  widthScale: number;
  heightScale: number;
  lean: number;
  swayPhase: number;
  swayStrength: number;
  swaySpeed: number;
  shadeBias: number;
  atlas: AtlasId;
  tint: THREE.Color;
}

interface PackedVertex {
  placementIndex: number;
  localX: number;
  localY: number;
  shade: number;
  windWeight: number;
}

interface LayerSlot {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  biomeId: ForegroundBiomeId | null;
  placements: SpritePlacement[];
  vertices: PackedVertex[];
  positions: Float32Array;
  colors: Float32Array;
  positionAttr: THREE.BufferAttribute;
  colorAttr: THREE.BufferAttribute;
}

interface LayerHandle {
  side: number;
  kind: LayerKind;
  scrollOffset: number;
  scrollSpeed: number;
  slots: [LayerSlot, LayerSlot];
}

export class BiomeLayers {
  private layers: LayerHandle[] = [];
  private root = new THREE.Group();
  private currentVillageBiomeId: ForegroundBiomeId | null = null;
  private windTime = 0;
  private treeVolumes: TreeVolumeLayer[] = [];

  private villagePoints: Array<{
    points: THREE.Points;
    geometry: THREE.BufferGeometry;
    material: THREE.PointsMaterial;
    side: number;
    capacity: number;
  }> = [];

  constructor(
    private scene: THREE.Scene,
    _atlas: SpriteAtlas,
    private scheduler: BiomeScheduler,
    private seed: number,
  ) {}

  build(): void {
    this.root.name = 'biome-layers';
    for (const side of [-1]) {
      this.layers.push(this.createLayer(side, 'midground', 0.55, side * 2.18, -15));
      this.layers.push(this.createLayer(side, 'foreground', 0.85, side * 2.10, -14));
      this.villagePoints.push(this.createVillageGroup(side));
      const treeVolume = new TreeVolumeLayer(side, this.seed);
      this.treeVolumes.push(treeVolume);
      this.root.add(treeVolume.group);
    }
    const { from, to } = this.scheduler.foreground();
    for (const layer of this.layers) {
      this.populateSlot(layer.slots[0], from, layer);
      this.populateSlot(layer.slots[1], to, layer);
    }
    this.populateVillageFor(from);
    this.scene.add(this.root);
  }

  setSeed(seed: number): void {
    this.seed = seed;
    for (const layer of this.layers) {
      layer.slots[0].biomeId = null;
      layer.slots[1].biomeId = null;
    }
    for (const volume of this.treeVolumes) volume.setSeed(seed);
    this.currentVillageBiomeId = null;
  }

  update(delta: number, trainSpeed: number, ctx: { daylight: number; nightAmount: number }): void {
    const window = this.scheduler.foreground();
    const fade = window.from.id === window.to.id ? 0 : window.t;
    const dominantBiome = fade < 0.5 ? window.from : window.to;
    this.windTime += delta * (0.55 + trainSpeed * 0.18);

    for (const layer of this.layers) {
      this.ensureSlotBiome(layer.slots[0], window.from, layer);
      this.ensureSlotBiome(layer.slots[1], window.to, layer);

      layer.scrollOffset += delta * trainSpeed * layer.scrollSpeed;
      layer.scrollOffset = ((layer.scrollOffset % LAYER_WIDTH) + LAYER_WIDTH) % LAYER_WIDTH;

      layer.slots[0].material.opacity = window.from.id === window.to.id ? 1 : 1 - fade;
      layer.slots[1].material.opacity = window.from.id === window.to.id ? 0 : fade;
      this.bakeSlot(layer.slots[0], layer.scrollOffset, ctx.daylight);
      this.bakeSlot(layer.slots[1], layer.scrollOffset, ctx.daylight);
    }

    if (dominantBiome.id !== this.currentVillageBiomeId) {
      this.populateVillageFor(dominantBiome);
    }

    const fromLights = window.from.villageLights?.density ?? 0;
    const toLights = window.to.villageLights?.density ?? 0;
    const lightDensity = fromLights * (1 - fade) + toLights * fade;
    for (const vg of this.villagePoints) {
      const desired = lightDensity * ctx.nightAmount;
      vg.material.opacity = vg.material.opacity + (desired - vg.material.opacity) * 0.06;
    }

    for (const volume of this.treeVolumes) {
      volume.update(delta, trainSpeed, dominantBiome);
    }
  }

  private createLayer(
    side: number,
    kind: LayerKind,
    scrollSpeed: number,
    x: number,
    renderOrder: number,
  ): LayerHandle {
    const slots: [LayerSlot, LayerSlot] = [
      this.createSlot(x, renderOrder),
      this.createSlot(x, renderOrder + 0.01),
    ];
    return { side, kind, scrollOffset: 0, scrollSpeed, slots };
  }

  private createSlot(x: number, renderOrder: number): LayerSlot {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(0);
    const colors = new Float32Array(0);
    const positionAttr = new THREE.BufferAttribute(positions, 3);
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('color', colorAttr);
    geometry.setIndex(null);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LAYER_WIDTH);
    geometry.computeBoundingSphere = () => {
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LAYER_WIDTH);
    };

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(x, 0, 0);
    mesh.renderOrder = renderOrder;
    this.root.add(mesh);

    return {
      mesh,
      geometry,
      material,
      biomeId: null,
      placements: [],
      vertices: [],
      positions,
      colors,
      positionAttr,
      colorAttr,
    };
  }

  private ensureSlotBiome(slot: LayerSlot, biome: ForegroundBiome, layer: LayerHandle): void {
    if (slot.biomeId !== biome.id) this.populateSlot(slot, biome, layer);
  }

  private populateSlot(slot: LayerSlot, biome: ForegroundBiome, layer: LayerHandle): void {
    slot.biomeId = biome.id;
    slot.placements = this.generatePlacements(biome, layer);
    slot.vertices = [];

    const buffers: ShapeBuffers = { positions: [], colors: [] };
    for (let i = 0; i < slot.placements.length; i += 1) {
      const p = slot.placements[i];
      const baseVertex = buffers.positions.length / 3;
      appendSpriteShape(buffers, p.atlas, 0, 0, 1, p.tint, 'bottom');
      const nextVertex = buffers.positions.length / 3;
      for (let v = baseVertex; v < nextVertex; v += 1) {
        const localX = buffers.positions[v * 3];
        const localY = buffers.positions[v * 3 + 1];
        slot.vertices.push({
          placementIndex: i,
          localX,
          localY,
          shade: spriteVertexShade(p.atlas, localX, localY),
          windWeight: vegetationWindFactor(p.atlas) * Math.pow(clamp01(localY), 1.45),
        });
      }
    }

    slot.positions = new Float32Array(buffers.positions.length);
    slot.colors = new Float32Array(buffers.colors.length);
    slot.positionAttr = new THREE.BufferAttribute(slot.positions, 3);
    slot.colorAttr = new THREE.BufferAttribute(slot.colors, 3);
    slot.positionAttr.setUsage(THREE.DynamicDrawUsage);
    slot.colorAttr.setUsage(THREE.DynamicDrawUsage);
    slot.geometry.setAttribute('position', slot.positionAttr);
    slot.geometry.setAttribute('color', slot.colorAttr);
    slot.geometry.setIndex(null);
    slot.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LAYER_WIDTH);
  }

  private generatePlacements(biome: ForegroundBiome, layer: LayerHandle): SpritePlacement[] {
    const placements: SpritePlacement[] = [];
    const seedKey = hashBiomeKey(biome.id, layer.side, layer.kind);
    const rand = streamFor(this.seed, seedKey);
    const groundColor = new THREE.Color(biome.groundColor.day);

    for (const band of biome.sprites) {
      if (band.layer !== layer.kind) continue;
      const count = Math.max(1, Math.floor(band.density * LAYER_WIDTH));
      const step = LAYER_WIDTH / count;
      for (let i = 0; i < count; i += 1) {
        const originX = -HALF_WIDTH + step * (i + 0.5) + (rand() - 0.5) * step * 0.72;
        const baseY = biome.ridge.baseY + (layer.kind === 'midground' ? 0.035 : 0) + (rand() - 0.5) * band.yJitter;
        const scale = band.sizeRange[0] + rand() * (band.sizeRange[1] - band.sizeRange[0]);
        const profile = scaleProfileFor(band.atlas, rand);
        const wind = vegetationWindFactor(band.atlas);
        placements.push({
          originX,
          baseY,
          scale,
          widthScale: profile.width,
          heightScale: profile.height,
          lean: (rand() - 0.5) * wind * (layer.kind === 'foreground' ? 0.14 : 0.08),
          swayPhase: rand() * Math.PI * 2,
          swayStrength: wind * (layer.kind === 'foreground' ? 0.030 : 0.018) * (0.75 + rand() * 0.5),
          swaySpeed: 0.75 + rand() * 0.85,
          shadeBias: 0.92 + rand() * 0.14,
          atlas: band.atlas,
          tint: colorFromBiomeBand(groundColor, band, rand),
        });
      }
    }

    return placements;
  }

  private bakeSlot(slot: LayerSlot, scroll: number, daylight: number): void {
    const dayMul = 0.42 + daylight * 0.58;
    for (let i = 0; i < slot.vertices.length; i += 1) {
      const v = slot.vertices[i];
      const p = slot.placements[v.placementIndex];
      let wx = p.originX - scroll;
      wx = ((wx + HALF_WIDTH) % LAYER_WIDTH + LAYER_WIDTH) % LAYER_WIDTH - HALF_WIDTH;
      const crownDrift = Math.sin(this.windTime * p.swaySpeed + p.swayPhase) * p.swayStrength;
      const leafFlutter = Math.sin(this.windTime * (p.swaySpeed + 0.65) + p.swayPhase + v.localY * 6.1) * p.swayStrength * 0.16;
      const bend = (p.lean * clamp01(v.localY) + (crownDrift + leafFlutter) * v.windWeight) * p.scale;
      slot.positions[i * 3 + 0] = wx + v.localX * p.scale * p.widthScale + bend;
      slot.positions[i * 3 + 1] = p.baseY + v.localY * p.scale * p.heightScale;
      slot.positions[i * 3 + 2] = 0;

      const shade = dayMul * p.shadeBias * v.shade;
      slot.colors[i * 3 + 0] = p.tint.r * shade;
      slot.colors[i * 3 + 1] = p.tint.g * shade;
      slot.colors[i * 3 + 2] = p.tint.b * shade;
    }
    slot.positionAttr.needsUpdate = true;
    slot.colorAttr.needsUpdate = true;
  }

  private createVillageGroup(side: number) {
    const cap = 80;
    const positions = new Float32Array(cap * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setDrawRange(0, 0);
    const material = new THREE.PointsMaterial({
      color: 0xffd58a,
      size: 0.022,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.rotation.y = Math.PI / 2;
    points.position.set(side * 2.10, 0, 0);
    points.renderOrder = -10;
    this.root.add(points);
    return { points, geometry, material, side, capacity: cap };
  }

  private populateVillageFor(biome: ForegroundBiome): void {
    this.currentVillageBiomeId = biome.id;
    for (const vg of this.villagePoints) this.populateVillage(vg, biome);
  }

  private populateVillage(
    vg: { points: THREE.Points; geometry: THREE.BufferGeometry; capacity: number; side: number },
    biome: ForegroundBiome,
  ): void {
    const positions = vg.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!biome.villageLights) {
      vg.geometry.setDrawRange(0, 0);
      return;
    }
    const rand = streamFor(this.seed, hashBiomeKey(biome.id, vg.side, 'village'));
    const tightness = biome.villageLights.clusterTightness;
    let cursor = 0;
    const clusters = 2 + Math.floor(rand() * 3);
    for (let c = 0; c < clusters && cursor < vg.capacity; c += 1) {
      const cx = (rand() - 0.5) * (LAYER_WIDTH - 1.0);
      const cy = biome.ridge.baseY + 0.04 + rand() * 0.12;
      const lights = 5 + Math.floor(rand() * 8);
      for (let i = 0; i < lights && cursor < vg.capacity; i += 1) {
        positions.setXYZ(
          cursor,
          cx + (rand() - 0.5) * tightness,
          cy + (rand() - 0.5) * tightness * 0.4,
          0,
        );
        cursor += 1;
      }
    }
    vg.geometry.setDrawRange(0, cursor);
    positions.needsUpdate = true;
  }
}

interface TreeVolumePlacement {
  originX: number;
  baseY: number;
  worldX: number;
  scale: number;
  group: THREE.Group;
  swayPhase: number;
  swayStrength: number;
  swaySpeed: number;
}

type TreeVolumePalette = {
  bark: THREE.Color;
  leafDark: THREE.Color;
  leafMid: THREE.Color;
  leafLight: THREE.Color;
};

class TreeVolumeLayer {
  readonly group = new THREE.Group();
  private placements: TreeVolumePlacement[] = [];
  private biomeId: ForegroundBiomeId | null = null;
  private scrollOffset = 0;
  private windTime = 0;

  constructor(
    private side: number,
    private seed: number,
  ) {
    this.group.name = `tree-volume-layer-${side}`;
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.biomeId = null;
    this.scrollOffset = 0;
    this.clear();
  }

  update(delta: number, trainSpeed: number, biome: ForegroundBiome): void {
    if (this.biomeId !== biome.id) this.populateFor(biome);
    this.scrollOffset += delta * trainSpeed * 0.68;
    this.scrollOffset = ((this.scrollOffset % LAYER_WIDTH) + LAYER_WIDTH) % LAYER_WIDTH;
    this.windTime += delta * (0.42 + trainSpeed * 0.12);

    for (const placement of this.placements) {
      let wx = placement.originX - this.scrollOffset;
      wx = ((wx + HALF_WIDTH) % LAYER_WIDTH + LAYER_WIDTH) % LAYER_WIDTH - HALF_WIDTH;
      const sway = Math.sin(this.windTime * placement.swaySpeed + placement.swayPhase) * placement.swayStrength;
      placement.group.position.set(placement.worldX, placement.baseY, -wx);
      placement.group.rotation.x = sway;
      placement.group.rotation.z = sway * 0.18;
      placement.group.visible = wx > -HALF_WIDTH - 0.6 && wx < HALF_WIDTH + 0.6;
    }
  }

  private populateFor(biome: ForegroundBiome): void {
    this.biomeId = biome.id;
    this.clear();

    for (const band of biome.sprites) {
      if (!isTreeAtlas(band.atlas)) continue;
      const count = Math.max(1, Math.floor(band.density * LAYER_WIDTH * 0.76));
      const step = LAYER_WIDTH / count;
      const rand = streamFor(this.seed, hashBiomeKey(biome.id, this.side, `${band.atlas}-volume-${band.layer}`));

      for (let i = 0; i < count; i += 1) {
        const originX = -HALF_WIDTH + step * (i + 0.5) + (rand() - 0.5) * step * 0.78;
        const baseY = biome.ridge.baseY + (band.layer === 'midground' ? 0.035 : -0.004) + (rand() - 0.5) * band.yJitter;
        const scale = (band.sizeRange[0] + rand() * (band.sizeRange[1] - band.sizeRange[0])) * (1.30 + rand() * 0.32);
        const palette = treePaletteFor(biome, band.atlas, rand);
        const tree = makeTreeVolume(band.atlas, palette, rand);
        tree.scale.setScalar(scale);
        this.group.add(tree);
        this.placements.push({
          originX,
          baseY,
          worldX: this.side * (band.layer === 'foreground' ? 2.10 : 2.18),
          scale,
          group: tree,
          swayPhase: rand() * Math.PI * 2,
          swayStrength: vegetationWindFactor(band.atlas) * 0.045 * (0.65 + rand() * 0.45),
          swaySpeed: 0.58 + rand() * 0.62,
        });
      }
    }
  }

  private clear(): void {
    this.group.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach(m => m.dispose());
      else mat.dispose();
    });
    this.group.clear();
    this.placements = [];
  }
}

function colorFromBiomeBand(groundDay: THREE.Color, band: SpriteBand, rand: () => number): THREE.Color {
  const c = new THREE.Color().copy(groundDay);
  if (isEvergreen(band.atlas)) {
    c.lerp(new THREE.Color(0x1d412f), 0.38);
  } else if (isBroadleaf(band.atlas)) {
    c.lerp(new THREE.Color(0x5f7f47), 0.24);
  } else if (band.atlas === 'reeds' || band.atlas === 'cattail') {
    c.lerp(new THREE.Color(0x8f8650), 0.35);
  }
  c.offsetHSL((rand() - 0.5) * 0.035, (rand() - 0.5) * 0.08, (rand() - 0.5) * 0.08);
  const baseMul = band.layer === 'foreground' ? 0.50 : 0.66;
  const v = 0.86 + rand() * 0.30;
  return c.multiplyScalar(baseMul * v);
}

function makeTreeVolume(atlas: AtlasId, palette: TreeVolumePalette, rand: () => number): THREE.Group {
  if (atlas === 'birchGrove') return makeBirchGroveVolume(palette, rand);
  if (atlas === 'windsweptOak' || atlas === 'deciduousRound' || atlas === 'deciduousTall') {
    return makeBroadleafVolume(atlas, palette, rand);
  }
  return makeEvergreenVolume(atlas, palette, rand);
}

function makeEvergreenVolume(atlas: AtlasId, palette: TreeVolumePalette, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const bark = makeTreeMaterial(palette.bark, 0.10);
  const dark = makeTreeMaterial(palette.leafDark, 0.08);
  const mid = makeTreeMaterial(palette.leafMid, 0.10);
  const light = makeTreeMaterial(palette.leafLight, 0.12);

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.042, 0.34, 5), bark);
  trunk.position.y = 0.17;
  treeMeshDefaults(trunk);
  group.add(trunk);

  const swept = atlas === 'cedarSweep';
  const tiers: Array<{ radius: number; height: number; y: number; mat: THREE.Material; squash: number }> = [
    { radius: swept ? 0.24 : 0.26, height: 0.34, y: 0.34, mat: dark,  squash: 1.18 },
    { radius: swept ? 0.21 : 0.22, height: 0.32, y: 0.53, mat: mid,   squash: 1.03 },
    { radius: swept ? 0.16 : 0.17, height: 0.30, y: 0.71, mat: light, squash: 0.90 },
  ];
  if (atlas === 'pineShort') tiers.pop();

  for (const tier of tiers) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(tier.radius, tier.height, 6), tier.mat);
    cone.position.set((rand() - 0.5) * 0.025, tier.y, (rand() - 0.5) * 0.025);
    cone.rotation.y = rand() * Math.PI * 2;
    cone.scale.x = tier.squash;
    cone.scale.z = 0.86 + rand() * 0.25;
    treeMeshDefaults(cone);
    group.add(cone);
  }

  return group;
}

function makeBirchGroveVolume(palette: TreeVolumePalette, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const bark = makeTreeMaterial(palette.bark.clone().lerp(new THREE.Color(0xa89a78), 0.40), 0.14);
  const dark = makeTreeMaterial(palette.leafDark, 0.09);
  const mid = makeTreeMaterial(palette.leafMid, 0.11);
  const light = makeTreeMaterial(palette.leafLight, 0.13);
  const trunks: Array<[number, number, number]> = [
    [-0.08, 0.42, -0.02],
    [0.00, 0.50, 0.02],
    [0.09, 0.39, 0.01],
  ];

  for (const [x, h, z] of trunks) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.026, h, 5), bark);
    trunk.position.set(x, h * 0.5, z);
    trunk.rotation.z = (rand() - 0.5) * 0.12;
    treeMeshDefaults(trunk);
    group.add(trunk);
  }

  const blobs: Array<[number, number, number, THREE.Material]> = [
    [-0.10, 0.52, 0.00, dark],
    [0.01, 0.67, 0.02, mid],
    [0.12, 0.54, -0.01, mid],
    [-0.03, 0.47, -0.06, light],
  ];
  for (const [x, y, z, mat] of blobs) {
    const blob = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16 + rand() * 0.035, 0), mat);
    blob.position.set(x, y, z);
    blob.rotation.set(rand() * 0.7, rand() * Math.PI * 2, rand() * 0.5);
    blob.scale.set(1.08 + rand() * 0.22, 0.88 + rand() * 0.28, 0.86 + rand() * 0.24);
    treeMeshDefaults(blob);
    group.add(blob);
  }

  return group;
}

function makeBroadleafVolume(atlas: AtlasId, palette: TreeVolumePalette, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  const bark = makeTreeMaterial(palette.bark, 0.10);
  const dark = makeTreeMaterial(palette.leafDark, 0.08);
  const mid = makeTreeMaterial(palette.leafMid, 0.11);
  const light = makeTreeMaterial(palette.leafLight, 0.14);
  const oak = atlas === 'windsweptOak';

  const trunkTop = oak ? new THREE.Vector3(0.08, 0.48, 0.00) : new THREE.Vector3(0.01, 0.46, 0.00);
  group.add(makeBranch(new THREE.Vector3(0, 0.02, 0), trunkTop, 0.035, bark));
  group.add(makeBranch(trunkTop.clone().multiplyScalar(0.72), new THREE.Vector3(oak ? 0.22 : 0.14, 0.58, 0.01), 0.020, bark));
  group.add(makeBranch(trunkTop.clone().multiplyScalar(0.78), new THREE.Vector3(oak ? -0.12 : -0.10, 0.54, -0.01), 0.016, bark));

  const blobs: Array<[number, number, number, number, THREE.Material]> = oak ? [
    [0.15, 0.62, 0.00, 0.19, dark],
    [0.31, 0.66, 0.03, 0.18, mid],
    [0.03, 0.69, -0.03, 0.17, mid],
    [0.23, 0.80, -0.02, 0.15, light],
    [-0.10, 0.57, 0.02, 0.13, dark],
  ] : [
    [0.00, 0.64, 0.00, 0.20, dark],
    [-0.14, 0.57, -0.02, 0.15, mid],
    [0.14, 0.58, 0.03, 0.16, mid],
    [-0.03, 0.78, 0.02, 0.15, light],
    [0.09, 0.72, -0.04, 0.14, light],
  ];

  for (const [x, y, z, r, mat] of blobs) {
    const blob = new THREE.Mesh(new THREE.DodecahedronGeometry(r + rand() * 0.025, 0), mat);
    blob.position.set(x, y, z);
    blob.rotation.set(rand() * 0.75, rand() * Math.PI * 2, rand() * 0.6);
    blob.scale.set(1.10 + rand() * 0.22, 0.88 + rand() * 0.22, 0.82 + rand() * 0.28);
    treeMeshDefaults(blob);
    group.add(blob);
  }

  return group;
}

function makeBranch(from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = Math.max(0.001, dir.length());
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius, length, 5), material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  treeMeshDefaults(mesh);
  return mesh;
}

function treePaletteFor(biome: ForegroundBiome, atlas: AtlasId, rand: () => number): TreeVolumePalette {
  const ground = new THREE.Color(biome.groundColor.day);
  const leafMid = ground.clone().lerp(new THREE.Color(isEvergreen(atlas) ? 0x2e6040 : 0x6f8f4e), 0.62);
  leafMid.offsetHSL((rand() - 0.5) * 0.035, 0.02 + rand() * 0.06, (rand() - 0.5) * 0.06);
  leafMid.multiplyScalar(1.12);
  const leafDark = leafMid.clone().multiplyScalar(isEvergreen(atlas) ? 0.66 : 0.72);
  const leafLight = leafMid.clone().lerp(new THREE.Color(0xd3be72), isEvergreen(atlas) ? 0.16 : 0.22).multiplyScalar(1.24);
  const bark = new THREE.Color(0x6b4424).lerp(ground, 0.16).multiplyScalar(0.86 + rand() * 0.12);
  return { bark, leafDark, leafMid, leafLight };
}

function makeTreeMaterial(color: THREE.Color, emissiveMul: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color.clone().multiplyScalar(emissiveMul * 1.8),
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });
}

function treeMeshDefaults(mesh: THREE.Mesh): void {
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = -13;
}

function scaleProfileFor(atlas: AtlasId, rand: () => number): { width: number; height: number } {
  if (isEvergreen(atlas)) {
    return { width: 0.82 + rand() * 0.32, height: 0.92 + rand() * 0.24 };
  }
  if (isBroadleaf(atlas)) {
    return { width: 0.88 + rand() * 0.42, height: 0.86 + rand() * 0.28 };
  }
  if (atlas === 'reeds' || atlas === 'cattail') {
    return { width: 0.84 + rand() * 0.32, height: 0.90 + rand() * 0.24 };
  }
  return { width: 0.94 + rand() * 0.12, height: 0.96 + rand() * 0.10 };
}

function spriteVertexShade(atlas: AtlasId, localX: number, localY: number): number {
  if (isEvergreen(atlas)) {
    const sideShade = 1 - Math.abs(localX) * 0.16;
    const heightShade = 0.80 + clamp01(localY) * 0.26;
    const trunkShade = Math.abs(localX) < 0.055 && localY < 0.34 ? 0.78 : 1;
    return sideShade * heightShade * trunkShade;
  }
  if (isBroadleaf(atlas)) {
    const topLift = 0.82 + clamp01(localY) * 0.22;
    const edgeShade = 0.92 + Math.max(0, localX) * 0.10 - Math.max(0, -localX) * 0.05;
    const trunkShade = Math.abs(localX) < 0.075 && localY < 0.45 ? 0.70 : 1;
    return topLift * edgeShade * trunkShade;
  }
  if (atlas === 'reeds' || atlas === 'cattail') {
    return 0.82 + clamp01(localY) * 0.24;
  }
  return 1;
}

function vegetationWindFactor(atlas: AtlasId): number {
  if (isEvergreen(atlas)) return 0.65;
  if (isBroadleaf(atlas)) return 1.0;
  if (atlas === 'reeds' || atlas === 'cattail') return 1.25;
  return 0;
}

function isEvergreen(atlas: AtlasId): boolean {
  return atlas === 'pineTall' || atlas === 'pineShort' || atlas === 'cedarSweep';
}

function isBroadleaf(atlas: AtlasId): boolean {
  return atlas === 'deciduousRound' || atlas === 'deciduousTall' || atlas === 'birchGrove' || atlas === 'windsweptOak';
}

function isTreeAtlas(atlas: AtlasId): boolean {
  return isEvergreen(atlas) || isBroadleaf(atlas);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function hashBiomeKey(id: string, side: number, kind: string): number {
  let h = 0;
  const s = `${id}|${side}|${kind}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
