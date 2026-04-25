import * as THREE from 'three/webgpu';
import { Fn, attribute, texture, uniform } from 'three/tsl';
import { SpriteAtlas, type AtlasEntry, type AtlasId } from './spriteAtlas';
import {
  type BiomeScheduler,
  type ForegroundBiome,
  type ForegroundBiomeId,
  type SpriteBand,
} from './biomes';
import { streamFor } from './seedRandom';

const LAYER_WIDTH = 7.6;
const HALF_WIDTH = LAYER_WIDTH * 0.5;
const MAX_SPRITES_PER_LAYER = 220;

type LayerKind = 'foreground' | 'midground';

interface SpritePlacement {
  originX: number;       // strip-local x of the anchor
  baseY: number;         // world Y of anchor (after mesh offset)
  scale: number;         // sprite size in meters
  atlas: AtlasEntry;
  tint: THREE.Color;
}

interface LayerHandle {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  side: number;
  kind: LayerKind;
  scrollOffset: number;
  scrollSpeed: number;
  meshY: number;
  capacity: number;
  positions: Float32Array;
  atlasUvs: Float32Array;
  tints: Float32Array;
  fades: Float32Array;
  positionAttr: THREE.BufferAttribute;
  atlasAttr: THREE.BufferAttribute;
  tintAttr: THREE.BufferAttribute;
  fadeAttr: THREE.BufferAttribute;
  daylightUniform: ReturnType<typeof uniform>;
  placements: SpritePlacement[];
}

export class BiomeLayers {
  private layers: LayerHandle[] = [];
  private root = new THREE.Group();
  private currentBiomeId: ForegroundBiomeId | null = null;

  private villagePoints: Array<{
    points: THREE.Points;
    geometry: THREE.BufferGeometry;
    material: THREE.PointsMaterial;
    side: number;
    capacity: number;
  }> = [];

  constructor(
    private scene: THREE.Scene,
    private atlas: SpriteAtlas,
    private scheduler: BiomeScheduler,
    private seed: number,
  ) {}

  build(): void {
    this.root.name = 'biome-layers';
    for (const side of [-1]) {
      // Midground sits behind, foreground in front. mesh.position.y bumps the
      // anchor row up to silhouette nicely above the background hill peaks.
      this.layers.push(this.createLayer(side, 'midground',  0.55, side * 2.18, 0.55));
      this.layers.push(this.createLayer(side, 'foreground', 0.85, side * 2.10, 0.45));
      this.villagePoints.push(this.createVillageGroup(side));
    }
    const { from } = this.scheduler.foreground();
    this.repopulateAll(from);
    this.currentBiomeId = from.id;
    this.scene.add(this.root);
  }

  setSeed(seed: number): void {
    this.seed = seed;
  }

  update(delta: number, trainSpeed: number, ctx: { daylight: number; nightAmount: number }): void {
    const { from, to, t } = this.scheduler.foreground();
    const targetBiome = t < 0.5 ? from : to;
    if (targetBiome.id !== this.currentBiomeId) {
      this.repopulateAll(targetBiome);
      this.currentBiomeId = targetBiome.id;
    }

    for (const layer of this.layers) {
      layer.scrollOffset += delta * trainSpeed * layer.scrollSpeed;
      if (layer.scrollOffset > LAYER_WIDTH) layer.scrollOffset -= LAYER_WIDTH;
      layer.daylightUniform.value = ctx.daylight;
      this.bakePositions(layer);
    }

    for (const vg of this.villagePoints) {
      const desired = targetBiome.villageLights ? targetBiome.villageLights.density * ctx.nightAmount : 0;
      vg.material.opacity = vg.material.opacity + (desired - vg.material.opacity) * 0.06;
    }
  }

