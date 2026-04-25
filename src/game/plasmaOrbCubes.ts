import * as THREE from 'three/webgpu';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { Fn, cameraPosition, normalWorld, positionWorld, uniform, vec3 } from 'three/tsl';
import { Pane } from 'tweakpane';

export type PlasmaOrbCubesOptions = {
  position: THREE.Vector3;
  /** Cube half-extent in world units. The mesh covers [center - extent, center + extent]^3. */
  extent?: number;
  /** Initial grid resolution. */
  resolution?: number;
  paneDock?: HTMLElement;
};

const params = {
  enabled: true,
  resolution: 40,
  isolation: 80,
  coreStrength: 0.85,
  coreSubtract: 12,
  fingerStrength: 0.55,
  fingerSubtract: 18,
  fingerFalloff: 1.4,
  rimSharpness: 2.4,
  baseAlpha: 0.55,
  rimAlpha: 0.95,
  brightness: 1.2,
  additive: true,
};

export type PlasmaOrbCubesParams = typeof params;

export class PlasmaOrbCubes {
  private scene: THREE.Scene;
  private center: THREE.Vector3;
  private extent: number;
  private resolution: number;
  private cubes!: MarchingCubes;
  private material!: THREE.MeshBasicNodeMaterial;
  private fingertips: THREE.Vector3[] = [];
  private orbStrength = params.coreStrength;
  private params = { ...params };
  private pane?: Pane;

  private uTint = uniform(new THREE.Vector3(0.3, 1.0, 0.85));
  private uHotTint = uniform(new THREE.Vector3(0.7, 1.0, 0.9));
  private uBaseAlpha = uniform(params.baseAlpha);
  private uRimAlpha = uniform(params.rimAlpha);
  private uRimSharpness = uniform(params.rimSharpness);
  private uBrightness = uniform(params.brightness);
  private uEnergy = uniform(0);

  constructor(scene: THREE.Scene, options: PlasmaOrbCubesOptions) {
    this.scene = scene;
    this.center = options.position.clone();
    this.extent = options.extent ?? 0.84;
    this.resolution = options.resolution ?? this.params.resolution;
    this.params.resolution = this.resolution;
    this.material = this.buildMaterial();
    this.rebuildCubes();

    if (options.paneDock) {
      const container = document.createElement('div');
      options.paneDock.appendChild(container);
      this.pane = new Pane({ title: 'Marching Cubes', container });
      this.pane.expanded = false;
      this.registerTweaks();
    }
  }

  setTints(coolRgb: THREE.Vector3, hotRgb: THREE.Vector3): void {
    this.uTint.value.copy(coolRgb);
    this.uHotTint.value.copy(hotRgb);
  }

  setOrbStrength(strength: number): void {
    this.orbStrength = strength;
  }

  setFingertips(fingertips: THREE.Vector3[]): void {
    this.fingertips = fingertips;
  }

  setEnergy(energy: number): void {
    this.uEnergy.value = Math.max(0, Math.min(1, energy));
  }

  update(): void {
    if (!this.cubes.visible) return;
    this.cubes.reset();
    this.cubes.isolation = this.params.isolation;

    this.addBallWorld(
      this.center,
      this.params.coreStrength * this.orbStrength,
      this.params.coreSubtract
    );

    for (const tip of this.fingertips) {
      const dist = tip.distanceTo(this.center);
      const falloff = Math.exp(-Math.pow(dist / Math.max(this.extent, 0.001), 2) * this.params.fingerFalloff);
      const strength = this.params.fingerStrength * falloff;
      if (strength < 0.005) continue;
      this.addBallWorld(tip, strength, this.params.fingerSubtract);
    }

    this.cubes.update();
  }

  dispose(): void {
    this.pane?.dispose();
    this.scene.remove(this.cubes);
    this.cubes.geometry.dispose();
    this.material.dispose();
  }

  private addBallWorld(world: THREE.Vector3, strength: number, subtract: number): void {
    const lx = (world.x - this.center.x) / this.extent;
    const ly = (world.y - this.center.y) / this.extent;
    const lz = (world.z - this.center.z) / this.extent;
    if (Math.abs(lx) > 1 || Math.abs(ly) > 1 || Math.abs(lz) > 1) return;
    const bx = (lx + 1) * 0.5;
    const by = (ly + 1) * 0.5;
    const bz = (lz + 1) * 0.5;
    this.cubes.addBall(bx, by, bz, strength, subtract);
  }

