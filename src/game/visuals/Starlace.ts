import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import type { HandContactPoint, PlayerVisual, VoiceState } from '../instruments';
import { clamp, hash } from '../math';

export const STARLACE_DEFS = {
  width:           { default: 0.78,  min: 0.36, max: 1.35, step: 0.01,  label: 'width' },
  height:          { default: 0.62,  min: 0.24, max: 1.05, step: 0.01,  label: 'height' },
  depth:           { default: 0.42,  min: 0.00, max: 0.80, step: 0.005, label: 'depth' },
  nodeRadius:      { default: 0.022, min: 0.006, max: 0.05, step: 0.001, label: 'star size' },
  contactRadius:   { default: 0.085, min: 0.025, max: 0.18, step: 0.001, label: 'hand contact' },
  hitCooldown:     { default: 0.065, min: 0.02,  max: 0.35, step: 0.005, label: 'hit cooldown s' },
  pulseDecay:      { default: 4.8,   min: 1,     max: 14,   step: 0.1,   label: 'star fade' },
  driftSpeed:      { default: 0.58,  min: 0,     max: 2.4,  step: 0.01,  label: 'drift speed' },
  waveAmp:         { default: 0.042, min: 0,     max: 0.16, step: 0.001, label: 'web wave' },
  linkOpacity:     { default: 0.46,  min: 0,     max: 0.9,  step: 0.01,  label: 'link opacity' },
  sparkSize:       { default: 0.030, min: 0.006, max: 0.08, step: 0.001, label: 'spark size' },
  anchorSmoothing: { default: 5.5,   min: 0.2,   max: 16,   step: 0.1,   label: 'anchor smoothing s' },
  coolColor:       { type: 'color', default: '#6fe8ff', label: 'blue stars' },
  warmColor:       { type: 'color', default: '#ff8cf0', label: 'violet stars' },
  goldColor:       { type: 'color', default: '#ffd166', label: 'gold links' },
  hotColor:        { type: 'color', default: '#fff7d6', label: 'hot' },
} as const;

export type StarlaceParams = ParamsOf<typeof STARLACE_DEFS>;

export type StarlacePluck = {
  nodeIndex: number;
  frequency: number;
  velocity: number;
  x: number;
  y: number;
};

type StarlacePalette = 'local' | 'remote';

type StarlaceOptions = {
  palette?: StarlacePalette;
  title?: string;
  onPluck?: (event: StarlacePluck) => void;
  sculptor?: import('../sculptor/EnergyEmitter').EnergySink;
};

type StarNode = {
  u: number;
  v: number;
  z: number;
  seed: number;
  noteIndex: number;
  pulse: number;
  lastHitAt: number;
  world: THREE.Vector3;
};

type TravelingSpark = {
  from: number;
  to: number;
  start: number;
  duration: number;
  intensity: number;
};

const ROW_COUNTS = [5, 7, 8, 7, 5];
const MAX_SPARKS = 64;
const MAX_HITS_PER_FRAME = 10;
const TAU = Math.PI * 2;

const STARLACE_HZ: number[] = [
  146.832, // D3
  164.814, // E3
  184.997, // F#3
  220.000, // A3
  246.942, // B3
  293.665, // D4
  329.628, // E4
  369.994, // F#4
  440.000, // A4
  493.883, // B4
  587.330, // D5
  659.255, // E5
  739.989, // F#5
  880.000, // A5
];

const _worldUp = new THREE.Vector3(0, 1, 0);
const _contactDelta = new THREE.Vector3();
const _segment = new THREE.Vector3();
const _pointDelta = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _scratch = new THREE.Vector3();
const _scratch2 = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _colorA = new THREE.Color();
const _colorB = new THREE.Color();

