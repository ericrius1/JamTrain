import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  cos,
  exp,
  float,
  mix,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  vec3,
  vec4,
} from 'three/tsl';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { HandContactPoint, PlayerVisual, VoiceState } from '../instruments';
import { clamp } from '../math';
import { OrbCollisionBVH } from './orbs/OrbCollisionBVH';

export const ORB_DRUMS_DEFS = {
  orbRadius:       { default: 0.085, min: 0.04, max: 0.16, step: 0.001, label: 'orb radius' },
  ringRadius:      { default: 0.24,  min: 0.10, max: 0.50, step: 0.005, label: 'ring radius' },
  bobAmount:       { default: 0.012, min: 0,    max: 0.06, step: 0.001, label: 'bob amount' },
  bobSpeed:        { default: 0.7,   min: 0,    max: 3,    step: 0.05,  label: 'bob speed' },
  rippleSpeed:     { default: 1.55,  min: 0.2,  max: 4,    step: 0.01,  label: 'wave speed' },
  rippleFreq:      { default: 22,    min: 4,    max: 80,   step: 0.5,   label: 'wave number' },
  rippleDecay:     { default: 2.4,   min: 0.2,  max: 4,    step: 0.05,  label: 'wave decay s' },
  rippleSigma:     { default: 0.24,  min: 0.05, max: 1.5,  step: 0.01,  label: 'packet width' },
  rippleDisplace:  { default: 0.030, min: 0,    max: 0.12, step: 0.001, label: 'surface ripple' },
  rippleGlow:      { default: 1.15,  min: 0,    max: 4,    step: 0.05,  label: 'crest glow' },
  hitDistance:     { default: 0.055, min: 0,    max: 0.14, step: 0.001, label: 'hit margin' },
  palmRadius:      { default: 0.080, min: 0.02, max: 0.14, step: 0.001, label: 'palm radius' },
  fingerRadius:    { default: 0.038, min: 0.01, max: 0.10, step: 0.001, label: 'finger radius' },
  hitCooldown:     { default: 0.10,  min: 0.03, max: 0.6,  step: 0.005, label: 'hit cooldown s' },
  hitVelMin:       { default: 0.02,  min: 0,    max: 1,    step: 0.005, label: 'hit vel min m/s' },
  anchorSmoothing: { default: 4.0,   min: 0.2,  max: 12,   step: 0.1,   label: 'anchor smoothing s' },
  baseColor:       { type: 'color', default: '#1d3247', label: 'base' },
  rimColor:        { type: 'color', default: '#7ad9ff', label: 'rim' },
  hotColor:        { type: 'color', default: '#fff8d6', label: 'hot' },
} as const;

export type OrbDrumsParams = ParamsOf<typeof ORB_DRUMS_DEFS>;

export type OrbHit = {
  /** Index of the orb (0..ORB_COUNT-1). */
  orbIndex: number;
  /** Hertz — pre-computed for the orb's note. */
  frequency: number;
  /** 0..1 normalized hit velocity. */
  velocity: number;
};

type OrbDrumsPalette = 'local' | 'remote';

type OrbDrumsOptions = {
  palette?: OrbDrumsPalette;
  title?: string;
  onHit?: (event: OrbHit) => void;
};

// 7 orbs in a hang-drum-style hex pattern: 1 center "ding" + 6 outer notes.
const ORB_COUNT = 7;
// Maximum simultaneous wave impulses shared by the orb cluster. Once exceeded,
// the oldest impulse is recycled. Keep enough history for overlapping strikes
// to meet instead of making a new hit feel like it erased the previous one.
const MAX_RIPPLES = 15;
const RIPPLE_MAX_AGE = 5.2;

type AnyNode = any;

// D minor pentatonic across one octave above D3, with the center orb at the
// low D3 "ding". Reads like a real handpan: low fundamental + 6 melody fields.
//   center: D3
//   outer:  F3, G3, A3, C4, D4, F4
const ORB_HZ: number[] = [
  146.832,  // D3 — center "ding"
  174.614,  // F3
  195.998,  // G3
  220.000,  // A3
  261.626,  // C4
  293.665,  // D4
  349.228,  // F4
];

