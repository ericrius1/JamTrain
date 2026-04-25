export const ROOM_NAME_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export const SAMPLE_ROOM_NAMES: readonly string[] = [
  // real-ish places
  'tokyo', 'reykjavik', 'kyoto', 'lisbon', 'marrakesh', 'queens', 'hanoi',
  'oaxaca', 'porto', 'belgrade', 'taipei', 'naples', 'savannah', 'osaka',
  'lagos', 'tbilisi', 'fes',

  // sci-fi
  'helion-prime', 'ceres-station', 'proxima', 'tannhauser', 'new-meridian',
  'orbital-7', 'kepler-22', 'arrakeen', 'low-orbit', 'cygnus-relay',
  'titan-deck', 'haven-iv', 'midnight-belt', 'starfall-9', 'umbra-port',
  'silica-moon', 'long-night',

  // fantasy
  'ferrum-bay', 'thistlemere', 'gilded-marches', 'oakenhollow', 'dunharrow',
  'caldera-keep', 'westwarren', 'silverwatch', 'briar-hold', 'foxglen',
  'shadefen', 'morrowfell', 'vellum-isle', 'thornaby', 'glasswater', 'ashfen',
];

export function pickRandomRoomName(exclude?: string): string {
  const pool = exclude ? SAMPLE_ROOM_NAMES.filter(n => n !== exclude) : SAMPLE_ROOM_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function sanitizeRoomName(raw: string): string {
  const trimmed = raw.trim().toLowerCase().slice(0, 48);
  return ROOM_NAME_REGEX.test(trimmed) ? trimmed : '';
}
