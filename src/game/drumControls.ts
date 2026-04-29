export const DRUM_DEFAULT_BASE_ROW = 3;

// Covers the current TweakPaint max of base row 8: 8 + 7 + ... + 1 = 36 orbs.
export const DRUM_KEY_RANGE = [
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';',
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'z', 'x', 'c', 'v', 'b', 'n',
] as const;

export function drumOrbCountForBaseRow(baseRow: number): number {
  const n = Math.max(1, Math.floor(baseRow));
  return (n * (n + 1)) / 2;
}

export function drumKeyLabelsForOrbCount(orbCount: number): string[] {
  const count = Math.max(0, Math.floor(orbCount));
  return DRUM_KEY_RANGE.slice(0, count).map(labelForDrumKey);
}

export function drumKeyboardIndexForKey(key: string, orbCount: number): number | undefined {
  const keyIndex = DRUM_KEY_RANGE.indexOf(key.toLowerCase() as (typeof DRUM_KEY_RANGE)[number]);
  if (keyIndex < 0 || keyIndex >= orbCount) return undefined;
  return orbCount - 1 - keyIndex;
}

function labelForDrumKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}
