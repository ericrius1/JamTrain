export type CreatureId = 'lion' | 'human' | 'elk' | 'robot';

export const CREATURE_IDS: readonly CreatureId[] = ['lion', 'human', 'elk', 'robot'];

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
  elk: {
    id: 'elk',
    label: 'Elk',
    subtitle: 'painted · antlered',
    color: '#7fd0bd',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M8.1 13.1 C 8.1 9.8 9.7 7.7 12 7.7 C 14.3 7.7 15.9 9.8 15.9 13.1 C 15.9 16.6 14.3 19 12 19 C 9.7 19 8.1 16.6 8.1 13.1 Z"/><path d="M9.2 8.5 L 6.2 4.8 M14.8 8.5 L 17.8 4.8 M6.2 4.8 L 4.4 3.5 M6.2 4.8 L 5.5 2.7 M17.8 4.8 L 19.6 3.5 M17.8 4.8 L 18.5 2.7"/><path d="M9.1 10.2 L 6.7 8.7 M14.9 10.2 L 17.3 8.7"/><circle cx="10.6" cy="12.1" r="0.42" fill="currentColor"/><circle cx="13.4" cy="12.1" r="0.42" fill="currentColor"/><path d="M10.7 14.3 C 11.4 14.8 12.6 14.8 13.3 14.3"/></svg>`,
  },
  robot: {
    id: 'robot',
    label: 'Robot',
    subtitle: 'painted · brass',
    color: '#d3a35f',
    iconSvg: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="8" width="10" height="8.5" rx="2.2"/><path d="M12 8 V5.5 M10.5 5.5 H13.5 M8.4 16.5 L7.1 20 M15.6 16.5 L16.9 20"/><circle cx="10" cy="12" r="0.7" fill="currentColor"/><circle cx="14" cy="12" r="0.7" fill="currentColor"/><path d="M10.2 14.5 H13.8 M5 11.2 H7 M17 11.2 H19"/></svg>`,
  },
};

export function isCreatureId(value: unknown): value is CreatureId {
  return value === 'lion' || value === 'human' || value === 'elk' || value === 'robot';
}
