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
  atlas: AtlasId;
  tint: THREE.Color;
}

interface PackedVertex {
  placementIndex: number;
  localX: number;
  localY: number;
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
    this.currentVillageBiomeId = null;
  }

  update(delta: number, trainSpeed: number, ctx: { daylight: number; nightAmount: number }): void {
    const window = this.scheduler.foreground();
    const fade = window.from.id === window.to.id ? 0 : window.t;
    const dominantBiome = fade < 0.5 ? window.from : window.to;

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
        slot.vertices.push({
          placementIndex: i,
          localX: buffers.positions[v * 3],
          localY: buffers.positions[v * 3 + 1],
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
        placements.push({
          originX,
          baseY,
          scale,
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
      slot.positions[i * 3 + 0] = wx + v.localX * p.scale;
      slot.positions[i * 3 + 1] = p.baseY + v.localY * p.scale;
      slot.positions[i * 3 + 2] = 0;

      slot.colors[i * 3 + 0] = p.tint.r * dayMul;
      slot.colors[i * 3 + 1] = p.tint.g * dayMul;
      slot.colors[i * 3 + 2] = p.tint.b * dayMul;
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

function colorFromBiomeBand(groundDay: THREE.Color, band: SpriteBand, rand: () => number): THREE.Color {
  const c = new THREE.Color().copy(groundDay);
  const baseMul = band.layer === 'foreground' ? 0.48 : 0.62;
  const v = 0.88 + rand() * 0.28;
  return c.multiplyScalar(baseMul * v);
}

function hashBiomeKey(id: string, side: number, kind: LayerKind | 'village'): number {
  let h = 0;
  const s = `${id}|${side}|${kind}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
