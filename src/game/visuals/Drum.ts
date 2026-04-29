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
import {
  DRUM_DEFAULT_BASE_ROW,
  drumKeyboardIndexForKey,
  drumOrbCountForBaseRow,
} from '../drumControls';
import { CREATURE_ROBE_COLORS, type CreatureId } from '../creatures';
import { getDrumHz } from '../harmony';
import { keyDirector } from '../keyDirector';
import {
  DEFAULT_ORB_ENVELOPE,
  type HandContactPoint,
  type OrbEnvelopeSettings,
  type OrbGestureState,
  type PlayerVisual,
  type VoiceState,
} from '../instruments';
import { clamp } from '../math';
import { OrbCollisionBVH } from './orbs/OrbCollisionBVH';

type DrumPalette = 'local' | 'remote';

export const DRUM_DEFS = {
  // pyramidBaseRow must come first so registerTweaks' initial onChange fires it
  // before the layout callbacks iterate the orb list populated by rebuildOrbs().
  pyramidBaseRow:    { default: DRUM_DEFAULT_BASE_ROW, min: 1, max: 8, step: 1, label: 'pyramid base row' },
  pyramidStartHeight: { default: 0.0, min: -0.5, max: 0.5, step: 0.005, label: 'starting height' },
  orbRadius:         { default: 0.052, min: 0.04, max: 0.32, step: 0.001, label: 'orb radius' },
  ringRadius:        { default: 0.125, min: 0.06, max: 0.50, step: 0.005, label: 'orb spacing' },
  pyramidRowSpacing: { default: 0.105, min: 0.10, max: 0.50, step: 0.005, label: 'height spacing' },
} as const;

export type DrumParams = ParamsOf<typeof DRUM_DEFS>;

const DRUM_RUNTIME = {
  bobAmount: 0.003,
  bobSpeed: 0.7,
  rippleSpeed: 1.28,
  rippleFreq: 27,
  rippleDecay: 3.1,
  rippleSigma: 0.18,
  rippleDisplace: 0.050,
  rippleGlow: 1.65,
  hitDistance: 0.045,
  palmRadius: 0.100,
  fingerRadius: 0.050,
  hitCooldown: 0.075,
  hitVelMin: 0.012,
  anchorSmoothing: 8.0,
  hitTintAmount: 0.85,
  envAttack: DEFAULT_ORB_ENVELOPE.attack,
  envDecay: DEFAULT_ORB_ENVELOPE.decay,
  envSustain: DEFAULT_ORB_ENVELOPE.sustain,
  envRelease: DEFAULT_ORB_ENVELOPE.release,
} as const;

const DRUM_ROBE_COOL = new THREE.Color('#6faec8');
const _orbHsl = { h: 0, s: 0, l: 0 };

export type OrbHit = {
  /** Scale field selected from the strike point on the single orb. */
  orbIndex: number;
  /** Hertz — pre-computed for the orb's note. */
  frequency: number;
  /** 0..1 normalized hit velocity. */
  velocity: number;
  /** Hand that caused a contact hit. Pointer / keyboard hits leave this empty. */
  hand?: HandContactPoint['hand'];
  /** Held-key/MIDI hits sustain until the matching release event arrives. */
  held?: boolean;
  /** Stable source for matching note-on/note-off. */
  sourceId?: string;
  /** Raw MIDI note number when the hit came from a MIDI controller. */
  noteNumber?: number;
  /** ADSR values used by both the sound engine and the orb light. */
  envelope: OrbEnvelopeSettings;
  /** World-space position of the strike (used by the sound-sculpture emitter). */
  worldPosition: THREE.Vector3;
};

export type OrbRelease = {
  orbIndex: number;
  frequency: number;
  sourceId: string;
  noteNumber?: number;
  envelope: OrbEnvelopeSettings;
};

type DrumOptions = {
  palette?: DrumPalette;
  creature?: CreatureId;
  title?: string;
  onHit?: (event: OrbHit) => void;
  onRelease?: (event: OrbRelease) => void;
  onGesture?: (gesture: OrbGestureState) => void;
  onOrbCountChange?: (count: number) => void;
  camera?: THREE.Camera;
  canvas?: HTMLCanvasElement;
  anchor?: THREE.Vector3;
  sculptor?: import('../sculptor/EnergyEmitter').EnergySink;
};

// Playable orbs arranged in a layered 3D pyramid in front of the player. Base
// plane count is tweakable (default 5 -> planes of 5,4,3,2,1 = 15 orbs). Each
// orb maps to a scale degree from the shared Jam Train harmony, continuing
// upward by octave when the pyramid has more orbs than one scale cycle.
// Maximum simultaneous wave impulses shared by the orb cluster. Once exceeded,
// the oldest impulse is recycled. Keep enough history for overlapping strikes
// to meet instead of making a new hit feel like it erased the previous one.
const MAX_RIPPLES = 24;
const RIPPLE_MAX_AGE = 5.8;
const DRUM_LAYOUT_TOP_ROWS = DRUM_DEFAULT_BASE_ROW;
// NDC units per second. Pointer must be moving at least this fast over an orb
// for the held drone synth to be considered active. Roughly "a hair of motion"
// — high enough to ignore the few stray pixels of cursor jitter while a user
// is reading the screen, low enough that gentle drags still drone.
const POINTER_GESTURE_MOTION_NDC_PER_SEC = 0.05;

type AnyNode = any;

// One octave of the Jam Train drum scale. frequencyForOrb() walks this table
// by scale degree and transposes whole cycles up by octaves, so expanded
// pyramids do not repeat exact pitches. The table is per-instance and tracks
// the current key via the KeyDirector subscription set up in the constructor.

function makeOrbPlanePoints(count: number, spacing: number): Array<{ x: number; z: number }> {
  if (count <= 1) return [{ x: 0, z: 0 }];
  const radius = spacing / (2 * Math.sin(Math.PI / count));
  const startAngle = -Math.PI / 2;
  const points: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const angle = startAngle + (i / count) * Math.PI * 2;
    points.push({
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
    });
  }
  return points;
}

