import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../hud/tweakDefs';
import type { CenterContribution, InstrumentId, VoiceState } from './instruments';
import { voiceStateZero } from './instruments';
import { Bloom } from './visuals/Bloom';
import { Ribbon } from './visuals/Ribbon';
import { Sparks } from './visuals/Sparks';

export const CENTER_DEFS = {
  spread:        { default: 0.55, min: 0.1, max: 1.5, step: 0.01, label: 'piece spread' },
  height:        { default: 0.45, min: 0,   max: 1.5, step: 0.01, label: 'piece height' },
  bondThreshold: { default: 0.35, min: 0,   max: 1,   step: 0.01, label: 'bond threshold' },
  bondSize:      { default: 1.4,  min: 0.2, max: 4,   step: 0.05, label: 'bond size' },
  bondOpacity:   { default: 0.6,  min: 0,   max: 1,   step: 0.01, label: 'bond opacity' },
  bondColor:     { type: 'color', default: '#ffe6c7', label: 'bond color' },
} as const;

export type CenterParams = ParamsOf<typeof CENTER_DEFS>;

type Slot = 0 | 1;

class InstrumentCenterPiece implements CenterContribution {
  private leftAnchor = new THREE.Vector3();
  private rightAnchor = new THREE.Vector3();
  private renderer: { update: Bloom['update']; dispose: () => void; setVisible: (v: boolean) => void };
  private which: 'flute' | 'bell' | 'sparks';

  constructor(
    scene: THREE.Scene,
    instrumentId: InstrumentId,
    paneDock: HTMLElement | undefined,
    paneKey: string,
    private renderHook?: (sparks: Sparks) => void,
  ) {
    this.which = instrumentId;
    if (instrumentId === 'flute') {
      const ribbon = new Ribbon(scene, paneDock, paneKey);
      this.renderer = ribbon;
    } else if (instrumentId === 'bell') {
      const bloom = new Bloom(scene, paneDock, paneKey);
      this.renderer = bloom;
    } else {
      const sparks = new Sparks(scene, paneDock, paneKey);
      this.renderHook?.(sparks);
      this.renderer = sparks;
    }
  }

  setAnchors(left: THREE.Vector3, right: THREE.Vector3): void {
    this.leftAnchor.copy(left);
    this.rightAnchor.copy(right);
  }

  update(voice: VoiceState, delta: number, _elapsed: number): void {
    this.renderer.update(this.leftAnchor, this.rightAnchor, voice, delta);
  }

  setVisible(visible: boolean): void {
    this.renderer.setVisible(visible);
  }

  dispose(): void {
    this.renderer.dispose();
  }

  get id(): InstrumentId { return this.which; }
}

export class CenterStage {
  readonly params: CenterParams;
  private bondMesh: THREE.Sprite;
  private bondMaterial: THREE.SpriteMaterial;
  private bondColor = new THREE.Color();
  private smoothedBond = 0;
  private slots: (InstrumentCenterPiece | null)[] = [null, null];
  private slotVoices: VoiceState[] = [voiceStateZero(), voiceStateZero()];
  private registered?: ReturnType<typeof registerTweaks<typeof CENTER_DEFS>>;
  private leftScratch = new THREE.Vector3();
  private rightScratch = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private centerPos: THREE.Vector3,
    private paneDock?: HTMLElement,
    private onSparksConstructed?: (sparks: Sparks) => void,
  ) {
    this.params = { ...Object.fromEntries(Object.entries(CENTER_DEFS).map(([k, d]) => [k, d.default])) } as CenterParams;
    this.bondColor.set(this.params.bondColor);

    const bondTex = makeRadialGlowTexture();
    this.bondMaterial = new THREE.SpriteMaterial({
      map: bondTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.bondMesh = new THREE.Sprite(this.bondMaterial);
    this.bondMesh.position.copy(centerPos);
    this.bondMesh.frustumCulled = false;
    this.bondMesh.renderOrder = 14;
    scene.add(this.bondMesh);

    this.registered = registerTweaks(paneDock, 'centerStage', CENTER_DEFS, {
      title: 'Center Stage',
      params: this.params,
      onChange: {
        bondColor: v => this.bondColor.set(v),
      },
    });
  }

  setSlotInstrument(slot: Slot, instrumentId: InstrumentId | null): void {
    const current = this.slots[slot];
    if (current && current.id === instrumentId) return;
    if (current) {
      current.dispose();
      this.slots[slot] = null;
    }
    if (instrumentId) {
      const paneKey = `centerStage-${slot}-${instrumentId}`;
      this.slots[slot] = new InstrumentCenterPiece(
        this.scene,
        instrumentId,
        this.paneDock,
        paneKey,
        this.onSparksConstructed,
      );
    }
  }

  setSlotVoice(slot: Slot, voice: VoiceState): void {
    this.slotVoices[slot] = voice;
  }

  update(delta: number, elapsed: number): void {
    // Compute symmetric anchor pairs for each slot, mirrored about the
    // center pole. Slot 0 uses (-spread, +height, 0) → (+spread, +height, 0)
    // and slot 1 the same — but visually we want them to share the same arc
    // through the center, so both can use the same anchor pair.
    const sp = this.params.spread;
    const h = this.params.height;
    this.leftScratch.set(this.centerPos.x - sp, this.centerPos.y + h, this.centerPos.z);
    this.rightScratch.set(this.centerPos.x + sp, this.centerPos.y + h, this.centerPos.z);

    for (let slot = 0; slot < 2; slot++) {
      const piece = this.slots[slot];
      const voice = this.slotVoices[slot];
      if (!piece) continue;
      piece.setAnchors(this.leftScratch, this.rightScratch);
      piece.update(voice, delta, elapsed);
    }

    // Bond glow: fades in only when BOTH slots' energy is above threshold.
    const e0 = this.slotVoices[0].active ? this.slotVoices[0].energy : 0;
    const e1 = this.slotVoices[1].active ? this.slotVoices[1].energy : 0;
    const both = Math.min(e0, e1); // limited by the weaker side
    const target = both > this.params.bondThreshold
      ? Math.min(1, (both - this.params.bondThreshold) / (1 - this.params.bondThreshold))
      : 0;
    const alpha = 1 - Math.exp(-delta * 4);
    this.smoothedBond += (target - this.smoothedBond) * alpha;
    this.bondMaterial.opacity = this.smoothedBond * this.params.bondOpacity;
    this.bondMaterial.color.copy(this.bondColor);
    this.bondMesh.scale.setScalar(this.params.bondSize * (0.6 + 0.4 * this.smoothedBond));
  }

  dispose(): void {
    this.registered?.dispose();
    for (const slot of this.slots) slot?.dispose();
    this.bondMaterial.map?.dispose();
    this.bondMaterial.dispose();
    this.bondMesh.removeFromParent();
  }
}

function makeRadialGlowTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / maxR;
      const dy = (y - cy) / maxR;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = Math.max(0, 1 - r);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(Math.pow(a, 1.6) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