  private createLayer(side: number, kind: LayerKind, scrollSpeed: number, x: number, meshY: number): LayerHandle {
    const cap = MAX_SPRITES_PER_LAYER;
    const positions = new Float32Array(cap * 4 * 3);
    const atlasUvs = new Float32Array(cap * 4 * 2);
    const tints = new Float32Array(cap * 4 * 3);
    const fades = new Float32Array(cap * 4);
    const indices = new Uint16Array(cap * 6);

    for (let i = 0; i < cap; i += 1) {
      const v = i * 4;
      const baseIdx = i * 6;
      indices[baseIdx + 0] = v + 0;
      indices[baseIdx + 1] = v + 1;
      indices[baseIdx + 2] = v + 2;
      indices[baseIdx + 3] = v + 0;
      indices[baseIdx + 4] = v + 2;
      indices[baseIdx + 5] = v + 3;
    }

    const positionAttr = new THREE.BufferAttribute(positions, 3);
    const atlasAttr = new THREE.BufferAttribute(atlasUvs, 2);
    const tintAttr = new THREE.BufferAttribute(tints, 3);
    const fadeAttr = new THREE.BufferAttribute(fades, 1);
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    atlasAttr.setUsage(THREE.DynamicDrawUsage);
    tintAttr.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('aAtlasUv', atlasAttr);
    geometry.setAttribute('aTint', tintAttr);
    geometry.setAttribute('aFade', fadeAttr);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LAYER_WIDTH);
    geometry.computeBoundingSphere = () => {
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LAYER_WIDTH);
    };

    const daylightUniform = uniform(1);

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    material.alphaTest = 0.05;

    material.colorNode = Fn(() => {
      const tint = attribute('aTint', 'vec3' as const);
      const dayMul = daylightUniform.mul(0.6).add(0.4);
      return tint.mul(dayMul);
    })();

    material.opacityNode = Fn(() => {
      const atlasUvAttr = attribute('aAtlasUv', 'vec2' as const);
      const sample = texture(this.atlas.texture, atlasUvAttr);
      const fade = attribute('aFade', 'float' as const);
      return sample.a.mul(fade);
    })();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(x, meshY, 0);
    mesh.renderOrder = -15 + (kind === 'foreground' ? 1 : 0);
    this.root.add(mesh);

    return {
      mesh, geometry, side, kind,
      scrollOffset: 0, scrollSpeed, meshY,
      capacity: cap,
      positions, atlasUvs, tints, fades,
      positionAttr, atlasAttr, tintAttr, fadeAttr,
      daylightUniform,
      placements: [],
    };
  }

  private repopulateAll(biome: ForegroundBiome): void {
    for (const layer of this.layers) this.populateLayer(layer, biome);
    for (const vg of this.villagePoints) this.populateVillage(vg, biome);
  }

  private populateLayer(layer: LayerHandle, biome: ForegroundBiome): void {
    layer.placements = [];
    const seedKey = hashBiomeKey(biome.id, layer.side, layer.kind);
    const rand = streamFor(this.seed, seedKey);
    const groundColor = new THREE.Color(biome.groundColor.day);

    let count = 0;
    for (const band of biome.sprites) {
      if (band.layer !== layer.kind) continue;
      const bandCount = Math.min(layer.capacity - count, Math.floor(band.density * LAYER_WIDTH));
      const entry = this.atlas.entries[band.atlas];
      for (let i = 0; i < bandCount; i += 1) {
        const originX = (rand() - 0.5) * LAYER_WIDTH;
        const baseY = (rand() - 0.5) * band.yJitter;
        const scale = band.sizeRange[0] + rand() * (band.sizeRange[1] - band.sizeRange[0]);
        layer.placements.push({
          originX, baseY, scale, atlas: entry,
          tint: colorFromBiomeBand(groundColor, band, rand),
        });
        count += 1;
        if (count >= layer.capacity) break;
      }
    }

    // Write atlas UVs, tints, fades. Positions are written each frame via bakePositions.
    for (let i = 0; i < layer.capacity; i += 1) {
      const v = i * 4;
      const p = layer.placements[i];
      if (!p) {
        for (let c = 0; c < 4; c += 1) layer.fades[v + c] = 0;
        continue;
      }
      const { rect } = p.atlas;
      // UVs: corners (-.5,0)→(u0,v1), (+.5,0)→(u1,v1), (+.5,+1)→(u1,v0), (-.5,+1)→(u0,v0)
      layer.atlasUvs[(v + 0) * 2 + 0] = rect.x; layer.atlasUvs[(v + 0) * 2 + 1] = rect.w;
      layer.atlasUvs[(v + 1) * 2 + 0] = rect.z; layer.atlasUvs[(v + 1) * 2 + 1] = rect.w;
      layer.atlasUvs[(v + 2) * 2 + 0] = rect.z; layer.atlasUvs[(v + 2) * 2 + 1] = rect.y;
      layer.atlasUvs[(v + 3) * 2 + 0] = rect.x; layer.atlasUvs[(v + 3) * 2 + 1] = rect.y;
      for (let c = 0; c < 4; c += 1) {
        layer.tints[(v + c) * 3 + 0] = p.tint.r;
        layer.tints[(v + c) * 3 + 1] = p.tint.g;
        layer.tints[(v + c) * 3 + 2] = p.tint.b;
        layer.fades[v + c] = 1;
      }
    }
    layer.atlasAttr.needsUpdate = true;
    layer.tintAttr.needsUpdate = true;
    layer.fadeAttr.needsUpdate = true;
  }

  private bakePositions(layer: LayerHandle): void {
    const positions = layer.positions;
    const scroll = layer.scrollOffset;
    for (let i = 0; i < layer.capacity; i += 1) {
      const v = i * 4;
      const p = layer.placements[i];
      if (!p) {
        // collapse degenerate quad to (0,0,0)
        for (let c = 0; c < 4; c += 1) {
          positions[(v + c) * 3 + 0] = 0;
          positions[(v + c) * 3 + 1] = 0;
          positions[(v + c) * 3 + 2] = 0;
        }
        continue;
      }
      // Wrap origin within strip
      let wx = p.originX - scroll;
      wx = ((wx + HALF_WIDTH) % LAYER_WIDTH + LAYER_WIDTH) % LAYER_WIDTH - HALF_WIDTH;
      const half = p.scale * 0.5;
      // Anchor: bottom-center. Corners (in strip-local: x, y, z=0):
      // (-half, 0), (+half, 0), (+half, scale), (-half, scale)
      positions[(v + 0) * 3 + 0] = wx - half; positions[(v + 0) * 3 + 1] = p.baseY;
      positions[(v + 1) * 3 + 0] = wx + half; positions[(v + 1) * 3 + 1] = p.baseY;
      positions[(v + 2) * 3 + 0] = wx + half; positions[(v + 2) * 3 + 1] = p.baseY + p.scale;
      positions[(v + 3) * 3 + 0] = wx - half; positions[(v + 3) * 3 + 1] = p.baseY + p.scale;
    }
    layer.positionAttr.needsUpdate = true;
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
    points.position.set(side * 2.10, 0.55, 0);
    points.renderOrder = -10;
    this.root.add(points);
    return { points, geometry, material, side, capacity: cap };
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
    const rand = streamFor(this.seed, hashBiomeKey(biome.id, vg.side, 'village' as LayerKind));
    const tightness = biome.villageLights.clusterTightness;
    let cursor = 0;
    const clusters = 2 + Math.floor(rand() * 3);
    for (let c = 0; c < clusters && cursor < vg.capacity; c += 1) {
      const cx = (rand() - 0.5) * (LAYER_WIDTH - 1.0);
      const cy = 0.05 + rand() * 0.10;
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

function colorFromBiomeBand(groundDay: THREE.Color, _band: SpriteBand, rand: () => number): THREE.Color {
  const c = new THREE.Color().copy(groundDay).multiplyScalar(0.30);
  const v = 0.85 + rand() * 0.30;
  return c.multiplyScalar(v);
}

function hashBiomeKey(id: string, side: number, kind: LayerKind | 'village'): number {
  let h = 0;
  const s = `${id}|${side}|${kind}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
