import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { JamAudioGraph } from './audioGraph';
import { BackingTrackAnalyzer } from './BackingTrackAnalyzer';
import { attachHandDepthPane } from './handDepth';
import { HandSynthEngine } from './handSynth';
import { HandTracker } from './handTracking';
import { MidiInputController, type MidiNoteEvent, type MidiState } from './midiInput';
import { clamp, hash, lerp } from './math';
import { MultiplayerClient } from './multiplayer';
import { Orb } from './visuals/Orb';
import { PostFX } from './visuals/PostFX';
import { Starlace } from './visuals/Starlace';
import { EnergySculptor } from './EnergySculptor';
import { pickArchetype } from './sculptor/archetypeShared';
import type { HandContactPoint, InstrumentId, InstrumentPerformanceEvent, PlayerVisual } from './instruments';
import { isInstrumentId, normalizeInstrumentId } from './instruments';
import { isCreatureId, type CreatureId } from './creatures';
import { attachMousePosePane, makePlayerPose } from './pose';
import { BroadcastChannelPoseTransport } from './pose/BroadcastChannelPoseTransport';
import { PoseSession } from './pose/PoseSession';
import { WebRtcPoseTransport } from './pose/WebRtcPoseTransport';
import { HumanoidRig } from './rig/HumanoidRig';
import { RobotMotionController, type RobotPerformanceContext } from './robotMotion';
import { ScenerySystem } from './scenery';
import { keyDirector } from './keyDirector';
import { orbLfo } from './orbLfo';
import { hashString } from './seedRandom';
import { fingerJointNames, fingerNames, handednesses, type Handedness, type PlayerPose, type Vec3Data } from './types';
import { WebRTCClient } from './webrtc';
import { makeParams, registerTweaks } from '../hud/tweakDefs';

const CAMERA_DEFS = {
  fov: { default: 62, min: 30, max: 90, step: 1, label: 'fov' },
} as const;

const PLAYERS_DEFS = {
  backOffset: { default: 0.08, min: -0.4, max: 0.8, step: 0.01, label: 'back offset' },
} as const;

const INSTRUMENTS_DEFS = {
  playerOffset: { default: 0.7, min: 0, max: 1.0, step: 0.01, label: 'player offset' },
} as const;

const DEV_DEFS = {
  particlesEnabled: { type: 'boolean' as const, default: true, label: 'particles' },
} as const;

const INSTRUMENT_FX_DEFS = {
  reverbWet:      { default: 0.22, min: 0, max: 1,    step: 0.01, folder: 'reverb', label: 'wet' },
  reverbDecay:    { default: 2.2,  min: 0.1, max: 10, step: 0.1,  folder: 'reverb', label: 'decay (s)' },
  reverbPreDelay: { default: 0.01, min: 0, max: 0.2,  step: 0.005, folder: 'reverb', label: 'pre-delay' },
  delayWet:       { default: 0.18, min: 0, max: 1,    step: 0.01, folder: 'delay', label: 'wet' },
  delayTime:      { default: 0.32, min: 0, max: 1,    step: 0.01, folder: 'delay', label: 'time (s)' },
  delayFeedback:  { default: 0.35, min: 0, max: 0.95, step: 0.01, folder: 'delay', label: 'feedback' },
} as const;

const INSTRUMENT_ANCHOR_Y = 0.98;
// Intro idle-motion scale: how slow characters move while the BeginGate is up.
// Small enough that motion is barely perceptible without being totally frozen.
const INTRO_MOTION_FACTOR = 0.05;
// Exponential time constant (seconds) for the lerp from intro speed to 1.0
// after exitIntroMode. ~3s reaches >95%.
const MOTION_FACTOR_TAU = 1.0;
const ROBOT_JAM_STRUM_MAX_OFFSET = 0.12;
// Sub-beat grid: notes land on eighth-note slots so density=1 is still playable.
const ROBOT_JAM_SLOTS_PER_BEAT = 2;
const ROBOT_JAM_BEATS_PER_BAR = 4;
const ROBOT_JAM_SLOTS_PER_BAR = ROBOT_JAM_SLOTS_PER_BEAT * ROBOT_JAM_BEATS_PER_BAR;
const ROBOT_JAM_PHRASE_BARS = 8;
const ROBOT_JAM_STARLACE_DENSITY_SCALE = 0.92;
const ROBOT_JAM_ORB_LISTEN_GAP = 0.18;
const ROBOT_JAM_STARLACE_LISTEN_GAP = 0.32;
// Cap simultaneous robot voices so phrases can layer without stacking up forever.
const ROBOT_JAM_MAX_CONCURRENT = 6;
// Visual hand target bias for the robot stand-in. The sound still lands on the
// real note target, but the puppet hand is aimed a little closer to the robot
// so the illustrated palm reads as behind the pad instead of punching through it.
const ROBOT_HAND_TARGET_BACKSET = 0.11;
const ROBOT_HAND_TARGET_LOOKAHEAD = 0.62;
// Beat-tracking window: keep last N detected backing-track beats to estimate tempo.
const ROBOT_JAM_BEAT_HISTORY = 8;
// Tempo lock requires median interval variance under this fraction.
const ROBOT_JAM_BEAT_LOCK_TOLERANCE = 0.12;
// Min/max BPM the lock will accept (rejects double/half-time noise).
const ROBOT_JAM_BEAT_BPM_MIN = 60;
const ROBOT_JAM_BEAT_BPM_MAX = 150;
// C-major late-night progressions. Values are diatonic scale degrees, not
// semitones, so they stay aligned with harmony.ts and the backing track.
const ROBOT_JAM_PROGRESSIONS: readonly (readonly RobotJamChord[])[] = [
  [
    { root: 0, tones: [0, 2, 4, 6], colors: [8, 9] },    // Cmaj7/9
    { root: 5, tones: [5, 7, 9, 11], colors: [12] },     // Am7
    { root: 3, tones: [3, 5, 7, 9], colors: [10] },      // Fmaj7
    { root: 4, tones: [4, 6, 8, 10], colors: [11, 13] }, // G7/13
    { root: 0, tones: [0, 2, 4, 6], colors: [8, 11] },
    { root: 2, tones: [2, 4, 6, 8], colors: [9] },       // Em7
    { root: 5, tones: [5, 7, 9, 11], colors: [12] },
    { root: 3, tones: [3, 5, 7, 9], colors: [10, 12] },
  ],
  [
    { root: 0, tones: [0, 2, 4, 6], colors: [9] },
    { root: 4, tones: [4, 6, 8, 10], colors: [11] },
    { root: 5, tones: [5, 7, 9, 11], colors: [12] },
    { root: 2, tones: [2, 4, 6, 8], colors: [9] },       // Em7
    { root: 3, tones: [3, 5, 7, 9], colors: [10] },
    { root: 0, tones: [0, 2, 4, 6], colors: [8] },
    { root: 1, tones: [1, 3, 5, 7], colors: [8, 10] },   // Dm7/9
    { root: 4, tones: [4, 6, 8, 10], colors: [11, 13] },
  ],
  [
    { root: 0, tones: [0, 2, 4, 6], colors: [8, 9] },
    { root: 5, tones: [5, 7, 9, 11], colors: [12] },
    { root: 1, tones: [1, 3, 5, 7], colors: [8] },
    { root: 4, tones: [4, 6, 8, 10], colors: [11] },
    { root: 0, tones: [0, 2, 4, 6], colors: [9] },
    { root: 5, tones: [5, 7, 9, 11], colors: [12] },
    { root: 3, tones: [3, 5, 7, 9], colors: [10, 12] },
    { root: 4, tones: [4, 6, 8, 10], colors: [11, 13] },
  ],
];
const ROBOT_JAM_STARLACE_MOTIFS: readonly (readonly number[])[] = [
  [4, 6, 4, 2, 0, 2],
  [6, 5, 4, 2, 4, 1],
  [2, 4, 6, 9, 7, 4],
  [9, 7, 6, 4, 2, 4],
];

const INTRO_SCENE_DEFS = {
  opacity:    { default: 0.7, min: 0.08, max: 0.80, step: 0.01, label: 'opacity' },
  brightness: { default: 0.7, min: 0.08, max: 0.90, step: 0.01, label: 'brightness' },
  saturation: { default: 0.22, min: 0.20, max: 1.20, step: 0.01, label: 'saturation' },
} as const;

const CABIN_DEFS = {
  bevelRadius:    { default: 0.04, min: 0, max: 0.12, step: 0.005, label: 'bevel radius' },
  furnitureBevel: { default: 0.10, min: 0, max: 0.18, step: 0.005, label: 'furniture bevel' },
  bevelSegments:  { default: 4,    min: 1, max: 8,    step: 1,     label: 'bevel smoothness' },
} as const;

const CABIN_LIGHTING_DEFS = {
  nightBlend:       { default: 0.74, min: 0, max: 2,    step: 0.01, label: 'lamp dim' },
  driftRate:        { default: 0.07, min: 0, max: 0.5,  step: 0.01, label: 'drift rate' },
  flickerRate:      { default: .5, min: 0, max: 2,    step: 0.05, label: 'flicker rate' },
  flickerAmplitude: { default: 0.40, min: 0, max: 0.65, step: 0.01, label: 'lamp amp' },
  flutter:          { default: 0.07, min: 0, max: 0.25, step: 0.01, label: 'flutter' },
} as const;

const ILLUSTRATED_CABIN_TEXTURES = [
  '/cabin/illustrated-cabin-plate-v2-color.webp',
  '/cabin/illustrated-cabin-plate-v2-medium.webp',
  '/cabin/illustrated-cabin-plate-v2-dark.webp',
] as const;
const ILLUSTRATED_CABIN_MASK_TEXTURE = '/cabin/illustrated-cabin-plate-v2-alpha.webp';
const ILLUSTRATED_CABIN_ASPECT = 1672 / 941;
const ILLUSTRATED_CABIN_DISTANCE = 3.35;
const ILLUSTRATED_CABIN_OVERSCAN = 1.015;

type GameUi = {
  connectionStatus: HTMLElement;
  inputStatus: HTMLElement;
};

