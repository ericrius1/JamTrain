import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { PlayerVisual, VoiceState } from '../instruments';
import { clamp } from '../math';

export const LOOM_DEFS = {
  strands:       { default: 11,    min: 7,    max: 21,   step: 2,     label: 'strands' },
  segments:      { default: 56,    min: 24,   max: 120,  step: 2,     label: 'segments' },
  spread:        { default: 0.34,  min: 0.08, max: 0.8,  step: 0.01,  label: 'spread' },
  waveAmp:       { default: 0.055, min: 0,    max: 0.22, step: 0.005, label: 'wave amp' },
  bowFlow:       { default: 0.82,  min: 0,    max: 2.8,  step: 0.01,  label: 'flow speed' },
  idleOpacity:   { default: 0.10,  min: 0,    max: 0.6,  step: 0.01,  label: 'idle opacity' },
  energyOpacity: { default: 0.62,  min: 0,    max: 1,    step: 0.01,  label: 'energy opacity' },
  pulseOpacity:  { default: 0.52,  min: 0,    max: 1,    step: 0.01,  label: 'pulse opacity' },
  moteCount:     { default: 48,    min: 0,    max: 160,  step: 4,     label: 'motes' },
  moteSize:      { default: 0.011, min: 0.004, max: 0.04, step: 0.001, label: 'mote size' },
  nodeSize:      { default: 0.17,  min: 0.04, max: 0.55, step: 0.01,  label: 'hand nodes' },
  coolColor:     { type: 'color', default: '#68f4ff', label: 'cool' },
  warmColor:     { type: 'color', default: '#f6bd4b', label: 'warm' },
  hotColor:      { type: 'color', default: '#fff5d6', label: 'hot' },
} as const;

export type LoomParams = ParamsOf<typeof LOOM_DEFS>;

type LoomPalette = 'local' | 'remote' | 'center';

type HarmonicLoomOptions = {
  palette?: LoomPalette;
  title?: string;
};

const MAX_STRANDS = 21;
const MAX_SEGMENTS = 120;
const MAX_MOTES = 160;
const TAU = Math.PI * 2;

