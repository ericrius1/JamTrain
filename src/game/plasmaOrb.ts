import * as THREE from 'three/webgpu';
import { Discard, Fn, cameraPosition, positionWorld, uniform, wgslFn } from 'three/tsl';
import { Pane } from 'tweakpane';
import { PlasmaOrbCubes } from './plasmaOrbCubes';

export type PlasmaOrbAttractor = {
  position: THREE.Vector3;
  weight: number;
};

export type PlasmaOrbOptions = {
  position: THREE.Vector3;
  radius?: number;
  paneDock?: HTMLElement;
};

const MAX_ATTRACTORS = 4;
const MAX_RAYMARCH_STEPS = 11;
const MAX_INNER_ITERS = 16;

const pseudoNoiseFn = wgslFn(/* wgsl */ `
fn pseudoNoise(s: vec3<f32>) -> f32 {
  return (
    sin(s.x + cos(s.y * 1.3)) +
    sin(s.y * 1.1 + cos(s.z * 0.9)) +
    sin(s.z * 1.2 + cos(s.x * 1.05))
  ) * (1.0 / 3.0);
}
`);

const fbmNoiseFn = wgslFn(/* wgsl */ `
fn fbmNoise(seed: vec3<f32>) -> f32 {
  // Three octaves: doubling-ish frequencies with decreasing amplitude.
  let n1 = pseudoNoise(seed);
  let n2 = pseudoNoise(seed * 2.13 + vec3<f32>(7.13, 3.71, 5.27));
  let n3 = pseudoNoise(seed * 4.71 + vec3<f32>(13.7, 19.3, 11.1));
  return (n1 + n2 * 0.5 + n3 * 0.25) * (1.0 / 1.75);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
`, [pseudoNoiseFn] as any);

