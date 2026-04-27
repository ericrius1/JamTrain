import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { PlayerVisual, VoiceState } from '../instruments';
import { clamp } from '../math';
import { VerletChain } from './chime/VerletChain';
import { ChimeBVH, type GemPair } from './chime/ChimeBVH';

export const WIND_CHIME_DEFS = {
  ringRadius:    { default: 0.18,   min: 0.10, max: 0.6,  step: 0.01,  label: 'ring radius' },
  ringTube:      { default: 0.014,  min: 0.004, max: 0.04, step: 0.001, label: 'ring tube' },
  stringLength:  { default: 0.5,    min: 0.2,  max: 1.0,  step: 0.01,  label: 'string length' },
  gemRadius:     { default: 0.028,  min: 0.012, max: 0.05, step: 0.001, label: 'gem radius' },
  gravity:       { default: 5.6,    min: 1,    max: 14,   step: 0.1,   label: 'gravity' },
  damping:       { default: 0.985,  min: 0.92, max: 0.999, step: 0.001, label: 'damping' },
  windGain:      { default: 24,     min: 0,    max: 60,   step: 0.5,   label: 'wind gain' },
  turbulence:    { default: 1.2,    min: 0,    max: 6,    step: 0.05,  label: 'turbulence' },
  contactRadius: { default: 0.16,   min: 0.04, max: 0.30, step: 0.005, label: 'hand contact' },
  contactPush:   { default: 1.4,    min: 0,    max: 4,    step: 0.05,  label: 'hand push' },
  hitVelMin:     { default: 0.06,   min: 0,    max: 4,    step: 0.01,  label: 'hit vel min m/s' },
  hitCooldown:   { default: 0.08,   min: 0.02, max: 0.5,  step: 0.005, label: 'hit cooldown s' },
  pulseDecay:    { default: 4.5,    min: 0.5,  max: 14,   step: 0.1,   label: 'glow decay' },
  anchorSmoothing:{ default: 5.0,   min: 0.2,  max: 12,   step: 0.1,   label: 'anchor smoothing s' },
  gemColor:      { type: 'color', default: '#ffd166', label: 'gem' },
  hotColor:      { type: 'color', default: '#fff7d6', label: 'gem hot' },
  ringColor:     { type: 'color', default: '#a16e2c', label: 'ring' },
  stringColor:   { type: 'color', default: '#f6bd4b', label: 'string' },
} as const;

export type WindChimeParams = ParamsOf<typeof WIND_CHIME_DEFS>;

type WindChimePalette = 'local' | 'remote';

type WindChimeOptions = {
  palette?: WindChimePalette;
  title?: string;
  /** Fired on every gem chime. Caller decides how to play it. */
  onHit?: (event: ChimeHit) => void;
};

export type ChimeHit = {
  /** 0..31, gem index across all strings. */
  gemIndex: number;
  /** Hertz. Pre-computed from the gem's note. */
  frequency: number;
  /** 0..1 normalized hit velocity (clamped). Drives volume. */
  velocity: number;
};

const STRING_COUNT = 8;
const GEMS_PER_STRING = 4;
const GEM_COUNT = STRING_COUNT * GEMS_PER_STRING;
// 1 root + 1 top hanger + 4 gem nodes — the hanger gives a visible neck
// between the ring and the first gem so strings don't look fused to the ring.
const NODES_PER_STRING = 1 + 1 + GEMS_PER_STRING;
const FIRST_GEM_NODE = 2;

// D pentatonic — 8 strings cover root..fifth wrapping; per-string octaves
// stack four times so each string carries the same scale degree at four
// pitches. Scale degree (semitones-from-D) per string: D, E, F#, A, B, D, E,
// F# — first 5 in one register, last 3 the next register up.
const STRING_SEMITONES_FROM_D3 = [0, 2, 4, 7, 9, 12, 14, 16];
// Highest gem (closest to ring) plays the highest octave. Index k = 0..3:
// gem at chain node FIRST_GEM_NODE+k, top-down, plays octave 3+(3-k).
const D3_HZ = 146.832; // 261.63 / 2^(3-1) ish; computed precisely below.

