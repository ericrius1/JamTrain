import * as THREE from 'three/webgpu';

export type PlasmaOrbAttractor = {
  position: THREE.Vector3;
  weight: number;
};

export type PlasmaOrbOptions = {
  position: THREE.Vector3;
  radius?: number;
};

const MAX_ATTRACTORS = 4;

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

  constructor(scene: THREE.Scene, options: PlasmaOrbOptions) {
    this.radius = options.radius ?? 0.42;

    const geometry = new THREE.SphereGeometry(this.radius * 1.5, 32, 24);
    const material = new THREE.MeshBasicMaterial({
      color: 0x35d8ff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.position.copy(options.position);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
  }

  setAttractors(attractors: PlasmaOrbAttractor[]): void {
    this.targetAttractors = attractors.slice(0, MAX_ATTRACTORS);
  }

  setEnergy(energy: number): void {
    this.targetEnergy = Math.max(0, Math.min(1, energy));
  }

  update(_elapsed: number, delta: number): void {
    const energyAlpha = 1 - Math.exp(-delta * 5);
    this.smoothedEnergy += (this.targetEnergy - this.smoothedEnergy) * energyAlpha;

    const posAlpha = 1 - Math.exp(-delta * 12);
    const weightAlpha = 1 - Math.exp(-delta * 8);
    for (let i = 0; i < MAX_ATTRACTORS; i += 1) {
      const target = this.targetAttractors[i];
      const slot = this.smoothedAttractors[i];
      if (target) {
        slot.position.lerp(target.position, posAlpha);
        slot.weight += (target.weight - slot.weight) * weightAlpha;
      } else {
        slot.weight += (0 - slot.weight) * weightAlpha;
      }
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
