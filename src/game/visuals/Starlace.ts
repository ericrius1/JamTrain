import * as THREE from 'three/webgpu';
import {
  float,
  instancedBufferAttribute,
  normalView,
  screenUV,
  vec3,
  viewportMipTexture,
} from 'three/tsl';
import { isDebugVisible } from '../../hud/debugMode';
import { registerTweaks, type ParamsOf } from '../../hud/tweakDefs';
import { getStarlaceHz } from '../harmony';
import { keyDirector } from '../keyDirector';
import type { HandContactPoint, InstrumentPerformanceEvent, PlayerVisual, VoiceState } from '../instruments';
import { clamp, hash } from '../math';

export const STARLACE_DEFS = {
  width:           { default: 0.58,  min: 0.36, max: 1.35, step: 0.01,  label: 'width' },
  height:          { default: 0.40,  min: 0.18, max: 1.05, step: 0.01,  label: 'height' },
  depth:           { default: 0.32,  min: 0.00, max: 0.80, step: 0.005, label: 'depth' },
  nodeRadius:      { default: 0.016, min: 0.006, max: 0.05, step: 0.001, label: 'star size' },
  contactRadius:   { default: 0.085, min: 0.025, max: 0.18, step: 0.001, label: 'hand contact' },
  hitCooldown:     { default: 0.065, min: 0.02,  max: 0.35, step: 0.005, label: 'cooldown s' },
  pulseDecay:      { default: 4.8,   min: 1,     max: 14,   step: 0.1,   label: 'star fade' },
  linkOpacity:     { default: 0.42,  min: 0,     max: 0.9,  step: 0.01,  label: 'link opacity' },
  anchorSmoothing: { default: 5.5,   min: 0.2,   max: 16,   step: 0.1,   label: 'anchor s' },
  handSmoothing:   { default: 3.2,   min: 0.4,   max: 18,   step: 0.1,   label: 'hand smoothing' },
  axisSmoothing:   { default: 2.0,   min: 0.2,   max: 12,   step: 0.1,   label: 'turn smoothing' },
  maxTurnRate:     { default: 0.72,  min: 0.05,  max: 6,    step: 0.01,  label: 'turn rad/s' },
  keyWalkInterval: { default: 0.20,  min: 0.08,  max: 0.75, step: 0.005, label: 'tempo s' },
  keyPhraseJumps:  { default: 9,     min: 2,     max: 24,   step: 1,     label: 'phrase turns' },
  keyChordMaxNotes:{ default: 3,     min: 1,     max: 3,    step: 1,     label: 'arp width' },
  keyRhythmSwing:  { default: 0.34,  min: 0,     max: 1,    step: 0.01,  label: 'rhythm swing' },
  keyTempoDrift:   { default: 0.20,  min: 0,     max: 1,    step: 0.01,  label: 'tempo drift' },
  keyPathWander:   { default: 0.72,  min: 0,     max: 1,    step: 0.01,  label: 'path wander' },
  keyEdgeFollow:   { default: 0.66,  min: 0,     max: 1,    step: 0.01,  label: 'edge follow' },
  pluckAmplitude:  { default: 0.012, min: 0,     max: 0.06, step: 0.0005, label: 'pluck amplitude' },
  pluckFrequency:  { default: 24,    min: 2,     max: 90,   step: 0.5,   label: 'pluck frequency' },
  pluckDecay:      { default: 5.5,   min: 0.5,   max: 20,   step: 0.1,   label: 'pluck decay' },
  pluckSegments:   { default: 14,    min: 2,     max: 32,   step: 1,     label: 'pluck segments' },
  pluckImpulse:    { default: 0.85,  min: 0,     max: 2,    step: 0.01,  label: 'pluck impulse' },
  pluckTravel:     { default: 0.55,  min: 0,     max: 1,    step: 0.01,  label: 'pluck travel' },
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
  hand?: HandContactPoint['hand'];
  worldPosition: THREE.Vector3;
  x: number;
  y: number;
  chordRootIndex?: number;
  chordSize?: 1 | 2 | 3;
  phraseStep?: number;
  nodeIndices?: number[];
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

type KeyboardMotifStep = {
  rootIndex: number;
  chordSize: 1 | 2 | 3;
  nodeIndices: number[];
};

type KeyboardPathState = {
  keyIndex: number;
  homeNoteIndex: number;
  currentNode: number;
  previousNode: number;
  startNode: number;
  bfsDistance: number[];
  maxRing: number;
  cycleLength: number;
  nextAt: number;
  step: number;
  totalStages: number;
  phraseSeed: number;
  recentNodes: number[];
  velocity: number;
  motifSteps: KeyboardMotifStep[];
  motifRepeatsLeft: number;
  motifReplay: boolean;
  lastCycleIndex: number;
};

const MAX_HITS_PER_FRAME = 10;
const TAU = Math.PI * 2;
const STARLACE_LINKS_PER_NODE = 2;
const STARLACE_MAX_NODE_DEGREE = 4;
const STARLACE_MAX_LINK_SPAN = 0.33;
const STARLACE_LINK_FADE_START = 0.18;
const POINTER_PLUCK_MOTION_NDC_PER_SEC = 0.05;
const POINTER_HOLD_KEY = 'pointer:primary';

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
  '#e4a64c',
  '#d67b4f',
  '#dd5e85',
  '#c458aa',
  '#9274df',
  '#5c8bd2',
  '#3fb2c4',
  '#68bd9a',
  '#d7963f',
] as const;

const STARLACE_DUSK_COOL = new THREE.Color('#376f8e');
const STARLACE_DUSK_WARM = new THREE.Color('#8d4b83');
const STARLACE_DUSK_GOLD = new THREE.Color('#b87835');
const STARLACE_DUSK_HOT = new THREE.Color('#d9934d');
const STARLACE_FROST_WHITE = new THREE.Color('#f3fbff');
const STARLACE_GEM_VIOLET = new THREE.Color('#5d438d');
const STARLACE_GEM_WINE = new THREE.Color('#7d435f');
const STARLACE_GEM_TEAL = new THREE.Color('#2f7f84');
const STARLACE_GEM_BLUE = new THREE.Color('#4e6ed0');
const STARLACE_GEM_AMBER = new THREE.Color('#bd7838');
const STARLACE_GEM_ROSE = new THREE.Color('#a3527b');