export class HarmonicLoom implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: LoomParams;

  private strandLines: THREE.Line[] = [];
  private strandMaterials: THREE.LineBasicMaterial[] = [];
  private moteMesh: THREE.InstancedMesh;
  private moteMaterial: THREE.MeshBasicMaterial;
  private nodeTexture: THREE.DataTexture;
  private leftNode: THREE.Sprite;
  private rightNode: THREE.Sprite;
  private coreNode: THREE.Sprite;
  private nodeMaterials: THREE.SpriteMaterial[] = [];
  private registered?: ReturnType<typeof registerTweaks<typeof LOOM_DEFS>>;

  private elapsed = 0;
  private active = true;
  private initialized = false;
  private smoothedEnergy = 0;
  private smoothedPulse = 0;
  private smoothedPitch = 0.5;
  private smoothedExpression = 0.5;
  private smoothedTension = 0.35;

  private left = new THREE.Vector3();
  private right = new THREE.Vector3();
  private center = new THREE.Vector3();
  private axis = new THREE.Vector3(1, 0, 0);
  private worldUp = new THREE.Vector3(0, 1, 0);
  private fieldUp = new THREE.Vector3(0, 1, 0);
  private fieldSide = new THREE.Vector3(0, 0, 1);
  private tmp = new THREE.Vector3();
  private dummy = new THREE.Object3D();
  private moteSeeds = new Float32Array(MAX_MOTES * 4);
  private cool = new THREE.Color();
  private warm = new THREE.Color();
  private hot = new THREE.Color();
  private scratchColor = new THREE.Color();

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey = 'harmonicLoom', opts: HarmonicLoomOptions = {}) {
    this.params = { ...Object.fromEntries(Object.entries(LOOM_DEFS).map(([k, d]) => [k, d.default])) } as LoomParams;
    applyPaletteDefaults(this.params, opts.palette ?? 'center');

    this.mesh = new THREE.Group();
    this.mesh.name = `aurora-loom-${opts.palette ?? 'center'}`;
    scene.add(this.mesh);

    this.nodeTexture = makeRadialGlowTexture();
    this.leftNode = this.makeNodeSprite();
    this.rightNode = this.makeNodeSprite();
    this.coreNode = this.makeNodeSprite();
    this.coreNode.renderOrder = 19;
    this.mesh.add(this.leftNode, this.rightNode, this.coreNode);

    for (let i = 0; i < MAX_STRANDS; i += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAX_SEGMENTS + 1) * 3), 3));
      geometry.setDrawRange(0, this.params.segments + 1);

      const material = new THREE.LineBasicMaterial({
        color: 0x68f4ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = 12 + i;
      this.strandLines.push(line);
      this.strandMaterials.push(material);
      this.mesh.add(line);
    }

    const moteGeometry = new THREE.SphereGeometry(1, 8, 6);
    this.moteMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff0bc,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.moteMesh = new THREE.InstancedMesh(moteGeometry, this.moteMaterial, MAX_MOTES);
    this.moteMesh.frustumCulled = false;
    this.moteMesh.renderOrder = 36;
    this.mesh.add(this.moteMesh);

    for (let i = 0; i < MAX_MOTES; i += 1) {
      const k = i * 4;
      this.moteSeeds[k] = hash01(i * 12.9898 + 0.17);
      this.moteSeeds[k + 1] = hash01(i * 78.233 + 1.31);
      this.moteSeeds[k + 2] = hash01(i * 37.719 + 2.79);
      this.moteSeeds[k + 3] = hash01(i * 19.17 + 4.43);
    }

    this.applyColors();
    this.registered = registerTweaks(paneDock, paneKey, LOOM_DEFS, {
      title: opts.title ?? 'Aurora Loom',
      params: this.params,
      onChange: {
        coolColor: () => this.applyColors(),
        warmColor: () => this.applyColors(),
        hotColor:  () => this.applyColors(),
      },
    });
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
  }

  update(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3, voice: VoiceState, delta: number): void {
    if (!this.active) return;

    this.elapsed += delta;
    if (!this.initialized) {
      this.left.copy(leftPalm);
      this.right.copy(rightPalm);
      this.initialized = true;
    }

    const palmAlpha = 1 - Math.exp(-delta * 18);
    this.left.lerp(leftPalm, palmAlpha);
    this.right.lerp(rightPalm, palmAlpha);
    this.center.copy(this.left).add(this.right).multiplyScalar(0.5);

    const energyTarget = voice.active ? voice.energy : 0;
    const energyAlpha = 1 - Math.exp(-delta * 6);
    const pulseAlpha = 1 - Math.exp(-delta * 16);
    this.smoothedEnergy += (energyTarget - this.smoothedEnergy) * energyAlpha;
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * pulseAlpha;
    this.smoothedPitch += (voice.pitch - this.smoothedPitch) * (1 - Math.exp(-delta * 12));
    this.smoothedExpression += (voice.expression - this.smoothedExpression) * (1 - Math.exp(-delta * 10));
    this.smoothedTension += (voice.tension - this.smoothedTension) * (1 - Math.exp(-delta * 8));

    this.resolveAxes();
    this.updateNodes();
    this.updateStrands(voice);
    this.updateMotes(voice);
  }

  dispose(): void {
    this.registered?.dispose();
    for (const line of this.strandLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.moteMesh.geometry.dispose();
    (this.moteMesh.material as THREE.Material).dispose();
    for (const material of this.nodeMaterials) {
      material.map?.dispose();
      material.dispose();
    }
    this.mesh.removeFromParent();
  }

  private makeNodeSprite(): THREE.Sprite {
    const material = new THREE.SpriteMaterial({
      map: this.nodeTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.nodeMaterials.push(material);
    const sprite = new THREE.Sprite(material);
    sprite.frustumCulled = false;
    sprite.renderOrder = 18;
    return sprite;
  }

  private resolveAxes(): void {
    this.axis.subVectors(this.right, this.left);
    if (this.axis.lengthSq() < 0.0001) this.axis.set(1, 0, 0);
    else this.axis.normalize();

    this.fieldSide.crossVectors(this.axis, this.worldUp);
    if (this.fieldSide.lengthSq() < 0.0001) this.fieldSide.set(0, 0, 1);
    this.fieldSide.normalize();
    this.fieldUp.crossVectors(this.fieldSide, this.axis).normalize();
  }

  private updateNodes(): void {
    const size = this.params.nodeSize * (0.66 + this.smoothedEnergy * 0.34 + this.smoothedPulse * 0.24);
    const coreSize = size * (1.24 + this.smoothedTension * 0.52);
    const opacity = clamp(0.15 + this.smoothedEnergy * 0.42 + this.smoothedPulse * 0.32, 0, 0.78);

    this.leftNode.position.copy(this.left);
    this.rightNode.position.copy(this.right);
    this.coreNode.position.copy(this.center);
    this.leftNode.scale.setScalar(size);
    this.rightNode.scale.setScalar(size);
    this.coreNode.scale.setScalar(coreSize);

    for (const material of this.nodeMaterials) {
      material.opacity = opacity;
      material.color.copy(this.warm).lerp(this.hot, this.smoothedPulse * 0.5);
    }
    (this.coreNode.material as THREE.SpriteMaterial).opacity = clamp(opacity * 0.66, 0, 0.68);
  }

  private updateStrands(voice: VoiceState): void {
    const strandCount = clampOdd(this.params.strands, 7, MAX_STRANDS);
    const segments = Math.max(8, Math.min(MAX_SEGMENTS, this.params.segments | 0));
    const activeStrand = this.activeStrandIndex(voice, strandCount);
    const spread = this.params.spread * (0.68 + this.smoothedTension * 0.92);
    const phase = this.elapsed * this.params.bowFlow * TAU;
    const expressionWarmth = clamp(this.smoothedExpression, 0, 1);

    for (let i = 0; i < MAX_STRANDS; i += 1) {
      const line = this.strandLines[i];
      const material = this.strandMaterials[i];
      line.visible = i < strandCount;
      if (!line.visible) continue;

      const geometry = line.geometry as THREE.BufferGeometry;
      geometry.setDrawRange(0, segments + 1);
      const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
      const distanceFromActive = Math.abs(i - activeStrand);
      const selected = Math.max(0, 1 - distanceFromActive / 2.4);
      const lane = strandCount <= 1 ? 0 : (i / (strandCount - 1) - 0.5);
      const laneOffset = lane * spread;
      const harmonic = 1.4 + (i % 5) * 0.55 + this.smoothedTension * 1.3;
      const waveAmp = this.params.waveAmp * (0.28 + this.smoothedEnergy * 0.95 + this.smoothedPulse * 1.6) * (0.7 + selected * 0.75);

      for (let s = 0; s <= segments; s += 1) {
        const u = s / segments;
        const envelope = Math.sin(u * Math.PI);
        const bow = Math.sin(u * TAU * harmonic - phase - i * 0.31);
        const shimmer = Math.sin(u * Math.PI * (5 + i % 3) + phase * 0.52 + i) * 0.34;
        const pulseTravel = Math.sin((u - (this.elapsed * (0.35 + this.smoothedExpression * 0.8))) * TAU * 2.0 + i * 0.2);
        const offset = (bow + shimmer + pulseTravel * this.smoothedPulse * selected) * waveAmp * envelope;

        this.tmp.copy(this.left).lerp(this.right, u)
          .addScaledVector(this.fieldUp, laneOffset)
          .addScaledVector(this.fieldSide, offset);
        positions.setXYZ(s, this.tmp.x, this.tmp.y, this.tmp.z);
      }

      positions.needsUpdate = true;
      const opacity = clamp(
        this.params.idleOpacity +
        this.smoothedEnergy * this.params.energyOpacity * (0.36 + selected * 0.58) +
        this.smoothedPulse * this.params.pulseOpacity * selected,
        0,
        0.98,
      );
      material.opacity = opacity;
      material.color.copy(this.cool)
        .lerp(this.warm, 0.2 + expressionWarmth * 0.45 + selected * 0.2)
        .lerp(this.hot, this.smoothedPulse * selected * 0.35);
    }
  }

  private updateMotes(voice: VoiceState): void {
    const strandCount = clampOdd(this.params.strands, 7, MAX_STRANDS);
    const activeStrand = this.activeStrandIndex(voice, strandCount);
    const spread = this.params.spread * (0.68 + this.smoothedTension * 0.92);
    const count = Math.max(0, Math.min(MAX_MOTES, Math.round(this.params.moteCount * (0.18 + this.smoothedEnergy * 0.82 + this.smoothedPulse * 0.25))));
    const phase = this.elapsed * this.params.bowFlow;

    this.moteMesh.count = count;
    this.moteMaterial.opacity = clamp(0.04 + this.smoothedEnergy * 0.42 + this.smoothedPulse * 0.24, 0, 0.68);
    this.moteMaterial.color.copy(this.warm).lerp(this.hot, this.smoothedPulse * 0.42);

    for (let i = 0; i < count; i += 1) {
      const k = i * 4;
      const s0 = this.moteSeeds[k];
      const s1 = this.moteSeeds[k + 1];
      const s2 = this.moteSeeds[k + 2];
      const s3 = this.moteSeeds[k + 3];
      const laneIndex = clamp(Math.round(activeStrand + (s0 - 0.5) * 4), 0, strandCount - 1);
      const lane = strandCount <= 1 ? 0 : (laneIndex / (strandCount - 1) - 0.5);
      const u = (s1 + phase * (0.16 + s2 * 0.45 + this.smoothedExpression * 0.25)) % 1;
      const envelope = Math.sin(u * Math.PI);
      const wave = Math.sin(u * TAU * (1.8 + s2 * 2.6) - phase * TAU + s3 * TAU)
        * this.params.waveAmp
        * (0.35 + this.smoothedEnergy + this.smoothedPulse)
        * envelope;

      this.tmp.copy(this.left).lerp(this.right, u)
        .addScaledVector(this.fieldUp, lane * spread)
        .addScaledVector(this.fieldSide, wave + (s0 - 0.5) * 0.018);

      const size = this.params.moteSize * (0.48 + s3 * 1.2) * (0.72 + this.smoothedEnergy * 0.8 + this.smoothedPulse * 0.8);
      this.dummy.position.copy(this.tmp);
      this.dummy.scale.setScalar(Math.max(0.0001, size));
      this.dummy.updateMatrix();
      this.moteMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.moteMesh.instanceMatrix.needsUpdate = true;
  }

  private activeStrandIndex(voice: VoiceState, strandCount: number): number {
    if (voice.noteIndex >= 0 && voice.noteCount > 1) {
      return clamp(Math.round((voice.noteIndex / (voice.noteCount - 1)) * (strandCount - 1)), 0, strandCount - 1);
    }
    return clamp(Math.round(this.smoothedPitch * (strandCount - 1)), 0, strandCount - 1);
  }

  private applyColors(): void {
    this.cool.set(this.params.coolColor);
    this.warm.set(this.params.warmColor);
    this.hot.set(this.params.hotColor);
    for (const material of this.nodeMaterials) material.color.copy(this.warm);
    this.moteMaterial.color.copy(this.warm);
    for (let i = 0; i < this.strandMaterials.length; i += 1) {
      const t = i / Math.max(1, this.strandMaterials.length - 1);
      this.scratchColor.copy(this.cool).lerp(this.warm, 0.2 + t * 0.35);
      this.strandMaterials[i].color.copy(this.scratchColor);
    }
  }
}

function clampOdd(value: number, min: number, max: number): number {
  const n = Math.max(min, Math.min(max, Math.round(value)));
  return n % 2 === 0 ? Math.max(min, Math.min(max, n + 1)) : n;
}

function applyPaletteDefaults(params: LoomParams, palette: LoomPalette): void {
  if (palette === 'local') {
    params.coolColor = '#65f4ff';
    params.warmColor = '#ffd166';
    params.hotColor = '#fff8d8';
    return;
  }
  if (palette === 'remote') {
    params.coolColor = '#8db4ff';
    params.warmColor = '#ff7ad6';
    params.hotColor = '#fff0fb';
    return;
  }
  params.coolColor = '#70f5ff';
  params.warmColor = '#f6bd4b';
  params.hotColor = '#fff5d6';
}

function makeRadialGlowTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const maxR = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - cx) / maxR;
      const dy = (y - cy) / maxR;
      const r = Math.sqrt(dx * dx + dy * dy);
      const core = Math.max(0, 1 - r * 3.4);
      const halo = Math.max(0, 1 - r);
      const alpha = Math.min(1, Math.pow(core, 0.62) + Math.pow(halo, 2.2) * 0.56);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(232 + core * 23);
      data[i + 2] = Math.round(190 + core * 55);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hash01(n: number): number {
  const s = Math.sin(n) * 43758.5453123;
  return s - Math.floor(s);
}
