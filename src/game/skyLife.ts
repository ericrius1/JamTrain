import * as THREE from 'three/webgpu';
import { SpriteAtlas, type AtlasId } from './spriteAtlas';
import type { BiomeScheduler, MagicEvent, TimeOfDay } from './biomes';
import { mulberry32 } from './seedRandom';
import { appendSpriteShape, type ShapeBuffers } from './spriteShapes';

const SKY_WIDTH = 12.4;
const HALF_WIDTH = SKY_WIDTH * 0.5;
const CLOUDS_PER_SIDE = 22;
const BIRDS_PER_SIDE = 28;
const FIREFLIES_PER_SIDE = 48;

interface SpriteLayer {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  side: number;
  capacity: number;
  buffers: ShapeBuffers;
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
    _atlas: SpriteAtlas,
    private scheduler: BiomeScheduler,
    private seed: number,
    private getEpochSeconds: () => number,
  ) {}

  build(): void {
    this.root.name = 'sky-life';
    for (const side of [-1]) {
      this.cloudLayer = this.createSpriteLayer(side, CLOUDS_PER_SIDE, side * 2.42, -25);
      this.birdLayer = this.createSpriteLayer(side, BIRDS_PER_SIDE, side * 2.36, -24);
      this.magicLayer = this.createSpriteLayer(side, 4, side * 2.40, -23);
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
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    geometry.setIndex(null);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_WIDTH);
    geometry.computeBoundingSphere = () => {
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_WIDTH);
    };

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(x, 0, 0);
    mesh.renderOrder = renderOrder;
    this.root.add(mesh);

    return { mesh, geometry, material, side, capacity, buffers: emptyBuffers() };
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

    this.beginLayer(this.cloudLayer);
    for (let i = 0; i < this.cloudLayer.capacity; i += 1) {
      const cloud = this.clouds[i];
      if (!cloud) continue;
      let x = cloud.baseX + cloud.speed * this.elapsedSeconds;
      x = ((x + HALF_WIDTH) % SKY_WIDTH + SKY_WIDTH) % SKY_WIDTH - HALF_WIDTH;
      baseTint.copy(whiteTint).lerp(sunsetTint, ctx.goldenHour * 0.7);
      baseTint.lerp(greyTint, Math.min(1, ctx.rainAmount * 1.4));
      baseTint.multiplyScalar((0.6 + ctx.daylight * 0.4) * opacityMul);
      this.writeSprite(this.cloudLayer, x, cloud.baseY, cloud.scale, cloudIds[cloud.variant], baseTint, 'center');
    }
    this.endLayer(this.cloudLayer);
  }

  private updateBirds(ctx: { daylight: number; currentForegroundId: string; phase: TimeOfDay }): void {
    void ctx.currentForegroundId;
    void ctx.phase;
    const fgScheduler = this.scheduler.foreground();
    const fg = fgScheduler.t < 0.5 ? fgScheduler.from : fgScheduler.to;
    const palette = fg.birdPalette;
    const enabledCount = Math.max(0, Math.min(this.birdLayer.capacity, Math.round(BIRDS_PER_SIDE * fg.birdBias)));
    const tint = new THREE.Color(palette === 'seabird' ? 0xefefe6 : 0x12161c);
    const renderTint = tint.multiplyScalar(ctx.daylight * 0.5 + 0.30);

    this.beginLayer(this.birdLayer);
    for (let i = 0; i < this.birdLayer.capacity; i += 1) {
      const bird = this.birds[i];
      if (!bird || i >= enabledCount) continue;
      const t = this.elapsedSeconds * bird.speed + bird.spawnPhase;
      let x = t;
      x = ((x + HALF_WIDTH) % SKY_WIDTH + SKY_WIDTH) % SKY_WIDTH - HALF_WIDTH;
      const y = bird.baseY + Math.sin(t * bird.freq) * bird.amp;
      const frame = Math.floor(this.elapsedSeconds * bird.flapHz) % 3;
      const ids: AtlasId[] = palette === 'seabird'
        ? ['seabirdA', 'seabirdB', 'seabirdC']
        : ['birdA', 'birdB', 'birdC'];
      this.writeSprite(this.birdLayer, x, y, bird.scale, ids[frame], renderTint, 'center');
    }
    this.endLayer(this.birdLayer);
  }

  private createFireflies(side: number) {
    const cap = FIREFLIES_PER_SIDE;
    const positions = new Float32Array(cap * 3);
    const velocities = new Float32Array(cap * 3);
    const rand = mulberry32(this.seed ^ 0xf1ef1e);
    for (let i = 0; i < cap; i += 1) {
      positions[i * 3] = (rand() - 0.5) * SKY_WIDTH * 0.8;
      positions[i * 3 + 1] = 0.95 + rand() * 0.40;
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
      fp.velocities[i * 3] += (Math.random() - 0.5) * delta * 0.4;
      fp.velocities[i * 3 + 1] += (Math.random() - 0.5) * delta * 0.3;
      fp.velocities[i * 3] *= 0.94;
      fp.velocities[i * 3 + 1] *= 0.94;
      fp.positions[i * 3] += fp.velocities[i * 3] * delta;
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
    const now = this.getEpochSeconds();
    const events = this.scheduler.magicAt(now);
    let slot = 0;

    this.beginLayer(this.magicLayer);
    for (const ev of events) {
      if (slot >= this.magicLayer.capacity) break;
      const localT = ev.duration > 0 ? Math.max(0, Math.min(1, (now - ev.startTime) / ev.duration)) : 0;
      this.renderMagic(ev, localT, ctx);
      slot += 1;
    }
    this.endLayer(this.magicLayer);
  }

  private renderMagic(ev: MagicEvent, t: number, ctx: { goldenHour: number }): void {
    const rand = mulberry32(ev.seed);
    if (ev.kind === 'shootingStar') {
      const startX = (rand() - 0.5) * SKY_WIDTH * 0.6 + SKY_WIDTH * 0.25;
      const startY = 2.2 + rand() * 0.4;
      const x = startX + (-1.4) * t;
      const y = startY + (-0.5) * t;
      const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      const tint = new THREE.Color(0xfff4d6).multiplyScalar(Math.max(0, fade));
      this.writeSprite(this.magicLayer, x, y, 0.6, 'shootingStarTrail', tint, 'center');
    } else if (ev.kind === 'balloon') {
      const baseY = 1.6 + rand() * 0.4;
      const x = (rand() - 0.5) * SKY_WIDTH * 0.4 + Math.sin(t * 0.6) * 0.2;
      const fade = t < 0.05 ? t / 0.05 : t > 0.95 ? (1 - t) / 0.05 : 1;
      const tint = new THREE.Color(0xfff0d8).lerp(new THREE.Color(0xff9b78), ctx.goldenHour * 0.7).multiplyScalar(fade);
      this.writeSprite(this.magicLayer, x, baseY + Math.sin(t * 1.1) * 0.05, 0.4, 'hotAirBalloon', tint, 'center');
    } else if (ev.kind === 'whale') {
      const x = (rand() - 0.5) * SKY_WIDTH * 0.4;
      const y = 0.55;
      if (t < 0.6) {
        const localT = t / 0.6;
        const fade = localT < 0.2 ? localT / 0.2 : 1 - (localT - 0.2) / 0.8;
        const tint = new THREE.Color(0xddeef5).multiplyScalar(Math.max(0, fade));
        this.writeSprite(this.magicLayer, x, y, 0.36, 'whaleSpout', tint, 'bottom');
      } else {
        const localT = (t - 0.6) / 0.4;
        const fade = 1 - localT;
        const tint = new THREE.Color(0x202830).multiplyScalar(Math.max(0, fade));
        this.writeSprite(this.magicLayer, x + 0.4, y, 0.32, 'whaleTail', tint, 'bottom');
      }
    } else if (ev.kind === 'plane') {
      const x = -SKY_WIDTH * 0.45 + t * SKY_WIDTH * 0.9;
      const y = 2.0 + Math.sin(t * 6) * 0.05;
      const blink = Math.sin(this.elapsedSeconds * 6) * 0.5 + 0.5;
      const tint = new THREE.Color(0xff8a8a).multiplyScalar(blink);
      this.writeSprite(this.magicLayer, x, y, 0.05, 'cloudSmall', tint, 'center');
    }
  }

  private beginLayer(layer: SpriteLayer): void {
    layer.buffers = emptyBuffers();
  }

  private writeSprite(
    layer: SpriteLayer,
    originX: number,
    originY: number,
    scale: number,
    atlas: AtlasId,
    tint: THREE.Color,
    anchor: 'center' | 'bottom',
  ): void {
    appendSpriteShape(layer.buffers, atlas, originX, originY, scale, tint, anchor);
  }

  private endLayer(layer: SpriteLayer): void {
    layer.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(layer.buffers.positions), 3));
    layer.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(layer.buffers.colors), 3));
    layer.geometry.setIndex(null);
    layer.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SKY_WIDTH);
  }
}

function emptyBuffers(): ShapeBuffers {
  return { positions: [], colors: [] };
}