const smoothstep01 = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export class Starlace implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: StarlaceParams;

  private nodes: StarNode[] = [];
  private performanceTargets: THREE.Vector3[] = [];
  private edges: [number, number][] = [];
  private edgeDistances: number[] = [];
  private adjacency: number[][] = [];
  private nodeEdges: number[][] = [];
  private edgePluck: Float32Array = new Float32Array(0);
  private edgePluckPhase: Float32Array = new Float32Array(0);
  private pluckSegments = 14;
  private _perp1 = new THREE.Vector3();
  private _perp2 = new THREE.Vector3();
  private _edgeDir = new THREE.Vector3();
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
  private nodeGeometry?: THREE.BufferGeometry;
  private nodeMesh?: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
  private nodeMaterial?: THREE.MeshBasicNodeMaterial;
  private nodeGlowMesh?: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private nodeGlowMaterial?: THREE.MeshBasicMaterial;
  private nodeGemParams?: THREE.InstancedBufferAttribute;

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
  private static readonly REVEAL_DURATION_IN = 1.0;
  private static readonly REVEAL_DURATION_OUT = 0.55;
  private static readonly REVEAL_FRONT_SOFTNESS = 0.85;
  // Steady lo-fi 8th/16th arpeggio grid. Mostly 16ths (1.0), with occasional
  // 8th breaths (2.0) and rare double-time runs (0.5). No stop-and-start; reads
  // as a flowing arpeggio. Length 8 = one bar of 16ths at base interval.
  private static readonly KEYBOARD_ECHO_DELAY_FACTORS = [1.0, 1.0, 1.0, 0.5, 1.0, 1.0, 0.5, 2.0] as const;
  // Velocity ripples down across the arpeggio, swelling back at the start.
  private static readonly KEYBOARD_ECHO_VELOCITY_OFFSETS = [0.14, 0.04, -0.02, -0.05, 0.06, -0.02, -0.06, -0.10] as const;
  private anchor = new THREE.Vector3();
  private left = new THREE.Vector3();
  private right = new THREE.Vector3();
  private center = new THREE.Vector3();
  private axis = new THREE.Vector3(1, 0, 0);
  private targetAxis = new THREE.Vector3(1, 0, 0);
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

  private cool = new THREE.Color();
  private warm = new THREE.Color();
  private gold = new THREE.Color();
  private hot = new THREE.Color();
  private noteColors: THREE.Color[] = STARLACE_NOTE_PALETTE.map(hex => new THREE.Color(hex));
  private hzTable: readonly number[] = getStarlaceHz(keyDirector.getCurrent());
  private keyUnsubscribe?: () => void;
  private onPluckCallback?: (event: StarlacePluck) => void;
  private sculptor?: import('../sculptor/EnergyEmitter').EnergySink;
  private motionElapsed = 0;
  private keyDownListener?: (e: KeyboardEvent) => void;
  private keyUpListener?: (e: KeyboardEvent) => void;
  private keyBlurListener?: () => void;
  private keyboardPitchNodes: number[][] = [];
  private keyboardPaths = new Map<string, KeyboardPathState>();
  private keyboardHeldKeys = new Set<string>();
  private camera?: THREE.Camera;
  private canvas?: HTMLCanvasElement;
  private pointerNdc = new THREE.Vector2(999, 999);
  private pointerNdcPrev = new THREE.Vector2(999, 999);
  private pointerNdcPrevValid = false;
  private pointerLastAtMs = -Infinity;
  private pointerDown = false;
  private pointerClickQueued = false;
  private pointerHeldNode = -1;
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

    this.pluckSegments = Math.max(2, Math.round(this.params.pluckSegments));
    const vertCount = this.edges.length * this.pluckSegments * 2 * 3;
    this.linePositions = new Float32Array(vertCount);
    this.lineColors = new Float32Array(vertCount);
    this.pulseLinePositions = new Float32Array(vertCount);
    this.pulseLineColors = new Float32Array(vertCount);
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

    this.buildNodeMeshes();

    this.applyColors();

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
        pluckSegments: () => this.reallocateLineBuffers(),
      },
    });
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
    if (!visible) {
      this.pointerDown = false;
      this.releasePointerHold();
      this.previousContacts.clear();
      this.activeContactKeys.clear();
      this.currentContactKeys.clear();
      this.keyboardPaths.clear();
      this.keyboardHeldKeys.clear();
      this.clearPointerState();
    }
  }

  setAnchor(anchor: THREE.Vector3): void {
    this.fixedAnchor = anchor.clone();
    this.anchor.copy(anchor);
    this.center.copy(anchor);
  }

  setSculptor(sculptor?: import('../sculptor/EnergyEmitter').EnergySink): void {
    this.sculptor = sculptor;
  }

  startHidden(): void {
    this.mesh.visible = false;
    this.pointerDown = false;
    this.releasePointerHold();
    this.keyboardPaths.clear();
    this.keyboardHeldKeys.clear();
    this.clearPointerState();
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

  applyPerformanceEvent(event: InstrumentPerformanceEvent): void {
    if (event.instrument !== 'starlace' || event.type !== 'starlace-pluck') return;
    if (!this.isInteractive()) return;
    const rootIndex = this.normalizeNodeIndex(event.nodeIndex);
    if (rootIndex < 0) return;
    const nodeIndices = this.normalizeNodeIndices(event.nodeIndices, rootIndex);
    const chord = {
      rootIndex: event.chordRootIndex,
      size: event.chordSize,
      phraseStep: event.phraseStep,
    };
    if (nodeIndices.length <= 1) {
      this.fireNode(rootIndex, clamp(event.velocity, 0, 1), event.hand, chord);
      return;
    }
    this.fireRemoteChord(rootIndex, nodeIndices, clamp(event.velocity, 0, 1), event.hand, chord);
  }

  private normalizeNodeIndex(nodeIndex: number): number {
    if (!Number.isFinite(nodeIndex)) return -1;
    const index = Math.round(nodeIndex);
    return index >= 0 && index < this.nodes.length ? index : -1;
  }

  private normalizeNodeIndices(nodeIndices: readonly number[] | undefined, fallback: number): number[] {
    const out: number[] = [];
    for (const raw of nodeIndices ?? [fallback]) {
      const index = this.normalizeNodeIndex(raw);
      if (index >= 0 && !out.includes(index)) out.push(index);
    }
    if (out.length === 0 && fallback >= 0) out.push(fallback);
    return out;
  }

  getPerformanceTargets(targets = this.performanceTargets): readonly THREE.Vector3[] {
    targets.length = 0;
    if (!this.active || !this.mesh.visible || !this.revealedFully || this.revealActive) return targets;

    let cursor = 0;
    for (let i = 0; i < this.nodes.length; i += 1) {
      if ((this.nodeRevealT[i] ?? 1) < 0.45) continue;
      const out = targets[cursor] ?? new THREE.Vector3();
      out.copy(this.nodes[i].world);
      targets[cursor] = out;
      cursor += 1;
    }
    targets.length = cursor;
    return targets;
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

    const freezeForPointerHold = this.isPointerHoldActive();
    this.elapsed += delta;
    if (!freezeForPointerHold) this.motionElapsed += delta;
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

    const palmAlpha = 1 - Math.exp(-delta * this.params.handSmoothing);
    this.left.lerp(leftPalm, palmAlpha);
    this.right.lerp(rightPalm, palmAlpha);
    if (this.fixedAnchor) {
      this.anchor.copy(this.fixedAnchor);
    } else if (!freezeForPointerHold) {
      _scratch.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
      _scratch.y += 0.05;
      const anchorAlpha = 1 - Math.exp(-delta / Math.max(0.05, this.params.anchorSmoothing));
      this.anchor.lerp(_scratch, anchorAlpha);
    }
    this.center.copy(this.anchor);

    this.smoothedEnergy += ((voice.active ? voice.energy : 0) - this.smoothedEnergy) * (1 - Math.exp(-delta * 3.8));
    this.smoothedPulse += (voice.pulse - this.smoothedPulse) * (1 - Math.exp(-delta * 8));
    this.smoothedPitch += (voice.pitch - this.smoothedPitch) * (1 - Math.exp(-delta * 4.5));
    this.smoothedExpression += (voice.expression - this.smoothedExpression) * (1 - Math.exp(-delta * 4));
    this.smoothedTension += (voice.tension - this.smoothedTension) * (1 - Math.exp(-delta * 3.6));

    if (!freezeForPointerHold) this.resolveAxes(delta);
    this.writeNodePositions();
    this.updateRevealValues();
    if (this.revealedFully && !this.revealActive) {
      this.processKeyboardPaths();
      if (contacts) this.processContacts(contacts, delta);
      else this.clearContactState();
      this.processPointer(delta);
    } else {
      this.keyboardPaths.clear();
      this.keyboardHeldKeys.clear();
      this.releasePointerHold();
      this.clearPointerState();
    }
    this.decayPulses(delta);
    this.writeLines();
    this.writeNodes();
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
    this.nodeGeometry?.dispose();
    this.nodeMaterial?.dispose();
    this.nodeGlowMaterial?.dispose();
    this.mesh.removeFromParent();
  }

  private createNodes(): void {
    // Three horizontal rows mirror the three keyboard rows so each letter
    // key plucks its dedicated node. Bottom z-m (7), home a-l (9), top q-p
    // (10) — 26 nodes total. Each row spans the harp's width; per-row z
    // bases stagger the rows into visual layers (back/middle/front) while
    // small v and z jitter keeps the cluster from looking gridlike.
    const rowCounts = Starlace.KEY_ROWS.map(r => r.length);
    const rowVs = [-0.46, 0.0, 0.46];
    const rowZBases = [0.22, -0.18, 0.10];
    let i = 0;
    for (let r = 0; r < rowCounts.length; r += 1) {
      const count = rowCounts[r];
      const baseV = rowVs[r];
      const baseZ = rowZBases[r];
      for (let c = 0; c < count; c += 1) {
        // Reverse t so the lowest-index node in each row (e.g. A on home row)
        // sits on the player/camera side and the highest-index sits window-
        // side, matching the orb arc layout in makeOrbOffsets.
        const t = count === 1 ? 0.5 : (count - 1 - c) / (count - 1);
        const u = (t - 0.5) * 0.92;
        const seed = hash(i * 8.31 + 3.30);
        const jitterV = (hash(i * 9.17 + 0.23) - 0.5) * 0.06;
        const jitterZ = (hash(i * 6.91 + 2.20) - 0.5) * 0.32;
        this.nodes.push({
          u,
          v: baseV + jitterV,
          z: baseZ + jitterZ,
          seed,
          noteIndex: 0,
          pulse: 0,
          lastHitAt: -100,
          world: new THREE.Vector3(),
        });
        i += 1;
      }
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
    this.addCrossRowEdges(seen);
    this.ensureConnected(seen);
    this.adjacency = Array.from({ length: this.nodes.length }, () => []);
    this.nodeEdges = Array.from({ length: this.nodes.length }, () => []);
    for (let e = 0; e < this.edges.length; e += 1) {
      const [a, b] = this.edges[e];
      this.adjacency[a].push(b);
      this.adjacency[b].push(a);
      this.nodeEdges[a].push(e);
      this.nodeEdges[b].push(e);
    }
    this.edgePluck = new Float32Array(this.edges.length);
    this.edgePluckPhase = new Float32Array(this.edges.length);
    for (let e = 0; e < this.edges.length; e += 1) {
      this.edgePluckPhase[e] = hash(e * 17.7 + 3.1) * TAU;
    }
  }

  private addCrossRowEdges(seen: Set<string>): void {
    // Three rows form three horizontal slices. Stitch them with a few
    // cross-row links so the lace reads as one woven cluster, not three
    // stacked strips. Stored distance is clamped into the mid-fade band so
    // these long links render visible but secondary to intra-row threads.
    const rowCounts = Starlace.KEY_ROWS.map(r => r.length);
    const rowStarts: number[] = [];
    let acc = 0;
    for (const c of rowCounts) {
      rowStarts.push(acc);
      acc += c;
    }
    const linksPerPair = 5;
    const crossRowFadeDistance = STARLACE_LINK_FADE_START
      + (STARLACE_MAX_LINK_SPAN - STARLACE_LINK_FADE_START) * 0.45;
    for (let r = 0; r < rowCounts.length - 1; r += 1) {
      const aStart = rowStarts[r];
      const aCount = rowCounts[r];
      const bStart = rowStarts[r + 1];
      const bCount = rowCounts[r + 1];
      for (let k = 0; k < linksPerPair; k += 1) {
        const t = (k + 0.5) / linksPerPair;
        const i = aStart + Math.min(aCount - 1, Math.floor(t * aCount));
        const a = this.nodes[i];
        let bestJ = -1;
        let bestD = Infinity;
        for (let j = bStart; j < bStart + bCount; j += 1) {
          const b = this.nodes[j];
          const du = a.u - b.u;
          const dv = a.v - b.v;
          const dz = (a.z - b.z) * 1.15;
          const d = Math.sqrt(du * du + dv * dv + dz * dz);
          if (d < bestD) {
            bestD = d;
            bestJ = j;
          }
        }
        if (bestJ < 0) continue;
        const lo = Math.min(i, bestJ);
        const hi = Math.max(i, bestJ);
        const key = `${lo}:${hi}`;
        if (seen.has(key)) continue;
        this.edges.push([lo, hi]);
        this.edgeDistances.push(Math.min(bestD, crossRowFadeDistance));
        seen.add(key);
      }
    }
  }

  private ensureConnected(seen: Set<string>): void {
    // Walk the existing edge graph and bridge any orphan components with
    // their shortest available cross-component edge. Guarantees every node
    // (every letter key) is reachable, so plucks ripple through one
    // continuous lace instead of dying at component boundaries.
    const n = this.nodes.length;
    const parent = new Array<number>(n);
    for (let i = 0; i < n; i += 1) parent[i] = i;
    const find = (x: number): number => {
      let root = x;
      while (parent[root] !== root) root = parent[root];
      while (parent[x] !== root) {
        const next = parent[x];
        parent[x] = root;
        x = next;
      }
      return root;
    };
    const unite = (a: number, b: number): boolean => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return false;
      parent[ra] = rb;
      return true;
    };
    for (const [a, b] of this.edges) unite(a, b);

    while (true) {
      const components = new Map<number, number[]>();
      for (let i = 0; i < n; i += 1) {
        const root = find(i);
        let bucket = components.get(root);
        if (!bucket) {
          bucket = [];
          components.set(root, bucket);
        }
        bucket.push(i);
      }
      if (components.size <= 1) return;
      const groups = Array.from(components.values());
      groups.sort((a, b) => b.length - a.length);
      const main = groups[0];
      const orphan = groups[1];
      let bestI = -1;
      let bestJ = -1;
      let bestD = Infinity;
      for (const i of main) {
        const a = this.nodes[i];
        for (const j of orphan) {
          const b = this.nodes[j];
          const du = a.u - b.u;
          const dv = a.v - b.v;
          const dz = (a.z - b.z) * 1.15;
          const d = Math.sqrt(du * du + dv * dv + dz * dz);
          if (d < bestD) {
            bestD = d;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestI < 0 || bestJ < 0) return;
      const lo = Math.min(bestI, bestJ);
      const hi = Math.max(bestI, bestJ);
      const key = `${lo}:${hi}`;
      if (!seen.has(key)) {
        this.edges.push([lo, hi]);
        this.edgeDistances.push(Math.min(bestD, STARLACE_MAX_LINK_SPAN * 0.85));
        seen.add(key);
      }
      unite(lo, hi);
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
  }

  private buildNodeMeshes(): void {
    const gemParams = new THREE.InstancedBufferAttribute(new Float32Array(this.nodes.length * 4), 4);
    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const lateral = clamp(node.u + 0.5, 0, 1);
      const vertical = clamp(node.v + 0.5, 0, 1);
      const depth = clamp(node.z + 0.5, 0, 1);
      const scatter = hash(node.seed * 37.1 + i * 0.73);
      const refraction = 0.056 + lateral * 0.024 + scatter * 0.034;
      const frost = 2.20 + vertical * 0.52 + depth * 0.30 + scatter * 0.58;
      const backdropMix = 0.54 + scatter * 0.10 + (1 - vertical) * 0.06;
      gemParams.setXYZW(i, refraction, frost, clamp(backdropMix, 0.50, 0.70), 0.12);
    }
    gemParams.setUsage(THREE.DynamicDrawUsage);
    this.nodeGemParams = gemParams;

    const gemParamsNode = instancedBufferAttribute<'vec4'>(gemParams, 'vec4');
    const hitGlow = gemParamsNode.w;
    const refractStrength = gemParamsNode.x.add(hitGlow.mul(float(0.018)));
    const refractedUv = screenUV.add(normalView.xy.mul(refractStrength));
    const frostedBackdrop = viewportMipTexture(refractedUv, gemParamsNode.y.add(hitGlow.mul(float(0.36))));
    const faceCore = normalView.z.mul(normalView.z).pow(float(1.15));
    const innerGlow = faceCore.mul(float(0.28)).add(hitGlow.mul(float(0.72))).add(faceCore.mul(hitGlow).mul(float(0.92)));
    const material = new THREE.MeshBasicNodeMaterial({
      color: 0xf0f7ff,
      transparent: true,
      opacity: 0.84,
      blending: THREE.NormalBlending,
      depthWrite: false,
      vertexColors: true,
      side: THREE.FrontSide,
    });
    material.colorNode = vec3(float(0.90).add(innerGlow));
    material.backdropNode = frostedBackdrop;
    material.backdropAlphaNode = gemParamsNode.z.sub(hitGlow.mul(float(0.08)));
    material.forceSinglePass = true;

    this.nodeGeometry = new THREE.IcosahedronGeometry(1, 0);
    this.nodeGeometry.computeVertexNormals();
    this.nodeMesh = new THREE.InstancedMesh(this.nodeGeometry, material, this.nodes.length);
    this.nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.nodes.length * 3), 3);
    this.nodeMesh.frustumCulled = false;
    this.nodeMesh.renderOrder = 20;
    this.nodeMaterial = material;

    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.48,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
    });
    glowMaterial.toneMapped = false;
    this.nodeGlowMesh = new THREE.InstancedMesh(this.nodeGeometry, glowMaterial, this.nodes.length);
    this.nodeGlowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.nodeGlowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.nodes.length * 3), 3);
    this.nodeGlowMesh.frustumCulled = false;
    this.nodeGlowMesh.renderOrder = 19;
    this.nodeGlowMaterial = glowMaterial;

    this.mesh.add(this.nodeGlowMesh, this.nodeMesh);
  }

  private resolveAxes(delta: number): void {
    if (this.fixedAnchor) {
      this.targetAxis.set(1, 0, 0);
    } else {
      this.targetAxis.subVectors(this.right, this.left);
      if (this.targetAxis.lengthSq() < 0.0001) {
        this.targetAxis.set(1, 0, 0);
      } else {
        this.targetAxis.normalize();
      }
    }

    const turnAlpha = 1 - Math.exp(-delta * this.params.axisSmoothing);
    rotateVectorTowards(this.axis, this.targetAxis, turnAlpha, this.params.maxTurnRate * delta);

    this.fieldSide.crossVectors(this.axis, _worldUp);
    if (this.fieldSide.lengthSq() < 0.0001) this.fieldSide.set(0, 0, 1);
    this.fieldSide.normalize();
    this.fieldUp.crossVectors(this.fieldSide, this.axis).normalize();
  }

  private writeNodePositions(): void {
    const handSpan = this.left.distanceTo(this.right);
    const width = this.fixedAnchor
      ? this.params.width
      : this.params.width * (0.88 + this.smoothedTension * 0.24) + clamp(handSpan - 0.42, -0.18, 0.36) * 0.26;
    const height = this.fixedAnchor
      ? this.params.height
      : this.params.height * (0.90 + this.smoothedEnergy * 0.14);
    const depth = this.fixedAnchor
      ? this.params.depth
      : this.params.depth * (0.72 + this.smoothedExpression * 0.38);

    for (let i = 0; i < this.nodes.length; i += 1) {
      const n = this.nodes[i];
      n.world.copy(this.center)
        .addScaledVector(this.axis, n.u * width)
        .addScaledVector(this.fieldUp, n.v * height)
        .addScaledVector(this.fieldSide, n.z * depth);
    }
  }

  private writeLines(): void {
    let maxPulse = 0;
    let cursor = 0;
    let colorCursor = 0;
    const segments = this.pluckSegments;
    const invSeg = 1 / segments;
    const amp = this.params.pluckAmplitude;
    const freq = this.params.pluckFrequency;
    const wavePhaseBase = this.elapsed * freq * TAU;
    for (let e = 0; e < this.edges.length; e += 1) {
      const [aIdx, bIdx] = this.edges[e];
      const a = this.nodes[aIdx];
      const b = this.nodes[bIdx];
      // Edge "draws" from the already-revealed endpoint toward the
      // newly-arriving one. With both endpoints fully revealed, t=1 and the
      // line spans the full edge as before.
      const t = this.edgeRevealT[e] ?? 1;
      const eased = smoothstep01(t);
      const endX = a.world.x + (b.world.x - a.world.x) * eased;
      const endY = a.world.y + (b.world.y - a.world.y) * eased;
      const endZ = a.world.z + (b.world.z - a.world.z) * eased;
      const distance = this.edgeDistances[e] ?? STARLACE_MAX_LINK_SPAN;
      const distanceFade = 1 - smoothstep01(
        (distance - STARLACE_LINK_FADE_START) / Math.max(0.001, STARLACE_MAX_LINK_SPAN - STARLACE_LINK_FADE_START),
      );
      const edgePulse = Math.max(a.pulse, b.pulse);
      const lineGlow = eased * clamp(0.18 + distanceFade * 0.86 + edgePulse * 0.24 + this.smoothedEnergy * 0.14, 0, 1.12);
      const pulseGlow = eased * clamp(edgePulse * 0.92 + this.smoothedPulse * 0.18, 0, 1.08);

      // Plucked-string vibration: middle vertices offset perpendicular to
      // edge axis, pinned at both endpoints (sin(πs) shape). Two perp axes
      // give an elliptical wobble so the string doesn't read as flat.
      const pluck = this.edgePluck[e];
      this._edgeDir.set(endX - a.world.x, endY - a.world.y, endZ - a.world.z);
      const edgeLen = this._edgeDir.length();
      if (edgeLen > 1e-5) this._edgeDir.multiplyScalar(1 / edgeLen);
      this._perp1.crossVectors(this._edgeDir, this.fieldUp);
      if (this._perp1.lengthSq() < 1e-6) this._perp1.crossVectors(this._edgeDir, this.fieldSide);
      if (this._perp1.lengthSq() < 1e-6) this._perp1.set(0, 1, 0);
      this._perp1.normalize();
      this._perp2.crossVectors(this._edgeDir, this._perp1).normalize();
      const phase = wavePhaseBase + this.edgePluckPhase[e];
      const wave1 = Math.sin(phase);
      const wave2 = Math.sin(phase + Math.PI * 0.5) * 0.55;
      const ampScaled = amp * pluck * eased;

      this.noteColorForNode(a, _colorB);
      this.noteColorForNode(b, _colorC);
      _colorA.copy(_colorB)
        .lerp(_colorC, 0.5)
        .lerp(this.gold, 0.25 + distanceFade * 0.20)
        .lerp(this.cool, 0.08 + hash(e * 13.7 + distance * 5.1) * 0.18)
        .multiplyScalar(lineGlow * 0.86);
      _colorB.lerp(this.hot, 0.10 + edgePulse * 0.08).multiplyScalar(pulseGlow * 0.92);
      _colorC.lerp(this.hot, 0.10 + edgePulse * 0.08).multiplyScalar(pulseGlow * 0.92);

      const ax = a.world.x;
      const ay = a.world.y;
      const az = a.world.z;
      const dx = endX - ax;
      const dy = endY - ay;
      const dz = endZ - az;
      const p1x = this._perp1.x;
      const p1y = this._perp1.y;
      const p1z = this._perp1.z;
      const p2x = this._perp2.x;
      const p2y = this._perp2.y;
      const p2z = this._perp2.z;

      const sampleAt = (s: number, out: { x: number; y: number; z: number }) => {
        const baseX = ax + dx * s;
        const baseY = ay + dy * s;
        const baseZ = az + dz * s;
        // sin(πs) pins both ends; ampScaled = 0 when no pluck → straight line.
        const shape = Math.sin(Math.PI * s);
        const offset = shape * ampScaled;
        const off1 = offset * wave1;
        const off2 = offset * wave2;
        out.x = baseX + p1x * off1 + p2x * off2;
        out.y = baseY + p1y * off1 + p2y * off2;
        out.z = baseZ + p1z * off1 + p2z * off2;
      };

      const pNow = { x: 0, y: 0, z: 0 };
      const pNext = { x: 0, y: 0, z: 0 };
      sampleAt(0, pNow);
      for (let k = 0; k < segments; k += 1) {
        const s1 = (k + 1) * invSeg;
        sampleAt(s1, pNext);
        // segment k start vertex
        this.linePositions[cursor] = pNow.x;
        this.pulseLinePositions[cursor++] = pNow.x;
        this.linePositions[cursor] = pNow.y;
        this.pulseLinePositions[cursor++] = pNow.y;
        this.linePositions[cursor] = pNow.z;
        this.pulseLinePositions[cursor++] = pNow.z;
        // segment k end vertex
        this.linePositions[cursor] = pNext.x;
        this.pulseLinePositions[cursor++] = pNext.x;
        this.linePositions[cursor] = pNext.y;
        this.pulseLinePositions[cursor++] = pNext.y;
        this.linePositions[cursor] = pNext.z;
        this.pulseLinePositions[cursor++] = pNext.z;

        // Color along edge: lerp endpoint colors by midpoint s.
        const sMid = (k + 0.5) * invSeg;
        const baseR = _colorA.r;
        const baseG = _colorA.g;
        const baseB_ = _colorA.b;
        const pulseR = _colorB.r * (1 - sMid) + _colorC.r * sMid;
        const pulseG = _colorB.g * (1 - sMid) + _colorC.g * sMid;
        const pulseB = _colorB.b * (1 - sMid) + _colorC.b * sMid;
        for (let v = 0; v < 2; v += 1) {
          this.lineColors[colorCursor] = baseR;
          this.pulseLineColors[colorCursor++] = pulseR;
          this.lineColors[colorCursor] = baseG;
          this.pulseLineColors[colorCursor++] = pulseG;
          this.lineColors[colorCursor] = baseB_;
          this.pulseLineColors[colorCursor++] = pulseB;
        }

        pNow.x = pNext.x;
        pNow.y = pNext.y;
        pNow.z = pNext.z;
      }
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
    const mesh = this.nodeMesh;
    const glowMesh = this.nodeGlowMesh;
    const material = this.nodeMaterial;
    const gemParams = this.nodeGemParams;
    const gemParamArray = gemParams?.array as Float32Array | undefined;
    if (!mesh || !material) return;

    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const twinkle = 0.5 + Math.sin(this.motionElapsed * (1.2 + node.seed * 1.7) + node.seed * TAU) * 0.5;
      const pitchGlow = 1 - Math.abs((node.noteIndex / (this.hzTable.length - 1)) - this.smoothedPitch);
      const pulse = clamp(node.pulse + pitchGlow * this.smoothedEnergy * 0.18 + twinkle * 0.07, 0, 1);
      const reveal = smoothstep01(this.nodeRevealT[i] ?? 1);
      // Triggered nodes mostly brighten; the mesh scale only nudges up so hits
      // read as a flash instead of a popping size change.
      const flash = Math.pow(node.pulse, 1.10);
      const size = this.params.nodeRadius * (0.82 + twinkle * 0.18 + pulse * 0.25 + flash * 0.08) * reveal;
      const drawSize = Math.max(size, 0.0001);
      const materialGlow = reveal * clamp(0.10 + twinkle * 0.04 + pulse * 0.16 + flash * 1.35, 0, 1.70);

      _dummy.position.copy(node.world);
      _dummy.rotation.set(
        this.motionElapsed * (0.18 + node.seed * 0.18) + node.seed * TAU,
        this.motionElapsed * (0.14 + node.seed * 0.16) + node.u * 2.1,
        this.motionElapsed * (0.10 + node.seed * 0.12) + node.v * 2.4,
      );
      _dummy.scale.setScalar(drawSize);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);

      this.nodeGemColor(node, pulse, twinkle, _colorA);
      mesh.setColorAt(i, _colorA);
      if (gemParamArray) gemParamArray[i * 4 + 3] = materialGlow;

      if (glowMesh) {
        const glow = reveal * smoothstep01(node.pulse);
        const glowSize = this.params.nodeRadius * (1.18 + flash * 0.26) * reveal;
        _dummy.scale.setScalar(glow > 0.004 ? glowSize : 0.0001);
        _dummy.updateMatrix();
        glowMesh.setMatrixAt(i, _dummy.matrix);
        _colorB.copy(this.hot).lerp(STARLACE_FROST_WHITE, 0.22 + flash * 0.18).multiplyScalar(glow * (0.76 + flash * 0.64));
        glowMesh.setColorAt(i, _colorB);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (glowMesh) {
      glowMesh.instanceMatrix.needsUpdate = true;
      if (glowMesh.instanceColor) glowMesh.instanceColor.needsUpdate = true;
    }
    if (gemParams) gemParams.needsUpdate = true;
    material.opacity = clamp(0.80 + this.maxPulse * 0.06 + this.smoothedPulse * 0.04, 0.80, 0.90);
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
      this.releasePointerHold();
    };
    this.pointerCancelListener = () => {
      this.pointerDown = false;
      this.releasePointerHold();
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
    this.pointerDown = false;
    this.releasePointerHold();
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
    this.releasePointerHold();
    this.pointerClickQueued = false;
    this.pointerNdcPrevValid = false;
    this.pointerLastAtMs = -Infinity;
    this.pointerNodeInside.fill(false);
  }

  private processPointer(delta: number): void {
    const camera = this.camera;
    if (!camera || !this.canvas) {
      this.releasePointerHold();
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
    this.updatePointerHold(activeNode, velocity);
    const pointerHoldActive = this.isPointerHoldActive();
    const activelyStriking = !pointerHoldActive && (clickQueued || ndcSpeed > POINTER_PLUCK_MOTION_NDC_PER_SEC);

    if (activelyStriking) {
      for (let i = 0; i < this.nodes.length; i += 1) {
        if (!this.pointerSweepSeen[i] || this.pointerNodeInside[i]) continue;
        this.pointerFrameFired[i] = this.firePointerNode(i, velocity);
      }
    }

    if (!pointerHoldActive && clickQueued && activeNode >= 0 && !this.pointerFrameFired[activeNode]) {
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

  private updatePointerHold(nodeIndex: number, velocity: number): void {
    if (!this.pointerDown) {
      this.releasePointerHold();
      return;
    }
    if (nodeIndex < 0 || nodeIndex === this.pointerHeldNode) return;
    const node = this.nodes[nodeIndex];
    if (!node) return;
    this.releasePointerHold();
    const keyIndex = clamp(node.noteIndex, 0, Starlace.KEY_MAP.length - 1);
    if (this.startKeyboardPath(POINTER_HOLD_KEY, keyIndex, velocity, nodeIndex)) {
      this.pointerHeldNode = nodeIndex;
    }
  }

  private releasePointerHold(): void {
    this.keyboardPaths.delete(POINTER_HOLD_KEY);
    this.keyboardHeldKeys.delete(POINTER_HOLD_KEY);
    this.pointerHeldNode = -1;
  }

  private isPointerHoldActive(): boolean {
    return this.pointerHeldNode >= 0 && this.pointerDown && this.keyboardHeldKeys.has(POINTER_HOLD_KEY);
  }

  private processContacts(contacts: readonly HandContactPoint[], delta: number): void {
    const safeDelta = Math.max(delta, 1e-4);
    this.currentContactKeys.clear();
    const activeContactIds = new Set<string>();
    let hitsThisFrame = 0;

    for (const contact of contacts) {
      activeContactIds.add(contact.id);
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
        this.fireNode(i, velocity, contact.hand);
        hitsThisFrame += 1;
        if (hitsThisFrame >= MAX_HITS_PER_FRAME) break;
      }

      previous.copy(contact.position);
      if (hitsThisFrame >= MAX_HITS_PER_FRAME) break;
    }

    for (const id of this.previousContacts.keys()) {
      if (!activeContactIds.has(id)) this.previousContacts.delete(id);
    }

    this.activeContactKeys.clear();
    for (const key of this.currentContactKeys) this.activeContactKeys.add(key);
  }

  private clearContactState(): void {
    this.previousContacts.clear();
    this.activeContactKeys.clear();
    this.currentContactKeys.clear();
  }

  private fireNode(
    nodeIndex: number,
    velocity: number,
    hand?: HandContactPoint['hand'],
    chord?: { rootIndex?: number; size?: 1 | 2 | 3; phraseStep?: number },
  ): void {
    const node = this.nodes[nodeIndex];
    this.pulseNode(nodeIndex, velocity);

    if (this.onPluckCallback) {
      const rootIndex = clamp(chord?.rootIndex ?? node.noteIndex, 0, this.hzTable.length - 1);
      this.onPluckCallback({
        nodeIndex,
        noteIndex: rootIndex,
        frequency: this.hzTable[rootIndex] ?? this.hzTable[node.noteIndex],
        velocity,
        hand,
        worldPosition: node.world.clone(),
        x: clamp(node.u + 0.5, 0, 1),
        y: clamp(node.v + 0.5, 0, 1),
        chordRootIndex: rootIndex,
        chordSize: chord?.size,
        phraseStep: chord?.phraseStep,
        nodeIndices: [nodeIndex],
      });
    }
    this.emitStreak(node, velocity);
  }

  private pulseNode(nodeIndex: number, velocity: number): void {
    const node = this.nodes[nodeIndex];
    if (!node) return;
    node.lastHitAt = this.elapsed;
    node.pulse = Math.min(1, node.pulse + 0.78 + velocity * 0.52);
    this.pluckEdgesAt(nodeIndex, velocity, 1);
  }

  private pluckEdgesAt(nodeIndex: number, velocity: number, depth: number): void {
    const incident = this.nodeEdges[nodeIndex];
    if (!incident) return;
    const impulse = this.params.pluckImpulse * (0.45 + velocity * 0.75);
    const travel = clamp(this.params.pluckTravel, 0, 1);
    for (const e of incident) {
      const prev = this.edgePluck[e];
      const next = Math.min(1.4, Math.max(prev, impulse));
      this.edgePluck[e] = next;
      this.edgePluckPhase[e] = (this.elapsed * this.params.pluckFrequency * TAU) % TAU;
    }
    if (depth > 0 && travel > 0.01) {
      for (const nb of this.adjacency[nodeIndex] ?? []) {
        for (const e of this.nodeEdges[nb] ?? []) {
          const prev = this.edgePluck[e];
          const trail = impulse * travel * 0.55;
          if (trail > prev) this.edgePluck[e] = trail;
        }
      }
    }
  }

  private fireKeyboardChord(
    state: KeyboardPathState,
    nodeIndices: readonly number[],
    chordSize: 1 | 2 | 3,
    rootIndex: number,
  ): void {
    if (nodeIndices.length === 0) return;
    const rootNodeIndex = nodeIndices[0];
    const rootNode = this.nodes[rootNodeIndex];
    if (!rootNode) return;
    const velocity = this.keyboardPathVelocity(state);

    for (let i = 0; i < nodeIndices.length; i += 1) {
      const nodeIndex = nodeIndices[i];
      const node = this.nodes[nodeIndex];
      if (!node) continue;
      this.pulseNode(nodeIndex, velocity * (i === 0 ? 1 : 0.86));
      this.emitStreak(node, velocity * (i === 0 ? 0.92 : 0.72));
    }

    if (this.onPluckCallback) {
      this.onPluckCallback({
        nodeIndex: rootNodeIndex,
        noteIndex: rootIndex,
        frequency: this.hzTable[rootIndex] ?? this.hzTable[rootNode.noteIndex],
        velocity,
        worldPosition: rootNode.world.clone(),
        x: clamp(rootNode.u + 0.5, 0, 1),
        y: clamp(rootNode.v + 0.5, 0, 1),
        chordRootIndex: rootIndex,
        chordSize,
        phraseStep: state.step,
        nodeIndices: [...nodeIndices],
      });
    }
  }

  private fireRemoteChord(
    rootNodeIndex: number,
    nodeIndices: readonly number[],
    velocity: number,
    hand: HandContactPoint['hand'] | undefined,
    chord: { rootIndex?: number; size?: 1 | 2 | 3; phraseStep?: number },
  ): void {
    const rootNode = this.nodes[rootNodeIndex];
    if (!rootNode) return;

    for (let i = 0; i < nodeIndices.length; i += 1) {
      const nodeIndex = nodeIndices[i];
      const node = this.nodes[nodeIndex];
      if (!node) continue;
      this.pulseNode(nodeIndex, velocity * (i === 0 ? 1 : 0.86));
      this.emitStreak(node, velocity * (i === 0 ? 0.92 : 0.72));
    }

    if (this.onPluckCallback) {
      const rootIndex = clamp(chord.rootIndex ?? rootNode.noteIndex, 0, this.hzTable.length - 1);
      this.onPluckCallback({
        nodeIndex: rootNodeIndex,
        noteIndex: rootIndex,
        frequency: this.hzTable[rootIndex] ?? this.hzTable[rootNode.noteIndex],
        velocity,
        hand,
        worldPosition: rootNode.world.clone(),
        x: clamp(rootNode.u + 0.5, 0, 1),
        y: clamp(rootNode.v + 0.5, 0, 1),
        chordRootIndex: rootIndex,
        chordSize: chord.size,
        phraseStep: chord.phraseStep,
        nodeIndices: [...nodeIndices],
      });
    }
  }

  // Three keyboard rows map directly to dedicated nodes. Indices 0..6 =
  // bottom row (z-m), 7..15 = home row (a-l), 16..25 = top row (q-p).
  // c/n/m are shadowed by debug shortcuts when the overlay is open (see
  // attachKeyboardEvents), free to play as instrument keys otherwise.
  private static readonly KEY_ROWS: ReadonlyArray<ReadonlyArray<string>> = [
    ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ];
  private static readonly KEY_MAP: ReadonlyArray<string> = Starlace.KEY_ROWS.flat();
  private static readonly DEBUG_SHADOWED_KEYS = new Set(['c', 'n', 'm']);
  private static readonly KEYBOARD_RECENT_LIMIT = 8;

  private attachKeyboardEvents(): void {
    this.keyDownListener = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.isKeyboardTextTarget(e.target)) return;
      if (!this.isInteractive()) return;
      const key = e.key.toLowerCase();
      const idx = Starlace.KEY_MAP.indexOf(key);
      if (idx < 0 || e.repeat || this.keyboardHeldKeys.has(key)) return;
      // c/n/m do double duty as debug-overlay shortcuts; when the overlay is
      // open let those keys belong to debug, otherwise they're instrument keys.
      if (isDebugVisible() && Starlace.DEBUG_SHADOWED_KEYS.has(key)) return;
      e.preventDefault();
      this.startKeyboardPath(key, idx, 0.74, idx);
    };
    this.keyUpListener = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      this.keyboardPaths.delete(key);
      this.keyboardHeldKeys.delete(key);
    };
    this.keyBlurListener = () => {
      this.keyboardPaths.clear();
      this.keyboardHeldKeys.clear();
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
    this.keyboardHeldKeys.clear();
  }

  private isKeyboardTextTarget(target: EventTarget | null): boolean {
    const element = target instanceof HTMLElement ? target : null;
    if (!element) return false;
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
  }

  triggerMidiNoteOn(noteNumber: number, velocity: number, sourceId?: string): void {
    if (!this.isInteractive()) return;
    if (!Number.isFinite(noteNumber)) return;
    const keyIndex = positiveModulo(Math.round(noteNumber) - 36, Starlace.KEY_MAP.length);
    const key = this.midiSourceId(noteNumber, sourceId);
    if (this.keyboardHeldKeys.has(key)) return;
    this.startKeyboardPath(key, keyIndex, clamp(velocity, 0, 1));
  }

  triggerMidiNoteOff(noteNumber: number, sourceId?: string): void {
    const key = this.midiSourceId(noteNumber, sourceId);
    this.keyboardPaths.delete(key);
    this.keyboardHeldKeys.delete(key);
  }

  releaseAllMidiNotes(): void {
    for (const key of [...this.keyboardPaths.keys()]) {
      if (key.startsWith('midi:')) this.keyboardPaths.delete(key);
    }
    for (const key of [...this.keyboardHeldKeys.keys()]) {
      if (key.startsWith('midi:')) this.keyboardHeldKeys.delete(key);
    }
  }

  private midiSourceId(noteNumber: number, sourceId?: string): string {
    return `midi:${sourceId ?? Math.round(noteNumber)}`;
  }

  private startKeyboardPath(key: string, keyIndex: number, velocity = 0.74, startNodeIndex?: number): boolean {
    const explicitStartNode = startNodeIndex !== undefined ? this.nodes[startNodeIndex] : undefined;
    const homeNoteIndex = explicitStartNode
      ? clamp(explicitStartNode.noteIndex, 0, this.hzTable.length - 1)
      : this.keyboardHomeNoteIndex(keyIndex);
    const startNode = explicitStartNode ? startNodeIndex! : this.pickKeyboardStartNode(homeNoteIndex);
    if (startNode < 0) return false;

    const bfsDistance = this.computeBfsDistances(startNode);
    let observedMax = 0;
    for (const d of bfsDistance) if (d > observedMax && d !== Infinity) observedMax = d;
    const maxRing = clamp(Math.min(observedMax, 4), 1, 5);
    // Triangle ripple: out then back. cycleLength = 2*maxRing keeps the wave
    // periodic so a held key feels like waves rolling in, not a random walk.
    const cycleLength = Math.max(4, maxRing * 2);
    const phraseSeed = hash(keyIndex * 17.31 + homeNoteIndex * 3.19 + this.elapsed * 0.71);

    const state: KeyboardPathState = {
      keyIndex,
      homeNoteIndex,
      currentNode: startNode,
      previousNode: -1,
      startNode,
      bfsDistance,
      maxRing,
      cycleLength,
      nextAt: this.elapsed,
      step: 0,
      totalStages: this.keyboardPhraseJumps() + 1,
      phraseSeed,
      recentNodes: [],
      velocity: clamp(velocity, 0.2, 1),
      motifSteps: [],
      motifRepeatsLeft: this.keyboardMotifRepeatCount(phraseSeed),
      motifReplay: false,
      lastCycleIndex: 0,
    };
    this.keyboardHeldKeys.add(key);
    this.fireKeyboardStage(state);
    state.step = 1;
    state.nextAt = this.elapsed + this.keyboardStepDelay(state);
    this.keyboardPaths.set(key, state);
    return true;
  }

  private processKeyboardPaths(): void {
    if (this.keyboardPaths.size === 0) return;

    let fired = 0;
    for (const [key, state] of this.keyboardPaths) {
      if (this.elapsed < state.nextAt) continue;
      if (!this.keyboardHeldKeys.has(key)) {
        this.keyboardPaths.delete(key);
        continue;
      }

      this.refreshKeyboardPhrase(state);
      const firedCount = this.fireKeyboardStage(state);
      if (firedCount > 0) {
        state.step += 1;
        fired += firedCount;
      } else {
        this.keyboardPaths.delete(key);
        continue;
      }

      const delay = this.keyboardStepDelay(state);
      state.nextAt = Math.max(state.nextAt + delay, this.elapsed + delay * 0.65);
      if (fired >= MAX_HITS_PER_FRAME) return;
    }
  }

  private fireKeyboardStage(state: KeyboardPathState): number {
    const phraseLength = Math.max(1, state.totalStages);
    const stageInPhrase = positiveModulo(state.step, phraseLength);
    const ringTarget = this.ringTargetForStep(state, state.step);
    const motifStep = positiveModulo(state.step, Math.max(2, state.cycleLength));
    const replayStep = state.motifReplay ? state.motifSteps[motifStep] : undefined;
    let rootIndex = replayStep?.rootIndex ?? this.keyboardStageRootIndex(state, stageInPhrase, ringTarget);
    let chordSize = replayStep?.chordSize ?? this.keyboardChordSizeForRing(ringTarget, state.maxRing);
    let nodes = replayStep?.nodeIndices.filter(index => this.nodes[index]) ?? [];

    // The held key/node is the bass anchor. Outer rings can wander, but every
    // returned ripple begins the next arpeggio on this same root note.
    if (ringTarget === 0) {
      rootIndex = state.homeNoteIndex;
      chordSize = 1;
      nodes = [state.startNode];
    }

    if (nodes.length === 0) {
      nodes = this.pickKeyboardChordNodes(state, chordSize, rootIndex, ringTarget);
      if (!state.motifReplay && nodes.length > 0) {
        state.motifSteps[motifStep] = {
          rootIndex,
          chordSize,
          nodeIndices: [...nodes],
        };
      }
    }
    if (nodes.length === 0) return 0;
    state.previousNode = state.currentNode;
    state.currentNode = nodes[0];
    for (const nodeIndex of nodes) this.rememberKeyboardNode(state, nodeIndex);
    this.fireKeyboardChord(state, nodes, chordSize, rootIndex);
    return nodes.length;
  }

  private keyboardChordSizeForRing(ringTarget: number, maxRing: number): 1 | 2 | 3 {
    const maxNotes = this.keyboardChordMaxNotes();
    if (maxNotes <= 1) return 1;
    if (ringTarget === 0) return 1;
    if (ringTarget === 1 && maxRing >= 2) return clamp(Math.min(2, maxNotes), 1, 3) as 1 | 2 | 3;
    return 1;
  }

  private refreshKeyboardPhrase(state: KeyboardPathState): void {
    const phraseLength = this.keyboardPhraseJumps() + 1;
    state.totalStages = phraseLength;
    const cycleLength = Math.max(2, state.cycleLength);
    const cycleIndex = Math.floor(Math.max(0, state.step) / cycleLength);
    if (state.step <= 0 || positiveModulo(state.step, cycleLength) !== 0 || cycleIndex === state.lastCycleIndex) return;

    state.lastCycleIndex = cycleIndex;
    if (state.motifRepeatsLeft > 0 && state.motifSteps.length > 0) {
      state.motifRepeatsLeft -= 1;
      state.motifReplay = true;
      return;
    }

    state.motifReplay = false;
    state.motifSteps = [];
    state.phraseSeed = hash(
      state.phraseSeed * 17.19 +
      state.step * 0.37 +
      state.currentNode * 3.11 +
      this.elapsed * 0.07,
    );
    state.motifRepeatsLeft = this.keyboardMotifRepeatCount(state.phraseSeed);
    if (state.recentNodes.length > 3) {
      state.recentNodes.splice(0, state.recentNodes.length - 3);
    }
  }

  private keyboardHomeNoteIndex(keyIndex: number): number {
    return clamp(keyIndex, 0, this.hzTable.length - 1);
  }

  private pickKeyboardStartNode(homeNoteIndex: number): number {
    const exact = this.keyboardPitchNodes[homeNoteIndex] ?? [];
    let best = -1;
    let bestScore = Infinity;
    const candidates = exact.length > 0 ? exact : this.nodes.map((_, i) => i);
    for (const i of candidates) {
      const node = this.nodes[i];
      const score =
        Math.abs(node.noteIndex - homeNoteIndex) * 10 +
        node.u * node.u * 1.15 +
        node.v * node.v * 0.90 +
        node.z * node.z * 0.55 +
        i * 0.0001;
      if (score >= bestScore) continue;
      best = i;
      bestScore = score;
    }
    return best;
  }

  private pickKeyboardChordNodes(
    state: KeyboardPathState,
    chordSize: 1 | 2 | 3,
    rootIndex: number,
    ringTarget: number,
  ): number[] {
    const noteIndexes = this.keyboardChordNoteIndexes(rootIndex, chordSize);
    const picked: number[] = [];
    let anchor = state.currentNode;

    for (const noteIndex of noteIndexes) {
      const nodeIndex = picked.length === 0 && (state.step === 0 || ringTarget === 0)
        ? state.startNode
        : this.pickKeyboardChordNode(noteIndex, state, picked, anchor);
      if (nodeIndex < 0) continue;
      picked.push(nodeIndex);
      anchor = nodeIndex;
    }

    return picked;
  }

  private keyboardStageRootIndex(state: KeyboardPathState, stageInPhrase: number, ringTarget: number): number {
    if (ringTarget === 0) return state.homeNoteIndex;
    const phraseLength = Math.max(1, state.totalStages);
    const wander = clamp(this.params.keyPathWander, 0, 1);
    const phraseOffsets = [0, 2, 4, 2, 5, 4, 3, 1, 0, -1, 2, 4, 5] as const;
    const shapeOffset = phraseOffsets[stageInPhrase % phraseOffsets.length] ?? 0;
    const drift = Math.round((hash(state.phraseSeed * 31.7 + state.step * 5.93) - 0.5) * 4 * wander);
    const currentNode = this.nodes[state.currentNode];
    const nodePull = currentNode
      ? Math.round((currentNode.noteIndex - state.homeNoteIndex) * 0.35 * wander)
      : 0;
    const returnHome = stageInPhrase > phraseLength * 0.72 ? Math.round(-2 * wander) : 0;
    return clamp(state.homeNoteIndex + shapeOffset + drift + nodePull + returnHome, 0, this.hzTable.length - 1);
  }

  private pickKeyboardChordNode(
    noteIndex: number,
    state: KeyboardPathState,
    picked: readonly number[],
    anchorIndex: number,
  ): number {
    const exact = this.keyboardPitchNodes[noteIndex] ?? [];
    const candidates = exact.length > 0
      ? exact
      : this.nodes.map((_, i) => i).filter(i => Math.abs(this.nodes[i].noteIndex - noteIndex) <= 1);
    const fallback = candidates.length > 0 ? candidates : this.nodes.map((_, i) => i);
    const anchor = this.nodes[anchorIndex] ?? this.nodes[state.currentNode];
    const direct = new Set(this.adjacency[anchorIndex] ?? []);
    const secondHop = new Set<number>();
    for (const nb of direct) {
      for (const hop of this.adjacency[nb] ?? []) {
        if (hop !== anchorIndex && !direct.has(hop)) secondHop.add(hop);
      }
    }
    const wander = clamp(this.params.keyPathWander, 0, 1);
    const edgeFollow = clamp(this.params.keyEdgeFollow, 0, 1);
    const ringTarget = this.ringTargetForStep(state, state.step);
    const ringWeight = 1.6 + edgeFollow * 1.2;

    let best = -1;
    let bestScore = Infinity;
    for (const index of fallback) {
      const node = this.nodes[index];
      if (!node) continue;
      const pickedPenalty = picked.includes(index) ? 20 : 0;
      const recentIndex = state.recentNodes.lastIndexOf(index);
      const recentPenalty = recentIndex < 0
        ? 0
        : (0.80 + (recentIndex / Math.max(1, state.recentNodes.length - 1)) * 0.70) * (1 - wander * 0.24);
      const graphScore = direct.has(index)
        ? -0.16 - edgeFollow * 0.78
        : secondHop.has(index)
          ? -0.06 - edgeFollow * 0.34
          : edgeFollow * 0.22;
      // Ripple ring penalty: prefer nodes at this step's BFS distance from the
      // origin so the wave propagates outward, not a random walk.
      const distFromOrigin = state.bfsDistance[index];
      const ringDelta = Number.isFinite(distFromOrigin)
        ? Math.abs(distFromOrigin - ringTarget)
        : ringTarget + 3;
      const ringPenalty = ringDelta * ringWeight;
      const returnPenalty = index === state.previousNode ? 0.50 + edgeFollow * 0.20 : 0;
      const pitchPenalty = Math.abs(node.noteIndex - noteIndex) * 1.7;
      const distancePenalty = anchor ? anchor.world.distanceTo(node.world) * (1.35 - wander * 0.70) : 0;
      const phase = state.step * 9.17 + picked.length * 4.33 + state.phraseSeed * 27.9;
      const score =
        pickedPenalty +
        pitchPenalty +
        distancePenalty +
        recentPenalty +
        returnPenalty +
        graphScore +
        ringPenalty +
        node.pulse * 0.22 +
        hash(index * 41.11 + phase) * (0.10 + wander * 0.46);

      if (score >= bestScore) continue;
      best = index;
      bestScore = score;
    }
    return best;
  }

  private keyboardChordNoteIndexes(rootIndex: number, chordSize: 1 | 2 | 3): number[] {
    const root = clamp(rootIndex, 0, this.hzTable.length - 1);
    const offsets = chordSize === 1 ? [0] : chordSize === 2 ? [0, 2] : [0, 2, 4];
    const picked: number[] = [];
    for (const offset of offsets) {
      let next = root + offset;
      if (next >= this.hzTable.length) next = root - offset;
      next = clamp(next, 0, this.hzTable.length - 1);
      if (!picked.includes(next)) picked.push(next);
    }
    return picked;
  }

  private keyboardChordSizeForStage(stage: number, totalStages: number): 1 | 2 | 3 {
    const maxNotes = this.keyboardChordMaxNotes();
    if (totalStages <= 1 || maxNotes <= 1) return 1;
    const distanceFromEdge = Math.min(stage, Math.max(0, totalStages - 1 - stage));
    return clamp(1 + Math.floor(distanceFromEdge), 1, maxNotes) as 1 | 2 | 3;
  }

  private keyboardPhraseJumps(): number {
    return Math.round(clamp(this.params.keyPhraseJumps, 2, 24));
  }

  private keyboardMotifRepeatCount(seed: number): number {
    const roll = hash(seed * 23.17 + 0.41);
    if (roll > 0.82) return 2;
    if (roll > 0.48) return 1;
    return 0;
  }

  // BFS distance from a start node along the lattice adjacency.
  // Unreachable nodes report Infinity. Used to drive ripple-style hold play.
  private computeBfsDistances(startNode: number): number[] {
    const dist = new Array<number>(this.nodes.length).fill(Infinity);
    if (startNode < 0 || startNode >= this.nodes.length) return dist;
    dist[startNode] = 0;
    const queue: number[] = [startNode];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      const currentDist = dist[current];
      for (const nb of this.adjacency[current] ?? []) {
        if (dist[nb] === Infinity) {
          dist[nb] = currentDist + 1;
          queue.push(nb);
        }
      }
    }
    return dist;
  }

  // Triangle wave through BFS rings: 0, 1, ..., maxRing, maxRing-1, ..., 1, 0, 1...
  // Held key produces concentric ripples expanding then contracting.
  private ringTargetForStep(state: KeyboardPathState, step: number): number {
    if (state.maxRing <= 0) return 0;
    const phase = positiveModulo(step, Math.max(2, state.cycleLength));
    return phase <= state.maxRing ? phase : state.cycleLength - phase;
  }

  private keyboardChordMaxNotes(): 1 | 2 | 3 {
    return Math.round(clamp(this.params.keyChordMaxNotes, 1, 3)) as 1 | 2 | 3;
  }

  private rememberKeyboardNode(state: KeyboardPathState, nodeIndex: number): void {
    state.recentNodes.push(nodeIndex);
    if (state.recentNodes.length > Starlace.KEYBOARD_RECENT_LIMIT) {
      state.recentNodes.splice(0, state.recentNodes.length - Starlace.KEYBOARD_RECENT_LIMIT);
    }
  }

  private keyboardStepDelay(state: KeyboardPathState): number {
    const base = clamp(this.params.keyWalkInterval, 0.08, 0.75);
    const stageIndex = Math.max(0, state.step - 1);
    const phraseLength = Math.max(1, state.totalStages);
    const stageInPhrase = positiveModulo(stageIndex, phraseLength);
    const phraseCycle = Math.floor(stageIndex / phraseLength);
    const patternIndex = stageIndex % Starlace.KEYBOARD_ECHO_DELAY_FACTORS.length;
    const rhythm = clamp(this.params.keyRhythmSwing, 0, 1);
    const drift = clamp(this.params.keyTempoDrift, 0, 1);
    const swing = stageInPhrase % 2 === 0 ? 1 + rhythm * 0.26 : 1 - rhythm * 0.22;
    const phraseWave = 1 + Math.sin((stageInPhrase / phraseLength) * TAU + state.phraseSeed * TAU) * drift * 0.30;
    const breath = stageInPhrase === 0 && phraseCycle > 0 ? 1 + drift * 0.38 : 1;
    const rush = stageInPhrase > phraseLength * 0.56 ? 1 - drift * 0.24 : 1;
    const humanize = (hash(state.phraseSeed * 13.71 + state.step * 19.37) - 0.5) * base * (0.08 + rhythm * 0.14);
    // Spanish-guitar attack: hold a longer rest after the bass chord on ring 0
    // so the arpeggio that follows reads as a clearly separate cascade, not
    // just another note in the same line.
    const justFiredRing = this.ringTargetForStep(state, stageIndex);
    const chordRest = justFiredRing === 0 ? 2.6 : 1;
    const factor = Starlace.KEYBOARD_ECHO_DELAY_FACTORS[patternIndex] * swing * phraseWave * breath * rush * chordRest;
    return clamp(base * factor + humanize, 0.07, 1.6);
  }

  private keyboardPathVelocity(state: KeyboardPathState): number {
    const patternIndex = state.step <= 0
      ? -1
      : (state.step - 1) % Starlace.KEYBOARD_ECHO_VELOCITY_OFFSETS.length;
    const accent = state.step <= 0
      ? 0.18
      : Starlace.KEYBOARD_ECHO_VELOCITY_OFFSETS[patternIndex] ?? 0;
    // Ripple decay: bass chord on ring 0 hits hardest; arpeggio notes on
    // outer rings sit clearly below it (Spanish-guitar dynamic). cycleStart
    // bonus restores energy when the next ripple begins.
    const ringTarget = this.ringTargetForStep(state, state.step);
    const ringFraction = state.maxRing > 0 ? ringTarget / state.maxRing : 0;
    const rippleDecay = ringFraction * 0.46;
    const ringZeroBoost = ringTarget === 0 ? 0.10 : 0;
    const cycleStart = state.step > 0 && positiveModulo(state.step, Math.max(2, state.cycleLength)) === 0
      ? 0.18
      : 0;
    const base = 0.46 + state.velocity * 0.36;
    return clamp(
      base + accent + cycleStart + ringZeroBoost - rippleDecay + hash(state.step * 11.23 + state.phraseSeed * 5.7) * 0.10,
      0.30,
      0.95,
    );
  }

  private emitStreak(node: StarNode, velocity: number): void {
    if (!this.sculptor) return;
    const sink = this.sculptor;
    const dir = _scratch.copy(sink.center).sub(node.world);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0.1, 0);
    dir.normalize();
    const pulse = clamp(node.pulse + velocity * 0.20, 0, 1);
    const twinkle = 0.5 + Math.sin(this.elapsed * (1.2 + node.seed * 1.7) + node.seed * TAU) * 0.5;
    this.nodeVisualColor(node, pulse, twinkle, _colorA);
    sink.emitFast(
      'starlace',
      node.world.x, node.world.y, node.world.z,
      dir.x, dir.y, dir.z,
      _colorA.r, _colorA.g, _colorA.b,
      Math.round(52 + velocity * 58),
      1.85 + velocity * 1.05,
    );
  }

  private decayPulses(delta: number): void {
    const k = Math.exp(-delta * this.params.pulseDecay);
    for (const node of this.nodes) node.pulse *= k;
    const pluckK = Math.exp(-delta * this.params.pluckDecay);
    for (let e = 0; e < this.edgePluck.length; e += 1) this.edgePluck[e] *= pluckK;
  }

  private reallocateLineBuffers(): void {
    const segments = Math.max(2, Math.round(this.params.pluckSegments));
    if (segments === this.pluckSegments) return;
    this.pluckSegments = segments;
    const vertFloats = this.edges.length * segments * 2 * 3;
    this.linePositions = new Float32Array(vertFloats);
    this.lineColors = new Float32Array(vertFloats);
    this.pulseLinePositions = new Float32Array(vertFloats);
    this.pulseLineColors = new Float32Array(vertFloats);
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.lineGeometry.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3));
    this.pulseLineGeometry.setAttribute('position', new THREE.BufferAttribute(this.pulseLinePositions, 3));
    this.pulseLineGeometry.setAttribute('color', new THREE.BufferAttribute(this.pulseLineColors, 3));
  }

  private applyColors(): void {
    this.cool.set(this.params.coolColor).lerp(STARLACE_DUSK_COOL, 0.20).multiplyScalar(0.98);
    this.warm.set(this.params.warmColor).lerp(STARLACE_DUSK_WARM, 0.18).multiplyScalar(0.98);
    this.gold.set(this.params.goldColor).lerp(STARLACE_DUSK_GOLD, 0.24).multiplyScalar(0.96);
    this.hot.set(this.params.hotColor).lerp(STARLACE_DUSK_HOT, 0.30).multiplyScalar(0.98);
    this.noteColors = STARLACE_NOTE_PALETTE.map(hex => new THREE.Color(hex).multiplyScalar(1.00));
    this.lineMaterial.color.setRGB(0.98, 0.97, 0.94);
    this.pulseLineMaterial.color.setRGB(1.00, 0.96, 0.92);
    this.nodeMaterial?.color.setRGB(0.94, 0.97, 1.00);
  }

  private notePaletteIndexForNode(node: StarNode): number {
    const maxNote = Math.max(1, this.hzTable.length - 1);
    const palettePos = (node.noteIndex / maxNote) * (STARLACE_NOTE_PALETTE.length - 1);
    return clamp(Math.round(palettePos), 0, STARLACE_NOTE_PALETTE.length - 1);
  }

  private nodeVisualColor(node: StarNode, pulse: number, twinkle: number, target: THREE.Color): THREE.Color {
    this.noteColorForNode(node, target);
    _colorB.copy(this.cool).lerp(this.warm, clamp(node.u + 0.5, 0, 1));
    target.lerp(_colorB, 0.10 + twinkle * 0.045);
    target.lerp(this.gold, hash(node.seed * 29.1 + node.noteIndex) > 0.80 ? 0.08 : 0.015);
    const flash = Math.pow(pulse, 1.55);
    target.lerp(this.hot, 0.08 + flash * 0.18).multiplyScalar(1.04 + flash * 0.56);
    target.r = Math.min(target.r, 1.22);
    target.g = Math.min(target.g, 1.16);
    target.b = Math.min(target.b, 1.24);
    return target;
  }

  private nodeGemColor(node: StarNode, pulse: number, twinkle: number, target: THREE.Color): THREE.Color {
    const lateral = smoothstep01(node.u + 0.5);
    const vertical = smoothstep01(node.v + 0.5);
    const depth = smoothstep01(node.z + 0.5);
    const flash = Math.pow(pulse, 1.55);
    const jewel = hash(node.seed * 41.7 + node.noteIndex * 3.9);
    const maxNote = Math.max(1, this.hzTable.length - 1);
    const gradient = positiveModulo(node.noteIndex / maxNote + lateral * 0.34 + jewel * 0.26, 1);

    if (gradient < 0.20) {
      target.copy(STARLACE_GEM_AMBER).lerp(this.gold, gradient / 0.20);
    } else if (gradient < 0.42) {
      target.copy(STARLACE_GEM_WINE).lerp(STARLACE_GEM_ROSE, (gradient - 0.20) / 0.22);
    } else if (gradient < 0.64) {
      target.copy(STARLACE_GEM_VIOLET).lerp(STARLACE_GEM_BLUE, (gradient - 0.42) / 0.22);
    } else if (gradient < 0.84) {
      target.copy(STARLACE_GEM_BLUE).lerp(STARLACE_GEM_TEAL, (gradient - 0.64) / 0.20);
    } else {
      target.copy(STARLACE_GEM_TEAL).lerp(STARLACE_GEM_AMBER, (gradient - 0.84) / 0.16);
    }

    this.noteColorForNode(node, _colorB);
    _colorC.copy(this.cool).lerp(this.warm, lateral);
    target
      .lerp(_colorB, 0.16 + jewel * 0.10)
      .lerp(_colorC, 0.10 + twinkle * 0.04)
      .lerp(this.gold, 0.04 + (1 - vertical) * 0.08 + (jewel > 0.82 ? 0.08 : 0));

    target.multiplyScalar(0.88 + depth * 0.16 + twinkle * 0.10);
    target.lerp(STARLACE_FROST_WHITE, 0.055 + (1 - pulse) * 0.025 + twinkle * 0.015);
    target.lerp(this.hot, 0.025 + flash * 0.18).multiplyScalar(1.08 + flash * 0.44);
    target.r = Math.min(target.r, 1.36);
    target.g = Math.min(target.g, 1.28);
    target.b = Math.min(target.b, 1.42);
    return target;
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

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function rotateVectorTowards(
  current: THREE.Vector3,
  target: THREE.Vector3,
  amount: number,
  maxRadians: number,
): void {
  if (target.lengthSq() < 1e-8) return;
  if (current.lengthSq() < 1e-8) {
    current.copy(target).normalize();
    return;
  }

  const angle = current.angleTo(target);
  if (!Number.isFinite(angle) || angle < 1e-5) {
    current.copy(target).normalize();
    return;
  }

  const capped = maxRadians > 0 ? Math.min(amount, maxRadians / angle) : amount;
  current.lerp(target, clamp(capped, 0, 1)).normalize();
}

function applyPaletteDefaults(params: StarlaceParams, palette: StarlacePalette): void {
  if (palette === 'remote') {
    params.coolColor = '#7b8ed2';
    params.warmColor = '#d35f95';
    params.goldColor = '#cc9448';
    params.hotColor = '#efad5c';
    return;
  }
  params.coolColor = '#4fa7ba';
  params.warmColor = '#c85a9a';
  params.goldColor = '#d99a43';
  params.hotColor = '#f2ba62';
}
