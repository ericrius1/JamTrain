import * as THREE from 'three/webgpu';
import { Fn, attribute, texture } from 'three/tsl';
import { SpriteAtlas, type AtlasEntry, type AtlasId } from './spriteAtlas';
import type { BiomeScheduler, MagicEvent, TimeOfDay } from './biomes';
import { mulberry32 } from './seedRandom';

const SKY_WIDTH = 7.6;
const HALF_WIDTH = SKY_WIDTH * 0.5;
const CLOUDS_PER_SIDE = 14;
const BIRDS_PER_SIDE = 18;
const FIREFLIES_PER_SIDE = 30;

interface SpriteLayer {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  side: number;
  capacity: number;
  positions: Float32Array;
  atlasUvs: Float32Array;
  tints: Float32Array;
  fades: Float32Array;
  positionAttr: THREE.BufferAttribute;
  atlasAttr: THREE.BufferAttribute;
  tintAttr: THREE.BufferAttribute;
  fadeAttr: THREE.BufferAttribute;
}

interface CloudData {
  baseX: number;
  baseY: number;
  scale: number;
  speed: number;
  variant: 0 | 1 | 2;
}

interface BirdData {
  baseY: number;
  amp: number;
  freq: number;
  speed: number;
  spawnPhase: number;
  flapHz: number;
  scale: number;
}

export class SkyLife {
  private root = new THREE.Group();
  private cloudLayer!: SpriteLayer;
  private birdLayer!: SpriteLayer;
  private magicLayer!: SpriteLayer;
  private fireflyPoints!: { points: THREE.Points; geometry: THREE.BufferGeometry; material: THREE.PointsMaterial; positions: Float32Array; velocities: Float32Array };
  private clouds: CloudData[] = [];
  private birds: BirdData[] = [];
  private elapsedSeconds = 0;

  constructor(
    private scene: THREE.Scene,
    private atlas: SpriteAtlas,
    private scheduler: BiomeScheduler,
    private seed: number,
    private getEpochSeconds: () => number,
  ) {}

  build(): void {
    this.root.name = 'sky-life';
    for (const side of [-1]) {
      this.cloudLayer = this.createSpriteLayer(side, CLOUDS_PER_SIDE, side * 2.42, 0);
      this.birdLayer = this.createSpriteLayer(side, BIRDS_PER_SIDE, side * 2.36, 1);
      this.magicLayer = this.createSpriteLayer(side, 4, side * 2.40, 2);
      this.fireflyPoints = this.createFireflies(side);
    }
    this.spawnClouds();
    this.spawnBirds();
    this.scene.add(this.root);
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.spawnClouds();
    this.spawnBirds();
  }

  update(
    delta: number,
    ctx: {
      daylight: number;
      goldenHour: number;
      cloudCover: number;
      rainAmount: number;
      phase: TimeOfDay;
      currentForegroundId: string;
    },
  ): void {
    this.elapsedSeconds += delta;
    this.updateClouds(ctx);
    this.updateBirds(ctx);
    this.updateFireflies(delta, ctx);
    this.updateMagic(ctx);
  }

