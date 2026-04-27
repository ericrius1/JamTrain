import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { VoiceState } from './instruments';
import { voiceStateZero } from './instruments';
import { clamp } from './math';

export const CENTER_DEFS = {
  bridgeCount:   { default: 18,    min: 6,    max: 28,   step: 1,     label: 'bridge strands' },
  segments:      { default: 96,    min: 24,   max: 140,  step: 2,     label: 'segments' },
  lift:          { default: 0.42,  min: -0.2, max: 1.2,  step: 0.01,  label: 'arch lift' },
  swirl:         { default: 0.095, min: 0,    max: 0.32, step: 0.005, label: 'interference' },
  idleOpacity:   { default: 0.04,  min: 0,    max: 0.4,  step: 0.01,  label: 'idle opacity' },
  soloOpacity:   { default: 0.16,  min: 0,    max: 0.8,  step: 0.01,  label: 'solo opacity' },
  duetOpacity:   { default: 0.72,  min: 0,    max: 1,    step: 0.01,  label: 'duet opacity' },
  coreSize:      { default: 0.82,  min: 0.1,  max: 2.2,  step: 0.02,  label: 'resonator size' },
  localColor:    { type: 'color', default: '#65f4ff', label: 'local' },
  remoteColor:   { type: 'color', default: '#ff7ad6', label: 'remote' },
  duetColor:     { type: 'color', default: '#fff5d6', label: 'duet' },
} as const;

export type CenterParams = ParamsOf<typeof CENTER_DEFS>;

type SlotInputs = {
  left: THREE.Vector3;
  right: THREE.Vector3;
  voice: VoiceState;
};

const MAX_BRIDGES = 28;
const MAX_SEGMENTS = 140;
const RING_COUNT = 3;
const TAU = Math.PI * 2;

export class CenterStage {
  readonly params: CenterParams;

  private bridgeLines: THREE.Line[] = [];
  private bridgeMaterials: THREE.LineBasicMaterial[] = [];
  private ringLines: THREE.Line[] = [];
  private ringMaterials: THREE.LineBasicMaterial[] = [];
  private coreSprite: THREE.Sprite;
  private coreMaterial: THREE.SpriteMaterial;
  private glowTexture: THREE.DataTexture;
  private registered?: ReturnType<typeof registerTweaks<typeof CENTER_DEFS>>;

  private local: SlotInputs = {
    left: new THREE.Vector3(-0.45, 1.1, 0.18),
    right: new THREE.Vector3(-0.15, 1.1, -0.18),
    voice: voiceStateZero(),
  };
  private remote: SlotInputs = {
    left: new THREE.Vector3(0.15, 1.1, -0.18),
    right: new THREE.Vector3(0.45, 1.1, 0.18),
    voice: voiceStateZero(),
  };

  private localColor = new THREE.Color();
  private remoteColor = new THREE.Color();
  private duetColor = new THREE.Color();
  private mixedColor = new THREE.Color();
  private center = new THREE.Vector3();
  private chord = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private side = new THREE.Vector3(0, 0, 1);
  private control = new THREE.Vector3();
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private smoothedLocal = 0;
  private smoothedRemote = 0;
  private smoothedDuet = 0;
  private initialized = false;

