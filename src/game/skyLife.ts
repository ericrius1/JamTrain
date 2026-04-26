import * as THREE from 'three/webgpu';
import { SpriteAtlas, type AtlasId } from './spriteAtlas';
import type { BiomeScheduler, MagicEvent, TimeOfDay } from './biomes';
import { mulberry32 } from './seedRandom';
import { appendSpriteShape, type ShapeBuffers } from './spriteShapes';

const SKY_WIDTH = 12.4;
const HALF_WIDTH = SKY_WIDTH * 0.5;
const CLOUDS_PER_SIDE = 22;
const FIREFLIES_PER_SIDE = 48;

const BIRD_LAYER_CAPACITY = 24;
const MAX_FLOCKS = 3;
const FLOCK_MIN_SIZE = 3;
const FLOCK_MAX_SIZE = 7;
const FLOCK_MIN_GAP_S = 6;
const FLOCK_MAX_GAP_S = 18;
const FLOCK_FIRST_SPAWN_S = 1.5;
const FLOCK_OFFSCREEN_BUFFER = 0.7;

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

interface Maneuver {
  startT: number;
  endT: number;
  kind: 'swoop' | 'loop';
  amp: number;
}

interface BirdData {
  formX: number;
  formY: number;
  flapHz: number;
  scale: number;
  swayAmp: number;
  swayFreq: number;
  swayPhase: number;
  maneuvers: Maneuver[];
}

interface Flock {
  startTime: number;
  duration: number;
  direction: 1 | -1;
  baseY: number;
  speed: number;
  palette: 'default' | 'seabird';
  birds: BirdData[];
}

