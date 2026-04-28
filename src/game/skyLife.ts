import * as THREE from 'three/webgpu';
import { SpriteAtlas, type AtlasId } from './spriteAtlas';
import type { BiomeScheduler, TimeOfDay } from './biomes';
import { appendSpriteShape, type ShapeBuffers, type SpriteTransformOptions } from './spriteShapes';

const SKY_WIDTH = 16.8;
const HALF_WIDTH = SKY_WIDTH * 0.5;

const BIRD_LAYER_CAPACITY = 56;
const MAX_FLOCKS = 4;
const FLOCK_MIN_SIZE = 1;
const FLOCK_MAX_SIZE = 12;
const FLOCK_MIN_GAP_S = 4.5;
const FLOCK_MAX_GAP_S = 16;
const FLOCK_FIRST_SPAWN_S = 1.5;
const FLOCK_OFFSCREEN_BUFFER = 0.7;

type FlockFormation = 'solo' | 'pair' | 'vee' | 'loose' | 'line' | 'scatter' | 'column';

interface SpriteLayer {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshBasicMaterial;
  side: number;
  capacity: number;
  buffers: ShapeBuffers;
}

interface Maneuver {
  startT: number;
  endT: number;
  kind: 'swoop' | 'loop' | 'peel';
  amp: number;
  side: 1 | -1;
}

interface BirdData {
  formX: number;
  formY: number;
  flapHz: number;
  flapPhase: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  swayAmp: number;
  swayFreq: number;
  swayPhase: number;
  driftAmp: number;
  driftFreq: number;
  driftPhase: number;
  colorMul: number;
  maneuvers: Maneuver[];
}

interface Flock {
  startTime: number;
  duration: number;
  direction: 1 | -1;
  baseY: number;
  endYOffset: number;
  pathAmp: number;
  pathFreq: number;
  pathPhase: number;
  speed: number;
  formation: FlockFormation;
  palette: 'default' | 'seabird';
  birds: BirdData[];
}

export class SkyLife {
  private root = new THREE.Group();
  private birdLayer!: SpriteLayer;
  private flocks: Flock[] = [];
  private nextFlockAt = FLOCK_FIRST_SPAWN_S;
  private elapsedSeconds = 0;

  constructor(
    private scene: THREE.Scene,
    _atlas: SpriteAtlas,
    private scheduler: BiomeScheduler,
    private seed: number,
  ) {}

  build(): void {
    this.root.name = 'sky-life';
    for (const side of [-1]) {
      this.birdLayer = this.createSpriteLayer(side, BIRD_LAYER_CAPACITY, side * 3.36, -24);
    }
    this.scene.add(this.root);
  }