// Local-space offsets (relative to anchor) for each orb. y stays at 0 — orbs
// float on a flat horizontal plane in front of the player.
function makeOrbOffsets(ringRadius: number): THREE.Vector3[] {
  const offsets: THREE.Vector3[] = [new THREE.Vector3(0, 0, 0)];
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
    offsets.push(new THREE.Vector3(
      Math.cos(angle) * ringRadius,
      Math.sin(angle * 0.5) * ringRadius * 0.18, // tiny vertical wobble per orb
      Math.sin(angle) * ringRadius,
    ));
  }
  return offsets;
}

function createOrbUniforms(params: OrbDrumsParams) {
  return {
    baseColor:    uniform(new THREE.Color(params.baseColor)),
    rimColor:     uniform(new THREE.Color(params.rimColor)),
    hotColor:     uniform(new THREE.Color(params.hotColor)),
    orbRadius:    uniform(params.orbRadius),
    rippleSpeed:  uniform(params.rippleSpeed),
    rippleFreq:   uniform(params.rippleFreq),
    rippleDecay:  uniform(params.rippleDecay),
    rippleSigma:  uniform(params.rippleSigma),
    rippleDisplace: uniform(params.rippleDisplace),
    rippleGlow:   uniform(params.rippleGlow),
  };
}
type OrbUniforms = ReturnType<typeof createOrbUniforms>;

function createOrbPerInstanceUniforms() {
  return {
    elapsed: uniform(0),
    pulse: uniform(0),
    offset: uniform(new THREE.Vector3()),
  };
}
type OrbPerInstanceUniforms = ReturnType<typeof createOrbPerInstanceUniforms>;

type Orb = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicNodeMaterial;
  lastHitAt: number;
  hitPulse: number;
  offset: THREE.Vector3;
  uniforms: OrbPerInstanceUniforms;
};

type OrbHitCandidate = {
  contact: HandContactPoint;
  point: THREE.Vector3;
  speed: number;
};

const _palmTmp = new THREE.Vector3();
const _hitDir = new THREE.Vector3();
const _contactDelta = new THREE.Vector3();
const _orbCenter = new THREE.Vector3();
const _strikePoint = new THREE.Vector3();
const _segment = new THREE.Vector3();
const _pointToStart = new THREE.Vector3();

