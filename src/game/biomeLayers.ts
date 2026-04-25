import * as THREE from 'three/webgpu';
import { Fn, attribute, fract, texture, uniform, vec3 } from 'three/tsl';
import { SpriteAtlas, type AtlasEntry, type AtlasId } from './spriteAtlas';
import {
  type BiomeScheduler,
  type ForegroundBiome,
  type ForegroundBiomeId,
  type SpriteBand,
} from './biomes';
import { streamFor } from './seedRandom';

const LAYER_WIDTH = 7.6;
const MAX_SPRITES_PER_LAYER = 220;

type LayerKind = 'foreground' | 'midground';

interface LayerHandle {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  side: number;
  kind: LayerKind;
  scrollOffset: number;
  scrollSpeed: number;
  scrollUniform: ReturnType<typeof uniform>;
  daylightUniform: ReturnType<typeof uniform>;
  // Per-vertex buffers — written into in-place per biome change.
  positions: Float32Array;       // vec3 — quad corner relative offset (-0.5..0.5 in x/y for the unit quad after anchor)
  origins: Float32Array;          // vec3 — sprite origin in strip-local space (one origin shared by all 4 verts of a quad)
  scales: Float32Array;           // float
  atlasUvs: Float32Array;         // vec2
  tints: Float32Array;            // vec3
  fades: Float32Array;            // float
  capacity: number;
}

export class BiomeLayers {
  private layers: LayerHandle[] = [];
  private root = new THREE.Group();
  private currentBiomeId: ForegroundBiomeId | null = null;

  // Village clusters (additive points)
  private villagePoints: Array<{
    points: THREE.Points;
    geometry: THREE.BufferGeometry;
    material: THREE.PointsMaterial;
    side: number;
    capacity: number;
    activeCount: number;
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
      // Midground panel (back), foreground panel (front).
      this.layers.push(this.createLayer(side, 'midground', 0.62, side * 2.18));
      this.layers.push(this.createLayer(side, 'foreground', 0.92, side * 2.10));
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

    // Pick the biome that is "more present" right now (snap on completion).
    const targetBiome = t < 0.5 ? from : to;
    if (targetBiome.id !== this.currentBiomeId) {
      this.repopulateAll(targetBiome);
      this.currentBiomeId = targetBiome.id;
    }

    for (const layer of this.layers) {
      layer.scrollOffset += delta * trainSpeed * layer.scrollSpeed;
      // Wrap to keep numbers small.
      if (layer.scrollOffset > LAYER_WIDTH) layer.scrollOffset -= LAYER_WIDTH;
      layer.scrollUniform.value = layer.scrollOffset;
      layer.daylightUniform.value = ctx.daylight;
    }

    // Village light opacity
    for (const vg of this.villagePoints) {
      const biome = targetBiome;
      const desired = biome.villageLights ? biome.villageLights.density * ctx.nightAmount : 0;
      const easing = 0.06;
      vg.material.opacity = vg.material.opacity + (desired - vg.material.opacity) * easing;
    }
  }

