// Deterministic small PRNG + string hash. Both clients in the same room use
// the same seed so biome sequence, weather windows, and lightning bolts match.

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — small, fast, good enough for visual variety.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reseedable wrapper for "give me a deterministic stream from (seed, key)".
export function streamFor(seed: number, key: number): () => number {
  return mulberry32((seed ^ Math.imul(key + 1, 0x9e3779b1)) >>> 0);
}