function noteFreqHz(semitonesFromD3: number): number {
  return D3_HZ * Math.pow(2, semitonesFromD3 / 12);
}

const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector3();
const _tmpMat = new THREE.Matrix4();
const _tmpQuat = new THREE.Quaternion();
const _scaleVec = new THREE.Vector3();
const TAU = Math.PI * 2;

export class WindChime implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: WindChimeParams;

  private chains: VerletChain[] = [];
  private chimeBVH!: ChimeBVH;
  private ringMesh: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private gemsMesh: THREE.InstancedMesh;
  private gemMat: THREE.MeshBasicMaterial;
  private gemHitPulse = new Float32Array(GEM_COUNT);
  private gemBaseColor = new THREE.Color();
  private gemHotColor = new THREE.Color();
  private gemColorScratch = new THREE.Color();
  /** Note frequency per gem, in Hz. */
  private gemFrequencies = new Float32Array(GEM_COUNT);
  /** Time stamp of last triggered hit per gem (cooldown gate). */
  private gemHitAt = new Float32Array(GEM_COUNT);
  private stringLines: THREE.Line[] = [];
  private stringMats: THREE.LineBasicMaterial[] = [];
  private stringPositions: Float32Array[] = [];

  private elapsed = 0;
  private active = true;
  private initialized = false;
  // Most recent verlet substep dt — used to convert raw position-delta from
  // chain.positions/previous into a proper m/s velocity for hit gating.
  private lastSubstepDt = 0.008;
  private debugStatsAt = 0;
  private gemHitCount = 0;
  private handHitCount = 0;

  private anchor = new THREE.Vector3();
  private leftPrev = new THREE.Vector3();
  private rightPrev = new THREE.Vector3();
  private rightVel = new THREE.Vector3();
  private windAccum = new THREE.Vector3();
  private smoothedEnergy = 0;
  private smoothedWindStrength = 0;
  private smoothedWarmth = 0.5;

  private onHitCallback?: (e: ChimeHit) => void;
  private gemPairs: GemPair[] = [];
  private handHits: number[] = [];

  private registered?: ReturnType<typeof registerTweaks<typeof WIND_CHIME_DEFS>>;

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey = 'windChime', opts: WindChimeOptions = {}) {
    this.params = { ...Object.fromEntries(Object.entries(WIND_CHIME_DEFS).map(([k, d]) => [k, d.default])) } as WindChimeParams;
    applyPaletteDefaults(this.params, opts.palette ?? 'local');
    this.onHitCallback = opts.onHit;

    this.mesh = new THREE.Group();
    this.mesh.name = `wind-chime-${opts.palette ?? 'local'}`;
    scene.add(this.mesh);

    // Ring — a slim torus floating above the hand center.
    this.ringMat = new THREE.MeshBasicMaterial({
      color: this.params.ringColor,
      transparent: true,
      opacity: 0.9,
    });
    const ringGeo = new THREE.TorusGeometry(this.params.ringRadius, this.params.ringTube, 8, 48);
    this.ringMesh = new THREE.Mesh(ringGeo, this.ringMat);
    this.ringMesh.rotation.x = Math.PI / 2;
    this.ringMesh.renderOrder = 14;
    this.mesh.add(this.ringMesh);

    // Gems — InstancedMesh of small octahedrons. Per-instance color carries
    // the hit pulse highlight so a recent collision visibly brightens.
    const gemGeo = new THREE.OctahedronGeometry(1, 0);
    this.gemMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.gemsMesh = new THREE.InstancedMesh(gemGeo, this.gemMat, GEM_COUNT);
    this.gemsMesh.frustumCulled = false;
    this.gemsMesh.renderOrder = 18;
    this.gemsMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GEM_COUNT * 3), 3);
    this.mesh.add(this.gemsMesh);

    // Strings — one Line per chain. We render the raw chain nodes verbatim
    // so the line bends with verlet motion.
    for (let s = 0; s < STRING_COUNT; s += 1) {
      const positions = new Float32Array(NODES_PER_STRING * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: this.params.stringColor,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 13;
      this.stringLines.push(line);
      this.stringMats.push(mat);
      this.stringPositions.push(positions);
      this.mesh.add(line);
    }

    // Verlet chains — one per string.
    const segLen = this.params.stringLength / (NODES_PER_STRING - 1);
    for (let s = 0; s < STRING_COUNT; s += 1) {
      this.chains.push(new VerletChain({
        nodeCount: NODES_PER_STRING,
        segmentLength: segLen,
        gravity: this.params.gravity,
        damping: this.params.damping,
        iterations: 4,
      }));
    }

    this.chimeBVH = new ChimeBVH(GEM_COUNT);
    this.assignGemFrequencies();
    this.applyColors();

    this.registered = registerTweaks(paneDock, paneKey, WIND_CHIME_DEFS, {
      title: opts.title ?? 'Wind Chime',
      params: this.params,
      onChange: {
        gemColor:    () => this.applyColors(),
        hotColor:    () => this.applyColors(),
        ringColor:   () => this.ringMat.color.set(this.params.ringColor),
        stringColor: () => this.applyStringColors(),
      },
    });
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
  }

  /** Drives the audio side: filter cutoff for this player's chime synth. */
  getWarmth(): number {
    return this.smoothedWarmth;
  }

  /** Drives the audio side: smoothed wind strength, used as a wet-send mod. */
  getWindStrength(): number {
    return this.smoothedWindStrength;
  }

  update(leftPalm: THREE.Vector3, rightPalm: THREE.Vector3, voice: VoiceState, delta: number): void {
    if (!this.active) return;
    if (delta <= 0) return;

    this.elapsed += delta;

    if (!this.initialized) {
      this.anchor.copy(leftPalm).add(rightPalm).multiplyScalar(0.5).add(_tmpVec.set(0, 0.05, 0));
      this.leftPrev.copy(leftPalm);
      this.rightPrev.copy(rightPalm);
      this.resetChains();
      this.initialized = true;
    }

    // Anchor slowly tracks the hand cloud — fixed-feeling, but follows
    // long-term re-positioning if the user shifts seat or stance.
    const anchorTarget = _tmpVec.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
    anchorTarget.y += 0.05;
    const anchorAlpha = 1 - Math.exp(-delta / Math.max(0.05, this.params.anchorSmoothing));
    this.anchor.lerp(anchorTarget, anchorAlpha);

    // Right-hand velocity drives wind. Left-hand y in [0..1] drives warmth.
    this.rightVel.copy(rightPalm).sub(this.rightPrev).divideScalar(delta);
    const handVelMag = this.rightVel.length();
    this.rightPrev.copy(rightPalm);
    this.leftPrev.copy(leftPalm);

    const warmthTarget = clamp((leftPalm.y - 0.7) / 0.9, 0, 1);
    this.smoothedWarmth += (warmthTarget - this.smoothedWarmth) * (1 - Math.exp(-delta * 6));

    const windStrengthTarget = clamp(handVelMag / 2.0, 0, 1);
    this.smoothedWindStrength += (windStrengthTarget - this.smoothedWindStrength) * (1 - Math.exp(-delta * 5));

    const energyTarget = voice.active ? voice.energy : 0;
    this.smoothedEnergy += (energyTarget - this.smoothedEnergy) * (1 - Math.exp(-delta * 4));

    this.placeRing();
    this.pinChainRoots();
    this.applyWindAndContact(rightPalm, delta, handVelMag);
    this.stepPhysics(delta);
    this.writeGemsAndStrings();
    this.runCollisions();
    this.handlePoke(rightPalm);
    this.decayHitPulse(delta);
    this.writeGemColors();

    // Once-per-second diagnostic. Helps confirm whether the chime is actually
    // generating hits or if collisions are silently empty.
    if (this.elapsed - this.debugStatsAt > 1.0) {
      this.debugStatsAt = this.elapsed;
      // console.debug('[chime] stats', {
      //   anchor: { x: +this.anchor.x.toFixed(2), y: +this.anchor.y.toFixed(2), z: +this.anchor.z.toFixed(2) },
      //   rightPalm: { x: +rightPalm.x.toFixed(2), y: +rightPalm.y.toFixed(2), z: +rightPalm.z.toFixed(2) },
      //   handSpeed: +handVelMag.toFixed(3),
      //   windAccum: +this.windAccum.length().toFixed(2),
      //   gemHits: this.gemHitCount,
      //   handHits: this.handHitCount,
      //   substepDt: +this.lastSubstepDt.toFixed(4),
      // });
      this.gemHitCount = 0;
      this.handHitCount = 0;
    }

    void voice;
  }

  dispose(): void {
    this.registered?.dispose();
    this.ringMesh.geometry.dispose();
    this.ringMat.dispose();
    this.gemsMesh.geometry.dispose();
    this.gemMat.dispose();
    for (const line of this.stringLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.chimeBVH.dispose();
    this.mesh.removeFromParent();
  }

  private assignGemFrequencies(): void {
    // Gem layout: chain s, gem k where k=0 is closest-to-ring (highest octave).
    for (let s = 0; s < STRING_COUNT; s += 1) {
      for (let k = 0; k < GEMS_PER_STRING; k += 1) {
        const gemIdx = s * GEMS_PER_STRING + k;
        const baseSemis = STRING_SEMITONES_FROM_D3[s];
        const octaveOffset = (GEMS_PER_STRING - 1 - k) * 12;
        this.gemFrequencies[gemIdx] = noteFreqHz(baseSemis + octaveOffset);
      }
    }
  }

  private resetChains(): void {
    const segLen = this.params.stringLength / (NODES_PER_STRING - 1);
    for (let s = 0; s < STRING_COUNT; s += 1) {
      const chain = this.chains[s];
      const angle = (s / STRING_COUNT) * TAU;
      const rx = this.anchor.x + Math.cos(angle) * this.params.ringRadius;
      const rz = this.anchor.z + Math.sin(angle) * this.params.ringRadius;
      const ry = this.anchor.y + 0.18;
      chain.segmentLength = segLen;
      chain.reset(rx, ry, rz);
    }
  }

  private placeRing(): void {
    this.ringMesh.position.set(this.anchor.x, this.anchor.y + 0.18, this.anchor.z);
    // Rebuild ring geometry only if user changed radius/tube — we cache by
    // checking the current geometry's parameters.
    const geo = this.ringMesh.geometry as THREE.TorusGeometry;
    const desiredR = this.params.ringRadius;
    const desiredT = this.params.ringTube;
    const params = (geo as unknown as { parameters: { radius: number; tube: number } }).parameters;
    if (params.radius !== desiredR || params.tube !== desiredT) {
      this.ringMesh.geometry.dispose();
      this.ringMesh.geometry = new THREE.TorusGeometry(desiredR, desiredT, 8, 48);
    }
  }

  private pinChainRoots(): void {
    for (let s = 0; s < STRING_COUNT; s += 1) {
      const angle = (s / STRING_COUNT) * TAU;
      const rx = this.anchor.x + Math.cos(angle) * this.params.ringRadius;
      const rz = this.anchor.z + Math.sin(angle) * this.params.ringRadius;
      const ry = this.anchor.y + 0.18;
      this.chains[s].setRoot(rx, ry, rz);
    }
  }

  private applyWindAndContact(rightPalm: THREE.Vector3, delta: number, handVelMag: number): void {
    // Wind direction = right-hand velocity, with a soft turbulence wobble so
    // sustained motion still produces interesting ripples instead of a flat
    // push.
    this.windAccum.copy(this.rightVel).multiplyScalar(this.params.windGain);
    if (this.params.turbulence > 0) {
      // Baseline turbulence is always present so gems jingle softly even at
      // rest. Hand motion adds on top — at full handVelMag of 2 m/s this
      // doubles the turbulence amplitude.
      const t = this.elapsed * 1.7;
      const turb = this.params.turbulence * (1.0 + Math.min(2, handVelMag) * 0.5);
      this.windAccum.x += Math.sin(t * 1.3) * turb;
      this.windAccum.y += Math.sin(t * 0.9 + 1.7) * turb * 0.4;
      this.windAccum.z += Math.cos(t * 1.1 + 0.6) * turb;
    }

    for (let s = 0; s < STRING_COUNT; s += 1) {
      const chain = this.chains[s];
      // Wind force is applied to all free nodes. Lower nodes (closer to bottom)
      // get a slightly amplified force so the bottom of the string swings
      // more than the top — feels like a chime hung in a breeze.
      for (let n = 1; n < NODES_PER_STRING; n += 1) {
        const depth = n / (NODES_PER_STRING - 1);
        const scale = 0.4 + depth * 0.9;
        chain.addForce(n, this.windAccum.x * scale, this.windAccum.y * scale, this.windAccum.z * scale);
      }
    }

    // Direct hand-as-wind-source: nodes near the right palm get an additional
    // push along the velocity direction so bumping a string ripples it
    // immediately, even before the BVH-driven solid contact below.
    const blastR = this.params.contactRadius * 2.2;
    const blastR2 = blastR * blastR;
    for (let s = 0; s < STRING_COUNT; s += 1) {
      const chain = this.chains[s];
      for (let n = 1; n < NODES_PER_STRING; n += 1) {
        const k = n * 3;
        const dx = chain.positions[k] - rightPalm.x;
        const dy = chain.positions[k + 1] - rightPalm.y;
        const dz = chain.positions[k + 2] - rightPalm.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < blastR2) {
          const falloff = 1 - d2 / blastR2;
          chain.addForce(n,
            this.windAccum.x * falloff * 0.5,
            this.windAccum.y * falloff * 0.5,
            this.windAccum.z * falloff * 0.5);
        }
      }
    }
    void delta;
  }

  private stepPhysics(delta: number): void {
    // Two fixed substeps per frame for stable rope. Cap dt so a long pause
    // doesn't explode the sim.
    const cappedDt = Math.min(delta, 0.04);
    const sub = cappedDt * 0.5;
    this.lastSubstepDt = sub;
    for (let s = 0; s < STRING_COUNT; s += 1) {
      const chain = this.chains[s];
      chain.gravity = this.params.gravity;
      chain.damping = this.params.damping;
      chain.step(sub);
      chain.step(sub);
    }
  }

  private writeGemsAndStrings(): void {
    for (let s = 0; s < STRING_COUNT; s += 1) {
      const chain = this.chains[s];
      const lineGeo = this.stringLines[s].geometry as THREE.BufferGeometry;
      const lineAttr = lineGeo.attributes.position as THREE.BufferAttribute;
      const linePos = lineAttr.array as Float32Array;
      // Copy chain node positions verbatim into the line.
      for (let n = 0; n < NODES_PER_STRING; n += 1) {
        const k = n * 3;
        linePos[k] = chain.positions[k];
        linePos[k + 1] = chain.positions[k + 1];
        linePos[k + 2] = chain.positions[k + 2];
      }
      lineAttr.needsUpdate = true;

      // Write gem matrices + BVH points.
      for (let k = 0; k < GEMS_PER_STRING; k += 1) {
        const gemIdx = s * GEMS_PER_STRING + k;
        const nodeIdx = FIRST_GEM_NODE + k;
        const o = nodeIdx * 3;
        const x = chain.positions[o];
        const y = chain.positions[o + 1];
        const z = chain.positions[o + 2];
        this.chimeBVH.setPoint(gemIdx, x, y, z);

        // Gem orientation: lock to ring's local frame for now (no spin —
        // chime gems shouldn't gyrate). Subtle wobble from chain motion.
        _tmpVec.set(x, y, z);
        _scaleVec.setScalar(this.params.gemRadius);
        _tmpQuat.identity();
        _tmpMat.compose(_tmpVec, _tmpQuat, _scaleVec);
        this.gemsMesh.setMatrixAt(gemIdx, _tmpMat);
      }
    }
    this.gemsMesh.instanceMatrix.needsUpdate = true;
    this.chimeBVH.refit();
  }

  private runCollisions(): void {
    const contactR = this.params.gemRadius * 2;
    this.gemPairs.length = 0;
    this.chimeBVH.collectGemPairs(contactR, this.gemPairs);

    if (this.gemPairs.length === 0) return;

    const minVel = this.params.hitVelMin;
    const cooldown = this.params.hitCooldown;

    for (const pair of this.gemPairs) {
      const a = pair.a;
      const b = pair.b;

      // Compute current relative velocity using each gem's chain prev/cur.
      const va = this.gemVelocity(a, _tmpVec);
      const vb = this.gemVelocity(b, _tmpVec2);
      const relSpeed = va.distanceTo(vb);

      // Separate gems gently so they don't lock together.
      this.separateGems(a, b, contactR);

      if (relSpeed < minVel) continue;
      const now = this.elapsed;
      if (now - this.gemHitAt[a] < cooldown && now - this.gemHitAt[b] < cooldown) continue;
      this.gemHitAt[a] = now;
      this.gemHitAt[b] = now;

      const velocity = clamp(relSpeed / 3.0, 0, 1);
      this.gemHitPulse[a] = Math.min(1, this.gemHitPulse[a] + 0.4 + velocity * 0.6);
      this.gemHitPulse[b] = Math.min(1, this.gemHitPulse[b] + 0.4 + velocity * 0.6);

      if (this.onHitCallback) {
        this.onHitCallback({ gemIndex: a, frequency: this.gemFrequencies[a], velocity });
        this.onHitCallback({ gemIndex: b, frequency: this.gemFrequencies[b], velocity });
      }
      this.gemHitCount += 1;
    }
  }

  private handlePoke(rightPalm: THREE.Vector3): void {
    this.handHits.length = 0;
    this.chimeBVH.collectHandHits(rightPalm, this.params.contactRadius, this.handHits);
    if (this.handHits.length === 0) return;

    const cooldown = this.params.hitCooldown * 1.4;
    const now = this.elapsed;
    const handSpeed = this.rightVel.length();
    const velNorm = clamp(handSpeed / 1.6, 0, 1);
    const minPokeSpeed = this.params.hitVelMin * 0.8;

    for (const gemIdx of this.handHits) {
      const s = Math.floor(gemIdx / GEMS_PER_STRING);
      const k = gemIdx % GEMS_PER_STRING;
      const nodeIdx = FIRST_GEM_NODE + k;
      // Push the gem along the hand velocity direction.
      const push = this.params.contactPush;
      this.chains[s].addImpulse(nodeIdx,
        this.rightVel.x * push * 0.012,
        this.rightVel.y * push * 0.012,
        this.rightVel.z * push * 0.012);

      if (handSpeed < minPokeSpeed) continue;
      if (now - this.gemHitAt[gemIdx] < cooldown) continue;
      this.gemHitAt[gemIdx] = now;
      this.gemHitPulse[gemIdx] = Math.min(1, this.gemHitPulse[gemIdx] + 0.5 + velNorm * 0.5);

      if (this.onHitCallback) {
        this.onHitCallback({ gemIndex: gemIdx, frequency: this.gemFrequencies[gemIdx], velocity: velNorm });
      }
      this.handHitCount += 1;
    }
  }

  private separateGems(a: number, b: number, contactR: number): void {
    const sa = Math.floor(a / GEMS_PER_STRING);
    const ka = a % GEMS_PER_STRING;
    const sb = Math.floor(b / GEMS_PER_STRING);
    const kb = b % GEMS_PER_STRING;
    const nodeA = FIRST_GEM_NODE + ka;
    const nodeB = FIRST_GEM_NODE + kb;
    const chainA = this.chains[sa];
    const chainB = this.chains[sb];
    const oa = nodeA * 3;
    const ob = nodeB * 3;
    const dx = chainB.positions[ob] - chainA.positions[oa];
    const dy = chainB.positions[ob + 1] - chainA.positions[oa + 1];
    const dz = chainB.positions[ob + 2] - chainA.positions[oa + 2];
    const dist = Math.hypot(dx, dy, dz) || 1e-6;
    const overlap = contactR - dist;
    if (overlap <= 0) return;
    const nx = dx / dist;
    const ny = dy / dist;
    const nz = dz / dist;
    const half = overlap * 0.5;
    chainA.addImpulse(nodeA, -nx * half, -ny * half, -nz * half);
    chainB.addImpulse(nodeB, nx * half, ny * half, nz * half);
  }

  private gemVelocity(gemIdx: number, out: THREE.Vector3): THREE.Vector3 {
    // chain.positions/previous straddle one verlet substep, so the raw delta
    // is meters-per-substep — divide by lastSubstepDt to land in m/s, the
    // unit hitVelMin is expressed in.
    const s = Math.floor(gemIdx / GEMS_PER_STRING);
    const k = gemIdx % GEMS_PER_STRING;
    const nodeIdx = FIRST_GEM_NODE + k;
    const chain = this.chains[s];
    const o = nodeIdx * 3;
    const inv = this.lastSubstepDt > 0 ? 1 / this.lastSubstepDt : 0;
    return out.set(
      (chain.positions[o] - chain.previous[o]) * inv,
      (chain.positions[o + 1] - chain.previous[o + 1]) * inv,
      (chain.positions[o + 2] - chain.previous[o + 2]) * inv,
    );
  }

  private decayHitPulse(delta: number): void {
    const k = Math.exp(-delta * this.params.pulseDecay);
    for (let i = 0; i < GEM_COUNT; i += 1) {
      this.gemHitPulse[i] *= k;
    }
  }

  private writeGemColors(): void {
    if (!this.gemsMesh.instanceColor) return;
    const arr = this.gemsMesh.instanceColor.array as Float32Array;
    for (let i = 0; i < GEM_COUNT; i += 1) {
      const pulse = clamp(this.gemHitPulse[i], 0, 1);
      this.gemColorScratch.copy(this.gemBaseColor).lerp(this.gemHotColor, pulse);
      // Add a brightness boost on top of the lerp so a solid hit reads as
      // a flash of light, not just a hue shift.
      const boost = 1 + pulse * 1.6;
      const o = i * 3;
      arr[o] = this.gemColorScratch.r * boost;
      arr[o + 1] = this.gemColorScratch.g * boost;
      arr[o + 2] = this.gemColorScratch.b * boost;
    }
    (this.gemsMesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private applyColors(): void {
    this.gemBaseColor.set(this.params.gemColor);
    this.gemHotColor.set(this.params.hotColor);
    this.ringMat.color.set(this.params.ringColor);
    this.applyStringColors();
  }

  private applyStringColors(): void {
    for (const mat of this.stringMats) mat.color.set(this.params.stringColor);
  }
}

function applyPaletteDefaults(params: WindChimeParams, palette: WindChimePalette): void {
  if (palette === 'remote') {
    params.gemColor = '#ff7ad6';
    params.hotColor = '#ffe6f8';
    params.ringColor = '#8a4a7a';
    params.stringColor = '#cf8be8';
    return;
  }
  // local — same warm gold as the loom warm color so the two instruments
  // share an identity in the player's palette.
  params.gemColor = '#ffd166';
  params.hotColor = '#fff7d6';
  params.ringColor = '#a16e2c';
  params.stringColor = '#f6bd4b';
}
