export type JamChordVoicing = {
  voices: [string, string, string];
  drone: string;
};

export const JAM_SCALE_NAME = 'D major pentatonic';

export const JAM_PLAYABLE_NOTES_LOCAL: string[] = [
  'D3',
  'E3',
  'F#3',
  'A3',
  'B3',
  'D4',
  'E4',
  'F#4',
  'A4',
  'B4',
  'D5',
  'E5',
];

export const JAM_PLAYABLE_NOTES_REMOTE: string[] = [
  'D2',
  'E2',
  'F#2',
  'A2',
  'B2',
  'D3',
  'E3',
  'F#3',
  'A3',
  'B3',
  'D4',
  'E4',
];

export const JAM_DUET_NOTES: string[] = [
  'D2',
  'A2',
  'B2',
  'D3',
  'E3',
  'F#3',
  'A3',
  'B3',
  'D4',
  'E4',
  'A4',
  'D5',
];

export const JAM_ORB_GESTURE_NOTES: string[] = [
  'D2',
  'A2',
  'D3',
  'F#3',
  'A3',
  'B3',
  'D4',
  'E4',
  'F#4',
  'A4',
  'B4',
  'D5',
  'E5',
];

export const JAM_STARLACE_NOTES: string[] = [
  'D3',
  'E3',
  'F#3',
  'A3',
  'B3',
  'D4',
  'E4',
  'F#4',
  'A4',
  'B4',
  'D5',
  'E5',
  'F#5',
  'A5',
];

export const JAM_STARLACE_HZ: number[] = [
  146.832, // D3
  164.814, // E3
  184.997, // F#3
  220.000, // A3
  246.942, // B3
  293.665, // D4
  329.628, // E4
  369.994, // F#4
  440.000, // A4
  493.883, // B4
  587.330, // D5
  659.255, // E5
  739.989, // F#5
  880.000, // A5
];

export const JAM_DRUM_HZ: number[] = [
  146.832, // D3
  164.814, // E3
  184.997, // F#3
  220.000, // A3
  246.942, // B3
];

// Same roots as the old vi-IV-I-V cycle, but the upper voices stay inside
// D major pentatonic. That keeps player notes consonant even while the bass
// moves, and avoids close C#/D or G/F# rubs against the playable scale.
export const JAM_BACKING_NIGHT: JamChordVoicing[] = [
  { voices: ['D4',  'F#4', 'A4'], drone: 'B2' },
  { voices: ['D4',  'E4',  'B4'], drone: 'G2' },
  { voices: ['D4',  'F#4', 'A4'], drone: 'D2' },
  { voices: ['D4',  'E4',  'A4'], drone: 'A2' },
];

export const JAM_BACKING_DAY: JamChordVoicing[] = [
  { voices: ['F#4', 'A4',  'D5'], drone: 'B2' },
  { voices: ['B3',  'D4',  'E4'], drone: 'G2' },
  { voices: ['F#4', 'A4',  'B4'], drone: 'D2' },
  { voices: ['E4',  'A4',  'D5'], drone: 'A2' },
];
