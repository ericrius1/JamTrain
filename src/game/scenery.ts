import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';
import { Fn, color, float, floor, fract, mix, smoothstep, time, uniform, uv } from 'three/tsl';
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
  speed: number;
  scrollOffset: number;
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
  private starStrength = uniform(0);
  private moonCos = uniform(0);
  private moonSign = uniform(1);
  private moonVisibility = uniform(0);
  private sunVisibility = uniform(1);
  private sunPosX = uniform(0.82);
  private sunPosY = uniform(0.62);
  private moonPosX = uniform(0.42);
  private moonPosY = uniform(0.68);
  private moonRadius = uniform(0.085);
  private moonRadiusInv = uniform(11.76);
  private skyTravel = uniform(0);
  private hills: HillMesh[] = [];
  private villages: MovingPoints[] = [];
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
    this.scene.add(this.root);
  }

  update(delta: number, elapsed: number): Atmosphere {
    const cycle = ((elapsed / Math.max(this.params.cycleLengthSeconds, 1) + this.params.cycleOffset) % 1 + 1) % 1;
    const sunWave = Math.sin(cycle * fullTurn);
    const daylight = clamp(sunWave * 0.58 + 0.48, 0, 1);
    const night = 1 - daylight;
    const moonNight = smoothstepScalar(0.12, 0.34, -sunWave);
    const sunArc = Math.sin(cycle * fullTurn);
    const moonCycle = (cycle + 0.5) % 1;
    const moonArc = Math.sin(moonCycle * fullTurn);
    const sunrise = Math.exp(-Math.pow(cycle / 0.095, 2));
    const sunset = Math.exp(-Math.pow((cycle - 0.5) / 0.105, 2));
    const goldenHour = clamp(Math.max(sunrise, sunset), 0, 1);
    const speed = this.params.trainSpeed;

    this.skyNight.value = night;
    this.skySunset.value = goldenHour;
    const auroraVisibility = clamp(night + goldenHour * 0.55, 0, 1);
    this.auroraStrength.value = auroraVisibility * this.params.auroraIntensity;
    this.starStrength.value = clamp(night + goldenHour * 0.25, 0, 1) * this.params.starIntensity;
    this.moonVisibility.value = moonNight * clamp(0.35 + this.params.starIntensity * 0.65, 0, 1);
    this.sunVisibility.value = daylight;
    this.sunPosX.value = 0.88 - cycle * 0.76;
    this.sunPosY.value = 0.46 + clamp(sunArc, 0, 1) * 0.34;
    this.moonPosX.value = 0.88 - moonCycle * 0.76;
    this.moonPosY.value = 0.50 + clamp(moonArc, 0, 1) * 0.34;
    this.moonRadius.value = clamp(this.params.moonSize * 0.24, 0.035, 0.14);
    this.moonRadiusInv.value = 1 / this.moonRadius.value;
    this.skyTravel.value += delta * speed;

    this.updateHills(delta, speed);
    this.updateMovingPoints(this.villages, delta, speed, night * this.params.villageDensity);

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
    const material = this.createWindowSkyMaterial();

    for (const side of [-1, 1]) {
      const sky = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2.05), material);
      sky.rotation.y = Math.PI / 2;
      sky.position.set(side * 2.56, 1.48, 0);
      sky.renderOrder = -30;
      this.root.add(sky);
    }
  }

  private createWindowSkyMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = Fn(() => {
      const u = uv();
      const y = u.y.mul(1.08).sub(0.18);
      const horizon = smoothstep(0.0, 0.72, y);

      const daySky = mix(color(0xf2a268), color(0x74c7ff), horizon);
      const duskSky = mix(color(0xff8d64), color(0x241b56), smoothstep(0.02, 0.82, y));
      const nightSky = mix(color(0x071018), color(0x173c61), horizon);
      const sky = mix(mix(daySky, duskSky, this.skySunset), nightSky, this.skyNight).toVar('windowSky');

      const belowMask = float(1).sub(smoothstep(0.19, 0.31, u.y));
      const ground = mix(color(0x57321f), color(0x050706), this.skyNight);
      sky.assign(mix(sky, ground, belowMask.mul(0.5)));

      const aspect = float(3.12);
      const sunDx = u.x.sub(this.sunPosX).mul(aspect);
      const sunDy = u.y.sub(this.sunPosY);
      const sunDist = sunDx.mul(sunDx).add(sunDy.mul(sunDy)).sqrt();
      const sunDisc = float(1).sub(smoothstep(0.034, 0.052, sunDist)).mul(this.sunVisibility);
      const sunHalo = float(1).sub(sunDist.mul(2.0)).max(0).pow(3.0).mul(this.sunVisibility);
      sky.addAssign(color(0xfff2bc).mul(sunDisc.mul(1.85)));
      sky.addAssign(color(0xff8d4f).mul(sunHalo.mul(0.72)));

      const moonDx = u.x.sub(this.moonPosX).mul(aspect);
      const moonDy = u.y.sub(this.moonPosY);
      const moonDist = moonDx.mul(moonDx).add(moonDy.mul(moonDy)).sqrt();
      const moonHalo = float(1).sub(moonDist.mul(3.6)).max(0).pow(2.4).mul(this.moonVisibility);
      sky.addAssign(color(0xbfd8ff).mul(moonHalo.mul(0.18)));

      const moonDisc = float(1).sub(smoothstep(this.moonRadius.mul(0.92), this.moonRadius, moonDist));
      const moonPx = moonDx.mul(this.moonRadiusInv);
      const moonPy = moonDy.mul(this.moonRadiusInv);
      const terminator = this.moonCos.mul(float(1).sub(moonPy.mul(moonPy)).max(0).sqrt());
      const lit = smoothstep(terminator.sub(0.035), terminator.add(0.035), moonPx.mul(this.moonSign));
      sky.assign(mix(sky, color(0xfff4cf), moonDisc.mul(lit).mul(this.moonVisibility)));

      const starMask = smoothstep(0.30, 0.50, u.y);

      // Star layer 1 — sparse, brighter, larger
      const starX = u.x.add(this.skyTravel.mul(0.004)).mul(140.0);
      const starY = u.y.mul(58.0);
      const cellX = floor(starX);
      const cellY = floor(starY);
      const fracX = fract(starX);
      const fracY = fract(starY);
      const starHashBase = cellX.mul(12.9898).add(cellY.mul(78.233));
      const starHash = fract(starHashBase.sin().mul(43758.5453));
      const starBright = fract(starHashBase.mul(1.91).sin().mul(23421.631));
      const starDistX = fracX.sub(0.5);
      const starDistY = fracY.sub(0.5);
      const starDist = starDistX.mul(starDistX).add(starDistY.mul(starDistY)).sqrt();
      const starThreshold = float(1.004).sub(this.starStrength.mul(0.18));
      const starOn = smoothstep(starThreshold, starThreshold.add(0.004), starHash);
      const starCircle = float(1).sub(smoothstep(0.045, 0.16, starDist));
      const twinkle = starHash.mul(160.0).add(time.mul(0.65)).sin().mul(0.22).add(0.78);
      sky.addAssign(
        mix(color(0xe8efff), color(0xffdfa4), starBright.mul(0.45))
          .mul(starOn)
          .mul(starCircle)
          .mul(twinkle)
          .mul(starMask)
          .mul(this.starStrength)
          .mul(1.15)
      );

      // Star layer 2 — denser, dimmer, smaller (adds depth and richness)
      const starX2 = u.x.add(this.skyTravel.mul(0.006)).mul(280.0);
      const starY2 = u.y.mul(112.0);
      const cellX2 = floor(starX2);
      const cellY2 = floor(starY2);
      const fracX2 = fract(starX2);
      const fracY2 = fract(starY2);
      const starHashBase2 = cellX2.mul(45.678).add(cellY2.mul(98.765));
      const starHash2 = fract(starHashBase2.sin().mul(17853.321));
      const starBright2 = fract(starHashBase2.mul(2.71).sin().mul(31247.159));
      const starDistX2 = fracX2.sub(0.5);
      const starDistY2 = fracY2.sub(0.5);
      const starDist2 = starDistX2.mul(starDistX2).add(starDistY2.mul(starDistY2)).sqrt();
      const starThreshold2 = float(1.005).sub(this.starStrength.mul(0.14));
      const starOn2 = smoothstep(starThreshold2, starThreshold2.add(0.005), starHash2);
      const starCircle2 = float(1).sub(smoothstep(0.07, 0.18, starDist2));
      const twinkle2 = starHash2.mul(120.0).add(time.mul(0.42)).sin().mul(0.18).add(0.82);
      sky.addAssign(
        mix(color(0xb8c8ff), color(0xffe2b0), starBright2.mul(0.4))
          .mul(starOn2)
          .mul(starCircle2)
          .mul(twinkle2)
          .mul(starMask)
          .mul(this.starStrength)
          .mul(0.55)
      );

      // ── Aurora borealis — domain-warped curtains with vertical ray detail ──
      const aT = time.mul(0.42);
      const apx = u.x.mul(5.2).add(this.skyTravel.mul(0.032));
      const apy = u.y.mul(2.8);

      // Domain warping for organic, flowing curtain shapes
      const warpA = apx.mul(0.7).add(apy.mul(0.5)).add(aT.mul(0.13)).sin().mul(1.4);
      const warpB = apy.mul(0.8).sub(apx.mul(0.6)).sub(aT.mul(0.11)).sin().mul(1.1);
      const awx = apx.add(warpA);
      const awy = apy.add(warpB);

      // Three curtain layers at increasing frequencies
      const c1 = awx.mul(1.0).add(awy.mul(0.7)).add(aT.mul(0.19)).sin();
      const c2 = awx.mul(2.3).sub(awy.mul(1.5)).sub(aT.mul(0.15)).sin();
      const c3 = awx.mul(4.7).add(awy.mul(3.1)).add(aT.mul(0.23)).sin();
      const curtain = c1.mul(0.45).add(c2.mul(0.30)).add(c3.mul(0.18));

      // Soft exponential brightness mapping
      const auroraBright = curtain.mul(0.5).add(0.55).max(0).pow(2.0);

      // Vertical profile — wider band with soft edges to fill more of the sky
      const auroraRise = smoothstep(0.30, 0.46, u.y);
      const auroraFall = float(1).sub(smoothstep(0.86, 1.0, u.y));
      const auroraVert = auroraRise.mul(auroraFall);

      // Vertical ray detail — high-freq stripes within curtains
      const auroraRays = awx.mul(11.0).add(awy.mul(7.5)).add(aT.mul(1.4)).sin().mul(0.10).add(0.90);

      // Gentle temporal pulse
      const auroraPulse = aT.mul(0.5).add(apx.mul(0.3)).sin().mul(0.08).add(0.92);

      // Three-stop color gradient: green base → teal mid → vivid purple top
      const auroraHFrac = smoothstep(0.30, 0.92, u.y);
      const auroraLow = mix(color(0x14ff5c), color(0x18c4c0), smoothstep(0.0, 0.4, auroraHFrac));
      const auroraColor = mix(auroraLow, color(0x9a32e0), smoothstep(0.4, 1.0, auroraHFrac));

      sky.addAssign(
        auroraColor
          .mul(auroraBright)
          .mul(auroraVert)
          .mul(auroraRays)
          .mul(auroraPulse)
          .mul(this.auroraStrength)
          .mul(0.7)
      );

      return sky;
    })();
    material.depthWrite = false;
    material.fog = false;

    return material;
  }

  private createHills(): void {
    const layers = [
      { baseY: 0.42, amplitude: 0.16, color: 0x172925, speed: 0.42, x: 2.18 },
      { baseY: 0.58, amplitude: 0.2, color: 0x254339, speed: 0.62, x: 2.26 },
      { baseY: 0.75, amplitude: 0.25, color: 0x3d654a, speed: 0.86, x: 2.34 },
    ];

    for (const side of [-1, 1]) {
      for (let layer = 0; layer < layers.length; layer += 1) {
        const settings = layers[layer];
        const material = new THREE.MeshBasicNodeMaterial();
        const shade = smoothstep(0.05, 1.5, uv().y);
        material.colorNode = mix(color(settings.color), color(0x8bb77b), shade.mul(float(0.18)));
        material.depthWrite = true;

        const hill = this.createHillMesh({
          side,
          x: settings.x,
          baseY: settings.baseY,
          amplitude: settings.amplitude,
          speed: settings.speed,
          seed: 100 + side * 20 + layer * 9,
          material,
        });
        this.hills.push(hill);
        this.root.add(hill.mesh);
      }
    }
  }

  private createHillMesh(options: {
    side: number;
    x: number;
    baseY: number;
    amplitude: number;
    speed: number;
    seed: number;
    material: THREE.Material;
  }): HillMesh {
    const width = 7.6;
    const segments = 96;
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
    mesh.position.set(options.side * options.x, 0, 0);
    mesh.renderOrder = -20;
    return { mesh, geometry, seed: options.seed, baseY: options.baseY, amplitude: options.amplitude, speed: options.speed, scrollOffset: 0 };
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

  private updateHills(delta: number, speed: number): void {
    for (const hill of this.hills) {
      hill.scrollOffset += delta * speed * hill.speed;
      this.updateHillShape(hill);
    }
  }

  private updateHillShape(hill: HillMesh): void {
    const positions = hill.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < positions.count / 2; i += 1) {
      const localX = positions.getX(i * 2 + 1);
      positions.setY(i * 2 + 1, this.hillHeight(localX - hill.scrollOffset, hill.baseY, hill.amplitude * this.params.hillAmplitude * 4.2, hill.seed));
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

  private hillHeight(x: number, baseY: number, amplitude: number, seed: number): number {
    const ridges = Math.sin(x * 1.2 + seed * 0.31) + Math.sin(x * 2.7 + seed * 0.17) * 0.45;
    const rollingNoise = smoothNoise1D(x * 1.9, seed) * 0.42 + smoothNoise1D(x * 3.8, seed + 41) * 0.18;
    return (
      baseY +
      ridges * amplitude +
      rollingNoise * amplitude
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

function smoothNoise1D(value: number, seed: number): number {
  const cell = Math.floor(value);
  const fraction = value - cell;
  const t = fraction * fraction * (3 - 2 * fraction);
  const a = hash(cell + seed * 17.13) - 0.5;
  const b = hash(cell + 1 + seed * 17.13) - 0.5;
  return a + (b - a) * t;
}
