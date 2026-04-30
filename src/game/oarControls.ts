// Two keyboard rows drive the piano pads: home a-l (9) + top q-p (10) = 19.
export const OAR_KEY_ROW_HOME = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'] as const;
export const OAR_KEY_ROW_TOP = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'] as const;

export const OAR_KEY_RANGE = [
  ...OAR_KEY_ROW_HOME,
  ...OAR_KEY_ROW_TOP,
] as const;

export const OAR_PAD_COUNT = OAR_KEY_RANGE.length;

// Legacy alias kept so existing callers (Tweakpane defaults, controls panel)
// continue to compile while the layout transitions away from pyramid math.
// "Base row" no longer drives orb count — we always render 19 pads.
export const OAR_DEFAULT_BASE_ROW = OAR_PAD_COUNT;

export function oarOrbCountForBaseRow(_baseRow: number): number {
  return OAR_PAD_COUNT;
}

export function oarKeyLabelsForOrbCount(orbCount: number): string[] {
  const count = Math.max(0, Math.floor(orbCount));
  return OAR_KEY_RANGE.slice(0, count).map(labelForOarKey);
}

export function oarKeyboardIndexForKey(key: string, orbCount: number): number | undefined {
  const keyIndex = OAR_KEY_RANGE.indexOf(key.toLowerCase() as (typeof OAR_KEY_RANGE)[number]);
  if (keyIndex < 0 || keyIndex >= orbCount) return undefined;
  return keyIndex;
}

function labelForOarKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}
