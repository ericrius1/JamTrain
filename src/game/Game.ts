import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { JamAudioGraph } from './audioGraph';
import { AudioEngine } from './audio';
import { attachHandDepthPane } from './handDepth';
import { HandSynthEngine } from './handSynth';
import { HandTracker } from './handTracking';
import { clamp } from './math';
import { MultiplayerClient } from './multiplayer';
import { Drum } from './visuals/Drum';
import { Starlace } from './visuals/Starlace';
import { RoundDirector } from './RoundDirector';
import { EnergySculptor } from './EnergySculptor';
import { pickArchetype } from './sculptor/archetypeShared';
import type { HandContactPoint, InstrumentId, PlayerVisual } from './instruments';
import { isInstrumentId, normalizeInstrumentId } from './instruments';
import { isCreatureId } from './creatures';
import { makePlayerPose } from './pose';
import { BroadcastChannelPoseTransport } from './pose/BroadcastChannelPoseTransport';
import { PoseSession } from './pose/PoseSession';
import { WebRtcPoseTransport } from './pose/WebRtcPoseTransport';
import { HumanoidRig } from './rig/HumanoidRig';
import { RobotMotionController } from './robotMotion';
import { ScenerySystem } from './scenery';
import { hashString } from './seedRandom';
import { fingerJointNames, fingerNames, handednesses, type PlayerPose } from './types';
import { WebRTCClient } from './webrtc';
import { makeParams, registerTweaks } from '../hud/tweakDefs';

const SHADOWS_DEFS = {
  mapSize:    { default: 2048,    options: { '1024': 1024, '2048': 2048, '4096': 4096 }, label: 'map size' },
  radius:     { default: 6,       min: 0,      max: 20,    step: 0.1,    label: 'radius' },
  normalBias: { default: 0.04,    min: 0,      max: 0.2,   step: 0.001,  label: 'normal bias' },
  bias:       { default: -0.0002, min: -0.005, max: 0.005, step: 0.0001, label: 'bias' },
  blurSamples:{ default: 16,      min: 1,      max: 32,    step: 1,      label: 'blur samples' },
} as const;

const CAMERA_DEFS = {
  fov: { default: 62, min: 30, max: 90, step: 1, label: 'fov' },
} as const;

const PLAYERS_DEFS = {
  backOffset: { default: 0.08, min: -0.4, max: 0.8, step: 0.01, label: 'back offset' },
} as const;

const CABIN_DEFS = {
  bevelRadius:    { default: 0.04, min: 0, max: 0.12, step: 0.005, label: 'bevel radius' },
  furnitureBevel: { default: 0.10, min: 0, max: 0.18, step: 0.005, label: 'furniture bevel' },
  bevelSegments:  { default: 4,    min: 1, max: 8,    step: 1,     label: 'bevel smoothness' },
} as const;

const ILLUSTRATED_CABIN_TEXTURE = '/cabin/illustrated-cabin-plate-v2-color.webp';
const ILLUSTRATED_CABIN_MASK_TEXTURE = '/cabin/illustrated-cabin-plate-v2-alpha.webp';
const ILLUSTRATED_CABIN_ASPECT = 1672 / 941;
const ILLUSTRATED_CABIN_DISTANCE = 3.35;
const ILLUSTRATED_CABIN_OVERSCAN = 1.015;

type GameUi = {
  connectionStatus: HTMLElement;
  inputStatus: HTMLElement;
  musicStatus: HTMLElement;
};