  private createSpriteLayer(side: number, capacity: number, x: number, renderOrder: number): SpriteLayer {
    const positions = new Float32Array(capacity * 4 * 3);
    const atlasUvs = new Float32Array(capacity * 4 * 2);
    const tints = new Float32Array(capacity * 4 * 3);
    const fades = new Float32Array(capacity * 4);
    const indices = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i += 1) {
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
    atlasAttr.setUsage(THREE.DynamicDrawUsage);
    tintAttr.setUsage(THREE.DynamicDrawUsage);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('aAtlasUv', atlasAttr);
    geometry.setAttribute('aTint', tintAttr);
    geometry.setAttribute('aFade', fadeAttr);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_WIDTH);
    geometry.computeBoundingSphere = () => {
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_WIDTH);
    };

    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    material.alphaTest = 0.05;
    material.colorNode = Fn(() => attribute('aTint', 'vec3' as const))();
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
    mesh.renderOrder = -25 + renderOrder;
    this.root.add(mesh);

    return { mesh, geometry, side, capacity, positions, atlasUvs, tints, fades, positionAttr, atlasAttr, tintAttr, fadeAttr };
  }

  private spawnClouds(): void {
    this.clouds = [];
    const rand = mulberry32(this.seed ^ 0xc10ddd);
    for (let i = 0; i < CLOUDS_PER_SIDE; i += 1) {
      this.clouds.push({
        baseX: (rand() - 0.5) * SKY_WIDTH,
        baseY: 1.7 + rand() * 0.7,
        scale: 0.7 + rand() * 0.7,
        speed: 0.08 + rand() * 0.12,
        variant: Math.floor(rand() * 3) as 0 | 1 | 2,
      });
    }
  }

  private spawnBirds(): void {
    this.birds = [];
    const rand = mulberry32(this.seed ^ 0xb12d5);
    for (let i = 0; i < BIRDS_PER_SIDE; i += 1) {
      this.birds.push({
        baseY: 1.5 + rand() * 0.7,
        amp: 0.05 + rand() * 0.15,
        freq: 0.4 + rand() * 0.6,
        speed: 0.45 + rand() * 0.35,
        spawnPhase: rand() * 1000,
        flapHz: 4 + rand() * 4,
        scale: 0.18 + rand() * 0.12,
      });
    }
  }

  private updateClouds(ctx: { daylight: number; goldenHour: number; cloudCover: number; rainAmount: number }): void {
    const cloudIds: AtlasId[] = ['cloudSmall', 'cloudMed', 'cloudLarge'];
    const baseTint = new THREE.Color();
    const sunsetTint = new THREE.Color(0xffc59a);
    const greyTint = new THREE.Color(0x808898);
    const whiteTint = new THREE.Color(0xffffff);
    const opacityMul = Math.min(1, 0.30 + ctx.cloudCover * 1.0);

    for (let i = 0; i < this.cloudLayer.capacity; i += 1) {
      const cloud = this.clouds[i];
      if (!cloud) {
        this.writeFade(this.cloudLayer, i, 0);
        continue;
      }
      let x = cloud.baseX + cloud.speed * this.elapsedSeconds;
      x = ((x + HALF_WIDTH) % SKY_WIDTH + SKY_WIDTH) % SKY_WIDTH - HALF_WIDTH;
      baseTint.copy(whiteTint).lerp(sunsetTint, ctx.goldenHour * 0.7);
      baseTint.lerp(greyTint, Math.min(1, ctx.rainAmount * 1.4));
      baseTint.multiplyScalar(0.6 + ctx.daylight * 0.4);
      const entry = this.atlas.entries[cloudIds[cloud.variant]];
      this.writeSprite(this.cloudLayer, i, x, cloud.baseY, cloud.scale, entry, baseTint, opacityMul, 'center');
    }
    this.markLayerDirty(this.cloudLayer);
  }

  private updateBirds(ctx: { phase: TimeOfDay; daylight: number; currentForegroundId: string }): void {
    const fgScheduler = this.scheduler.foreground();
    const fg = fgScheduler.t < 0.5 ? fgScheduler.from : fgScheduler.to;
    const palette = fg.birdPalette;
    const enabledCount = Math.max(0, Math.min(this.birdLayer.capacity, Math.round(BIRDS_PER_SIDE * fg.birdBias)));
    const tint = new THREE.Color(palette === 'seabird' ? 0xefefe6 : 0x12161c);
    const nightFade = ctx.daylight * 0.5 + 0.25;

    for (let i = 0; i < this.birdLayer.capacity; i += 1) {
      const bird = this.birds[i];
      if (!bird || i >= enabledCount) {
        this.writeFade(this.birdLayer, i, 0);
        continue;
      }
      const t = this.elapsedSeconds * bird.speed + bird.spawnPhase;
      let x = t;
      x = ((x + HALF_WIDTH) % SKY_WIDTH + SKY_WIDTH) % SKY_WIDTH - HALF_WIDTH;
      const y = bird.baseY + Math.sin(t * bird.freq) * bird.amp;
      const frame = Math.floor(this.elapsedSeconds * bird.flapHz) % 3;
      const ids: AtlasId[] = palette === 'seabird'
        ? ['seabirdA', 'seabirdB', 'seabirdC']
        : ['birdA', 'birdB', 'birdC'];
      const entry = this.atlas.entries[ids[frame]];
      this.writeSprite(this.birdLayer, i, x, y, bird.scale, entry, tint, nightFade, 'center');
    }
    this.markLayerDirty(this.birdLayer);
  }

  private createFireflies(side: number) {
    const cap = FIREFLIES_PER_SIDE;
    const positions = new Float32Array(cap * 3);
    const velocities = new Float32Array(cap * 3);
    for (let i = 0; i < cap; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * SKY_WIDTH * 0.8;
      positions[i * 3 + 1] = 0.95 + Math.random() * 0.40;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xffd58a,
      size: 0.025,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.rotation.y = Math.PI / 2;
    points.position.set(side * 2.08, 0, 0);
    points.renderOrder = -8;
    this.root.add(points);
    return { points, geometry, material, positions, velocities };
  }

  private updateFireflies(delta: number, ctx: { currentForegroundId: string; daylight: number }): void {
    const enabled = ctx.currentForegroundId === 'meadow' && ctx.daylight < 0.45;
    const desired = enabled ? 0.85 : 0;
    const fp = this.fireflyPoints;
    fp.material.opacity = fp.material.opacity + (desired - fp.material.opacity) * 0.04;
    if (fp.material.opacity < 0.01) return;
    const positions = fp.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < FIREFLIES_PER_SIDE; i += 1) {
      fp.velocities[i * 3]     += (Math.random() - 0.5) * delta * 0.4;
      fp.velocities[i * 3 + 1] += (Math.random() - 0.5) * delta * 0.3;
      fp.velocities[i * 3]     *= 0.94;
      fp.velocities[i * 3 + 1] *= 0.94;
      fp.positions[i * 3]     += fp.velocities[i * 3] * delta;
      fp.positions[i * 3 + 1] += fp.velocities[i * 3 + 1] * delta;
      if (fp.positions[i * 3] > SKY_WIDTH * 0.4) fp.positions[i * 3] = SKY_WIDTH * 0.4;
      if (fp.positions[i * 3] < -SKY_WIDTH * 0.4) fp.positions[i * 3] = -SKY_WIDTH * 0.4;
      if (fp.positions[i * 3 + 1] < 0.85) fp.positions[i * 3 + 1] = 0.85;
      if (fp.positions[i * 3 + 1] > 1.5) fp.positions[i * 3 + 1] = 1.5;
      positions.setXYZ(i, fp.positions[i * 3], fp.positions[i * 3 + 1], 0);
    }
    positions.needsUpdate = true;
  }

  private updateMagic(ctx: { goldenHour: number }): void {
    for (let i = 0; i < this.magicLayer.capacity; i += 1) this.writeFade(this.magicLayer, i, 0);
    const now = this.getEpochSeconds();
    const events = this.scheduler.magicAt(now);
    let slot = 0;
    for (const ev of events) {
      if (slot >= this.magicLayer.capacity) break;
      const localT = ev.duration > 0 ? Math.max(0, Math.min(1, (now - ev.startTime) / ev.duration)) : 0;
      this.renderMagic(slot, ev, localT, ctx);
      slot += 1;
    }
    this.markLayerDirty(this.magicLayer);
  }

  private renderMagic(slot: number, ev: MagicEvent, t: number, ctx: { goldenHour: number }): void {
    const layer = this.magicLayer;
    const rand = mulberry32(ev.seed);
    if (ev.kind === 'shootingStar') {
      const startX = (rand() - 0.5) * SKY_WIDTH * 0.6 + SKY_WIDTH * 0.25;
      const startY = 2.2 + rand() * 0.4;
      const x = startX + (-1.4) * t;
      const y = startY + (-0.5) * t;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      const tint = new THREE.Color(0xfff4d6);
      this.writeSprite(layer, slot, x, y, 0.6, this.atlas.entries.shootingStarTrail, tint, Math.max(0, fade), 'center');
    } else if (ev.kind === 'balloon') {
      const baseY = 1.6 + rand() * 0.4;
      const x = (rand() - 0.5) * SKY_WIDTH * 0.4 + Math.sin(t * 0.6) * 0.2;
      const fade = t < 0.05 ? t / 0.05 : t > 0.95 ? (1 - t) / 0.05 : 1;
      const tint = new THREE.Color(0xfff0d8).lerp(new THREE.Color(0xff9b78), ctx.goldenHour * 0.7);
      this.writeSprite(layer, slot, x, baseY + Math.sin(t * 1.1) * 0.05, 0.4, this.atlas.entries.hotAirBalloon, tint, fade, 'center');
    } else if (ev.kind === 'whale') {
      const x = (rand() - 0.5) * SKY_WIDTH * 0.4;
      const y = 0.55;
      if (t < 0.6) {
        const localT = t / 0.6;
        const fade = localT < 0.2 ? localT / 0.2 : 1 - (localT - 0.2) / 0.8;
        this.writeSprite(layer, slot, x, y, 0.36, this.atlas.entries.whaleSpout, new THREE.Color(0xddeef5), Math.max(0, fade), 'bottom');
      } else {
        const localT = (t - 0.6) / 0.4;
        const fade = 1 - localT;
        this.writeSprite(layer, slot, x + 0.4, y, 0.32, this.atlas.entries.whaleTail, new THREE.Color(0x202830), Math.max(0, fade), 'bottom');
      }
    } else if (ev.kind === 'plane') {
      const x = -SKY_WIDTH * 0.45 + t * SKY_WIDTH * 0.9;
      const y = 2.0 + Math.sin(t * 6) * 0.05;
      const blink = Math.sin(this.elapsedSeconds * 6) * 0.5 + 0.5;
      const tint = new THREE.Color(0xff8a8a).multiplyScalar(blink);
      this.writeSprite(layer, slot, x, y, 0.05, this.atlas.entries.cloudSmall, tint, 0.85, 'center');
    }
  }

  private writeSprite(
    layer: SpriteLayer,
    index: number,
    originX: number,
    originY: number,
    scale: number,
    entry: AtlasEntry,
    tint: THREE.Color,
    fade: number,
    anchor: 'center' | 'bottom',
  ): void {
    const v = index * 4;
    const half = scale * 0.5;
    let yLo: number, yHi: number;
    if (anchor === 'center') {
      yLo = originY - half;
      yHi = originY + half;
    } else {
      yLo = originY;
      yHi = originY + scale;
    }
    const xLo = originX - half;
    const xHi = originX + half;
    layer.positions[(v + 0) * 3 + 0] = xLo; layer.positions[(v + 0) * 3 + 1] = yLo;
    layer.positions[(v + 1) * 3 + 0] = xHi; layer.positions[(v + 1) * 3 + 1] = yLo;
    layer.positions[(v + 2) * 3 + 0] = xHi; layer.positions[(v + 2) * 3 + 1] = yHi;
    layer.positions[(v + 3) * 3 + 0] = xLo; layer.positions[(v + 3) * 3 + 1] = yHi;

    const { rect } = entry;
    layer.atlasUvs[(v + 0) * 2 + 0] = rect.x; layer.atlasUvs[(v + 0) * 2 + 1] = rect.w;
    layer.atlasUvs[(v + 1) * 2 + 0] = rect.z; layer.atlasUvs[(v + 1) * 2 + 1] = rect.w;
    layer.atlasUvs[(v + 2) * 2 + 0] = rect.z; layer.atlasUvs[(v + 2) * 2 + 1] = rect.y;
    layer.atlasUvs[(v + 3) * 2 + 0] = rect.x; layer.atlasUvs[(v + 3) * 2 + 1] = rect.y;
    for (let c = 0; c < 4; c += 1) {
      layer.tints[(v + c) * 3 + 0] = tint.r;
      layer.tints[(v + c) * 3 + 1] = tint.g;
      layer.tints[(v + c) * 3 + 2] = tint.b;
      layer.fades[v + c] = fade;
    }
    layer.positionAttr.needsUpdate = true;
  }

  private writeFade(layer: SpriteLayer, index: number, fade: number): void {
    const v = index * 4;
    for (let c = 0; c < 4; c += 1) layer.fades[v + c] = fade;
  }

  private markLayerDirty(layer: SpriteLayer): void {
    layer.atlasAttr.needsUpdate = true;
    layer.tintAttr.needsUpdate = true;
    layer.fadeAttr.needsUpdate = true;
    layer.positionAttr.needsUpdate = true;
  }
}
