import {
  WebMidi,
  type Input as WebMidiInput,
  type Listener,
  type NoteMessageEvent,
} from 'webmidi';
import { clamp } from './math';

export type MidiNoteEvent = {
  noteNumber: number;
  velocity: number;
  sourceId: string;
  inputId: string;
  inputName: string;
  channel: number;
};

type MidiInputControllerOptions = {
  onNoteOn: (event: MidiNoteEvent) => void;
  onNoteOff: (event: MidiNoteEvent) => void;
};

export class MidiInputController {
  private started = false;
  private listeners = new Map<string, Listener[]>();
  private activeNotes = new Map<string, MidiNoteEvent>();

  constructor(private readonly opts: MidiInputControllerOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (!WebMidi.supported) {
      console.info('[midi] Web MIDI is not supported in this browser');
      return;
    }

    try {
      await WebMidi.enable({ sysex: false });
    } catch (err) {
      console.warn('[midi] Web MIDI access was not granted', err);
      return;
    }

    this.started = true;
    this.attachInputs();
    WebMidi.addListener('portschanged', this.handlePortsChanged);
    this.logInputs();
  }

  dispose(): void {
    this.releaseAllActiveNotes();
    this.detachInputs();
    if (this.started) WebMidi.removeListener('portschanged', this.handlePortsChanged);
    this.started = false;
  }

  private handlePortsChanged = (): void => {
    this.attachInputs();
    this.logInputs();
  };

  private attachInputs(): void {
    const liveIds = new Set(WebMidi.inputs.map(input => input.id));
    for (const [id, listeners] of this.listeners) {
      if (liveIds.has(id)) continue;
      for (const listener of listeners) listener.remove();
      this.listeners.delete(id);
      this.releaseActiveNotesForInput(id);
    }

    for (const input of WebMidi.inputs) {
      if (this.listeners.has(input.id)) continue;
      const noteOnListeners = asListeners(input.addListener('noteon', this.handleNoteOn));
      const noteOffListeners = asListeners(input.addListener('noteoff', this.handleNoteOff));
      this.listeners.set(input.id, [...noteOnListeners, ...noteOffListeners]);
    }
  }

  private detachInputs(): void {
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) listener.remove();
    }
    this.listeners.clear();
  }

  private handleNoteOn = (event: NoteMessageEvent): void => {
    const note = this.toMidiNoteEvent(event, 'attack');
    if (!note) return;
    if (note.velocity <= 0) {
      this.releaseNote(note);
      return;
    }
    if (this.activeNotes.has(note.sourceId)) return;
    this.activeNotes.set(note.sourceId, note);
    this.opts.onNoteOn(note);
  };

  private handleNoteOff = (event: NoteMessageEvent): void => {
    const note = this.toMidiNoteEvent(event, 'release');
    if (!note) return;
    this.releaseNote(note);
  };

  private releaseNote(note: MidiNoteEvent): void {
    const active = this.activeNotes.get(note.sourceId);
    if (!active) return;
    this.activeNotes.delete(note.sourceId);
    this.opts.onNoteOff({ ...active, velocity: note.velocity });
  }

  private releaseAllActiveNotes(): void {
    for (const [sourceId, note] of [...this.activeNotes]) {
      this.opts.onNoteOff({ ...note, velocity: 0 });
      this.activeNotes.delete(sourceId);
    }
  }

  private releaseActiveNotesForInput(inputId: string): void {
    for (const [sourceId, note] of [...this.activeNotes]) {
      if (note.inputId !== inputId) continue;
      this.opts.onNoteOff({ ...note, velocity: 0 });
      this.activeNotes.delete(sourceId);
    }
  }

  private toMidiNoteEvent(event: NoteMessageEvent, velocityKind: 'attack' | 'release'): MidiNoteEvent | null {
    const noteNumber = event.note.number;
    if (!Number.isFinite(noteNumber)) return null;
    const input = event.port as WebMidiInput;
    const channel = this.eventChannel(event);
    const velocity = velocityKind === 'attack' ? event.note.attack : event.note.release;
    return {
      noteNumber,
      velocity: clamp(velocity, 0, 1),
      sourceId: this.sourceId(input.id, channel, noteNumber),
      inputId: input.id,
      inputName: input.name || 'MIDI input',
      channel,
    };
  }

  private eventChannel(event: NoteMessageEvent): number {
    const raw = (event.message as unknown as { channel?: number }).channel;
    return Number.isFinite(raw) ? Number(raw) : 0;
  }

  private sourceId(inputId: string, channel: number, noteNumber: number): string {
    return `${inputId}:${channel}:${Math.round(noteNumber)}`;
  }

  private logInputs(): void {
    if (WebMidi.inputs.length === 0) {
      console.info('[midi] waiting for a MIDI input');
      return;
    }
    console.info('[midi] listening to MIDI inputs', WebMidi.inputs.map(input => input.name || input.id));
  }
}

function asListeners(value: Listener | Listener[]): Listener[] {
  return Array.isArray(value) ? value : [value];
}