export class SkyLife {
  private root = new THREE.Group();
  private cloudLayer!: SpriteLayer;
  private birdLayer!: SpriteLayer;
  private magicLayer!: SpriteLayer;
  private fireflyPoints!: { points: THREE.Points; geometry: THREE.BufferGeometry; material: THREE.PointsMaterial; positions: Float32Array; velocities: Float32Array };
  private clouds: CloudData[] = [];
  private flocks: Flock[] = [];
  private nextFlockAt = FLOCK_FIRST_SPAWN_S;
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
      this.birdLayer = this.createSpriteLayer(side, BIRD_LAYER_CAPACITY, side * 2.36, -24);
      this.magicLayer = this.createSpriteLayer(side, 4, side * 2.40, -23);
      this.fireflyPoints = this.createFireflies(side);
    }
    this.spawnClouds();
    this.scene.add(this.root);
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.spawnClouds();
    this.flocks = [];
    this.nextFlockAt = this.elapsedSeconds + FLOCK_FIRST_SPAWN_S;
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

  private createFlock(palette: 'default' | 'seabird'): Flock {
    const direction: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const speed = 0.55 + Math.random() * 0.45;
    const travel = SKY_WIDTH + FLOCK_OFFSCREEN_BUFFER * 2;
    const duration = travel / speed;
    const baseY = 1.45 + Math.random() * 0.65;
    const size = FLOCK_MIN_SIZE + Math.floor(Math.random() * (FLOCK_MAX_SIZE - FLOCK_MIN_SIZE + 1));
    const birds: BirdData[] = [];
    for (let i = 0; i < size; i += 1) {
      birds.push(this.createBird(i, duration));
    }
    return {
      startTime: this.elapsedSeconds,
      duration,
      direction,
      baseY,
      speed,
      palette,
      birds,
    };
  }

  private createBird(i: number, flockDuration: number): BirdData {
    const trail = i * (0.10 + Math.random() * 0.06) + Math.random() * 0.04;
    const lateralSign = i === 0 ? 0 : (i % 2 === 0 ? -1 : 1);
    const lateralMag = Math.floor((i + 1) / 2) * 0.05 + Math.random() * 0.04;
    const formX = -trail;
    const formY = lateralSign * lateralMag + (Math.random() - 0.5) * 0.04;
    const scale = 0.18 + Math.random() * 0.10;
    const flapHz = 4 + Math.random() * 4;
    const swayAmp = 0.04 + Math.random() * 0.07;
    const swayFreq = 0.6 + Math.random() * 0.9;
    const swayPhase = Math.random() * Math.PI * 2;

    const maneuvers: Maneuver[] = [];
    const roll = Math.random();
    const count = roll < 0.20 ? 0 : roll < 0.75 ? 1 : 2;
    let cursor = flockDuration * (0.15 + Math.random() * 0.20);
    for (let m = 0; m < count; m += 1) {
      const dur = 1.2 + Math.random() * 1.6;
      if (cursor + dur >= flockDuration * 0.92) break;
      const kind: Maneuver['kind'] = Math.random() < 0.55 ? 'swoop' : 'loop';
      const amp = kind === 'swoop' ? 0.22 + Math.random() * 0.20 : 0.10 + Math.random() * 0.08;
      maneuvers.push({ startT: cursor, endT: cursor + dur, kind, amp });
      cursor += dur + 1.2 + Math.random() * 2.0;
    }

    return { formX, formY, flapHz, scale, swayAmp, swayFreq, swayPhase, maneuvers };
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

    this.flocks = this.flocks.filter((f) => this.elapsedSeconds <= f.startTime + f.duration);
    this.maybeSpawnFlock(fg.birdBias, fg.birdPalette);

    this.beginLayer(this.birdLayer);
    for (const flock of this.flocks) {
      this.renderFlock(flock, ctx.daylight);
    }
    this.endLayer(this.birdLayer);
  }

  private maybeSpawnFlock(birdBias: number, palette: 'default' | 'seabird'): void {
    if (birdBias <= 0) return;
    if (this.elapsedSeconds < this.nextFlockAt) return;
    if (this.flocks.length >= MAX_FLOCKS) {
      this.nextFlockAt = this.elapsedSeconds + 1.5;
      return;
    }
    this.flocks.push(this.createFlock(palette));
    const baseGap = FLOCK_MIN_GAP_S + Math.random() * (FLOCK_MAX_GAP_S - FLOCK_MIN_GAP_S);
    const gap = baseGap / Math.max(0.25, birdBias);
    this.nextFlockAt = this.elapsedSeconds + gap;
  }

  private renderFlock(flock: Flock, daylight: number): void {
    const local = this.elapsedSeconds - flock.startTime;
    if (local < 0) return;
    const fadeIn = Math.min(1, local / 1.0);
    const fadeOut = Math.min(1, (flock.duration - local) / 1.2);
    const fade = Math.max(0, Math.min(fadeIn, fadeOut));
    if (fade <= 0) return;

    const progress = local / flock.duration;
    const startX = -flock.direction * (HALF_WIDTH + FLOCK_OFFSCREEN_BUFFER);
    const travel = SKY_WIDTH + FLOCK_OFFSCREEN_BUFFER * 2;
    const leadX = startX + flock.direction * progress * travel;

    const tint = new THREE.Color(flock.palette === 'seabird' ? 0xefefe6 : 0x12161c)
      .multiplyScalar(daylight * 0.5 + 0.30)
      .multiplyScalar(fade);

    const ids: AtlasId[] = flock.palette === 'seabird'
      ? ['seabirdA', 'seabirdB', 'seabirdC']
      : ['birdA', 'birdB', 'birdC'];

    for (const bird of flock.birds) {
      let bx = leadX + flock.direction * bird.formX;
      let by = flock.baseY + bird.formY;

      by += Math.sin(this.elapsedSeconds * bird.swayFreq + bird.swayPhase) * bird.swayAmp;
      bx += Math.cos(this.elapsedSeconds * bird.swayFreq * 0.7 + bird.swayPhase) * bird.swayAmp * 0.4 * flock.direction;

      const m = this.computeManeuver(bird, local, flock.direction);
      bx += m.dx;
      by += m.dy;

      const flapMul = m.kind === 'swoop' ? 1.6 : m.kind === 'loop' ? 1.9 : 1.0;
      const frame = Math.floor(this.elapsedSeconds * bird.flapHz * flapMul) % 3;
      this.writeSprite(this.birdLayer, bx, by, bird.scale, ids[frame], tint, 'center');
    }
  }

  private computeManeuver(
    bird: BirdData,
    localTime: number,
    dir: 1 | -1,
  ): { dx: number; dy: number; kind: 'swoop' | 'loop' | null } {
    for (const m of bird.maneuvers) {
      if (localTime < m.startT || localTime > m.endT) continue;
      const p = (localTime - m.startT) / (m.endT - m.startT);
      if (m.kind === 'swoop') {
        const dy = -Math.sin(Math.PI * p) * m.amp;
        const dx = (1 - Math.cos(Math.PI * p)) * 0.5 * m.amp * 0.6 * dir;
        return { dx, dy, kind: 'swoop' };
      }
      const angle = p * Math.PI * 2;
      const r = m.amp;
      const dx = Math.sin(angle) * r * dir;
      const dy = (1 - Math.cos(angle)) * r;
      return { dx, dy, kind: 'loop' };
    }
    return { dx: 0, dy: 0, kind: null };
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
