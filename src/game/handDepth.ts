import { makeParams, registerTweaks, type ParamsOf } from '../hud/tweakDefs';

// Shared, live-tunable mapping between webcam-space hand depth and 3D world
// depth. Defaults preserve previous baked-in behavior; lower worldDepthScale
// to keep hands from punching into the orb when the user is at medium distance.
export const HAND_DEPTH_DEFS = {
  worldDepthScale:   { default: 0.55, min: 0,    max: 1.5,  step: 0.01,  label: 'world scale' },
  worldDepthOffset:  { default: -0.1, min: -0.6, max: 0.6,  step: 0.01,  label: 'world offset' },
  depthGain:         { default: 0.1,  min: 0.1,  max: 2,    step: 0.05,  label: 'size→depth gain' },
  referencePalmSize: { default: 0.09, min: 0.04, max: 0.18, step: 0.005, label: 'palm size' },
} as const;

export type HandDepthParams = ParamsOf<typeof HAND_DEPTH_DEFS>;

// Live config object — the same reference that pane bindings mutate, so other
// modules importing `handDepthConfig` see writes immediately.
export const handDepthConfig: HandDepthParams = makeParams(HAND_DEPTH_DEFS);

let registered: ReturnType<typeof registerTweaks<typeof HAND_DEPTH_DEFS>> | undefined;

export function attachHandDepthPane(paneDock: HTMLElement): void {
  if (registered) return;
  registered = registerTweaks(paneDock, 'handDepth', HAND_DEPTH_DEFS, {
    title: 'Hand Depth',
    params: handDepthConfig,
  });
}

export function disposeHandDepthPane(): void {
  registered?.dispose();
  registered = undefined;
}