export type CameraMode = 'game' | 'orbit';
type PlayerSlot = 'local' | 'remote';
type RobotJamNote = {
  instrument: InstrumentId;
  noteNumber: number;
  sourceId: string;
  releaseAt: number;
};
type RobotJamPendingNote = RobotJamNote & {
  startAt: number;
  velocity: number;
  seed: number;
};
type RobotJamChord = {
  root: number;
  tones: readonly number[];
  colors: readonly number[];
};
type RobotJamEvent = {
  degrees: readonly number[];
  holdBeats: number;
  velocity: number;
  strumBeats: number;
  chance: number;
};
type RobotJamHumanMode = 'active' | 'leading' | 'silent';
type RobotJamHumanState = {
  sinceLastNote: number;
  mode: RobotJamHumanMode;
  /** Density multiplier: pad-only when active, full when silent. */
  densityScale: number;
};
type CabinPlateLayer = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  material: THREE.MeshBasicMaterial;
  texture: THREE.Texture;
};

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function makeHandContactPoints(): HandContactPoint[] {
  const contacts: HandContactPoint[] = [];
  for (const hand of handednesses) {
    contacts.push({
      id: `${hand}:palm`,
      hand,
      kind: 'palm',
      position: new THREE.Vector3(),
    });
    for (const finger of fingerNames) {
      for (const joint of fingerJointNames) {
        contacts.push({
          id: `${hand}:${finger}:${joint}`,
          hand,
          kind: 'finger',
          finger,
          joint,
          position: new THREE.Vector3(),
        });
      }
    }
  }
  return contacts;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseNetworkPerformanceEvent(json: string): InstrumentPerformanceEvent | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!isObject(value)) return null;
    if (value.type === 'orb-hit' && value.instrument === 'orb') {
      const orbIndex = finiteNumber(value.orbIndex);
      const velocity = finiteNumber(value.velocity);
      if (orbIndex === undefined || velocity === undefined) return null;
      let worldPosition: Vec3Data | undefined;
      if (isObject(value.worldPosition)) {
        const x = finiteNumber(value.worldPosition.x);
        const y = finiteNumber(value.worldPosition.y);
        const z = finiteNumber(value.worldPosition.z);
        if (x !== undefined && y !== undefined && z !== undefined) worldPosition = { x, y, z };
      }
      return {
        type: 'orb-hit',
        instrument: 'orb',
        orbIndex,
        velocity,
        held: value.held === true,
        sourceId: typeof value.sourceId === 'string' ? value.sourceId : undefined,
        noteNumber: finiteNumber(value.noteNumber),
        worldPosition,
      };
    }
    if (value.type === 'orb-release' && value.instrument === 'orb' && typeof value.sourceId === 'string') {
      return {
        type: 'orb-release',
        instrument: 'orb',
        sourceId: value.sourceId,
      };
    }
    if (value.type === 'starlace-pluck' && value.instrument === 'starlace') {
      const nodeIndex = finiteNumber(value.nodeIndex);
      const velocity = finiteNumber(value.velocity);
      if (nodeIndex === undefined || velocity === undefined) return null;
      const rawNodeIndices = Array.isArray(value.nodeIndices)
        ? value.nodeIndices.map(finiteNumber).filter((n): n is number => n !== undefined)
        : undefined;
      const chordSize = value.chordSize === 1 || value.chordSize === 2 || value.chordSize === 3
        ? value.chordSize
        : undefined;
      return {
        type: 'starlace-pluck',
        instrument: 'starlace',
        nodeIndex,
        nodeIndices: rawNodeIndices,
        velocity,
        hand: value.hand === 'left' || value.hand === 'right' ? value.hand : undefined,
        chordRootIndex: finiteNumber(value.chordRootIndex),
        chordSize,
        phraseStep: finiteNumber(value.phraseStep),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export class Game {
  private renderer: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.05, 90);
  private orbitControls?: OrbitControls;
  private cameraMode: CameraMode = 'game';
  private readonly gameCameraPosition = new THREE.Vector3(1.66, 1.34, 0.02);
  private readonly gameCameraTarget = new THREE.Vector3(-0.12, 1.06, 0);
  private readonly _cabinPlateForward = new THREE.Vector3();
  private readonly cameraParams = makeParams(CAMERA_DEFS);
  private cameraTweaks?: ReturnType<typeof registerTweaks<typeof CAMERA_DEFS>>;
  private readonly sculptureTarget = new THREE.Vector3(0, 1.08, 0);
  private startedAt = performance.now();
  private lastFrameAt = this.startedAt;
  readonly handTracker: HandTracker;
  private audioGraph: JamAudioGraph;
  private handSynth: HandSynthEngine;
  private midiInput: MidiInputController;
  readonly multiplayer: MultiplayerClient;
  private webrtc: WebRTCClient;
  private poseSession!: PoseSession;
  private broadcastTransport!: BroadcastChannelPoseTransport;
  private remoteStreamListeners = new Set<(stream: MediaStream | null) => void>();
  private localOrbCountListeners = new Set<(count: number) => void>();
  private localOrbCount = 0;
  private localRig: HumanoidRig;
  private remoteRig: HumanoidRig;
  private robotMotion: RobotMotionController;
  private scenery: ScenerySystem;
  private playerVisuals: Record<PlayerSlot, PlayerVisual | null> = { local: null, remote: null };
  private playerVisualCache: Record<PlayerSlot, Partial<Record<InstrumentId, PlayerVisual>>> = {
    local: {},
    remote: {},
  };
  private playerInstruments: Record<PlayerSlot, InstrumentId> = { local: 'orb', remote: 'starlace' };
  private playerCreatures: Record<PlayerSlot, CreatureId> = { local: 'lion', remote: 'robot' };
  private sculptor?: EnergySculptor;
  private postFX?: PostFX;
  private devTweaks?: ReturnType<typeof registerTweaks<typeof DEV_DEFS>>;
  private readonly devParams = makeParams(DEV_DEFS);
  private backingTrackAnalyzer = new BackingTrackAnalyzer();
  private lastOrbHitAt = -10;
  private lastStarlacePluckAt = -10;
  private lastSynchronyAt = -10;
  private lastHumanNoteAt = -Infinity;
  // Backing-track beat timestamps (elapsed seconds) — drives tempo lock.
  private detectedBeatTimes: number[] = [];
  // When tempo locks, this is the elapsed time of an anchor beat that pins
  // slot 0; null until enough stable beats arrive.
  private lockedTempoBpm: number | null = null;
  private lockedPhaseAnchor = 0;
  // Phrase generator state — when robot launches a multi-slot melodic line,
  // we remember the slot it ends on so we don't double-trigger.
  private robotJamPhraseEndsAtSlot = -1;
  private visualContacts: Record<PlayerSlot, HandContactPoint[]> = {
    local: makeHandContactPoints(),
    remote: makeHandContactPoints(),
  };
  private activeVisualContacts: Record<PlayerSlot, HandContactPoint[]> = {
    local: [],
    remote: [],
  };
  // While `introActive` is true the instruments stay hidden and the scenery
  // bird system is held off — the world reads as a still tableau the user is
  // about to step into. exitIntroMode() flips this and runs the per-player
  // intro animations.
  private introActive = true;
  // Idle-motion clock scale. During intro the robot/player visuals tick at
  // ~5% speed so the scene reads as a near-still tableau; on exitIntroMode
  // this lerps toward 1.0 over a few seconds, "waking" the characters into
  // their default float/movement speed.
  private motionFactor = INTRO_MOTION_FACTOR;
  private motionFactorTarget = INTRO_MOTION_FACTOR;
  private motionElapsed = 0;
  private swapsInFlight: Record<PlayerSlot, number> = { local: 0, remote: 0 };
  private cabinTweaks?: ReturnType<typeof registerTweaks<typeof CABIN_DEFS>>;
  private cabinLightingTweaks?: ReturnType<typeof registerTweaks<typeof CABIN_LIGHTING_DEFS>>;
  private cabinGroup?: THREE.Group;
  private cabinPlate?: THREE.Group;
  private cabinPlateLayers: CabinPlateLayer[] = [];
  private cabinPlateMaskTexture?: THREE.Texture;
  private readonly cabinParams = makeParams(CABIN_DEFS);
  private readonly cabinLightingParams = makeParams(CABIN_LIGHTING_DEFS);
  private cabinLightingBlend: number = CABIN_LIGHTING_DEFS.nightBlend.default;
  private introSceneTweaks?: ReturnType<typeof registerTweaks<typeof INTRO_SCENE_DEFS>>;
  private readonly introSceneParams = makeParams(INTRO_SCENE_DEFS);
  private playersTweaks?: ReturnType<typeof registerTweaks<typeof PLAYERS_DEFS>>;
  private readonly playersParams = makeParams(PLAYERS_DEFS);
  private instrumentsTweaks?: ReturnType<typeof registerTweaks<typeof INSTRUMENTS_DEFS>>;
  private readonly instrumentsParams = makeParams(INSTRUMENTS_DEFS);
  private instrumentFxTweaks?: ReturnType<typeof registerTweaks<typeof INSTRUMENT_FX_DEFS>>;
  private readonly instrumentFxParams = makeParams(INSTRUMENT_FX_DEFS);
  readonly paneDock: HTMLElement;
  private roomId: string;
  private roomSeed: number;
  private localPose?: PlayerPose;
  private remotePose?: PlayerPose;
  private partnerPresent = false;
  private robotJamMuted = false;
  private robotJamNextAt = 0;
  private robotJamStep = -1;
  private robotJamActive: RobotJamNote[] = [];
  private robotJamPending: RobotJamPendingNote[] = [];
  private readonly localLeftPalm = new THREE.Vector3();
  private readonly localRightPalm = new THREE.Vector3();
  private readonly remoteLeftPalm = new THREE.Vector3();
  private readonly remoteRightPalm = new THREE.Vector3();
  private readonly robotInstrumentTargets: Record<Handedness, Vec3Data[]> = { left: [], right: [] };
  private readonly robotJamStrikeTarget: Vec3Data = { x: 0, y: 0, z: 0 };
  private readonly robotFocusedWorldTargets: THREE.Vector3[] = [];
  private readonly robotFocusedWorldTargetIndices: number[] = [];
  private readonly robotTargetWorldScratch = new THREE.Vector3();
  private hiddenStartedAt: number | null = null;
  private frameRenderListeners = new Set<() => void>();
  constructor(
    private canvas: HTMLCanvasElement,
    urlRoom: string,
    private ui: GameUi
  ) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(1)
    this.paneDock = this.createPaneDock();
    this.setupIntroScenePane();
    this.setupCabinLightingPane();
    this.handTracker = new HandTracker(ui.inputStatus);
    this.audioGraph = new JamAudioGraph();
    this.handSynth = new HandSynthEngine(this.audioGraph, canvas);
    this.midiInput = new MidiInputController({
      onNoteOn: note => this.handleMidiNoteOn(note),
      onNoteOff: note => this.handleMidiNoteOff(note),
    });
    this.handTracker.setPointerInputEnabled(false);
    this.handSynth.setMouseInputEnabled(false);
    this.multiplayer = new MultiplayerClient(urlRoom, 'Player');
    // MultiplayerClient already rolled a random local instrument in its ctor.
    // Sync now so installPlayerVisuals() (in start()) builds the correct one
    // — otherwise the listeners registered in main.ts replay the MP-chosen
    // values and swap the visuals before the user does anything.
    this.playerInstruments.local = normalizeInstrumentId(this.multiplayer.getLocalInstrument());
    this.playerInstruments.remote = normalizeInstrumentId(this.multiplayer.getPartnerInstrument());
    this.playerCreatures.local = this.normalizeCreature(this.multiplayer.getLocalCreature(), 'lion');
    this.playerCreatures.remote = this.normalizeCreature(this.multiplayer.getPartnerCreature(), 'robot');
    this.roomId = this.multiplayer.getRoom();
    this.roomSeed = hashString(this.roomId);
    keyDirector.setRoomSeed(this.roomSeed);
    keyDirector.attachPane(this.paneDock);
    this.multiplayer.onStateChange(state => {
      ui.connectionStatus.textContent = state;
    });
    this.multiplayer.onAssignedRoom(room => {
      this.roomSeed = hashString(room);
      this.scenery.setRoomSeed(this.roomSeed);
      keyDirector.setRoomSeed(this.roomSeed);
    });
    this.multiplayer.onPartnerIdentity(identity => {
      this.partnerPresent = identity !== null;
      this.applyRobotMute();
    });

    this.webrtc = new WebRTCClient(
      this.multiplayer,
      () => this.handTracker.getStream(),
      () => this.handTracker.getMicStream(),
    );
    this.webrtc.onRemoteStream(stream => {
      for (const listener of this.remoteStreamListeners) listener(stream);
    });
    this.webrtc.onRemotePerformanceEvent(eventJson => this.applyRemotePerformanceEvent(eventJson));

    this.broadcastTransport = new BroadcastChannelPoseTransport(this.roomId);
    const webrtcTransport = new WebRtcPoseTransport(this.webrtc);
    this.poseSession = new PoseSession(
      [webrtcTransport, this.broadcastTransport],
      {
        getLocalId: () => this.multiplayer.localId,
        getRoomId: () => this.multiplayer.getRoom(),
        getPartnerSeatIndex: () => this.multiplayer.partnerSeatIndex,
      }
    );

    this.multiplayer.onAssignedRoom(room => {
      this.broadcastTransport.setRoomId(room);
      this.poseSession.clearRemotePose();
    });
    this.multiplayer.onPartnerIdentity(() => this.poseSession.clearRemotePose());

    this.localRig = new HumanoidRig(this.scene, { seatIndex: 0, creature: this.playerCreatures.local });
    this.remoteRig = new HumanoidRig(this.scene, { seatIndex: 1, creature: this.playerCreatures.remote });
    this.localRig.setFingertipNodesVisible(false);
    this.remoteRig.setFingertipNodesVisible(false);
    this.applyPlayerBackOffset();
    this.multiplayer.onSeatChange((localSeat, partnerSeat) => {
      this.localRig.setSeatIndex(localSeat);
      this.remoteRig.setSeatIndex(partnerSeat);
      this.applyPlayerBackOffset();
      this.updatePlayerVisualAnchors();
    });
    this.robotMotion = new RobotMotionController(this.paneDock);
    this.scenery = new ScenerySystem(this.scene, this.paneDock, {
      roomSeed: this.roomSeed,
    });
  }

  async start(): Promise<void> {
    this.setupRenderer();
    this.setupCamera();
    this.createCabin();
    await this.renderer.init();
    this.setupOrbitControls();
    this.setupDevPane();
    this.postFX = new PostFX(this.renderer, this.scene, this.camera);
    this.postFX.attachPane(this.paneDock);
    this.installPlayerVisuals();
    await this.prewarmPlayerVisuals();
    this.refreshArchetype();
    this.setupPlayersPane();
    this.setupInstrumentsPane();
    this.setupInstrumentFxPane();
    this.handTracker.attachPane(this.paneDock);
    attachHandDepthPane(this.paneDock);
    attachMousePosePane(this.paneDock);
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('blur', this.handleVisibilityChange);
    window.addEventListener('focus', this.handleVisibilityChange);
    this.resize();
    this.renderer.setAnimationLoop(() => this.update());
  }

  // Suspends the shared Tone audio context whenever the tab is hidden or the
  // window loses focus, so switching to another app silences the bed, orb,
  // and synth — otherwise the camera keeps tracking and a hand near the face
  // (e.g. while thinking in an editor) starts playing notes. Releases held
  // synth voices first so the user doesn't return to a stuck note.
  private handleVisibilityChange = (): void => {
    const hidden = document.hidden;
    const inactive = hidden || !document.hasFocus();
    const now = performance.now();
    if (hidden) {
      this.hiddenStartedAt ??= now;
    } else if (this.hiddenStartedAt !== null) {
      this.sculptor?.advanceLifecycle((now - this.hiddenStartedAt) / 1000);
      this.hiddenStartedAt = null;
      this.lastFrameAt = now;
    }

    if (inactive) {
      this.handSynth.silenceAll();
    }
    void this.audioGraph.setSuspended(inactive);
  };

  async startCamera(): Promise<void> {
    await this.handTracker.startCamera();
    this.webrtc.notifyLocalStreamReady();
  }

  async startAudio(): Promise<void> {
    await this.audioGraph.start();
    await this.handSynth.start();
  }

  attachBackingTrack(audio: HTMLAudioElement): void {
    this.backingTrackAnalyzer.attach(audio);
    this.backingTrackAnalyzer.attachPane(this.paneDock, this.sculptor);
  }

  private setupDevPane(): void {
    if (this.devTweaks) return;
    this.devTweaks = registerTweaks(this.paneDock, 'dev', DEV_DEFS, {
      title: 'Dev',
      expanded: true,
      params: this.devParams,
      onChange: {
        particlesEnabled: enabled => this.applyParticlesEnabled(enabled),
      },
    });
  }

  private applyParticlesEnabled(enabled: boolean): void {
    if (enabled) {
      if (this.sculptor) return;
      const sculptor = new EnergySculptor(this.scene, this.sculptureTarget, this.renderer, this.paneDock);
      this.sculptor = sculptor;
      for (const slot of ['local', 'remote'] as const) {
        for (const cached of Object.values(this.playerVisualCache[slot])) {
          cached?.setSculptor?.(sculptor);
        }
      }
      this.backingTrackAnalyzer.setSculptor(sculptor);
      this.refreshArchetype();
    } else {
      const sculptor = this.sculptor;
      if (!sculptor) return;
      for (const slot of ['local', 'remote'] as const) {
        for (const cached of Object.values(this.playerVisualCache[slot])) {
          cached?.setSculptor?.(undefined);
        }
      }
      this.backingTrackAnalyzer.setSculptor(undefined);
      this.sculptor = undefined;
      sculptor.dispose();
    }
  }

  async enableMidi(): Promise<void> {
    await this.midiInput.enable();
  }

  getMidiState(): MidiState {
    return this.midiInput.getState();
  }

  onMidiStateChange(listener: (state: MidiState) => void): () => void {
    return this.midiInput.onStateChange(listener);
  }

  connectMultiplayer(): void {
    this.multiplayer.connect();
  }

  waitForInitialMultiplayerSync(): Promise<void> {
    return this.multiplayer.waitForInitialSync();
  }

  whenNextFrameRendered(): Promise<void> {
    return new Promise(resolve => {
      this.frameRenderListeners.add(resolve);
    });
  }

  setRoom(roomId: string): void {
    this.roomId = roomId;
    this.multiplayer.requestRoom(roomId);
  }

  getRoom(): string {
    return this.roomId;
  }

  onAssignedRoom(listener: (roomId: string) => void): void {
    this.multiplayer.onAssignedRoom(roomId => {
      this.roomId = roomId;
      listener(roomId);
    });
  }

  onPlayerJoined(listener: (player: { id: string; displayName: string }) => void): void {
    this.multiplayer.onPlayerJoined(listener);
  }

  onPlayerLeft(listener: (player: { id: string; displayName: string }) => void): void {
    this.multiplayer.onPlayerLeft(listener);
  }

  onPartnerChange(listener: (name: string | null) => void): void {
    this.multiplayer.onPartnerChange(listener);
  }

  onSeatChange(listener: (localSeat: number, partnerSeat: number) => void): void {
    this.multiplayer.onSeatChange(listener);
  }

  onRemoteStream(listener: (stream: MediaStream | null) => void): void {
    this.remoteStreamListeners.add(listener);
  }

  onLocalOrbCountChange(listener: (count: number) => void): void {
    this.localOrbCountListeners.add(listener);
    if (this.localOrbCount > 0) listener(this.localOrbCount);
  }

  // Arms / disarms the push-to-talk mic. Acquiring the stream the first time
  // is what triggers the peer-connection renegotiation so the partner can
  // hear us; whether tracks are actively transmitting is then governed by
  // setMicTransmitting (typically wired to a held key).
  async setMicEnabled(enabled: boolean): Promise<void> {
    const hadMic = !!this.handTracker.getMicStream();
    await this.handTracker.setMicArmed(enabled);
    if (enabled && !hadMic && this.handTracker.getMicStream()) {
      this.webrtc.notifyMicReady();
    }
  }

  setMicTransmitting(transmitting: boolean): void {
    this.handTracker.setMicTransmitting(transmitting);
  }

  setCameraEnabled(enabled: boolean): void {
    this.handTracker.setVideoEnabled(enabled);
  }

  setShareVideoEnabled(enabled: boolean): void {
    this.webrtc.setShareVideo(enabled);
  }

  getMicEnabled(): boolean {
    return this.handTracker.getMicArmed();
  }

  getCameraEnabled(): boolean {
    return this.handTracker.getVideoEnabled();
  }

  getShareVideoEnabled(): boolean {
    return this.webrtc.getShareVideo();
  }

  // Player synth (Aurora Loom).
  setMusicVolume(value: number): void {
    this.handSynth.setMasterGain(value);
  }

  setStarlaceVolume(value: number): void {
    this.handSynth.setStarlaceGain(value);
  }

  setOrbVolume(value: number): void {
    this.handSynth.setOrbGain(value);
  }

  // Mute the procedural robot fill-in's hand-played voice. Has no effect
  // when a real partner is present — only the robot stand-in is gated.
  setRobotJamMuted(muted: boolean): void {
    this.robotJamMuted = muted;
    this.applyRobotMute();
  }

  isRobotJamMuted(): boolean {
    return this.robotJamMuted;
  }

  private applyRobotMute(): void {
    const robotActive = !this.partnerPresent;
    this.handSynth.setRobotPartnerActive(robotActive);
    this.handSynth.setMuted('remote', robotActive && this.robotJamMuted);
  }

  private sendLocalPerformanceEvent(event: InstrumentPerformanceEvent): void {
    if (!this.partnerPresent) return;
    this.webrtc.sendPerformanceEvent(JSON.stringify(event));
  }

  private applyRemotePerformanceEvent(eventJson: string): void {
    if (!this.partnerPresent) return;
    const event = parseNetworkPerformanceEvent(eventJson);
    if (!event) return;
    if (event.instrument !== this.playerInstruments.remote) return;
    this.playerVisuals.remote?.applyPerformanceEvent?.(event);
  }

  setDisplayName(name: string): void {
    this.multiplayer.setDisplayName(name);
  }

  getCameraMode(): CameraMode {
    return this.cameraMode;
  }

  setDebugVisible(visible: boolean): void {
    this.sculptor?.setDebugVisible(visible);
  }

  getAliveParticleCount(): number {
    return this.sculptor?.getAliveParticleCount() ?? 0;
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    if (this.orbitControls) {
      this.orbitControls.enabled = mode === 'orbit';
      this.orbitControls.target.copy(this.sculptureTarget);
    }

    if (mode === 'game') {
      this.lockGameCamera();
      return;
    }

    this.camera.position.set(2.25, 1.8, 2.45);
    this.camera.lookAt(this.sculptureTarget);
    this.orbitControls?.update();
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('blur', this.handleVisibilityChange);
    window.removeEventListener('focus', this.handleVisibilityChange);
    this.handTracker.dispose();
    this.multiplayer.dispose();
    this.poseSession.dispose();
    this.webrtc.dispose();
    this.robotMotion.dispose();
    this.scenery.dispose();
    this.sculptor?.dispose();
    this.postFX?.dispose();
    this.devTweaks?.dispose();
    this.backingTrackAnalyzer.dispose();
    this.disposePlayerVisuals();
    this.midiInput.dispose();
    this.handSynth.dispose();
    this.audioGraph.dispose();
    this.cameraTweaks?.dispose();
    this.cabinTweaks?.dispose();
    this.cabinLightingTweaks?.dispose();
    this.introSceneTweaks?.dispose();
    this.playersTweaks?.dispose();
    this.instrumentsTweaks?.dispose();
    this.instrumentFxTweaks?.dispose();
    this.disposeCabinPlate();
    this.paneDock.remove();
    this.renderer.dispose();
  }

  private setupRenderer(): void {
    this.renderer.setClearColor(0x050403, 1);
    this.scene.background = new THREE.Color(0x050403);
    this.scene.fog = new THREE.Fog(0x070503, 6.5, 20);
  }

  private setupCamera(): void {
    this.lockGameCamera();
    this.setupCameraPane();
  }

  private setupOrbitControls(): void {
    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.enabled = false;
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.minDistance = 0.1;
    this.orbitControls.maxDistance = 5.2;
    this.orbitControls.minPolarAngle = Math.PI * 0.18;
    this.orbitControls.maxPolarAngle = Math.PI * 0.48;
    this.orbitControls.target.copy(this.sculptureTarget);
  }

  private lockGameCamera(): void {
    this.camera.fov = this.cameraParams.fov;
    this.camera.position.copy(this.gameCameraPosition);
    this.camera.lookAt(this.gameCameraTarget);
    this.camera.updateProjectionMatrix();
    this.updateCabinPlateTransform();
  }

  private setupCameraPane(): void {
    if (this.cameraTweaks) return;
    this.cameraTweaks = registerTweaks(this.paneDock, 'camera', CAMERA_DEFS, {
      title: 'Camera',
      params: this.cameraParams,
      onChange: {
        fov: () => this.lockGameCamera(),
      },
    });
  }

  private setupIntroScenePane(): void {
    if (this.introSceneTweaks) return;
    this.introSceneTweaks = registerTweaks(this.paneDock, 'introScene', INTRO_SCENE_DEFS, {
      title: 'Intro Scene',
      expanded: true,
      params: this.introSceneParams,
      onChange: {
        opacity:    () => this.applyIntroSceneTweaks(),
        brightness: () => this.applyIntroSceneTweaks(),
        saturation: () => this.applyIntroSceneTweaks(),
      },
    });
    this.applyIntroSceneTweaks();
  }

  private applyIntroSceneTweaks(): void {
    const root = document.documentElement;
    root.style.setProperty('--intro-scene-opacity', String(this.introSceneParams.opacity));
    root.style.setProperty('--intro-scene-brightness', String(this.introSceneParams.brightness));
    root.style.setProperty('--intro-scene-saturation', String(this.introSceneParams.saturation));
  }

  private createCabin(): void {
    this.scenery.build();
    this.buildIllustratedCabinPlate();
  }

  private buildIllustratedCabinPlate(): void {
    this.disposeCabinPlate();
    const loader = new THREE.TextureLoader();
    const textures = ILLUSTRATED_CABIN_TEXTURES.map(url => {
      const texture = loader.load(url, tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      return texture;
    });

    const maskTexture = loader.load(ILLUSTRATED_CABIN_MASK_TEXTURE, tex => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
    });
    maskTexture.colorSpace = THREE.NoColorSpace;
    maskTexture.generateMipmaps = true;
    this.cabinPlateMaskTexture = maskTexture;

    const group = new THREE.Group();
    group.name = 'illustrated-cabin-plate';
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.cabinPlateLayers = textures.map((texture, index) => {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        alphaMap: maskTexture,
        transparent: true,
        opacity: index === 0 ? 1 : 0,
        alphaTest: 0.5,
        blending: index === 0 ? THREE.NoBlending : THREE.NormalBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `illustrated-cabin-plate-${index === 0 ? 'light' : index === 1 ? 'medium' : 'dark'}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = -6 + index;
      group.add(mesh);
      return { mesh, material, texture };
    });
    this.cabinPlate = group;
    this.scene.add(group);
    this.updateCabinPlateTransform();
    this.updateCabinLighting(0, true);
  }

  private updateCabinPlateTransform(): void {
    if (!this.cabinPlate) return;
    const fovRadians = THREE.MathUtils.degToRad(this.camera.fov);
    const viewHeight = 2 * Math.tan(fovRadians * 0.5) * ILLUSTRATED_CABIN_DISTANCE;
    const viewWidth = viewHeight * this.camera.aspect;
    let width = viewWidth;
    let height = width / ILLUSTRATED_CABIN_ASPECT;
    if (height < viewHeight) {
      height = viewHeight;
      width = height * ILLUSTRATED_CABIN_ASPECT;
    }
    this.cabinPlate.scale.set(width * ILLUSTRATED_CABIN_OVERSCAN, height * ILLUSTRATED_CABIN_OVERSCAN, 1);
    this.camera.getWorldDirection(this._cabinPlateForward);
    this.cabinPlate.position
      .copy(this.camera.position)
      .addScaledVector(this._cabinPlateForward, ILLUSTRATED_CABIN_DISTANCE);
    this.cabinPlate.quaternion.copy(this.camera.quaternion);
  }

  private disposeCabinPlate(): void {
    if (!this.cabinPlate) return;
    this.scene.remove(this.cabinPlate);
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    for (const layer of this.cabinPlateLayers) {
      if (!disposedGeometries.has(layer.mesh.geometry)) {
        layer.mesh.geometry.dispose();
        disposedGeometries.add(layer.mesh.geometry);
      }
      layer.material.dispose();
      layer.texture.dispose();
    }
    this.cabinPlateMaskTexture?.dispose();
    this.cabinPlate = undefined;
    this.cabinPlateLayers = [];
    this.cabinPlateMaskTexture = undefined;
  }

  private buildCabinGeometry(): void {
    if (this.cabinGroup) {
      this.cabinGroup.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach(x => x.dispose());
          else mat.dispose();
        }
      });
      this.scene.remove(this.cabinGroup);
    }
    const group = new THREE.Group();
    group.name = 'cabin-shell';

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1b1009, roughness: 0.82, metalness: 0.04 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x100c0a, roughness: 0.88, metalness: 0.05 });
    const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x0d0907, roughness: 0.96, metalness: 0.02 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xa16e2c, roughness: 0.45, metalness: 0.42 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x060504, roughness: 0.82, metalness: 0.08 });
    const frameLipMat = new THREE.MeshStandardMaterial({ color: 0xd09a3f, roughness: 0.36, metalness: 0.52 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x603419, roughness: 0.56, metalness: 0.12 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x2b1713, roughness: 0.72, metalness: 0.04 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xffd49a,
      transparent: true,
      opacity: 0.12,
      roughness: 0.62,
      metalness: 0,
      depthWrite: false,
    });

    const wallR = this.cabinParams.bevelRadius;
    const seatR = this.cabinParams.furnitureBevel;

    const cabinZ = 10.4;
    const boothCenters = [-3.72, 0, 3.72];

    const floor = new THREE.Mesh(this.roundedBox(3.4, 0.08, cabinZ, wallR), floorMat);
    floor.position.y = 0.02;
    group.add(floor);

    const ceilingY = 2.55;
    const ceiling = new THREE.Mesh(this.roundedBox(3.45, 0.08, cabinZ, wallR), ceilingMat);
    ceiling.position.y = ceilingY;
    group.add(ceiling);

    const glassBottom = 0.12;
    const glassTop = 2.44;
    const glassHeight = glassTop - glassBottom;
    const glassY = (glassBottom + glassTop) / 2;
    const glassSpan = 9.34;
    const frameThick = 0.11;
    const brassLip = 0.018;
    const frameOuterSpan = glassSpan + frameThick * 2;

    const ceilingBottom = ceilingY - 0.04;
    const lowerWallHeight = glassBottom - 0.06;
    const upperWallHeight = ceilingBottom - glassTop;
    const endCapHeight = ceilingBottom - 0.06;
    const endCapDepth = cabinZ / 2 - glassSpan / 2;

    for (const x of [-1.72]) {
      const lowerWall = new THREE.Mesh(this.roundedBox(0.08, lowerWallHeight, cabinZ, wallR), wallMat);
      lowerWall.position.set(x, 0.06 + lowerWallHeight / 2, 0);
      group.add(lowerWall);

      const upperWall = new THREE.Mesh(this.roundedBox(0.08, upperWallHeight, cabinZ, wallR), wallMat);
      upperWall.position.set(x, glassTop + upperWallHeight / 2, 0);
      group.add(upperWall);

      for (const zSign of [-1, 1]) {
        const endCap = new THREE.Mesh(this.roundedBox(0.08, endCapHeight, endCapDepth, wallR), wallMat);
        endCap.position.set(x, 0.06 + endCapHeight / 2, zSign * (glassSpan / 2 + endCapDepth / 2));
        group.add(endCap);
      }

      const frameX = x * 1.012;

      const topRail = new THREE.Mesh(this.roundedBox(frameThick, frameThick, frameOuterSpan, wallR), frameMat);
      topRail.position.set(frameX, glassTop + frameThick / 2, 0);
      group.add(topRail);

      const bottomRail = new THREE.Mesh(this.roundedBox(frameThick, frameThick, frameOuterSpan, wallR), frameMat);
      bottomRail.position.set(frameX, glassBottom - frameThick / 2, 0);
      group.add(bottomRail);

      for (const z of [-glassSpan / 2 - frameThick / 2, glassSpan / 2 + frameThick / 2]) {
        const endPost = new THREE.Mesh(this.roundedBox(frameThick, glassHeight, frameThick, wallR), frameMat);
        endPost.position.set(frameX, glassY, z);
        group.add(endPost);
      }

      const topLip = new THREE.Mesh(this.roundedBox(brassLip, brassLip, glassSpan, brassLip * 0.5), frameLipMat);
      topLip.position.set(frameX - 0.004, glassTop - brassLip * 0.6, 0);
      group.add(topLip);

      const bottomLip = new THREE.Mesh(this.roundedBox(brassLip, brassLip, glassSpan, brassLip * 0.5), frameLipMat);
      bottomLip.position.set(frameX - 0.004, glassBottom + brassLip * 0.6, 0);
      group.add(bottomLip);

      for (const z of [-glassSpan / 2, glassSpan / 2]) {
        const sideLip = new THREE.Mesh(this.roundedBox(brassLip, glassHeight, brassLip, brassLip * 0.5), frameLipMat);
        sideLip.position.set(frameX - 0.004, glassY, z);
        group.add(sideLip);
      }

      const windowPane = new THREE.Mesh(new THREE.BoxGeometry(0.022, glassHeight, glassSpan), glassMat);
      windowPane.position.set(x * 1.005, glassY, 0);
      windowPane.renderOrder = 2;
      group.add(windowPane);
    }

    for (const cz of boothCenters) {
      for (const dz of [-1.12, 1.12]) {
        const z = cz + dz;
        const bench = new THREE.Mesh(this.roundedBox(1.35, 0.24, 0.52, seatR), seatMat);
        bench.position.set(0, 0.36, z);
        group.add(bench);

        const back = new THREE.Mesh(this.roundedBox(1.35, 0.74, 0.18, seatR), seatMat);
        back.position.set(0, 0.78, z + (dz > 0 ? 0.32 : -0.32));
        back.rotation.x = dz > 0 ? -0.1 : 0.1;
        group.add(back);
      }

      const table = new THREE.Mesh(this.roundedBox(1.15, 0.06, 0.64, seatR), woodMat);
      table.position.set(0, 0.72, cz);
      group.add(table);

      const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.68, 16), woodMat);
      tableLeg.position.set(0, 0.36, cz);
      group.add(tableLeg);
    }

    const fixtureMat = new THREE.MeshBasicMaterial({ color: 0xf0b24d });
    const fixtureZs = [-4.65, -3.1, -1.55, 0, 1.55, 3.1, 4.65];
    for (const z of fixtureZs) {
      const fixture = new THREE.Mesh(this.roundedBox(0.5, 0.022, 0.09, wallR), fixtureMat);
      fixture.position.set(0, 2.43, z);
      group.add(fixture);
    }

    this.cabinGroup = group;
    this.scene.add(group);
  }

  private roundedBox(width: number, height: number, depth: number, radius: number): THREE.BufferGeometry {
    const segments = Math.max(1, Math.floor(this.cabinParams.bevelSegments));
    const r = Math.max(0.0001, Math.min(radius, width * 0.499, height * 0.499, depth * 0.499));
    return new RoundedBoxGeometry(width, height, depth, segments, r);
  }

  private applyPlayerBackOffset(): void {
    this.localRig.setBackOffset(this.playersParams.backOffset);
    this.remoteRig.setBackOffset(this.playersParams.backOffset);
  }

  private setupPlayersPane(): void {
    if (this.playersTweaks) return;
    this.playersTweaks = registerTweaks(this.paneDock, 'players-v2', PLAYERS_DEFS, {
      title: 'Players',
      params: this.playersParams,
      onChange: {
        backOffset: () => this.applyPlayerBackOffset(),
      },
    });
  }

  private setupInstrumentsPane(): void {
    if (this.instrumentsTweaks) return;
    this.instrumentsTweaks = registerTweaks(this.paneDock, 'instruments', INSTRUMENTS_DEFS, {
      title: 'Instruments',
      params: this.instrumentsParams,
      onChange: {
        playerOffset: () => this.updatePlayerVisualAnchors(),
      },
    });
  }

  private setupInstrumentFxPane(): void {
    if (this.instrumentFxTweaks) return;
    this.instrumentFxTweaks = registerTweaks(this.paneDock, 'instrumentFx', INSTRUMENT_FX_DEFS, {
      title: 'Instrument FX',
      params: this.instrumentFxParams,
      onChange: {
        reverbWet:      v => this.audioGraph.setInstrumentFxParam('reverbWet', v),
        reverbDecay:    v => this.audioGraph.setInstrumentFxParam('reverbDecay', v),
        reverbPreDelay: v => this.audioGraph.setInstrumentFxParam('reverbPreDelay', v),
        delayWet:       v => this.audioGraph.setInstrumentFxParam('delayWet', v),
        delayTime:      v => this.audioGraph.setInstrumentFxParam('delayTime', v),
        delayFeedback:  v => this.audioGraph.setInstrumentFxParam('delayFeedback', v),
      },
    });
  }

  private installPlayerVisuals(): void {
    // Only construct each player's currently-active instrument visual at
    // boot. The other instrument is built lazily on first swap via
    // ensurePlayerVisual() inside swapPlayerVisual. Costs a one-time
    // shader compile on first swap; saves the up-front 2× construction
    // and prewarm work for visuals nobody is using.
    this.installPlayerVisualImmediate('local', this.playerInstruments.local);
    this.installPlayerVisualImmediate('remote', this.playerInstruments.remote);
  }

  private ensurePlayerVisual(player: PlayerSlot, id: InstrumentId): PlayerVisual {
    const cached = this.playerVisualCache[player][id];
    if (cached) return cached;
    const seatIndex = player === 'local' ? this.multiplayer.localSeatIndex : this.multiplayer.partnerSeatIndex;
    const anchor = this.computeInstrumentAnchor(seatIndex);
    let visual: PlayerVisual;
    const paneDock = player === 'local' ? this.paneDock : undefined;
    if (id === 'starlace') {
      visual = new Starlace(this.scene, paneDock, `starlace-${player}`, {
        palette: player,
        title: `Starlace (${player === 'local' ? 'Local' : 'Partner'})`,
        sculptor: this.sculptor,
        anchor,
        camera: player === 'local' ? this.camera : undefined,
        canvas: player === 'local' ? this.canvas : undefined,
        onPluck: pluck => {
          this.handSynth.triggerStarlacePluck(
            player,
            pluck.frequency,
            pluck.velocity,
            pluck.nodeIndex,
            pluck.x,
            pluck.y,
            pluck.noteIndex,
            {
              chordRootIndex: pluck.chordRootIndex,
              chordSize: pluck.chordSize,
              phraseStep: pluck.phraseStep,
            },
          );
          this.cueRobotInstrumentStrike(player, pluck.hand, pluck.worldPosition, pluck.velocity);
          this.lastStarlacePluckAt = performance.now() / 1000;
          if (player === 'local') {
            this.sendLocalPerformanceEvent({
              type: 'starlace-pluck',
              instrument: 'starlace',
              nodeIndex: pluck.nodeIndex,
              nodeIndices: pluck.nodeIndices,
              velocity: pluck.velocity,
              hand: pluck.hand,
              chordRootIndex: pluck.chordRootIndex,
              chordSize: pluck.chordSize,
              phraseStep: pluck.phraseStep,
            });
            this.recordHumanNote();
          }
          this.checkSynchrony();
        },
      });
    } else {
      visual = new Orb(this.scene, paneDock, `orb-${player}`, {
        palette: player,
        creature: this.playerCreatures[player],
        title: `Orb Pads (${player === 'local' ? 'Local' : 'Partner'})`,
        camera: player === 'local' ? this.camera : undefined,
        canvas: player === 'local' ? this.canvas : undefined,
        sculptor: this.sculptor,
        anchor,
        onOrbCountChange: player === 'local' ? count => this.setLocalOrbCount(count) : undefined,
        onHit: hit => {
          if (hit.held && hit.sourceId) {
            this.handSynth.triggerOrbNoteOn(player, hit.sourceId, hit.frequency, hit.velocity, hit.orbIndex, hit.envelope);
          } else {
            this.handSynth.triggerOrbHit(player, hit.frequency, hit.velocity, hit.orbIndex, hit.envelope);
          }
          this.cueRobotInstrumentStrike(player, hit.hand, hit.worldPosition, hit.velocity);
          this.lastOrbHitAt = performance.now() / 1000;
          if (player === 'local') {
            this.sendLocalPerformanceEvent({
              type: 'orb-hit',
              instrument: 'orb',
              orbIndex: hit.orbIndex,
              velocity: hit.velocity,
              held: hit.held,
              sourceId: hit.sourceId,
              noteNumber: hit.noteNumber,
              worldPosition: {
                x: hit.worldPosition.x,
                y: hit.worldPosition.y,
                z: hit.worldPosition.z,
              },
            });
            this.recordHumanNote();
          }
          this.checkSynchrony();
        },
        onRelease: release => {
          this.handSynth.triggerOrbNoteOff(player, release.sourceId, release.envelope);
          if (player === 'local') {
            this.sendLocalPerformanceEvent({
              type: 'orb-release',
              instrument: 'orb',
              sourceId: release.sourceId,
            });
          }
        },
        onGesture: gesture => {
          this.handSynth.setOrbGesture(player, gesture);
        },
      });
    }
    visual.startHidden();
    this.playerVisualCache[player][id] = visual;
    return visual;
  }

  private installPlayerVisualImmediate(player: PlayerSlot, id: InstrumentId): void {
    const previous = this.playerVisuals[player];
    const visual = this.ensurePlayerVisual(player, id);
    if (previous && previous !== visual) {
      previous.startHidden();
    }

    const seatIndex = player === 'local' ? this.multiplayer.localSeatIndex : this.multiplayer.partnerSeatIndex;
    visual.setAnchor(this.computeInstrumentAnchor(seatIndex));
    this.playerVisuals[player] = visual;
    this.playerInstruments[player] = id;
    this.handSynth.setInstrument(player, id);
    // Always start hidden — the caller decides when to play the intro
    // animation (after All Aboard, or on instrument swap).
    visual.startHidden();
    if (!this.introActive) {
      visual.playIntroAnimation();
    }
  }

  private async prewarmPlayerVisuals(): Promise<void> {
    const visuals = new Set<PlayerVisual>();
    for (const slot of ['local', 'remote'] as const) {
      for (const id of ['orb', 'starlace'] as const) {
        const visual = this.playerVisualCache[slot][id];
        if (visual) visuals.add(visual);
      }
    }

    for (const visual of visuals) {
      const wasVisible = visual.mesh.visible;
      visual.mesh.visible = true;
      try {
        await this.renderer.compileAsync(visual.mesh, this.camera, this.scene);
      } catch (err) {
        console.warn('[game] visual prewarm failed', err);
      } finally {
        visual.mesh.visible = wasVisible;
      }
    }
  }

  private updatePlayerVisualAnchors(): void {
    for (const player of ['local', 'remote'] as const) {
      const seatIndex = player === 'local' ? this.multiplayer.localSeatIndex : this.multiplayer.partnerSeatIndex;
      const anchor = this.computeInstrumentAnchor(seatIndex);
      for (const visual of Object.values(this.playerVisualCache[player])) {
        visual?.setAnchor(anchor);
      }
    }
  }

  private disposePlayerVisuals(): void {
    const visuals = new Set<PlayerVisual>();
    for (const slot of ['local', 'remote'] as const) {
      for (const visual of Object.values(this.playerVisualCache[slot])) {
        if (visual) visuals.add(visual);
      }
      this.playerVisualCache[slot] = {};
      this.playerVisuals[slot] = null;
    }
    for (const visual of visuals) visual.dispose();
  }

  private setLocalOrbCount(count: number): void {
    if (count === this.localOrbCount) return;
    this.localOrbCount = count;
    for (const listener of this.localOrbCountListeners) listener(count);
  }

  private async swapPlayerVisual(player: PlayerSlot, id: InstrumentId): Promise<void> {
    const current = this.playerVisuals[player];
    if (current) {
      this.swapsInFlight[player] += 1;
      try {
        await current.playOutroAnimation();
      } catch (err) {
        console.warn('[game] outro animation rejected', err);
      }
      // If another swap superseded this one mid-outro, abort the rest of
      // this branch so the most recent swap stays authoritative.
      this.swapsInFlight[player] -= 1;
      if (this.swapsInFlight[player] > 0) return;
    }
    this.installPlayerVisualImmediate(player, id);
  }

  /**
   * Where this seat's instrument visual lives. Anchored in front of the
   * seated player (between them and the cabin center) so the visual stays
   * with the player instead of drifting toward whatever the hands average.
   * Seat 0 sits at +Z in cabin space; seat 1 at -Z.
   */
  private computeInstrumentAnchor(seatIndex: number): THREE.Vector3 {
    const dir = seatIndex === 0 ? 1 : -1;
    return new THREE.Vector3(0, INSTRUMENT_ANCHOR_Y, dir * this.instrumentsParams.playerOffset);
  }

  private checkSynchrony(): void {
    const now = performance.now() / 1000;
    if (Math.abs(this.lastOrbHitAt - this.lastStarlacePluckAt) < 0.4 &&
        now - this.lastSynchronyAt > 0.25) {
      this.lastSynchronyAt = now;
      this.sculptor?.fireSynchrony();
    }
  }

  private handleMidiNoteOn(note: MidiNoteEvent): void {
    this.playerVisuals.local?.triggerMidiNoteOn?.(note.noteNumber, note.velocity, note.sourceId);
    this.recordHumanNote();
  }

  private recordHumanNote(): void {
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.lastHumanNoteAt = elapsed;
    this.duckRobotJamForHuman(elapsed);
  }

  private duckRobotJamForHuman(elapsed: number): void {
    if (this.partnerPresent || this.introActive || this.robotJamMuted) return;
    this.robotJamPending = [];
    const releaseAt = elapsed + 0.18;
    for (const note of this.robotJamActive) {
      if (note.releaseAt > releaseAt) note.releaseAt = releaseAt;
    }
  }

  private handleMidiNoteOff(note: MidiNoteEvent): void {
    this.playerVisuals.local?.triggerMidiNoteOff?.(note.noteNumber, note.sourceId);
  }

  private cueRobotInstrumentStrike(
    player: PlayerSlot,
    hand: Handedness | undefined,
    worldPosition: THREE.Vector3 | undefined,
    velocity: number,
  ): void {
    if (player !== 'remote' || this.partnerPresent || !hand || !worldPosition) return;
    const target = this.remoteRig.worldToPosePoint(hand, worldPosition);
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.robotMotion.cueStrike(hand, target, clamp(velocity, 0, 1), elapsed);
  }

  setPlayerInstrument(player: PlayerSlot, id: string): void {
    if (!isInstrumentId(id)) return;
    if (player === 'remote') {
      if (this.playerInstruments.remote === id) return;
      this.releaseRobotJamNotes();
      this.robotJamNextAt = 0;
      this.robotJamStep = -1;
      if (this.introActive) {
        this.installPlayerVisualImmediate(player, id);
        this.refreshArchetype();
        return;
      }
      void this.swapPlayerVisual(player, id).then(() => this.refreshArchetype());
      return;
    }
    if (this.playerInstruments[player] === id) return;
    // During intro we'd see the outro of an empty visual followed by the
    // intro of the new one — nothing has been revealed yet, so just swap
    // immediately.
    if (this.introActive) {
      this.installPlayerVisualImmediate(player, id);
      this.refreshArchetype();
      return;
    }
    void this.swapPlayerVisual(player, id).then(() => this.refreshArchetype());
  }

  private refreshArchetype(): void {
    const localKind = this.playerInstruments.local === 'starlace' ? 'starlace' : 'orb';
    const remoteKind = this.playerInstruments.remote === 'starlace' ? 'starlace' : 'orb';
    this.sculptor?.setArchetype(pickArchetype(localKind, remoteKind));
  }

  private normalizeCreature(value: string, fallback: CreatureId): CreatureId {
    return isCreatureId(value) ? value : fallback;
  }

  setPlayerCreature(player: PlayerSlot, id: string): void {
    if (!isCreatureId(id)) {
      console.warn('[game] setPlayerCreature: invalid id', id);
      return;
    }
    this.playerCreatures[player] = id;
    const rig = player === 'local' ? this.localRig : this.remoteRig;
    rig.setCreature(id);
    for (const visual of Object.values(this.playerVisualCache[player])) {
      visual?.setCreature?.(id);
    }
  }

  private setupCabinPane(): void {
    if (this.cabinTweaks) return;
    const rebuild = () => this.buildCabinGeometry();
    this.cabinTweaks = registerTweaks(this.paneDock, 'cabin', CABIN_DEFS, {
      title: 'Cabin',
      params: this.cabinParams,
      onChange: {
        bevelRadius:    rebuild,
        furnitureBevel: rebuild,
        bevelSegments:  rebuild,
      },
    });
  }

  private setupCabinLightingPane(): void {
    if (this.cabinLightingTweaks) return;
    this.cabinLightingTweaks = registerTweaks(this.paneDock, 'cabin-local-lighting', CABIN_LIGHTING_DEFS, {
      title: 'Cabin Lighting',
      params: this.cabinLightingParams,
    });
  }

  getSceneVertexCount(): number {
    let total = 0;
    this.scene.traverse(obj => {
      const geometry = (obj as THREE.Mesh | THREE.Points | THREE.LineSegments).geometry as THREE.BufferGeometry | undefined;
      if (geometry && geometry.isBufferGeometry) {
        const pos = geometry.getAttribute('position');
        if (pos) {
          const drawCount = geometry.drawRange.count;
          total += Number.isFinite(drawCount) ? Math.min(pos.count, Math.max(0, drawCount)) : pos.count;
        }
      }
    });
    return total;
  }

  private update(): void {
    const now = performance.now();
    const delta = Math.min((now - this.lastFrameAt) / 1000, 0.05);
    const elapsed = (now - this.startedAt) / 1000;
    this.lastFrameAt = now;
    // Lerp the idle-motion clock scale toward its target (0.05 during intro,
    // 1.0 after exitIntroMode). motionElapsed is the slowed clock the visible
    // procedural motion (robot hands, instrument bobbing) reads from.
    this.motionFactor += (this.motionFactorTarget - this.motionFactor) * (1 - Math.exp(-delta / MOTION_FACTOR_TAU));
    this.motionElapsed += delta * this.motionFactor;
    const motionDelta = delta * this.motionFactor;
    const localSeat = this.multiplayer.localSeatIndex;
    const partnerSeat = this.multiplayer.partnerSeatIndex;
    const hands = this.handTracker.update(elapsed, localSeat);
    const localPose = makePlayerPose(this.multiplayer.localId, 'Player', this.roomId, localSeat, hands, {
      inputSource: this.handTracker.getPoseInputSource(),
      trackedHands: this.handTracker.getTrackedHands(),
    });
    const remoteFromNetwork = this.poseSession.getRemotePose();
    const robotPerformance = this.partnerPresent ? undefined : this.updateRobotInstrumentTargets(elapsed);
    const robotHands = this.robotMotion.update(this.motionElapsed, motionDelta, localPose, robotPerformance);
    const robotPose = makePlayerPose('robot', 'Robot', this.roomId, partnerSeat, robotHands, {
      isRobot: true,
      inputSource: 'robot',
    });
    // Presence (player row in our cabin) drives form. Pose freshness only
    // drives hand articulation. If partner is here but no pose has arrived
    // yet (or it paused — hands out of frame), hold the last-known pose.
    const remotePose = this.partnerPresent
      ? (remoteFromNetwork ?? this.remotePose ?? robotPose)
      : robotPose;
    const robotTarget = this.partnerPresent ? 0 : 1;

    this.localPose = localPose;
    this.remotePose = remotePose;
    this.localRig.update(localPose, delta, 0);
    this.remoteRig.update(remotePose, delta, robotTarget);

    orbLfo.tick(motionDelta);
    this.updatePlayerVisuals(motionDelta, elapsed);
    const beat = this.backingTrackAnalyzer.tick(performance.now());
    if (beat) {
      this.sculptor?.triggerRipple(beat.intensity);
      this.ingestBackingTrackBeat(elapsed);
    }
    this.sculptor?.update(delta);
    const atmosphere = this.scenery.update(delta, elapsed);
    this.updateAtmosphere(atmosphere);
    this.updateCabinLighting(elapsed);
    this.handSynth.update(localPose, remotePose, delta);
    this.poseSession.sendLocalPose(localPose, elapsed);
    if (this.cameraMode === 'orbit') this.orbitControls?.update();
    if (this.postFX) {
      this.postFX.setLoudness(this.backingTrackAnalyzer.getLoudness());
      this.postFX.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.resolveFrameRenderListeners();
  }

  private resolveFrameRenderListeners(): void {
    if (this.frameRenderListeners.size === 0) return;
    const listeners = [...this.frameRenderListeners];
    this.frameRenderListeners.clear();
    for (const listener of listeners) listener();
  }

  private updatePlayerVisuals(delta: number, elapsed: number): void {
    const localLeft = this.localRig.getPalmWorld('left', this.localLeftPalm);
    const localRight = this.localRig.getPalmWorld('right', this.localRightPalm);
    const remoteLeft = this.remoteRig.getPalmWorld('left', this.remoteLeftPalm);
    const remoteRight = this.remoteRig.getPalmWorld('right', this.remoteRightPalm);
    // Local mouse hands are visual followers; pointer/keyboard/MIDI already
    // have direct instrument paths. Remote contacts are only a fallback until
    // the reliable performance channel is open.
    const localContacts = this.localPose?.inputSource === 'camera'
      ? this.updateVisualContacts('local', this.localRig, this.localPose.trackedHands)
      : undefined;
    const remotePose = this.remotePose;
    const reconstructRemoteContacts = this.partnerPresent && !this.webrtc.isPerformanceChannelOpen();
    const remoteContacts = reconstructRemoteContacts && remotePose && remotePose.inputSource !== 'robot'
      ? this.updateVisualContacts(
          'remote',
          this.remoteRig,
          remotePose.inputSource === 'camera' ? remotePose.trackedHands : undefined,
        )
      : undefined;
    const localVoice = this.handSynth.getVoiceState('local');
    const remoteVoice = this.handSynth.getVoiceState('remote');

    this.playerVisuals.local?.update(localLeft, localRight, localVoice, delta, localContacts);
    this.playerVisuals.remote?.update(remoteLeft, remoteRight, remoteVoice, delta, remoteContacts);
    this.tickRobotJam(elapsed);
  }

  private tickRobotJam(elapsed: number): void {
    if (this.partnerPresent || this.introActive || this.robotJamMuted) {
      this.releaseRobotJamNotes();
      this.robotJamNextAt = 0;
      this.robotJamStep = -1;
      this.lastHumanNoteAt = -Infinity;
      this.robotJamPhraseEndsAtSlot = -1;
      return;
    }

    const humanState = this.updateHumanJamState(elapsed);

    this.releaseDueRobotJamNotes(elapsed);
    this.startDueRobotJamNotes(elapsed);

    const visual = this.playerVisuals.remote;
    if (!visual?.triggerMidiNoteOn) return;
    if (this.robotJamNextAt <= 0) {
      this.scheduleNextRobotJam(elapsed);
      return;
    }
    if (elapsed < this.robotJamNextAt) return;

    const slotIndex = this.robotJamSlotIndex(elapsed);
    if (slotIndex <= this.robotJamStep) {
      this.scheduleNextRobotJam(elapsed);
      return;
    }

    // Note-count cap so phrases can layer without runaway stacking.
    const concurrent = this.robotJamActive.length + this.robotJamPending.length;
    if (concurrent >= ROBOT_JAM_MAX_CONCURRENT) {
      this.robotJamStep = slotIndex;
      this.scheduleNextRobotJam(elapsed);
      return;
    }

    const instrument = this.playerInstruments.remote;
    const phraseIndex = Math.floor(slotIndex / Math.max(1, ROBOT_JAM_SLOTS_PER_BAR * ROBOT_JAM_PHRASE_BARS));
    const seed = slotIndex * 17.17 + phraseIndex * 5.31 + this.roomSeed * 0.029;
    const motion = this.robotMotion.params;
    this.robotJamStep = slotIndex;

    // When player is silent and we're at a downbeat with no active phrase,
    // launch a multi-slot melodic line (only meaningful for starlace; orb
    // already lays a chord pad via its slot-0 event).
    if (
      instrument === 'starlace'
      && humanState.mode === 'silent'
      && slotIndex > this.robotJamPhraseEndsAtSlot
      && positiveModulo(slotIndex, ROBOT_JAM_SLOTS_PER_BAR) === 0
      && hash(seed + 13.7) < 0.78
    ) {
      const launched = this.queueRobotJamMelodicPhrase(elapsed, slotIndex, seed);
      if (launched > 0) {
        this.robotJamPhraseEndsAtSlot = slotIndex + launched - 1;
        this.scheduleNextRobotJam(elapsed);
        return;
      }
    }

    const event = this.pickRobotJamEvent(instrument, slotIndex, seed, humanState);
    if (event) {
      const densityScale = (instrument === 'starlace' ? ROBOT_JAM_STARLACE_DENSITY_SCALE : 1)
        * humanState.densityScale;
      const playChance = clamp(motion.density * densityScale * event.chance, 0, 0.98);
      if (hash(seed + 0.97) < playChance) {
        this.queueRobotJamGesture(elapsed, instrument, slotIndex, seed, event);
      }
    }
    this.scheduleNextRobotJam(elapsed);
  }

  /**
   * Build a 4–8 note melodic line over upcoming slots using the current
   * chord's tones + colors + a motif. Notes are queued as pending with
   * staggered startAt; returns the number of slots consumed.
   */
  private queueRobotJamMelodicPhrase(elapsed: number, slotIndex: number, seed: number): number {
    const motion = this.robotMotion.params;
    const slotSec = this.effectiveSlotSec();
    const beatSec = slotSec * ROBOT_JAM_SLOTS_PER_BEAT;
    const chord = this.robotJamChordForSlot(slotIndex);
    const motifSet = ROBOT_JAM_STARLACE_MOTIFS[
      positiveModulo(Math.floor(seed * 0.13), ROBOT_JAM_STARLACE_MOTIFS.length)
    ] ?? ROBOT_JAM_STARLACE_MOTIFS[0];
    const root = chord.tones[0] ?? chord.root;
    // Phrase length: 5–8 notes, with rhythm = 1 or 2 slots between hits.
    const phraseLen = 5 + Math.floor(hash(seed + 21.1) * 4); // 5..8
    const ridingHigh = hash(seed + 22.2) > 0.4;

    let cursorSlots = 0;
    let added = 0;
    const visual = this.playerVisuals.remote;
    if (!visual?.triggerMidiNoteOn) return 0;

    for (let i = 0; i < phraseLen; i += 1) {
      const motifOffset = motifSet[positiveModulo(i, motifSet.length)] ?? 0;
      const accent = i === 0 ? 0 : hash(seed + i * 4.71) > 0.65 ? 1 : 0;
      const degree = root + (ridingHigh ? 7 : 0) + motifOffset + accent;
      const startAt = elapsed + cursorSlots * slotSec;
      // Hold ~1.4 slots so notes overlap a tiny bit, building melodic flow.
      const holdSec = beatSec * lerp(0.55, 1.10, hash(seed + i * 5.13));
      const velocity = clamp(0.36 + hash(seed + i * 7.91) * 0.20 - i * 0.012, 0.22, 0.74);
      const noteNumber = 36 + clamp(degree, 0, 25);
      const sourceId = `robot-phrase:${slotIndex}:${i}`;
      this.robotJamPending.push({
        instrument: 'starlace',
        noteNumber,
        sourceId,
        startAt,
        releaseAt: startAt + holdSec,
        velocity,
        seed: seed + i * 3.07,
      });
      added += 1;
      // Rhythm: most notes 1 slot apart, occasionally 2 slots for breath.
      cursorSlots += hash(seed + i * 9.13) > 0.78 ? 2 : 1;
      // Don't blow past phrase budget.
      if (cursorSlots >= ROBOT_JAM_SLOTS_PER_BAR * 2) break;
    }

    // Apply density gating to whole phrase, not per-note, so silent-mode
    // produces continuous lines rather than fragmented chance-gated notes.
    const phraseChance = clamp(motion.density * 1.1, 0.4, 0.98);
    if (hash(seed + 0.97) > phraseChance) {
      // Roll back this phrase if density says no — drop the just-pushed pending entries.
      this.robotJamPending.splice(this.robotJamPending.length - added, added);
      return 0;
    }
    return Math.max(1, cursorSlots);
  }

  /**
   * Three-mode listener. `active` = human just hit a note (robot pad-only).
   * `leading` = brief gap (robot fills with sparse accents). `silent` = long
   * gap (robot solos with full phrase generator).
   */
  private updateHumanJamState(elapsed: number): RobotJamHumanState {
    const motion = this.robotMotion.params;
    const sinceLastNote = elapsed - this.lastHumanNoteAt;
    const leadingTime = motion.humanLeadingTime;
    const floor = motion.humanDuckFloor;
    const boost = motion.silentBoost;

    let mode: RobotJamHumanMode;
    let densityScale: number;
    if (sinceLastNote < leadingTime * 0.5) {
      mode = 'active';
      densityScale = floor;
    } else if (sinceLastNote < leadingTime * 2.5) {
      mode = 'leading';
      // Smooth ramp from floor → 1 across the leading window.
      const t = clamp((sinceLastNote - leadingTime * 0.5) / (leadingTime * 2), 0, 1);
      densityScale = lerp(floor, 1, t);
    } else {
      mode = 'silent';
      // Continued ramp into boost so the robot pushes harder the longer the
      // human is gone.
      const t = clamp((sinceLastNote - leadingTime * 2.5) / 4, 0, 1);
      densityScale = lerp(1, boost, t);
    }
    return { sinceLastNote, mode, densityScale };
  }

  /**
   * Backing-track beat ingestion. Pushes new beat times, estimates BPM from
   * recent intervals, and locks tempo + phase anchor when intervals are
   * stable. Called from animate() whenever the analyzer fires a beat.
   */
  private ingestBackingTrackBeat(elapsed: number): void {
    this.detectedBeatTimes.push(elapsed);
    if (this.detectedBeatTimes.length > ROBOT_JAM_BEAT_HISTORY) {
      this.detectedBeatTimes.shift();
    }
    if (this.detectedBeatTimes.length < 4) return;

    const intervals: number[] = [];
    for (let i = 1; i < this.detectedBeatTimes.length; i += 1) {
      intervals.push(this.detectedBeatTimes[i] - this.detectedBeatTimes[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    if (median <= 0) return;

    const minInterval = intervals[0];
    const maxInterval = intervals[intervals.length - 1];
    if ((maxInterval - minInterval) / median > ROBOT_JAM_BEAT_LOCK_TOLERANCE) return;

    const bpm = 60 / median;
    if (bpm < ROBOT_JAM_BEAT_BPM_MIN || bpm > ROBOT_JAM_BEAT_BPM_MAX) return;

    this.lockedTempoBpm = bpm;
    this.lockedPhaseAnchor = elapsed;
    // Slot index is computed relative to the anchor — resetting it keeps
    // robotJamStep and robotJamPhraseEndsAtSlot from pointing into the past
    // and silently skipping the next ~30 slots after a lock.
    this.robotJamStep = -1;
    this.robotJamPhraseEndsAtSlot = -1;
    this.robotJamNextAt = 0;
  }

  private effectiveSlotSec(): number {
    const bpm = this.lockedTempoBpm ?? Math.max(this.robotMotion.params.tempo, 1);
    return (60 / bpm) / ROBOT_JAM_SLOTS_PER_BEAT;
  }

  private scheduleNextRobotJam(elapsed: number): void {
    const slotSec = this.effectiveSlotSec();
    const anchor = this.lockedPhaseAnchor;
    // Quantize to next slot boundary relative to the locked phase anchor so
    // the robot's grid aligns with the backing-track downbeats once locked.
    const slotIndex = Math.floor((elapsed - anchor) / slotSec + 1e-4) + 1;
    let nextAt = anchor + slotIndex * slotSec;
    // Apply swing to off-beat (odd) slots: delay by up to swing * slotSec.
    if (slotIndex % 2 === 1) nextAt += this.robotMotion.params.swing * slotSec;
    this.robotJamNextAt = nextAt;
  }

  private robotJamSlotIndex(elapsed: number): number {
    const slotSec = this.effectiveSlotSec();
    return Math.max(0, Math.floor((elapsed - this.lockedPhaseAnchor) / slotSec + 1e-4));
  }

  private pickRobotJamEvent(
    instrument: InstrumentId,
    slotIndex: number,
    seed: number,
    human: RobotJamHumanState,
  ): RobotJamEvent | null {
    const chord = this.robotJamChordForSlot(slotIndex);
    return instrument === 'orb'
      ? this.pickRobotJamOrbEvent(chord, slotIndex, seed, human)
      : this.pickRobotJamStarlaceEvent(chord, slotIndex, seed, human);
  }

  private pickRobotJamOrbEvent(
    chord: RobotJamChord,
    slotIndex: number,
    seed: number,
    human: RobotJamHumanState,
  ): RobotJamEvent | null {
    if (human.sinceLastNote < ROBOT_JAM_ORB_LISTEN_GAP) return null;
    const slotInBar = positiveModulo(slotIndex, ROBOT_JAM_SLOTS_PER_BAR);
    const isActive = human.mode === 'active';
    const isSilent = human.mode === 'silent';
    const root = chord.tones[0] ?? chord.root;
    const third = chord.tones[1] ?? chord.root + 2;
    const fifth = chord.tones[2] ?? chord.root + 4;
    const seventh = chord.tones[3] ?? chord.root + 6;
    const color = chord.colors[0] ?? chord.root + 8;

    if (slotInBar === 0) {
      const degrees = isActive
        ? [third, seventh]
        : isSilent && hash(seed + 0.35) > 0.30
          ? [root + 7, third + 7, seventh, color]
          : [root, fifth, seventh];
      return {
        degrees: this.normalizeRobotJamDegrees(degrees),
        holdBeats: isActive ? 1.15 : isSilent ? 3.25 : 2.05,
        velocity: isActive ? 0.28 + hash(seed + 2.7) * 0.08 : 0.38 + hash(seed + 2.7) * 0.16,
        strumBeats: 0.10 + hash(seed + 3.1) * 0.07,
        chance: isActive ? 0.62 : isSilent ? 0.96 : 0.82,
      };
    }

    if (slotInBar === ROBOT_JAM_SLOTS_PER_BEAT * 2) {
      const useColor = hash(seed + 0.83) > 0.48;
      return {
        degrees: this.normalizeRobotJamDegrees(useColor ? [third, color] : [fifth, seventh]),
        holdBeats: isActive ? 0.75 : 1.35 + hash(seed + 1.9) * 0.45,
        velocity: isActive ? 0.24 + hash(seed + 4.2) * 0.08 : 0.34 + hash(seed + 4.2) * 0.14,
        strumBeats: 0.07 + hash(seed + 4.8) * 0.06,
        chance: isActive ? 0.36 : isSilent ? 0.78 : 0.56,
      };
    }

    if (!isActive && (slotInBar === ROBOT_JAM_SLOTS_PER_BAR - 2 || slotInBar === ROBOT_JAM_SLOTS_PER_BAR - 1)) {
      const slotsToNextBar = ROBOT_JAM_SLOTS_PER_BAR - slotInBar;
      const next = this.robotJamChordForSlot(slotIndex + slotsToNextBar);
      const nextThird = next.tones[1] ?? next.root + 2;
      const nextColor = next.colors[0] ?? next.root + 8;
      return {
        degrees: this.normalizeRobotJamDegrees(hash(seed + 5.4) > 0.45 ? [nextThird] : [nextColor]),
        holdBeats: 0.42 + hash(seed + 5.9) * 0.22,
        velocity: 0.28 + hash(seed + 6.3) * 0.12,
        strumBeats: 0,
        chance: isSilent ? 0.66 : 0.40,
      };
    }

    return null;
  }

  private pickRobotJamStarlaceEvent(
    chord: RobotJamChord,
    slotIndex: number,
    seed: number,
    human: RobotJamHumanState,
  ): RobotJamEvent | null {
    if (human.sinceLastNote < ROBOT_JAM_STARLACE_LISTEN_GAP) return null;
    const slotInBar = positiveModulo(slotIndex, ROBOT_JAM_SLOTS_PER_BAR);
    const isActive = human.mode === 'active';
    const isSilent = human.mode === 'silent';
    // 'active' → only ghost-hits on offbeats. 'leading' → most odd slots + 2,6.
    // 'silent' → every slot is fair game (the dedicated phrase generator
    // handles bar-aligned runs; this picker fills in between).
    const allowed = isActive
      ? slotInBar === 3 || slotInBar === 5 || slotInBar === 7
      : isSilent
        ? true
        : slotInBar % 2 === 1 || slotInBar === 2 || slotInBar === 6;
    if (!allowed) return null;

    const motifSet = ROBOT_JAM_STARLACE_MOTIFS[
      positiveModulo(Math.floor(this.roomSeed * 0.001 + slotIndex / ROBOT_JAM_SLOTS_PER_BAR), ROBOT_JAM_STARLACE_MOTIFS.length)
    ] ?? ROBOT_JAM_STARLACE_MOTIFS[0];
    const phraseStep = Math.floor(slotIndex / ROBOT_JAM_SLOTS_PER_BEAT);
    const motifOffset = motifSet[positiveModulo(phraseStep, motifSet.length)] ?? 0;
    const highAnchor = chord.root + 7 + motifOffset;
    const neighbor = hash(seed + 7.2) > 0.56 ? 2 : -1;
    const twoNote = !isActive && hash(seed + 7.7) > 0.72;
    return {
      degrees: this.normalizeRobotJamDegrees(twoNote ? [highAnchor, highAnchor + neighbor] : [highAnchor]),
      holdBeats: isActive ? 0.42 + hash(seed + 8.1) * 0.20 : 0.92 + hash(seed + 8.1) * 0.78,
      velocity: isActive ? 0.24 + hash(seed + 8.8) * 0.10 : 0.38 + hash(seed + 8.8) * 0.20,
      strumBeats: twoNote ? 0.14 + hash(seed + 9.2) * 0.08 : 0,
      chance: isActive ? 0.30 : isSilent ? 0.78 : 0.58,
    };
  }

  private robotJamChordForSlot(slotIndex: number): RobotJamChord {
    const phraseIndex = Math.floor(slotIndex / Math.max(1, ROBOT_JAM_SLOTS_PER_BAR * ROBOT_JAM_PHRASE_BARS));
    const progressionIndex = positiveModulo(
      Math.floor(hash(this.roomSeed * 0.071) * ROBOT_JAM_PROGRESSIONS.length) + phraseIndex,
      ROBOT_JAM_PROGRESSIONS.length,
    );
    const progression = ROBOT_JAM_PROGRESSIONS[progressionIndex] ?? ROBOT_JAM_PROGRESSIONS[0];
    const barIndex = Math.floor(slotIndex / ROBOT_JAM_SLOTS_PER_BAR);
    return progression[positiveModulo(barIndex, progression.length)] ?? progression[0];
  }

  private normalizeRobotJamDegrees(degrees: readonly number[]): number[] {
    const out: number[] = [];
    for (const value of degrees) {
      if (!Number.isFinite(value)) continue;
      let degree = Math.round(value);
      while (degree < 0) degree += 7;
      while (degree > 25) degree -= 7;
      if (!out.includes(degree)) out.push(degree);
    }
    return out;
  }

  private queueRobotJamGesture(
    elapsed: number,
    instrument: InstrumentId,
    gestureIndex: number,
    seed: number,
    event: RobotJamEvent,
  ): number {
    const beatSec = this.effectiveSlotSec() * ROBOT_JAM_SLOTS_PER_BEAT;
    const maxStrum = ROBOT_JAM_STRUM_MAX_OFFSET;
    const strum = event.degrees.length > 1
      ? Math.min(maxStrum, beatSec * event.strumBeats)
      : 0;
    const hold = beatSec * event.holdBeats;

    let added = 0;
    event.degrees.forEach((degree, index) => {
      const startAt = elapsed + index * strum;
      this.robotJamPending.push({
        instrument,
        noteNumber: 36 + degree,
        sourceId: `robot:${gestureIndex}:${index}:${degree}`,
        startAt,
        releaseAt: startAt + hold,
        velocity: clamp(event.velocity * (0.92 + hash(seed + index * 1.91 + 0.67) * 0.18) - index * 0.025, 0.18, 0.82),
        seed: seed + index * 3.07,
      });
      added += 1;
    });
    return added;
  }

  private startDueRobotJamNotes(elapsed: number): void {
    if (this.robotJamPending.length === 0) return;
    const stillPending: RobotJamPendingNote[] = [];
    const visual = this.playerVisuals.remote;
    for (const note of this.robotJamPending) {
      if (elapsed < note.startAt) {
        stillPending.push(note);
        continue;
      }
      visual?.triggerMidiNoteOn?.(note.noteNumber, note.velocity, note.sourceId);
      this.cueRobotJamStrike(note.noteNumber, note.velocity, elapsed, note.seed);
      this.robotJamActive.push({
        instrument: note.instrument,
        noteNumber: note.noteNumber,
        sourceId: note.sourceId,
        releaseAt: note.releaseAt,
      });
    }
    this.robotJamPending = stillPending;
  }

  private cueRobotJamStrike(noteNumber: number, velocity: number, elapsed: number, seed: number): void {
    const targets = this.playerVisuals.remote?.getPerformanceTargets?.();
    if (!targets?.length) return;
    const hand: Handedness = hash(seed + 1.03) < 0.5 ? 'left' : 'right';
    const index = positiveModulo(Math.round(noteNumber) - 36, targets.length);
    this.remoteRig.worldToPosePoint(
      hand,
      this.robotHandTargetWorldPoint(targets[index], this.robotTargetWorldScratch),
      this.robotJamStrikeTarget,
    );
    this.robotMotion.cueStrike(hand, this.robotJamStrikeTarget, clamp(velocity, 0, 1), elapsed);
  }

  private releaseDueRobotJamNotes(elapsed: number): void {
    if (this.robotJamActive.length === 0) return;
    const stillActive: RobotJamNote[] = [];
    for (const note of this.robotJamActive) {
      if (elapsed < note.releaseAt) {
        stillActive.push(note);
        continue;
      }
      this.releaseRobotJamNote(note);
    }
    this.robotJamActive = stillActive;
  }

  private releaseRobotJamNotes(): void {
    this.robotJamPending = [];
    for (const note of this.robotJamActive) this.releaseRobotJamNote(note);
    this.robotJamActive = [];
  }

  private releaseRobotJamNote(note: RobotJamNote): void {
    const visual = this.playerVisualCache.remote[note.instrument] ?? this.playerVisuals.remote;
    visual?.triggerMidiNoteOff?.(note.noteNumber, note.sourceId);
  }

  private updateRobotInstrumentTargets(elapsed: number): RobotPerformanceContext | undefined {
    const worldTargets = this.playerVisuals.remote?.getPerformanceTargets?.();
    if (!worldTargets?.length) return undefined;

    const focusedTargets = this.collectRobotFocusedWorldTargets(worldTargets, elapsed);
    const sourceTargets = focusedTargets.length > 0 ? focusedTargets : worldTargets;
    const count = Math.min(sourceTargets.length, 32);
    for (const hand of handednesses) {
      const targets = this.robotInstrumentTargets[hand];
      targets.length = 0;
      for (let i = 0; i < count; i += 1) {
        const out = targets[i] ?? { x: 0, y: 0, z: 0 };
        this.remoteRig.worldToPosePoint(
          hand,
          this.robotHandTargetWorldPoint(sourceTargets[i], this.robotTargetWorldScratch),
          out,
        );
        targets[i] = out;
      }
      targets.length = count;
    }

    return {
      instrument: this.playerInstruments.remote,
      targets: this.robotInstrumentTargets,
    };
  }

  private collectRobotFocusedWorldTargets(worldTargets: readonly THREE.Vector3[], elapsed: number): readonly THREE.Vector3[] {
    this.robotFocusedWorldTargets.length = 0;
    this.robotFocusedWorldTargetIndices.length = 0;
    const addNoteTarget = (note: RobotJamNote): void => {
      if (note.instrument !== this.playerInstruments.remote) return;
      const index = this.robotTargetIndexForNote(note.noteNumber, worldTargets.length);
      if (index < 0 || this.robotFocusedWorldTargetIndices.includes(index)) return;
      const target = worldTargets[index];
      if (!target) return;
      this.robotFocusedWorldTargetIndices.push(index);
      this.robotFocusedWorldTargets.push(target);
    };

    for (const note of this.robotJamActive) {
      if (note.releaseAt >= elapsed - 0.05) addNoteTarget(note);
    }
    for (const note of this.robotJamPending) {
      if (note.startAt <= elapsed + ROBOT_HAND_TARGET_LOOKAHEAD && note.releaseAt >= elapsed - 0.05) {
        addNoteTarget(note);
      }
    }

    return this.robotFocusedWorldTargets;
  }

  private robotTargetIndexForNote(noteNumber: number, targetCount: number): number {
    if (targetCount <= 0 || !Number.isFinite(noteNumber)) return -1;
    return positiveModulo(Math.round(noteNumber) - 36, targetCount);
  }

  private robotHandTargetWorldPoint(point: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    const dir = this.multiplayer.partnerSeatIndex === 0 ? 1 : -1;
    target.copy(point);
    target.z += dir * ROBOT_HAND_TARGET_BACKSET;
    return target;
  }

  private updateVisualContacts(
    player: PlayerSlot,
    rig: HumanoidRig,
    trackedHands?: Readonly<Record<Handedness, boolean>>,
  ): readonly HandContactPoint[] {
    const contacts = this.visualContacts[player];
    const activeContacts = this.activeVisualContacts[player];
    activeContacts.length = 0;
    let cursor = 0;

    for (const hand of handednesses) {
      const includeHand = trackedHands ? trackedHands[hand] === true : true;
      const palmContact = contacts[cursor++];
      rig.getPalmCenterWorld(hand, palmContact.position);
      if (includeHand) activeContacts.push(palmContact);
      for (const finger of fingerNames) {
        for (const joint of fingerJointNames) {
          const contact = contacts[cursor++];
          rig.getFingerJointWorld(hand, finger, joint, contact.position);
          if (includeHand) activeContacts.push(contact);
        }
      }
    }

    return activeContacts;
  }

  // Intro/active state. While intro is enabled the scenery's bird system is
  // held off, the instruments stay hidden, and pointer/keyboard input cannot
  // hit the orbs/starlace. Master visual dimming of the rendered scene is
  // handled in CSS via the canvas's opacity/filter so it lands uniformly on
  // lit and unlit materials.
  exitIntroMode(): void {
    if (!this.introActive) return;
    this.introActive = false;
    this.motionFactorTarget = 1.0;
    this.handTracker.setPointerInputEnabled(true);
    this.handSynth.setMouseInputEnabled(true);
    this.scenery.setSkyLifeEnabled(true);
    this.playerVisuals.local?.playIntroAnimation();
    this.playerVisuals.remote?.playIntroAnimation();
  }

  private updateAtmosphere(atmosphere: { background: THREE.Color; daylight: number; night: number; underwater?: number }): void {
    this.scene.background = atmosphere.background;
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(atmosphere.background);
  }

  private updateCabinLighting(elapsed: number, snap = false): void {
    if (this.cabinPlateLayers.length < 3) return;
    const p = this.cabinLightingParams;
    const drift = p.driftRate > 0 ? Math.sin(elapsed * p.driftRate * Math.PI * 2) * 0.55 : 0;
    const flickerPhase = elapsed * p.flickerRate * Math.PI * 2;
    const flicker = p.flickerRate > 0
      ? Math.sin(flickerPhase + 1.7) * 0.25 + Math.sin(flickerPhase * 1.73 + 4.2) * 0.20
      : 0;
    const flutter = p.flutter > 0 && p.flickerRate > 0
      ? Math.pow(Math.max(0, Math.sin(flickerPhase * 3.7 + 0.4)), 8) * p.flutter
      : 0;
    const target = clamp(p.nightBlend + (drift + flicker) * p.flickerAmplitude + flutter, 0, 2);
    this.cabinLightingBlend = snap ? target : this.cabinLightingBlend + (target - this.cabinLightingBlend) * 0.12;

    const mediumOpacity = clamp(this.cabinLightingBlend, 0, 1);
    const darkOpacity = clamp(this.cabinLightingBlend - 1, 0, 1);
    this.cabinPlateLayers[1].material.opacity = mediumOpacity;
    this.cabinPlateLayers[2].material.opacity = darkOpacity;
    this.cabinPlateLayers[1].mesh.visible = mediumOpacity > 0.001;
    this.cabinPlateLayers[2].mesh.visible = darkOpacity > 0.001;
  }

  private resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    if (this.cameraMode === 'game') this.lockGameCamera();
    this.renderer.setSize(width, height, false);
  }

  private createPaneDock(): HTMLElement {
    // Single collapsible <details> wrapper so all the per-system tweakpanes
    // fold into one meta panel that the user can roll up out of the way.
    const dock = document.createElement('details');
    dock.className = 'tweak-pane-dock';
    dock.open = true;
    const summary = document.createElement('summary');
    summary.className = 'tweak-pane-dock-summary';
    summary.textContent = 'Tweaks';
    dock.appendChild(summary);
    // Mount on #stage-wrap (viewport-fixed) rather than #stage so the pane
    // keeps its native size on narrow viewports instead of shrinking with
    // the letterboxed scene.
    const host = document.getElementById('stage-wrap') ?? document.body;
    host.appendChild(dock);
    return dock;
  }
}