const plasmaWGSL = /* wgsl */ `
fn plasmaOrb(
  ro: vec3<f32>,
  rd: vec3<f32>,
  uCenter: vec3<f32>,
  uRadius: f32,
  uTime: f32,
  uEnergy: f32,
  uNoiseAmp: f32,
  uWobbleFreq: f32,
  uWobbleSpeed: f32,
  uAttractorReach: f32,
  uAttractorStrength: f32,
  uA0: vec4<f32>,
  uA1: vec4<f32>,
  uA2: vec4<f32>,
  uA3: vec4<f32>,
  uCool: vec3<f32>,
  uWarm: vec3<f32>,
  uHot: vec3<f32>,
  uSteps: i32,
  uInnerIters: i32,
  uFoldSensitivity: f32,
  uAccumRate: f32,
  uToneStrength: f32,
  uBrightness: f32
) -> vec4<f32> {
  let oc = ro - uCenter;
  let bound = uRadius * 1.4;
  let b = dot(oc, rd);
  let cTerm = dot(oc, oc) - bound * bound;
  let h = b * b - cTerm;
  if (h < 0.0) {
    return vec4<f32>(0.0);
  }
  let hSqrt = sqrt(h);
  let tMin = max(-b - hSqrt, 0.0);
  let tMax = -b + hSqrt;
  if (tMax <= tMin) {
    return vec4<f32>(0.0);
  }

  // Pack attractors so the inner loop is uniform.
  var attractorsXyz: array<vec3<f32>, 4>;
  var attractorsW: array<f32, 4>;
  attractorsXyz[0] = uA0.xyz;
  attractorsW[0] = uA0.w;
  attractorsXyz[1] = uA1.xyz;
  attractorsW[1] = uA1.w;
  attractorsXyz[2] = uA2.xyz;
  attractorsW[2] = uA2.w;
  attractorsXyz[3] = uA3.xyz;
  attractorsW[3] = uA3.w;

  // Attractor-weighted swirl offset.
  var attractorAccum = vec3<f32>(0.0);
  var attractorWeight = 0.0;
  for (var ai: i32 = 0; ai < 4; ai = ai + 1) {
    let aw = attractorsW[ai];
    if (aw > 0.001) {
      let local = attractorsXyz[ai] - uCenter;
      attractorAccum = attractorAccum + local * aw;
      attractorWeight = attractorWeight + aw;
    }
  }
  var foldOffset = vec3<f32>(0.0);
  if (attractorWeight > 0.001) {
    foldOffset = (attractorAccum / attractorWeight) * 0.4;
  }

  var intensityAccum = 0.0;
  var t = tMin;
  let stepCount = max(uSteps, 1);
  let dtBase = (tMax - tMin) / f32(stepCount);
  var lastDensity = 0.0;
  var everInside = false;
  var maxStep = 0.0;
  var depthAccum = 0.0;

  for (var i: i32 = 0; i < 96; i = i + 1) {
    if (i >= stepCount) { break; }
    let stepDt = dtBase * exp(-2.0 * lastDensity);
    t = t + stepDt;
    if (t > tMax) {
      break;
    }

    let p0 = ro + t * rd - uCenter;

    // Smooth-min attractor pull adds to the SDF radius near hands.
    var radiusBoost = 0.0;
    for (var ai: i32 = 0; ai < 4; ai = ai + 1) {
      let aw = attractorsW[ai];
      if (aw > 0.001) {
        let dvec = (attractorsXyz[ai] - uCenter) - p0;
        let d2 = dot(dvec, dvec);
        let falloff = exp(-d2 / max(uAttractorReach * uAttractorReach, 1e-4));
        radiusBoost = radiusBoost + falloff * aw * uAttractorStrength;
      }
    }

    // FBM noise: spatial frequency from uWobbleFreq, time-scrolled by uWobbleSpeed.
    // Multiplicative so uNoiseAmp reads as a percentage of radius.
    let timeShift = vec3<f32>(uTime * 0.3, uTime * 0.21, uTime * 0.18) * uWobbleSpeed;
    let nseed = p0 * uWobbleFreq + timeShift;
    let noise = fbmNoise(nseed);
    let displacement = uRadius * uNoiseAmp * noise;

    let surfaceR = uRadius + radiusBoost + displacement;
    let outsideSurface = length(p0) - surfaceR;
    if (outsideSurface > 0.0) {
      lastDensity = 0.0;
      continue;
    }
    everInside = true;

    // Plasma fold (port of reference shadertoy 'map').
    var p = p0 + foldOffset;
    let cFold = p;
    var density = 0.0;
    let innerCount = max(uInnerIters, 1);
    for (var k: i32 = 0; k < 16; k = k + 1) {
      if (k >= innerCount) { break; }
      let dotPP = max(dot(p, p), 1e-4);
      p = 0.7 * abs(p) / dotPP - 0.7;
      let yz = vec2<f32>(p.y, p.z);
      let csq = vec2<f32>(yz.x * yz.x - yz.y * yz.y, 2.0 * yz.x * yz.y);
      let folded = vec3<f32>(p.x, csq.x, csq.y);
      p = folded.zxy;
      density = density + exp(-uFoldSensitivity * abs(dot(p, cFold)));
    }
    density = density * 0.5;
    lastDensity = density;

    let bright = clamp(density, 0.0, 4.0);
    maxStep = max(maxStep, bright);
    depthAccum = depthAccum + bright;
    // Single scalar intensity accumulator. b² balances mid vs peak weight.
    intensityAccum = intensityAccum * 0.99 + uAccumRate * (bright * bright);
  }

  if (!everInside) {
    return vec4<f32>(0.0);
  }

  // Reinhard on the scalar intensity, guaranteed [0, 1).
  let exposed = intensityAccum * uToneStrength;
  let intensity = exposed / (1.0 + exposed);

  // Cool dominates everywhere; uHot only at true peaks.
  let coolBlend = mix(uCool * 0.45, uCool, smoothstep(0.05, 0.55, intensity));
  let withHot = mix(coolBlend, uHot, smoothstep(0.75, 1.0, intensity));

  // Filaments: rays where a single inner iteration peaks above the
  // volume average. Amber rides on these threads only.
  let avgStep = depthAccum / f32(stepCount);
  let filament = clamp((maxStep - avgStep * 4.0 - 0.35) * 1.6, 0.0, 1.0);
  let amberAccent = filament * smoothstep(0.25, 0.75, intensity) * uEnergy;
  let palette = mix(withHot, uWarm, amberAccent * 0.85);

  // Output color is palette directly, scaled by intensity for swirl
  // contrast. Adding the dim baseFill keeps the back of the volume from
  // punching through to black where intensity is near zero.
  let baseFill = uCool * 0.05;
  let outRgb = palette * intensity * uBrightness + baseFill;
  let outFinal = clamp(outRgb, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(outFinal, 1.0);
}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plasmaFn = wgslFn(plasmaWGSL, [fbmNoiseFn] as any);

function colorToVec3(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export class PlasmaOrb {
  readonly mesh: THREE.Mesh;
  private radius: number;
  private energyBoost = 1;
  private pane?: Pane;
  private cubes?: PlasmaOrbCubes;
  private smoothedEnergy = 0;
  private targetEnergy = 0;
  private targetAttractors: PlasmaOrbAttractor[] = [];
  private smoothedAttractors: PlasmaOrbAttractor[] = Array.from(
    { length: MAX_ATTRACTORS },
    () => ({ position: new THREE.Vector3(), weight: 0 })
  );

  private uTime = uniform(0);
  private uCenter = uniform(new THREE.Vector3());
  private uRadius = uniform(0.42);
  private uEnergy = uniform(0);
  private uNoiseAmp = uniform(0.18);
  private uWobbleFreq = uniform(4.5);
  private uWobbleSpeed = uniform(1.2);
  private uAttractorReach = uniform(0.07);
  private uAttractorStrength = uniform(0.22);
  private uA0 = uniform(new THREE.Vector4());
  private uA1 = uniform(new THREE.Vector4());
  private uA2 = uniform(new THREE.Vector4());
  private uA3 = uniform(new THREE.Vector4());
  private uCool = uniform(colorToVec3(0x14e8c0));
  private uWarm = uniform(colorToVec3(0xff5a18));
  private uHot = uniform(colorToVec3(0x7af2d4));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uSteps = (uniform as any)(48, 'int');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uInnerIters = (uniform as any)(10, 'int');
  private uFoldSensitivity = uniform(19.0);
  private uAccumRate = uniform(0.06);
  private uToneStrength = uniform(0.7);
  private uBrightness = uniform(1.0);

  constructor(scene: THREE.Scene, options: PlasmaOrbOptions) {
    this.radius = options.radius ?? 0.42;
    this.uRadius.value = this.radius;
    this.uCenter.value.copy(options.position);

    const geometry = new THREE.SphereGeometry(this.radius * 1.5, 111, 111);
    const material = this.buildMaterial();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(options.position);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);

    if (options.paneDock) {
      const container = document.createElement('div');
      options.paneDock.appendChild(container);
      this.pane = new Pane({ title: 'Plasma Orb', container });
      this.pane.expanded = false;
      this.registerTweaks();
    }

    this.cubes = new PlasmaOrbCubes(scene, {
      position: options.position,
      extent: this.radius * 2.0,
      paneDock: options.paneDock,
    });
    this.cubes.setTints(this.uCool.value, this.uHot.value);
  }

  setFingertips(fingertips: THREE.Vector3[]): void {
    this.cubes?.setFingertips(fingertips);
  }

  private registerTweaks(): void {
    if (!this.pane) return;
    const pane = this.pane;
    const params = {
      radius: this.radius,
      noiseAmp: this.uNoiseAmp.value,
      wobbleFreq: this.uWobbleFreq.value,
      wobbleSpeed: this.uWobbleSpeed.value,
      attractorReach: this.uAttractorReach.value,
      attractorStrength: this.uAttractorStrength.value,
      energyBoost: this.energyBoost,
      coolColor: vec3ToHex(this.uCool.value),
      warmColor: vec3ToHex(this.uWarm.value),
      hotColor: vec3ToHex(this.uHot.value),
      raymarchSteps: this.uSteps.value,
      innerIters: this.uInnerIters.value,
      foldSensitivity: this.uFoldSensitivity.value,
      accumRate: this.uAccumRate.value,
      toneStrength: this.uToneStrength.value,
      brightness: this.uBrightness.value,
    };

    pane.addBinding(params, 'radius', { min: 0.2, max: 0.8, step: 0.01 }).on('change', e => {
      this.radius = e.value;
      this.uRadius.value = e.value;
    });
    pane.addBinding(params, 'noiseAmp', { label: 'wobble amp', min: 0, max: 0.7, step: 0.01 }).on('change', e => {
      this.uNoiseAmp.value = e.value;
    });
    pane.addBinding(params, 'wobbleFreq', { label: 'wobble freq', min: 0.5, max: 24, step: 0.1 }).on('change', e => {
      this.uWobbleFreq.value = e.value;
    });
    pane.addBinding(params, 'wobbleSpeed', { label: 'wobble speed', min: 0, max: 4, step: 0.05 }).on('change', e => {
      this.uWobbleSpeed.value = e.value;
    });
    pane.addBinding(params, 'attractorReach', { label: 'hand reach', min: 0.01, max: 1.5, step: 0.01 }).on('change', e => {
      this.uAttractorReach.value = e.value;
    });
    pane.addBinding(params, 'attractorStrength', { label: 'hand pull', min: 0, max: 0.4, step: 0.005 }).on('change', e => {
      this.uAttractorStrength.value = e.value;
    });
    pane.addBinding(params, 'energyBoost', { label: 'energy boost', min: 0, max: 2, step: 0.05 }).on('change', e => {
      this.energyBoost = e.value;
    });
    pane.addBinding(params, 'coolColor', { label: 'cool' }).on('change', e => {
      hexToVec3(e.value, this.uCool.value);
    });
    pane.addBinding(params, 'warmColor', { label: 'warm' }).on('change', e => {
      hexToVec3(e.value, this.uWarm.value);
    });
    pane.addBinding(params, 'hotColor', { label: 'hot' }).on('change', e => {
      hexToVec3(e.value, this.uHot.value);
    });

    const advanced = pane.addFolder({ title: 'raymarch / tone', expanded: false });
    advanced.addBinding(params, 'raymarchSteps', { label: 'steps', min: 8, max: 96, step: 1 }).on('change', e => {
      this.uSteps.value = e.value | 0;
    });
    advanced.addBinding(params, 'innerIters', { label: 'fold iters', min: 1, max: 16, step: 1 }).on('change', e => {
      this.uInnerIters.value = e.value | 0;
    });
    advanced.addBinding(params, 'foldSensitivity', { label: 'fold sens', min: 4, max: 40, step: 0.5 }).on('change', e => {
      this.uFoldSensitivity.value = e.value;
    });
    advanced.addBinding(params, 'accumRate', { label: 'accum rate', min: 0.005, max: 0.2, step: 0.005 }).on('change', e => {
      this.uAccumRate.value = e.value;
    });
    advanced.addBinding(params, 'toneStrength', { label: 'tone (Reinhard)', min: 0.1, max: 3, step: 0.05 }).on('change', e => {
      this.uToneStrength.value = e.value;
    });
    advanced.addBinding(params, 'brightness', { label: 'brightness', min: 0.2, max: 2, step: 0.05 }).on('change', e => {
      this.uBrightness.value = e.value;
    });
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = false;
    material.depthWrite = true;
    material.side = THREE.FrontSide;
    // material.blending = THREE.NormalBlending;
    // material.alphaTest = 0.5;
    // material.wireframe = true

    try {
      const colorNode = Fn(() => {
        const ro = cameraPosition;
        const rd = positionWorld.sub(cameraPosition).normalize();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sample = plasmaFn({
          ro,
          rd,
          uCenter: this.uCenter,
          uRadius: this.uRadius,
          uTime: this.uTime,
          uEnergy: this.uEnergy,
          uNoiseAmp: this.uNoiseAmp,
          uWobbleFreq: this.uWobbleFreq,
          uWobbleSpeed: this.uWobbleSpeed,
          uAttractorReach: this.uAttractorReach,
          uAttractorStrength: this.uAttractorStrength,
          uA0: this.uA0,
          uA1: this.uA1,
          uA2: this.uA2,
          uA3: this.uA3,
          uCool: this.uCool,
          uWarm: this.uWarm,
          uHot: this.uHot,
          uSteps: this.uSteps,
          uInnerIters: this.uInnerIters,
          uFoldSensitivity: this.uFoldSensitivity,
          uAccumRate: this.uAccumRate,
          uToneStrength: this.uToneStrength,
          uBrightness: this.uBrightness,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;
        Discard(sample.a.lessThan(0.5));
        return sample;
      })();
      material.colorNode = colorNode as unknown as THREE.MeshBasicNodeMaterial['colorNode'];
    } catch (err) {
      console.error('[PlasmaOrb] WGSL compile failed, using fallback', err);
      const fallback = new THREE.MeshBasicMaterial({
        color: 0x35d8ff,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      });
      return fallback as unknown as THREE.MeshBasicNodeMaterial;
    }

    return material;
  }

  setAttractors(attractors: PlasmaOrbAttractor[]): void {
    this.targetAttractors = attractors.slice(0, MAX_ATTRACTORS);
  }

  setEnergy(energy: number): void {
    this.targetEnergy = Math.max(0, Math.min(1, energy * this.energyBoost));
  }

  update(elapsed: number, delta: number): void {
    const energyAlpha = 1 - Math.exp(-delta * 5);
    this.smoothedEnergy += (this.targetEnergy - this.smoothedEnergy) * energyAlpha;

    const posAlpha = 1 - Math.exp(-delta * 12);
    const weightAlpha = 1 - Math.exp(-delta * 8);
    const slots = [this.uA0, this.uA1, this.uA2, this.uA3];
    for (let i = 0; i < MAX_ATTRACTORS; i += 1) {
      const target = this.targetAttractors[i];
      const slot = this.smoothedAttractors[i];
      if (target) {
        slot.position.lerp(target.position, posAlpha);
        slot.weight += (target.weight - slot.weight) * weightAlpha;
      } else {
        slot.weight += (0 - slot.weight) * weightAlpha;
      }
      slots[i].value.set(slot.position.x, slot.position.y, slot.position.z, slot.weight);
    }

    this.uTime.value = elapsed;
    this.uEnergy.value = this.smoothedEnergy;
    this.uCenter.value.copy(this.mesh.position);

    if (this.cubes) {
      this.cubes.setEnergy(this.smoothedEnergy);
      this.cubes.setTints(this.uCool.value, this.uHot.value);
      this.cubes.update();
    }
  }

  dispose(): void {
    this.pane?.dispose();
    this.cubes?.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

function vec3ToHex(v: THREE.Vector3): string {
  const r = Math.round(Math.max(0, Math.min(1, v.x)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, v.y)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, v.z)) * 255);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function hexToVec3(hex: string, target: THREE.Vector3): void {
  const c = new THREE.Color(hex);
  target.set(c.r, c.g, c.b);
}
