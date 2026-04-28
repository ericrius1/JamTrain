import type { Key, Mode } from './keyDirector';

export type JamChordVoicing = {
  voices: [string, string, string];
  drone: string;
  bass: string;
};

export type JamStarlaceChord = readonly [string, string] | readonly [string, string, string];

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Pentatonic scale semitones from the root.
const SCALE_SEMIS: Record<Mode, readonly number[]> = {
  majorPent: [0, 2, 4, 7, 9],
  minorPent: [0, 3, 5, 7, 10],
};

// Bass progression as semitone offsets from the key root. Major-pent uses
// vi-IV-I-V; minor-pent uses i-bVII-v-iv with all bass notes in-pent so it
// locks with the upper voices.
const BASS_PROGRESSIONS: Record<Mode, readonly number[]> = {
  majorPent: [-3, -7, 0, -5],
  minorPent: [0, -2, -5, -7],
};

// Drone follows bass except the I chord drops an octave for the felt-low tonic.
const DRONE_PROGRESSIONS: Record<Mode, readonly number[]> = {
  majorPent: [-3, -7, -12, -5],
  minorPent: [-12, -2, -5, -7],
};

// Pentatonic-step indices for the upper voices. Step 0 = root in the reference
// octave; step 5 = root one octave up. The same shapes carry across modes —
// pentatonic forgiveness keeps them all consonant.
const VOICE_STEPS_NIGHT: readonly (readonly number[])[] = [
  [5, 7, 8],
  [5, 6, 9],
  [5, 7, 8],
  [5, 6, 8],
];

const VOICE_STEPS_DAY: readonly (readonly number[])[] = [
  [7, 8, 10],
  [4, 5, 6],
  [7, 8, 9],
  [6, 8, 10],
];

// Reference octaves anchored to the original D-major-pentatonic register so
// the playable band stays in the comfortable hand-tracked range across roots.
const REF_OCT_VOICES = 3;
const REF_OCT_BASS = 2;
const REF_OCT_DRONE = 3;

// Step indices that reproduce the original arrays at key=D major pentatonic.
const PLAYABLE_LOCAL_STEPS  = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const PLAYABLE_REMOTE_STEPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DUET_STEPS            = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15];
const ORB_GESTURE_STEPS     = [0, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const STARLACE_STEPS        = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const DRUM_STEPS            = [0, 1, 2, 3, 4];

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

function pentStepMidi(key: Key, refOctave: number, step: number): number {
  const semis = SCALE_SEMIS[key.mode];
  const len = semis.length;
  const within = ((step % len) + len) % len;
  const octaveOffset = Math.floor(step / len);
  return 12 * (refOctave + 1) + key.root + semis[within] + 12 * octaveOffset;
}

function midiFromRoot(key: Key, refOctave: number, semitoneOffset: number): number {
  return 12 * (refOctave + 1) + key.root + semitoneOffset;
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
  return PLAYABLE_LOCAL_STEPS.map(s => midiToName(pentStepMidi(key, REF_OCT_VOICES, s)));
}

export function getPlayableNotesRemote(key: Key): string[] {
  return PLAYABLE_REMOTE_STEPS.map(s => midiToName(pentStepMidi(key, REF_OCT_BASS, s)));
}

export function getDuetNotes(key: Key): string[] {
  return DUET_STEPS.map(s => midiToName(pentStepMidi(key, REF_OCT_BASS, s)));
}

export function getOrbGestureNotes(key: Key): string[] {
  return ORB_GESTURE_STEPS.map(s => midiToName(pentStepMidi(key, REF_OCT_BASS, s)));
}

export function getStarlaceNotes(key: Key): string[] {
  return STARLACE_STEPS.map(s => midiToName(pentStepMidi(key, REF_OCT_VOICES, s)));
}

export function getStarlaceHz(key: Key): number[] {
  return STARLACE_STEPS.map(s => midiToHz(pentStepMidi(key, REF_OCT_VOICES, s)));
}

export function getStarlaceChords(key: Key): JamStarlaceChord[] {
  return STARLACE_CHORD_STEPS.map(steps => {
    const names = steps.map(s => midiToName(pentStepMidi(key, REF_OCT_VOICES, s)));
    return (names.length === 2
      ? [names[0], names[1]] as const
      : [names[0], names[1], names[2]] as const) as JamStarlaceChord;
  });
}

export function getDrumHz(key: Key): number[] {
  return DRUM_STEPS.map(s => midiToHz(pentStepMidi(key, REF_OCT_VOICES, s)));
}

export function getBackingNight(key: Key): JamChordVoicing[] {
  return buildBacking(key, VOICE_STEPS_NIGHT);
}

export function getBackingDay(key: Key): JamChordVoicing[] {
  return buildBacking(key, VOICE_STEPS_DAY);
}

function buildBacking(key: Key, voiceStepsCycle: readonly (readonly number[])[]): JamChordVoicing[] {
  const bassSemis = BASS_PROGRESSIONS[key.mode];
  const droneSemis = DRONE_PROGRESSIONS[key.mode];
  return voiceStepsCycle.map((voiceSteps, i) => {
    const voices = [
      midiToName(pentStepMidi(key, REF_OCT_VOICES, voiceSteps[0])),
      midiToName(pentStepMidi(key, REF_OCT_VOICES, voiceSteps[1])),
      midiToName(pentStepMidi(key, REF_OCT_VOICES, voiceSteps[2])),
    ] as [string, string, string];
    const drone = midiToName(midiFromRoot(key, REF_OCT_DRONE, droneSemis[i]));
    const bass = midiToName(midiFromRoot(key, REF_OCT_BASS, bassSemis[i]));
    return { voices, drone, bass };
  });
}

export function getKeyName(key: Key): string {
  return `${PITCH_NAMES[key.root]} ${key.mode === 'majorPent' ? 'maj pent' : 'min pent'}`;
}
