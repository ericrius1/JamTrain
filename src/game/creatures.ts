export type CreatureId = 'lion' | 'human';

export const CREATURE_IDS: readonly CreatureId[] = ['lion', 'human'];

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
    subtitle: 'maned · golden',
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
};

export function isCreatureId(value: unknown): value is CreatureId {
  return value === 'lion' || value === 'human';
}
