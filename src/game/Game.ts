import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AudioEngine } from './audio';
import { HandTracker } from './handTracking';
import { clamp, distance, fromThree } from './math';
import { MultiplayerClient } from './multiplayer';
import { LinkParticles } from './particles';
import { makePlayerPose } from './pose';
import { PlayerRig } from './rig';
import { RobotMotionController } from './robotMotion';
import { ScenerySystem } from './scenery';
import { fingerNames, handednesses, type LinkSample, type PlayerPose } from './types';

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
  private readonly sculptureTarget = new THREE.Vector3(0, 1.08, 0);
  private startedAt = performance.now();
  private lastFrameAt = this.startedAt;
  private handTracker: HandTracker;
  private audio: AudioEngine;
  private multiplayer: MultiplayerClient;
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
  private sculpture = new THREE.Group();
  private sculptureMaterials: THREE.MeshStandardMaterial[] = [];
  readonly paneDock: HTMLElement;
  private roomId: string;
  private localPose?: PlayerPose;
  private remotePose?: PlayerPose;

  constructor(
    private canvas: HTMLCanvasElement,
    roomId: string,
    private ui: GameUi
  ) {
    this.roomId = roomId;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.handTracker = new HandTracker(ui.inputStatus);
    this.audio = new AudioEngine(ui.musicStatus);
    this.multiplayer = new MultiplayerClient(roomId, 'Player');
    this.multiplayer.onStateChange(state => {
      ui.connectionStatus.textContent = state;
    });

    this.localRig = new PlayerRig(this.scene, { seatIndex: 0, color: 0x2d7f8c });
    this.remoteRig = new PlayerRig(this.scene, { seatIndex: 1, color: 0x8c4a7b, robot: true });
    this.particles = new LinkParticles(this.scene);
    this.paneDock = this.createPaneDock();
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
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.update());
  }

  startCamera(): Promise<void> {
    return this.handTracker.startCamera();
  }

  startAudio(): Promise<void> {
    return this.audio.start();
  }

  connectMultiplayer(): void {
    this.multiplayer.connect();
  }

  setRoom(roomId: string): void {
    this.roomId = roomId;
    this.multiplayer.setRoom(roomId);
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
    this.robotMotion.dispose();
    this.scenery.dispose();
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
    this.lockGameCamera();
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
    const narrow = this.camera.aspect < 0.72;
    this.camera.fov = narrow ? 82 : 62;
    this.gameCameraPosition.set(narrow ? 2.18 : 1.66, narrow ? 1.42 : 1.34, narrow ? 0.18 : 0.02);
    this.gameCameraTarget.set(narrow ? -0.06 : -0.12, 1.06, 0);
    this.camera.position.copy(this.gameCameraPosition);
    this.camera.lookAt(this.gameCameraTarget);
    this.camera.updateProjectionMatrix();
  }

  private createCabin(): void {
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x273034, roughness: 0.72, metalness: 0.08 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x18252a, roughness: 0.6, metalness: 0.18 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xd0b46b, roughness: 0.38, metalness: 0.22 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x4c233b, roughness: 0.7, metalness: 0.02 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9bd9f0,
      emissive: 0x1e5f72,
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0.28,
      roughness: 0.08,
      metalness: 0.05,
      depthWrite: false,
    });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.08, 4.8), floorMat);
    floor.position.y = 0.02;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(3.45, 0.08, 4.8), wallMat);
    ceiling.position.y = 2.24;
    this.scene.add(ceiling);

    for (const x of [-1.72, 1.72]) {
      const lowerWall = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.52, 4.8), wallMat);
      lowerWall.position.set(x, 0.32, 0);
      lowerWall.receiveShadow = true;
      this.scene.add(lowerWall);

      const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 4.8), trimMat);
      topRail.position.set(x, 2.04, 0);
      this.scene.add(topRail);

      const bottomRail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 4.8), trimMat);
      bottomRail.position.set(x, 0.7, 0);
      this.scene.add(bottomRail);

      for (const z of [-2.24, -0.76, 0.76, 2.24]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.32, 0.08), trimMat);
        post.position.set(x, 1.36, z);
        this.scene.add(post);
      }

      for (const z of [-1.5, 0, 1.5]) {
        const windowPane = new THREE.Mesh(new THREE.BoxGeometry(0.035, 1.18, 1.32), glassMat);
        windowPane.position.set(x * 1.005, 1.36, z);
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

    const table = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.06, 0.64), trimMat);
    table.position.set(0, 0.72, 0);
    table.castShadow = true;
    this.scene.add(table);

    const tableLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.68, 16), trimMat);
    tableLeg.position.set(0, 0.36, 0);
    this.scene.add(tableLeg);

    this.createMusicSculpture();

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

  private createMusicSculpture(): void {
    this.sculpture.position.copy(this.sculptureTarget);

    const coreMaterial = new THREE.MeshStandardMaterial({
      color: 0xdffaff,
      emissive: 0x35d8ff,
      emissiveIntensity: 1.2,
      transparent: true,
      opacity: 0.72,
      roughness: 0.2,
      metalness: 0.18,
    });
    const amberMaterial = new THREE.MeshStandardMaterial({
      color: 0xf7cf72,
      emissive: 0xf28e4c,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.58,
      roughness: 0.26,
      metalness: 0.12,
    });
    this.sculptureMaterials.push(coreMaterial, amberMaterial);

    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 2), coreMaterial);
    this.sculpture.add(core);

    for (let i = 0; i < 3; i += 1) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24 + i * 0.11, 0.006, 8, 96), i % 2 === 0 ? coreMaterial : amberMaterial);
      ring.rotation.set(i * 0.72, Math.PI * 0.5 + i * 0.42, i * 0.31);
      this.sculpture.add(ring);
    }

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 24, 14),
      new THREE.MeshBasicMaterial({
        color: 0x72f1ff,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.sculpture.add(halo);
    this.scene.add(this.sculpture);
  }

  private update(): void {
    const now = performance.now();
    const delta = Math.min((now - this.lastFrameAt) / 1000, 0.05);
    const elapsed = (now - this.startedAt) / 1000;
    this.lastFrameAt = now;
    const hands = this.handTracker.update(elapsed);
    const localPose = makePlayerPose(this.multiplayer.localId, 'Player', this.roomId, 0, hands, false);
    const remoteFromNetwork = this.multiplayer.getRemotePose();
    const robotHands = this.robotMotion.update(elapsed, delta, localPose);
    const robotPose = makePlayerPose('robot', 'Robot', this.roomId, 1, robotHands, true);
    const remotePose = remoteFromNetwork ?? robotPose;
    const robotTarget = remoteFromNetwork ? 0 : 1;

    this.localPose = localPose;
    this.remotePose = remotePose;
    this.localRig.update(localPose, delta, 0);
    this.remoteRig.update(remotePose, delta, robotTarget);

    const links = this.updateLinks();
    this.particles.update(this.renderer, links, elapsed);
    this.audio.update(localPose, remotePose, elapsed);
    this.multiplayer.sendPose(localPose, elapsed);
    this.updateAtmosphere(this.scenery.update(delta, elapsed));
    if (this.cameraMode === 'game') this.lockGameCamera();
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
    this.updateSculpture(energy);
    return links;
  }

  private updateSculpture(energy: number): void {
    this.sculpture.rotation.x += 0.004 + energy * 0.006;
    this.sculpture.rotation.y += 0.007 + energy * 0.009;
    const scale = 0.92 + energy * 0.28 + Math.sin(performance.now() * 0.004) * 0.035;
    this.sculpture.scale.setScalar(scale);

    for (const material of this.sculptureMaterials) {
      material.emissiveIntensity = 0.7 + energy * 1.4;
      material.opacity = 0.48 + energy * 0.36;
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
    const dock = document.createElement('div');
    dock.className = 'tweak-pane-dock';
    // Mount inside #stage so the dock scales with the letterboxed HUD.
    // Falls back to body if the stage isn't there yet (e.g. tests).
    const stage = document.getElementById('stage') ?? document.body;
    stage.appendChild(dock);
    return dock;
  }
}
