export type CreatureId = 'lion' | 'human' | 'otter';

export const CREATURE_IDS: readonly CreatureId[] = ['lion', 'human', 'otter'];

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
  human: {
    id: 'human',
    label: 'Human',
    subtitle: 'tunic · soft',
    color: '#9ed3ff',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20 C 6.5 14.5 9.5 12 12 12 C 14.5 12 17.5 14.5 18.5 20"/></svg>`,
  },
  otter: {
    id: 'otter',
    label: 'Otter',
    subtitle: 'rigged · playful',
    color: '#8dd7c7',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M7.4 11.2 C 7.4 7.6 9.4 5.4 12 5.4 C 14.6 5.4 16.6 7.6 16.6 11.2 C 16.6 15.3 14.6 18.7 12 18.7 C 9.4 18.7 7.4 15.3 7.4 11.2 Z"/><path d="M8.2 7.8 L 6.2 5.8 M15.8 7.8 L 17.8 5.8"/><circle cx="10.5" cy="10.3" r="0.45" fill="currentColor"/><circle cx="13.5" cy="10.3" r="0.45" fill="currentColor"/><path d="M11.1 12.1 C 11.5 12.5 12.5 12.5 12.9 12.1 M9.2 14.1 C 10.7 15.2 13.3 15.2 14.8 14.1"/></svg>`,
  },
};

export function isCreatureId(value: unknown): value is CreatureId {
  return value === 'lion' || value === 'human' || value === 'otter';
}
