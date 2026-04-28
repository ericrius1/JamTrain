import * as THREE from 'three/webgpu';
import { Fn, color, hash, positionLocal, float } from 'three/tsl';

type AnyColorNode = THREE.MeshBasicNodeMaterial['colorNode'];

/** Build an unlit MeshBasicNodeMaterial with an optional fiber-hash speckle on top of a flat color. */
function makeFlatMaterial(hex: THREE.ColorRepresentation, fiberHashStrength = 0): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  if (fiberHashStrength > 0) {
    m.colorNode = Fn(() => {
      const base = color(new THREE.Color(hex));
      const h = hash(positionLocal.length().mul(38.0)).mul(2).sub(1).mul(fiberHashStrength);
      return base.mul(float(1).add(h));
    })() as unknown as AnyColorNode;
  } else {
    m.colorNode = color(new THREE.Color(hex)) as unknown as AnyColorNode;
  }
  return m;
}

export function makeSkinMaterial(): THREE.MeshBasicNodeMaterial {
  return makeFlatMaterial('#e9b893');
}

export function makeClothMaterial(seatColor: number): THREE.MeshBasicNodeMaterial {
  return makeFlatMaterial(new THREE.Color(seatColor), 0.04);
}

export function makeFurMaterial(): THREE.MeshBasicNodeMaterial {
  return makeFlatMaterial('#b97933', 0.10);
}

export function makeManeMaterial(seatColor: number): THREE.MeshBasicNodeMaterial {
  // Mane base = warm gold tinted toward seat color (keeps gold dominant).
  const seat = new THREE.Color(seatColor);
  const gold = new THREE.Color('#c9862d');
  const maneBase = gold.clone().lerp(seat, 0.35);
  return makeFlatMaterial(maneBase, 0.18);
}

export function makeEyeMaterial(): THREE.MeshBasicNodeMaterial {
  return makeFlatMaterial('#1a1410');
}

/** Golden glow used at palm/wrist nodes — anchor points for instrument visuals. */
export function makeAccentMaterial(): THREE.MeshBasicNodeMaterial {
  return makeFlatMaterial('#ffd36b');
}