  constructor(
    private scene: THREE.Scene,
    private centerPos: THREE.Vector3,
    private paneDock?: HTMLElement,
  ) {
    this.params = { ...Object.fromEntries(Object.entries(CENTER_DEFS).map(([k, d]) => [k, d.default])) } as CenterParams;
    this.localColor.set(this.params.localColor);
    this.remoteColor.set(this.params.remoteColor);
    this.duetColor.set(this.params.duetColor);
    this.center.copy(centerPos);

    for (let i = 0; i < MAX_BRIDGES; i += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAX_SEGMENTS + 1) * 3), 3));
      geometry.setDrawRange(0, this.params.segments + 1);
      const material = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = 30 + i;
      this.bridgeLines.push(line);
      this.bridgeMaterials.push(material);
      this.scene.add(line);
    }

    for (let i = 0; i < RING_COUNT; i += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAX_SEGMENTS + 1) * 3), 3));
      geometry.setDrawRange(0, this.params.segments + 1);
      const material = new THREE.LineBasicMaterial({
        color: 0xfff5d6,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = 61 + i;
      this.ringLines.push(line);
      this.ringMaterials.push(material);
      this.scene.add(line);
    }

    this.glowTexture = makeRadialGlowTexture();
    this.coreMaterial = new THREE.SpriteMaterial({
      map: this.glowTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.coreSprite = new THREE.Sprite(this.coreMaterial);
    this.coreSprite.position.copy(centerPos);
    this.coreSprite.frustumCulled = false;
    this.coreSprite.renderOrder = 65;
    this.scene.add(this.coreSprite);

    this.registered = registerTweaks(paneDock, 'centerStage', CENTER_DEFS, {
      title: 'Duet Weave',
      params: this.params,
      onChange: {
        localColor:  v => this.localColor.set(v),
        remoteColor: v => this.remoteColor.set(v),
        duetColor:   v => this.duetColor.set(v),
      },
    });
  }

  setInputs(
    localLeft: THREE.Vector3,
    localRight: THREE.Vector3,
    localVoice: VoiceState,
    remoteLeft: THREE.Vector3,
    remoteRight: THREE.Vector3,
    remoteVoice: VoiceState,
  ): void {
    if (!this.initialized) {
      this.local.left.copy(localLeft);
      this.local.right.copy(localRight);
      this.remote.left.copy(remoteLeft);
      this.remote.right.copy(remoteRight);
      this.initialized = true;
    } else {
      this.local.left.copy(localLeft);
      this.local.right.copy(localRight);
      this.remote.left.copy(remoteLeft);
      this.remote.right.copy(remoteRight);
    }
    this.local.voice = localVoice;
    this.remote.voice = remoteVoice;
  }

  update(delta: number, elapsed: number): void {
    const localEnergy = this.local.voice.active ? this.local.voice.energy : 0;
    const remoteEnergy = this.remote.voice.active ? this.remote.voice.energy : 0;
    const duetEnergy = Math.min(localEnergy, remoteEnergy);
    const alpha = 1 - Math.exp(-delta * 5.5);
    this.smoothedLocal += (localEnergy - this.smoothedLocal) * alpha;
    this.smoothedRemote += (remoteEnergy - this.smoothedRemote) * alpha;
    this.smoothedDuet += (duetEnergy - this.smoothedDuet) * (1 - Math.exp(-delta * 4.2));

    this.center.copy(this.centerPos);
    const orbit = Math.sin(elapsed * 0.7) * 0.035 * this.smoothedDuet;
    this.center.y += orbit;

    this.updateBridges(elapsed);
    this.updateRings(elapsed);
    this.updateCore();
  }

  dispose(): void {
    this.registered?.dispose();
    for (const line of this.bridgeLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      line.removeFromParent();
    }
    for (const line of this.ringLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
      line.removeFromParent();
    }
    this.coreMaterial.map?.dispose();
    this.coreMaterial.dispose();
    this.coreSprite.removeFromParent();
  }

  private updateBridges(elapsed: number): void {
    const bridgeCount = Math.max(0, Math.min(MAX_BRIDGES, Math.round(this.params.bridgeCount)));
    const segments = Math.max(12, Math.min(MAX_SEGMENTS, this.params.segments | 0));
    const solo = Math.max(this.smoothedLocal, this.smoothedRemote);
    const duet = this.smoothedDuet;
    const pulse = Math.max(this.local.voice.pulse, this.remote.voice.pulse);
    const noteDelta = Math.abs((this.local.voice.noteIndex >= 0 ? this.local.voice.noteIndex : 0) - (this.remote.voice.noteIndex >= 0 ? this.remote.voice.noteIndex : 0));

    for (let i = 0; i < MAX_BRIDGES; i += 1) {
      const line = this.bridgeLines[i];
      const material = this.bridgeMaterials[i];
      line.visible = i < bridgeCount;
      if (!line.visible) continue;

      const [from, to] = this.bridgeEndpoints(i);
      this.resolveBridgeFrame(from, to);
      const geometry = line.geometry as THREE.BufferGeometry;
      geometry.setDrawRange(0, segments + 1);
      const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
      const lane = bridgeCount <= 1 ? 0 : (i / (bridgeCount - 1) - 0.5);
      const lanePhase = i * 0.47;
      const arch = this.params.lift * (0.35 + duet * 0.95) + Math.sin(i * 1.7) * 0.035;

      this.control.copy(this.center)
        .addScaledVector(this.up, arch)
        .addScaledVector(this.side, lane * 0.24);

      for (let s = 0; s <= segments; s += 1) {
        const u = s / segments;
        quadraticBezier(from, this.control, to, u, this.tmpA);
        const envelope = Math.sin(u * Math.PI);
        const localWave = Math.sin(u * TAU * (1.2 + this.local.voice.tension * 1.6) - elapsed * TAU * 0.52 + lanePhase);
        const remoteWave = Math.sin(u * TAU * (1.4 + this.remote.voice.tension * 1.5) + elapsed * TAU * 0.48 - lanePhase);
        const interference = (localWave * this.smoothedLocal + remoteWave * this.smoothedRemote) * this.params.swirl * envelope;
        const crossing = Math.sin((u + lane * 0.18) * TAU * (2.4 + noteDelta * 0.08) + elapsed * 2.8) * this.params.swirl * duet * envelope;
        this.tmpA
          .addScaledVector(this.side, lane * 0.09 + interference)
          .addScaledVector(this.up, crossing + Math.sin(u * Math.PI * 2 + lanePhase) * 0.018 * solo);
        positions.setXYZ(s, this.tmpA.x, this.tmpA.y, this.tmpA.z);
      }

      positions.needsUpdate = true;
      material.opacity = clamp(
        this.params.idleOpacity +
        solo * this.params.soloOpacity +
        duet * this.params.duetOpacity * (0.42 + Math.sin(i * 1.9) * 0.12 + 0.46) +
        pulse * duet * 0.24,
        0,
        0.95,
      );
      this.mixedColor.copy(this.localColor)
        .lerp(this.remoteColor, bridgeCount <= 1 ? 0.5 : i / (bridgeCount - 1))
        .lerp(this.duetColor, duet * 0.42 + pulse * 0.18);
      material.color.copy(this.mixedColor);
    }
  }

  private updateRings(elapsed: number): void {
    const segments = Math.max(24, Math.min(MAX_SEGMENTS, this.params.segments | 0));
    const pulse = Math.max(this.local.voice.pulse, this.remote.voice.pulse);
    const duet = this.smoothedDuet;
    const radiusBase = this.params.coreSize * (0.34 + duet * 0.42 + pulse * 0.08);

    for (let r = 0; r < RING_COUNT; r += 1) {
      const line = this.ringLines[r];
      const material = this.ringMaterials[r];
      const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      line.geometry.setDrawRange(0, segments + 1);
      const spin = elapsed * (0.34 + r * 0.13) + r * TAU / RING_COUNT;
      const radius = radiusBase * (0.72 + r * 0.28);
      const tiltA = spin + r * 0.9;
      const a = this.tmpA.set(Math.cos(tiltA), Math.sin(tiltA) * 0.35, Math.sin(tiltA)).normalize();
      const b = this.tmpB.crossVectors(a, new THREE.Vector3(0, 1, 0));
      if (b.lengthSq() < 0.001) b.set(1, 0, 0);
      b.normalize();

      for (let s = 0; s <= segments; s += 1) {
        const u = s / segments;
        const theta = u * TAU;
        const wobble = Math.sin(theta * (3 + r) + elapsed * 2.3) * radius * 0.08 * duet;
        this.tmpC.copy(this.center)
          .addScaledVector(a, Math.cos(theta) * (radius + wobble))
          .addScaledVector(b, Math.sin(theta) * radius * (0.72 + r * 0.1));
        positions.setXYZ(s, this.tmpC.x, this.tmpC.y, this.tmpC.z);
      }

      positions.needsUpdate = true;
      material.opacity = clamp(duet * (0.18 + r * 0.13) + pulse * duet * 0.18, 0, 0.78);
      material.color.copy(this.duetColor).lerp(r % 2 === 0 ? this.localColor : this.remoteColor, 0.18);
    }
  }

  private updateCore(): void {
    const pulse = Math.max(this.local.voice.pulse, this.remote.voice.pulse);
    const duet = this.smoothedDuet;
    this.coreSprite.position.copy(this.center);
    this.coreSprite.scale.setScalar(this.params.coreSize * (0.38 + duet * 0.72 + pulse * duet * 0.22));
    this.coreMaterial.opacity = clamp(duet * 0.72 + pulse * duet * 0.24, 0, 0.86);
    this.coreMaterial.color.copy(this.duetColor).lerp(this.localColor, this.smoothedLocal * 0.12).lerp(this.remoteColor, this.smoothedRemote * 0.12);
  }

  private bridgeEndpoints(i: number): [THREE.Vector3, THREE.Vector3] {
    switch (i % 6) {
      case 0: return [this.local.left, this.remote.right];
      case 1: return [this.local.right, this.remote.left];
      case 2: return [this.local.left, this.remote.left];
      case 3: return [this.local.right, this.remote.right];
      case 4: return [this.local.left, this.local.right];
      default: return [this.remote.left, this.remote.right];
    }
  }

  private resolveBridgeFrame(from: THREE.Vector3, to: THREE.Vector3): void {
    this.chord.subVectors(to, from);
    if (this.chord.lengthSq() < 0.0001) this.chord.set(1, 0, 0);
    else this.chord.normalize();
    this.side.crossVectors(this.chord, new THREE.Vector3(0, 1, 0));
    if (this.side.lengthSq() < 0.0001) this.side.set(0, 0, 1);
    this.side.normalize();
    this.up.crossVectors(this.side, this.chord).normalize();
  }
}

function quadraticBezier(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const inv = 1 - t;
  out.set(
    inv * inv * a.x + 2 * inv * t * b.x + t * t * c.x,
    inv * inv * a.y + 2 * inv * t * b.y + t * t * c.y,
    inv * inv * a.z + 2 * inv * t * b.z + t * t * c.z,
  );
  return out;
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
      const core = Math.max(0, 1 - r * 3.2);
      const halo = Math.max(0, 1 - r);
      const alpha = Math.min(1, Math.pow(core, 0.58) * 0.94 + Math.pow(halo, 2.0) * 0.56);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(236 + core * 19);
      data[i + 2] = Math.round(206 + core * 49);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
