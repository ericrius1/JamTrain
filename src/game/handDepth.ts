import { Pane } from 'tweakpane';

// Shared, live-tunable mapping between webcam-space hand depth and 3D world
// depth. Sliders show up under "Hand Depth" in the pane dock. Defaults preserve
// previous baked-in behavior; lower worldDepthScale to keep hands from punching
// into the orb when the user is at medium distance.
export type HandDepthParams = {
  // Multiplier on DEPTH_FROM_SIZE — how aggressively apparent palm-size delta
  // converts into tracker-space z. Lower = less sensitive to closer/farther.
  depthGain: number;
  // Multiplier on the rig's world-Z mapping. Lower = hands don't push as far
  // toward the camera/orb for the same tracked depth.
  worldDepthScale: number;
  // Additive bias on world Z (rig local). Negative = pull hands back toward
  // body; positive = push forward toward the orb.
  worldDepthOffset: number;
  // What palm size in image space counts as "neutral" depth. Raise this if the
  // user normally sits closer to the camera so chest-height hands stay neutral.
  referencePalmSize: number;
};

const DEFAULTS: HandDepthParams = {
  depthGain: 1,
  worldDepthScale: 1,
  worldDepthOffset: 0,
  referencePalmSize: 0.09,
};

export const handDepthConfig: HandDepthParams = { ...DEFAULTS };

let pane: Pane | undefined;

export function attachHandDepthPane(paneDock: HTMLElement): void {
  if (pane) return;
  const container = document.createElement('div');
  paneDock.appendChild(container);
  pane = new Pane({ title: 'Hand Depth', container });
  pane.expanded = false;
  pane.addBinding(handDepthConfig, 'worldDepthScale', {
    label: 'world scale', min: 0, max: 1.5, step: 0.01,
  });
  pane.addBinding(handDepthConfig, 'worldDepthOffset', {
    label: 'world offset', min: -0.6, max: 0.6, step: 0.01,
  });
  pane.addBinding(handDepthConfig, 'depthGain', {
    label: 'size→depth gain', min: 0.1, max: 2, step: 0.05,
  });
  pane.addBinding(handDepthConfig, 'referencePalmSize', {
    label: 'neutral palm size', min: 0.04, max: 0.18, step: 0.005,
  });
  pane.addButton({ title: 'reset depth' }).on('click', () => {
    Object.assign(handDepthConfig, DEFAULTS);
    pane?.refresh();
  });
}

export function disposeHandDepthPane(): void {
  pane?.dispose();
  pane = undefined;
}
