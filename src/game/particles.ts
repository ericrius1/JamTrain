import * as THREE from 'three/webgpu';
import { Fn, color, float, hash, instancedArray, instanceIndex, mix, time, uniform, vec3 } from 'three/tsl';
import { clamp, toThree } from './math';
import type { LinkSample } from './types';

type TslComputeNode = any;

const stripCount = 10;
const particlesPerStrip = 240;

class GpuLinkStrip {
  readonly mesh: THREE.InstancedMesh;
  readonly start = uniform(new THREE.Vector3());
  readonly end = uniform(new THREE.Vector3());
  readonly energy = uniform(0.4);
  private readonly positions = instancedArray(particlesPerStrip, 'vec3');
  private readonly computeInit: TslComputeNode;
  private readonly computeUpdate: TslComputeNode;

  constructor(index: number, colorA: number, colorB: number) {
    const speed = 0.9 + index * 0.08;
    const phase = index * 2.17;

    this.computeInit = Fn(() => {
      const position = this.positions.element(instanceIndex);
      const pct = instanceIndex.toFloat().div(float(particlesPerStrip - 1));
      const base = this.start.mul(float(1).sub(pct)).add(this.end.mul(pct));
      position.assign(base);
    })().compute(particlesPerStrip) as TslComputeNode;

    this.computeUpdate = Fn(() => {
      const position = this.positions.element(instanceIndex);
      const pct = instanceIndex.toFloat().div(float(particlesPerStrip - 1));
      const base = this.start.mul(float(1).sub(pct)).add(this.end.mul(pct));
      const wave = pct
        .mul(18.84 + index * 0.9)
        .add(time.mul(speed * 2.2).add(phase))
        .sin();
      const shimmer = hash(instanceIndex.add(index * 71)).sub(0.5);
      const amp = float(0.025).add(this.energy.mul(0.13));
      const offset = vec3(shimmer.mul(amp), wave.mul(amp), hash(instanceIndex.add(19 + index)).sub(0.5).mul(amp));
      position.assign(position.mul(0.78).add(base.add(offset).mul(0.22)));
    })().compute(particlesPerStrip) as TslComputeNode;

    const geometry = new THREE.SphereGeometry(0.018, 6, 4);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pct = instanceIndex.toFloat().div(float(particlesPerStrip - 1));
    material.positionNode = this.positions.element(instanceIndex);
    material.colorNode = mix(color(colorA), color(colorB), pct);
    material.opacityNode = float(0.2).add(this.energy.mul(0.55));

    this.mesh = new THREE.InstancedMesh(geometry, material, particlesPerStrip);
    this.mesh.frustumCulled = false;
  }

  initialize(renderer: THREE.WebGPURenderer): void {
    renderer.compute(this.computeInit);
  }

  update(renderer: THREE.WebGPURenderer, link: LinkSample, tension = link.tension): void {
    toThree(link.from, this.start.value);
    toThree(link.to, this.end.value);
    this.energy.value = clamp(tension, 0.05, 1);
    renderer.compute(this.computeUpdate);
  }
}

class CpuTrailFallback {
  readonly points: THREE.Points;
  private positions = new Float32Array(stripCount * 90 * 3);
  private geometry = new THREE.BufferGeometry();

  constructor() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const material = new THREE.PointsMaterial({
      size: 0.035,
      color: 0x9ef5ff,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
  }

  update(links: LinkSample[], timeSeconds: number): void {
    let cursor = 0;
    for (let linkIndex = 0; linkIndex < stripCount; linkIndex += 1) {
      const link = links[linkIndex % links.length];
      for (let i = 0; i < 90; i += 1) {
        const pct = i / 89;
        const wave = Math.sin(timeSeconds * 2.2 + pct * 18 + linkIndex) * 0.045 * link.tension;
        this.positions[cursor++] = link.from.x + (link.to.x - link.from.x) * pct + Math.sin(i * 12.989) * 0.018;
        this.positions[cursor++] = link.from.y + (link.to.y - link.from.y) * pct + wave;
        this.positions[cursor++] = link.from.z + (link.to.z - link.from.z) * pct + Math.cos(i * 9.871) * 0.018;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
  }
}

export class LinkParticles {
  private strips: GpuLinkStrip[] = [];
  private fallback?: CpuTrailFallback;
  private gpuActive = true;
  private musicIntensity = 0;

  constructor(private scene: THREE.Scene) {
    const colors = [
      [0x60f0ff, 0xf7cf72],
      [0xf26d7d, 0x8df7b3],
      [0x89a7ff, 0xfce694],
      [0x58ffd0, 0xff8a5f],
      [0xffffff, 0x7ef2ff],
    ];

    for (let i = 0; i < stripCount; i += 1) {
      const [a, b] = colors[i % colors.length];
      const strip = new GpuLinkStrip(i, a, b);
      this.strips.push(strip);
      this.scene.add(strip.mesh);
    }
  }

  initialize(renderer: THREE.WebGPURenderer): void {
    if (!this.gpuActive) return;
    try {
      for (const strip of this.strips) strip.initialize(renderer);
    } catch (error) {
      console.warn('GPU particle compute unavailable; using CPU trail fallback', error);
      this.useFallback();
    }
  }

  update(renderer: THREE.WebGPURenderer, links: LinkSample[], timeSeconds: number): void {
    if (links.length === 0) return;
    if (!this.gpuActive) {
      this.fallback?.update(links, timeSeconds);
      return;
    }

    try {
      for (let i = 0; i < this.strips.length; i += 1) {
        const link = links[i % links.length];
        // Layer music intensity on top of the link's tension. Note attacks
        // and drum hits give the threads a gentle shimmer.
        const tension = this.musicIntensity > 0
          ? clamp(link.tension + this.musicIntensity * 0.4, 0.05, 1)
          : link.tension;
        this.strips[i].update(renderer, link, tension);
      }
    } catch (error) {
      console.warn('GPU particle update failed; using CPU trail fallback', error);
      this.useFallback();
      this.fallback?.update(links, timeSeconds);
    }
  }

  setMusicIntensity(value: number): void {
    this.musicIntensity = clamp(value, 0, 1);
  }

  private useFallback(): void {
    this.gpuActive = false;
    for (const strip of this.strips) strip.mesh.visible = false;
    if (!this.fallback) {
      this.fallback = new CpuTrailFallback();
      this.scene.add(this.fallback.points);
    }
  }
}