  setSeed(seed: number): void {
    this.seed = seed;
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
    this.updateBirds(ctx);
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

  private createFlock(palette: 'default' | 'seabird', birdBias: number): Flock {
    const direction: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const formation = chooseFlockFormation();
    const speed = 0.46 + Math.random() * 0.62;
    const travel = SKY_WIDTH + FLOCK_OFFSCREEN_BUFFER * 2;
    const duration = travel / speed;
    const baseY = 1.32 + Math.random() * 0.78;
    const endYOffset = (Math.random() - 0.5) * (formation === 'solo' || formation === 'pair' ? 0.44 : 0.28);
    const pathAmp = (formation === 'scatter' ? 0.12 : 0.04) + Math.random() * 0.16;
    const pathFreq = 0.75 + Math.random() * 1.45;
    const pathPhase = Math.random() * Math.PI * 2;
    const size = chooseFlockSize(formation, birdBias);
    const birds: BirdData[] = [];
    for (let i = 0; i < size; i += 1) {
      birds.push(this.createBird(i, size, formation, duration));
    }
    return {
      startTime: this.elapsedSeconds,
      duration,
      direction,
      baseY,
      endYOffset,
      pathAmp,
      pathFreq,
      pathPhase,
      speed,
      formation,
      palette,
      birds,
    };
  }

  private createBird(i: number, flockSize: number, formation: FlockFormation, flockDuration: number): BirdData {
    const offset = formationOffset(formation, i, flockSize);
    const formX = offset.x;
    const formY = offset.y;
    const scale = 0.20 + Math.random() * 0.13;
    const scaleX = 0.82 + Math.random() * 0.36;
    const scaleY = 0.82 + Math.random() * 0.30;
    const flapHz = 3.2 + Math.random() * 5.6;
    const flapPhase = Math.random() * 3;
    const swayAmp = 0.04 + Math.random() * 0.07;
    const swayFreq = 0.6 + Math.random() * 0.9;
    const swayPhase = Math.random() * Math.PI * 2;
    const driftAmp = (formation === 'scatter' || formation === 'loose' ? 0.030 : 0.014) + Math.random() * 0.035;
    const driftFreq = 0.45 + Math.random() * 0.85;
    const driftPhase = Math.random() * Math.PI * 2;
    const colorMul = 0.82 + Math.random() * 0.34;

    const maneuvers: Maneuver[] = [];
    const activity = formation === 'solo' || formation === 'scatter' ? 0.18 : 0;
    const roll = Math.random() - activity;
    const count = roll < 0.18 ? 0 : roll < 0.70 ? 1 : 2;
    let cursor = flockDuration * (0.15 + Math.random() * 0.20);
    for (let m = 0; m < count; m += 1) {
      const dur = 1.2 + Math.random() * 1.6;
      if (cursor + dur >= flockDuration * 0.92) break;
      const kind = chooseManeuverKind(formation);
      const amp = kind === 'swoop'
        ? 0.18 + Math.random() * 0.24
        : kind === 'loop'
          ? 0.08 + Math.random() * 0.10
          : 0.16 + Math.random() * 0.22;
      const side: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      maneuvers.push({ startT: cursor, endT: cursor + dur, kind, amp, side });
      cursor += dur + 1.2 + Math.random() * 2.0;
    }

    return {
      formX,
      formY,
      flapHz,
      flapPhase,
      scale,
      scaleX,
      scaleY,
      swayAmp,
      swayFreq,
      swayPhase,
      driftAmp,
      driftFreq,
      driftPhase,
      colorMul,
      maneuvers,
    };
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
    this.flocks.push(this.createFlock(palette, birdBias));
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
    const formationMotion = flock.formation === 'scatter' || flock.formation === 'loose'
      ? 1.35
      : flock.formation === 'vee'
        ? 0.82
        : 1.0;
    const routeY = flock.baseY
      + flock.endYOffset * smooth01(progress)
      + Math.sin(progress * Math.PI * 2 * flock.pathFreq + flock.pathPhase) * flock.pathAmp * formationMotion * Math.sin(Math.PI * progress);

    const tint = new THREE.Color(flock.palette === 'seabird' ? 0xefefe6 : 0x12161c)
      .multiplyScalar(daylight * 0.5 + 0.30)
      .multiplyScalar(fade);

    const ids: AtlasId[] = flock.palette === 'seabird'
      ? ['seabirdA', 'seabirdB', 'seabirdC']
      : ['birdA', 'birdB', 'birdC'];

    for (const bird of flock.birds) {
      let bx = leadX + flock.direction * bird.formX;
      let by = routeY + bird.formY;

      by += Math.sin(this.elapsedSeconds * bird.swayFreq + bird.swayPhase) * bird.swayAmp;
      bx += Math.cos(this.elapsedSeconds * bird.swayFreq * 0.7 + bird.swayPhase) * bird.swayAmp * 0.4 * flock.direction;
      by += Math.sin(local * bird.driftFreq + bird.driftPhase) * bird.driftAmp * formationMotion;
      bx += Math.cos(local * bird.driftFreq * 0.8 + bird.driftPhase) * bird.driftAmp * 0.45 * formationMotion * flock.direction;

      const m = this.computeManeuver(bird, local, flock.direction);
      bx += m.dx;
      by += m.dy;

      const flapMul = (m.kind === 'swoop' ? 1.6 : m.kind === 'loop' ? 1.9 : m.kind === 'peel' ? 1.35 : 1.0) * (0.92 + flock.speed * 0.12);
      const frame = Math.floor((this.elapsedSeconds * bird.flapHz * flapMul + bird.flapPhase) % 3);
      const birdTint = tint.clone().multiplyScalar(bird.colorMul);
      const bodyRoll = Math.sin(local * bird.driftFreq + bird.swayPhase) * 0.08;
      this.writeSprite(this.birdLayer, bx, by, bird.scale, ids[frame], birdTint, 'center', {
        flipX: flock.direction < 0,
        rotation: bodyRoll * flock.direction + m.rotation,
        scaleX: bird.scaleX,
        scaleY: bird.scaleY,
      });
    }
  }

  private computeManeuver(
    bird: BirdData,
    localTime: number,
    dir: 1 | -1,
  ): { dx: number; dy: number; rotation: number; kind: Maneuver['kind'] | null } {
    for (const m of bird.maneuvers) {
      if (localTime < m.startT || localTime > m.endT) continue;
      const p = (localTime - m.startT) / (m.endT - m.startT);
      if (m.kind === 'swoop') {
        const envelope = Math.sin(Math.PI * p);
        const dy = -envelope * m.amp;
        const dx = envelope * m.amp * 0.30 * dir;
        return { dx, dy, rotation: envelope * 0.16 * dir, kind: 'swoop' };
      }
      if (m.kind === 'loop') {
        const angle = p * Math.PI * 2;
        const r = m.amp;
        const dx = Math.sin(angle) * r * dir;
        const dy = (1 - Math.cos(angle)) * r;
        return { dx, dy, rotation: Math.sin(angle) * 0.42 * dir, kind: 'loop' };
      }
      const peel = Math.sin(Math.PI * p);
      const dx = peel * m.amp * 0.55 * dir;
      const dy = peel * m.amp * m.side;
      return { dx, dy, rotation: peel * 0.30 * m.side * dir, kind: 'peel' };
    }
    return { dx: 0, dy: 0, rotation: 0, kind: null };
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
    transform?: SpriteTransformOptions,
  ): void {
    appendSpriteShape(layer.buffers, atlas, originX, originY, scale, tint, anchor, transform);
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

function chooseFlockFormation(): FlockFormation {
  const roll = Math.random();
  if (roll < 0.08) return 'solo';
  if (roll < 0.20) return 'pair';
  if (roll < 0.46) return 'vee';
  if (roll < 0.66) return 'loose';
  if (roll < 0.82) return 'line';
  if (roll < 0.95) return 'scatter';
  return 'column';
}

function chooseFlockSize(formation: FlockFormation, birdBias: number): number {
  const range = flockSizeRange(formation);
  let size = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
  if (birdBias > 1 && size > 2 && Math.random() < Math.min(0.55, (birdBias - 1) * 0.45)) {
    size += 1 + Math.floor(Math.random() * 3);
  } else if (birdBias < 0.75 && size > 1 && Math.random() < 0.45) {
    size -= 1;
  }
  return Math.max(FLOCK_MIN_SIZE, Math.min(FLOCK_MAX_SIZE, size));
}

function flockSizeRange(formation: FlockFormation): [number, number] {
  switch (formation) {
    case 'solo': return [1, 1];
    case 'pair': return [2, 3];
    case 'vee': return [4, 12];
    case 'loose': return [3, 10];
    case 'line': return [3, 8];
    case 'scatter': return [5, 12];
    case 'column': return [3, 7];
  }
}

function formationOffset(
  formation: FlockFormation,
  i: number,
  size: number,
): { x: number; y: number } {
  switch (formation) {
    case 'solo':
      return { x: 0, y: 0 };
    case 'pair':
      return {
        x: -i * (0.13 + Math.random() * 0.08),
        y: (i - (size - 1) * 0.5) * (0.08 + Math.random() * 0.05) + (Math.random() - 0.5) * 0.025,
      };
    case 'vee': {
      const rank = Math.ceil(i / 2);
      const side = i === 0 ? 0 : i % 2 === 0 ? -1 : 1;
      return {
        x: -rank * (0.12 + Math.random() * 0.055) - Math.random() * 0.04,
        y: side * (rank * (0.055 + Math.random() * 0.018)) + (Math.random() - 0.5) * 0.035,
      };
    }
    case 'line':
      return {
        x: -i * (0.14 + Math.random() * 0.06),
        y: (i - (size - 1) * 0.5) * 0.035 + (Math.random() - 0.5) * 0.05,
      };
    case 'scatter':
      return {
        x: -(0.10 + Math.random() * 0.94),
        y: (Math.random() - 0.5) * 0.52,
      };
    case 'column':
      return {
        x: -Math.floor(i / 2) * (0.10 + Math.random() * 0.05) + (Math.random() - 0.5) * 0.06,
        y: (i - (size - 1) * 0.5) * (0.060 + Math.random() * 0.025),
      };
    case 'loose':
    default:
      return {
        x: -(Math.random() * 0.72 + i * 0.025),
        y: (Math.random() - 0.5) * 0.34,
      };
  }
}

function chooseManeuverKind(formation: FlockFormation): Maneuver['kind'] {
  const roll = Math.random();
  if (formation === 'solo' || formation === 'scatter') {
    if (roll < 0.36) return 'loop';
    if (roll < 0.70) return 'peel';
    return 'swoop';
  }
  if (roll < 0.48) return 'swoop';
  if (roll < 0.78) return 'peel';
  return 'loop';
}

function smooth01(t: number): number {
  return t * t * (3 - 2 * t);
}
