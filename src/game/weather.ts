import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  fract,
  smoothstep as smoothstep_typed,
  texture,
  time,
  uniform,
  uv,
  vec3 as vec3_typed,
} from 'three/tsl';
import type { BiomeScheduler, ForegroundBiome, BackgroundBiome, LightningEvent } from './biomes';
import { generateBolt, rasterizeBolt } from './lightning';

type AnyNode = any;
const smoothstep: AnyNode = smoothstep_typed;
const vec3: AnyNode = vec3_typed;

const QUAD_WIDTH = 11.6;
const QUAD_HEIGHT = 2.6;
const BOLT_W = 256;
const BOLT_H = 128;

const RAIN_COUNT = 600;
const RAIN_QUAD_W = 0.012;
const RAIN_QUAD_H = 0.16;
const RAIN_AREA_HALF_W = QUAD_WIDTH * 0.5;
const RAIN_AREA_HALF_H = QUAD_HEIGHT * 0.5;
const RAIN_PANEL_X = -2.46;
const RAIN_PANEL_Y = 1.6;
const RAIN_FALL_MIN = 2.4;
const RAIN_FALL_MAX = 4.6;

interface RainParticle {
  x: number;
  y: number;
  vy: number;
  scaleX: number;
  scaleY: number;
}

export class Weather {
  private root = new THREE.Group();
  rainAmount = uniform(0);
  snowAmount = uniform(0);
  cloudCover = uniform(0);
  lightningFlash = uniform(0);
  boltOpacity = uniform(0);

  private rainAlphaMul = uniform(0);

  private boltCanvas: HTMLCanvasElement;
  private boltCtx: CanvasRenderingContext2D;
  private boltTexture: THREE.CanvasTexture;
  private mesh!: THREE.Mesh;

  private rainMesh!: THREE.InstancedMesh;
  private rainParticles: RainParticle[] = [];
  private rainMatrix = new THREE.Matrix4();

  private activeBolts: Array<{ startTime: number }> = [];
  private firedBolts = new Set<number>();

  constructor(
    private scene: THREE.Scene,
    private scheduler: BiomeScheduler,
    private getEpochSeconds: () => number,
    private onThunder?: (delaySeconds: number) => void,
  ) {
    this.boltCanvas = document.createElement('canvas');
    this.boltCanvas.width = BOLT_W;
    this.boltCanvas.height = BOLT_H;
    this.boltCtx = this.boltCanvas.getContext('2d')!;
    this.boltTexture = new THREE.CanvasTexture(this.boltCanvas);
    this.boltTexture.colorSpace = THREE.SRGBColorSpace;
  }

  build(): void {
    this.root.name = 'weather';
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;

    material.colorNode = Fn(() => {
      const u = uv();
      const result = vec3(0, 0, 0).toVar('weatherOut');

      // Snow flakes: bigger softer dots, slow drift.
      const snowGrid = u.mul(80).add(time.mul(0.6));
      const sCellX = snowGrid.x.floor();
      const sCellY = snowGrid.y.floor();
      const sfx = fract(snowGrid.x);
      const sfy = fract(snowGrid.y);
      const sHash = fract(sCellX.mul(57.13).add(sCellY.mul(91.7)).sin().mul(11297.31));
      const dx = sfx.sub(0.5);
      const dy = sfy.sub(0.5);
      const dist = dx.mul(dx).add(dy.mul(dy)).sqrt();
      const flakeOn = smoothstep(float(0.985), float(1.0), sHash);
      const flake = smoothstep(float(0.18), float(0.04), dist).mul(flakeOn).mul(this.snowAmount);
      const snowColor = color(0xeef3f8);
      result.assign(result.add(vec3(snowColor.r, snowColor.g, snowColor.b).mul(flake.mul(0.85))));

      // Lightning bolt — additive sample
      const bolt = texture(this.boltTexture, u);
      result.assign(result.add(bolt.rgb.mul(this.boltOpacity)));

      return result;
    })();

    material.opacityNode = Fn(() => {
      const s = this.snowAmount;
      const b = this.boltOpacity;
      return s.add(b).clamp(0, 1).mul(0.95);
    })();

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(QUAD_WIDTH, QUAD_HEIGHT), material);
    this.mesh.rotation.y = Math.PI / 2;
    this.mesh.position.set(-2.50, 1.6, 0);
    this.mesh.renderOrder = -22;
    this.root.add(this.mesh);