  private rebuildCubes(): void {
    if (this.cubes) {
      this.scene.remove(this.cubes);
      this.cubes.geometry.dispose();
    }
    const cubes = new MarchingCubes(this.resolution, this.material, false, false, 32000);
    cubes.position.copy(this.center);
    cubes.scale.setScalar(this.extent);
    cubes.frustumCulled = false;
    cubes.renderOrder = 9;
    cubes.isolation = this.params.isolation;
    this.scene.add(cubes);
    this.cubes = cubes;
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = this.params.additive ? THREE.AdditiveBlending : THREE.NormalBlending;

    try {
      const colorNode = Fn(() => {
        const viewDir = positionWorld.sub(cameraPosition).normalize();
        // Fresnel-style edge highlight: 1 at silhouette, 0 facing camera.
        const facing = normalWorld.dot(viewDir.negate()).clamp(0, 1);
        const fresnel = facing.oneMinus().pow(this.uRimSharpness);
        // Mix base teal with brighter hot tint at the rim.
        const tint = this.uTint.toVar();
        const hot = this.uHotTint.toVar();
        const rgb = vec3(tint).add(vec3(hot).sub(vec3(tint)).mul(fresnel)).mul(this.uBrightness);
        return rgb;
      })();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      material.colorNode = colorNode as any;

      const opacityNode = Fn(() => {
        const viewDir = positionWorld.sub(cameraPosition).normalize();
        const facing = normalWorld.dot(viewDir.negate()).clamp(0, 1);
        const fresnel = facing.oneMinus().pow(this.uRimSharpness);
        // Base body alpha plus rim accent.
        return this.uBaseAlpha.add(this.uRimAlpha.sub(this.uBaseAlpha).mul(fresnel));
      })();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      material.opacityNode = opacityNode as any;
    } catch (err) {
      console.error('[PlasmaOrbCubes] WGSL compile failed', err);
    }

    return material;
  }

  private registerTweaks(): void {
    if (!this.pane) return;
    const pane = this.pane;

    pane.addBinding(this.params, 'enabled').on('change', e => {
      this.cubes.visible = e.value;
    });
    pane.addBinding(this.params, 'resolution', { options: { 24: 24, 32: 32, 40: 40, 56: 56, 72: 72 } }).on('change', e => {
      this.resolution = e.value as number;
      this.rebuildCubes();
    });
    pane.addBinding(this.params, 'isolation', { min: 20, max: 240, step: 1 });
    pane.addBinding(this.params, 'coreStrength', { label: 'core str', min: 0, max: 2, step: 0.05 });
    pane.addBinding(this.params, 'coreSubtract', { label: 'core sub', min: 1, max: 80, step: 1 });
    pane.addBinding(this.params, 'fingerStrength', { label: 'finger str', min: 0, max: 2, step: 0.05 });
    pane.addBinding(this.params, 'fingerSubtract', { label: 'finger sub', min: 1, max: 80, step: 1 });
    pane.addBinding(this.params, 'fingerFalloff', { label: 'finger falloff', min: 0, max: 5, step: 0.05 });
    pane.addBinding(this.params, 'rimSharpness', { label: 'rim power', min: 0.4, max: 8, step: 0.1 }).on('change', e => {
      this.uRimSharpness.value = e.value;
    });
    pane.addBinding(this.params, 'baseAlpha', { label: 'body alpha', min: 0, max: 1, step: 0.01 }).on('change', e => {
      this.uBaseAlpha.value = e.value;
    });
    pane.addBinding(this.params, 'rimAlpha', { label: 'rim alpha', min: 0, max: 1, step: 0.01 }).on('change', e => {
      this.uRimAlpha.value = e.value;
    });
    pane.addBinding(this.params, 'brightness', { label: 'brightness', min: 0, max: 3, step: 0.05 }).on('change', e => {
      this.uBrightness.value = e.value;
    });
    pane.addBinding(this.params, 'additive', { label: 'additive blend' }).on('change', e => {
      this.material.blending = e.value ? THREE.AdditiveBlending : THREE.NormalBlending;
      this.material.needsUpdate = true;
    });
  }
}
