import type { Key, Mode } from './keyDirector';

export type JamStarlaceChord = readonly [string, string] | readonly [string, string, string];

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Diatonic scale semitones from the root. The KeyDirector is currently locked
// to C major so both instruments stay in tune with the backing track.
const SCALE_SEMIS: Record<Mode, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
};

// Reference octaves keep the playable band in a comfortable hand-tracked range.
const REF_OCT_VOICES = 3;
const REF_OCT_BASS = 2;

// Scale step indices. With the current C-major lock these resolve only to
// natural notes: C, D, E, F, G, A, and B.
const PLAYABLE_LOCAL_STEPS  = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const PLAYABLE_REMOTE_STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DUET_STEPS            = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15];
const ORB_GESTURE_STEPS     = [0, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
// 26 unique diatonic scale steps so every key (z/x/c/v/b/n/m + a-l + q-p)
// gets its own distinct note in the active key. With REF_OCT_VOICES=3 and
// the C-major lock this spans C3 up to G6 (4 octaves, 26 naturals).
const STARLACE_STEPS        = [
  0, 1, 2, 3, 4, 5, 6,
  7, 8, 9, 10, 11, 12, 13,
  14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25,
];
const ORB_PAD_STEPS         = [0, 1, 2, 3, 4, 5, 6];

const STARLACE_CHORD_STEPS: readonly (readonly number[])[] = [
  [0, 3, 7],
  [1, 4, 8],
  [2, 3, 5],
  [3, 5, 6],
  [4, 5, 7],
  [5, 7, 8],
  [6, 8, 9],
  [7, 8, 10],
  [8, 10, 11],
  [9, 10, 12],
  [10, 12, 13],
  [9, 11, 13],
  [8, 10, 12],
  [11, 13],
];

function scaleStepMidi(key: Key, refOctave: number, step: number): number {
  const semis = SCALE_SEMIS[key.mode];
  const len = semis.length;
  const within = ((step % len) + len) % len;
  const octaveOffset = Math.floor(step / len);
  return 12 * (refOctave + 1) + key.root + semis[within] + 12 * octaveOffset;
}

function midiToName(midi: number): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const octave = Math.floor(Math.round(midi) / 12) - 1;
  return `${PITCH_NAMES[pc]}${octave}`;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function getPlayableNotesLocal(key: Key): string[] {
  return PLAYABLE_LOCAL_STEPS.map(s => midiToName(scaleStepMidi(key, REF_OCT_VOICES, s)));
}

export function getPlayableNotesRemote(key: Key): string[] {
  return PLAYABLE_REMOTE_STEPS.map(s => midiToName(scaleStepMidi(key, REF_OCT_BASS, s)));
}

export function getDuetNotes(key: Key): string[] {
  return DUET_STEPS.map(s => midiToName(scaleStepMidi(key, REF_OCT_BASS, s)));
}

export function getOrbGestureNotes(key: Key): string[] {
  return ORB_GESTURE_STEPS.map(s => midiToName(scaleStepMidi(key, REF_OCT_BASS, s)));
}

export function getStarlaceNotes(key: Key): string[] {
  return STARLACE_STEPS.map(s => midiToName(scaleStepMidi(key, REF_OCT_VOICES, s)));
}

export function getStarlaceHz(key: Key): number[] {
  return STARLACE_STEPS.map(s => midiToHz(scaleStepMidi(key, REF_OCT_VOICES, s)));
}

export function getStarlaceChords(key: Key): JamStarlaceChord[] {
  return STARLACE_CHORD_STEPS.map(steps => {
    const names = steps.map(s => midiToName(scaleStepMidi(key, REF_OCT_VOICES, s)));
    return (names.length === 2
      ? [names[0], names[1]] as const
      : [names[0], names[1], names[2]] as const) as JamStarlaceChord;
  });
}

export function getOrbHz(key: Key): number[] {
  return ORB_PAD_STEPS.map(s => midiToHz(scaleStepMidi(key, REF_OCT_VOICES, s)));
}

export function getKeyName(key: Key): string {
  return `${PITCH_NAMES[key.root]} major`;
}
