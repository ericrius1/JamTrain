import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  cos,
  exp,
  float,
  mix,
  normalWorld,
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
  rippleSpeed:     { default: 1.05,  min: 0.2,  max: 4,    step: 0.01,  label: 'ripple speed' },
  rippleFreq:      { default: 26,    min: 4,    max: 80,   step: 0.5,   label: 'ripple freq' },
  rippleDecay:     { default: 1.35,  min: 0.2,  max: 4,    step: 0.05,  label: 'ripple decay s' },
  rippleSigma:     { default: 0.42,  min: 0.05, max: 1.5,  step: 0.01,  label: 'ripple sharpness' },
  rippleGlow:      { default: 1.45,  min: 0,    max: 4,    step: 0.05,  label: 'ripple glow' },
  hitDistance:     { default: 0.040, min: 0,    max: 0.12, step: 0.001, label: 'hit margin' },
  palmRadius:      { default: 0.060, min: 0.02, max: 0.12, step: 0.001, label: 'palm radius' },
  fingerRadius:    { default: 0.026, min: 0.01, max: 0.08, step: 0.001, label: 'finger radius' },
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
// Maximum simultaneous ripples per orb. Once exceeded, oldest is recycled.
const MAX_RIPPLES = 6;

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
    rippleSpeed:  uniform(params.rippleSpeed),
    rippleFreq:   uniform(params.rippleFreq),
    rippleDecay:  uniform(params.rippleDecay),
    rippleSigma:  uniform(params.rippleSigma),
    rippleGlow:   uniform(params.rippleGlow),
  };
}
type OrbUniforms = ReturnType<typeof createOrbUniforms>;

function createOrbPerInstanceUniforms() {
  return {
    elapsed: uniform(0),
    pulse: uniform(0),
  };
}
type OrbPerInstanceUniforms = ReturnType<typeof createOrbPerInstanceUniforms>;

type Orb = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicNodeMaterial;
  ripples: THREE.Vector4[];
  rippleCursor: number;
  lastHitAt: number;
  hitPulse: number;
  offset: THREE.Vector3;
  uniforms: OrbPerInstanceUniforms;
};

type OrbHitCandidate = {
  contact: HandContactPoint;
  speed: number;
};