type CameraMode = 'game' | 'orbit';
type PlayerSlot = 'local' | 'remote';

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
  private audio: AudioEngine;
  private handSynth: HandSynthEngine;
  readonly multiplayer: MultiplayerClient;
  private webrtc: WebRTCClient;
  private poseSession!: PoseSession;
  private broadcastTransport!: BroadcastChannelPoseTransport;
  private remoteStreamListeners = new Set<(stream: MediaStream | null) => void>();
  private localRig: HumanoidRig;
  private remoteRig: HumanoidRig;
  private robotMotion: RobotMotionController;
  private scenery: ScenerySystem;
  private ambientLight?: THREE.AmbientLight;
  private keyLight?: THREE.DirectionalLight;
  private cabinLights: { light: THREE.PointLight; baseIntensity: number }[] = [];
  private playerVisuals: Record<PlayerSlot, PlayerVisual | null> = { local: null, remote: null };
  private playerInstruments: Record<PlayerSlot, InstrumentId> = { local: 'drum', remote: 'starlace' };
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
  private musicIntensity = 0;
  private shadowsTweaks?: ReturnType<typeof registerTweaks<typeof SHADOWS_DEFS>>;
  private readonly shadowParams = makeParams(SHADOWS_DEFS);
  private cabinTweaks?: ReturnType<typeof registerTweaks<typeof CABIN_DEFS>>;
  private cabinGroup?: THREE.Group;
  private cabinPlate?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private cabinPlateTexture?: THREE.Texture;
  private cabinPlateMaskTexture?: THREE.Texture;
  private readonly cabinParams = makeParams(CABIN_DEFS);
  private playersTweaks?: ReturnType<typeof registerTweaks<typeof PLAYERS_DEFS>>;
  private readonly playersParams = makeParams(PLAYERS_DEFS);
  readonly paneDock: HTMLElement;
  private roomId: string;
  private roomSeed: number;
  private localPose?: PlayerPose;
  private remotePose?: PlayerPose;
  private partnerPresent = false;
  private robotJamMuted = true;
  private readonly localLeftPalm = new THREE.Vector3();
  private readonly localRightPalm = new THREE.Vector3();
  private readonly remoteLeftPalm = new THREE.Vector3();
  private readonly remoteRightPalm = new THREE.Vector3();
  private readonly ambientBaseColor = new THREE.Color(0x3f2a1d);
  private readonly ambientDayColor = new THREE.Color(0xffc37a);
  private readonly ambientUnderwaterColor = new THREE.Color(0x2ac9d3);
  private readonly keyBaseColor = new THREE.Color(0x9d5f2f);
  private readonly keyDayColor = new THREE.Color(0xffc05a);
  private readonly keyUnderwaterColor = new THREE.Color(0x8dfcff);

  constructor(
    private canvas: HTMLCanvasElement,
    urlRoom: string,
    private ui: GameUi
  ) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(1)
    this.paneDock = this.createPaneDock();
    this.handTracker = new HandTracker(ui.inputStatus);
    this.audioGraph = new JamAudioGraph();
    this.audio = new AudioEngine(this.audioGraph, ui.musicStatus, this.paneDock);
    this.handSynth = new HandSynthEngine(this.audioGraph, canvas, this.paneDock);
    this.multiplayer = new MultiplayerClient(urlRoom, 'Player');
    this.roomId = this.multiplayer.getRoom();
    this.roomSeed = hashString(this.roomId);
    this.multiplayer.onStateChange(state => {
      ui.connectionStatus.textContent = state;
    });
    this.multiplayer.onAssignedRoom(room => {
      this.roomSeed = hashString(room);
      this.scenery.setRoomSeed(this.roomSeed);
    });
    this.multiplayer.onPartnerIdentity(identity => {
      this.partnerPresent = identity !== null;
      this.applyRobotMute();
    });

    this.webrtc = new WebRTCClient(
      this.multiplayer,
      () => this.handTracker.getStream()
    );
    this.webrtc.onRemoteStream(stream => {
      for (const listener of this.remoteStreamListeners) listener(stream);
    });

    this.broadcastTransport = new BroadcastChannelPoseTransport(this.roomId);
    const webrtcTransport = new WebRtcPoseTransport(this.webrtc);
    this.poseSession = new PoseSession(
      [webrtcTransport, this.broadcastTransport],
      {
        localId: this.multiplayer.localId,
        getRoomId: () => this.multiplayer.getRoom(),
        getPartnerSeatIndex: () => this.multiplayer.partnerSeatIndex,
      }
    );

    this.multiplayer.onAssignedRoom(room => {
      this.broadcastTransport.setRoomId(room);
      this.poseSession.clearRemotePose();
    });
    this.multiplayer.onPartnerIdentity(() => this.poseSession.clearRemotePose());

    this.localRig = new HumanoidRig(this.scene, { seatIndex: 0, color: 0x2d7f8c, creature: 'lion' });
    this.remoteRig = new HumanoidRig(this.scene, { seatIndex: 1, color: 0x8c4a7b, creature: 'robot' });
    this.localRig.setFingertipNodesVisible(false);
    this.remoteRig.setFingertipNodesVisible(false);
    this.applyPlayerBackOffset();
    this.multiplayer.onSeatChange((localSeat, partnerSeat) => {
      this.localRig.setSeatIndex(localSeat);
      this.remoteRig.setSeatIndex(partnerSeat);
      this.applyPlayerBackOffset();
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
    this.sculptor = new EnergySculptor(this.scene, this.sculptureTarget, this.paneDock);
    this.roundDirector.onPlayingStart(() => {
      if (this.pendingPartnerInstrument && this.pendingPartnerInstrument !== this.playerInstruments.remote) {
        this.installPlayerVisual('remote', this.pendingPartnerInstrument);
      }
      this.pendingPartnerInstrument = null;
      this.refreshArchetype();
      this.sculptor.endDissolve();
    });
    this.roundDirector.onDissolvingStart(() => {
      this.sculptor.beginDissolve();
    });
    this.installPlayerVisuals();
    this.refreshArchetype();
    this.roundDirector.start();
    this.setupShadowsPane();
    this.setupPlayersPane();
    this.handTracker.attachPane(this.paneDock);
    attachHandDepthPane(this.paneDock);
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
    const inactive = document.hidden || !document.hasFocus();
    if (inactive) this.handSynth.silenceAll();
    void this.audioGraph.setSuspended(inactive);
  };

  async startCamera(): Promise<void> {
    await this.handTracker.startCamera();
    this.webrtc.notifyLocalStreamReady();
  }

  async startAudio(): Promise<void> {
    await this.audioGraph.start();
    await this.audio.start();
    await this.handSynth.start();
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

  setMicEnabled(enabled: boolean): void {
    this.handTracker.setAudioEnabled(enabled);
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

  // Bed + drums backing track.
  setBackingVolume(value: number): void {
    this.audio.setMasterGain(value);
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
    this.handSynth.setMuted('remote', !this.partnerPresent && this.robotJamMuted);
  }

  setDisplayName(name: string): void {
    this.multiplayer.setDisplayName(name);
  }

  getCameraMode(): CameraMode {
    return this.cameraMode;
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
    this.playerVisuals.local?.dispose();
    this.playerVisuals.remote?.dispose();
    this.audio.dispose();
    this.handSynth.dispose();
    this.audioGraph.dispose();
    this.cameraTweaks?.dispose();
    this.shadowsTweaks?.dispose();
    this.cabinTweaks?.dispose();
    this.playersTweaks?.dispose();
    this.disposeCabinPlate();
    this.paneDock.remove();
    this.renderer.dispose();
  }

  private setupRenderer(): void {
    this.renderer.setClearColor(0x050403, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    this.orbitControls.minDistance = 1.8;
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

  private setupShadowsPane(): void {
    if (!this.keyLight || this.shadowsTweaks) return;
    this.shadowsTweaks = registerTweaks(this.paneDock, 'shadows', SHADOWS_DEFS, {
      title: 'Shadows',
      params: this.shadowParams,
      onChange: {
        mapSize: v => {
          if (!this.keyLight) return;
          this.keyLight.shadow.mapSize.set(v, v);
          this.keyLight.shadow.map?.dispose();
          this.keyLight.shadow.map = null;
        },
        radius:      v => { if (this.keyLight) this.keyLight.shadow.radius = v; },
        normalBias:  v => { if (this.keyLight) this.keyLight.shadow.normalBias = v; },
        bias:        v => { if (this.keyLight) this.keyLight.shadow.bias = v; },
        blurSamples: v => { if (this.keyLight) this.keyLight.shadow.blurSamples = v; },
      },
    });
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

  private createCabin(): void {
    this.scenery.build();
    this.buildIllustratedCabinPlate();
    this.scenery.setThunderHandler(delay => this.audio.playThunder(delay));

    for (const z of [-4.65, -3.1, -1.55, 0, 1.55, 3.1, 4.65]) {
      const isHero = Math.abs(z) < 1.7;
      const baseIntensity = isHero ? 0.55 : 0.32;
      const light = new THREE.PointLight(0xf5a33b, baseIntensity, 3.2, 1.4);
      light.position.set(0, 2.34, z);
      this.scene.add(light);
      this.cabinLights.push({ light, baseIntensity });
    }

    this.ambientLight = new THREE.AmbientLight(0x7d5a35, 0.72);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xffbd54, 1.65);
    this.keyLight.position.set(-2.8, 4.2, 3.5);
    this.keyLight.castShadow = true;
    this.keyLight.target.position.set(0, 1, 0);
    this.scene.add(this.keyLight.target);
    const shadowCam = this.keyLight.shadow.camera as THREE.OrthographicCamera;
    shadowCam.left = -3.4;
    shadowCam.right = 3.4;
    shadowCam.top = 6.0;
    shadowCam.bottom = -6.0;
    shadowCam.near = 0.5;
    shadowCam.far = 16;
    shadowCam.updateProjectionMatrix();
    this.keyLight.shadow.mapSize.set(this.shadowParams.mapSize, this.shadowParams.mapSize);
    this.keyLight.shadow.radius = this.shadowParams.radius;
    this.keyLight.shadow.bias = this.shadowParams.bias;
    this.keyLight.shadow.normalBias = this.shadowParams.normalBias;
    this.keyLight.shadow.blurSamples = this.shadowParams.blurSamples;
    this.scene.add(this.keyLight);
  }

  private buildIllustratedCabinPlate(): void {
    this.disposeCabinPlate();
    const texture = new THREE.TextureLoader().load(ILLUSTRATED_CABIN_TEXTURE, tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
    });
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    this.cabinPlateTexture = texture;

    const maskTexture = new THREE.TextureLoader().load(ILLUSTRATED_CABIN_MASK_TEXTURE, tex => {
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
    });
    maskTexture.colorSpace = THREE.NoColorSpace;
    maskTexture.generateMipmaps = true;
    this.cabinPlateMaskTexture = maskTexture;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      alphaMap: maskTexture,
      transparent: true,
      alphaTest: 0.5,
      blending: THREE.NoBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.name = 'illustrated-cabin-plate';
    mesh.frustumCulled = false;
    mesh.renderOrder = -6;
    this.cabinPlate = mesh;
    this.scene.add(mesh);
    this.updateCabinPlateTransform();
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
    this.cabinPlate.geometry.dispose();
    this.cabinPlate.material.dispose();
    this.cabinPlateTexture?.dispose();
    this.cabinPlateMaskTexture?.dispose();
    this.cabinPlate = undefined;
    this.cabinPlateTexture = undefined;
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
    floor.receiveShadow = true;
    group.add(floor);

    const ceilingY = 2.55;
    const ceiling = new THREE.Mesh(this.roundedBox(3.45, 0.08, cabinZ, wallR), ceilingMat);
    ceiling.position.y = ceilingY;
    ceiling.receiveShadow = true;
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
      lowerWall.receiveShadow = true;
      group.add(lowerWall);

      const upperWall = new THREE.Mesh(this.roundedBox(0.08, upperWallHeight, cabinZ, wallR), wallMat);
      upperWall.position.set(x, glassTop + upperWallHeight / 2, 0);
      upperWall.receiveShadow = true;
      group.add(upperWall);

      for (const zSign of [-1, 1]) {
        const endCap = new THREE.Mesh(this.roundedBox(0.08, endCapHeight, endCapDepth, wallR), wallMat);
        endCap.position.set(x, 0.06 + endCapHeight / 2, zSign * (glassSpan / 2 + endCapDepth / 2));
        endCap.receiveShadow = true;
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
        bench.castShadow = true;
        bench.receiveShadow = true;
        group.add(bench);

        const back = new THREE.Mesh(this.roundedBox(1.35, 0.74, 0.18, seatR), seatMat);
        back.position.set(0, 0.78, z + (dz > 0 ? 0.32 : -0.32));
        back.rotation.x = dz > 0 ? -0.1 : 0.1;
        back.castShadow = true;
        back.receiveShadow = true;
        group.add(back);
      }

      const table = new THREE.Mesh(this.roundedBox(1.15, 0.06, 0.64, seatR), woodMat);
      table.position.set(0, 0.72, cz);
      table.castShadow = true;
      table.receiveShadow = true;
      group.add(table);

      const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.68, 16), woodMat);
      tableLeg.position.set(0, 0.36, cz);
      tableLeg.castShadow = true;
      tableLeg.receiveShadow = true;
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

  private installPlayerVisuals(): void {
    this.installPlayerVisual('local', this.playerInstruments.local);
    this.installPlayerVisual('remote', this.playerInstruments.remote);
  }

  private installPlayerVisual(player: PlayerSlot, id: InstrumentId): void {
    this.playerVisuals[player]?.dispose();
    this.playerInstruments[player] = id;

    const seatIndex = player === 'local' ? this.multiplayer.localSeatIndex : this.multiplayer.partnerSeatIndex;
    const anchor = this.computeInstrumentAnchor(seatIndex);
    if (id === 'starlace') {
      this.playerVisuals[player] = new Starlace(this.scene, this.paneDock, `starlace-${player}`, {
        palette: player,
        title: `Starlace (${player === 'local' ? 'Local' : 'Partner'})`,
        sculptor: this.sculptor,
        anchor,
        onPluck: pluck => {
          this.handSynth.triggerStarlacePluck(player, pluck.frequency, pluck.velocity, pluck.nodeIndex, pluck.x, pluck.y);
          this.lastStarlacePluckAt = performance.now() / 1000;
          this.checkSynchrony();
        },
      });
    } else {
      this.playerVisuals[player] = new Drum(this.scene, this.paneDock, `drum-${player}`, {
        palette: player,
        title: `Drum (${player === 'local' ? 'Local' : 'Partner'})`,
        camera: player === 'local' ? this.camera : undefined,
        canvas: player === 'local' ? this.canvas : undefined,
        sculptor: this.sculptor,
        anchor,
        onHit: hit => {
          this.handSynth.triggerOrbHit(player, hit.frequency, hit.velocity, hit.orbIndex);
          this.lastDrumHitAt = performance.now() / 1000;
          this.checkSynchrony();
        },
        onGesture: gesture => {
          this.handSynth.setOrbGesture(player, gesture);
        },
      });
    }
    this.handSynth.setInstrument(player, id);
  }

  /**
   * Where this seat's instrument visual lives. Anchored in front of the
   * seated player (between them and the cabin center) so the visual stays
   * with the player instead of drifting toward whatever the hands average.
   * Seat 0 sits at +Z in cabin space; seat 1 at -Z.
   */
  private computeInstrumentAnchor(seatIndex: number): THREE.Vector3 {
    const dir = seatIndex === 0 ? 1 : -1;
    return new THREE.Vector3(0, 1.05, dir * 0.55);
  }

  private checkSynchrony(): void {
    const now = performance.now() / 1000;
    if (Math.abs(this.lastDrumHitAt - this.lastStarlacePluckAt) < 0.4 &&
        now - this.lastSynchronyAt > 0.25) {
      this.lastSynchronyAt = now;
      this.sculptor?.fireSynchrony();
    }
  }

  setPlayerInstrument(player: PlayerSlot, id: string): void {
    if (!isInstrumentId(id)) return;
    if (player === 'remote') {
      // Queue partner-instrument changes so the in-progress sculpture's
      // archetype doesn't shift mid-round. Applied on the next playing edge.
      if (this.playerInstruments.remote !== id) this.pendingPartnerInstrument = id;
      return;
    }
    if (this.playerInstruments[player] === id) return;
    this.installPlayerVisual(player, id);
    this.refreshArchetype();
  }

  private refreshArchetype(): void {
    const localKind = this.playerInstruments.local === 'starlace' ? 'starlace' : 'drum';
    const remoteKind = this.playerInstruments.remote === 'starlace' ? 'starlace' : 'drum';
    this.sculptor?.setArchetype(pickArchetype(localKind, remoteKind));
  }

  setPlayerCreature(player: PlayerSlot, id: string): void {
    if (!isCreatureId(id)) {
      console.warn('[game] setPlayerCreature: invalid id', id);
      return;
    }
    const rig = player === 'local' ? this.localRig : this.remoteRig;
    rig.setCreature(id);
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
    const robotHands = this.robotMotion.update(elapsed, delta, localPose);
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

    this.updatePlayerVisuals(delta);
    this.sculptor.setRoundProgress(this.roundDirector.snapshot().progress);
    this.sculptor.update(delta);
    const atmosphere = this.scenery.update(delta, elapsed);
    this.updateAtmosphere(atmosphere);
    this.audio.update(localPose, remotePose, atmosphere.daylight, delta);
    this.handSynth.update(localPose, remotePose, delta);
    this.updateMusicReactivity(delta);
    this.poseSession.sendLocalPose(localPose, elapsed);
    if (this.cameraMode === 'orbit') this.orbitControls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  private updatePlayerVisuals(delta: number): void {
    const localLeft = this.localRig.getPalmWorld('left', this.localLeftPalm);
    const localRight = this.localRig.getPalmWorld('right', this.localRightPalm);
    const remoteLeft = this.remoteRig.getPalmWorld('left', this.remoteLeftPalm);
    const remoteRight = this.remoteRig.getPalmWorld('right', this.remoteRightPalm);
    const localContacts = this.updateVisualContacts('local', this.localRig);
    const remoteContacts = this.updateVisualContacts('remote', this.remoteRig);
    const localVoice = this.handSynth.getVoiceState('local');
    const remoteVoice = this.handSynth.getVoiceState('remote');

    this.playerVisuals.local?.update(localLeft, localRight, localVoice, delta, localContacts);
    this.playerVisuals.remote?.update(remoteLeft, remoteRight, remoteVoice, delta, remoteContacts);
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

  private updateMusicReactivity(delta: number): void {
    // Combine drum hits + synth note attacks into a single 0..1 pulse, plus a
    // gentle sustained "music is happening" baseline. Smoothed so the visuals
    // breathe rather than strobe.
    const drumPulse = this.audio.getDrumPulse();
    const drumLevel = this.audio.getDrumLevel();
    const notePulse = this.handSynth.getNotePulse();
    const synthActivity = this.handSynth.getActivity();
    const sustained = clamp(drumLevel * 0.55 + synthActivity * 0.4, 0, 1);
    const pulse = Math.max(drumPulse, notePulse);
    const targetIntensity = clamp(sustained * 0.45 + pulse * 0.85, 0, 1);

    const alpha = 1 - Math.exp(-delta * 7);
    this.musicIntensity += (targetIntensity - this.musicIntensity) * alpha;

    // Cabin lights: very subtle warm breath. Drum kicks give a tiny bump,
    // sustained activity adds a touch of overall warmth. Stays under ±10%
    // of the baseline so it never reads as harsh strobing.
    const lightMod = 1 + drumPulse * 0.06 + sustained * 0.05;
    for (const entry of this.cabinLights) {
      entry.light.intensity = entry.baseIntensity * lightMod;
    }
  }

  private updateAtmosphere(atmosphere: { background: THREE.Color; daylight: number; night: number; underwater?: number }): void {
    const underwater = atmosphere.underwater ?? 0;
    this.scene.background = atmosphere.background;
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(atmosphere.background);

    if (this.ambientLight) {
      this.ambientLight.color
        .copy(this.ambientBaseColor)
        .lerp(this.ambientDayColor, atmosphere.daylight * 0.62)
        .lerp(this.ambientUnderwaterColor, underwater * 0.82);
      this.ambientLight.intensity = 0.38 + atmosphere.daylight * 0.48 + atmosphere.night * 0.14 + underwater * 0.16;
    }
    if (this.keyLight) {
      this.keyLight.color
        .copy(this.keyBaseColor)
        .lerp(this.keyDayColor, atmosphere.daylight)
        .lerp(this.keyUnderwaterColor, underwater * 0.78);
      this.keyLight.intensity = 0.58 + atmosphere.daylight * 1.35 + atmosphere.night * 0.18 - underwater * 0.34;
      this.keyLight.position.set(-2.8, 3.1 + atmosphere.daylight * 1.5 + underwater * 0.55, 3.5);
    }
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
