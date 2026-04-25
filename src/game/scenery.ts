import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';
import { color, float, mix, smoothstep, time, uniform, uv } from 'three/tsl';
import { clamp, hash } from './math';

type Atmosphere = {
  background: THREE.Color;
  daylight: number;
  night: number;
};

type HillMesh = {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  seed: number;
  baseY: number;
  amplitude: number;
  width: number;
  speed: number;
};

type MovingPoints = {
  points: THREE.Points;
  width: number;
  speed: number;
  material: THREE.PointsMaterial;
};

type SceneryParams = {
  cycleLengthSeconds: number;
  cycleOffset: number;
  trainSpeed: number;
  hillAmplitude: number;
  villageDensity: number;
  auroraIntensity: number;
  starIntensity: number;
  moonSize: number;
  moonPhase: string;
};

const fullTurn = Math.PI * 2;

export class ScenerySystem {
  readonly params: SceneryParams;
  private pane: Pane;
  private root = new THREE.Group();
  private skyNight = uniform(0);
  private skySunset = uniform(0);
  private auroraStrength = uniform(0);
  private moonCos = uniform(0);
  private moonSign = uniform(1);
  private moonVisibility = uniform(0);
  private sunVisibility = uniform(1);
  private hills: HillMesh[] = [];
  private villages: MovingPoints[] = [];
  private stars: MovingPoints[] = [];
  private moonPlanes: THREE.Mesh[] = [];
  private sunPlanes: THREE.Mesh[] = [];
  private atmosphere = {
    background: new THREE.Color(0x10202d),
    daylight: 1,
    night: 0,
  };

  constructor(
    private scene: THREE.Scene,
    paneContainer?: HTMLElement
  ) {
    const moonPhase = getMoonPhase(new Date());
    this.params = {
      cycleLengthSeconds: 180,
      cycleOffset: 0.08,
      trainSpeed: 1.1,
      hillAmplitude: 0.22,
      villageDensity: 0.58,
      auroraIntensity: 0.76,
      starIntensity: 0.78,
      moonSize: 0.34,
      moonPhase: moonPhase.name,
    };
    this.moonCos.value = Math.cos(moonPhase.phase * fullTurn);
    this.moonSign.value = moonPhase.phase < 0.5 ? 1 : -1;

    this.pane = new Pane({ title: 'Scenery', container: paneContainer });
    this.setupPane();
  }

  build(): void {
    this.root.name = 'procedural-scenery';
    this.createSky();
    this.createHills();
    this.createVillages();
    this.createStars();
    this.createMoonAndSun();
    this.scene.add(this.root);
  }

  update(delta: number, elapsed: number): Atmosphere {
    const cycle = ((elapsed / Math.max(this.params.cycleLengthSeconds, 1) + this.params.cycleOffset) % 1 + 1) % 1;
    const sunWave = Math.sin(cycle * fullTurn);
    const daylight = clamp(sunWave * 0.58 + 0.48, 0, 1);
    const night = 1 - daylight;
    const moonNight = smoothstepScalar(0.12, 0.34, -sunWave);
    const sunrise = Math.exp(-Math.pow(cycle / 0.095, 2));
    const sunset = Math.exp(-Math.pow((cycle - 0.5) / 0.105, 2));
    const goldenHour = clamp(Math.max(sunrise, sunset), 0, 1);
    const speed = this.params.trainSpeed;

    this.skyNight.value = night;
    this.skySunset.value = goldenHour;
    this.auroraStrength.value = night * this.params.auroraIntensity;
    this.moonVisibility.value = moonNight * clamp(0.35 + this.params.starIntensity * 0.65, 0, 1);
    this.sunVisibility.value = daylight;

    this.updateHills(delta, speed);
    this.updateMovingPoints(this.villages, delta, speed, night * this.params.villageDensity);
    this.updateMovingPoints(this.stars, delta, speed * 0.12, night * this.params.starIntensity);
    this.updateMoonAndSun(cycle, moonNight);

    const dayColor = new THREE.Color(0x2f6172);
    const duskColor = new THREE.Color(0x4d3158);
    const nightColor = new THREE.Color(0x071013);
    this.atmosphere.background.copy(nightColor).lerp(dayColor, daylight).lerp(duskColor, goldenHour * 0.35);
    this.atmosphere.daylight = daylight;
    this.atmosphere.night = night;
    return this.atmosphere;
  }

