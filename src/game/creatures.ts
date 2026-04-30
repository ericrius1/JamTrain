export type CreatureId = 'lion' | 'elk' | 'fox' | 'rabbit' | 'robot';

// Picker options shown to players. `robot` is omitted on purpose — it stays
// in `CreatureId` only as the partner-absent placeholder rendered on the
// remote rig.
export const CREATURE_IDS: readonly CreatureId[] = ['lion', 'elk', 'fox', 'rabbit'];

export const DEFAULT_CREATURE: CreatureId = 'lion';

export type CreatureMeta = {
  id: CreatureId;
  /** Human-friendly name for the picker label and tooltip. */
  label: string;
  /** Single-line subtitle / personality blurb. */
  subtitle: string;
  /** Inline SVG markup for the picker icon and the medallion silhouette. Sized 24×24. */
  iconSvg: string;
  /** Primary color for the picker chip ring + glow. CSS color string. */
  color: string;
};

export const CREATURES: Record<CreatureId, CreatureMeta> = {
  lion: {
    id: 'lion',
    label: 'Lion',
    subtitle: 'painted · golden',
    color: '#f6c66a',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12.5" r="3.6"/><path d="M12 8.9 V 6.5 M9.4 9.6 L 7.6 7.5 M14.6 9.6 L 16.4 7.5 M7.5 12 L 5 11.4 M16.5 12 L 19 11.4 M8 14.5 L 6 16 M16 14.5 L 18 16 M10 16 L 9 18 M14 16 L 15 18 M12 16 V 18.5"/><circle cx="10.6" cy="11.8" r="0.4" fill="currentColor"/><circle cx="13.4" cy="11.8" r="0.4" fill="currentColor"/></svg>`,
  },
  elk: {
    id: 'elk',
    label: 'Elk',
    subtitle: 'painted · antlered',
    color: '#7fd0bd',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M8.1 13.1 C 8.1 9.8 9.7 7.7 12 7.7 C 14.3 7.7 15.9 9.8 15.9 13.1 C 15.9 16.6 14.3 19 12 19 C 9.7 19 8.1 16.6 8.1 13.1 Z"/><path d="M9.2 8.5 L 6.2 4.8 M14.8 8.5 L 17.8 4.8 M6.2 4.8 L 4.4 3.5 M6.2 4.8 L 5.5 2.7 M17.8 4.8 L 19.6 3.5 M17.8 4.8 L 18.5 2.7"/><path d="M9.1 10.2 L 6.7 8.7 M14.9 10.2 L 17.3 8.7"/><circle cx="10.6" cy="12.1" r="0.42" fill="currentColor"/><circle cx="13.4" cy="12.1" r="0.42" fill="currentColor"/><path d="M10.7 14.3 C 11.4 14.8 12.6 14.8 13.3 14.3"/></svg>`,
  },
  fox: {
    id: 'fox',
    label: 'Fox',
    subtitle: 'painted · ember',
    color: '#e88b4f',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 8 L8.7 4.4 L10.4 7.1 C11.4 6.8 12.6 6.8 13.6 7.1 L15.3 4.4 L18.5 8 L17.8 13.1 C17.3 16.4 14.9 19 12 19 C9.1 19 6.7 16.4 6.2 13.1 Z"/><path d="M8.4 11.3 L5.2 10 M15.6 11.3 L18.8 10 M9.5 15.2 C10.6 16.3 13.4 16.3 14.5 15.2"/><circle cx="10" cy="12.2" r="0.42" fill="currentColor"/><circle cx="14" cy="12.2" r="0.42" fill="currentColor"/><path d="M11.2 14 H12.8"/></svg>`,
  },
  rabbit: {
    id: 'rabbit',
    label: 'Rabbit',
    subtitle: 'painted · moonlit',
    color: '#b8a0ff',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 8.9 C 8.7 5.5 9 2.8 10.3 2.2 C 12 3.8 12.6 6.6 12.2 9.4"/><path d="M13.5 9.2 C 14 5.8 15.3 3.3 16.8 3 C 17.8 5.2 17.3 8.1 15.6 10.4"/><path d="M7 13.3 C 7 10.3 9.2 8.2 12.1 8.2 C 15.7 8.2 18.8 10.9 19.5 14.2 C 17.9 17.4 14.8 19.3 11.8 19.3 C 9 19.3 7 16.8 7 13.3 Z"/><path d="M15.4 13.5 L20 12.6 M15.5 14.8 L20.5 15.1 M15 16.1 L18.7 18"/><circle cx="12.4" cy="12.2" r="0.42" fill="currentColor"/><path d="M16.7 13.4 C17.5 13.4 18 13.7 18.3 14.2"/></svg>`,
  },
  robot: {
    id: 'robot',
    label: 'Robot',
    subtitle: 'painted · brass',
    color: '#d3a35f',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="8" width="10" height="8.5" rx="2.2"/><path d="M12 8 V5.5 M10.5 5.5 H13.5 M8.4 16.5 L7.1 20 M15.6 16.5 L16.9 20"/><circle cx="10" cy="12" r="0.7" fill="currentColor"/><circle cx="14" cy="12" r="0.7" fill="currentColor"/><path d="M10.2 14.5 H13.8 M5 11.2 H7 M17 11.2 H19"/></svg>`,
  },
};

// Dominant robe cloth sampled from the illustrated puppet body assets. These
// colors drive creature-tied instrument effects, not the picker accent chips.
export const CREATURE_ROBE_COLORS: Record<CreatureId, string> = {
  lion: '#12233b',
  elk: '#1f4b42',
  fox: '#4a1723',
  rabbit: '#2d275f',
  robot: '#402147',
};

export function isCreatureId(value: unknown): value is CreatureId {
  return value === 'lion' || value === 'elk' || value === 'fox' || value === 'rabbit' || value === 'robot';
}