export class Starlace implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: StarlaceParams;

  private nodes: StarNode[] = [];
  private edges: [number, number][] = [];
  private adjacency: number[][] = [];
  private linePositions: Float32Array;
  private pulseLinePositions: Float32Array;
  private lineGeometry: THREE.BufferGeometry;
  private pulseLineGeometry: THREE.BufferGeometry;
  private lineMaterial: THREE.LineBasicMaterial;
  private pulseLineMaterial: THREE.LineBasicMaterial;
  private lineSegments: THREE.LineSegments;
  private pulseLineSegments: THREE.LineSegments;
  private nodeMesh: THREE.InstancedMesh;
  private nodeMaterial: THREE.MeshBasicMaterial;
  private sparkMesh: THREE.InstancedMesh;
  private sparkMaterial: THREE.MeshBasicMaterial;

  private elapsed = 0;
  private active = true;
  private initialized = false;
  private anchor = new THREE.Vector3();
  private left = new THREE.Vector3();
  private right = new THREE.Vector3();
  private center = new THREE.Vector3();
  private axis = new THREE.Vector3(1, 0, 0);
  private fieldUp = new THREE.Vector3(0, 1, 0);
  private fieldSide = new THREE.Vector3(0, 0, 1);
  private smoothedEnergy = 0;
  private smoothedPulse = 0;
  private smoothedPitch = 0.5;
  private smoothedExpression = 0.5;
  private smoothedTension = 0.35;
  private maxPulse = 0;

  private previousContacts = new Map<string, THREE.Vector3>();
  private activeContactKeys = new Set<string>();
  private currentContactKeys = new Set<string>();
  private fallbackContacts: HandContactPoint[] = [
    { id: 'starlace:left:palm', hand: 'left', kind: 'palm', position: new THREE.Vector3() },
    { id: 'starlace:right:palm', hand: 'right', kind: 'palm', position: new THREE.Vector3() },
  ];
  private sparks: TravelingSpark[] = Array.from({ length: MAX_SPARKS }, () => ({
    from: 0,
    to: 0,
    start: -100,
    duration: 0.5,
    intensity: 0,
  }));
  private sparkCursor = 0;

  private cool = new THREE.Color();
  private warm = new THREE.Color();
  private gold = new THREE.Color();
  private hot = new THREE.Color();
  private onPluckCallback?: (event: StarlacePluck) => void;
  private sculptor?: import('../sculptor/EnergyEmitter').EnergySink;
  private keyDownListener?: (e: KeyboardEvent) => void;
  private palette: StarlacePalette;
  private registered?: ReturnType<typeof registerTweaks<typeof STARLACE_DEFS>>;

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey = 'starlace', opts: StarlaceOptions = {}) {
    this.params = { ...Object.fromEntries(Object.entries(STARLACE_DEFS).map(([k, d]) => [k, d.default])) } as StarlaceParams;
    applyPaletteDefaults(this.params, opts.palette ?? 'local');
    this.onPluckCallback = opts.onPluck;
    this.sculptor = opts.sculptor;
    this.palette = opts.palette ?? 'local';

    this.mesh = new THREE.Group();
    this.mesh.name = `starlace-harp-${opts.palette ?? 'local'}`;
    scene.add(this.mesh);

    this.createNodes();
    this.createEdges();

    this.linePositions = new Float32Array(this.edges.length * 2 * 3);
    this.pulseLinePositions = new Float32Array(this.edges.length * 2 * 3);
    this.lineGeometry = new THREE.BufferGeometry();
    this.pulseLineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.pulseLineGeometry.setAttribute('position', new THREE.BufferAttribute(this.pulseLinePositions, 3));

    this.lineMaterial = new THREE.LineBasicMaterial({
      color: this.params.goldColor,
      transparent: true,
      opacity: this.params.linkOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.pulseLineMaterial = new THREE.LineBasicMaterial({
      color: this.params.hotColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.lineSegments = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.pulseLineSegments = new THREE.LineSegments(this.pulseLineGeometry, this.pulseLineMaterial);
    this.lineSegments.frustumCulled = false;
    this.pulseLineSegments.frustumCulled = false;
    this.lineSegments.renderOrder = 16;
    this.pulseLineSegments.renderOrder = 17;
    this.mesh.add(this.lineSegments, this.pulseLineSegments);

    this.nodeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
    });
    this.nodeMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), this.nodeMaterial, this.nodes.length);
    this.nodeMesh.frustumCulled = false;
    this.nodeMesh.renderOrder = 20;
    this.mesh.add(this.nodeMesh);

    this.sparkMaterial = new THREE.MeshBasicMaterial({
      color: this.params.hotColor,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sparkMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), this.sparkMaterial, MAX_SPARKS);
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = 22;
    this.mesh.add(this.sparkMesh);

    this.applyColors();
    this.writeHiddenSparks();

    if (this.palette === 'local') this.attachKeyboardEvents();

    this.registered = registerTweaks(paneDock, paneKey, STARLACE_DEFS, {
      title: opts.title ?? 'Starlace',
      params: this.params,
      onChange: {
        coolColor: () => this.applyColors(),
        warmColor: () => this.applyColors(),
        goldColor: () => this.applyColors(),
        hotColor:  () => this.applyColors(),
      },
    });
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
    if (!visible) {
      this.previousContacts.clear();
      this.activeContactKeys.clear();
      this.currentContactKeys.clear();
    }
  }

  update(
    leftPalm: THREE.Vector3,
    rightPalm: THREE.Vector3,
    voice: VoiceState,
    delta: number,
    contacts?: readonly HandContactPoint[],
  ): void {
    if (!this.active || delta <= 0) return;

    this.elapsed += delta;
    if (!this.initialized) {
      this.left.copy(leftPalm);
      this.right.copy(rightPalm);
      this.anchor.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
      this.anchor.y += 0.05;
      this.initialized = true;
    }

    const palmAlpha = 1 - Math.exp(-delta * 16);
    this.left.lerp(leftPalm, palmAlpha);
    this.right.lerp(rightPalm, palmAlpha);
    _scratch.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
    _scratch.y += 0.05;
    const anchorAlpha = 1 - Math.exp(-delta / Math.max(0.05, this.params.anchorSmoothing));
    this.anchor.lerp(_scratch, anchorAlpha);
    this.center.copy(this.anchor);

    this.smoothedEnergy += ((voice.active ? voice.energy : 0) - this.smoothedEnergy) * (1 - Math.exp(-delta * 5));
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * (1 - Math.exp(-delta * 12));
    this.smoothedPitch += (voice.pitch - this.smoothedPitch) * (1 - Math.exp(-delta * 8));
    this.smoothedExpression += (voice.expression - this.smoothedExpression) * (1 - Math.exp(-delta * 8));
    this.smoothedTension += (voice.tension - this.smoothedTension) * (1 - Math.exp(-delta * 7));

    this.resolveAxes();
    this.writeNodePositions();
    this.processContacts(this.resolveContacts(leftPalm, rightPalm, contacts), delta);
    this.decayPulses(delta);
    this.writeLines();
    this.writeNodes();
    this.writeSparks();
  }

  dispose(): void {
    this.detachKeyboardEvents();
    this.registered?.dispose();
    this.lineGeometry.dispose();
    this.pulseLineGeometry.dispose();
    this.lineMaterial.dispose();
    this.pulseLineMaterial.dispose();
    this.nodeMesh.geometry.dispose();
    this.nodeMaterial.dispose();
    this.sparkMesh.geometry.dispose();
    this.sparkMaterial.dispose();
    this.mesh.removeFromParent();
  }

  private createNodes(): void {
    // 3D radial cluster: deterministic Halton-ish sampling over an ellipsoid,
    // density-biased toward the center so the constellation reads as a
    // star-cluster rather than a uniform cloud.
    const NODE_COUNT = 36;
    for (let i = 0; i < NODE_COUNT; i += 1) {
      const r1 = hash(i * 9.17 + 0.23);
      const r2 = hash(i * 5.73 + 1.10);
      const r3 = hash(i * 6.91 + 2.20);
      const r4 = hash(i * 8.31 + 3.30);
      // Spherical sample with bias: smaller exponent -> denser core.
      const radius = Math.pow(r1, 0.55);
      const theta = r2 * TAU;
      const phi = Math.acos(2 * r3 - 1);
      // Convert to ellipsoidal u/v/z in [-0.5, 0.5].
      const u = 0.5 * radius * Math.sin(phi) * Math.cos(theta);
      const v = 0.5 * radius * Math.cos(phi);
      const z = 0.5 * radius * Math.sin(phi) * Math.sin(theta);
      const seed = r4;
      const noteT = clamp((v + 0.5) * 0.78 + (u + 0.5) * 0.22, 0, 1);
      this.nodes.push({
        u,
        v,
        z,
        seed,
        noteIndex: clamp(Math.round(noteT * (STARLACE_HZ.length - 1)), 0, STARLACE_HZ.length - 1),
        pulse: 0,
        lastHitAt: -100,
        world: new THREE.Vector3(),
      });
    }
  }

  private createEdges(): void {
    // k-nearest-neighbor graph in u/v/z space (z weighted slightly less so the
    // graph still feels planar-ish when viewed head-on).
    const K = 5;
    type Pair = { i: number; j: number; d: number };
    const distances: Pair[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      for (let j = i + 1; j < this.nodes.length; j += 1) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        const du = a.u - b.u;
        const dv = a.v - b.v;
        const dz = (a.z - b.z) * 0.85;
        const d = Math.sqrt(du * du + dv * dv + dz * dz);
        distances.push({ i, j, d });
      }
    }
    distances.sort((a, b) => a.d - b.d);
    const degree = new Array(this.nodes.length).fill(0);
    const seen = new Set<string>();
    for (const p of distances) {
      const key = `${p.i}:${p.j}`;
      if (seen.has(key)) continue;
      if (degree[p.i] >= K && degree[p.j] >= K) continue;
      this.edges.push([p.i, p.j]);
      seen.add(key);
      degree[p.i] += 1;
      degree[p.j] += 1;
    }
    this.adjacency = Array.from({ length: this.nodes.length }, () => []);
    for (const [a, b] of this.edges) {
      this.adjacency[a].push(b);
      this.adjacency[b].push(a);
    }
  }

  private resolveAxes(): void {
    this.axis.subVectors(this.right, this.left);
    if (this.axis.lengthSq() < 0.0001) this.axis.set(1, 0, 0);
    else this.axis.normalize();

    this.fieldSide.crossVectors(this.axis, _worldUp);
    if (this.fieldSide.lengthSq() < 0.0001) this.fieldSide.set(0, 0, 1);
    this.fieldSide.normalize();
    this.fieldUp.crossVectors(this.fieldSide, this.axis).normalize();
  }

  private writeNodePositions(): void {
    const handSpan = this.left.distanceTo(this.right);
    const width = this.params.width * (0.88 + this.smoothedTension * 0.24) + clamp(handSpan - 0.42, -0.18, 0.36) * 0.26;
    const height = this.params.height * (0.90 + this.smoothedEnergy * 0.14);
    const depth = this.params.depth * (0.72 + this.smoothedExpression * 0.38);
    const time = this.elapsed * this.params.driftSpeed;

    for (let i = 0; i < this.nodes.length; i += 1) {
      const n = this.nodes[i];
      const wave = Math.sin(time * TAU + n.seed * TAU + n.u * 4.1) * this.params.waveAmp;
      const shimmer = Math.cos(time * 3.3 + n.v * 6.4 + n.seed * 5.7) * this.params.waveAmp * 0.38;
      n.world.copy(this.center)
        .addScaledVector(this.axis, n.u * width)
        .addScaledVector(this.fieldUp, n.v * height + wave)
        .addScaledVector(this.fieldSide, n.z * depth + shimmer);
    }
  }

  private writeLines(): void {
    let maxPulse = 0;
    let cursor = 0;
    for (const [aIdx, bIdx] of this.edges) {
      const a = this.nodes[aIdx];
      const b = this.nodes[bIdx];
      this.linePositions[cursor] = a.world.x;
      this.pulseLinePositions[cursor++] = a.world.x;
      this.linePositions[cursor] = a.world.y;
      this.pulseLinePositions[cursor++] = a.world.y;
      this.linePositions[cursor] = a.world.z;
      this.pulseLinePositions[cursor++] = a.world.z;
      this.linePositions[cursor] = b.world.x;
      this.pulseLinePositions[cursor++] = b.world.x;
      this.linePositions[cursor] = b.world.y;
      this.pulseLinePositions[cursor++] = b.world.y;
      this.linePositions[cursor] = b.world.z;
      this.pulseLinePositions[cursor++] = b.world.z;
      maxPulse = Math.max(maxPulse, a.pulse, b.pulse);
    }
    this.maxPulse += (maxPulse - this.maxPulse) * 0.35;
    (this.lineGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pulseLineGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.lineMaterial.opacity = this.params.linkOpacity * (0.58 + this.smoothedEnergy * 0.58);
    this.pulseLineMaterial.opacity = clamp(this.maxPulse * 0.62 + this.smoothedPulse * 0.22, 0, 0.82);
  }

  private writeNodes(): void {
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const twinkle = 0.5 + Math.sin(this.elapsed * (1.2 + node.seed * 1.7) + node.seed * TAU) * 0.5;
      const pitchGlow = 1 - Math.abs((node.noteIndex / (STARLACE_HZ.length - 1)) - this.smoothedPitch);
      const pulse = clamp(node.pulse + pitchGlow * this.smoothedEnergy * 0.22 + twinkle * 0.10, 0, 1);
      const size = this.params.nodeRadius * (0.72 + twinkle * 0.34 + pulse * 1.45);

      _dummy.position.copy(node.world);
      _dummy.scale.setScalar(size);
      _dummy.updateMatrix();
      this.nodeMesh.setMatrixAt(i, _dummy.matrix);

      _colorA.copy(this.cool).lerp(this.warm, clamp(node.u + 0.5, 0, 1));
      _colorB.copy(_colorA).lerp(this.hot, pulse);
      const boost = 0.9 + pulse * 1.9;
      _colorB.multiplyScalar(boost);
      this.nodeMesh.setColorAt(i, _colorB);
    }
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    if (this.nodeMesh.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true;
  }

  private writeSparks(): void {
    let visible = 0;
    for (let i = 0; i < this.sparks.length; i += 1) {
      const spark = this.sparks[i];
      const age = (this.elapsed - spark.start) / Math.max(0.001, spark.duration);
      if (age < 0 || age >= 1 || spark.intensity <= 0) continue;
      const a = this.nodes[spark.from];
      const b = this.nodes[spark.to];
      const t = easeOutCubic(age);
      _scratch.copy(a.world).lerp(b.world, t);
      const lift = Math.sin(age * Math.PI) * this.params.sparkSize * 1.8;
      _scratch.addScaledVector(this.fieldUp, lift);
      const size = this.params.sparkSize * (1 - age * 0.6) * (0.35 + spark.intensity);
      _dummy.position.copy(_scratch);
      _dummy.scale.setScalar(size);
      _dummy.updateMatrix();
      this.sparkMesh.setMatrixAt(visible, _dummy.matrix);
      visible += 1;
      if (visible >= MAX_SPARKS) break;
    }
    for (let i = visible; i < MAX_SPARKS; i += 1) {
      _dummy.position.set(0, -1000, 0);
      _dummy.scale.setScalar(0.0001);
      _dummy.updateMatrix();
      this.sparkMesh.setMatrixAt(i, _dummy.matrix);
    }
    this.sparkMesh.instanceMatrix.needsUpdate = true;
  }

  private writeHiddenSparks(): void {
    for (let i = 0; i < MAX_SPARKS; i += 1) {
      _dummy.position.set(0, -1000, 0);
      _dummy.scale.setScalar(0.0001);
      _dummy.updateMatrix();
      this.sparkMesh.setMatrixAt(i, _dummy.matrix);
    }
    this.sparkMesh.instanceMatrix.needsUpdate = true;
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

  private processContacts(contacts: readonly HandContactPoint[], delta: number): void {
    const safeDelta = Math.max(delta, 1e-4);
    this.currentContactKeys.clear();
    let hitsThisFrame = 0;

    for (const contact of contacts) {
      let previous = this.previousContacts.get(contact.id);
      if (!previous) {
        previous = contact.position.clone();
        this.previousContacts.set(contact.id, previous);
      }

      _contactDelta.copy(contact.position).sub(previous);
      const speed = _contactDelta.length() / safeDelta;
      const radius = this.params.contactRadius * (contact.kind === 'palm' ? 1.05 : 0.58);
      const fastEnough = speed > 0.018;

      for (let i = 0; i < this.nodes.length; i += 1) {
        const node = this.nodes[i];
        const key = `${contact.id}:${i}`;
        const currentDistance = node.world.distanceTo(contact.position);
        const currentlyOver = currentDistance <= radius;
        if (currentlyOver) this.currentContactKeys.add(key);

        const sweptDistance = segmentPointDistance(previous, contact.position, node.world);
        const sweptThrough = sweptDistance <= radius && fastEnough;
        const entered = currentlyOver && !this.activeContactKeys.has(key);
        if (!entered && !sweptThrough) continue;
        if (this.elapsed - node.lastHitAt < this.params.hitCooldown) continue;

        const velocity = clamp(0.18 + speed / 1.7, 0.2, 1);
        this.fireNode(i, velocity);
        hitsThisFrame += 1;
        if (hitsThisFrame >= MAX_HITS_PER_FRAME) break;
      }

      previous.copy(contact.position);
      if (hitsThisFrame >= MAX_HITS_PER_FRAME) break;
    }

    this.activeContactKeys.clear();
    for (const key of this.currentContactKeys) this.activeContactKeys.add(key);
  }

  private fireNode(nodeIndex: number, velocity: number): void {
    const node = this.nodes[nodeIndex];
    node.lastHitAt = this.elapsed;
    node.pulse = Math.min(1, node.pulse + 0.65 + velocity * 0.45);

    const neighbors = this.adjacency[nodeIndex];
    for (let i = 0; i < Math.min(neighbors.length, 5); i += 1) {
      const neighborIndex = neighbors[(i + Math.floor(node.seed * neighbors.length)) % neighbors.length];
      this.addSpark(nodeIndex, neighborIndex, velocity);
      this.nodes[neighborIndex].pulse = Math.min(1, this.nodes[neighborIndex].pulse + velocity * 0.32);
    }

    if (this.onPluckCallback) {
      this.onPluckCallback({
        nodeIndex,
        frequency: STARLACE_HZ[node.noteIndex],
        velocity,
        x: clamp(node.u + 0.5, 0, 1),
        y: clamp(node.v + 0.5, 0, 1),
      });
    }
    this.emitStreak(node, velocity);
  }

  private static KEY_MAP: ReadonlyArray<string> = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];

  private attachKeyboardEvents(): void {
    this.keyDownListener = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      const idx = Starlace.KEY_MAP.indexOf(e.key.toLowerCase());
      if (idx < 0) return;
      // Pick the i-th node in pitch order (sorted by noteIndex), so keys
      // ascend the scale predictably across the constellation.
      const sorted = this.nodes
        .map((n, i) => ({ i, note: n.noteIndex }))
        .sort((a, b) => a.note - b.note);
      const target = sorted[Math.min(idx, sorted.length - 1)];
      if (!target) return;
      this.fireNode(target.i, 0.7);
    };
    window.addEventListener('keydown', this.keyDownListener);
  }

  private detachKeyboardEvents(): void {
    if (this.keyDownListener) {
      window.removeEventListener('keydown', this.keyDownListener);
      this.keyDownListener = undefined;
    }
  }

  private emitStreak(node: StarNode, velocity: number): void {
    if (!this.sculptor) return;
    const sink = this.sculptor;
    const dir = _scratch.copy(sink.center).sub(node.world);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0.1, 0);
    dir.normalize();
    // Pick a palette color based on node seed so the constellation's
    // multi-color identity carries into the sculpture.
    const phase = node.seed * 3;
    const idx = Math.floor(phase) % 3;
    const palette = idx === 0
      ? this.cool   // cyan
      : idx === 1
        ? this.warm // magenta
        : this.gold;
    sink.emit({
      kind: 'starlace',
      origin: node.world.clone(),
      direction: dir.clone(),
      color: { r: palette.r, g: palette.g, b: palette.b },
      count: Math.round(20 + velocity * 14),
      intensity: 0.5 + velocity * 0.5,
      speed: 1.1 + velocity * 0.6,
      lifetime: 1.6 + velocity * 0.4,
    });
  }

  private addSpark(from: number, to: number, intensity: number): void {
    const spark = this.sparks[this.sparkCursor % MAX_SPARKS];
    spark.from = from;
    spark.to = to;
    spark.start = this.elapsed;
    spark.duration = 0.22 + hash(from * 3.17 + to * 7.31) * 0.22;
    spark.intensity = clamp(intensity, 0, 1);
    this.sparkCursor += 1;
  }

  private decayPulses(delta: number): void {
    const k = Math.exp(-delta * this.params.pulseDecay);
    for (const node of this.nodes) node.pulse *= k;
  }

  private applyColors(): void {
    this.cool.set(this.params.coolColor);
    this.warm.set(this.params.warmColor);
    this.gold.set(this.params.goldColor);
    this.hot.set(this.params.hotColor);
    this.lineMaterial.color.copy(this.gold);
    this.pulseLineMaterial.color.copy(this.hot);
    this.sparkMaterial.color.copy(this.hot);
  }
}

function segmentPointDistance(from: THREE.Vector3, to: THREE.Vector3, point: THREE.Vector3): number {
  _segment.copy(to).sub(from);
  const lenSq = _segment.lengthSq();
  if (lenSq <= 1e-8) return point.distanceTo(to);
  _pointDelta.copy(point).sub(from);
  const t = THREE.MathUtils.clamp(_pointDelta.dot(_segment) / lenSq, 0, 1);
  _closest.copy(from).addScaledVector(_segment, t);
  return _closest.distanceTo(point);
}

function easeOutCubic(t: number): number {
  const inv = 1 - clamp(t, 0, 1);
  return 1 - inv * inv * inv;
}

function applyPaletteDefaults(params: StarlaceParams, palette: StarlacePalette): void {
  if (palette === 'remote') {
    params.coolColor = '#d98bff';
    params.warmColor = '#ff7ad6';
    params.goldColor = '#b991ff';
    params.hotColor = '#fff0fb';
    return;
  }
  params.coolColor = '#6fe8ff';
  params.warmColor = '#ff8cf0';
  params.goldColor = '#ffd166';
  params.hotColor = '#fff7d6';
}