function makeOrbOffsets(baseRow: number, planeSpacing: number, layerSpacing: number, startHeight: number): THREE.Vector3[] {
  // Pyramid: bottom plane has `baseRow` orbs, each plane above has one fewer,
  // until a single orb at the apex. Default-size pad grids stay centered
  // around the anchor; larger grids grow downward so the apex does not climb
  // into the top of the view. Index order is bottom-up, then back-to-front
  // within each plane.
  const rows = Math.max(1, Math.floor(baseRow));
  const offsets: THREE.Vector3[] = [];
  const yCenter = (rows - 1) * 0.5 * layerSpacing;
  const topOverflowRows = Math.max(0, rows - DRUM_LAYOUT_TOP_ROWS);
  const downBias = topOverflowRows * 0.5 * layerSpacing;
  for (let row = 0; row < rows; row += 1) {
    const orbsInPlane = rows - row;
    const y = startHeight + row * layerSpacing - yCenter - downBias;
    const points = makeOrbPlanePoints(orbsInPlane, planeSpacing);
    for (const point of points) {
      offsets.push(new THREE.Vector3(point.x, y, point.z));
    }
  }
  return offsets;
}

function createOrbUniforms(params: DrumParams) {
  return {
    hitTintAmount: uniform(DRUM_RUNTIME.hitTintAmount),
    orbRadius:    uniform(params.orbRadius),
    rippleSpeed:  uniform(DRUM_RUNTIME.rippleSpeed),
    rippleFreq:   uniform(DRUM_RUNTIME.rippleFreq),
    rippleDecay:  uniform(DRUM_RUNTIME.rippleDecay),
    rippleSigma:  uniform(DRUM_RUNTIME.rippleSigma),
    rippleDisplace: uniform(DRUM_RUNTIME.rippleDisplace),
    rippleGlow:   uniform(DRUM_RUNTIME.rippleGlow),
    gesture:      uniform(new THREE.Vector4(0, 0, 0, 0)),
    gestureDepth: uniform(0),
  };
}
type OrbUniforms = ReturnType<typeof createOrbUniforms>;

function createOrbPerInstanceUniforms() {
  return {
    elapsed: uniform(0),
    pulse: uniform(0),
    offset: uniform(new THREE.Vector3()),
    baseColor: uniform(new THREE.Color()),
    rimColor: uniform(new THREE.Color()),
    hotColor: uniform(new THREE.Color()),
    sparkColor: new THREE.Color(),
  };
}
type OrbPerInstanceUniforms = ReturnType<typeof createOrbPerInstanceUniforms>;

function applyOrbRobeGradient(
  creature: CreatureId,
  heightT: number,
  index: number,
  perOrb: OrbPerInstanceUniforms,
): void {
  const t = clamp(heightT, 0, 1);
  const jitterRaw = Math.sin((index + 1) * 12.9898) * 43758.5453;
  const jitter = jitterRaw - Math.floor(jitterRaw) - 0.5;

  const base = perOrb.baseColor.value;
  base.set(CREATURE_ROBE_COLORS[creature]);
  base.lerp(DRUM_ROBE_COOL, clamp((1 - t) * 0.18 + Math.max(0, -jitter) * 0.035, 0, 0.28));
  base.getHSL(_orbHsl);
  base.setHSL(
    _orbHsl.h,
    clamp(_orbHsl.s * (0.84 + t * 0.36) + jitter * 0.055, 0, 1),
    clamp(_orbHsl.l * (0.90 + t * 0.14) + t * 0.095 + jitter * 0.026, 0.045, 0.62),
  );

  base.getHSL(_orbHsl);
  perOrb.rimColor.value.setHSL(
    _orbHsl.h,
    clamp(_orbHsl.s * 1.16 + 0.14, 0, 1),
    clamp(_orbHsl.l + 0.28 + t * 0.08, 0.28, 0.86),
  );
  perOrb.hotColor.value.setHSL(
    _orbHsl.h,
    clamp(_orbHsl.s * 0.94 + 0.10, 0, 1),
    clamp(_orbHsl.l + 0.50 + t * 0.03, 0.58, 0.97),
  );
  perOrb.sparkColor.setHSL(
    _orbHsl.h,
    clamp(_orbHsl.s * 1.08 + 0.08, 0, 1),
    clamp(_orbHsl.l + 0.22 + t * 0.07, 0.34, 0.78),
  );
}

type Orb = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicNodeMaterial;
  lastHitAt: number;
  hitPulse: number;
  envelopePhase: 'idle' | 'attack' | 'decay' | 'sustain' | 'release';
  envelopeStartedAt: number;
  envelopeStartLevel: number;
  envelopePeak: number;
  envelopeSustain: number;
  envelopeReleaseFrom: number;
  heldSources: Set<string>;
  offset: THREE.Vector3;
  uniforms: OrbPerInstanceUniforms;
};

type OrbHitCandidate = {
  contact: HandContactPoint;
  point: THREE.Vector3;
  speed: number;
};

type PointerRayHit = {
  orbIndex: number;
  distance: number;
  worldPoint: THREE.Vector3;
  localPoint: THREE.Vector3;
};

const _palmTmp = new THREE.Vector3();
const _hitDir = new THREE.Vector3();
const _contactDelta = new THREE.Vector3();
const _orbCenter = new THREE.Vector3();
const _strikePoint = new THREE.Vector3();
const _ripplePoint = new THREE.Vector3();
const _sparkDir = new THREE.Vector3();
const _segment = new THREE.Vector3();
const _pointToStart = new THREE.Vector3();
const _pointerWorld = new THREE.Vector3();
const _pointerLocal = new THREE.Vector3();
const _pointerNdcSample = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _pointerIntersections: THREE.Intersection<THREE.Object3D>[] = [];

export class Drum implements PlayerVisual {
  readonly mesh: THREE.Group;
  readonly params: DrumParams;

  private orbs: Orb[] = [];
  private performanceTargets: THREE.Vector3[] = [];
  private elapsed = 0;
  private active = true;
  private initialized = false;
  private anchor = new THREE.Vector3();
  private smoothedEnergy = 0;
  private collisionBVH!: OrbCollisionBVH;
  private sphereGeo!: THREE.SphereGeometry;
  private previousContacts = new Map<string, THREE.Vector3>();
  private contactHits: number[] = [];
  private currentContactHits: number[] = [];
  private hitCandidates: (OrbHitCandidate | null)[] = [];
  private activeContactKeys = new Set<string>();
  private currentContactKeys = new Set<string>();
  private rippleSources: THREE.Vector4[] = [];
  private rippleStarts: number[] = [];
  private rippleCursor = 0;
  private pointerNdc = new THREE.Vector2(999, 999);
  private pointerNdcPrev = new THREE.Vector2(999, 999);
  private pointerNdcPrevValid = false;
  private pointerLastAtMs = -Infinity;
  private pointerDown = false;
  private pointerInside = false;
  private pointerGlow = 0;
  private pointerClickQueued = false;
  // Per-orb "ray currently inside this orb" — flips false→true to fire entry hits.
  // Sized in rebuildOrbs() so it tracks pyramidBaseRow.
  private pointerOrbInside: boolean[] = [];
  private pointerSweepSeen: boolean[] = [];
  private pointerSweepWorldPoints: THREE.Vector3[] = [];
  private pointerFrameFired: boolean[] = [];
  private pointerCurrentHit: PointerRayHit = {
    orbIndex: -1,
    distance: Infinity,
    worldPoint: new THREE.Vector3(),
    localPoint: new THREE.Vector3(),
  };
  private pointerSampleHit: PointerRayHit = {
    orbIndex: -1,
    distance: Infinity,
    worldPoint: new THREE.Vector3(),
    localPoint: new THREE.Vector3(),
  };
  private pointerMoveListener?: (event: PointerEvent) => void;
  private pointerDownListener?: (event: PointerEvent) => void;
  private pointerUpListener?: (event: PointerEvent) => void;
  private pointerLeaveListener?: (event: PointerEvent) => void;

