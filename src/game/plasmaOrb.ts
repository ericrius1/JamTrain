import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, positionWorld, uniform, wgslFn } from 'three/tsl';

export type PlasmaOrbAttractor = {
  position: THREE.Vector3;
  weight: number;
};

export type PlasmaOrbOptions = {
  position: THREE.Vector3;
  radius?: number;
};

const MAX_ATTRACTORS = 4;
const RAYMARCH_STEPS = 48;

const plasmaWGSL = /* wgsl */ `
fn plasmaOrb(
  ro: vec3<f32>,
  rd: vec3<f32>,
  uCenter: vec3<f32>,
  uRadius: f32,
  uTime: f32,
  uEnergy: f32,
  uNoiseAmp: f32,
  uAttractorReach: f32,
  uAttractorStrength: f32,
  uA0: vec4<f32>,
  uA1: vec4<f32>,
  uA2: vec4<f32>,
  uA3: vec4<f32>,
  uCool: vec3<f32>,
  uWarm: vec3<f32>,
  uHot: vec3<f32>
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

  var col = vec3<f32>(0.0);
  var alphaAccum = 0.0;
  var t = tMin;
  let dtBase = (tMax - tMin) / 48.0;
  var lastDensity = 0.0;

  for (var i: i32 = 0; i < 48; i = i + 1) {
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

    // Cheap 3D pseudo-noise for low-frequency wobble.
    let nseed = p0 * 2.4 + vec3<f32>(uTime * 0.3, uTime * 0.21, uTime * 0.18);
    let noise = (
      sin(nseed.x + cos(nseed.y * 1.3)) +
      sin(nseed.y * 1.1 + cos(nseed.z * 0.9)) +
      sin(nseed.z * 1.2 + cos(nseed.x * 1.05))
    ) * (1.0 / 3.0);
    let displacement = noise * uNoiseAmp;

    let surfaceR = uRadius + radiusBoost + displacement;
    let outsideSurface = length(p0) - surfaceR;
    if (outsideSurface > 0.0) {
      lastDensity = 0.0;
      continue;
    }

    // Plasma fold (port of reference shadertoy 'map').
    var p = p0 + foldOffset;
    let cFold = p;
    var density = 0.0;
    for (var k: i32 = 0; k < 10; k = k + 1) {
      let dotPP = max(dot(p, p), 1e-4);
      p = 0.7 * abs(p) / dotPP - 0.7;
      let yz = vec2<f32>(p.y, p.z);
      let csq = vec2<f32>(yz.x * yz.x - yz.y * yz.y, 2.0 * yz.x * yz.y);
      let folded = vec3<f32>(p.x, csq.x, csq.y);
      p = folded.zxy;
      density = density + exp(-19.0 * abs(dot(p, cFold)));
    }
    density = density * 0.5;
    lastDensity = density;

    let bright = clamp(density, 0.0, 4.0);
    col = col * 0.99 + 0.08 * vec3<f32>(bright * bright * bright, bright * bright, bright);
    alphaAccum = alphaAccum + 0.04 * bright;
  }

  col = 0.5 * log(1.0 + col);

  // Palette: cool → hot for density, with amber accent gated by energy.
  let lum = clamp(dot(col, vec3<f32>(0.299, 0.587, 0.114)), 0.0, 2.0);
  let coolBlend = mix(uCool, uHot, smoothstep(0.0, 0.9, lum));
  let amberAccent = smoothstep(0.4, 0.95, lum) * uEnergy;
  let palette = mix(coolBlend, uWarm, amberAccent);
  let tinted = col * palette * 1.6;

  // Rim fresnel.
  let rimDir = normalize(oc + rd * tMin);
  let fresnel = pow(1.0 - clamp(abs(dot(rd, rimDir)), 0.0, 1.0), 3.0);
  let rim = uCool * fresnel * 0.55;

  let outRgb = tinted + rim;
  let outAlpha = clamp(alphaAccum * 1.4 + fresnel * 0.4, 0.0, 1.0);
  return vec4<f32>(outRgb, outAlpha);
}
`;

const plasmaFn = wgslFn(plasmaWGSL);

function colorToVec3(hex: number): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export class PlasmaOrb {
  readonly mesh: THREE.Mesh;
  private readonly radius: number;
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
  private uNoiseAmp = uniform(0.08);
  private uAttractorReach = uniform(0.55);
  private uAttractorStrength = uniform(0.22);
  private uA0 = uniform(new THREE.Vector4());
  private uA1 = uniform(new THREE.Vector4());
  private uA2 = uniform(new THREE.Vector4());
  private uA3 = uniform(new THREE.Vector4());
  private uCool = uniform(colorToVec3(0x2bd6f7));
  private uWarm = uniform(colorToVec3(0xffae42));
  private uHot = uniform(colorToVec3(0xfff4d0));

  constructor(scene: THREE.Scene, options: PlasmaOrbOptions) {
    this.radius = options.radius ?? 0.42;
    this.uRadius.value = this.radius;
    this.uCenter.value.copy(options.position);

    const geometry = new THREE.SphereGeometry(this.radius * 1.5, 32, 24);
    const material = this.buildMaterial();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(options.position);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.BackSide;
    material.blending = THREE.AdditiveBlending;

    try {
      const colorNode = Fn(() => {
        const ro = cameraPosition;
        const rd = positionWorld.sub(cameraPosition).normalize();
        return plasmaFn({
          ro,
          rd,
          uCenter: this.uCenter,
          uRadius: this.uRadius,
          uTime: this.uTime,
          uEnergy: this.uEnergy,
          uNoiseAmp: this.uNoiseAmp,
          uAttractorReach: this.uAttractorReach,
          uAttractorStrength: this.uAttractorStrength,
          uA0: this.uA0,
          uA1: this.uA1,
          uA2: this.uA2,
          uA3: this.uA3,
          uCool: this.uCool,
          uWarm: this.uWarm,
          uHot: this.uHot,
        });
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
    this.targetEnergy = Math.max(0, Math.min(1, energy));
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
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
