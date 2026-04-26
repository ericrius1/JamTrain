import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { AudioEngine } from './audio';
import { attachHandDepthPane } from './handDepth';
import { HandSynthEngine } from './handSynth';
import { HandTracker } from './handTracking';
import { clamp, distance, fromThree } from './math';
import { MultiplayerClient } from './multiplayer';
import { LinkParticles } from './particles';
import { PlasmaOrb, type PlasmaOrbMetaball } from './plasmaOrb';
import { makePlayerPose } from './pose';
import { PlayerRig } from './rig';
import { RobotMotionController } from './robotMotion';
import { ScenerySystem } from './scenery';
import { hashString, roomEpoch } from './seedRandom';
import { fingerNames, handednesses, type LinkSample, type PlayerPose } from './types';
import { WebRTCClient } from './webrtc';
import { makeParams, registerTweaks } from '../hud/tweakDefs';

const SHADOWS_DEFS = {
  mapSize:    { default: 2048,    options: { '1024': 1024, '2048': 2048, '4096': 4096 }, label: 'map size' },
  radius:     { default: 6,       min: 0,      max: 20,    step: 0.1,    label: 'radius' },
  normalBias: { default: 0.04,    min: 0,      max: 0.2,   step: 0.001,  label: 'normal bias' },
  bias:       { default: -0.0002, min: -0.005, max: 0.005, step: 0.0001, label: 'bias' },
  blurSamples:{ default: 16,      min: 1,      max: 32,    step: 1,      label: 'blur samples' },
} as const;

const CAMERA_DOLLY_DEFS = {
  fovWide:          { default: 62,   min: 30,  max: 90,  step: 1,    label: 'fov wide' },
  fovNarrow:        { default: 66,   min: 30,  max: 100, step: 1,    label: 'fov narrow' },
  dollyBackMeters:  { default: 2.4,  min: 0,   max: 5,   step: 0.05, label: 'dolly back m' },
  riseMeters:       { default: 0.18, min: 0,   max: 1,   step: 0.01, label: 'rise m' },
  narrowAspect:     { default: 0.55, min: 0.3, max: 1.5, step: 0.01, label: 'narrow aspect' },
  smoothingSeconds: { default: 0.45, min: 0,   max: 2,   step: 0.01, label: 'lag sec' },
} as const;

const PLAYERS_DEFS = {
  backOffset: { default: -0.14, min: -0.4, max: 0.8, step: 0.01, label: 'back offset' },
} as const;

const CABIN_DEFS = {
  bevelRadius:    { default: 0.04, min: 0, max: 0.12, step: 0.005, label: 'bevel radius' },
  furnitureBevel: { default: 0.10, min: 0, max: 0.18, step: 0.005, label: 'furniture bevel' },
  bevelSegments:  { default: 4,    min: 1, max: 8,    step: 1,     label: 'bevel smoothness' },
} as const;

type GameUi = {
  connectionStatus: HTMLElement;
  inputStatus: HTMLElement;
  musicStatus: HTMLElement;
};

type CameraMode = 'game' | 'orbit';