const _palmTmp = new THREE.Vector3();
const _hitDir = new THREE.Vector3();
const _contactDelta = new THREE.Vector3();
const _orbCenter = new THREE.Vector3();

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
  private hitCandidates: (OrbHitCandidate | null)[] = Array.from({ length: ORB_COUNT }, () => null);
  private fallbackContacts: HandContactPoint[] = [
    { id: 'left:palm', hand: 'left', kind: 'palm', position: new THREE.Vector3() },
    { id: 'right:palm', hand: 'right', kind: 'palm', position: new THREE.Vector3() },
  ];

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

    const sphereGeo = new THREE.SphereGeometry(1, 32, 24);
    const offsets = makeOrbOffsets(this.params.ringRadius);

    for (let i = 0; i < ORB_COUNT; i += 1) {
      // Pre-fill ripple slots with sentinel w=-1 so they're inactive.
      const ripples: THREE.Vector4[] = [];
      for (let r = 0; r < MAX_RIPPLES; r += 1) ripples.push(new THREE.Vector4(0, 0, 0, -1));

      const orbUniforms = createOrbPerInstanceUniforms();

      const material = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: true,
      });
      material.colorNode = this.makeOrbColorNode(ripples, orbUniforms);

      const sphere = new THREE.Mesh(sphereGeo, material);
      sphere.scale.setScalar(this.params.orbRadius);
      sphere.position.copy(offsets[i]);
      sphere.renderOrder = 16;
      sphere.frustumCulled = false;
      this.mesh.add(sphere);

      this.orbs.push({
        mesh: sphere,
        material,
        ripples,
        rippleCursor: 0,
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
        rippleGlow:   v => { this.uniforms.rippleGlow.value = v; },
        orbRadius:    v => { for (const o of this.orbs) o.mesh.scale.setScalar(v); },
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
    // centers are current so both palms and fingertips query the same tree.
    for (let i = 0; i < ORB_COUNT; i += 1) {
      const orb = this.orbs[i];
      // Subtle bob — each orb has its own phase.
      const bob = Math.sin(this.elapsed * this.params.bobSpeed * 1.3 + i * 1.21) * this.params.bobAmount;
      orb.mesh.position.set(orb.offset.x, orb.offset.y + bob, orb.offset.z);
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

    for (const contact of contacts) {
      const previous = this.previousContacts.get(contact.id);
      if (!previous) {
        this.previousContacts.set(contact.id, contact.position.clone());
        continue;
      }

      const travel = _contactDelta.copy(contact.position).sub(previous).length();
      const speed = travel / delta;
      this.contactHits.length = 0;

      const contactRadius = contact.kind === 'palm' ? this.params.palmRadius : this.params.fingerRadius;
      this.collisionBVH.collectSweptPointHits(
        previous,
        contact.position,
        this.params.orbRadius + contactRadius + this.params.hitDistance,
        this.contactHits,
      );
      previous.copy(contact.position);

      if (speed <= this.params.hitVelMin) continue;

      for (const orbIndex of this.contactHits) {
        this.registerHitCandidate(orbIndex, contact, speed);
      }
    }

    for (let i = 0; i < ORB_COUNT; i += 1) {
      const candidate = this.hitCandidates[i];
      if (!candidate) continue;
      const orb = this.orbs[i];
      if (this.elapsed - orb.lastHitAt <= this.params.hitCooldown) continue;
      this.fireHit(i, candidate.contact, candidate.speed);
    }
  }

  private registerHitCandidate(orbIndex: number, contact: HandContactPoint, speed: number): void {
    const existing = this.hitCandidates[orbIndex];
    if (!existing || speed > existing.speed) this.hitCandidates[orbIndex] = { contact, speed };
  }

  private fireHit(orbIndex: number, contact: HandContactPoint, speed: number): void {
    const orb = this.orbs[orbIndex];
    orb.lastHitAt = this.elapsed;

    this.collisionBVH.getPoint(orbIndex, _orbCenter);
    _hitDir.copy(contact.position).sub(_orbCenter).normalize();
    if (!Number.isFinite(_hitDir.x) || _hitDir.lengthSq() < 1e-6) _hitDir.set(0, 1, 0);

    const slot = orb.rippleCursor % MAX_RIPPLES;
    orb.ripples[slot].set(_hitDir.x, _hitDir.y, _hitDir.z, this.elapsed);
    orb.rippleCursor = (orb.rippleCursor + 1) % MAX_RIPPLES;

    const velocity = clamp(speed / 1.6, 0.18, 1);
    orb.hitPulse = Math.min(1, orb.hitPulse + 0.5 + velocity * 0.5);
    if (this.onHitCallback) {
      this.onHitCallback({ orbIndex, frequency: ORB_HZ[orbIndex], velocity });
    }
  }

  private makeOrbColorNode(
    ripples: THREE.Vector4[],
    perOrb: OrbPerInstanceUniforms,
  ) {
    const rippleArr = uniformArray(ripples, 'vec4');
    const u = this.uniforms;

    return Fn(() => {
      // Steel-drum base lighting — fake key light + fresnel rim. No real
      // PBR; everything goes through MeshBasicNodeMaterial per the project
      // convention.
      const n = normalWorld;
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

      // Ripple accumulation — sum traveling damped sine waves emanating from
      // each active hit point. Multiple ripples interfere additively, so
      // overlapping wavefronts brighten (constructive) or cancel (destructive).
      const rippleAccum = float(0).toVar('rippleAccum');
      const surfDir = positionLocal.normalize().toVar('surfDir');

      for (let i = 0; i < MAX_RIPPLES; i += 1) {
        // The TSL element node loses its vec4 type tag through the generic
        // signature, so coerce the element to the explicit vec4 path.
        const rippleAny = rippleArr.element(i) as unknown as ReturnType<typeof vec4>;
        const ripple = rippleAny;
        const center = ripple.xyz;
        const startTime = ripple.w;
        const age = perOrb.elapsed.sub(startTime);

        // active = startTime >= 0 AND age < 3s. Fold both into a smoothstep
        // mask so we don't need If branches in the TSL graph.
        const aliveMask = smoothstep(float(0), float(0.02), startTime.add(0.5))
          .mul(float(1).sub(smoothstep(float(2.4), float(3.0), age)));

        // Geodesic distance on unit sphere = angle between this surface
        // direction and the ripple's strike direction. acos is stable in
        // [-1,1].
        const cosA = surfDir.dot(center).clamp(-0.9999, 0.9999);
        const angle = cosA.acos();

        // Wave packet position = age * speed. Offset = angle - front.
        const front = age.mul(u.rippleSpeed);
        const offset = angle.sub(front);

        // Gaussian envelope keeps the wave packet localized — sigma controls
        // the radial sharpness.
        const offsetN = offset.div(u.rippleSigma);
        const envSpace = exp(offsetN.mul(offsetN).negate());
        const envTime = exp(age.div(u.rippleDecay).negate());
        // Fade the *back* of the sphere — ripples wrap visibly but quietly.
        const backFade = exp(angle.mul(0.4).negate());

        // Sine wave at the configured spatial frequency.
        const wave = sin(offset.mul(u.rippleFreq));

        rippleAccum.addAssign(wave.mul(envSpace).mul(envTime).mul(backFade).mul(aliveMask));
      }

      // Convert accumulated wave height into a brightness boost. abs() so
      // both peaks and troughs glow (gives the look of standing waves).
      const glow = rippleAccum.abs().mul(u.rippleGlow);
      lit.addAssign(u.hotColor.mul(glow));

      // Hit flash — subtle global lift on each orb at the moment of contact.
      const flash = perOrb.pulse.mul(float(0.35)).mul(float(1).sub(fres.mul(0.6)));
      lit.addAssign(u.rimColor.mul(flash));

      // Subtle iridescent shimmer — a slow cosine band against view-aligned
      // latitude — so the orbs don't read as flat at rest.
      const shimmer = cos(positionLocal.y.mul(8).add(perOrb.elapsed.mul(0.6))).mul(0.06).mul(fres);
      lit.addAssign(u.hotColor.mul(shimmer));

      return lit;
    })();
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