  private createLayer(side: number, kind: LayerKind, scrollSpeed: number, x: number): LayerHandle {
    const cap = MAX_SPRITES_PER_LAYER;
    const positions = new Float32Array(cap * 4 * 3);
    const origins = new Float32Array(cap * 4 * 3);
    const scales = new Float32Array(cap * 4);
    const atlasUvs = new Float32Array(cap * 4 * 2);
    const tints = new Float32Array(cap * 4 * 3);
    const fades = new Float32Array(cap * 4);
    const indices = new Uint16Array(cap * 6);

    // Fill quad corner positions and indices once.
    for (let i = 0; i < cap; i += 1) {
      const v = i * 4;
      // Corner offsets (anchor: bottom-center). Quad: (-0.5,0), (+0.5,0), (+0.5,+1), (-0.5,+1)
      positions[(v + 0) * 3 + 0] = -0.5; positions[(v + 0) * 3 + 1] = 0.0; positions[(v + 0) * 3 + 2] = 0;
      positions[(v + 1) * 3 + 0] = +0.5; positions[(v + 1) * 3 + 1] = 0.0; positions[(v + 1) * 3 + 2] = 0;
      positions[(v + 2) * 3 + 0] = +0.5; positions[(v + 2) * 3 + 1] = 1.0; positions[(v + 2) * 3 + 2] = 0;
      positions[(v + 3) * 3 + 0] = -0.5; positions[(v + 3) * 3 + 1] = 1.0; positions[(v + 3) * 3 + 2] = 0;

      const baseIdx = i * 6;
      indices[baseIdx + 0] = v + 0;
      indices[baseIdx + 1] = v + 1;
      indices[baseIdx + 2] = v + 2;
      indices[baseIdx + 3] = v + 0;
      indices[baseIdx + 4] = v + 2;
      indices[baseIdx + 5] = v + 3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origins, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aAtlasUv', new THREE.BufferAttribute(atlasUvs, 2));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 3));
    geometry.setAttribute('aFade', new THREE.BufferAttribute(fades, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere = () => {
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LAYER_WIDTH);
    };
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), LAYER_WIDTH);

    const scrollUniform = uniform(0);
    const daylightUniform = uniform(1);
    const halfWidth = uniform(LAYER_WIDTH * 0.5);
    const layerWidth = uniform(LAYER_WIDTH);

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;

    material.positionNode = Fn(() => {
      const localPos = attribute('position', 'vec3' as const);
      const origin = attribute('aOrigin', 'vec3' as const);
      const scale = attribute('aScale', 'float' as const);

      // Quad in strip-local space, anchored at origin.xy.
      const quadX = origin.x.add(localPos.x.mul(scale));
      const quadY = origin.y.add(localPos.y.mul(scale));

      // Apply scrolling along strip with wrap.
      // (((x - scroll) + W/2) mod W) - W/2 keeps content centered while scrolling.
      const shifted = quadX.sub(scrollUniform).add(halfWidth);
      const wrapped = fract(shifted.div(layerWidth)).mul(layerWidth).sub(halfWidth);

      return vec3(wrapped, quadY, 0);
    })();

    material.colorNode = Fn(() => {
      const tint = attribute('aTint', 'vec3' as const);
      const dayMul = daylightUniform.mul(0.55).add(0.45);
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
    mesh.position.set(x, 0, 0);
    mesh.renderOrder = -15 + (kind === 'foreground' ? 1 : 0);
    this.root.add(mesh);

    return {
      mesh, geometry, side, kind,
      scrollOffset: 0, scrollSpeed,
      scrollUniform, daylightUniform,
      positions, origins, scales, atlasUvs, tints, fades,
      capacity: cap,
    };
  }

  private repopulateAll(biome: ForegroundBiome): void {
    for (const layer of this.layers) this.populateLayer(layer, biome);
    for (const vg of this.villagePoints) this.populateVillage(vg, biome);
  }

  private populateLayer(layer: LayerHandle, biome: ForegroundBiome): void {
    // Reset all fades to 0 first.
    for (let i = 0; i < layer.capacity * 4; i += 1) layer.fades[i] = 0;

    const seedKey = hashBiomeKey(biome.id, layer.side, layer.kind);
    const rand = streamFor(this.seed, seedKey);

    let cursor = 0;
    const groundColor = new THREE.Color(biome.groundColor.day);
    for (const band of biome.sprites) {
      if (band.layer !== layer.kind) continue;
      const count = Math.min(layer.capacity - cursor, Math.floor(band.density * LAYER_WIDTH));
      const entry = this.atlas.entries[band.atlas];
      for (let i = 0; i < count; i += 1) {
        const x = (rand() - 0.5) * LAYER_WIDTH;
        const y = biome.ridge.baseY + (rand() - 0.5) * band.yJitter;
        const scale = band.sizeRange[0] + rand() * (band.sizeRange[1] - band.sizeRange[0]);
        const tint = colorFromBiomeBand(groundColor, band, rand);
        writeSprite(layer, cursor, x, y, scale, entry, tint);
        cursor += 1;
        if (cursor >= layer.capacity) break;
      }
    }

    (layer.geometry.getAttribute('aOrigin') as THREE.BufferAttribute).needsUpdate = true;
    (layer.geometry.getAttribute('aScale') as THREE.BufferAttribute).needsUpdate = true;
    (layer.geometry.getAttribute('aAtlasUv') as THREE.BufferAttribute).needsUpdate = true;
    (layer.geometry.getAttribute('aTint') as THREE.BufferAttribute).needsUpdate = true;
    (layer.geometry.getAttribute('aFade') as THREE.BufferAttribute).needsUpdate = true;
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
    return { points, geometry, material, side, capacity: cap, activeCount: 0 };
  }

  private populateVillage(
    vg: { points: THREE.Points; geometry: THREE.BufferGeometry; activeCount: number; capacity: number; side: number },
    biome: ForegroundBiome,
  ): void {
    const positions = vg.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!biome.villageLights) {
      vg.activeCount = 0;
      vg.geometry.setDrawRange(0, 0);
      return;
    }
    const rand = streamFor(this.seed, hashBiomeKey(biome.id, vg.side, 'village' as LayerKind));
    const tightness = biome.villageLights.clusterTightness;
    let cursor = 0;
    const clusters = 2 + Math.floor(rand() * 3);
    for (let c = 0; c < clusters && cursor < vg.capacity; c += 1) {
      const cx = (rand() - 0.5) * (LAYER_WIDTH - 1.0);
      const cy = biome.ridge.baseY + 0.04 + rand() * 0.05;
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
    vg.activeCount = cursor;
    vg.geometry.setDrawRange(0, cursor);
    positions.needsUpdate = true;
  }
}

function writeSprite(
  layer: LayerHandle,
  index: number,
  originX: number,
  originY: number,
  scale: number,
  entry: AtlasEntry,
  tint: THREE.Color,
): void {
  const v = index * 4;
  for (let c = 0; c < 4; c += 1) {
    layer.origins[(v + c) * 3 + 0] = originX;
    layer.origins[(v + c) * 3 + 1] = originY;
    layer.origins[(v + c) * 3 + 2] = 0;
    layer.scales[v + c] = scale;
    layer.tints[(v + c) * 3 + 0] = tint.r;
    layer.tints[(v + c) * 3 + 1] = tint.g;
    layer.tints[(v + c) * 3 + 2] = tint.b;
    layer.fades[v + c] = 1;
  }
  // UVs map atlas rect to corners of the quad: position (-0.5,0), (+0.5,0), (+0.5,1), (-0.5,1)
  // → atlas (u0, v1), (u1, v1), (u1, v0), (u0, v0)  (V is flipped because canvas Y grows downward but UV grows up).
  const u0 = entry.rect.x, v0 = entry.rect.y, u1 = entry.rect.z, v1 = entry.rect.w;
  layer.atlasUvs[(v + 0) * 2 + 0] = u0; layer.atlasUvs[(v + 0) * 2 + 1] = v1;
  layer.atlasUvs[(v + 1) * 2 + 0] = u1; layer.atlasUvs[(v + 1) * 2 + 1] = v1;
  layer.atlasUvs[(v + 2) * 2 + 0] = u1; layer.atlasUvs[(v + 2) * 2 + 1] = v0;
  layer.atlasUvs[(v + 3) * 2 + 0] = u0; layer.atlasUvs[(v + 3) * 2 + 1] = v0;
}

function colorFromBiomeBand(groundDay: THREE.Color, _band: SpriteBand, rand: () => number): THREE.Color {
  // Silhouette tint: dark version of the biome's ground color, with mild per-instance variance.
  const c = new THREE.Color().copy(groundDay).multiplyScalar(0.32);
  const v = 0.85 + rand() * 0.30;
  return c.multiplyScalar(v);
}

function hashBiomeKey(id: string, side: number, kind: LayerKind | 'village'): number {
  let h = 0;
  const s = `${id}|${side}|${kind}`;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
