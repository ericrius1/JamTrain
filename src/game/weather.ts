import * as THREE from 'three/webgpu';
import { Fn, color, float, fract, sin, smoothstep, texture, time, uniform, uv, vec3 } from 'three/tsl';
import type { BiomeScheduler, ForegroundBiome, BackgroundBiome, LightningEvent } from './biomes';
import { generateBolt, rasterizeBolt } from './lightning';

const QUAD_WIDTH = 6.4;
const QUAD_HEIGHT = 2.6;
const BOLT_W = 256;
const BOLT_H = 128;

export class Weather {
  private root = new THREE.Group();
  rainAmount = uniform(0);
  snowAmount = uniform(0);
  cloudCover = uniform(0);
  lightningFlash = uniform(0);
  boltOpacity = uniform(0);

  private boltCanvas: HTMLCanvasElement;
  private boltCtx: CanvasRenderingContext2D;
  private boltTexture: THREE.CanvasTexture;
  private mesh!: THREE.Mesh;

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

      // Rain streaks: hashed grid scrolled diagonally; tight streak masks
      const rainGrid = u.mul(120).add(time.mul(8)).add(vec3(u.y.mul(40), u.y.mul(40), 0).xy);
      const cellX = rainGrid.x.floor();
      const cellY = rainGrid.y.floor();
      const fy = fract(rainGrid.y);
      const cellHash = fract(cellX.mul(127.1).add(cellY.mul(311.7)).sin().mul(43758.5453));
      const streak = smoothstep(float(0.0), float(0.06), float(1).sub(fy)).mul(smoothstep(float(0.985), float(1.0), cellHash));
      const rainColor = color(0xc6d4e6);
      result.assign(result.add(vec3(rainColor.r, rainColor.g, rainColor.b).mul(streak.mul(this.rainAmount).mul(0.85))));

      // Snow flakes: bigger softer dots, slow drift
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
      // Be visible only where we're contributing.
      const r = this.rainAmount;
      const s = this.snowAmount;
      const b = this.boltOpacity;
      return r.add(s).add(b).clamp(0, 1).mul(0.95);
    })();

    for (const side of [-1]) {
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(QUAD_WIDTH, QUAD_HEIGHT), material);
      this.mesh.rotation.y = Math.PI / 2;
      this.mesh.position.set(side * 2.50, 1.6, 0);
      this.mesh.renderOrder = -22;
      this.root.add(this.mesh);
    }
    this.scene.add(this.root);
  }

  update(_delta: number, ctx: { fgBiome: ForegroundBiome; bgBiome: BackgroundBiome }): void {
    const now = this.getEpochSeconds();
    const w = this.scheduler.weatherAt(now);

    // Snow only manifests when we're in a snow context.
    const inSnowContext = ctx.fgBiome.id === 'snowfield' || ctx.bgBiome.id === 'snowMountains';
    const targetRain = inSnowContext ? Math.min(0.15, w.rain * 0.25) : w.rain;
    const targetSnow = inSnowContext ? Math.max(w.snow, w.rain * 0.6) : 0;

    this.rainAmount.value = lerp(this.rainAmount.value, targetRain, 0.04);
    this.snowAmount.value = lerp(this.snowAmount.value, targetSnow, 0.04);
    this.cloudCover.value = lerp(this.cloudCover.value, w.cloudCover, 0.04);

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

    // Decay envelopes for active bolts.
    let boltOpacity = 0;
    let flash = 0;
    for (const b of this.activeBolts) {
      const age = now - b.startTime;
      if (age < 0) continue;
      // Bolt: 60ms ramp up, 250ms decay
      let bo = 0;
      if (age < 0.06) bo = age / 0.06;
      else if (age < 0.31) bo = Math.exp(-(age - 0.06) * 12);
      // Flash: 80ms ramp, 600ms decay, peak 0.18 (muted/cozy)
      let fl = 0;
      if (age < 0.08) fl = age / 0.08;
      else if (age < 0.68) fl = Math.exp(-(age - 0.08) * 5);
      boltOpacity = Math.max(boltOpacity, bo);
      flash = Math.max(flash, fl * 0.18);
    }
    this.boltOpacity.value = boltOpacity;
    this.lightningFlash.value = flash;

    this.activeBolts = this.activeBolts.filter(b => now - b.startTime < 1.5);
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

// (rasterizeBolt remains exported from lightning.ts but Weather rasterizes
//  in-place to avoid creating a new CanvasTexture per strike.)
void rasterizeBolt;
