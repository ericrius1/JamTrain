import * as THREE from 'three/webgpu';
import {
  Fn,
  color,
  float,
  fract,
  mix,
  mx_fractal_noise_float as mx_fractal_noise_float_typed,
  smoothstep as smoothstep_typed,
  time,
  uniform,
  uv,
  vec2 as vec2_typed,
} from 'three/tsl';
import { mulberry32 } from './seedRandom';
import { appendSpriteShape, type ShapeBuffers } from './spriteShapes';
import type { AtlasId } from './spriteAtlas';

type AnyNode = any;
const vec2: AnyNode = vec2_typed;
const smoothstep: AnyNode = smoothstep_typed;
const mx_fractal_noise_float: AnyNode = mx_fractal_noise_float_typed;

const PANEL_WIDTH = 11.6;
const PANEL_HEIGHT = 2.6;
const BACKDROP_X = -2.225;
const RAYS_X = -2.205;
const LIFE_X = -2.045;
const PANEL_Y = 1.6;

const FISH_COUNT = 22;
const BUBBLE_COUNT = 120;
const HALF_WIDTH = PANEL_WIDTH * 0.5;
const HALF_HEIGHT = PANEL_HEIGHT * 0.5;

type FishKind = Extract<AtlasId, 'fishTiny' | 'rayFish' | 'jellyfish'>;

interface Fish {
  x: number;
  y: number;
  speed: number;
  phase: number;
  wobble: number;
  scale: number;
  kind: FishKind;
  tint: THREE.Color;
}

interface Bubble {
  x: number;
  y: number;
  rise: number;
  drift: number;
  phase: number;
}

export class UnderwaterRealm {
  private root = new THREE.Group();
  private presence = uniform(0);
  private daylight = uniform(1);
  private causticTime = 0;

  private fishLayer!: {
    mesh: THREE.Mesh;
    geometry: THREE.BufferGeometry;
    material: THREE.MeshBasicMaterial;
    buffers: ShapeBuffers;
  };
  private fish: Fish[] = [];
  private bubbles: Bubble[] = [];
  private bubblePoints!: THREE.Points;
  private bubbleGeometry!: THREE.BufferGeometry;
  private bubbleMaterial!: THREE.PointsMaterial;
  private bubblePositions = new Float32Array(BUBBLE_COUNT * 3);

  constructor(
    private scene: THREE.Scene,
    private seed: number,
  ) {}

  build(): void {
    this.root.name = 'underwater-realm';
    this.root.add(this.createBackdrop());
    this.root.add(this.createGodRays());
    this.createFishLayer();
    this.createBubbles();
    this.populateLife();
    this.scene.add(this.root);
  }

  setSeed(seed: number): void {
    this.seed = seed;
    this.populateLife();
  }

  update(delta: number, ctx: { presence: number; daylight: number; trainSpeed: number }): void {
    const alpha = 1 - Math.exp(-delta * 3.8);
    this.presence.value += (ctx.presence - this.presence.value) * alpha;
    this.daylight.value += (ctx.daylight - this.daylight.value) * (1 - Math.exp(-delta * 2.4));
    this.causticTime += delta;

    const p = this.presence.value;
    this.fishLayer.material.opacity = p;
    this.bubbleMaterial.opacity = p * (0.24 + ctx.daylight * 0.30);
    if (p < 0.004) return;

    this.updateFish(delta, ctx.trainSpeed);
    this.updateBubbles(delta, ctx.trainSpeed);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse(obj => {
      const mesh = obj as THREE.Mesh | THREE.Points;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (geometry) geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach(m => m.dispose());
      else material?.dispose();
    });
  }

