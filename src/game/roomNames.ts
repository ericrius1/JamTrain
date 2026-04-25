export const ROOM_NAME_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export const SAMPLE_ROOM_NAMES: readonly string[] = [
  'tokyo', 'kyoto', 'osaka', 'sapporo', 'fukuoka', 'seoul', 'busan', 'taipei',
  'hanoi', 'bangkok', 'chiang-mai', 'singapore', 'jakarta', 'bali', 'manila',
  'kuala-lumpur', 'delhi', 'mumbai', 'bangalore', 'jaipur', 'kathmandu',
  'colombo', 'dubai', 'doha', 'muscat', 'istanbul', 'beirut', 'amman',
  'tbilisi', 'yerevan', 'baku', 'tehran', 'cairo', 'nairobi', 'lagos', 'accra',
  'dakar', 'casablanca', 'marrakesh', 'tunis', 'fes', 'cape-town',
  'johannesburg', 'addis-ababa', 'zanzibar', 'lisbon', 'porto', 'madrid',
  'barcelona', 'seville', 'paris', 'lyon', 'brussels', 'amsterdam', 'berlin',
  'munich', 'vienna', 'zurich', 'milan', 'rome', 'naples', 'florence',
  'venice', 'athens', 'dublin', 'edinburgh', 'london', 'oslo', 'stockholm',
  'helsinki', 'copenhagen', 'reykjavik', 'tallinn', 'warsaw', 'krakow',
  'prague', 'budapest', 'belgrade', 'sofia', 'bucharest', 'kyiv', 'mexico-city',
  'oaxaca', 'havana', 'bogota', 'lima', 'santiago', 'buenos-aires', 'sao-paulo',
  'rio', 'toronto', 'montreal', 'vancouver', 'queens', 'savannah',
  'new-orleans', 'honolulu', 'sydney', 'melbourne', 'auckland',
];

export function pickRandomRoomName(exclude?: string): string {
  const pool = exclude ? SAMPLE_ROOM_NAMES.filter(n => n !== exclude) : SAMPLE_ROOM_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function sanitizeRoomName(raw: string): string {
  const trimmed = raw.trim().toLowerCase().slice(0, 48);
  return ROOM_NAME_REGEX.test(trimmed) ? trimmed : '';
}
