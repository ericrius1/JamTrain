// Two keyboard rows drive the orb pads: home a-l (9) + top q-p (10) = 19.
export const ORB_KEY_ROW_HOME = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'] as const;
export const ORB_KEY_ROW_TOP = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'] as const;

export const ORB_KEY_RANGE = [
  ...ORB_KEY_ROW_HOME,
  ...ORB_KEY_ROW_TOP,
] as const;

export const ORB_PAD_COUNT = ORB_KEY_RANGE.length;

export function orbKeyLabelsForOrbCount(orbCount: number): string[] {
  const count = Math.max(0, Math.floor(orbCount));
  return ORB_KEY_RANGE.slice(0, count).map(labelForOrbKey);
}

export function orbKeyboardIndexForKey(key: string, orbCount: number): number | undefined {
  const keyIndex = ORB_KEY_RANGE.indexOf(key.toLowerCase() as (typeof ORB_KEY_RANGE)[number]);
  if (keyIndex < 0 || keyIndex >= orbCount) return undefined;
  return keyIndex;
}

function labelForOrbKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}
