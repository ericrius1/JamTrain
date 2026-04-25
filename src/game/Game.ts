import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AudioEngine } from './audio';
import { HandTracker } from './handTracking';
import { clamp, distance, fromThree } from './math';
import { MultiplayerClient } from './multiplayer';
import { LinkParticles } from './particles';
import { PlasmaOrb, type PlasmaOrbAttractor } from './plasmaOrb';
import { makePlayerPose } from './pose';
import { PlayerRig } from './rig';
import { RobotMotionController } from './robotMotion';
import { ScenerySystem } from './scenery';
import { fingerNames, handednesses, type LinkSample, type PlayerPose } from './types';
import { WebRTCClient } from './webrtc';
import { Pane } from 'tweakpane';

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
  private readonly cameraDolly = {
    fovWide: 62,
    fovNarrow: 64,
    dollyBackMeters: 0.85,
    riseMeters: 0.08,
    narrowAspect: 0.55,
    smoothingSeconds: 0.45,
  };
  private dollyT = 0;
  private cameraPane?: Pane;
  private readonly sculptureTarget = new THREE.Vector3(0, 1.08, 0);
  private startedAt = performance.now();
  private lastFrameAt = this.startedAt;
  readonly handTracker: HandTracker;
  private audio: AudioEngine;
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
  private plasmaOrb?: PlasmaOrb;
  readonly paneDock: HTMLElement;
  private roomId: string;
  private localPose?: PlayerPose;
  private remotePose?: PlayerPose;

  constructor(
    private canvas: HTMLCanvasElement,
    urlRoom: string,
    private ui: GameUi
  ) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.paneDock = this.createPaneDock();
    this.handTracker = new HandTracker(ui.inputStatus);
    this.audio = new AudioEngine(ui.musicStatus, this.paneDock);
    this.multiplayer = new MultiplayerClient(urlRoom, 'Player');
    this.roomId = this.multiplayer.getRoom();
    this.multiplayer.onStateChange(state => {
      ui.connectionStatus.textContent = state;
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
    this.multiplayer.onSeatChange((localSeat, partnerSeat) => {
      this.localRig.setSeatIndex(localSeat);
      this.remoteRig.setSeatIndex(partnerSeat);
    });
    this.particles = new LinkParticles(this.scene);
    this.robotMotion = new RobotMotionController(this.paneDock);
    this.scenery = new ScenerySystem(this.scene, this.paneDock);

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
    this.handTracker.attachPane(this.paneDock);
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.update());
  }

  async startCamera(): Promise<void> {
    await this.handTracker.startCamera();
    this.webrtc.notifyLocalStreamReady();
  }

  startAudio(): Promise<void> {
    return this.audio.start();
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

  setDisplayName(name: string): void {
    this.multiplayer.setDisplayName(name);
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
    this.cameraPane?.dispose();
    this.paneDock.remove();
    this.renderer.dispose();
  }

  private setupRenderer(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x071013, 1);
    this.renderer.shadowMap.enabled = true;
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

  private setupCameraPane(): void {
    if (this.cameraPane) return;
    const container = document.createElement('div');
    this.paneDock.appendChild(container);
    this.cameraPane = new Pane({ title: 'Camera Dolly', container });
    this.cameraPane.expanded = false;
    this.cameraPane.addBinding(this.cameraDolly, 'fovWide', {
      label: 'fov wide', min: 30, max: 90, step: 1,
    });
    this.cameraPane.addBinding(this.cameraDolly, 'fovNarrow', {
      label: 'fov narrow', min: 30, max: 100, step: 1,
    });
    this.cameraPane.addBinding(this.cameraDolly, 'dollyBackMeters', {
      label: 'dolly back m', min: 0, max: 3, step: 0.05,
    });
    this.cameraPane.addBinding(this.cameraDolly, 'riseMeters', {
      label: 'rise m', min: 0, max: 1, step: 0.01,
    });
    this.cameraPane.addBinding(this.cameraDolly, 'narrowAspect', {
      label: 'narrow aspect', min: 0.3, max: 1.5, step: 0.01,
    });
    this.cameraPane.addBinding(this.cameraDolly, 'smoothingSeconds', {
      label: 'lag sec', min: 0, max: 2, step: 0.01,
    });
  }

  private createCabin(): void {
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x273034, roughness: 0.72, metalness: 0.08 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x18252a, roughness: 0.6, metalness: 0.18 });
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

    const floor = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.08, 4.8), floorMat);
    floor.position.y = 0.02;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(3.45, 0.08, 4.8), wallMat);
    ceiling.position.y = 2.24;
    this.scene.add(ceiling);

    const glassBottom = 0.19;
    const glassTop = 1.95;
    const glassHeight = glassTop - glassBottom;
    const glassY = (glassBottom + glassTop) / 2;
    const glassZs = [-1.5, 0, 1.5];
    const paneDepth = 1.32;
    const glassSpan = glassZs.length * paneDepth;
    const frameThick = 0.025;
    const frameOuterSpan = glassSpan + frameThick;

    const ceilingBottom = 2.24 - 0.04;
    const lowerWallHeight = glassBottom - 0.06;
    const upperWallHeight = ceilingBottom - glassTop;
    const endCapHeight = ceilingBottom - 0.06;
    const endCapDepth = 4.8 / 2 - glassSpan / 2;

    for (const x of [-1.72, 1.72]) {
      const lowerWall = new THREE.Mesh(new THREE.BoxGeometry(0.08, lowerWallHeight, 4.8), wallMat);
      lowerWall.position.set(x, 0.06 + lowerWallHeight / 2, 0);
      lowerWall.receiveShadow = true;
      this.scene.add(lowerWall);

      const upperWall = new THREE.Mesh(new THREE.BoxGeometry(0.08, upperWallHeight, 4.8), wallMat);
      upperWall.position.set(x, glassTop + upperWallHeight / 2, 0);
      this.scene.add(upperWall);

      for (const zSign of [-1, 1]) {
        const endCap = new THREE.Mesh(new THREE.BoxGeometry(0.08, endCapHeight, endCapDepth), wallMat);
        endCap.position.set(x, 0.06 + endCapHeight / 2, zSign * (glassSpan / 2 + endCapDepth / 2));
        this.scene.add(endCap);
      }

      const frameX = x * 1.012;

      const topRail = new THREE.Mesh(new THREE.BoxGeometry(frameThick, frameThick, frameOuterSpan), trimMat);
      topRail.position.set(frameX, glassTop + frameThick / 2, 0);
      this.scene.add(topRail);

      const bottomRail = new THREE.Mesh(new THREE.BoxGeometry(frameThick, frameThick, frameOuterSpan), trimMat);
      bottomRail.position.set(frameX, glassBottom - frameThick / 2, 0);
      this.scene.add(bottomRail);

      for (const z of [-glassSpan / 2 - frameThick / 2, glassSpan / 2 + frameThick / 2]) {
        const endPost = new THREE.Mesh(new THREE.BoxGeometry(frameThick, glassHeight, frameThick), trimMat);
        endPost.position.set(frameX, glassY, z);
        this.scene.add(endPost);
      }

      for (const z of glassZs) {
        const windowPane = new THREE.Mesh(new THREE.BoxGeometry(0.035, glassHeight, paneDepth), glassMat);
        windowPane.position.set(x * 1.005, glassY, z);
        windowPane.renderOrder = 2;
        this.scene.add(windowPane);
      }
    }

    this.scenery.build();

    for (const z of [1.38, -1.38]) {
      const bench = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.24, 0.52), seatMat);
      bench.position.set(0, 0.36, z);
      bench.castShadow = true;
      bench.receiveShadow = true;
      this.scene.add(bench);

      const back = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.74, 0.18), seatMat);
      back.position.set(0, 0.78, z + (z > 0 ? 0.32 : -0.32));
      back.rotation.x = z > 0 ? -0.1 : 0.1;
      back.castShadow = true;
      this.scene.add(back);
    }

    const table = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.06, 0.64), woodMat);
    table.position.set(0, 0.72, 0);
    table.castShadow = true;
    this.scene.add(table);

    const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.68, 16), woodMat);
    tableLeg.position.set(0, 0.36, 0);
    this.scene.add(tableLeg);

    for (const z of [-1.55, 0, 1.55]) {
      const light = new THREE.PointLight(0xffe8ad, 0.95, 4.8);
      light.position.set(0, 2.08, z);
      this.scene.add(light);

      const fixture = new THREE.Mesh(
        new THREE.BoxGeometry(0.68, 0.03, 0.12),
        new THREE.MeshBasicMaterial({ color: 0xffe8ad })
      );
      fixture.position.copy(light.position);
      this.scene.add(fixture);
    }

    this.ambientLight = new THREE.AmbientLight(0x9fb9c1, 0.92);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xf7cf72, 1.45);
    this.keyLight.position.set(-2.8, 4.2, 3.5);
    this.keyLight.castShadow = true;
    this.scene.add(this.keyLight);

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
    this.multiplayer.sendPose(localPose, elapsed);
    if (this.cameraMode === 'game') this.updateCameraDolly(delta);
    if (this.cameraMode === 'orbit') this.orbitControls?.update();
    this.renderer.render(this.scene, this.camera);
  }

  private updateLinks(): LinkSample[] {
    const links: LinkSample[] = [];
    let cursor = 0;

    for (const handedness of handednesses) {
      for (const finger of fingerNames) {
        const from = this.localRig.getFingertipWorld(handedness, finger);
        const to = this.remoteRig.getFingertipWorld(handedness, finger);
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
      this.plasmaOrb.setAttractors(this.computeOrbAttractors());
      this.plasmaOrb.setEnergy(energy);
    }
    return links;
  }

  private computeOrbAttractors(): PlasmaOrbAttractor[] {
    const attractors: PlasmaOrbAttractor[] = [];
    const maxReach = 0.9;

    const pushHand = (rig: PlayerRig, hand: 'left' | 'right'): void => {
      const centroid = new THREE.Vector3();
      let count = 0;
      for (const finger of fingerNames) {
        centroid.add(rig.getFingertipWorld(hand, finger));
        count += 1;
      }
      if (count === 0) return;
      centroid.divideScalar(count);
      const distance = centroid.distanceTo(this.sculptureTarget);
      const weight = Math.max(0, Math.min(1, 1 - distance / maxReach));
      attractors.push({ position: centroid, weight });
    };

    pushHand(this.localRig, 'left');
    pushHand(this.localRig, 'right');
    pushHand(this.remoteRig, 'left');
    pushHand(this.remoteRig, 'right');

    return attractors;
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
    const dock = document.createElement('div');
    dock.className = 'tweak-pane-dock';
    // Mount inside #stage so the dock scales with the letterboxed HUD.
    // Falls back to body if the stage isn't there yet (e.g. tests).
    const stage = document.getElementById('stage') ?? document.body;
    stage.appendChild(dock);
    return dock;
  }
}