  private createBackdrop(): THREE.Mesh {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;

    material.colorNode = Fn(() => {
      const u = uv();
      const aspect = float(PANEL_WIDTH / PANEL_HEIGHT);
      const p = vec2(u.x.mul(aspect), u.y);
      const depth = float(1).sub(u.y).clamp(0, 1);

      const top = color(0x38d6d7);
      const mid = color(0x0c6f83);
      const deep = color(0x031423);
      const base = mix(deep, mid, smoothstep(0.0, 0.78, u.y)).toVar('underwaterBase');
      base.assign(mix(base, top, smoothstep(0.72, 1.0, u.y).mul(0.62)));

      const slowNoise = mx_fractal_noise_float(
        vec2(p.x.mul(1.3).add(time.mul(0.025)), p.y.mul(3.2).sub(time.mul(0.035))),
        4,
        2.0,
        0.55,
      ).mul(0.5).add(0.5);
      base.addAssign(color(0x29e0d1).mul(slowNoise.mul(0.10).mul(float(1).sub(depth.mul(0.35)))));

      const causticWarp = mx_fractal_noise_float(
        vec2(p.x.mul(7.0).sub(time.mul(0.08)), p.y.mul(6.0).add(time.mul(0.055))),
        3,
        2.0,
        0.52,
      ).mul(0.5).add(0.5);
      const ca1 = p.x.mul(34.0).add(p.y.mul(12.0)).add(time.mul(0.68)).add(causticWarp.mul(2.4)).sin();
      const ca2 = p.x.mul(-24.0).add(p.y.mul(20.0)).sub(time.mul(0.55)).sin();
      const causticLines = ca1.mul(ca2).mul(0.5).add(0.5).add(causticWarp.mul(0.18));
      const causticBand = smoothstep(0.16, 0.78, u.y).mul(float(1).sub(smoothstep(0.88, 1.0, u.y)));
      const caustics = smoothstep(0.78, 1.02, causticLines).mul(causticBand).mul(this.daylight);
      base.addAssign(color(0xc4fff1).mul(caustics.mul(0.20)));

      const seabed = p.x.mul(2.1).sin().mul(0.055)
        .add(p.x.mul(4.8).add(0.7).sin().mul(0.035))
        .add(0.16);
      const coralSpikes = p.x.mul(13.0).add(0.4).sin().max(0).pow(4.0).mul(0.18)
        .add(p.x.mul(21.0).sub(0.8).sin().max(0).pow(7.0).mul(0.11));
      const reefHeight = seabed.add(coralSpikes);
      const reefMask = float(1).sub(smoothstep(reefHeight, reefHeight.add(0.035), u.y));
      base.assign(mix(base, color(0x031f26), reefMask.mul(0.82)));

      const planktonGrid = u.mul(92.0).add(vec2(time.mul(0.018), time.mul(0.07)));
      const cellX = planktonGrid.x.floor();
      const cellY = planktonGrid.y.floor();
      const fracX = fract(planktonGrid.x);
      const fracY = fract(planktonGrid.y);
      const h = fract(cellX.mul(37.13).add(cellY.mul(81.71)).sin().mul(21297.31));
      const dx = fracX.sub(0.5);
      const dy = fracY.sub(0.5);
      const dot = float(1).sub(smoothstep(0.025, 0.13, dx.mul(dx).add(dy.mul(dy)).sqrt()));
      const plankton = smoothstep(0.985, 1.0, h).mul(dot).mul(0.32);
      base.addAssign(color(0xb8fff0).mul(plankton));

      return base.mul(float(0.76).add(this.daylight.mul(0.24)));
    })();

    material.opacityNode = Fn(() => this.presence.mul(0.985))();

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), material);
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(BACKDROP_X, PANEL_Y, 0);
    mesh.renderOrder = -19;
    mesh.frustumCulled = false;
    return mesh;
  }

  private createGodRays(): THREE.Mesh {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    material.blending = THREE.AdditiveBlending;

    // Screen-space single-scatter integration. The cabin camera is fixed, so
    // Three stable samples per shaft give a volumetric look without a 3D pass.
    // Keep the inner sample analytic: FBM inside this loop is too expensive
    // for WebGPU fallbacks and low-power GPUs.
    const shaftSample = Fn(([sourceX, phase, sampleT]: AnyNode[]) => {
      const u = uv();
      const aspect = float(PANEL_WIDTH / PANEL_HEIGHT);
      const pixel = vec2(u.x, u.y);
      const source = vec2(sourceX, 1.10);
      const samplePos = mix(source, pixel, sampleT) as AnyNode;
      const depth = float(1).sub(samplePos.y).clamp(0, 1);
      const sampleP = vec2(samplePos.x.mul(aspect), samplePos.y);
      const waveA = sampleP.x.mul(14.0).add(sampleP.y.mul(5.0)).add(time.mul(0.28)).add(phase).sin();
      const waveB = sampleP.x.mul(-8.0).add(sampleP.y.mul(9.0)).sub(time.mul(0.18)).add(phase.mul(1.7)).sin();
      const waveC = sampleP.x.mul(23.0).sub(sampleP.y.mul(4.0)).add(time.mul(0.11)).add(phase.mul(0.6)).sin();
      const turbulence = waveA.mul(0.50).add(waveB.mul(0.32)).add(waveC.mul(0.18)).mul(0.5).add(0.5);
      const rippledAperture = sampleP.x.mul(11.0).add(sampleP.y.mul(5.5)).add(turbulence.mul(3.1)).add(time.mul(0.26).add(phase)).sin()
        .mul(0.5).add(0.5);
      const aperture = smoothstep(0.36, 0.82, rippledAperture.add(turbulence.mul(0.24)));

      const bend = depth.mul(0.12).mul(phase.add(1.7).sin());
      const lateral = samplePos.x.sub(sourceX.add(bend)).abs();
      const width = float(0.034).add(depth.mul(0.40));
      const cone = float(1).sub(smoothstep(width, width.add(0.26), lateral));
      const depthWindow = smoothstep(0.03, 0.78, depth).mul(float(1).sub(smoothstep(0.88, 1.02, depth)));
      return aperture.mul(cone).mul(depthWindow);
    });

    const integrateShaft = Fn(([sourceX, phase, weight]: AnyNode[]) => {
      let scatter = shaftSample(sourceX, phase, float(0.22)).mul(0.30);
      scatter = scatter.add(shaftSample(sourceX, phase, float(0.52)).mul(0.42));
      scatter = scatter.add(shaftSample(sourceX, phase, float(0.82)).mul(0.28));
      return scatter.mul(weight);
    });

    material.colorNode = Fn(() => {
      const u = uv();
      const topGate = smoothstep(0.03, 0.32, float(1).sub(u.y));
      const depthFade = float(1).sub(smoothstep(0.76, 1.03, float(1).sub(u.y)));
      const shaftA = integrateShaft(float(0.30), float(0.1), float(1.05));
      const shaftB = integrateShaft(float(0.46), float(2.4), float(0.78));
      const shaftC = integrateShaft(float(0.68), float(4.7), float(0.82));
      const radiance = shaftA.add(shaftB).add(shaftC)
        .mul(topGate)
        .mul(depthFade)
        .mul(this.daylight.mul(0.78).add(0.22))
        .mul(this.presence);

      const sourceGlow = smoothstep(0.98, 0.72, u.y)
        .mul(smoothstep(0.03, 0.24, u.x))
        .mul(float(1).sub(smoothstep(0.86, 1.0, u.x)))
        .mul(0.24)
        .mul(this.daylight)
        .mul(this.presence);

      return color(0xeefff7).mul(radiance.mul(3.6)).add(color(0x2bd5ff).mul(radiance.mul(0.42).add(sourceGlow)));
    })();

    material.opacityNode = Fn(() => this.presence.mul(this.daylight.mul(0.95).add(0.28)).clamp(0, 1))();

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), material);
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(RAYS_X, PANEL_Y, 0);
    mesh.renderOrder = -18;
    mesh.frustumCulled = false;
    return mesh;
  }

  private createFishLayer(): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(LIFE_X, PANEL_Y - HALF_HEIGHT, 0);
    mesh.renderOrder = -9;
    this.fishLayer = { mesh, geometry, material, buffers: { positions: [], colors: [] } };
    this.root.add(mesh);
  }

  private createBubbles(): void {
    this.bubbleGeometry = new THREE.BufferGeometry();
    this.bubbleGeometry.setAttribute('position', new THREE.BufferAttribute(this.bubblePositions, 3));
    this.bubbleMaterial = new THREE.PointsMaterial({
      color: 0xbffdf5,
      size: 0.024,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.bubblePoints = new THREE.Points(this.bubbleGeometry, this.bubbleMaterial);
    this.bubblePoints.frustumCulled = false;
    this.bubblePoints.rotation.y = Math.PI / 2;
    this.bubblePoints.position.set(LIFE_X + 0.02, PANEL_Y - HALF_HEIGHT, 0);
    this.bubblePoints.renderOrder = -8;
    this.root.add(this.bubblePoints);
  }

  private populateLife(): void {
    const rand = mulberry32(this.seed ^ 0x0cea11);
    this.fish = [];
    for (let i = 0; i < FISH_COUNT; i += 1) {
      const kindRoll = rand();
      const kind: FishKind = kindRoll < 0.14 ? 'jellyfish' : kindRoll < 0.30 ? 'rayFish' : 'fishTiny';
      const baseTint =
        kind === 'jellyfish' ? new THREE.Color(0xd8b6ff) :
        kind === 'rayFish' ? new THREE.Color(0x23495b) :
        new THREE.Color(rand() < 0.5 ? 0xffc86a : 0x74f2d8);
      baseTint.offsetHSL((rand() - 0.5) * 0.06, (rand() - 0.5) * 0.12, (rand() - 0.5) * 0.08);
      this.fish.push({
        x: -HALF_WIDTH + rand() * PANEL_WIDTH,
        y: 0.50 + rand() * 1.45,
        speed: (kind === 'jellyfish' ? 0.05 : 0.16 + rand() * 0.28) * (rand() < 0.5 ? -1 : 1),
        phase: rand() * Math.PI * 2,
        wobble: 0.035 + rand() * 0.12,
        scale: kind === 'jellyfish' ? 0.20 + rand() * 0.08 : kind === 'rayFish' ? 0.16 + rand() * 0.10 : 0.07 + rand() * 0.05,
        kind,
        tint: baseTint.multiplyScalar(kind === 'rayFish' ? 0.70 : 0.85),
      });
    }

    this.bubbles = [];
    for (let i = 0; i < BUBBLE_COUNT; i += 1) {
      this.bubbles.push({
        x: -HALF_WIDTH + rand() * PANEL_WIDTH,
        y: rand() * PANEL_HEIGHT,
        rise: 0.10 + rand() * 0.22,
        drift: (rand() - 0.5) * 0.11,
        phase: rand() * Math.PI * 2,
      });
      this.bubblePositions[i * 3] = this.bubbles[i].x;
      this.bubblePositions[i * 3 + 1] = this.bubbles[i].y;
      this.bubblePositions[i * 3 + 2] = 0;
    }
    const position = this.bubbleGeometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (position) position.needsUpdate = true;
  }

  private updateFish(delta: number, trainSpeed: number): void {
    const buffers: ShapeBuffers = { positions: [], colors: [] };
    for (const f of this.fish) {
      f.x += delta * (f.speed - trainSpeed * 0.05);
      if (f.x > HALF_WIDTH + 0.45) f.x = -HALF_WIDTH - 0.45;
      if (f.x < -HALF_WIDTH - 0.45) f.x = HALF_WIDTH + 0.45;

      const y = f.y + Math.sin(this.causticTime * (f.kind === 'jellyfish' ? 1.4 : 2.0) + f.phase) * f.wobble;
      const pulse = f.kind === 'jellyfish' ? 0.92 + Math.sin(this.causticTime * 2.6 + f.phase) * 0.08 : 1;
      const tint = f.tint.clone().multiplyScalar(0.68 + this.daylight.value * 0.32);
      appendSpriteShape(buffers, f.kind, f.x, y, f.scale * pulse, tint, 'center');
    }

    this.fishLayer.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffers.positions), 3));
    this.fishLayer.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(buffers.colors), 3));
    this.fishLayer.geometry.setIndex(null);
    this.fishLayer.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), PANEL_WIDTH);
  }

  private updateBubbles(delta: number, trainSpeed: number): void {
    const attr = this.bubbleGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < this.bubbles.length; i += 1) {
      const b = this.bubbles[i];
      b.y += delta * b.rise;
      b.x += delta * (Math.sin(this.causticTime * 0.7 + b.phase) * 0.055 + b.drift - trainSpeed * 0.025);
      if (b.y > PANEL_HEIGHT + 0.12) {
        b.y = -0.10;
        b.x = -HALF_WIDTH + Math.random() * PANEL_WIDTH;
      }
      if (b.x > HALF_WIDTH + 0.2) b.x = -HALF_WIDTH - 0.2;
      if (b.x < -HALF_WIDTH - 0.2) b.x = HALF_WIDTH + 0.2;
      this.bubblePositions[i * 3] = b.x;
      this.bubblePositions[i * 3 + 1] = b.y;
      this.bubblePositions[i * 3 + 2] = 0;
      attr.setXYZ(i, b.x, b.y, 0);
    }
    attr.needsUpdate = true;
  }
}
