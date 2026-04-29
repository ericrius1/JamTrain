import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { JamAudioGraph } from './audioGraph';
import { attachHandDepthPane } from './handDepth';
import { HandSynthEngine } from './handSynth';
import { HandTracker } from './handTracking';
import { MidiInputController, type MidiNoteEvent } from './midiInput';
import { clamp, hash } from './math';
import { MultiplayerClient } from './multiplayer';
import { Drum } from './visuals/Drum';
import { Starlace } from './visuals/Starlace';
import { RoundDirector } from './RoundDirector';
import { EnergySculptor } from './EnergySculptor';
import { pickArchetype } from './sculptor/archetypeShared';
import type { HandContactPoint, InstrumentId, PlayerVisual } from './instruments';
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

const INSTRUMENT_ANCHOR_Y = 0.98;
const ROBOT_JAM_MIN_DELAY = 1.85;
const ROBOT_JAM_MAX_DELAY = 4.6;
const ROBOT_STARLACE_JAM_MIN_DELAY = 2.35;
const ROBOT_STARLACE_JAM_MAX_DELAY = 5.8;
const ROBOT_JAM_SHORT_HOLD = 0.18;
const ROBOT_JAM_LONG_HOLD_MIN = 0.68;
const ROBOT_JAM_LONG_HOLD_MAX = 1.55;
const ROBOT_JAM_STRUM_MAX_OFFSET = 0.16;
// Scale-degree patterns. harmony.ts is locked to C major, so these stay
// diatonic while still letting the robot imply simple chords.
const ROBOT_JAM_SCALE_ROOTS = [0, 1, 3, 4, 5] as const;
const ROBOT_JAM_CHORD_SHAPES: readonly (readonly number[])[] = [
  [0],
  [0, 2],
  [0, 2, 4],
  [0, 3, 5],
  [2, 4, 6],
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
  private localDrumOrbCountListeners = new Set<(count: number) => void>();
  private localDrumOrbCount = 0;
  private localRig: HumanoidRig;
  private remoteRig: HumanoidRig;
  private robotMotion: RobotMotionController;
  private scenery: ScenerySystem;
  private playerVisuals: Record<PlayerSlot, PlayerVisual | null> = { local: null, remote: null };
  private playerVisualCache: Record<PlayerSlot, Partial<Record<InstrumentId, PlayerVisual>>> = {
    local: {},
    remote: {},
  };
  private playerInstruments: Record<PlayerSlot, InstrumentId> = { local: 'drum', remote: 'starlace' };
  private playerCreatures: Record<PlayerSlot, CreatureId> = { local: 'lion', remote: 'robot' };
  private pendingPartnerInstrument: InstrumentId | null = null;
  private roundDirector!: RoundDirector;
  private sculptor!: EnergySculptor;
  private lastDrumHitAt = -10;
  private lastStarlacePluckAt = -10;
  private lastSynchronyAt = -10;
  private visualContacts: Record<PlayerSlot, HandContactPoint[]> = {
    local: makeHandContactPoints(),
    remote: makeHandContactPoints(),
  };
  // While `introActive` is true the instruments stay hidden and the scenery
  // bird system is held off — the world reads as a still tableau the user is
  // about to step into. exitIntroMode() flips this and runs the per-player
  // intro animations.
  private introActive = true;
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
  readonly paneDock: HTMLElement;
  private roomId: string;
  private roomSeed: number;
  private localPose?: PlayerPose;
  private remotePose?: PlayerPose;
  private partnerPresent = false;
  private robotJamMuted = false;
  private robotJamNextAt = 0;
  private robotJamStep = 0;
  private robotJamActive: RobotJamNote[] = [];
  private robotJamPending: RobotJamPendingNote[] = [];
  private readonly localLeftPalm = new THREE.Vector3();
  private readonly localRightPalm = new THREE.Vector3();
  private readonly remoteLeftPalm = new THREE.Vector3();
  private readonly remoteRightPalm = new THREE.Vector3();
  private readonly robotInstrumentTargets: Record<Handedness, Vec3Data[]> = { left: [], right: [] };
  private readonly robotJamStrikeTarget: Vec3Data = { x: 0, y: 0, z: 0 };
  private hiddenStartedAt: number | null = null;
  constructor(
    private canvas: HTMLCanvasElement,
    urlRoom: string,
    private ui: GameUi
  ) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(1)
    this.paneDock = this.createPaneDock();
    this.setupIntroScenePane();
    this.setupCabinLightingPane();
    this.handTracker = new HandTracker(ui.inputStatus);
    this.audioGraph = new JamAudioGraph();
    this.handSynth = new HandSynthEngine(this.audioGraph, canvas, this.paneDock);
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

    this.localRig = new HumanoidRig(this.scene, { seatIndex: 0, creature: 'lion' });
    this.remoteRig = new HumanoidRig(this.scene, { seatIndex: 1, creature: 'robot' });
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
    this.roundDirector = new RoundDirector(this.paneDock);
    this.sculptor = new EnergySculptor(this.scene, this.sculptureTarget, this.renderer, this.paneDock);
    this.roundDirector.onPlayingStart(() => {
      // endDissolve must run first. If anything below throws (e.g. an instrument
      // swap rejects), emit() would otherwise stay gated on dissolveMode > 0
      // and every drum hit / pluck would silently produce no particles even
      // though audio plays.
      this.sculptor.endDissolve();
      try {
        if (this.pendingPartnerInstrument && this.pendingPartnerInstrument !== this.playerInstruments.remote) {
          if (this.introActive) {
            this.installPlayerVisualImmediate('remote', this.pendingPartnerInstrument);
          } else {
            void this.swapPlayerVisual('remote', this.pendingPartnerInstrument).then(() => this.refreshArchetype());
          }
        }
        this.pendingPartnerInstrument = null;
        this.refreshArchetype();
      } catch (err) {
        console.warn('[Game] onPlayingStart listener failed', err);
      }
    });
    this.roundDirector.onDissolvingStart(() => {
      this.sculptor.beginDissolve();
    });
    this.installPlayerVisuals();
    await this.prewarmPlayerVisuals();
    this.refreshArchetype();
    this.roundDirector.start();
    this.setupPlayersPane();
    this.setupInstrumentsPane();
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
  // window loses focus, so switching to another app silences the bed, drums,
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
    await this.midiInput.start();
  }

  connectMultiplayer(): void {
    this.multiplayer.connect();
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

  onLocalDrumOrbCountChange(listener: (count: number) => void): void {
    this.localDrumOrbCountListeners.add(listener);
    if (this.localDrumOrbCount > 0) listener(this.localDrumOrbCount);
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    const hadMic = !!this.handTracker.getMicStream();
    await this.handTracker.setAudioEnabled(enabled);
    // First time the mic is brought online, the peer connection (if any) was
    // negotiated without an audio m-line — renegotiate so the partner can
    // hear us.
    if (enabled && !hadMic && this.handTracker.getMicStream()) {
      this.webrtc.notifyMicReady();
    }
  }

  setCameraEnabled(enabled: boolean): void {
    this.handTracker.setVideoEnabled(enabled);
  }

  setShareVideoEnabled(enabled: boolean): void {
    this.webrtc.setShareVideo(enabled);
  }

  getMicEnabled(): boolean {
    return this.handTracker.getAudioEnabled();
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

  setDisplayName(name: string): void {
    this.multiplayer.setDisplayName(name);
  }

  getCameraMode(): CameraMode {
    return this.cameraMode;
  }

  setDebugVisible(visible: boolean): void {
    this.sculptor?.setDebugVisible(visible);
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
    this.roundDirector?.dispose();
    this.disposePlayerVisuals();
    this.midiInput.dispose();
    this.handSynth.dispose();
    this.audioGraph.dispose();
    this.cameraTweaks?.dispose();
    this.cabinTweaks?.dispose();
    this.cabinLightingTweaks?.dispose();
    this.introSceneTweaks?.dispose();
    this.playersTweaks?.dispose();
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

  private installPlayerVisuals(): void {
    this.ensurePlayerVisual('local', 'drum');
    this.ensurePlayerVisual('local', 'starlace');
    this.ensurePlayerVisual('remote', 'drum');
    this.ensurePlayerVisual('remote', 'starlace');
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
          this.checkSynchrony();
        },
      });
    } else {
      visual = new Drum(this.scene, paneDock, `drum-${player}`, {
        palette: player,
        creature: this.playerCreatures[player],
        title: `Piano Pads (${player === 'local' ? 'Local' : 'Partner'})`,
        camera: player === 'local' ? this.camera : undefined,
        canvas: player === 'local' ? this.canvas : undefined,
        sculptor: this.sculptor,
        anchor,
        onOrbCountChange: player === 'local' ? count => this.setLocalDrumOrbCount(count) : undefined,
        onHit: hit => {
          if (hit.held && hit.sourceId) {
            this.handSynth.triggerOrbNoteOn(player, hit.sourceId, hit.frequency, hit.velocity, hit.orbIndex, hit.envelope);
          } else {
            this.handSynth.triggerOrbHit(player, hit.frequency, hit.velocity, hit.orbIndex, hit.envelope);
          }
          this.cueRobotInstrumentStrike(player, hit.hand, hit.worldPosition, hit.velocity);
          this.lastDrumHitAt = performance.now() / 1000;
          this.checkSynchrony();
        },
        onRelease: release => {
          this.handSynth.triggerOrbNoteOff(player, release.sourceId, release.envelope);
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
      for (const id of ['drum', 'starlace'] as const) {
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

  private setLocalDrumOrbCount(count: number): void {
    if (count === this.localDrumOrbCount) return;
    this.localDrumOrbCount = count;
    for (const listener of this.localDrumOrbCountListeners) listener(count);
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
    if (Math.abs(this.lastDrumHitAt - this.lastStarlacePluckAt) < 0.4 &&
        now - this.lastSynchronyAt > 0.25) {
      this.lastSynchronyAt = now;
      this.sculptor?.fireSynchrony();
    }
  }

  private handleMidiNoteOn(note: MidiNoteEvent): void {
    this.playerVisuals.local?.triggerMidiNoteOn?.(note.noteNumber, note.velocity, note.sourceId);
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
    const localKind = this.playerInstruments.local === 'starlace' ? 'starlace' : 'drum';
    const remoteKind = this.playerInstruments.remote === 'starlace' ? 'starlace' : 'drum';
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
    this.roundDirector.tick(delta);
    const localSeat = this.multiplayer.localSeatIndex;
    const partnerSeat = this.multiplayer.partnerSeatIndex;
    const hands = this.handTracker.update(elapsed, localSeat);
    const localPose = makePlayerPose(this.multiplayer.localId, 'Player', this.roomId, localSeat, hands, false);
    const remoteFromNetwork = this.poseSession.getRemotePose();
    const robotPerformance = this.partnerPresent ? undefined : this.updateRobotInstrumentTargets();
    const robotHands = this.robotMotion.update(elapsed, delta, localPose, robotPerformance);
    const robotPose = makePlayerPose('robot', 'Robot', this.roomId, partnerSeat, robotHands, true);
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

    this.updatePlayerVisuals(delta, elapsed);
    this.sculptor.setRoundProgress(this.roundDirector.snapshot().progress);
    this.sculptor.update(delta);
    const atmosphere = this.scenery.update(delta, elapsed);
    this.updateAtmosphere(atmosphere);
    this.updateCabinLighting(elapsed);
    this.handSynth.update(localPose, remotePose, delta);
    this.poseSession.sendLocalPose(localPose, elapsed);
    if (this.cameraMode === 'orbit') this.orbitControls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  private updatePlayerVisuals(delta: number, elapsed: number): void {
    const localLeft = this.localRig.getPalmWorld('left', this.localLeftPalm);
    const localRight = this.localRig.getPalmWorld('right', this.localRightPalm);
    const remoteLeft = this.remoteRig.getPalmWorld('left', this.remoteLeftPalm);
    const remoteRight = this.remoteRig.getPalmWorld('right', this.remoteRightPalm);
    // Local contact-based hits are gated on active webcam hand tracking. Without
    // this, the rig's mouse-driven pose sits inside the instrument and triggers
    // continuous hits when the user isn't moving anything. Mouse-on-orb play
    // still works through Drum's pointer gesture path.
    const localContacts = this.handTracker.hasTrackedHands()
      ? this.updateVisualContacts('local', this.localRig)
      : undefined;
    // A real partner plays through hand contacts. The procedural robot keeps
    // moving its hands, but note events come from tickRobotJam() so the robot
    // stays sparse and cannot flood the instrument collision system.
    const remoteContacts = this.partnerPresent
      ? this.updateVisualContacts('remote', this.remoteRig)
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
      return;
    }

    this.releaseDueRobotJamNotes(elapsed);
    this.startDueRobotJamNotes(elapsed);

    const visual = this.playerVisuals.remote;
    if (!visual?.triggerMidiNoteOn) return;
    if (this.robotJamNextAt <= 0) {
      this.scheduleNextRobotJam(elapsed, 1.0);
      return;
    }
    if (this.robotJamActive.length > 0 || this.robotJamPending.length > 0 || elapsed < this.robotJamNextAt) return;

    const instrument = this.playerInstruments.remote;
    const noteCount = this.queueRobotJamGesture(elapsed, instrument);
    this.scheduleNextRobotJam(elapsed, noteCount > 1 ? 0.85 : 0);
  }

  private scheduleNextRobotJam(elapsed: number, extraDelay = 0): void {
    const starlace = this.playerInstruments.remote === 'starlace';
    const min = starlace ? ROBOT_STARLACE_JAM_MIN_DELAY : ROBOT_JAM_MIN_DELAY;
    const max = starlace ? ROBOT_STARLACE_JAM_MAX_DELAY : ROBOT_JAM_MAX_DELAY;
    const breath = this.robotJamStep % 5 === 4 ? 1.25 : 0;
    const swing = hash(this.robotJamStep * 13.73 + this.roomSeed * 0.031);
    this.robotJamNextAt = elapsed + extraDelay + min + swing * (max - min) + breath;
  }

  private queueRobotJamGesture(elapsed: number, instrument: InstrumentId): number {
    const gestureIndex = this.robotJamStep;
    const seed = gestureIndex * 17.17 + this.roomSeed * 0.029;
    const shape = this.pickRobotJamShape(seed);
    const root = ROBOT_JAM_SCALE_ROOTS[Math.floor(hash(seed + 0.11) * ROBOT_JAM_SCALE_ROOTS.length)] ?? 0;
    const longHold = instrument === 'drum' && shape.length === 1 && hash(seed + 0.29) > 0.56;
    const strum = shape.length > 1 ? ROBOT_JAM_STRUM_MAX_OFFSET * (0.35 + hash(seed + 0.41) * 0.65) : 0;

    this.robotJamPending = shape.map((degreeOffset, index) => {
      const startAt = elapsed + index * strum;
      const hold = this.robotJamHoldDuration(instrument, seed, longHold);
      return {
        instrument,
        noteNumber: 36 + root + degreeOffset,
        sourceId: `robot:${gestureIndex}:${index}`,
        startAt,
        releaseAt: startAt + hold,
        velocity: 0.30 + hash(seed + index * 1.91 + 0.67) * 0.32,
        seed: seed + index * 3.07,
      };
    });
    this.robotJamStep += 1;
    return this.robotJamPending.length;
  }

  private pickRobotJamShape(seed: number): readonly number[] {
    const roll = hash(seed + 0.73);
    if (roll < 0.56) return ROBOT_JAM_CHORD_SHAPES[0];
    if (roll < 0.78) return ROBOT_JAM_CHORD_SHAPES[1];
    if (roll < 0.92) return ROBOT_JAM_CHORD_SHAPES[2];
    return ROBOT_JAM_CHORD_SHAPES[3 + Math.floor(hash(seed + 1.31) * 2)] ?? ROBOT_JAM_CHORD_SHAPES[2];
  }

  private robotJamHoldDuration(instrument: InstrumentId, seed: number, longHold: boolean): number {
    if (instrument !== 'drum') return ROBOT_JAM_SHORT_HOLD;
    if (!longHold) return ROBOT_JAM_SHORT_HOLD + hash(seed + 2.17) * 0.18;
    return ROBOT_JAM_LONG_HOLD_MIN + hash(seed + 2.17) * (ROBOT_JAM_LONG_HOLD_MAX - ROBOT_JAM_LONG_HOLD_MIN);
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
    this.remoteRig.worldToPosePoint(hand, targets[index], this.robotJamStrikeTarget);
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

  private updateRobotInstrumentTargets(): RobotPerformanceContext | undefined {
    const worldTargets = this.playerVisuals.remote?.getPerformanceTargets?.();
    if (!worldTargets?.length) return undefined;

    const count = Math.min(worldTargets.length, 32);
    for (const hand of handednesses) {
      const targets = this.robotInstrumentTargets[hand];
      targets.length = 0;
      for (let i = 0; i < count; i += 1) {
        const out = targets[i] ?? { x: 0, y: 0, z: 0 };
        this.remoteRig.worldToPosePoint(hand, worldTargets[i], out);
        targets[i] = out;
      }
      targets.length = count;
    }

    return {
      instrument: this.playerInstruments.remote,
      targets: this.robotInstrumentTargets,
    };
  }

  private updateVisualContacts(
    player: PlayerSlot,
    rig: HumanoidRig,
  ): readonly HandContactPoint[] {
    const contacts = this.visualContacts[player];
    let cursor = 0;

    for (const hand of handednesses) {
      rig.getPalmCenterWorld(hand, contacts[cursor++].position);
      for (const finger of fingerNames) {
        for (const joint of fingerJointNames) {
          rig.getFingerJointWorld(hand, finger, joint, contacts[cursor++].position);
        }
      }
    }

    return contacts;
  }

  // Intro/active state. While intro is enabled the scenery's bird system is
  // held off, the instruments stay hidden, and pointer/keyboard input cannot
  // hit the orbs/starlace. Master visual dimming of the rendered scene is
  // handled in CSS via the canvas's opacity/filter so it lands uniformly on
  // lit and unlit materials.
  exitIntroMode(): void {
    if (!this.introActive) return;
    this.introActive = false;
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
