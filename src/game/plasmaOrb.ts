import * as THREE from 'three/webgpu';
import { Discard, Fn, cameraPosition, positionWorld, uniform, wgslFn } from 'three/tsl';
import { Pane } from 'tweakpane';

export type PlasmaOrbMetaball = {
  id: string;
  position: THREE.Vector3;
  tracked?: boolean;
};

export type PlasmaOrbOptions = {
  position: THREE.Vector3;
  radius?: number;
  paneDock?: HTMLElement;
};

const MAX_FINGER_METABALLS = 20;
const MAX_METABALLS = MAX_FINGER_METABALLS + 1;
const MAX_SURFACE_STEPS = 48;
const MAX_REFINE_STEPS = 5;

const pseudoNoiseFn = wgslFn(/* wgsl */ `
fn pseudoNoise(s: vec3<f32>) -> f32 {
  return (
    sin(s.x + cos(s.y * 1.3)) +
    sin(s.y * 1.1 + cos(s.z * 0.9)) +
    sin(s.z * 1.2 + cos(s.x * 1.05))
  ) * (1.0 / 3.0);
}
`);

const metaballWGSL = /* wgsl */ `
fn plasmaMetaballs(
  ro: vec3<f32>,
  rd: vec3<f32>,
  uCenter: vec3<f32>,
  uBoundRadius: f32,
  uTime: f32,
  uEnergy: f32,
  uIsoLevel: f32,
  uBallCount: i32,
  uNoiseAmp: f32,
  uWobbleFreq: f32,
  uWobbleSpeed: f32,
  uB0: vec4<f32>,
  uB1: vec4<f32>,
  uB2: vec4<f32>,
  uB3: vec4<f32>,
  uB4: vec4<f32>,
  uB5: vec4<f32>,
  uB6: vec4<f32>,
  uB7: vec4<f32>,
  uB8: vec4<f32>,
  uB9: vec4<f32>,
  uB10: vec4<f32>,
  uB11: vec4<f32>,
  uB12: vec4<f32>,
  uB13: vec4<f32>,
  uB14: vec4<f32>,
  uB15: vec4<f32>,
  uB16: vec4<f32>,
  uB17: vec4<f32>,
  uB18: vec4<f32>,
  uB19: vec4<f32>,
  uB20: vec4<f32>,
  uCool: vec3<f32>,
  uWarm: vec3<f32>,
  uHot: vec3<f32>,
  uSteps: i32,
  uRefineSteps: i32,
  uBrightness: f32,
  uAlpha: f32
) -> vec4<f32> {
  var balls: array<vec4<f32>, ${MAX_METABALLS}>;
  balls[0] = uB0;
  balls[1] = uB1;
  balls[2] = uB2;
  balls[3] = uB3;
  balls[4] = uB4;
  balls[5] = uB5;
  balls[6] = uB6;
  balls[7] = uB7;
  balls[8] = uB8;
  balls[9] = uB9;
  balls[10] = uB10;
  balls[11] = uB11;
  balls[12] = uB12;
  balls[13] = uB13;
  balls[14] = uB14;
  balls[15] = uB15;
  balls[16] = uB16;
  balls[17] = uB17;
  balls[18] = uB18;
  balls[19] = uB19;
  balls[20] = uB20;

  let oc = ro - uCenter;
  let bound = max(uBoundRadius, 0.1);
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

  let stepCount = max(uSteps, 4);
  let invSteps = 1.0 / f32(stepCount);
  var hit = false;
  var hitT = tMax;
  var prevT = tMin;
  var prevDensity = -1.0;

  for (var i: i32 = 0; i < ${MAX_SURFACE_STEPS}; i = i + 1) {
    if (i >= stepCount) { break; }

    let t = mix(tMin, tMax, f32(i + 1) * invSteps);
    let p = ro + rd * t;
    var field = 0.0;
    for (var bi: i32 = 0; bi < ${MAX_METABALLS}; bi = bi + 1) {
      if (bi >= uBallCount) { break; }
      field = field + fieldContribution(p, balls[bi]);
    }

    var density = field - uIsoLevel;
    if (uNoiseAmp > 0.001) {
      let surfaceNoise = pseudoNoise((p - uCenter) * uWobbleFreq + vec3<f32>(
        uTime * 0.31,
        uTime * 0.23,
        uTime * 0.19
      ) * uWobbleSpeed);
      density = density + surfaceNoise * uNoiseAmp;
    }

    if (density >= 0.0 && prevDensity < 0.0) {
      var lo = prevT;
      var hi = t;
      for (var ri: i32 = 0; ri < ${MAX_REFINE_STEPS}; ri = ri + 1) {
        if (ri >= uRefineSteps) { break; }
        let mid = (lo + hi) * 0.5;
        let mp = ro + rd * mid;
        var mf = 0.0;
        for (var bi: i32 = 0; bi < ${MAX_METABALLS}; bi = bi + 1) {
          if (bi >= uBallCount) { break; }
          mf = mf + fieldContribution(mp, balls[bi]);
        }
        var mn = 0.0;
        if (uNoiseAmp > 0.001) {
          mn = pseudoNoise((mp - uCenter) * uWobbleFreq + vec3<f32>(
            uTime * 0.31,
            uTime * 0.23,
            uTime * 0.19
          ) * uWobbleSpeed);
        }
        if (mf - uIsoLevel + mn * uNoiseAmp >= 0.0) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      hitT = (lo + hi) * 0.5;
      hit = true;
      break;
    }

    prevT = t;
    prevDensity = density;
  }

  if (!hit) {
    return vec4<f32>(0.0);
  }

  let p = ro + rd * hitT;
  var grad = vec3<f32>(0.0);
  var fieldAtHit = 0.0;
  for (var bi: i32 = 0; bi < ${MAX_METABALLS}; bi = bi + 1) {
    if (bi >= uBallCount) { break; }
    fieldAtHit = fieldAtHit + fieldContribution(p, balls[bi]);
    grad = grad + fieldGradient(p, balls[bi]);
  }
  var normal = normalize(uCenter - p);
  if (dot(grad, grad) > 0.000001) {
    normal = normalize(-grad);
  }

  let viewDir = normalize(-rd);
  let lightDir = normalize(vec3<f32>(-0.45, 0.82, 0.35));
  let halfDir = normalize(lightDir + viewDir);
  let diffuse = clamp(dot(normal, lightDir) * 0.55 + 0.45, 0.0, 1.0);
  let fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 2.0);
  let specular = pow(max(dot(normal, halfDir), 0.0), 34.0);

  var blend = max(abs(normal), vec3<f32>(0.00001));
  blend = blend / max(blend.x + blend.y + blend.z, 0.00001);

  let flow = vec3<f32>(
    sin(uTime * 0.11),
    cos(uTime * 0.17),
    sin(uTime * 0.07)
  ) * (0.18 * uWobbleSpeed);
  let xTex = waterTexel(p.yz + flow.yz, uTime, uWobbleFreq, uWobbleSpeed, uCool, uWarm, uHot);
  let yTex = waterTexel(p.xz + flow.xz, uTime, uWobbleFreq, uWobbleSpeed, uCool, uWarm, uHot);
  let zTex = waterTexel(p.xy + flow.xy, uTime, uWobbleFreq, uWobbleSpeed, uCool, uWarm, uHot);
  let water = xTex * blend.x + yTex * blend.y + zTex * blend.z;
  let nearSurface = smoothstep(uIsoLevel, uIsoLevel * 2.2, fieldAtHit);

  var color = water * (0.62 + diffuse * 0.38);
  color = color + uHot * (specular * 0.5 + fresnel * 0.18);
  color = color + uWarm * (nearSurface * uEnergy * 0.06);
  color = clamp(color * uBrightness, vec3<f32>(0.0), vec3<f32>(1.0));

  let alpha = clamp(uAlpha + fresnel * 0.04, 0.25, 1.0);
  return vec4<f32>(color, alpha);
}

fn fieldContribution(p: vec3<f32>, ball: vec4<f32>) -> f32 {
  let radius = max(ball.w, 0.0);
  if (radius <= 0.0001) {
    return 0.0;
  }

  let d = p - ball.xyz;
  let d2 = dot(d, d);
  let r2 = radius * radius;

  // Same reciprocal field shape as the reference WebGPU metaballs, but with
  // a hard far cutoff so tiny fingertip balls do not affect every sample.
  if (d2 > r2 * 16.0) {
    return 0.0;
  }

  return r2 / max(d2, 0.00001);
}

fn fieldGradient(p: vec3<f32>, ball: vec4<f32>) -> vec3<f32> {
  let radius = max(ball.w, 0.0);
  if (radius <= 0.0001) {
    return vec3<f32>(0.0);
  }

  let d = p - ball.xyz;
  let d2 = dot(d, d);
  let r2 = radius * radius;
  if (d2 > r2 * 16.0) {
    return vec3<f32>(0.0);
  }

  return -2.0 * r2 * d / max(d2 * d2, 0.00001);
}

fn waterTexel(
  uv: vec2<f32>,
  uTime: f32,
  uScale: f32,
  uFlowSpeed: f32,
  uDeep: vec3<f32>,
  uSurface: vec3<f32>,
  uShine: vec3<f32>
) -> vec3<f32> {
  let scale = max(uScale, 0.1);
  let t = uTime * max(uFlowSpeed, 0.0);
  let p = uv * scale;
  let flowA = vec2<f32>(t * 0.18, -t * 0.11);
  let flowB = vec2<f32>(-t * 0.07, t * 0.15);

  let nA = pseudoNoise(vec3<f32>(p + flowA, t * 0.08));
  let nB = pseudoNoise(vec3<f32>(p.yx * 1.73 + flowB, t * 0.13));
  let waveA = sin((p.x + nA * 0.8) * 7.0 + t * 1.15);
  let waveB = cos((p.y + nB * 0.7) * 5.5 - t * 0.82);
  let ripple = waveA * waveB;
  let foam = smoothstep(0.52, 0.96, abs(ripple));
  let body = mix(uDeep, uSurface, clamp(0.45 + nA * 0.18 + nB * 0.12, 0.0, 1.0));
  return mix(body, uShine, foam * 0.28);
}
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const metaballFn = wgslFn(metaballWGSL, [pseudoNoiseFn] as any);

function colorToVec3(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

type SmoothedMetaball = {
  id: string | null;
  position: THREE.Vector3;
  radius: number;
};

export class PlasmaOrb {
  readonly mesh: THREE.Mesh;
  private radius: number;
  private boundRadius = 1.08;
  private fingerRadius = 0.052;
  private fingerInfluence = 1.0;
  private activeTipLimit = 12;
  private activeTipRange = 1.18;
  private energyBoost = 1;
  private pane?: Pane;
  private smoothedEnergy = 0;
  private targetEnergy = 0;
  private targetFingertips: PlasmaOrbMetaball[] = [];
  private smoothedFingertips: SmoothedMetaball[] = Array.from(
    { length: MAX_FINGER_METABALLS },
    () => ({ id: null, position: new THREE.Vector3(), radius: 0 })
  );

  private uTime = uniform(0);
  private uCenter = uniform(new THREE.Vector3());
  private uBoundRadius = uniform(this.boundRadius);
  private uEnergy = uniform(0);
  private uIsoLevel = uniform(1.0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uBallCount = (uniform as any)(1, 'int');
  private uNoiseAmp = uniform(0.0);
  private uWobbleFreq = uniform(3.2);
  private uWobbleSpeed = uniform(0.75);
  private uB0 = uniform(new THREE.Vector4());
  private uB1 = uniform(new THREE.Vector4());
  private uB2 = uniform(new THREE.Vector4());
  private uB3 = uniform(new THREE.Vector4());
  private uB4 = uniform(new THREE.Vector4());
  private uB5 = uniform(new THREE.Vector4());
  private uB6 = uniform(new THREE.Vector4());
  private uB7 = uniform(new THREE.Vector4());
  private uB8 = uniform(new THREE.Vector4());
  private uB9 = uniform(new THREE.Vector4());
  private uB10 = uniform(new THREE.Vector4());
  private uB11 = uniform(new THREE.Vector4());
  private uB12 = uniform(new THREE.Vector4());
  private uB13 = uniform(new THREE.Vector4());
  private uB14 = uniform(new THREE.Vector4());
  private uB15 = uniform(new THREE.Vector4());
  private uB16 = uniform(new THREE.Vector4());
  private uB17 = uniform(new THREE.Vector4());
  private uB18 = uniform(new THREE.Vector4());
  private uB19 = uniform(new THREE.Vector4());
  private uB20 = uniform(new THREE.Vector4());
  private uCool = uniform(colorToVec3(0x146f92));
  private uWarm = uniform(colorToVec3(0x5bd0ca));
  private uHot = uniform(colorToVec3(0xd8fff8));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uSteps = (uniform as any)(12, 'int');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uRefineSteps = (uniform as any)(2, 'int');
  private uBrightness = uniform(1.05);
  private uAlpha = uniform(0.96);

  private ballUniforms = [
    this.uB0, this.uB1, this.uB2, this.uB3, this.uB4, this.uB5, this.uB6,
    this.uB7, this.uB8, this.uB9, this.uB10, this.uB11, this.uB12, this.uB13,
    this.uB14, this.uB15, this.uB16, this.uB17, this.uB18, this.uB19, this.uB20,
  ];

  constructor(scene: THREE.Scene, options: PlasmaOrbOptions) {
    this.radius = options.radius ?? 0.42;
    this.uCenter.value.copy(options.position);
    this.uB0.value.set(options.position.x, options.position.y, options.position.z, this.radius);

    const geometry = new THREE.SphereGeometry(1, 48, 24);
    const material = this.buildMaterial();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(options.position);
    this.mesh.scale.setScalar(this.boundRadius);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);

    if (options.paneDock) {
      const container = document.createElement('div');
      options.paneDock.appendChild(container);
      this.pane = new Pane({ title: 'Water Metaballs', container });
      this.pane.expanded = false;
      this.registerTweaks();
    }
  }

  private registerTweaks(): void {
    if (!this.pane) return;
    const pane = this.pane;
    const params = {
      radius: this.radius,
      boundRadius: this.boundRadius,
      fingerRadius: this.fingerRadius,
      fingerInfluence: this.fingerInfluence,
      activeTipLimit: this.activeTipLimit,
      activeTipRange: this.activeTipRange,
      isoLevel: this.uIsoLevel.value,
      noiseAmp: this.uNoiseAmp.value,
      wobbleFreq: this.uWobbleFreq.value,
      wobbleSpeed: this.uWobbleSpeed.value,
      energyBoost: this.energyBoost,
      coolColor: vec3ToHex(this.uCool.value),
      warmColor: vec3ToHex(this.uWarm.value),
      hotColor: vec3ToHex(this.uHot.value),
      surfaceSteps: this.uSteps.value,
      refineSteps: this.uRefineSteps.value,
      brightness: this.uBrightness.value,
      alpha: this.uAlpha.value,
    };

    pane.addBinding(params, 'radius', { label: 'orb radius', min: 0.2, max: 0.8, step: 0.01 }).on('change', e => {
      this.radius = e.value;
    });
    pane.addBinding(params, 'boundRadius', { label: 'field bounds', min: 0.7, max: 1.8, step: 0.01 }).on('change', e => {
      this.boundRadius = e.value;
      this.uBoundRadius.value = e.value;
      this.mesh.scale.setScalar(e.value);
    });
    pane.addBinding(params, 'fingerRadius', { label: 'tip radius', min: 0.015, max: 0.16, step: 0.001 }).on('change', e => {
      this.fingerRadius = e.value;
    });
    pane.addBinding(params, 'fingerInfluence', { label: 'tip influence', min: 0, max: 3, step: 0.01 }).on('change', e => {
      this.fingerInfluence = e.value;
    });
    pane.addBinding(params, 'activeTipLimit', { label: 'active tips', min: 2, max: MAX_FINGER_METABALLS, step: 1 }).on('change', e => {
      this.activeTipLimit = e.value | 0;
    });
    pane.addBinding(params, 'activeTipRange', { label: 'tip range', min: 0.45, max: 1.8, step: 0.01 }).on('change', e => {
      this.activeTipRange = e.value;
    });
    pane.addBinding(params, 'isoLevel', { label: 'melt threshold', min: 0.45, max: 1.8, step: 0.01 }).on('change', e => {
      this.uIsoLevel.value = e.value;
    });
    pane.addBinding(params, 'noiseAmp', { label: 'shape ripple', min: 0, max: 0.25, step: 0.005 }).on('change', e => {
      this.uNoiseAmp.value = e.value;
    });
    pane.addBinding(params, 'wobbleFreq', { label: 'texture scale', min: 0.5, max: 12, step: 0.1 }).on('change', e => {
      this.uWobbleFreq.value = e.value;
    });
    pane.addBinding(params, 'wobbleSpeed', { label: 'flow speed', min: 0, max: 4, step: 0.05 }).on('change', e => {
      this.uWobbleSpeed.value = e.value;
    });
    pane.addBinding(params, 'energyBoost', { label: 'energy boost', min: 0, max: 2, step: 0.05 }).on('change', e => {
      this.energyBoost = e.value;
    });
    pane.addBinding(params, 'coolColor', { label: 'deep' }).on('change', e => {
      hexToVec3(e.value, this.uCool.value);
    });
    pane.addBinding(params, 'warmColor', { label: 'surface' }).on('change', e => {
      hexToVec3(e.value, this.uWarm.value);
    });
    pane.addBinding(params, 'hotColor', { label: 'shine' }).on('change', e => {
      hexToVec3(e.value, this.uHot.value);
    });

    const advanced = pane.addFolder({ title: 'quality / tone', expanded: false });
    advanced.addBinding(params, 'surfaceSteps', { label: 'surface steps', min: 6, max: MAX_SURFACE_STEPS, step: 1 }).on('change', e => {
      this.uSteps.value = e.value | 0;
    });
    advanced.addBinding(params, 'refineSteps', { label: 'edge refine', min: 0, max: MAX_REFINE_STEPS, step: 1 }).on('change', e => {
      this.uRefineSteps.value = e.value | 0;
    });
    advanced.addBinding(params, 'brightness', { min: 0.2, max: 2, step: 0.05 }).on('change', e => {
      this.uBrightness.value = e.value;
    });
    advanced.addBinding(params, 'alpha', { min: 0.1, max: 1, step: 0.01 }).on('change', e => {
      this.uAlpha.value = e.value;
    });
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = true;
    material.side = THREE.FrontSide;

    try {
      const colorNode = Fn(() => {
        const ro = cameraPosition;
        const rd = positionWorld.sub(cameraPosition).normalize();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sample = metaballFn({
          ro,
          rd,
          uCenter: this.uCenter,
          uBoundRadius: this.uBoundRadius,
          uTime: this.uTime,
          uEnergy: this.uEnergy,
          uIsoLevel: this.uIsoLevel,
          uBallCount: this.uBallCount,
          uNoiseAmp: this.uNoiseAmp,
          uWobbleFreq: this.uWobbleFreq,
          uWobbleSpeed: this.uWobbleSpeed,
          uB0: this.uB0,
          uB1: this.uB1,
          uB2: this.uB2,
          uB3: this.uB3,
          uB4: this.uB4,
          uB5: this.uB5,
          uB6: this.uB6,
          uB7: this.uB7,
          uB8: this.uB8,
          uB9: this.uB9,
          uB10: this.uB10,
          uB11: this.uB11,
          uB12: this.uB12,
          uB13: this.uB13,
          uB14: this.uB14,
          uB15: this.uB15,
          uB16: this.uB16,
          uB17: this.uB17,
          uB18: this.uB18,
          uB19: this.uB19,
          uB20: this.uB20,
          uCool: this.uCool,
          uWarm: this.uWarm,
          uHot: this.uHot,
          uSteps: this.uSteps,
          uRefineSteps: this.uRefineSteps,
          uBrightness: this.uBrightness,
          uAlpha: this.uAlpha,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;
        Discard(sample.a.lessThan(0.04));
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

  setFingertips(fingertips: PlasmaOrbMetaball[]): void {
    this.targetFingertips = fingertips.slice(0, MAX_FINGER_METABALLS);
  }

  setEnergy(energy: number): void {
    this.targetEnergy = Math.max(0, Math.min(1, energy * this.energyBoost));
  }

  update(elapsed: number, delta: number): void {
    const energyAlpha = 1 - Math.exp(-delta * 5);
    this.smoothedEnergy += (this.targetEnergy - this.smoothedEnergy) * energyAlpha;

    const posAlpha = 1 - Math.exp(-delta * 18);
    const radiusAlpha = 1 - Math.exp(-delta * 12);
    const effectiveFingerRadius = this.fingerRadius * Math.sqrt(Math.max(this.fingerInfluence, 0));
    const activeLimit = Math.max(0, Math.min(MAX_FINGER_METABALLS, this.activeTipLimit | 0));
    const activeRangeSq = Math.max(0.01, this.activeTipRange * this.activeTipRange);
    const radiusEpsilon = Math.max(effectiveFingerRadius * 0.04, 0.0005);

    // Only tracked fingertips that are within the orb's pull range qualify.
    // Everything is sorted by distance so the closest tips win the slot budget.
    const candidates = this.targetFingertips
      .filter(target => target.tracked !== false)
      .map(target => ({
        target,
        distanceSq: target.position.distanceToSquared(this.mesh.position),
      }))
      .filter(entry => entry.distanceSq <= activeRangeSq)
      .sort((a, b) => a.distanceSq - b.distanceSq);

    // Map current id → slot so a fingertip keeps the same smoothed slot
    // across frames. Without this, sort-order changes would snap a slot's
    // identity to a different physical fingertip and the lerp would streak
    // through space.
    const slotById = new Map<string, number>();
    for (let i = 0; i < this.smoothedFingertips.length; i += 1) {
      const id = this.smoothedFingertips[i].id;
      if (id) slotById.set(id, i);
    }

    const targetForSlot: (PlasmaOrbMetaball | null)[] = new Array(this.smoothedFingertips.length).fill(null);
    const claimed = new Set<number>();
    let kept = 0;

    // Pass 1 — let any candidate that already owns a slot keep it.
    for (const entry of candidates) {
      if (kept >= activeLimit) break;
      const slot = slotById.get(entry.target.id);
      if (slot != null) {
        targetForSlot[slot] = entry.target;
        claimed.add(slot);
        kept += 1;
      }
    }

    // Pass 2 — new fingertips fill genuinely empty slots first, then any
    // unclaimed (fading) slot if we run out of empty ones.
    for (const entry of candidates) {
      if (kept >= activeLimit) break;
      if (slotById.has(entry.target.id)) continue;
      let free = -1;
      for (let i = 0; i < this.smoothedFingertips.length; i += 1) {
        if (claimed.has(i)) continue;
        const slot = this.smoothedFingertips[i];
        if (slot.id == null && slot.radius <= radiusEpsilon) { free = i; break; }
      }
      if (free === -1) {
        for (let i = 0; i < this.smoothedFingertips.length; i += 1) {
          if (claimed.has(i)) continue;
          free = i;
          break;
        }
      }
      if (free === -1) break;
      const slot = this.smoothedFingertips[free];
      slot.id = entry.target.id;
      slot.position.copy(entry.target.position);
      slot.radius = 0;
      targetForSlot[free] = entry.target;
      claimed.add(free);
      kept += 1;
    }

    // Smooth each slot toward its target (or fade out if it has none).
    for (let i = 0; i < this.smoothedFingertips.length; i += 1) {
      const slot = this.smoothedFingertips[i];
      const target = targetForSlot[i];
      if (target) {
        slot.position.lerp(target.position, posAlpha);
        slot.radius += (effectiveFingerRadius - slot.radius) * radiusAlpha;
      } else {
        slot.radius += (0 - slot.radius) * radiusAlpha;
        if (slot.radius <= radiusEpsilon) {
          slot.radius = 0;
          slot.id = null;
        }
      }
    }

    // Pack contiguously into the shader uniforms. The shader sums field
    // contributions, so packing order is irrelevant to the look but lets
    // uBallCount stay tight for ray-march cost.
    this.ballUniforms[0].value.set(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z, this.radius);
    let writeIdx = 1;
    for (let i = 0; i < this.smoothedFingertips.length; i += 1) {
      const slot = this.smoothedFingertips[i];
      if (slot.radius > radiusEpsilon) {
        this.ballUniforms[writeIdx].value.set(slot.position.x, slot.position.y, slot.position.z, slot.radius);
        writeIdx += 1;
      }
    }
    for (let j = writeIdx; j < MAX_METABALLS; j += 1) {
      this.ballUniforms[j].value.set(0, 0, 0, 0);
    }

    this.uBallCount.value = writeIdx;
    this.uTime.value = elapsed;
    this.uEnergy.value = this.smoothedEnergy;
    this.uCenter.value.copy(this.mesh.position);
    this.uBoundRadius.value = this.boundRadius;
    this.mesh.scale.setScalar(this.boundRadius);
  }

  dispose(): void {
    this.pane?.dispose();
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
