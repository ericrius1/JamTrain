export const OAR_DEFAULT_BASE_ROW = 5;

// Covers the current TweakPaint max of base row 8: 8 + 7 + ... + 1 = 36 orbs.
export const OAR_KEY_RANGE = [
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';',
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'z', 'x', 'c', 'v', 'b', 'n',
] as const;

export function oarOrbCountForBaseRow(baseRow: number): number {
  const n = Math.max(1, Math.floor(baseRow));
  return (n * (n + 1)) / 2;
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