    this.buildRain();

    this.scene.add(this.root);
  }

  private buildRain(): void {
    const geo = new THREE.PlaneGeometry(RAIN_QUAD_W, RAIN_QUAD_H);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.fog = false;

    // Stretched gradient drop: an elongated soft ellipse with a brighter
    // head and a tapered tail.
    const dropShape = Fn(() => {
      const u = uv();
      const cx = u.x.sub(0.5).mul(2.0);   // -1..1 horizontally
      const cy = u.y.sub(0.5).mul(2.0);   // -1..1 vertically
      // Squash y to make the drop a vertical ellipse.
      const ellipse = cx.mul(cx).mul(1.4).add(cy.mul(cy).mul(0.4)).sqrt();
      const shape = float(1).sub(smoothstep(0.55, 1.0, ellipse)).clamp(0, 1);
      // Trail fade — bottom of the quad is more transparent (motion-blur tail).
      const trail = smoothstep(0.05, 0.55, u.y);
      return shape.mul(trail);
    });

    mat.colorNode = Fn(() => {
      const u = uv();
      // Brighten the top half of each drop slightly so the head reads as a wet specular highlight.
      const head = smoothstep(0.55, 0.95, u.y);
      const body = vec3(0.62, 0.74, 0.92);
      const headTint = vec3(0.94, 0.97, 1.0);
      return body.add(headTint.sub(body).mul(head.mul(0.75)));
    })();

    mat.opacityNode = Fn(() => {
      const a = dropShape();
      return a.mul(this.rainAlphaMul).mul(0.95);
    })();

    this.rainMesh = new THREE.InstancedMesh(geo, mat, RAIN_COUNT);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.rotation.y = Math.PI / 2;
    this.rainMesh.position.set(RAIN_PANEL_X, RAIN_PANEL_Y, 0);
    this.rainMesh.renderOrder = -21;
    this.root.add(this.rainMesh);

    for (let i = 0; i < RAIN_COUNT; i += 1) {
      this.rainParticles.push({
        x: (Math.random() - 0.5) * QUAD_WIDTH,
        y: (Math.random() - 0.5) * QUAD_HEIGHT,
        vy: RAIN_FALL_MIN + Math.random() * (RAIN_FALL_MAX - RAIN_FALL_MIN),
        scaleX: 0.7 + Math.random() * 0.6,
        scaleY: 0.7 + Math.random() * 0.9,
      });
    }
    this.writeAllRainMatrices();
  }

  update(delta: number, ctx: { fgBiome: ForegroundBiome; bgBiome: BackgroundBiome }): void {
    const now = this.getEpochSeconds();
    const w = this.scheduler.weatherAt(now);

    // Snow only manifests when we're in a snow context.
    const inSnowContext = ctx.fgBiome.id === 'snowfield' || ctx.bgBiome.id === 'snowMountains';
    const targetRain = inSnowContext ? Math.min(0.15, w.rain * 0.25) : w.rain;
    const targetSnow = inSnowContext ? Math.max(w.snow, w.rain * 0.6) : 0;

    this.rainAmount.value = lerp(this.rainAmount.value, targetRain, 0.04);
    this.snowAmount.value = lerp(this.snowAmount.value, targetSnow, 0.04);
    this.cloudCover.value = lerp(this.cloudCover.value, w.cloudCover, 0.04);
    // Rain particles use a punchier alpha curve than the raw rainAmount.
    this.rainAlphaMul.value = clamp01(this.rainAmount.value * 1.6);

    // Process lightning events (deterministic — both clients see the same).
    for (const ev of w.lightning) {
      if (this.firedBolts.has(ev.time)) continue;
      if (ev.time <= now + 0.05 && ev.time > now - 1) {
        this.firedBolts.add(ev.time);
        this.fireBolt(ev);
      }
    }
    if (this.firedBolts.size > 64) {
      for (const t of this.firedBolts) {
        if (t < now - 30) this.firedBolts.delete(t);
      }
    }

    let boltOpacity = 0;
    let flash = 0;
    for (const b of this.activeBolts) {
      const age = now - b.startTime;
      if (age < 0) continue;
      let bo = 0;
      if (age < 0.06) bo = age / 0.06;
      else if (age < 0.31) bo = Math.exp(-(age - 0.06) * 12);
      let fl = 0;
      if (age < 0.08) fl = age / 0.08;
      else if (age < 0.68) fl = Math.exp(-(age - 0.08) * 5);
      boltOpacity = Math.max(boltOpacity, bo);
      flash = Math.max(flash, fl * 0.18);
    }
    this.boltOpacity.value = boltOpacity;
    this.lightningFlash.value = flash;

    this.activeBolts = this.activeBolts.filter(b => now - b.startTime < 1.5);

    this.updateRain(delta);
  }

  private updateRain(delta: number): void {
    if (this.rainAlphaMul.value < 0.005 && this.rainAmount.value < 0.005) {
      // Hide entirely when no rain — but still tick particles slowly so they
      // resume from a natural distribution when rain returns.
      this.rainMesh.visible = false;
      return;
    }
    this.rainMesh.visible = true;

    const speedMul = 1.0;
    for (let i = 0; i < this.rainParticles.length; i += 1) {
      const p = this.rainParticles[i];
      p.y -= p.vy * delta * speedMul;
      if (p.y < -RAIN_AREA_HALF_H - 0.15) {
        p.y = RAIN_AREA_HALF_H + Math.random() * 0.4;
        p.x = (Math.random() - 0.5) * QUAD_WIDTH;
        p.vy = RAIN_FALL_MIN + Math.random() * (RAIN_FALL_MAX - RAIN_FALL_MIN);
        p.scaleX = 0.7 + Math.random() * 0.6;
        p.scaleY = 0.7 + Math.random() * 0.9;
      }
      this.writeRainMatrix(i, p);
    }
    this.rainMesh.instanceMatrix.needsUpdate = true;
  }

  private writeAllRainMatrices(): void {
    for (let i = 0; i < this.rainParticles.length; i += 1) {
      this.writeRainMatrix(i, this.rainParticles[i]);
    }
    this.rainMesh.instanceMatrix.needsUpdate = true;
  }

  private writeRainMatrix(index: number, p: RainParticle): void {
    this.rainMatrix.makeScale(p.scaleX, p.scaleY, 1);
    this.rainMatrix.setPosition(p.x, p.y, 0);
    this.rainMesh.setMatrixAt(index, this.rainMatrix);
  }

  private fireBolt(ev: LightningEvent): void {
    const geo = generateBolt(ev.seed);
    rasterizeBoltInto(this.boltCtx, geo, BOLT_W, BOLT_H);
    this.boltTexture.needsUpdate = true;
    this.activeBolts.push({ startTime: ev.time });
    if (this.onThunder) {
      const delay = 0.5 + Math.random() * 1.5;
      this.onThunder(delay);
    }
  }
}

function rasterizeBoltInto(ctx: CanvasRenderingContext2D, geo: ReturnType<typeof generateBolt>, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,238,200,0.30)';
  ctx.lineWidth = 7;
  for (const s of geo.segments) {
    ctx.beginPath();
    ctx.moveTo(s.x0 * w, s.y0 * h);
    ctx.lineTo(s.x1 * w, s.y1 * h);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,242,210,0.55)';
  ctx.lineWidth = 4;
  for (const s of geo.segments) {
    ctx.beginPath();
    ctx.moveTo(s.x0 * w, s.y0 * h);
    ctx.lineTo(s.x1 * w, s.y1 * h);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,250,235,1.0)';
  ctx.lineWidth = 1.6;
  for (const s of geo.segments) {
    ctx.beginPath();
    ctx.moveTo(s.x0 * w, s.y0 * h);
    ctx.lineTo(s.x1 * w, s.y1 * h);
    ctx.stroke();
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

void rasterizeBolt;