export class OrbDrums implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: OrbDrumsParams;

  private orbs: Orb[] = [];
  private elapsed = 0;
  private active = true;
  private initialized = false;
  private anchor = new THREE.Vector3();
  private smoothedEnergy = 0;
  private collisionBVH = new OrbCollisionBVH(ORB_COUNT);
  private previousContacts = new Map<string, THREE.Vector3>();
  private contactHits: number[] = [];
  private currentContactHits: number[] = [];
  private hitCandidates: (OrbHitCandidate | null)[] = Array.from({ length: ORB_COUNT }, () => null);
  private activeContactKeys = new Set<string>();
  private currentContactKeys = new Set<string>();
  private fallbackContacts: HandContactPoint[] = [
    { id: 'left:palm', hand: 'left', kind: 'palm', position: new THREE.Vector3() },
    { id: 'right:palm', hand: 'right', kind: 'palm', position: new THREE.Vector3() },
  ];
  private rippleSources: THREE.Vector4[] = [];
  private rippleStarts: number[] = [];
  private rippleCursor = 0;

  private uniforms: OrbUniforms;

  private onHitCallback?: (e: OrbHit) => void;
  private registered?: ReturnType<typeof registerTweaks<typeof ORB_DRUMS_DEFS>>;

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey = 'orbDrums', opts: OrbDrumsOptions = {}) {
    this.params = { ...Object.fromEntries(Object.entries(ORB_DRUMS_DEFS).map(([k, d]) => [k, d.default])) } as OrbDrumsParams;
    applyPaletteDefaults(this.params, opts.palette ?? 'local');
    this.onHitCallback = opts.onHit;

    this.mesh = new THREE.Group();
    this.mesh.name = `orb-drums-${opts.palette ?? 'local'}`;
    scene.add(this.mesh);

    this.uniforms = createOrbUniforms(this.params);
    for (let r = 0; r < MAX_RIPPLES; r += 1) {
      this.rippleSources.push(new THREE.Vector4(0, 0, 0, 0));
      this.rippleStarts.push(-1);
    }

    const sphereGeo = new THREE.SphereGeometry(1, 32, 24);
    const offsets = makeOrbOffsets(this.params.ringRadius);

    for (let i = 0; i < ORB_COUNT; i += 1) {
      const orbUniforms = createOrbPerInstanceUniforms();
      orbUniforms.offset.value.copy(offsets[i]);

      const material = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: true,
      });
      const nodes = this.makeOrbNodes(orbUniforms);
      material.positionNode = nodes.positionNode;
      material.colorNode = nodes.colorNode;

      const sphere = new THREE.Mesh(sphereGeo, material);
      sphere.scale.setScalar(this.params.orbRadius);
      sphere.position.copy(offsets[i]);
      sphere.renderOrder = 16;
      sphere.frustumCulled = false;
      this.mesh.add(sphere);

      this.orbs.push({
        mesh: sphere,
        material,
        lastHitAt: -10,
        hitPulse: 0,
        offset: offsets[i].clone(),
        uniforms: orbUniforms,
      });
    }

    this.registered = registerTweaks(paneDock, paneKey, ORB_DRUMS_DEFS, {
      title: opts.title ?? 'Hang Orbs',
      params: this.params,
      onChange: {
        baseColor:    () => this.uniforms.baseColor.value.set(this.params.baseColor),
        rimColor:     () => this.uniforms.rimColor.value.set(this.params.rimColor),
        hotColor:     () => this.uniforms.hotColor.value.set(this.params.hotColor),
        rippleSpeed:  v => { this.uniforms.rippleSpeed.value = v; },
        rippleFreq:   v => { this.uniforms.rippleFreq.value = v; },
        rippleDecay:  v => { this.uniforms.rippleDecay.value = v; },
        rippleSigma:  v => { this.uniforms.rippleSigma.value = v; },
        rippleDisplace: v => { this.uniforms.rippleDisplace.value = v; },
        rippleGlow:   v => { this.uniforms.rippleGlow.value = v; },
        orbRadius:    v => {
          this.uniforms.orbRadius.value = v;
          for (const o of this.orbs) o.mesh.scale.setScalar(v);
        },
        ringRadius:   () => this.layoutOrbs(),
      },
    });
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
  }

  update(
    leftPalm: THREE.Vector3,
    rightPalm: THREE.Vector3,
    voice: VoiceState,
    delta: number,
    contacts?: readonly HandContactPoint[],
  ): void {
    if (!this.active) return;
    if (delta <= 0) return;

    this.elapsed += delta;

    if (!this.initialized) {
      this.anchor.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
      this.anchor.z -= 0.06;
      this.initialized = true;
      this.placeGroup();
    }

    // Anchor follows hand cloud center with strong smoothing — feels like a
    // table you've placed in front of you, not glued to your palms.
    _palmTmp.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
    _palmTmp.z -= 0.06;
    const alpha = 1 - Math.exp(-delta / Math.max(0.05, this.params.anchorSmoothing));
    this.anchor.lerp(_palmTmp, alpha);
    this.placeGroup();

    this.smoothedEnergy += (voice.energy - this.smoothedEnergy) * (1 - Math.exp(-delta * 5));

    // Per-orb update: bob and BVH sync. Hit detection runs once after all
    // centers are current so palms and finger joints query the same tree.
    for (let i = 0; i < ORB_COUNT; i += 1) {
      const orb = this.orbs[i];
      // Subtle bob — each orb has its own phase.
      const bob = Math.sin(this.elapsed * this.params.bobSpeed * 1.3 + i * 1.21) * this.params.bobAmount;
      orb.mesh.position.set(orb.offset.x, orb.offset.y + bob, orb.offset.z);
      orb.uniforms.offset.value.copy(orb.mesh.position);
      _orbCenter.copy(this.mesh.position).add(orb.mesh.position);
      this.collisionBVH.setPoint(i, _orbCenter.x, _orbCenter.y, _orbCenter.z);
    }

    this.collisionBVH.refit();
    this.processContactHits(this.resolveContacts(leftPalm, rightPalm, contacts), delta);

    for (const orb of this.orbs) {
      // Decay the per-orb hit flash and push into shader uniform.
      orb.hitPulse = Math.max(0, orb.hitPulse - delta * 2.4);
      orb.uniforms.pulse.value = orb.hitPulse;
      orb.uniforms.elapsed.value = this.elapsed;
    }

    void voice;
  }

  dispose(): void {
    this.registered?.dispose();
    for (const orb of this.orbs) {
      orb.mesh.geometry.dispose();
      orb.material.dispose();
    }
    this.collisionBVH.dispose();
    this.mesh.removeFromParent();
  }

  private placeGroup(): void {
    this.mesh.position.copy(this.anchor);
  }

  private layoutOrbs(): void {
    const offsets = makeOrbOffsets(this.params.ringRadius);
    for (let i = 0; i < this.orbs.length; i += 1) {
      this.orbs[i].offset.copy(offsets[i]);
      this.orbs[i].uniforms.offset.value.copy(offsets[i]);
    }
  }

  private resolveContacts(
    leftPalm: THREE.Vector3,
    rightPalm: THREE.Vector3,
    contacts?: readonly HandContactPoint[],
  ): readonly HandContactPoint[] {
    if (contacts && contacts.length > 0) return contacts;
    this.fallbackContacts[0].position.copy(leftPalm);
    this.fallbackContacts[1].position.copy(rightPalm);
    return this.fallbackContacts;
  }

  private processContactHits(contacts: readonly HandContactPoint[], delta: number): void {
    this.hitCandidates.fill(null);
    this.currentContactKeys.clear();

    for (const contact of contacts) {
      let previous = this.previousContacts.get(contact.id);
      if (!previous) {
        previous = contact.position.clone();
        this.previousContacts.set(contact.id, previous);
      }

      const travel = _contactDelta.copy(contact.position).sub(previous).length();
      const speed = travel / delta;
      this.contactHits.length = 0;
      this.currentContactHits.length = 0;

      const contactRadius = contact.kind === 'palm' ? this.params.palmRadius : this.params.fingerRadius;
      const hitRadius = this.params.orbRadius + contactRadius + this.params.hitDistance;
      this.collisionBVH.collectPointHits(contact.position, hitRadius, this.currentContactHits);
      this.collisionBVH.collectSweptPointHits(previous, contact.position, hitRadius, this.contactHits);

      for (const orbIndex of this.currentContactHits) {
        this.currentContactKeys.add(this.contactKey(contact.id, orbIndex));
      }

      const fastEnough = speed > this.params.hitVelMin;
      for (const orbIndex of this.contactHits) {
        const key = this.contactKey(contact.id, orbIndex);
        const currentlyOverlapping = this.currentContactHits.includes(orbIndex);
        const entered = currentlyOverlapping && !this.activeContactKeys.has(key);
        const sweptAcross = !currentlyOverlapping && fastEnough;
        if (!entered && !sweptAcross) continue;

        const point = currentlyOverlapping
          ? contact.position
          : this.closestSweepPoint(orbIndex, previous, contact.position, _strikePoint);
        this.registerHitCandidate(orbIndex, contact, speed, point);
      }

      previous.copy(contact.position);
    }

    for (let i = 0; i < ORB_COUNT; i += 1) {
      const candidate = this.hitCandidates[i];
      if (!candidate) continue;
      const orb = this.orbs[i];
      if (this.elapsed - orb.lastHitAt <= this.params.hitCooldown) continue;
      this.fireHit(i, candidate.contact, candidate.speed);
    }

    this.activeContactKeys.clear();
    for (const key of this.currentContactKeys) this.activeContactKeys.add(key);
  }

  private registerHitCandidate(orbIndex: number, contact: HandContactPoint, speed: number, point: THREE.Vector3): void {
    const existing = this.hitCandidates[orbIndex];
    if (!existing || speed > existing.speed) this.hitCandidates[orbIndex] = { contact, point: point.clone(), speed };
  }

  private fireHit(orbIndex: number, contact: HandContactPoint, speed: number): void {
    const orb = this.orbs[orbIndex];
    orb.lastHitAt = this.elapsed;

    this.collisionBVH.getPoint(orbIndex, _orbCenter);
    const candidate = this.hitCandidates[orbIndex];
    _hitDir.copy(candidate?.point ?? contact.position).sub(_orbCenter).normalize();
    if (!Number.isFinite(_hitDir.x) || _hitDir.lengthSq() < 1e-6) _hitDir.set(0, 1, 0);

    const velocity = clamp(speed / 1.6, 0.18, 1);

    const slot = this.rippleCursor % MAX_RIPPLES;
    _strikePoint.copy(orb.mesh.position).addScaledVector(_hitDir, this.params.orbRadius);
    this.rippleSources[slot].set(_strikePoint.x, _strikePoint.y, _strikePoint.z, velocity);
    this.rippleStarts[slot] = this.elapsed;
    this.rippleCursor = (this.rippleCursor + 1) % MAX_RIPPLES;

    orb.hitPulse = Math.min(1, orb.hitPulse + 0.5 + velocity * 0.5);
    if (this.onHitCallback) {
      this.onHitCallback({ orbIndex, frequency: ORB_HZ[orbIndex], velocity });
    }
  }

  private contactKey(contactId: string, orbIndex: number): string {
    return `${contactId}:${orbIndex}`;
  }

  private closestSweepPoint(
    orbIndex: number,
    from: THREE.Vector3,
    to: THREE.Vector3,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    this.collisionBVH.getPoint(orbIndex, _orbCenter);
    _segment.copy(to).sub(from);
    const lenSq = _segment.lengthSq();
    if (lenSq <= 1e-8) return out.copy(to);
    _pointToStart.copy(_orbCenter).sub(from);
    const t = THREE.MathUtils.clamp(_pointToStart.dot(_segment) / lenSq, 0, 1);
    return out.copy(from).addScaledVector(_segment, t);
  }

  private makeOrbNodes(
    perOrb: OrbPerInstanceUniforms,
  ) {
    const rippleSourceArr = uniformArray(this.rippleSources, 'vec4');
    const rippleStartArr = uniformArray(this.rippleStarts, 'float');
    const u = this.uniforms;

    const waveField = Fn(([samplePos]: AnyNode[]) => {
      const height = float(0).toVar();
      const energy = float(0).toVar();

      for (let i = 0; i < MAX_RIPPLES; i += 1) {
        const rippleAny = rippleSourceArr.element(i) as unknown as ReturnType<typeof vec4>;
        const source = rippleAny;
        const startTime = rippleStartArr.element(i) as AnyNode;
        const age = perOrb.elapsed.sub(startTime);
        const intensity = source.w;

        const aliveMask = smoothstep(float(0), float(0.025), startTime.add(0.5))
          .mul(smoothstep(float(0), float(0.045), age))
          .mul(float(1).sub(smoothstep(float(RIPPLE_MAX_AGE - 0.7), float(RIPPLE_MAX_AGE), age)))
          .mul(smoothstep(float(0.001), float(0.01), intensity));

        // The flat MidiRipples shader sums signed analytical wave heights. Here
        // the same idea is sampled over the cluster in orb-radius units, so a
        // strike on one sphere can travel onto nearby spheres and interfere
        // with later strikes.
        const dist = samplePos.sub(source.xyz).length().div(u.orbRadius.max(0.001));
        const wavefront = dist.sub(u.rippleSpeed.mul(age));
        const packetWidth = u.rippleSigma.add(age.mul(0.055));
        const envelope = exp(wavefront.mul(wavefront).div(packetWidth.mul(packetWidth)).negate());
        const ripple = sin(wavefront.mul(u.rippleFreq));
        const spread = float(1).div(dist.mul(1.8).sqrt().max(0.35));
        const decay = exp(age.div(u.rippleDecay).negate());
        const component = ripple.mul(envelope).mul(spread).mul(decay).mul(intensity).mul(aliveMask);

        height.addAssign(component);
        energy.addAssign(component.abs());
      }

      return vec4(energy, float(0), float(0), height);
    });

    const clusterSurface = Fn(([surfaceDir]: AnyNode[]) => {
      return perOrb.offset.add(surfaceDir.mul(u.orbRadius));
    });

    const positionNode = Fn(() => {
      const surfDir = positionLocal.normalize().toVar('orbPosDir');
      const h = waveField(clusterSurface(surfDir)).w.clamp(-1.8, 1.8);
      return surfDir.mul(float(1).add(h.mul(u.rippleDisplace)));
    })();

    const colorNode = Fn(() => {
      // Steel-drum base lighting — fake key light + fresnel rim. No real
      // PBR; everything goes through MeshBasicNodeMaterial per the project
      // convention.
      const surfDir = positionLocal.normalize().toVar('orbSurfDir');
      const samplePos = clusterSurface(surfDir).toVar('orbSamplePos');
      const centerField = waveField(samplePos).toVar('orbWaveField');
      const h = centerField.w.toVar('orbHeight');
      const packetEnergy = centerField.x.clamp(0, 1.8).toVar('orbPacketEnergy');

      // Finite differences on the sphere: sample the shared wave field in two
      // tangent directions, then bend the lighting normal by the signed height
      // gradient. This makes interference read as a fluid surface instead of
      // painted contour lines.
      const seed = surfDir.y.abs().lessThan(0.92).select(vec3(0, 1, 0), vec3(1, 0, 0));
      const tangentA = seed.cross(surfDir).normalize().toVar('orbTangentA');
      const tangentB = surfDir.cross(tangentA).normalize().toVar('orbTangentB');
      const eps = float(0.036);
      const posA = clusterSurface(surfDir.add(tangentA.mul(eps)).normalize());
      const posB = clusterSurface(surfDir.add(tangentB.mul(eps)).normalize());
      const dhA = waveField(posA).w.sub(h).div(eps);
      const dhB = waveField(posB).w.sub(h).div(eps);
      const waveNormal = surfDir
        .sub(tangentA.mul(dhA).mul(0.115))
        .sub(tangentB.mul(dhB).mul(0.115))
        .normalize()
        .toVar('orbWaveNormal');

      const n = waveNormal;
      const view = cameraPosition.sub(positionWorld).normalize();
      const fres = float(1).sub(n.dot(view).abs()).clamp(0, 1);
      const keyDir = vec3(0.45, 0.78, 0.42).normalize();
      const ndl = n.dot(keyDir).mul(0.5).add(0.5);
      // Soft latitude shading — equator slightly darker than poles for
      // that cast-metal read.
      const latShade = float(1).sub(float(1).sub(positionLocal.y.abs()).mul(0.18));

      const lit = mix(
        u.baseColor.mul(0.45),
        u.baseColor,
        smoothstep(float(0), float(1), ndl),
      ).mul(latShade).toVar('lit');

      // Fresnel rim — bright cyan halo at the silhouette.
      const rim = pow(fres, float(2.2)).mul(0.85);
      lit.addAssign(u.rimColor.mul(rim));

      const waveEnergy = h.abs().clamp(0, 1.4);
      const crest = smoothstep(float(0.08), float(0.54), h);
      const trough = smoothstep(float(0.08), float(0.54), h.negate());
      const slope = dhA.abs().add(dhB.abs()).mul(0.22).clamp(0, 1.2);
      const halfDir = keyDir.add(view).normalize();
      const visibleWave = packetEnergy.mul(0.62).add(waveEnergy.mul(0.38)).clamp(0, 1.6);
      const spec = pow(n.dot(halfDir).max(0), float(38)).mul(visibleWave).mul(float(0.55).add(u.rippleGlow.mul(0.28)));
      const edgeGlint = smoothstep(float(0.14), float(0.82), slope).mul(visibleWave).mul(0.22);

      lit.addAssign(u.hotColor.mul(crest.mul(u.rippleGlow).mul(0.52)));
      lit.addAssign(u.rimColor.mul(visibleWave.mul(0.13).add(edgeGlint)));
      lit.addAssign(u.hotColor.mul(spec));
      lit.assign(lit.mul(float(1).sub(trough.mul(0.30))));

      // Hit flash — subtle global lift on each orb at the moment of contact.
      const flash = perOrb.pulse.mul(float(0.35)).mul(float(1).sub(fres.mul(0.6)));
      lit.addAssign(u.rimColor.mul(flash));

      // Subtle iridescent shimmer — a slow cosine band against view-aligned
      // latitude — so the orbs don't read as flat at rest.
      const shimmer = cos(positionLocal.y.mul(8).add(perOrb.elapsed.mul(0.6))).mul(0.06).mul(fres);
      lit.addAssign(u.hotColor.mul(shimmer));

      return lit;
    })();

    return { colorNode, positionNode };
  }
}

function applyPaletteDefaults(params: OrbDrumsParams, palette: OrbDrumsPalette): void {
  if (palette === 'remote') {
    params.baseColor = '#37183a';
    params.rimColor = '#ff7ad6';
    params.hotColor = '#fff0fb';
    return;
  }
  // local — cool blue steel drum
  params.baseColor = '#1d3247';
  params.rimColor = '#7ad9ff';
  params.hotColor = '#fff8d6';
}