  private uniforms: OrbUniforms;

  // Intro/outro reveal: orbs ride up from below the screen. revealStartedAt
  // marks when the active animation began (in `elapsed` seconds), direction
  // 1 = rise in / -1 = sink out. While `revealActive` is true, hand and
  // pointer interaction is suppressed so the animation can't be interrupted
  // by accidental hits.
  private revealStartedAt = -Infinity;
  private revealDirection: 1 | -1 = 1;
  private revealActive = false;
  private revealedFully = false;
  private revealResolveOutro?: () => void;
  private outroPromise?: Promise<void>;
  private static readonly REVEAL_DURATION_IN = 1.05;
  private static readonly REVEAL_DURATION_OUT = 0.55;
  private static readonly REVEAL_PER_ORB_IN = 0.65;
  private static readonly REVEAL_PER_ORB_OUT = 0.42;
  private static readonly REVEAL_DROP_DISTANCE = 1.45;

  private onHitCallback?: (e: OrbHit) => void;
  private onReleaseCallback?: (e: OrbRelease) => void;
  private onGestureCallback?: (gesture: OrbGestureState) => void;
  private onOrbCountChange?: (count: number) => void;
  private lastReportedOrbCount = -1;
  private registered?: ReturnType<typeof registerTweaks<typeof DRUM_DEFS>>;
  private camera?: THREE.Camera;
  private canvas?: HTMLCanvasElement;
  private fixedAnchor?: THREE.Vector3;
  private sculptor?: import('../sculptor/EnergyEmitter').EnergySink;
  private palette: DrumPalette;
  private static SPARK_COLOR_LOCAL = { r: 0.34, g: 0.88, b: 0.94 };
  private static SPARK_COLOR_REMOTE = { r: 0.48, g: 0.84, b: 0.98 };
  private keyDownListener?: (e: KeyboardEvent) => void;
  private keyUpListener?: (e: KeyboardEvent) => void;
  private keyBlurListener?: () => void;
  private heldSources = new Map<string, { orbIndex: number; frequency: number; noteNumber?: number }>();
  private hzTable: readonly number[] = getDrumHz(keyDirector.getCurrent());
  private keyUnsubscribe?: () => void;

  constructor(scene: THREE.Scene, paneDock?: HTMLElement, paneKey = 'drum', opts: DrumOptions = {}) {
    this.params = { ...Object.fromEntries(Object.entries(DRUM_DEFS).map(([k, d]) => [k, d.default])) } as DrumParams;
    this.onHitCallback = opts.onHit;
    this.onReleaseCallback = opts.onRelease;
    this.onGestureCallback = opts.onGesture;
    this.onOrbCountChange = opts.onOrbCountChange;
    this.camera = opts.camera;
    this.canvas = opts.canvas;
    this.fixedAnchor = opts.anchor?.clone();
    this.sculptor = opts.sculptor;
    this.palette = opts.palette ?? 'local';

    this.mesh = new THREE.Group();
    this.mesh.name = `piano-pads-${opts.palette ?? 'local'}`;
    scene.add(this.mesh);

    this.keyUnsubscribe = keyDirector.onChange(({ current }) => {
      this.hzTable = getDrumHz(current);
    });

    this.uniforms = createOrbUniforms(this.params, this.palette);
    for (let r = 0; r < MAX_RIPPLES; r += 1) {
      this.rippleSources.push(new THREE.Vector4(0, 0, 0, 0));
      this.rippleStarts.push(-1);
    }

    this.sphereGeo = new THREE.SphereGeometry(1, 32, 24);
    // Initial orbs are created via the registerTweaks initial fire of
    // pyramidBaseRow → rebuildOrbs(); ensure something exists in case
    // registerTweaks doesn't fire (no callback registered for that key).

    this.registered = registerTweaks(paneDock, paneKey, DRUM_DEFS, {
      title: opts.title ?? 'Piano Pads',
      params: this.params,
      onChange: {
        orbRadius:    v => {
          this.uniforms.orbRadius.value = v;
          for (const o of this.orbs) o.mesh.scale.setScalar(v);
        },
        ringRadius:        () => this.layoutOrbs(),
        pyramidRowSpacing: () => this.layoutOrbs(),
        pyramidStartHeight: () => this.layoutOrbs(),
        pyramidBaseRow:    () => this.rebuildOrbs(),
      },
    });

    // Safety net: if registerTweaks didn't fire pyramidBaseRow's onChange (e.g.
    // future refactor), make sure orbs exist before we start the update loop.
    if (this.orbs.length === 0) this.rebuildOrbs();

    if (this.camera && this.canvas) this.attachPointerEvents(this.canvas);
    if (this.palette === 'local') this.attachKeyboardEvents();
  }

  private rebuildOrbs(): void {
    // Tear down any existing orbs and BVH, then rebuild for the current
    // pyramidBaseRow / spacing values. Per-orb state arrays are resized too.
    this.releaseAllHeldNotes();
    for (const orb of this.orbs) {
      this.mesh.remove(orb.mesh);
      orb.material.dispose();
    }
    this.orbs.length = 0;
    this.collisionBVH?.dispose();

    const baseRow = Math.max(1, Math.floor(this.params.pyramidBaseRow));
    const offsets = makeOrbOffsets(
      baseRow,
      this.params.ringRadius,
      this.params.pyramidRowSpacing,
      this.params.pyramidStartHeight,
    );
    const count = offsets.length;
    this.notifyOrbCount(count);

    this.collisionBVH = new OrbCollisionBVH(count);
    this.hitCandidates = Array.from({ length: count }, () => null);
    this.pointerOrbInside = Array.from({ length: count }, () => false);
    this.pointerSweepSeen = Array.from({ length: count }, () => false);
    this.pointerSweepWorldPoints = Array.from({ length: count }, () => new THREE.Vector3());
    this.pointerFrameFired = Array.from({ length: count }, () => false);

    for (let i = 0; i < count; i += 1) {
      const orbUniforms = createOrbPerInstanceUniforms();
      orbUniforms.offset.value.copy(offsets[i]);

      const material = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: true,
      });
      const nodes = this.makeOrbNodes(orbUniforms);
      material.positionNode = nodes.positionNode;
      material.colorNode = nodes.colorNode;