  dispose(): void {
    this.pane.dispose();
  }

  private setupPane(): void {
    this.pane.addBinding(this.params, 'cycleLengthSeconds', { label: 'day/night sec', min: 30, max: 600, step: 1 });
    this.pane.addBinding(this.params, 'cycleOffset', { label: 'cycle offset', min: 0, max: 1, step: 0.001 });
    this.pane.addBinding(this.params, 'trainSpeed', { label: 'train speed', min: 0, max: 3, step: 0.01 });
    this.pane.addBinding(this.params, 'hillAmplitude', { label: 'hill shape', min: 0.05, max: 0.48, step: 0.01 });
    this.pane.addBinding(this.params, 'villageDensity', { label: 'village lights', min: 0, max: 1, step: 0.01 });
    this.pane.addBinding(this.params, 'auroraIntensity', { label: 'aurora', min: 0, max: 1.8, step: 0.01 });
    this.pane.addBinding(this.params, 'starIntensity', { label: 'stars', min: 0, max: 1, step: 0.01 });
    this.pane.addBinding(this.params, 'moonSize', { label: 'moon size', min: 0.12, max: 0.58, step: 0.01 });
    this.pane.addBinding(this.params, 'moonPhase', { label: 'moon phase', readonly: true } as never);
  }

  private createSky(): void {
    const material = new THREE.MeshBasicNodeMaterial();
    const v = uv().y;
    const horizon = smoothstep(0.02, 0.86, v);
    const daySky = mix(color(0xffbd83), color(0x6fcaff), horizon);
    const duskSky = mix(color(0x2b1f5e), color(0xff8d64), smoothstep(0.02, 0.68, v));
    const nightSky = mix(color(0x06101f), color(0x153f62), horizon);
    material.colorNode = mix(mix(daySky, duskSky, this.skySunset), nightSky, this.skyNight);
    material.depthWrite = false;

    for (const side of [-1, 1]) {
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2.05), material);
      sky.rotation.y = Math.PI / 2;
      sky.position.set(side * 2.56, 1.48, 0);
      sky.renderOrder = -30;
      this.root.add(sky);
    }
  }

  private createHills(): void {
    const layers = [
      { baseY: 0.42, amplitude: 0.16, color: 0x172925, speed: 0.42, x: 2.18 },
      { baseY: 0.58, amplitude: 0.2, color: 0x254339, speed: 0.62, x: 2.26 },
      { baseY: 0.75, amplitude: 0.25, color: 0x3d654a, speed: 0.86, x: 2.34 },
    ];

    for (const side of [-1, 1]) {
      for (let layer = 0; layer < layers.length; layer += 1) {
        for (let copy = 0; copy < 2; copy += 1) {
          const settings = layers[layer];
          const material = new THREE.MeshBasicNodeMaterial();
          const shade = smoothstep(0.05, 1.5, uv().y);
          material.colorNode = mix(color(settings.color), color(0x8bb77b), shade.mul(float(0.18)));
          material.depthWrite = true;

          const hill = this.createHillMesh({
            side,
            x: settings.x,
            z: copy === 0 ? 0 : -6.2,
            baseY: settings.baseY,
            amplitude: settings.amplitude,
            speed: settings.speed,
            seed: 100 + side * 20 + layer * 9 + copy,
            material,
          });
          this.hills.push(hill);
          this.root.add(hill.mesh);
        }
      }
    }
  }

  private createHillMesh(options: {
    side: number;
    x: number;
    z: number;
    baseY: number;
    amplitude: number;
    speed: number;
    seed: number;
    material: THREE.Material;
  }): HillMesh {
    const width = 6.2;
    const segments = 42;
    const positions = new Float32Array((segments + 1) * 2 * 3);
    const uvs = new Float32Array((segments + 1) * 2 * 2);
    const indices: number[] = [];

    for (let i = 0; i <= segments; i += 1) {
      const x = -width / 2 + (i / segments) * width;
      const bottomIndex = i * 2;
      const topIndex = bottomIndex + 1;
      positions[bottomIndex * 3] = x;
      positions[bottomIndex * 3 + 1] = 0.12;
      positions[topIndex * 3] = x;
      positions[topIndex * 3 + 1] = this.hillHeight(x, options.baseY, options.amplitude, options.seed);
      uvs[bottomIndex * 2] = i / segments;
      uvs[bottomIndex * 2 + 1] = 0;
      uvs[topIndex * 2] = i / segments;
      uvs[topIndex * 2 + 1] = 1;

      if (i < segments) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, c, b, c, d, b);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, options.material);
    mesh.rotation.y = Math.PI / 2;
    mesh.position.set(options.side * options.x, 0, options.z);
    mesh.renderOrder = -20;
    return { mesh, geometry, seed: options.seed, baseY: options.baseY, amplitude: options.amplitude, width, speed: options.speed };
  }

  private createVillages(): void {
    for (const side of [-1, 1]) {
      for (let layer = 0; layer < 2; layer += 1) {
        const width = 6.2;
        const count = 80;
        const positions = new Float32Array(count * 3);
        for (let i = 0; i < count; i += 1) {
          positions[i * 3] = -width / 2 + hash(i + layer * 13 + side * 17) * width;
          positions[i * 3 + 1] = 0.55 + hash(i + 90) * 0.48;
          positions[i * 3 + 2] = 0;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const material = new THREE.PointsMaterial({
          color: layer === 0 ? 0xffd983 : 0xa9f3ff,
          size: layer === 0 ? 0.018 : 0.012,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const points = new THREE.Points(geometry, material);
        points.rotation.y = Math.PI / 2;
        points.position.set(side * (2.09 + layer * 0.04), 0, layer === 0 ? 0 : -3.1);
        points.renderOrder = -10;
        this.villages.push({ points, width, speed: 0.95 + layer * 0.22, material });
        this.root.add(points);
      }
    }
  }

  private createStars(): void {
    for (const side of [-1, 1]) {
      const width = 6.2;
      const count = 140;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        positions[i * 3] = -width / 2 + hash(i + side * 31) * width;
        positions[i * 3 + 1] = 1.15 + hash(i + 7) * 0.82;
        positions[i * 3 + 2] = 0;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color: 0xdff7ff,
        size: 0.012,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geometry, material);
      points.rotation.y = Math.PI / 2;
      points.position.set(side * 2.49, 0, 0);
      points.renderOrder = -25;
      this.stars.push({ points, width, speed: 0.06, material });
      this.root.add(points);
    }
  }

  private createMoonAndSun(): void {
    const moonMaterial = this.createMoonMaterial();
    const sunMaterial = this.createSunMaterial();
    const auroraMaterial = this.createAuroraMaterial();

    for (const side of [-1, 1]) {
      const aurora = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 1.25), auroraMaterial);
      aurora.rotation.y = Math.PI / 2;
      aurora.position.set(side * 2.45, 1.48, 0);
      aurora.renderOrder = -24;
      this.root.add(aurora);

      const moon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), moonMaterial);
      moon.rotation.y = Math.PI / 2;
      moon.position.set(side * 2.42, 1.72, -0.9);
      moon.renderOrder = -15;
      this.moonPlanes.push(moon);
      this.root.add(moon);

      const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sunMaterial);
      sun.rotation.y = Math.PI / 2;
      sun.position.set(side * 2.41, 1.28, 1.3);
      sun.renderOrder = -16;
      this.sunPlanes.push(sun);
      this.root.add(sun);
    }
  }

  private createAuroraMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    const u = uv();
    const waveA = u.x.mul(9.0).add(time.mul(0.16)).sin().mul(0.5).add(0.5);
    const waveB = u.x.mul(17.0).sub(time.mul(0.11)).sin().mul(0.5).add(0.5);
    const curtain = smoothstep(0.38, 0.76, u.y.add(waveA.mul(0.18))).mul(float(1).sub(smoothstep(0.82, 1.02, u.y.add(waveB.mul(0.08)))));
    material.colorNode = mix(color(0x32ffca), color(0x9877ff), waveB);
    material.opacityNode = curtain.mul(this.auroraStrength).mul(0.52);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    return material;
  }

  private createMoonMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    const p = uv().mul(2).sub(1);
    const radius = p.length();
    const disc = float(1).sub(smoothstep(0.94, 1.0, radius));
    const terminator = this.moonCos.mul(float(1).sub(p.y.mul(p.y)).max(0).sqrt());
    const lit = smoothstep(terminator.sub(0.035), terminator.add(0.035), p.x.mul(this.moonSign));
    material.colorNode = mix(color(0x223244), color(0xfff4cf), lit);
    material.opacityNode = disc.mul(this.moonVisibility);
    material.transparent = true;
    material.depthWrite = false;
    return material;
  }

  private createSunMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    const p = uv().mul(2).sub(1);
    const radius = p.length();
    const disc = float(1).sub(smoothstep(0.84, 1.0, radius));
    material.colorNode = mix(color(0xfff4b8), color(0xff7a45), smoothstep(0.0, 0.95, radius));
    material.opacityNode = disc.mul(this.sunVisibility);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    return material;
  }

  private updateHills(delta: number, speed: number): void {
    for (const hill of this.hills) {
      hill.mesh.position.z += delta * speed * hill.speed;
      if (hill.mesh.position.z > hill.width / 2) hill.mesh.position.z -= hill.width;
      this.updateHillShape(hill);
    }
  }

  private updateHillShape(hill: HillMesh): void {
    const positions = hill.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count / 2; i += 1) {
      const localX = positions.getX(i * 2 + 1);
      positions.setY(i * 2 + 1, this.hillHeight(localX, hill.baseY, hill.amplitude * this.params.hillAmplitude * 4.2, hill.seed));
    }
    positions.needsUpdate = true;
  }

  private updateMovingPoints(points: MovingPoints[], delta: number, speed: number, opacity: number): void {
    for (const item of points) {
      item.points.position.z += delta * speed * item.speed;
      if (item.points.position.z > item.width / 2) item.points.position.z -= item.width;
      item.material.opacity = clamp(opacity, 0, 1);
    }
  }

  private updateMoonAndSun(cycle: number, moonNight: number): void {
    const moonScale = this.params.moonSize;
    const sunScale = 0.42;
    const sunArc = Math.sin(cycle * fullTurn);
    const moonArc = Math.sin((cycle + 0.5) * fullTurn);

    for (const moon of this.moonPlanes) {
      moon.visible = moonNight > 0.01;
      moon.scale.setScalar(moonScale);
      moon.position.y = 1.35 + clamp(moonArc, 0, 1) * 0.55;
      moon.position.z = 1.65 - cycle * 3.2;
    }

    for (const sun of this.sunPlanes) {
      sun.scale.setScalar(sunScale);
      sun.position.y = 1.05 + clamp(sunArc, 0, 1) * 0.72;
      sun.position.z = -1.65 + cycle * 3.2;
    }
  }

  private hillHeight(x: number, baseY: number, amplitude: number, seed: number): number {
    return (
      baseY +
      Math.sin(x * 1.2 + seed * 0.31) * amplitude +
      Math.sin(x * 2.7 + seed * 0.17) * amplitude * 0.45 +
      (hash(Math.floor((x + 9) * 4) + seed) - 0.5) * amplitude * 0.32
    );
  }
}

function getMoonPhase(date: Date): { phase: number; name: string } {
  const synodicMonth = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - knownNewMoon) / 86_400_000;
  const age = ((days % synodicMonth) + synodicMonth) % synodicMonth;
  const phase = age / synodicMonth;
  const names = [
    'new moon',
    'waxing crescent',
    'first quarter',
    'waxing gibbous',
    'full moon',
    'waning gibbous',
    'last quarter',
    'waning crescent',
  ];
  const index = Math.round(phase * 8) % 8;
  return { phase, name: names[index] };
}

function smoothstepScalar(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
