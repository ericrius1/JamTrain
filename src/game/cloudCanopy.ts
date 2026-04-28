import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  mix,
  mx_fractal_noise_float as mx_fractal_noise_float_typed,
  smoothstep as smoothstep_typed,
  uv,
  vec2 as vec2_typed,
  vec3,
} from 'three/tsl';

const PANEL_WIDTH = 18.8;
const PANEL_HEIGHT = 4.0;
const PANEL_X = -4.18;
const PANEL_Y = 1.6;

// TSL UniformNode generics produce noisy errors when chained with helpers like
// vec2/smoothstep/mx_fractal_noise_float — the runtime accepts any node, but
// the .d.ts overloads disagree. Keep the typed imports for autocomplete and
// re-cast through these locals once.
type AnyNode = any;
const vec2: AnyNode = vec2_typed;
const smoothstep: AnyNode = smoothstep_typed;
const mx_fractal_noise_float: AnyNode = mx_fractal_noise_float_typed;

export interface CloudUniforms {
  cloudCover: AnyNode;
  skyTravel: AnyNode;
  goldenHour: AnyNode;
  skyNight: AnyNode;
  rainAmount: AnyNode;
}

function vec3FromHex(hex: number) {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return vec3(r, g, b);
}

export class CloudCanopy {
  private root = new THREE.Group();
  private mesh!: THREE.Mesh;

  constructor(private scene: THREE.Scene, private uniforms: CloudUniforms) {}

  build(): void {
    this.root.name = 'cloud-canopy';
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;

    // Returns vec2(density, topLitFactor) for one FBM cloud layer.
    const layerField = Fn(
      ([scaleX, scaleY, yShift, scrollMul, threshOffset, threshSpan, vMaskLo, vMaskHi]: AnyNode[]) => {
        const u = uv();
        const aspect = float(PANEL_WIDTH / PANEL_HEIGHT);
        const px = u.x.mul(aspect);
        const py = u.y;
        const scroll = this.uniforms.skyTravel.mul(scrollMul);
        const p = vec2(px.mul(scaleX).sub(scroll), py.mul(scaleY).add(yShift));
        const raw = mx_fractal_noise_float(p, 5, 2.0, 0.55).mul(0.5).add(0.5);
        const upper = vec2(p.x, p.y.add(0.10));
        const upperRaw = mx_fractal_noise_float(upper, 5, 2.0, 0.55).mul(0.5).add(0.5);
        const cover = this.uniforms.cloudCover;
        const threshold = threshOffset.sub(cover.mul(0.30));
        const density = smoothstep(threshold, threshold.add(threshSpan), raw);
        const vMask = smoothstep(vMaskLo, vMaskLo.add(0.18), py)
          .mul(float(1).sub(smoothstep(vMaskHi.sub(0.10), vMaskHi, py)));
        const masked = density.mul(vMask);
        const topLit = raw.sub(upperRaw).mul(3.0).clamp(0, 1);
        return vec2(masked, topLit);
      },
    ) as AnyNode;

    // Two layers at different scroll speeds & scales for depth/parallax.
    const farLayer = () =>
      layerField(
        float(0.62), float(1.7),  float(0.18),  float(0.045),
        float(0.62), float(0.18), float(0.30),  float(0.92),
      );
    const nearLayer = () =>
      layerField(
        float(1.20), float(2.4),  float(-0.40), float(0.090),
        float(0.66), float(0.13), float(0.36),  float(0.98),
      );

    material.colorNode = Fn(() => {
      const far = farLayer().toVar('far');
      const near = nearLayer().toVar('near');

      const dayLit = vec3FromHex(0xffffff);
      const dayShadow = vec3FromHex(0x5d6d80);
      const sunsetLit = vec3FromHex(0xffd6a4);
      const sunsetShadow = vec3FromHex(0xa15c4f);
      const nightLit = vec3FromHex(0x2a3848);
      const nightShadow = vec3FromHex(0x0a1118);
      const litBase = mix(dayLit, sunsetLit, this.uniforms.goldenHour);
      const litFinal = mix(litBase, nightLit, this.uniforms.skyNight);
      const shadowBase = mix(dayShadow, sunsetShadow, this.uniforms.goldenHour);
      const shadowFinal = mix(shadowBase, nightShadow, this.uniforms.skyNight);
      const rainMute = mix(float(1), float(0.55), this.uniforms.rainAmount.clamp(0, 1));

      const farColor = mix(shadowFinal, litFinal, far.y);
      const nearColor = mix(shadowFinal, litFinal, near.y);

      // Density-weighted blend so transparent edges don't pull color toward black.
      const eps = float(0.0001);
      const total = far.x.add(near.x).max(eps);
      const blended = farColor.mul(far.x).add(nearColor.mul(near.x)).div(total);
      return blended.mul(rainMute);
    })();

    material.opacityNode = Fn(() => {
      const far = farLayer().toVar('farO');
      const near = nearLayer().toVar('nearO');
      // Composite layer alphas with 1 - (1-a)(1-b).
      const inv = float(1).sub(far.x).mul(float(1).sub(near.x));
      return float(1).sub(inv).mul(0.96);
    })();

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), material);
    this.mesh.rotation.y = Math.PI / 2;
    this.mesh.position.set(PANEL_X, PANEL_Y, 0);
    this.mesh.renderOrder = -25;
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
    this.scene.add(this.root);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
  }
}