export class Game {
  private renderer: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.05, 90);
  private orbitControls?: OrbitControls;
  private cameraMode: CameraMode = 'game';
  private readonly gameCameraPosition = new THREE.Vector3(1.48, 1.34, 0.56);
  private readonly gameCameraTarget = new THREE.Vector3(-0.18, 1.06, 0);
  // Anchor pose for the design aspect (1920×1014). The dolly system pulls
  // the camera back along the view direction from this anchor as the
  // viewport narrows.
  private readonly designCameraPos = new THREE.Vector3(1.66, 1.34, 0.02);
  private readonly designCameraTarget = new THREE.Vector3(-0.12, 1.06, 0);
  private readonly _backDir = new THREE.Vector3();
  private readonly cameraDolly = makeParams(CAMERA_DOLLY_DEFS);
  private dollyT = 0;
  private cameraTweaks?: ReturnType<typeof registerTweaks<typeof CAMERA_DOLLY_DEFS>>;
  private readonly sculptureTarget = new THREE.Vector3(0, 1.08, 0);
  private startedAt = performance.now();
  private lastFrameAt = this.startedAt;
  readonly handTracker: HandTracker;
  private audio: AudioEngine;
  private handSynth: HandSynthEngine;
  private multiplayer: MultiplayerClient;
  private webrtc: WebRTCClient;
  private remoteStreamListeners = new Set<(stream: MediaStream | null) => void>();
  private localRig: PlayerRig;
  private remoteRig: PlayerRig;
  private particles: LinkParticles;
  private robotMotion: RobotMotionController;
  private linkPositions = new Float32Array(10 * 2 * 3);
  private linkGeometry = new THREE.BufferGeometry();
  private linkLines: THREE.LineSegments;
  private scenery: ScenerySystem;
  private ambientLight?: THREE.AmbientLight;
  private keyLight?: THREE.DirectionalLight;
  private cabinLights: { light: THREE.PointLight; baseIntensity: number }[] = [];
  private plasmaOrb?: PlasmaOrb;
  private musicIntensity = 0;
  private shadowsTweaks?: ReturnType<typeof registerTweaks<typeof SHADOWS_DEFS>>;
  private readonly shadowParams = makeParams(SHADOWS_DEFS);
  private cabinTweaks?: ReturnType<typeof registerTweaks<typeof CABIN_DEFS>>;
  private cabinGroup?: THREE.Group;
  private readonly cabinParams = makeParams(CABIN_DEFS);
  private playersTweaks?: ReturnType<typeof registerTweaks<typeof PLAYERS_DEFS>>;
  private readonly playersParams = makeParams(PLAYERS_DEFS);
  readonly paneDock: HTMLElement;
  private roomId: string;
  private roomSeed: number;
  private sharedEpoch: number;
  private localPose?: PlayerPose;
  private remotePose?: PlayerPose;

  constructor(
    private canvas: HTMLCanvasElement,
    urlRoom: string,
    private ui: GameUi
  ) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(1)
    this.paneDock = this.createPaneDock();
    this.handTracker = new HandTracker(ui.inputStatus);
    this.audio = new AudioEngine(ui.musicStatus, this.paneDock);
    this.handSynth = new HandSynthEngine(canvas, this.paneDock);
    this.multiplayer = new MultiplayerClient(urlRoom, 'Player');
    this.roomId = this.multiplayer.getRoom();
    this.roomSeed = hashString(this.roomId);
    this.sharedEpoch = roomEpoch();
    this.multiplayer.onStateChange(state => {
      ui.connectionStatus.textContent = state;
    });
    this.multiplayer.onAssignedRoom(room => {
      this.roomSeed = hashString(room);
      this.scenery.setRoomSeed(this.roomSeed);
    });

    this.webrtc = new WebRTCClient(
      this.multiplayer,
      () => this.handTracker.getStream()
    );
    this.webrtc.onRemoteStream(stream => {
      for (const listener of this.remoteStreamListeners) listener(stream);
    });

    this.localRig = new PlayerRig(this.scene, { seatIndex: 0, color: 0x2d7f8c });
    this.remoteRig = new PlayerRig(this.scene, { seatIndex: 1, color: 0x8c4a7b, robot: true });
    this.localRig.setFingertipNodesVisible(false);
    this.remoteRig.setFingertipNodesVisible(false);
    this.applyPlayerBackOffset();
    this.multiplayer.onSeatChange((localSeat, partnerSeat) => {
      this.localRig.setSeatIndex(localSeat);
      this.remoteRig.setSeatIndex(partnerSeat);
      this.applyPlayerBackOffset();
    });
    this.particles = new LinkParticles(this.scene);
    this.robotMotion = new RobotMotionController(this.paneDock);
    this.scenery = new ScenerySystem(this.scene, this.paneDock, {
      roomSeed: this.roomSeed,
      sharedEpoch: this.sharedEpoch,
    });

    this.linkGeometry.setAttribute('position', new THREE.BufferAttribute(this.linkPositions, 3));
    const linkMaterial = new THREE.LineBasicMaterial({
      color: 0xaefcff,
      transparent: true,
      opacity: 0.52,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.linkLines = new THREE.LineSegments(this.linkGeometry, linkMaterial);
    this.linkLines.frustumCulled = false;
    this.scene.add(this.linkLines);
  }

  async start(): Promise<void> {
    this.setupRenderer();
    this.setupCamera();
    this.createCabin();
    await this.renderer.init();
    this.setupOrbitControls();
    this.particles.initialize(this.renderer);
    this.plasmaOrb = new PlasmaOrb(this.scene, {
      position: this.sculptureTarget,
      radius: 0.42,
      paneDock: this.paneDock,
    });
    this.setupShadowsPane();
    this.setupPlayersPane();
    this.handTracker.attachPane(this.paneDock);
    attachHandDepthPane(this.paneDock);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.update());
  }

  async startCamera(): Promise<void> {
    await this.handTracker.startCamera();
    this.webrtc.notifyLocalStreamReady();
  }

  async startAudio(): Promise<void> {
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

  setMusicVolume(value: number): void {
    this.audio.setMasterGain(value);
  }

  getMusicVolume(): number {
    return this.audio.getMasterGain();
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
    this.handTracker.dispose();
    this.multiplayer.dispose();
    this.webrtc.dispose();
    this.robotMotion.dispose();
    this.scenery.dispose();
    this.plasmaOrb?.dispose();
    this.audio.dispose();
    this.handSynth.dispose();
    this.cameraTweaks?.dispose();
    this.shadowsTweaks?.dispose();
    this.cabinTweaks?.dispose();
    this.playersTweaks?.dispose();
    this.paneDock.remove();
    this.renderer.dispose();
  }

  private setupRenderer(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x071013, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(0x071013);
    this.scene.fog = new THREE.Fog(0x071013, 7, 22);
  }

  private setupCamera(): void {
    // Snap to the aspect-derived target so the first frame doesn't animate
    // in from the wide pose.
    this.dollyT = this.computeDollyTarget();
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

  private computeDollyTarget(): number {
    // 0 at the design aspect (or wider); 1 at the configured narrow aspect.
    const ref = 1920 / 1014;
    const span = Math.max(0.0001, ref - this.cameraDolly.narrowAspect);
    return THREE.MathUtils.clamp((ref - this.camera.aspect) / span, 0, 1);
  }

  private updateCameraDolly(delta: number): void {
    // Exponential smoothing toward the aspect-derived target so a window
    // resize feels like a graceful dolly rather than a snap.
    const target = this.computeDollyTarget();
    const tau = this.cameraDolly.smoothingSeconds;
    const alpha = tau <= 0 ? 1 : 1 - Math.exp(-delta / tau);
    this.dollyT += (target - this.dollyT) * alpha;
    this.lockGameCamera();
  }

  private lockGameCamera(): void {
    const t = this.dollyT;
    const p = this.cameraDolly;
    this.camera.fov = THREE.MathUtils.lerp(p.fovWide, p.fovNarrow, t);
    this._backDir.subVectors(this.designCameraPos, this.designCameraTarget).normalize();
    this.gameCameraPosition
      .copy(this.designCameraPos)
      .addScaledVector(this._backDir, p.dollyBackMeters * t);
    this.gameCameraPosition.y += p.riseMeters * t;
    this.gameCameraTarget.copy(this.designCameraTarget);
    this.camera.position.copy(this.gameCameraPosition);
    this.camera.lookAt(this.gameCameraTarget);
    this.camera.updateProjectionMatrix();
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
    this.cameraTweaks = registerTweaks(this.paneDock, 'cameraDolly', CAMERA_DOLLY_DEFS, {
      title: 'Camera Dolly',
      params: this.cameraDolly,
    });
  }

  private createCabin(): void {
    this.buildCabinGeometry();
    this.scenery.build();
    this.scenery.setThunderHandler(delay => this.audio.playThunder(delay));

    for (const z of [-4.65, -3.1, -1.55, 0, 1.55, 3.1, 4.65]) {
      const isHero = Math.abs(z) < 1.7;
      const baseIntensity = isHero ? 0.55 : 0.32;
      const light = new THREE.PointLight(0xffb069, baseIntensity, 3.2, 1.4);
      light.position.set(0, 2.34, z);
      this.scene.add(light);
      this.cabinLights.push({ light, baseIntensity });
    }

    this.setupCabinPane();

    this.ambientLight = new THREE.AmbientLight(0x9fb9c1, 0.92);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xf7cf72, 1.45);
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

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x231b18, roughness: 0.86, metalness: 0.0 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a2024, roughness: 0.92, metalness: 0.0 });
    const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.98, metalness: 0.0 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x6e9684, roughness: 0.68, metalness: 0.22 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x9c7e4d, roughness: 0.58, metalness: 0.08 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x4c233b, roughness: 0.7, metalness: 0.02 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xb5dbe6,
      transparent: true,
      opacity: 0.14,
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

    const glassBottom = 0.19;
    const glassTop = 2.38;
    const glassHeight = glassTop - glassBottom;
    const glassY = (glassBottom + glassTop) / 2;
    const paneDepth = 1.32;
    const glassZs = [-3.96, -2.64, -1.32, 0, 1.32, 2.64, 3.96];
    const glassSpan = glassZs.length * paneDepth;
    const frameThick = 0.025;
    const frameOuterSpan = glassSpan + frameThick;

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

      const topRail = new THREE.Mesh(this.roundedBox(frameThick, frameThick, frameOuterSpan, wallR), trimMat);
      topRail.position.set(frameX, glassTop + frameThick / 2, 0);
      group.add(topRail);

      const bottomRail = new THREE.Mesh(this.roundedBox(frameThick, frameThick, frameOuterSpan, wallR), trimMat);
      bottomRail.position.set(frameX, glassBottom - frameThick / 2, 0);
      group.add(bottomRail);

      for (const z of [-glassSpan / 2 - frameThick / 2, glassSpan / 2 + frameThick / 2]) {
        const endPost = new THREE.Mesh(this.roundedBox(frameThick, glassHeight, frameThick, wallR), trimMat);
        endPost.position.set(frameX, glassY, z);
        group.add(endPost);
      }

      for (let i = 0; i < glassZs.length - 1; i += 1) {
        const mullionZ = (glassZs[i] + glassZs[i + 1]) / 2;
        const mullion = new THREE.Mesh(this.roundedBox(frameThick, glassHeight, frameThick, wallR), trimMat);
        mullion.position.set(frameX, glassY, mullionZ);
        group.add(mullion);
      }

      for (const z of glassZs) {
        const windowPane = new THREE.Mesh(new THREE.BoxGeometry(0.035, glassHeight, paneDepth), glassMat);
        windowPane.position.set(x * 1.005, glassY, z);
        windowPane.renderOrder = 2;
        group.add(windowPane);
      }
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

    const fixtureMat = new THREE.MeshBasicMaterial({ color: 0xd9a974 });
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
    this.playersTweaks = registerTweaks(this.paneDock, 'players', PLAYERS_DEFS, {
      title: 'Players',
      params: this.playersParams,
      onChange: {
        backOffset: () => this.applyPlayerBackOffset(),
      },
    });
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
    const hands = this.handTracker.update(elapsed);
    const localSeat = this.multiplayer.localSeatIndex;
    const partnerSeat = this.multiplayer.partnerSeatIndex;
    const localPose = makePlayerPose(this.multiplayer.localId, 'Player', this.roomId, localSeat, hands, false);
    const remoteFromNetwork = this.multiplayer.getRemotePose();
    const robotHands = this.robotMotion.update(elapsed, delta, localPose);
    const robotPose = makePlayerPose('robot', 'Robot', this.roomId, partnerSeat, robotHands, true);
    const remotePose = remoteFromNetwork ?? robotPose;
    const robotTarget = remoteFromNetwork ? 0 : 1;

    this.localPose = localPose;
    this.remotePose = remotePose;
    this.localRig.update(localPose, delta, 0);
    this.remoteRig.update(remotePose, delta, robotTarget);

    const links = this.updateLinks();
    this.plasmaOrb?.update(elapsed, delta);
    this.particles.update(this.renderer, links, elapsed);
    const atmosphere = this.scenery.update(delta, elapsed);
    this.updateAtmosphere(atmosphere);
    this.audio.update(localPose, remotePose, atmosphere.daylight, delta);
    this.handSynth.update(localPose, remotePose, delta);
    this.updateMusicReactivity(delta);
    this.multiplayer.sendPose(localPose, elapsed);
    if (this.cameraMode === 'game') this.updateCameraDolly(delta);
    if (this.cameraMode === 'orbit') this.orbitControls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  private updateLinks(): LinkSample[] {
    const links: LinkSample[] = [];
    const metaballs: PlasmaOrbMetaball[] = [];
    let cursor = 0;

    // Confidence threshold separating real camera detections (~0.7+) from
    // simulated/neutral fallback poses (0.35). Untracked hands shouldn't
    // feed phantom metaballs into the orb.
    const TRACK_THRESHOLD = 0.5;

    for (const handedness of handednesses) {
      const localTracked = (this.localPose?.hands[handedness].confidence ?? 0) >= TRACK_THRESHOLD;
      const remoteTracked = (this.remotePose?.hands[handedness].confidence ?? 0) >= TRACK_THRESHOLD;
      for (const finger of fingerNames) {
        const from = this.localRig.getFingertipWorld(handedness, finger);
        const to = this.remoteRig.getFingertipWorld(handedness, finger);
        // Every fingertip feeds the same metaball field. Whether it visibly
        // tendrils into the central orb is governed by distance + the orb's
        // own influence reach (uOrbReach), not by tracking — default-pose
        // hands are positioned beyond the orb's reach.
        metaballs.push(
          { id: `local:${handedness}:${finger}`, position: from, tracked: localTracked },
          { id: `remote:${handedness}:${finger}`, position: to, tracked: remoteTracked },
        );
        const fromData = fromThree(from);
        const toData = fromThree(to);
        const tension = clamp(1.25 - Math.abs(distance(fromData, toData) - 1.1) * 0.42, 0.08, 1);
        links.push({ from: fromData, to: toData, finger, hand: handedness, tension });

        this.linkPositions[cursor++] = from.x;
        this.linkPositions[cursor++] = from.y;
        this.linkPositions[cursor++] = from.z;
        this.linkPositions[cursor++] = to.x;
        this.linkPositions[cursor++] = to.y;
        this.linkPositions[cursor++] = to.z;
      }
    }

    this.linkGeometry.attributes.position.needsUpdate = true;
    const material = this.linkLines.material as THREE.LineBasicMaterial;
    const energy = links.reduce((sum, link) => sum + link.tension, 0) / Math.max(links.length, 1);
    material.opacity = 0.18 + energy * 0.48;
    if (this.plasmaOrb) {
      this.plasmaOrb.setFingertips(metaballs);
      this.plasmaOrb.setEnergy(energy);
    }
    return links;
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

    this.plasmaOrb?.setMusicIntensity(this.musicIntensity);
    this.particles.setMusicIntensity(this.musicIntensity * 0.7);

    // Cabin lights: very subtle warm breath. Drum kicks give a tiny bump,
    // sustained activity adds a touch of overall warmth. Stays under ±10%
    // of the baseline so it never reads as harsh strobing.
    const lightMod = 1 + drumPulse * 0.06 + sustained * 0.05;
    for (const entry of this.cabinLights) {
      entry.light.intensity = entry.baseIntensity * lightMod;
    }
  }

  private updateAtmosphere(atmosphere: { background: THREE.Color; daylight: number; night: number }): void {
    this.scene.background = atmosphere.background;
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(atmosphere.background);

    if (this.ambientLight) {
      this.ambientLight.color.set(0x8ea7bc).lerp(new THREE.Color(0xffd0a1), atmosphere.daylight * 0.48);
      this.ambientLight.intensity = 0.46 + atmosphere.daylight * 0.55 + atmosphere.night * 0.12;
    }
    if (this.keyLight) {
      this.keyLight.color.set(0x91d5ff).lerp(new THREE.Color(0xffcf84), atmosphere.daylight);
      this.keyLight.intensity = 0.45 + atmosphere.daylight * 1.25;
      this.keyLight.position.set(-2.8, 3.1 + atmosphere.daylight * 1.5, 3.5);
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
