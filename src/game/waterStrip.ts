import * as THREE from 'three/webgpu';
import { Fn, color, mix, sin, time, uniform, uv } from 'three/tsl';
import type { ForegroundBiome } from './biomes';

const STRIP_WIDTH = 12.4;
const STRIP_HEIGHT = 0.18;

export class WaterStrip {
  private root = new THREE.Group();
  private meshes: { mesh: THREE.Mesh; side: number }[] = [];
  private coverage = uniform(0);
  private tint = uniform(new THREE.Color(0xb6d6e6));
  private skyTint = uniform(new THREE.Color(0x6a90b0));

  constructor(private scene: THREE.Scene) {}

  build(): void {
    const material = new THREE.MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;
    material.colorNode = Fn(() => {
      const u = uv();
      // Vertical fade — top is sky reflection, bottom is open water.
      const blend = u.y;
      const baseTint = mix(this.tint, this.skyTint, blend);
      // Slow horizontal jitter band for shimmer.
      const shimmer = sin(u.x.mul(34).add(time.mul(0.6))).mul(0.06).add(sin(u.x.mul(13).sub(time.mul(0.8))).mul(0.04));
      const shine = mix(color(0xffffff), color(0x8aa8c0), u.y).mul(shimmer.mul(0.5).add(0.5));
      return baseTint.mul(0.85).add(shine.mul(0.15));
    })();
    material.opacityNode = this.coverage;

    for (const side of [-1]) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(STRIP_WIDTH, STRIP_HEIGHT), material);
      mesh.rotation.y = Math.PI / 2;
      // Sit at the foreground baseline, just below the ground line.
      mesh.position.set(side * 2.13, 0.30, 0);
      mesh.renderOrder = -14;
      this.root.add(mesh);
      this.meshes.push({ mesh, side });
    }
    this.scene.add(this.root);
  }

  setSkyTint(hex: number): void {
    this.skyTint.value.setHex(hex);
  }

  update(biome: ForegroundBiome, _delta: number): void {
    if (biome.water) {
      // Easing toward target coverage so transitions don't pop.
      const target = biome.water.coverage;
      this.coverage.value = this.coverage.value + (target - this.coverage.value) * 0.05;
      this.tint.value.setHex(biome.water.reflectionTint);
    } else {
      this.coverage.value = this.coverage.value + (0 - this.coverage.value) * 0.05;
    }
  }
}