      const sphere = new THREE.Mesh(this.sphereGeo, material);
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
        envelopePhase: 'idle',
        envelopeStartedAt: 0,
        envelopeStartLevel: 0,
        envelopePeak: 0,
        envelopeSustain: 0,
        envelopeReleaseFrom: 0,
        heldSources: new Set(),
        offset: offsets[i].clone(),
        uniforms: orbUniforms,
      });
    }
  }

  setVisible(visible: boolean): void {
    this.active = visible;
    this.mesh.visible = visible;
    if (!visible) this.releaseAllHeldNotes();
  }

  setAnchor(anchor: THREE.Vector3): void {
    this.fixedAnchor = anchor.clone();
    this.anchor.copy(anchor);
    this.placeGroup();
  }

  startHidden(): void {
    this.mesh.visible = false;
    this.releaseAllHeldNotes();
    this.revealedFully = false;
    this.revealActive = false;
  }

  playIntroAnimation(): void {
    this.revealStartedAt = this.elapsed;
    this.revealDirection = 1;
    this.revealActive = true;
    this.revealedFully = false;
    this.mesh.visible = true;
  }

  /**
   * Returns a promise that resolves once the orbs have fully sunk out of
   * view, so the caller can swap instruments cleanly.
   *
   * Idempotent: if an outro is already in flight (e.g. the HUD pick fired
   * the change AND the multiplayer echo fired it again), every caller awaits
   * the same promise so neither side gets orphaned.
   */
  playOutroAnimation(): Promise<void> {
    if (!this.mesh.visible) return Promise.resolve();
    if (this.outroPromise) return this.outroPromise;
    this.releaseAllHeldNotes();
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

  getPerformanceTargets(targets = this.performanceTargets): readonly THREE.Vector3[] {
    targets.length = 0;
    if (!this.active || !this.mesh.visible || !this.revealedFully || this.revealActive) return targets;

    for (let i = 0; i < this.orbs.length; i += 1) {
      const out = targets[i] ?? new THREE.Vector3();
      out.copy(this.mesh.position).add(this.orbs[i].mesh.position);
      targets[i] = out;
    }
    targets.length = this.orbs.length;
    return targets;
  }

  // Per-orb reveal envelope. Stagger keeps neighbours from rising together
  // so the row reads as a phrase rather than a single block.
  private orbReveal(i: number): { offsetY: number; scale: number } {
    if (!this.mesh.visible) return { offsetY: 0, scale: 0 };
    if (!this.revealActive) {
      return this.revealedFully
        ? { offsetY: 0, scale: 1 }
        : { offsetY: 0, scale: 0 };
    }
    const isIn = this.revealDirection === 1;
    const total = isIn ? Drum.REVEAL_DURATION_IN : Drum.REVEAL_DURATION_OUT;
    const perOrb = isIn ? Drum.REVEAL_PER_ORB_IN : Drum.REVEAL_PER_ORB_OUT;
    const stagger = Math.max(0, total - perOrb) / Math.max(1, this.orbs.length - 1);
    // Outro sweeps the opposite way so the cluster collapses center-out
    // instead of repeating the intro pattern in reverse.
    const stagIndex = isIn ? i : this.orbs.length - 1 - i;
    const localT = this.elapsed - this.revealStartedAt - stagIndex * stagger;
    const t = clamp(localT / Math.max(perOrb, 0.0001), 0, 1);
    // Out-cubic on the way in for the satisfying settle, in-cubic on the way
    // out so the orbs accelerate as they fall away.
    const eased = isIn
      ? 1 - Math.pow(1 - t, 3)
      : Math.pow(t, 3);
    const orbT = isIn ? eased : 1 - eased;
    return {
      offsetY: -Drum.REVEAL_DROP_DISTANCE * (1 - orbT),
      scale: orbT,
    };
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
      if (this.fixedAnchor) {
        this.anchor.copy(this.fixedAnchor);
      } else {
        this.anchor.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
        this.anchor.z -= 0.06;
      }
      this.initialized = true;
      this.placeGroup();
    }

    // Anchor follows hand cloud center with strong smoothing. While the mouse
    // is actively inside the orb, freeze the anchor so the instrument does not
    // run away from the pointer.
    if (this.fixedAnchor) {
      this.anchor.copy(this.fixedAnchor);
    } else if (!this.pointerInside && !this.pointerDown) {
      _palmTmp.copy(leftPalm).add(rightPalm).multiplyScalar(0.5);
      _palmTmp.z -= 0.06;
      const alpha = 1 - Math.exp(-delta / Math.max(0.05, DRUM_RUNTIME.anchorSmoothing));
      this.anchor.lerp(_palmTmp, alpha);
    }
    this.placeGroup();

    this.smoothedEnergy += (voice.energy - this.smoothedEnergy) * (1 - Math.exp(-delta * 5));

    // Per-orb update: bob and BVH sync. Hit detection runs once after all
    // centers are current so palms and finger joints query the same tree.
    const baseRadius = this.params.orbRadius;
    for (let i = 0; i < this.orbs.length; i += 1) {
      const orb = this.orbs[i];
      // Subtle bob — each orb has its own phase.
      const bob = Math.sin(this.elapsed * DRUM_RUNTIME.bobSpeed * 1.3 + i * 1.21) * DRUM_RUNTIME.bobAmount;
      const reveal = this.orbReveal(i);
      orb.mesh.position.set(orb.offset.x, orb.offset.y + bob + reveal.offsetY, orb.offset.z);
      orb.mesh.scale.setScalar(baseRadius * reveal.scale);
      orb.uniforms.offset.value.copy(orb.mesh.position);
      _orbCenter.copy(this.mesh.position).add(orb.mesh.position);
      this.collisionBVH.setPoint(i, _orbCenter.x, _orbCenter.y, _orbCenter.z);
    }

    this.collisionBVH.refit();
    this.tickReveal();
    if (this.revealedFully && !this.revealActive) {
      if (contacts) this.processContactHits(contacts, delta);
      this.updatePointerGesture(delta);
    } else {
      // Drain any pointer "still inside" state so hits don't fire the moment
      // interactivity returns. Visuals stay quiet during the rise.
      this.clearPointerVisualState(delta);
      this.pointerNdcPrevValid = false;
      for (let i = 0; i < this.orbs.length; i += 1) this.pointerOrbInside[i] = false;
    }

    for (const orb of this.orbs) {
      this.updateOrbEnvelope(orb);
      orb.uniforms.pulse.value = orb.hitPulse;
      orb.uniforms.elapsed.value = this.elapsed;
    }

    void voice;
  }

  dispose(): void {
    this.registered?.dispose();
    this.keyUnsubscribe?.();
    this.releaseAllHeldNotes();
    this.detachPointerEvents();
    this.detachKeyboardEvents();
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

  private tickReveal(): void {
    if (!this.revealActive) return;
    const total = this.revealDirection === 1
      ? Drum.REVEAL_DURATION_IN
      : Drum.REVEAL_DURATION_OUT;
    const elapsedSinceStart = this.elapsed - this.revealStartedAt;
    if (elapsedSinceStart < total + 0.05) return;
    this.revealActive = false;
    if (this.revealDirection === 1) {
      this.revealedFully = true;
    } else {
      this.revealedFully = false;
      this.mesh.visible = false;
      const resolve = this.revealResolveOutro;
      this.revealResolveOutro = undefined;
      this.outroPromise = undefined;
      resolve?.();
    }
  }

  private currentEnvelope(): OrbEnvelopeSettings {
    return {
      attack: Math.max(0.002, DRUM_RUNTIME.envAttack),
      decay: Math.max(0.002, DRUM_RUNTIME.envDecay),
      sustain: clamp(DRUM_RUNTIME.envSustain, 0, 1),
      release: Math.max(0.002, DRUM_RUNTIME.envRelease),
    };
  }

  private startOrbEnvelope(orb: Orb, velocity: number): void {
    const envelope = this.currentEnvelope();
    const peak = clamp(0.56 + velocity * 0.44, 0.05, 1);
    orb.envelopePhase = 'attack';
    orb.envelopeStartedAt = this.elapsed;
    orb.envelopeStartLevel = orb.hitPulse;
    orb.envelopePeak = Math.max(peak, orb.hitPulse);
    orb.envelopeSustain = orb.envelopePeak * envelope.sustain;
    orb.envelopeReleaseFrom = orb.hitPulse;
  }

  private beginOrbRelease(orb: Orb): void {
    if (orb.envelopePhase === 'idle' || orb.envelopePhase === 'release') return;
    orb.envelopePhase = 'release';
    orb.envelopeStartedAt = this.elapsed;
    orb.envelopeReleaseFrom = orb.hitPulse;
  }

  private updateOrbEnvelope(orb: Orb): void {
    const envelope = this.currentEnvelope();
    const age = this.elapsed - orb.envelopeStartedAt;
    switch (orb.envelopePhase) {
      case 'attack': {
        const t = clamp(age / envelope.attack, 0, 1);
        orb.hitPulse = lerp(orb.envelopeStartLevel, orb.envelopePeak, t);
        if (t >= 1) {
          orb.envelopePhase = 'decay';
          orb.envelopeStartedAt = this.elapsed;
        }
        break;
      }
      case 'decay': {
        const t = clamp(age / envelope.decay, 0, 1);
        orb.hitPulse = lerp(orb.envelopePeak, orb.envelopeSustain, t);
        if (t >= 1) {
          if (orb.heldSources.size > 0) {
            orb.envelopePhase = 'sustain';
            orb.hitPulse = orb.envelopeSustain;
          } else {
            this.beginOrbRelease(orb);
          }
        }
        break;
      }
      case 'sustain':
        if (orb.heldSources.size > 0) {
          orb.hitPulse += (orb.envelopeSustain - orb.hitPulse) * 0.35;
        } else {
          this.beginOrbRelease(orb);
        }
        break;
      case 'release': {
        const t = clamp(age / envelope.release, 0, 1);
        orb.hitPulse = lerp(orb.envelopeReleaseFrom, 0, t);
        if (t >= 1) {
          orb.envelopePhase = 'idle';
          orb.hitPulse = 0;
        }
        break;
      }
      case 'idle':
      default:
        orb.hitPulse = 0;
        break;
    }
  }

  private layoutOrbs(): void {
    const baseRow = Math.max(1, Math.floor(this.params.pyramidBaseRow));
    const offsets = makeOrbOffsets(
      baseRow,
      this.params.ringRadius,
      this.params.pyramidRowSpacing,
      this.params.pyramidStartHeight,
    );
    if (offsets.length !== this.orbs.length) {
      // Spacing changed at the same time the row count did — defer to a full
      // rebuild so per-orb state arrays stay sized to the orb list.
      this.rebuildOrbs();
      return;
    }
    for (let i = 0; i < this.orbs.length; i += 1) {
      this.orbs[i].offset.copy(offsets[i]);
      this.orbs[i].uniforms.offset.value.copy(offsets[i]);
    }
  }

  private attachPointerEvents(canvas: HTMLCanvasElement): void {
    const clearPointer = () => {
      if (this.pointerDown) return;
      this.pointerInside = false;
      this.pointerClickQueued = false;
      this.pointerNdcPrevValid = false;
      this.pointerLastAtMs = -Infinity;
      for (let i = 0; i < this.orbs.length; i += 1) this.pointerOrbInside[i] = false;
    };

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
        clearPointer();
        return;
      }
      if (!updatePointer(event)) clearPointer();
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
    this.pointerLeaveListener = () => {
      this.pointerDown = false;
      clearPointer();
    };

    window.addEventListener('pointermove', this.pointerMoveListener, true);
    window.addEventListener('pointerdown', this.pointerDownListener, true);
    window.addEventListener('pointerup', this.pointerUpListener, true);
    window.addEventListener('pointercancel', this.pointerLeaveListener, true);
  }

  private detachPointerEvents(): void {
    if (this.pointerMoveListener) window.removeEventListener('pointermove', this.pointerMoveListener, true);
    if (this.pointerDownListener) window.removeEventListener('pointerdown', this.pointerDownListener, true);
    if (this.pointerUpListener) window.removeEventListener('pointerup', this.pointerUpListener, true);
    if (this.pointerLeaveListener) window.removeEventListener('pointercancel', this.pointerLeaveListener, true);
    this.pointerMoveListener = undefined;
    this.pointerDownListener = undefined;
    this.pointerUpListener = undefined;
    this.pointerLeaveListener = undefined;
  }

  private isPointerUiTarget(event: PointerEvent): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    if (target === this.canvas) return false;
    return !!target.closest('button,input,textarea,select,a,[contenteditable="true"],[role="button"],#ui > *,#stage > *');
  }

  private attachKeyboardEvents(): void {
    this.keyDownListener = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (!this.isInteractive()) return;
      const key = e.key.toLowerCase();
      const idx = drumKeyboardIndexForKey(key, this.orbs.length);
      if (idx === undefined) return;
      e.preventDefault();
      this.fireKeyboardHit(key, idx);
    };
    this.keyUpListener = (e: KeyboardEvent) => {
      this.releaseHeldSource(`keyboard:${e.key.toLowerCase()}`);
    };
    this.keyBlurListener = () => {
      this.releaseAllHeldNotes('keyboard:');
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
    this.releaseAllHeldNotes('keyboard:');
  }

  private fireKeyboardHit(key: string, orbIndex: number): void {
    const orb = this.orbs[orbIndex];
    if (!orb) return;
    // Strike from the front of the orb (toward +z in local space).
    _hitDir.set(0, 0.2, 1);
    _hitDir.normalize();
    _strikePoint.copy(orb.mesh.position).addScaledVector(_hitDir, this.params.orbRadius);
    const velocity = 0.7;
    const worldStrike = _strikePoint.clone();
    this.mesh.localToWorld(worldStrike);
    this.dispatchHit(orbIndex, velocity, worldStrike, false, undefined, {
      held: true,
      sourceId: `keyboard:${key}`,
    });
  }

  triggerMidiNoteOn(noteNumber: number, velocity: number, sourceId?: string): void {
    if (!this.isInteractive()) return;
    const orbIndex = this.orbIndexForMidiNote(noteNumber);
    if (orbIndex < 0) return;
    const orb = this.orbs[orbIndex];
    if (!orb) return;
    _hitDir.set(0, 0.2, 1).normalize();
    _strikePoint.copy(orb.mesh.position).addScaledVector(_hitDir, this.params.orbRadius);
    const worldStrike = _strikePoint.clone();
    this.mesh.localToWorld(worldStrike);
    this.dispatchHit(orbIndex, clamp(velocity, 0, 1), worldStrike, false, undefined, {
      held: true,
      sourceId: this.midiSourceId(noteNumber, sourceId),
      noteNumber,
    });
  }

  triggerMidiNoteOff(noteNumber: number, sourceId?: string): void {
    this.releaseHeldSource(this.midiSourceId(noteNumber, sourceId));
  }

  releaseAllMidiNotes(): void {
    this.releaseAllHeldNotes('midi:');
  }

  private orbIndexForMidiNote(noteNumber: number): number {
    const count = this.orbs.length;
    if (count <= 0 || !Number.isFinite(noteNumber)) return -1;
    return positiveModulo(Math.round(noteNumber) - 36, count);
  }

  private midiSourceId(noteNumber: number, sourceId?: string): string {
    return `midi:${sourceId ?? Math.round(noteNumber)}`;
  }

  private releaseHeldSource(sourceId: string): void {
    const held = this.heldSources.get(sourceId);
    if (!held) return;
    this.heldSources.delete(sourceId);
    const orb = this.orbs[held.orbIndex];
    if (orb) {
      orb.heldSources.delete(sourceId);
      if (orb.heldSources.size === 0) this.beginOrbRelease(orb);
    }
    this.onReleaseCallback?.({
      sourceId,
      orbIndex: held.orbIndex,
      frequency: held.frequency,
      noteNumber: held.noteNumber,
      envelope: this.currentEnvelope(),
    });
  }

  private releaseAllHeldNotes(prefix?: string): void {
    const sources = [...this.heldSources.keys()];
    for (const sourceId of sources) {
      if (prefix && !sourceId.startsWith(prefix)) continue;
      this.releaseHeldSource(sourceId);
    }
  }

  private updatePointerGesture(delta: number): void {
    const camera = this.camera;
    if (!camera || !this.canvas) {
      this.emitGesture(false, _pointerLocal.set(0, 0, 0), 0, 0, 0);
      return;
    }

    const recent = (performance.now() - this.pointerLastAtMs) / 1000 < 0.42 || this.pointerDown;
    if (!recent) {
      this.clearPointerVisualState(delta);
      for (let i = 0; i < this.orbs.length; i += 1) this.pointerOrbInside[i] = false;
      this.pointerNdcPrevValid = false;
      this.pointerClickQueued = false;
      this.emitGesture(false, _pointerLocal.set(0, 0, 0), 0, 0, 0);
      return;
    }

    // NDC-space pointer speed. Independent of which orb is intersected; used
    // as the "swipe speed" velocity for any hits triggered this frame.
    let ndcSpeed = 0;
    if (this.pointerNdcPrevValid && delta > 0) {
      ndcSpeed = this.pointerNdc.distanceTo(this.pointerNdcPrev) / delta;
    }

    const clickQueued = this.pointerClickQueued;
    this.pointerClickQueued = false;

    this.mesh.updateMatrixWorld(true);
    const hadPrevious = this.pointerNdcPrevValid;
    const ndcDistance = hadPrevious ? this.pointerNdc.distanceTo(this.pointerNdcPrev) : 0;
    const sampleCount = hadPrevious ? clamp(Math.ceil(ndcDistance / 0.025), 1, 36) : 1;
    this.pointerSweepSeen.fill(false);
    this.pointerFrameFired.fill(false);

    for (let s = 0; s <= sampleCount; s += 1) {
      if (hadPrevious) {
        _pointerNdcSample.copy(this.pointerNdcPrev).lerp(this.pointerNdc, s / sampleCount);
      } else {
        _pointerNdcSample.copy(this.pointerNdc);
      }
      if (!this.raycastPointer(_pointerNdcSample, camera, this.pointerSampleHit)) continue;
      const orbIndex = this.pointerSampleHit.orbIndex;
      if (this.pointerSweepSeen[orbIndex]) continue;
      this.pointerSweepSeen[orbIndex] = true;
      this.pointerSweepWorldPoints[orbIndex].copy(this.pointerSampleHit.worldPoint);
    }

    const hasActiveHit = this.raycastPointer(this.pointerNdc, camera, this.pointerCurrentHit);
    const activeOrb = hasActiveHit ? this.pointerCurrentHit.orbIndex : -1;
    const velocity = this.pointerVelocity(ndcSpeed, clickQueued);

    // A swipe can skip over a small orb between animation frames. Sample the
    // pointer path in NDC and fire for every orb the swept ray crossed.
    for (let i = 0; i < this.orbs.length; i += 1) {
      if (!this.pointerSweepSeen[i] || this.pointerOrbInside[i]) continue;
      this.pointerFrameFired[i] = this.firePointerHit(i, velocity, this.pointerSweepWorldPoints[i]);
    }

    // Clicking while already hovering should still behave like a real strike.
    if (clickQueued && hasActiveHit && !this.pointerFrameFired[activeOrb]) {
      this.pointerFrameFired[activeOrb] = this.firePointerHit(activeOrb, velocity, this.pointerCurrentHit.worldPoint);
    }

    for (let i = 0; i < this.orbs.length; i += 1) {
      this.pointerOrbInside[i] = i === activeOrb;
    }

    this.pointerNdcPrev.copy(this.pointerNdc);
    this.pointerNdcPrevValid = true;

    if (!hasActiveHit) {
      this.clearPointerVisualState(delta);
      this.emitGesture(false, _pointerLocal.set(0, 0, 0), 0, 0, 0);
      return;
    }

    // Visual gesture render uses the active ray/object intersection in
    // cluster-local space, so the lit spot and ripple origin match the cursor.
    const orb = this.orbs[activeOrb];
    _pointerLocal.copy(this.pointerCurrentHit.localPoint);

    const radial = clamp(_pointerLocal.distanceTo(orb.mesh.position) / Math.max(this.params.orbRadius, 1e-4), 0, 1);
    const depth = clamp(1 - radial, 0, 1);
    const speed = clamp(ndcSpeed / 7.5, 0, 1);
    const intensity = clamp(0.18 + speed * 0.58 + depth * 0.34 + (this.pointerDown ? 0.18 : 0), 0, 1);
    this.pointerGlow += (intensity - this.pointerGlow) * (1 - Math.exp(-delta * 12));
    this.uniforms.gesture.value.set(_pointerLocal.x, _pointerLocal.y, _pointerLocal.z, this.pointerGlow);
    this.uniforms.gestureDepth.value += (depth - this.uniforms.gestureDepth.value) * (1 - Math.exp(-delta * 10));
    this.pointerInside = true;
    // Held drone audio only when the pointer is actively moving over an orb (or
    // on a click). Stationary hover keeps the visual lit spot but the synth
    // gesture is gated off so auraSynth/subSynth/shimmerSynth don't ring
    // forever on idle hover.
    const moving = ndcSpeed > POINTER_GESTURE_MOTION_NDC_PER_SEC || clickQueued;
    this.emitGesture(moving, _pointerLocal, depth, radial, speed);
  }

  private clearPointerVisualState(delta: number): void {
    this.pointerInside = false;
    this.pointerGlow += (0 - this.pointerGlow) * (1 - Math.exp(-delta * 8));
    this.uniforms.gesture.value.w = this.pointerGlow;
    this.uniforms.gestureDepth.value += (0 - this.uniforms.gestureDepth.value) * (1 - Math.exp(-delta * 8));
  }

  private raycastPointer(ndc: THREE.Vector2, camera: THREE.Camera, out: PointerRayHit): boolean {
    _raycaster.setFromCamera(ndc, camera);
    let bestOrb = -1;
    let bestDistance = Infinity;

    for (let i = 0; i < this.orbs.length; i += 1) {
      _pointerIntersections.length = 0;
      _raycaster.intersectObject(this.orbs[i].mesh, false, _pointerIntersections);
      const hit = _pointerIntersections[0];
      if (!hit || hit.distance >= bestDistance) continue;
      bestOrb = i;
      bestDistance = hit.distance;
      _pointerWorld.copy(hit.point);
    }

    if (bestOrb < 0) {
      out.orbIndex = -1;
      out.distance = Infinity;
      return false;
    }

    out.orbIndex = bestOrb;
    out.distance = bestDistance;
    out.worldPoint.copy(_pointerWorld);
    out.localPoint.copy(_pointerWorld);
    this.mesh.worldToLocal(out.localPoint);
    return true;
  }

  private pointerVelocity(ndcSpeed: number, clickQueued: boolean): number {
    const motion = clamp(ndcSpeed / 7.5, 0, 1);
    const contactBoost = clickQueued ? 0.24 : (this.pointerDown ? 0.12 : 0);
    return clamp(0.22 + contactBoost + motion * 0.64, 0.18, 1);
  }

  private firePointerHit(orbIndex: number, velocity: number, worldPoint: THREE.Vector3): boolean {
    const orb = this.orbs[orbIndex];
    if (!orb) return false;
    if (this.elapsed - orb.lastHitAt <= DRUM_RUNTIME.hitCooldown) return false;
    this.dispatchHit(orbIndex, velocity, worldPoint, true);
    return true;
  }

  private dispatchHit(
    orbIndex: number,
    velocity: number,
    worldPosition: THREE.Vector3,
    rippleBurst = false,
    hand?: HandContactPoint['hand'],
    source?: { held?: boolean; sourceId?: string; noteNumber?: number },
  ): void {
    const orb = this.orbs[orbIndex];
    if (!orb) return;
    orb.lastHitAt = this.elapsed;

    _strikePoint.copy(worldPosition);
    this.mesh.worldToLocal(_strikePoint);
    if (rippleBurst) {
      this.addImpactRipples(_strikePoint, velocity);
    } else {
      this.addRippleAt(_strikePoint, velocity);
    }

    if (source?.held && source.sourceId) {
      const existing = this.heldSources.get(source.sourceId);
      if (existing && existing.orbIndex !== orbIndex) this.releaseHeldSource(source.sourceId);
      orb.heldSources.add(source.sourceId);
      this.heldSources.set(source.sourceId, {
        orbIndex,
        frequency: this.frequencyForOrb(orbIndex),
        noteNumber: source.noteNumber,
      });
    }
    this.startOrbEnvelope(orb, velocity);
    const frequency = this.frequencyForOrb(orbIndex);
    const worldStrike = worldPosition.clone();
    if (this.onHitCallback) {
      this.onHitCallback({
        orbIndex,
        frequency,
        velocity,
        worldPosition: worldStrike,
        hand,
        held: !!source?.held,
        sourceId: source?.sourceId,
        noteNumber: source?.noteNumber,
        envelope: this.currentEnvelope(),
      });
    }
    this.emitSparks(worldStrike, velocity);
  }

  private emitGesture(active: boolean, localPoint: THREE.Vector3, depth: number, radius: number, speed: number): void {
    if (!this.onGestureCallback) return;
    const invRadius = 1 / Math.max(this.params.orbRadius, 1e-4);
    this.onGestureCallback({
      active,
      x: clamp(localPoint.x * invRadius, -1, 1),
      y: clamp(localPoint.y * invRadius, -1, 1),
      z: clamp(localPoint.z * invRadius, -1, 1),
      depth: clamp(depth, 0, 1),
      radius: clamp(radius, 0, 1),
      speed: clamp(speed, 0, 1),
      angle: Math.atan2(localPoint.z, localPoint.x),
      intensity: active ? clamp(0.18 + depth * 0.42 + speed * 0.58, 0, 1) : 0,
    });
  }

  private addRippleAt(localPoint: THREE.Vector3, intensity: number): void {
    const slot = this.rippleCursor % MAX_RIPPLES;
    this.rippleSources[slot].set(localPoint.x, localPoint.y, localPoint.z, clamp(intensity, 0.05, 1));
    this.rippleStarts[slot] = this.elapsed;
    this.rippleCursor = (this.rippleCursor + 1) % MAX_RIPPLES;
  }

  private addImpactRipples(localPoint: THREE.Vector3, velocity: number): void {
    this.addRippleAt(localPoint, velocity);
    const extra = velocity > 0.82 ? 2 : (velocity > 0.58 ? 1 : 0);
    for (let i = 0; i < extra; i += 1) {
      const angle = this.elapsed * 7.1 + i * Math.PI * 1.18;
      const spread = this.params.orbRadius * (0.12 + i * 0.08);
      _ripplePoint.copy(localPoint);
      _ripplePoint.x += Math.cos(angle) * spread;
      _ripplePoint.y += Math.sin(angle) * spread * 0.6;
      _ripplePoint.z += Math.sin(angle * 0.7) * spread;
      this.addRippleAt(_ripplePoint, velocity * (0.48 - i * 0.12));
    }
  }

  private frequencyForOrb(orbIndex: number): number {
    const len = this.hzTable.length;
    if (len <= 0) return 0;
    const degree = Math.max(0, Math.floor(orbIndex));
    const pitchClass = degree % len;
    const octaveShift = Math.floor(degree / len);
    return this.hzTable[pitchClass] * Math.pow(2, octaveShift);
  }

  private notifyOrbCount(count = drumOrbCountForBaseRow(this.params.pyramidBaseRow)): void {
    if (count === this.lastReportedOrbCount) return;
    this.lastReportedOrbCount = count;
    this.onOrbCountChange?.(count);
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

      const contactRadius = contact.kind === 'palm' ? DRUM_RUNTIME.palmRadius : DRUM_RUNTIME.fingerRadius;
      const hitRadius = this.params.orbRadius + contactRadius + DRUM_RUNTIME.hitDistance;
      this.collisionBVH.collectPointHits(contact.position, hitRadius, this.currentContactHits);
      this.collisionBVH.collectSweptPointHits(previous, contact.position, hitRadius, this.contactHits);

      for (const orbIndex of this.currentContactHits) {
        this.currentContactKeys.add(this.contactKey(contact.id, orbIndex));
      }

      const fastEnough = speed > DRUM_RUNTIME.hitVelMin;
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

    for (let i = 0; i < this.orbs.length; i += 1) {
      const candidate = this.hitCandidates[i];
      if (!candidate) continue;
      const orb = this.orbs[i];
      if (this.elapsed - orb.lastHitAt <= DRUM_RUNTIME.hitCooldown) continue;
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

    _strikePoint.copy(orb.mesh.position).addScaledVector(_hitDir, this.params.orbRadius);
    this.addRippleAt(_strikePoint, velocity);

    this.startOrbEnvelope(orb, velocity);
    const frequency = this.frequencyForOrb(orbIndex);
    const worldStrike = _strikePoint.clone().add(this.mesh.position);
    if (this.onHitCallback) {
      this.onHitCallback({
        orbIndex,
        frequency,
        velocity,
        worldPosition: worldStrike,
        hand: contact.hand,
        envelope: this.currentEnvelope(),
      });
    }
    this.emitSparks(worldStrike, velocity);
  }

  private emitSparks(worldPosition: THREE.Vector3, velocity: number): void {
    if (!this.sculptor) return;
    const sink = this.sculptor;
    const dir = _sparkDir.copy(sink.center).sub(worldPosition);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0.1, 0);
    dir.normalize();
    sink.emit({
      kind: 'drum',
      origin: worldPosition.clone(),
      direction: dir.clone(),
      color: this.palette === 'local' ? Drum.SPARK_COLOR_LOCAL : Drum.SPARK_COLOR_REMOTE,
      count: Math.round(40 + velocity * 40),
      speed: 0.9 + velocity * 1.4,
    });
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

      // Hit-tint lerp: base orb color shifts toward hitTint while the per-orb
      // pulse decays. So a struck orb visibly glows green and fades back.
      const tintBase = mix(u.baseColor, u.hitTint, perOrb.pulse.mul(u.hitTintAmount).clamp(0, 1)).toVar('orbTintBase');

      const lit = mix(
        tintBase.mul(0.45),
        tintBase,
        smoothstep(float(0), float(1), ndl),
      ).mul(latShade).toVar('lit');

      // Fresnel rim — bright cyan halo at the silhouette.
      const rim = pow(fres, float(2.2)).mul(0.85);
      lit.addAssign(u.rimColor.mul(rim));
      const restGlow = cos(positionLocal.y.mul(6.5).add(positionLocal.x.mul(2.2)).add(perOrb.elapsed.mul(0.65)))
        .mul(0.5).add(0.5);
      lit.addAssign(u.rimColor.mul(float(0.08).add(restGlow.mul(0.045))));

      const gestureDelta = samplePos.sub(u.gesture.xyz);
      const gestureDist = gestureDelta.length().div(u.orbRadius.max(0.001));
      const gestureAura = float(1).sub(smoothstep(float(0.18), float(1.15), gestureDist))
        .mul(u.gesture.w)
        .mul(float(0.52).add(u.gestureDepth.mul(0.72)));
      const gestureFilament = sin(gestureDist.mul(28).sub(perOrb.elapsed.mul(5.2)))
        .mul(0.5).add(0.5)
        .mul(float(1).sub(smoothstep(float(0.05), float(1.25), gestureDist)))
        .mul(u.gesture.w)
        .mul(float(0.18).add(u.gestureDepth.mul(0.36)));
      lit.addAssign(u.rimColor.mul(gestureAura.mul(0.50).add(gestureFilament.mul(0.32))));
      lit.addAssign(u.hotColor.mul(gestureAura.mul(0.38).add(gestureFilament.mul(0.54))));

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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
