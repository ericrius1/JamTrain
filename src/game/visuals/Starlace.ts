import * as THREE from 'three/webgpu';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import { getStarlaceHz } from '../harmony';
import { keyDirector } from '../keyDirector';
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
  linkOpacity:     { default: 0.42,  min: 0,     max: 0.9,  step: 0.01,  label: 'link opacity' },
  sparkSize:       { default: 0.030, min: 0.006, max: 0.08, step: 0.001, label: 'spark size' },
  anchorSmoothing: { default: 5.5,   min: 0.2,   max: 16,   step: 0.1,   label: 'anchor smoothing s' },
  keyWalkInterval: { default: 0.34,  min: 0.18,  max: 0.75, step: 0.005, label: 'key walk step s' },
  coolColor:       { type: 'color', default: '#5fb6c4', label: 'cool stars' },
  warmColor:       { type: 'color', default: '#e56f67', label: 'warm stars' },
  goldColor:       { type: 'color', default: '#edae4a', label: 'gold links' },
  hotColor:        { type: 'color', default: '#ffd06a', label: 'hot' },
} as const;

export type StarlaceParams = ParamsOf<typeof STARLACE_DEFS>;

export type StarlacePluck = {
  nodeIndex: number;
  noteIndex: number;
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
  anchor?: THREE.Vector3;
  camera?: THREE.Camera;
  canvas?: HTMLCanvasElement;
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

type KeyboardPathState = {
  keyIndex: number;
  homeNoteIndex: number;
  currentNode: number;
  previousNode: number;
  nextAt: number;
  step: number;
  phraseSeed: number;
  recentNodes: number[];
};

const MAX_SPARKS = 64;
const MAX_HITS_PER_FRAME = 10;
const TAU = Math.PI * 2;
const STARLACE_LINKS_PER_NODE = 2;
const STARLACE_MAX_NODE_DEGREE = 4;
const STARLACE_MAX_LINK_SPAN = 0.33;
const STARLACE_LINK_FADE_START = 0.18;

// Hz table for the current key. Refreshed per Starlace instance via the
// KeyDirector subscription so each starlace harp picks up new tunings as the
// tour advances. Length stays constant (one entry per pentatonic step).

const _worldUp = new THREE.Vector3(0, 1, 0);
const _contactDelta = new THREE.Vector3();
const _segment = new THREE.Vector3();
const _pointDelta = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _scratch = new THREE.Vector3();
const _scratch2 = new THREE.Vector3();
const _pointerDelta = new THREE.Vector3();
const _pointerNdcSample = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _dummy = new THREE.Object3D();
const _colorA = new THREE.Color();
const _colorB = new THREE.Color();
const _colorC = new THREE.Color();

const STARLACE_NOTE_PALETTE = [
  '#ffc45c',
  '#f08a4f',
  '#e06a60',
  '#d8699f',
  '#9a7fd9',
  '#5fa8c8',
  '#69bcae',
  '#f2a84a',
] as const;

const STARLACE_DUSK_COOL = new THREE.Color('#4f8f95');
const STARLACE_DUSK_WARM = new THREE.Color('#c76551');
const STARLACE_DUSK_GOLD = new THREE.Color('#d99a3f');
const STARLACE_DUSK_HOT = new THREE.Color('#eead57');

const smoothstep01 = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export class Starlace implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: StarlaceParams;

  private nodes: StarNode[] = [];
  private edges: [number, number][] = [];
  private edgeDistances: number[] = [];
  private adjacency: number[][] = [];
  private linePositions: Float32Array;
  private lineColors: Float32Array;
  private pulseLinePositions: Float32Array;
  private pulseLineColors: Float32Array;
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
  // Intro/outro reveal: a "front" sweeps outward (or inward) from a chosen
  // origin node. Each node's reveal scale ramps as the front passes it, and
  // edges grow from their already-revealed endpoint toward the other node so
  // the whole structure self-assembles like crystal forming.
  private revealStartedAt = -Infinity;
  private revealDirection: 1 | -1 = 1;
  private revealActive = false;
  private revealedFully = false;
  private revealResolveOutro?: () => void;
  private outroPromise?: Promise<void>;
  private nodeDistance: number[] = [];
  private maxNodeDistance = 1;
  private nodeRevealT: number[] = [];
  private edgeRevealT: number[] = [];
  private revealOriginIndex = 0;
  private static readonly REVEAL_DURATION_IN = 1.55;
  private static readonly REVEAL_DURATION_OUT = 0.85;
  private static readonly REVEAL_FRONT_SOFTNESS = 0.85;
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
  private noteColors: THREE.Color[] = STARLACE_NOTE_PALETTE.map(hex => new THREE.Color(hex));
  private hzTable: readonly number[] = getStarlaceHz(keyDirector.getCurrent());
  private keyUnsubscribe?: () => void;
  private onPluckCallback?: (event: StarlacePluck) => void;
  private sculptor?: import('../sculptor/EnergyEmitter').EnergySink;
  private keyDownListener?: (e: KeyboardEvent) => void;
  private keyUpListener?: (e: KeyboardEvent) => void;
  private keyBlurListener?: () => void;
  private keyboardPitchNodes: number[][] = [];
  private keyboardStartCursor: number[] = [];
  private keyboardPaths = new Map<string, KeyboardPathState>();
  private camera?: THREE.Camera;
  private canvas?: HTMLCanvasElement;
  private pointerNdc = new THREE.Vector2(999, 999);
  private pointerNdcPrev = new THREE.Vector2(999, 999);
  private pointerNdcPrevValid = false;
  private pointerLastAtMs = -Infinity;
  private pointerDown = false;
  private pointerClickQueued = false;
  private pointerNodeInside: boolean[] = [];
  private pointerSweepSeen: boolean[] = [];
  private pointerFrameFired: boolean[] = [];
  private pointerMoveListener?: (event: PointerEvent) => void;
  private pointerDownListener?: (event: PointerEvent) => void;
  private pointerUpListener?: (event: PointerEvent) => void;
  private pointerCancelListener?: (event: PointerEvent) => void;
  private palette: StarlacePalette;
  private fixedAnchor?: THREE.Vector3;
  private registered?: ReturnType<typeof registerTweaks<typeof STARLACE_DEFS>>;

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey = 'starlace', opts: StarlaceOptions = {}) {
    this.params = { ...Object.fromEntries(Object.entries(STARLACE_DEFS).map(([k, d]) => [k, d.default])) } as StarlaceParams;
    applyPaletteDefaults(this.params, opts.palette ?? 'local');
    this.onPluckCallback = opts.onPluck;
    this.sculptor = opts.sculptor;
    this.palette = opts.palette ?? 'local';
    this.fixedAnchor = opts.anchor?.clone();
    this.camera = opts.camera;
    this.canvas = opts.canvas;

    this.mesh = new THREE.Group();
    this.mesh.name = `starlace-harp-${opts.palette ?? 'local'}`;
    scene.add(this.mesh);

    this.keyUnsubscribe = keyDirector.onChange(({ current }) => {
      this.hzTable = getStarlaceHz(current);
    });

    this.createNodes();
    this.createEdges();
    this.buildKeyboardPitchBuckets();
    this.pointerNodeInside = Array.from({ length: this.nodes.length }, () => false);
    this.pointerSweepSeen = Array.from({ length: this.nodes.length }, () => false);
    this.pointerFrameFired = Array.from({ length: this.nodes.length }, () => false);

    this.linePositions = new Float32Array(this.edges.length * 2 * 3);
    this.lineColors = new Float32Array(this.edges.length * 2 * 3);
    this.pulseLinePositions = new Float32Array(this.edges.length * 2 * 3);
    this.pulseLineColors = new Float32Array(this.edges.length * 2 * 3);
    this.lineGeometry = new THREE.BufferGeometry();
    this.pulseLineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.lineGeometry.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3));
    this.pulseLineGeometry.setAttribute('position', new THREE.BufferAttribute(this.pulseLinePositions, 3));
    this.pulseLineGeometry.setAttribute('color', new THREE.BufferAttribute(this.pulseLineColors, 3));

    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: this.params.linkOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.pulseLineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
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
      opacity: 0.82,
      blending: THREE.NormalBlending,
      depthWrite: false,
      vertexColors: true,
    });
    this.nodeMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), this.nodeMaterial, this.nodes.length);
    this.nodeMesh.frustumCulled = false;
    this.nodeMesh.renderOrder = 20;
    this.mesh.add(this.nodeMesh);

    this.sparkMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.64,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
    });
    this.sparkMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), this.sparkMaterial, MAX_SPARKS);
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = 22;
    this.mesh.add(this.sparkMesh);

    this.applyColors();
    this.writeHiddenSparks();

    if (this.palette === 'local') {
      this.attachKeyboardEvents();
      if (this.camera && this.canvas) this.attachPointerEvents(this.canvas);
    }

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
      this.keyboardPaths.clear();
    }
  }

  setAnchor(anchor: THREE.Vector3): void {
    this.fixedAnchor = anchor.clone();
    this.anchor.copy(anchor);
    this.center.copy(anchor);
  }

  startHidden(): void {
    this.mesh.visible = false;
    this.keyboardPaths.clear();
    this.revealedFully = false;
    this.revealActive = false;
    this.fillRevealValues(0);
  }

  playIntroAnimation(): void {
    this.pickRevealOrigin();
    this.revealStartedAt = this.elapsed;
    this.revealDirection = 1;
    this.revealActive = true;
    this.revealedFully = false;
    this.fillRevealValues(0);
    this.mesh.visible = true;
  }

  // Idempotent: a duplicate trigger (e.g. HUD pick + multiplayer echo) must
  // hand back the existing promise instead of starting a second outro that
  // would orphan the first awaiter and leave the swap mid-air.
  playOutroAnimation(): Promise<void> {
    if (!this.mesh.visible) return Promise.resolve();
    if (this.outroPromise) return this.outroPromise;
    // Outro picks a fresh origin so the dissolve doesn't read as a literal
    // rewind of the intro — gives the second instrument a different "feel."
    this.pickRevealOrigin();
    this.revealStartedAt = this.elapsed;
    this.revealDirection = -1;
    this.revealActive = true;
    this.revealedFully = false;
    this.outroPromise = new Promise(resolve => {
      this.revealResolveOutro = resolve;
    });
    return this.outroPromise;
  }

  isInteractive(): boolean {
    return this.revealedFully && !this.revealActive;
  }

  private pickRevealOrigin(): void {
    if (this.nodes.length === 0) return;
    this.revealOriginIndex = Math.floor(Math.random() * this.nodes.length);
    this.computeRevealDistances();
  }

  // BFS hop-count distance from the origin. Hop count gives clean, bandy
  // contours that feel like a ripple rather than the noisy world-space-radius
  // alternative — the structure is irregular enough that geodesic hops
  // matches the eye's intuition for "how far out is this node."
  private computeRevealDistances(): void {
    const n = this.nodes.length;
    this.nodeDistance = new Array(n).fill(Infinity);
    this.nodeDistance[this.revealOriginIndex] = 0;
    const queue: number[] = [this.revealOriginIndex];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const next = this.nodeDistance[cur] + 1;
      for (const nb of this.adjacency[cur] ?? []) {
        if (next < this.nodeDistance[nb]) {
          this.nodeDistance[nb] = next;
          queue.push(nb);
        }
      }
    }
    let max = 1;
    for (let i = 0; i < n; i += 1) {
      if (Number.isFinite(this.nodeDistance[i])) max = Math.max(max, this.nodeDistance[i]);
    }
    this.maxNodeDistance = max;
    this.nodeRevealT = new Array(n).fill(0);
    this.edgeRevealT = new Array(this.edges.length).fill(0);
  }

  private fillRevealValues(value: number): void {
    if (this.nodeRevealT.length !== this.nodes.length) {
      this.nodeRevealT = new Array(this.nodes.length).fill(value);
    } else {
      this.nodeRevealT.fill(value);
    }
    if (this.edgeRevealT.length !== this.edges.length) {
      this.edgeRevealT = new Array(this.edges.length).fill(value);
    } else {
      this.edgeRevealT.fill(value);
    }
  }

  // Computes per-node + per-edge reveal scalars from the sweep front. Called
  // once per frame. Off the front (already-passed nodes) hold at 1; nodes
  // ahead of the front hold at 0; nodes inside the soft band ramp up.
  private updateRevealValues(): void {
    if (!this.revealActive && !this.revealedFully) {
      this.fillRevealValues(0);
      return;
    }
    if (!this.revealActive && this.revealedFully) {
      this.fillRevealValues(1);
      return;
    }
    const isIn = this.revealDirection === 1;
    const total = isIn ? Starlace.REVEAL_DURATION_IN : Starlace.REVEAL_DURATION_OUT;
    const localT = clamp((this.elapsed - this.revealStartedAt) / Math.max(total, 0.0001), 0, 1);
    // Front sweeps from -softness to maxDistance + softness so the boundary
    // can fully clear the farthest nodes by the end.
    const softness = Starlace.REVEAL_FRONT_SOFTNESS;
    const span = this.maxNodeDistance + softness * 2;
    const frontIn = -softness + span * localT;
    // Outro: same sweep direction, but fades nodes from 1 → 0 as the front
    // passes them. Visually reads as "structure dissolves outward".
    for (let i = 0; i < this.nodes.length; i += 1) {
      const d = this.nodeDistance[i];
      const t = isIn
        ? smoothstep01((frontIn - d) / softness)
        : 1 - smoothstep01((frontIn - d) / softness);
      this.nodeRevealT[i] = t;
    }
    // Edge reveal lags the slower of its two endpoints — the line "draws"
    // from the already-present node out to the newly-arriving one.
    for (let e = 0; e < this.edges.length; e += 1) {
      const [a, b] = this.edges[e];
      this.edgeRevealT[e] = Math.min(this.nodeRevealT[a], this.nodeRevealT[b]);
    }
  }

  private tickReveal(): void {
    if (!this.revealActive) return;
    const total = this.revealDirection === 1
      ? Starlace.REVEAL_DURATION_IN
      : Starlace.REVEAL_DURATION_OUT;
    if (this.elapsed - this.revealStartedAt < total + 0.05) return;
    this.revealActive = false;
    if (this.revealDirection === 1) {
      this.revealedFully = true;
      this.fillRevealValues(1);
    } else {
      this.revealedFully = false;
      this.fillRevealValues(0);
      this.mesh.visible = false;
      const resolve = this.revealResolveOutro;
      this.revealResolveOutro = undefined;
      this.outroPromise = undefined;
      resolve?.();
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
      if (this.fixedAnchor) {
        this.anchor.copy(this.fixedAnchor);
      } else {
        this.anchor.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
        this.anchor.y += 0.05;
      }
      this.initialized = true;
    }

    const palmAlpha = 1 - Math.exp(-delta * 16);
    this.left.lerp(leftPalm, palmAlpha);
    this.right.lerp(rightPalm, palmAlpha);
    if (this.fixedAnchor) {
      this.anchor.copy(this.fixedAnchor);
    } else {
      _scratch.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
      _scratch.y += 0.05;
      const anchorAlpha = 1 - Math.exp(-delta / Math.max(0.05, this.params.anchorSmoothing));
      this.anchor.lerp(_scratch, anchorAlpha);
    }
    this.center.copy(this.anchor);

    this.smoothedEnergy += ((voice.active ? voice.energy : 0) - this.smoothedEnergy) * (1 - Math.exp(-delta * 5));
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * (1 - Math.exp(-delta * 12));
    this.smoothedPitch += (voice.pitch - this.smoothedPitch) * (1 - Math.exp(-delta * 8));
    this.smoothedExpression += (voice.expression - this.smoothedExpression) * (1 - Math.exp(-delta * 8));
    this.smoothedTension += (voice.tension - this.smoothedTension) * (1 - Math.exp(-delta * 7));

    this.resolveAxes();
    this.writeNodePositions();
    this.updateRevealValues();
    if (this.revealedFully && !this.revealActive) {
      this.processKeyboardPaths();
      this.processContacts(this.resolveContacts(leftPalm, rightPalm, contacts), delta);
      this.processPointer(delta);
    } else {
      this.keyboardPaths.clear();
      this.clearPointerState();
    }
    this.decayPulses(delta);
    this.writeLines();
    this.writeNodes();
    this.writeSparks();
    this.tickReveal();
  }

  dispose(): void {
    this.detachKeyboardEvents();
    this.detachPointerEvents();
    this.keyUnsubscribe?.();
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
      this.nodes.push({
        u,
        v,
        z,
        seed,
        noteIndex: 0,
        pulse: 0,
        lastHitAt: -100,
        world: new THREE.Vector3(),
      });
    }
    this.assignNodePitches();
  }

  private assignNodePitches(): void {
    const byPitchPosition = this.nodes
      .map((node, i) => ({ i, score: node.v * 0.78 + node.u * 0.22 }))
      .sort((a, b) => a.score - b.score);
    const maxRank = Math.max(1, byPitchPosition.length - 1);
    for (let rank = 0; rank < byPitchPosition.length; rank += 1) {
      const noteIndex = Math.round((rank / maxRank) * (this.hzTable.length - 1));
      this.nodes[byPitchPosition[rank].i].noteIndex = clamp(noteIndex, 0, this.hzTable.length - 1);
    }
  }

  private createEdges(): void {
    // Similar in spirit to Three's linked-particles example: each node owns
    // only a couple of nearest links, with a hard degree cap and span cutoff.
    // That keeps the visible lace local instead of becoming a dense hairball.
    type Pair = { i: number; j: number; d: number };
    const distances: Pair[] = [];
    for (let i = 0; i < this.nodes.length; i += 1) {
      for (let j = i + 1; j < this.nodes.length; j += 1) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        const du = a.u - b.u;
        const dv = a.v - b.v;
        const dz = (a.z - b.z) * 1.15;
        const d = Math.sqrt(du * du + dv * dv + dz * dz);
        distances.push({ i, j, d });
      }
    }
    distances.sort((a, b) => a.d - b.d);
    const degree = new Array(this.nodes.length).fill(0);
    const outgoing = new Array(this.nodes.length).fill(0);
    const seen = new Set<string>();
    for (const p of distances) {
      if (p.d > STARLACE_MAX_LINK_SPAN) continue;
      const key = `${p.i}:${p.j}`;
      if (seen.has(key)) continue;
      if (degree[p.i] >= STARLACE_MAX_NODE_DEGREE || degree[p.j] >= STARLACE_MAX_NODE_DEGREE) continue;
      if (outgoing[p.i] >= STARLACE_LINKS_PER_NODE && outgoing[p.j] >= STARLACE_LINKS_PER_NODE) continue;

      let owner = outgoing[p.i] <= outgoing[p.j] ? p.i : p.j;
      if (outgoing[owner] >= STARLACE_LINKS_PER_NODE) owner = owner === p.i ? p.j : p.i;
      if (outgoing[owner] >= STARLACE_LINKS_PER_NODE) continue;

      this.edges.push([p.i, p.j]);
      this.edgeDistances.push(p.d);
      seen.add(key);
      outgoing[owner] += 1;
      degree[p.i] += 1;
      degree[p.j] += 1;
    }
    this.adjacency = Array.from({ length: this.nodes.length }, () => []);
    for (const [a, b] of this.edges) {
      this.adjacency[a].push(b);
      this.adjacency[b].push(a);
    }
  }

  private buildKeyboardPitchBuckets(): void {
    this.keyboardPitchNodes = Array.from({ length: this.hzTable.length }, () => []);
    for (let i = 0; i < this.nodes.length; i += 1) {
      const noteIndex = this.nodes[i].noteIndex;
      this.keyboardPitchNodes[noteIndex]?.push(i);
    }
    for (const bucket of this.keyboardPitchNodes) {
      bucket.sort((a, b) => {
        const nodeA = this.nodes[a];
        const nodeB = this.nodes[b];
        return nodeA.u === nodeB.u ? nodeA.v - nodeB.v : nodeA.u - nodeB.u;
      });
    }
    this.keyboardStartCursor = Array.from({ length: this.hzTable.length }, () => 0);
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
    let colorCursor = 0;
    for (let e = 0; e < this.edges.length; e += 1) {
      const [aIdx, bIdx] = this.edges[e];
      const a = this.nodes[aIdx];
      const b = this.nodes[bIdx];
      // Edge "draws" from the already-revealed endpoint toward the
      // newly-arriving one. With both endpoints fully revealed, t=1 and the
      // line spans the full edge as before.
      const t = this.edgeRevealT[e] ?? 1;
      const eased = smoothstep01(t);
      const bx = a.world.x + (b.world.x - a.world.x) * eased;
      const by = a.world.y + (b.world.y - a.world.y) * eased;
      const bz = a.world.z + (b.world.z - a.world.z) * eased;
      const distance = this.edgeDistances[e] ?? STARLACE_MAX_LINK_SPAN;
      const distanceFade = 1 - smoothstep01(
        (distance - STARLACE_LINK_FADE_START) / Math.max(0.001, STARLACE_MAX_LINK_SPAN - STARLACE_LINK_FADE_START),
      );
      const edgePulse = Math.max(a.pulse, b.pulse);
      const lineGlow = eased * clamp(0.18 + distanceFade * 0.86 + edgePulse * 0.24 + this.smoothedEnergy * 0.14, 0, 1.12);
      const pulseGlow = eased * clamp(edgePulse * 0.92 + this.smoothedPulse * 0.18, 0, 1.08);
      this.linePositions[cursor] = a.world.x;
      this.pulseLinePositions[cursor++] = a.world.x;
      this.linePositions[cursor] = a.world.y;
      this.pulseLinePositions[cursor++] = a.world.y;
      this.linePositions[cursor] = a.world.z;
      this.pulseLinePositions[cursor++] = a.world.z;
      this.linePositions[cursor] = bx;
      this.pulseLinePositions[cursor++] = bx;
      this.linePositions[cursor] = by;
      this.pulseLinePositions[cursor++] = by;
      this.linePositions[cursor] = bz;
      this.pulseLinePositions[cursor++] = bz;

      _colorA.copy(this.cool).lerp(this.gold, 0.58).multiplyScalar(lineGlow);
      this.noteColorForNode(a, _colorB).lerp(this.hot, 0.08 + edgePulse * 0.06).multiplyScalar(pulseGlow);
      this.noteColorForNode(b, _colorC).lerp(this.hot, 0.08 + edgePulse * 0.06).multiplyScalar(pulseGlow);

      this.lineColors[colorCursor] = _colorA.r;
      this.pulseLineColors[colorCursor++] = _colorB.r;
      this.lineColors[colorCursor] = _colorA.g;
      this.pulseLineColors[colorCursor++] = _colorB.g;
      this.lineColors[colorCursor] = _colorA.b;
      this.pulseLineColors[colorCursor++] = _colorB.b;

      this.lineColors[colorCursor] = _colorA.r;
      this.pulseLineColors[colorCursor++] = _colorC.r;
      this.lineColors[colorCursor] = _colorA.g;
      this.pulseLineColors[colorCursor++] = _colorC.g;
      this.lineColors[colorCursor] = _colorA.b;
      this.pulseLineColors[colorCursor++] = _colorC.b;
      maxPulse = Math.max(maxPulse, a.pulse, b.pulse);
    }
    this.maxPulse += (maxPulse - this.maxPulse) * 0.35;
    (this.lineGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.pulseLineGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pulseLineGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.lineMaterial.opacity = Math.max(0.28, this.params.linkOpacity) * (1.04 + this.smoothedEnergy * 0.24);
    this.pulseLineMaterial.opacity = clamp(this.maxPulse * 0.52 + this.smoothedPulse * 0.16, 0, 0.66);
  }

  private writeNodes(): void {
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const twinkle = 0.5 + Math.sin(this.elapsed * (1.2 + node.seed * 1.7) + node.seed * TAU) * 0.5;
      const pitchGlow = 1 - Math.abs((node.noteIndex / (this.hzTable.length - 1)) - this.smoothedPitch);
      const pulse = clamp(node.pulse + pitchGlow * this.smoothedEnergy * 0.18 + twinkle * 0.07, 0, 1);
      const reveal = smoothstep01(this.nodeRevealT[i] ?? 1);
      const size = this.params.nodeRadius * (0.70 + twinkle * 0.28 + pulse * 1.10) * reveal;

      _dummy.position.copy(node.world);
      _dummy.scale.setScalar(size);
      _dummy.updateMatrix();
      this.nodeMesh.setMatrixAt(i, _dummy.matrix);

      _colorA.copy(this.cool).lerp(this.warm, clamp(node.u + 0.5, 0, 1));
      this.noteColorForNode(node, _colorB);
      _colorA.lerp(_colorB, clamp(pulse * 0.68 + node.pulse * 0.14, 0, 0.88));
      _colorA.lerp(this.hot, Math.pow(pulse, 3) * 0.10);
      const boost = 0.70 + pulse * 0.64;
      _colorB.copy(_colorA);
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
      this.noteColorForNode(a, _colorA).lerp(this.noteColorForNode(b, _colorB), t);
      _colorA.lerp(this.hot, 0.08).multiplyScalar(0.92 + spark.intensity * 0.34);
      this.sparkMesh.setColorAt(visible, _colorA);
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
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;
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

  private attachPointerEvents(canvas: HTMLCanvasElement): void {
    const updatePointer = (event: PointerEvent): boolean => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return false;
      this.pointerNdc.set(x * 2 - 1, -(y * 2 - 1));
      this.pointerLastAtMs = performance.now();
      return true;
    };

    this.pointerMoveListener = event => {
      if (this.isPointerUiTarget(event)) {
        this.clearPointerState();
        return;
      }
      if (!updatePointer(event) && !this.pointerDown) this.clearPointerState();
    };
    this.pointerDownListener = event => {
      if (this.isPointerUiTarget(event)) return;
      if (!updatePointer(event)) return;
      this.pointerDown = true;
      this.pointerClickQueued = true;
    };
    this.pointerUpListener = () => {
      this.pointerDown = false;
    };
    this.pointerCancelListener = () => {
      this.pointerDown = false;
      this.clearPointerState();
    };

    window.addEventListener('pointermove', this.pointerMoveListener, true);
    window.addEventListener('pointerdown', this.pointerDownListener, true);
    window.addEventListener('pointerup', this.pointerUpListener, true);
    window.addEventListener('pointercancel', this.pointerCancelListener, true);
  }

  private detachPointerEvents(): void {
    if (this.pointerMoveListener) window.removeEventListener('pointermove', this.pointerMoveListener, true);
    if (this.pointerDownListener) window.removeEventListener('pointerdown', this.pointerDownListener, true);
    if (this.pointerUpListener) window.removeEventListener('pointerup', this.pointerUpListener, true);
    if (this.pointerCancelListener) window.removeEventListener('pointercancel', this.pointerCancelListener, true);
    this.pointerMoveListener = undefined;
    this.pointerDownListener = undefined;
    this.pointerUpListener = undefined;
    this.pointerCancelListener = undefined;
  }

  private isPointerUiTarget(event: PointerEvent): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    if (target === this.canvas) return false;
    return !!target.closest('button,input,textarea,select,a,[contenteditable="true"],[role="button"],#ui > *,#stage > *');
  }

  private clearPointerState(): void {
    if (this.pointerDown) return;
    this.pointerClickQueued = false;
    this.pointerNdcPrevValid = false;
    this.pointerLastAtMs = -Infinity;
    this.pointerNodeInside.fill(false);
  }

  private processPointer(delta: number): void {
    const camera = this.camera;
    if (!camera || !this.canvas) {
      this.clearPointerState();
      return;
    }

    const recent = (performance.now() - this.pointerLastAtMs) / 1000 < 0.42 || this.pointerDown;
    if (!recent) {
      this.clearPointerState();
      return;
    }

    let ndcSpeed = 0;
    if (this.pointerNdcPrevValid && delta > 0) {
      ndcSpeed = this.pointerNdc.distanceTo(this.pointerNdcPrev) / delta;
    }

    const clickQueued = this.pointerClickQueued;
    this.pointerClickQueued = false;
    const hadPrevious = this.pointerNdcPrevValid;
    const ndcDistance = hadPrevious ? this.pointerNdc.distanceTo(this.pointerNdcPrev) : 0;
    const sampleCount = hadPrevious ? clamp(Math.ceil(ndcDistance / 0.022), 1, 40) : 1;
    this.pointerSweepSeen.fill(false);
    this.pointerFrameFired.fill(false);

    for (let s = 0; s <= sampleCount; s += 1) {
      if (hadPrevious) {
        _pointerNdcSample.copy(this.pointerNdcPrev).lerp(this.pointerNdc, s / sampleCount);
      } else {
        _pointerNdcSample.copy(this.pointerNdc);
      }
      const nodeIndex = this.pickPointerNode(_pointerNdcSample, camera);
      if (nodeIndex < 0 || this.pointerSweepSeen[nodeIndex]) continue;
      this.pointerSweepSeen[nodeIndex] = true;
    }

    const activeNode = this.pickPointerNode(this.pointerNdc, camera);
    const velocity = this.pointerVelocity(ndcSpeed, clickQueued);

    for (let i = 0; i < this.nodes.length; i += 1) {
      if (!this.pointerSweepSeen[i] || this.pointerNodeInside[i]) continue;
      this.pointerFrameFired[i] = this.firePointerNode(i, velocity);
    }

    if (clickQueued && activeNode >= 0 && !this.pointerFrameFired[activeNode]) {
      this.pointerFrameFired[activeNode] = this.firePointerNode(activeNode, velocity);
    }

    for (let i = 0; i < this.nodes.length; i += 1) {
      this.pointerNodeInside[i] = i === activeNode;
    }
    this.pointerNdcPrev.copy(this.pointerNdc);
    this.pointerNdcPrevValid = true;
  }

  private pickPointerNode(ndc: THREE.Vector2, camera: THREE.Camera): number {
    _raycaster.setFromCamera(ndc, camera);
    const ray = _raycaster.ray;
    const hitRadius = Math.max(this.params.nodeRadius * 2.65, 0.040);
    const hitRadiusSq = hitRadius * hitRadius;
    let best = -1;
    let bestDistSq = Infinity;
    let bestAlongRay = Infinity;

    for (let i = 0; i < this.nodes.length; i += 1) {
      if ((this.nodeRevealT[i] ?? 1) < 0.2) continue;
      const node = this.nodes[i];
      _pointerDelta.copy(node.world).sub(ray.origin);
      const alongRay = _pointerDelta.dot(ray.direction);
      if (alongRay <= 0) continue;
      const distSq = ray.distanceSqToPoint(node.world);
      if (distSq > hitRadiusSq) continue;
      if (distSq > bestDistSq && Math.abs(distSq - bestDistSq) > 1e-6) continue;
      if (distSq >= bestDistSq && alongRay >= bestAlongRay) continue;
      best = i;
      bestDistSq = distSq;
      bestAlongRay = alongRay;
    }

    return best;
  }

  private pointerVelocity(ndcSpeed: number, clickQueued: boolean): number {
    const motion = clamp(ndcSpeed / 7.5, 0, 1);
    const contactBoost = clickQueued ? 0.24 : (this.pointerDown ? 0.12 : 0);
    return clamp(0.22 + contactBoost + motion * 0.64, 0.2, 1);
  }

  private firePointerNode(nodeIndex: number, velocity: number): boolean {
    const node = this.nodes[nodeIndex];
    if (!node || this.elapsed - node.lastHitAt < this.params.hitCooldown) return false;
    this.fireNode(nodeIndex, velocity);
    return true;
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
        noteIndex: node.noteIndex,
        frequency: this.hzTable[node.noteIndex],
        velocity,
        x: clamp(node.u + 0.5, 0, 1),
        y: clamp(node.v + 0.5, 0, 1),
      });
    }
    this.emitStreak(node, velocity);
  }

  private static readonly KEY_MAP: ReadonlyArray<string> = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
  private static readonly KEYBOARD_INTERVAL_PATTERN: ReadonlyArray<number> = [1, 2, -1, 3, 1, -2, 2, -1];
  private static readonly KEYBOARD_RECENT_LIMIT = 8;

  private attachKeyboardEvents(): void {
    this.keyDownListener = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.isKeyboardTextTarget(e.target)) return;
      if (!this.isInteractive()) return;
      const key = e.key.toLowerCase();
      const idx = Starlace.KEY_MAP.indexOf(key);
      if (idx < 0 || this.keyboardPaths.has(key)) return;
      e.preventDefault();
      this.startKeyboardPath(key, idx);
    };
    this.keyUpListener = (e: KeyboardEvent) => {
      this.keyboardPaths.delete(e.key.toLowerCase());
    };
    this.keyBlurListener = () => {
      this.keyboardPaths.clear();
    };
    window.addEventListener('keydown', this.keyDownListener);
    window.addEventListener('keyup', this.keyUpListener);
    window.addEventListener('blur', this.keyBlurListener);
  }

  private detachKeyboardEvents(): void {
    if (this.keyDownListener) {
      window.removeEventListener('keydown', this.keyDownListener);
      this.keyDownListener = undefined;
    }
    if (this.keyUpListener) {
      window.removeEventListener('keyup', this.keyUpListener);
      this.keyUpListener = undefined;
    }
    if (this.keyBlurListener) {
      window.removeEventListener('blur', this.keyBlurListener);
      this.keyBlurListener = undefined;
    }
    this.keyboardPaths.clear();
  }

  private isKeyboardTextTarget(target: EventTarget | null): boolean {
    const element = target instanceof HTMLElement ? target : null;
    if (!element) return false;
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
  }

  private startKeyboardPath(key: string, keyIndex: number): void {
    const homeNoteIndex = this.keyboardHomeNoteIndex(keyIndex);
    const startNode = this.pickKeyboardStartNode(homeNoteIndex);
    if (startNode < 0) return;

    const state: KeyboardPathState = {
      keyIndex,
      homeNoteIndex,
      currentNode: startNode,
      previousNode: -1,
      nextAt: this.elapsed,
      step: 0,
      phraseSeed: hash(keyIndex * 17.31 + this.elapsed * 0.71 + (this.keyboardStartCursor[homeNoteIndex] ?? 0) * 3.19),
      recentNodes: [startNode],
    };
    state.nextAt = this.elapsed + this.keyboardStepDelay(state);
    this.keyboardPaths.set(key, state);
    this.fireNode(startNode, 0.74);
  }

  private processKeyboardPaths(): void {
    if (this.keyboardPaths.size === 0) return;

    let fired = 0;
    for (const state of this.keyboardPaths.values()) {
      if (this.elapsed < state.nextAt) continue;

      const nextNode = this.pickKeyboardNextNode(state);
      if (nextNode >= 0) {
        state.previousNode = state.currentNode;
        state.currentNode = nextNode;
        state.step += 1;
        this.rememberKeyboardNode(state, nextNode);
        this.fireNode(nextNode, this.keyboardPathVelocity(state));
        fired += 1;
      }

      const delay = this.keyboardStepDelay(state);
      state.nextAt = Math.max(state.nextAt + delay, this.elapsed + delay * 0.65);
      if (fired >= MAX_HITS_PER_FRAME) return;
    }
  }

  private keyboardHomeNoteIndex(keyIndex: number): number {
    return clamp(keyIndex, 0, this.hzTable.length - 1);
  }

  private pickKeyboardStartNode(homeNoteIndex: number): number {
    const exact = this.keyboardPitchNodes[homeNoteIndex] ?? [];
    if (exact.length > 0) {
      const cursor = this.keyboardStartCursor[homeNoteIndex] ?? 0;
      this.keyboardStartCursor[homeNoteIndex] = cursor + 1;
      return exact[cursor % exact.length];
    }

    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const score = Math.abs(node.noteIndex - homeNoteIndex) * 10 + Math.abs(node.u) + Math.abs(node.v) * 0.4;
      if (score >= bestScore) continue;
      best = i;
      bestScore = score;
    }
    return best;
  }

  private pickKeyboardNextNode(state: KeyboardPathState): number {
    if (!this.nodes[state.currentNode]) return this.pickKeyboardStartNode(state.homeNoteIndex);

    const candidates = this.collectKeyboardCandidates(state.currentNode, state.step % 4 === 2);
    if (candidates.length === 0) return this.pickKeyboardStartNode(state.homeNoteIndex);

    const current = this.nodes[state.currentNode];
    const desiredInterval = Starlace.KEYBOARD_INTERVAL_PATTERN[
      (state.step + state.keyIndex) % Starlace.KEYBOARD_INTERVAL_PATTERN.length
    ];
    const desiredDirection = Math.sign(Math.sin((state.step + 1 + state.phraseSeed * 4) * 0.92));

    let best = -1;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const node = this.nodes[candidate.index];
      if (!node) continue;
      const interval = node.noteIndex - current.noteIndex;
      const recentIndex = state.recentNodes.lastIndexOf(candidate.index);
      const recentPenalty = recentIndex < 0
        ? 0
        : 1.0 + (recentIndex / Math.max(1, state.recentNodes.length - 1)) * 0.85;
      const directionPenalty = desiredDirection !== 0 && Math.sign(interval) === -desiredDirection ? 0.36 : 0;
      const homeDrift = Math.max(0, Math.abs(node.noteIndex - state.homeNoteIndex) - 6) * 0.42;
      const score =
        Math.abs(interval - desiredInterval) * 0.34 +
        (node.noteIndex === current.noteIndex ? 0.5 : 0) +
        (candidate.index === state.previousNode ? 0.9 : 0) +
        recentPenalty +
        directionPenalty +
        homeDrift +
        node.pulse * 0.28 +
        candidate.hops * 0.08 +
        hash(candidate.index * 41.11 + state.step * 7.13 + state.phraseSeed * 19.7) * 0.22;

      if (score >= bestScore) continue;
      best = candidate.index;
      bestScore = score;
    }

    return best;
  }

  private collectKeyboardCandidates(nodeIndex: number, includeSecondHop: boolean): Array<{ index: number; hops: number }> {
    const direct = this.adjacency[nodeIndex] ?? [];
    const byIndex = new Map<number, number>();
    const add = (index: number, hops: number): void => {
      if (index === nodeIndex) return;
      const previous = byIndex.get(index);
      if (previous !== undefined && previous <= hops) return;
      byIndex.set(index, hops);
    };

    for (const index of direct) add(index, 1);
    if (includeSecondHop || direct.length <= 2) {
      for (const index of direct) {
        for (const second of this.adjacency[index] ?? []) add(second, 2);
      }
    }

    return [...byIndex.entries()].map(([index, hops]) => ({ index, hops }));
  }

  private rememberKeyboardNode(state: KeyboardPathState, nodeIndex: number): void {
    state.recentNodes.push(nodeIndex);
    if (state.recentNodes.length > Starlace.KEYBOARD_RECENT_LIMIT) {
      state.recentNodes.splice(0, state.recentNodes.length - Starlace.KEYBOARD_RECENT_LIMIT);
    }
  }

  private keyboardStepDelay(state: KeyboardPathState): number {
    const base = clamp(this.params.keyWalkInterval, 0.18, 0.75);
    const swing = Math.sin((state.step + 1) * 1.73 + state.phraseSeed * TAU) * 0.035;
    const breath = state.step % 7 === 6 ? 0.045 : 0;
    return clamp(base + swing + breath, 0.22, 0.82);
  }

  private keyboardPathVelocity(state: KeyboardPathState): number {
    const accent = state.step % 4 === 1 ? 0.11 : 0;
    return clamp(0.52 + accent + hash(state.step * 11.23 + state.phraseSeed * 5.7) * 0.18, 0.48, 0.84);
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
    this.cool.set(this.params.coolColor).lerp(STARLACE_DUSK_COOL, 0.30).multiplyScalar(0.94);
    this.warm.set(this.params.warmColor).lerp(STARLACE_DUSK_WARM, 0.30).multiplyScalar(0.98);
    this.gold.set(this.params.goldColor).lerp(STARLACE_DUSK_GOLD, 0.34).multiplyScalar(1.00);
    this.hot.set(this.params.hotColor).lerp(STARLACE_DUSK_HOT, 0.42).multiplyScalar(1.00);
    this.noteColors = STARLACE_NOTE_PALETTE.map(hex => new THREE.Color(hex).multiplyScalar(0.94));
    this.lineMaterial.color.copy(STARLACE_DUSK_GOLD).lerp(STARLACE_DUSK_COOL, 0.16).multiplyScalar(1.14);
    this.pulseLineMaterial.color.copy(STARLACE_DUSK_HOT).lerp(STARLACE_DUSK_WARM, 0.18).multiplyScalar(1.10);
    this.nodeMaterial.color.copy(STARLACE_DUSK_HOT).lerp(STARLACE_DUSK_WARM, 0.35).multiplyScalar(1.12);
    this.sparkMaterial.color.copy(STARLACE_DUSK_HOT).lerp(STARLACE_DUSK_COOL, 0.12).multiplyScalar(1.12);
  }

  private noteColorForNode(node: StarNode, target: THREE.Color): THREE.Color {
    const maxNote = Math.max(1, this.hzTable.length - 1);
    const palettePos = (node.noteIndex / maxNote) * (this.noteColors.length - 1);
    const low = Math.floor(palettePos);
    const high = Math.min(this.noteColors.length - 1, low + 1);
    const t = palettePos - low;
    const glint = hash(node.seed * 19.7 + node.noteIndex * 3.31);
    target.copy(this.noteColors[low]).lerp(this.noteColors[high], t);
    if (glint > 0.76) target.lerp(this.gold, 0.18);
    return target;
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
    params.coolColor = '#a37bd8';
    params.warmColor = '#e66f9d';
    params.goldColor = '#d89b51';
    params.hotColor = '#ffba67';
    return;
  }
  params.coolColor = '#5fb6c4';
  params.warmColor = '#e56f67';
  params.goldColor = '#edae4a';
  params.hotColor = '#ffd06a';
}
