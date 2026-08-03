// What an alert is allowed to sound like.
//
// The app had exactly three sounds, all of them the same glass bell in three
// directions, and all of them hardcoded at the call site. That was the right call while
// there was one opinion to have; it stops being right the moment somebody wants their
// finished-turn sound to be a cat, because the only way to get one was to edit
// `useChime.ts` and rebuild.
//
// So a sound is DATA now: a short recipe a synth can render, living beside a catalogue
// of them. Two properties are worth keeping while adding to it:
//
//   - **Nothing is bundled.** Every built-in is still synthesised from oscillators and
//     noise at play time - no `.wav` in the asar, no codec to rely on, no licence to
//     track, and the whole catalogue costs about as many bytes as one small sample.
//     A person who wants a real recording uploads one; that is what custom sounds are.
//   - **The recipe is inspectable.** A test can assert that every catalogue entry is
//     playable and every default resolves without a browser, which is the half of this
//     that silently rots - an id renamed in one place leaves an alert that plays
//     nothing at all, and silence is indistinguishable from "the setting is off".
//
// The synth that renders these lives in `renderer/src/useChime.ts`. Everything here is
// pure so `scripts/sound-test.mjs` can run it in node.

/** Oscillator shapes, plus white noise, which is what every percussive sound starts as. */
export type SoundWave = 'sine' | 'triangle' | 'square' | 'sawtooth' | 'noise'

export interface SoundFilter {
  type: 'lowpass' | 'highpass' | 'bandpass'
  /** cutoff/centre at the start of the voice */
  freq: number
  /** swept to this by the end - a falling lowpass is how a plucked string dulls */
  to?: number
  q?: number
}

/**
 * One layer of a sound. A recipe is a handful of these, each with its own start time,
 * so "two barks" and "a bell plus its octave" are the same construction.
 */
export interface SoundVoice {
  wave: SoundWave
  /** Hz. Ignored for noise. */
  freq?: number
  /**
   * Pitch waypoints as [fraction of dur, Hz]. This is what makes a meow a meow and a
   * laser a laser: both are a glide, in opposite directions.
   */
  glide?: [number, number][]
  /** Extra partials as [frequency multiple, relative level] - a bell is its overtones. */
  partials?: [number, number][]
  /** seconds after the sound starts */
  at: number
  dur: number
  /** 0..1, before the catalogue's own gain and the user's volume */
  gain: number
  /** seconds of ramp in. Below ~4ms an oscillator starts with an audible click. */
  attack?: number
  /** how the tail falls: `exp` rings like a bell, `lin` stops like a drum */
  decay?: 'exp' | 'lin'
  /** fraction of dur held at full level before the decay starts */
  hold?: number
  filter?: SoundFilter
  /** Hz and depth in Hz. A voice with no vibrato is a machine; an animal has one. */
  vibrato?: { rate: number; depth: number }
  /** play this voice more than once - a double bark, a cricket, a cuckoo */
  repeat?: { times: number; every: number }
}

export interface SoundDef {
  id: string
  label: string
  /** the rail heading it sits under in the picker */
  group: string
  /** master level for the whole recipe, so one sound can be tamed without touching its voices */
  gain: number
  voices: SoundVoice[]
}

/** A file the user picked. The bytes live in userData, never in config.json. */
export interface CustomSound {
  id: string
  /** what the picker shows - the file's own name, minus the extension */
  name: string
  /** file name inside the sounds folder, never a full path */
  file: string
  addedAt: number
}

/** Which alert is being played. Each one picks its own sound. */
export type SoundEvent = 'done' | 'stall' | 'bell'

export interface SoundConfig {
  /** a session finished its turn or asked you something */
  done: string
  /** a running turn has printed nothing for too long */
  stall: string
  /** the terminal rang its bell */
  bell: string
  /** 0..1, applied on top of every sound's own level */
  volume: number
  custom: CustomSound[]
}

// ---------------------------------------------------------------------------
// The catalogue
//
// Ordered by group, and the three that were already here keep their character, their
// place at the top AND their exact gains: an upgrade must not change what the app
// already sounds like.
//
// **Every `gain` below is measured, not guessed.** The first pass was written by ear on
// paper and came out with an eight-to-one spread - Water drip peaked at 0.037 and Dog
// bark at 0.305, so the same volume slider made one alert inaudible and the other a
// jump-scare. They were levelled by playing each one through an AnalyserNode tapped onto
// the live output and reading the actual peak, then scaling toward the Glass bell's
// 0.164, which is the level this app has always alerted at. Re-tune the same way rather
// than by ear: filters and short envelopes throw away far more energy than a recipe
// looks like it should, which is exactly why the paper version was wrong.

export const SOUNDS: SoundDef[] = [
  // --- Bells: quiet, tonal, safe to hear forty times a day -------------------
  {
    id: 'chime',
    label: 'Glass bell',
    group: 'Bells',
    gain: 0.13,
    voices: [
      { wave: 'sine', freq: 783.99, at: 0, dur: 0.9, gain: 1, attack: 0.012, partials: [[2, 0.22], [3, 0.07]] },
      { wave: 'sine', freq: 1174.66, at: 0.13, dur: 1.2, gain: 0.85, attack: 0.012, partials: [[2, 0.22], [3, 0.07]] }
    ]
  },
  {
    id: 'fall',
    label: 'Falling bell',
    group: 'Bells',
    gain: 0.11,
    voices: [
      { wave: 'sine', freq: 587.33, at: 0, dur: 1.1, gain: 1, attack: 0.012, partials: [[2, 0.22], [3, 0.07]] },
      { wave: 'sine', freq: 392.0, at: 0.16, dur: 1.4, gain: 0.9, attack: 0.012, partials: [[2, 0.22], [3, 0.07]] }
    ]
  },
  {
    id: 'ping',
    label: 'Ping',
    group: 'Bells',
    gain: 0.1,
    voices: [
      { wave: 'sine', freq: 1567.98, at: 0, dur: 0.5, gain: 1, attack: 0.012, partials: [[2, 0.22], [3, 0.07]] }
    ]
  },
  {
    id: 'marimba',
    label: 'Marimba',
    group: 'Bells',
    gain: 0.14,
    voices: [
      { wave: 'sine', freq: 523.25, at: 0, dur: 0.45, gain: 1, attack: 0.004, partials: [[4, 0.35], [9.2, 0.08]] },
      { wave: 'sine', freq: 783.99, at: 0.09, dur: 0.5, gain: 0.7, attack: 0.004, partials: [[4, 0.3]] }
    ]
  },
  {
    id: 'harp',
    label: 'Harp run',
    group: 'Bells',
    gain: 0.09,
    voices: [
      { wave: 'triangle', freq: 523.25, at: 0, dur: 0.7, gain: 1, attack: 0.006, partials: [[2, 0.3], [3, 0.12]] },
      { wave: 'triangle', freq: 659.25, at: 0.06, dur: 0.7, gain: 0.9, attack: 0.006, partials: [[2, 0.3]] },
      { wave: 'triangle', freq: 783.99, at: 0.12, dur: 0.8, gain: 0.85, attack: 0.006, partials: [[2, 0.3]] },
      { wave: 'triangle', freq: 1046.5, at: 0.18, dur: 1.0, gain: 0.8, attack: 0.006, partials: [[2, 0.25]] }
    ]
  },
  {
    id: 'bowl',
    label: 'Singing bowl',
    group: 'Bells',
    gain: 0.11,
    voices: [
      {
        wave: 'sine',
        freq: 329.63,
        at: 0,
        dur: 2.4,
        gain: 1,
        attack: 0.05,
        partials: [[2.76, 0.3], [5.4, 0.12]],
        vibrato: { rate: 4.2, depth: 1.4 }
      }
    ]
  },

  // --- Animals: the ask that started this ------------------------------------
  //
  // Every one of these is a glide through a resonant filter. A voice IS a pitch contour
  // plus two or three formants, and at this length nobody is judging the realism - the
  // job is to be identifiable across a room in under half a second.
  {
    id: 'meow',
    label: 'Cat meow',
    group: 'Animals',
    gain: 0.4,
    voices: [
      {
        wave: 'sawtooth',
        // up, over, and down: the "mee-ow" is one syllable with a bend in the middle.
        glide: [[0, 420], [0.18, 720], [0.45, 790], [1, 430]],
        at: 0,
        dur: 0.55,
        gain: 1,
        attack: 0.03,
        hold: 0.55,
        decay: 'lin',
        filter: { type: 'bandpass', freq: 900, to: 1250, q: 3.2 },
        vibrato: { rate: 7.5, depth: 12 }
      },
      // The second formant. One bandpass sounds like a kazoo; two sounds like a mouth.
      {
        wave: 'sawtooth',
        glide: [[0, 420], [0.18, 720], [0.45, 790], [1, 430]],
        at: 0,
        dur: 0.55,
        gain: 0.35,
        attack: 0.03,
        hold: 0.55,
        decay: 'lin',
        filter: { type: 'bandpass', freq: 2100, to: 1700, q: 6 },
        vibrato: { rate: 7.5, depth: 12 }
      }
    ]
  },
  {
    id: 'bark',
    label: 'Dog bark',
    group: 'Animals',
    gain: 0.135,
    voices: [
      // The transient. A bark starts as a burst of air, and without this it is a burp.
      {
        wave: 'noise',
        at: 0,
        dur: 0.07,
        gain: 0.75,
        attack: 0.002,
        decay: 'lin',
        filter: { type: 'bandpass', freq: 1100, to: 600, q: 1.1 },
        repeat: { times: 2, every: 0.23 }
      },
      // The body: a short falling growl an octave under it.
      {
        wave: 'sawtooth',
        glide: [[0, 300], [0.25, 220], [1, 130]],
        at: 0.005,
        dur: 0.17,
        gain: 1,
        attack: 0.006,
        decay: 'lin',
        hold: 0.2,
        filter: { type: 'lowpass', freq: 1600, to: 700, q: 1.4 },
        repeat: { times: 2, every: 0.23 }
      }
    ]
  },
  {
    id: 'chirp',
    label: 'Bird chirp',
    group: 'Animals',
    gain: 0.155,
    voices: [
      {
        wave: 'sine',
        glide: [[0, 2400], [0.4, 3600], [1, 2900]],
        at: 0,
        dur: 0.09,
        gain: 1,
        attack: 0.005,
        decay: 'lin',
        repeat: { times: 3, every: 0.12 }
      }
    ]
  },
  {
    id: 'cuckoo',
    label: 'Cuckoo',
    group: 'Animals',
    gain: 0.15,
    voices: [
      { wave: 'sine', freq: 784, at: 0, dur: 0.18, gain: 1, attack: 0.01, hold: 0.5, partials: [[2, 0.12]] },
      { wave: 'sine', freq: 622, at: 0.22, dur: 0.26, gain: 0.95, attack: 0.01, hold: 0.4, partials: [[2, 0.12]] }
    ]
  },
  {
    id: 'owl',
    label: 'Owl hoot',
    group: 'Animals',
    gain: 0.14,
    voices: [
      {
        wave: 'sine',
        glide: [[0, 380], [0.3, 420], [1, 360]],
        at: 0,
        dur: 0.34,
        gain: 1,
        attack: 0.05,
        hold: 0.4,
        decay: 'lin',
        filter: { type: 'lowpass', freq: 900, q: 1 },
        vibrato: { rate: 11, depth: 5 },
        repeat: { times: 2, every: 0.45 }
      }
    ]
  },
  {
    id: 'frog',
    label: 'Frog croak',
    group: 'Animals',
    gain: 0.26,
    voices: [
      {
        wave: 'square',
        glide: [[0, 150], [1, 118]],
        at: 0,
        dur: 0.22,
        gain: 1,
        attack: 0.008,
        hold: 0.5,
        decay: 'lin',
        filter: { type: 'bandpass', freq: 520, to: 380, q: 2.4 },
        // The rattle. A croak is amplitude modulation, and a fast deep vibrato is the
        // cheapest way to get one without a second oscillator.
        vibrato: { rate: 26, depth: 40 }
      }
    ]
  },
  {
    id: 'cricket',
    label: 'Cricket',
    group: 'Animals',
    gain: 0.155,
    voices: [
      {
        wave: 'sine',
        freq: 4400,
        at: 0,
        dur: 0.028,
        gain: 1,
        attack: 0.003,
        decay: 'lin',
        repeat: { times: 4, every: 0.055 }
      }
    ]
  },

  // --- Arcade: short, bright, unmistakably synthetic -------------------------
  {
    id: 'coin',
    label: 'Arcade coin',
    group: 'Arcade',
    gain: 0.16,
    voices: [
      { wave: 'square', freq: 988, at: 0, dur: 0.07, gain: 1, attack: 0.003, decay: 'lin', hold: 0.8 },
      { wave: 'square', freq: 1319, at: 0.07, dur: 0.42, gain: 1, attack: 0.003, hold: 0.25 }
    ]
  },
  {
    id: 'powerup',
    label: 'Power-up',
    group: 'Arcade',
    gain: 0.155,
    voices: [
      { wave: 'square', freq: 523, at: 0, dur: 0.06, gain: 1, attack: 0.002, decay: 'lin', hold: 0.9 },
      { wave: 'square', freq: 659, at: 0.06, dur: 0.06, gain: 1, attack: 0.002, decay: 'lin', hold: 0.9 },
      { wave: 'square', freq: 784, at: 0.12, dur: 0.06, gain: 1, attack: 0.002, decay: 'lin', hold: 0.9 },
      { wave: 'square', freq: 1047, at: 0.18, dur: 0.3, gain: 1, attack: 0.002, hold: 0.3 }
    ]
  },
  {
    id: 'laser',
    label: 'Laser',
    group: 'Arcade',
    gain: 0.16,
    voices: [
      {
        wave: 'sawtooth',
        glide: [[0, 1800], [1, 220]],
        at: 0,
        dur: 0.24,
        gain: 1,
        attack: 0.003,
        decay: 'lin',
        filter: { type: 'lowpass', freq: 3000, to: 800, q: 4 }
      }
    ]
  },
  {
    id: 'droid',
    label: 'Droid chirp',
    group: 'Arcade',
    gain: 0.16,
    voices: [
      {
        wave: 'square',
        glide: [[0, 700], [0.5, 1500], [1, 950]],
        at: 0,
        dur: 0.08,
        gain: 1,
        attack: 0.003,
        decay: 'lin'
      },
      {
        wave: 'square',
        glide: [[0, 1400], [0.6, 800], [1, 1900]],
        at: 0.1,
        dur: 0.11,
        gain: 0.9,
        attack: 0.003,
        decay: 'lin'
      },
      { wave: 'square', glide: [[0, 900], [1, 2200]], at: 0.24, dur: 0.13, gain: 0.85, attack: 0.003, decay: 'lin' }
    ]
  },
  {
    id: 'sonar',
    label: 'Sonar',
    group: 'Arcade',
    gain: 0.16,
    voices: [
      {
        wave: 'sine',
        freq: 1200,
        at: 0,
        dur: 0.9,
        gain: 1,
        attack: 0.006,
        partials: [[1.5, 0.1]],
        filter: { type: 'bandpass', freq: 1200, q: 6 }
      }
    ]
  },
  {
    id: 'boop',
    label: 'Boop',
    group: 'Arcade',
    gain: 0.14,
    voices: [
      { wave: 'sine', glide: [[0, 660], [1, 440]], at: 0, dur: 0.13, gain: 1, attack: 0.006, hold: 0.4, decay: 'lin' }
    ]
  },
  {
    id: 'blip',
    label: 'Blip',
    group: 'Arcade',
    gain: 0.177,
    voices: [{ wave: 'triangle', freq: 1760, at: 0, dur: 0.06, gain: 1, attack: 0.003, decay: 'lin' }],
  },

  // --- Objects: the ones that read as a real thing happening, not a notification
  {
    id: 'knock',
    label: 'Wood knock',
    group: 'Objects',
    gain: 0.155,
    voices: [
      {
        wave: 'noise',
        at: 0,
        dur: 0.035,
        gain: 0.6,
        attack: 0.001,
        decay: 'lin',
        filter: { type: 'bandpass', freq: 1800, to: 900, q: 1.6 }
      },
      { wave: 'sine', glide: [[0, 320], [1, 190]], at: 0, dur: 0.11, gain: 1, attack: 0.002, decay: 'lin' }
    ]
  },
  {
    id: 'drip',
    label: 'Water drip',
    group: 'Objects',
    gain: 0.5,
    voices: [
      {
        wave: 'sine',
        glide: [[0, 700], [1, 1800]],
        at: 0,
        dur: 0.11,
        gain: 1,
        attack: 0.004,
        filter: { type: 'bandpass', freq: 1400, q: 2 }
      }
    ]
  },
  {
    id: 'pop',
    label: 'Bubble pop',
    group: 'Objects',
    gain: 0.155,
    voices: [
      {
        wave: 'sine',
        glide: [[0, 420], [1, 1100]],
        at: 0,
        dur: 0.055,
        gain: 1,
        attack: 0.002,
        decay: 'lin'
      },
      {
        wave: 'noise',
        at: 0,
        dur: 0.02,
        gain: 0.3,
        attack: 0.001,
        decay: 'lin',
        filter: { type: 'highpass', freq: 2200 }
      }
    ]
  },
  {
    id: 'typewriter',
    label: 'Typewriter bell',
    group: 'Objects',
    gain: 0.09,
    voices: [
      {
        wave: 'noise',
        at: 0,
        dur: 0.025,
        gain: 0.35,
        attack: 0.001,
        decay: 'lin',
        filter: { type: 'highpass', freq: 3000 }
      },
      {
        wave: 'sine',
        freq: 2093,
        at: 0.004,
        dur: 1.1,
        gain: 1,
        attack: 0.003,
        partials: [[1.48, 0.4], [2.9, 0.12]]
      }
    ]
  },
  {
    id: 'whistle',
    label: 'Slide whistle',
    group: 'Objects',
    gain: 0.155,
    voices: [
      {
        wave: 'sine',
        glide: [[0, 700], [1, 2100]],
        at: 0,
        dur: 0.4,
        gain: 1,
        attack: 0.02,
        hold: 0.7,
        decay: 'lin',
        vibrato: { rate: 5, depth: 14 }
      }
    ]
  }
]

/** The sounds each alert starts on: exactly what the app played before it had a picker. */
export const DEFAULT_SOUNDS: SoundConfig = {
  done: 'chime',
  stall: 'fall',
  bell: 'ping',
  volume: 1,
  custom: []
}

/** Prefix that marks a saved id as "one of the user's files" rather than a built-in. */
export const CUSTOM_PREFIX = 'custom:'

const BY_ID = new Map(SOUNDS.map((s) => [s.id, s]))

export function builtinSound(id: string): SoundDef | null {
  return BY_ID.get(id) ?? null
}

/**
 * What an event should play, given the config as it is on disk.
 *
 * Every failure here lands on the built-in default rather than on silence: a config
 * naming a custom file the user has since deleted, an id from a newer version, a
 * `sounds` block missing entirely because the config predates this feature. An alert
 * that plays nothing is indistinguishable from an alert that is switched off, and the
 * person would go looking in the wrong place.
 */
export type Resolved =
  | { kind: 'builtin'; def: SoundDef }
  | { kind: 'custom'; sound: CustomSound }

export function resolveSound(id: string, custom: CustomSound[] = []): Resolved | null {
  if (id.startsWith(CUSTOM_PREFIX)) {
    const want = id.slice(CUSTOM_PREFIX.length)
    const hit = custom.find((c) => c.id === want)
    return hit ? { kind: 'custom', sound: hit } : null
  }
  const def = BY_ID.get(id)
  return def ? { kind: 'builtin', def } : null
}

export function soundFor(sounds: Partial<SoundConfig> | undefined, event: SoundEvent): Resolved {
  const custom = sounds?.custom ?? []
  const picked = sounds?.[event]
  return (
    (picked ? resolveSound(picked, custom) : null) ??
    resolveSound(DEFAULT_SOUNDS[event], custom) ??
    // DEFAULT_SOUNDS names catalogue entries, so this is unreachable unless somebody
    // deletes one of the three originals - in which case the first entry still rings.
    { kind: 'builtin', def: SOUNDS[0] }
  )
}

/** The name shown for whatever a saved id points at, for the picker's trigger. */
export function soundLabel(id: string, custom: CustomSound[] = []): string {
  const r = resolveSound(id, custom)
  if (!r) return 'Missing sound'
  return r.kind === 'builtin' ? r.def.label : r.sound.name
}

export function clampVolume(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.max(0, Math.min(1, n))
}

// ---------------------------------------------------------------------------
// Uploaded files
//
// The main process does the copying; these are the rules it copies BY, kept here so the
// test can drive them without electron and so the renderer can grey out a bad pick
// before it ever reaches an IPC call.

/**
 * Containers Chromium's `decodeAudioData` will actually take. `.wma` and `.aiff` are
 * deliberately absent: the file dialog would accept them and playback would then fail
 * silently at 2am when the alert was supposed to fire.
 */
export const SOUND_EXTS = ['.wav', '.mp3', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac', '.webm']

/**
 * 8 MB. Long enough for a couple of minutes of compressed audio, short enough that the
 * whole thing can be handed over IPC and decoded into memory without a thought - and a
 * notification sound that needs more than this is the wrong kind of sound.
 */
export const MAX_SOUND_BYTES = 8 * 1024 * 1024

export function soundExt(path: string): string {
  const m = /\.[a-z0-9]+$/i.exec(path.trim())
  return m ? m[0].toLowerCase() : ''
}

export function isSoundFile(path: string): boolean {
  return SOUND_EXTS.includes(soundExt(path))
}

/** The file's own name without its extension, trimmed to something a row can show. */
export function soundNameFrom(path: string): string {
  const base = path.trim().split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.[a-z0-9]+$/i, '').trim()
  return (stem || 'Sound').slice(0, 48)
}

/**
 * The name the copy is stored under.
 *
 * Built from the id rather than from the user's file name on purpose: a name is
 * arbitrary text from outside the app, and the one thing it must never do is decide
 * where in the filesystem the write lands. The extension is re-derived from the
 * allowlist above, so `..\..\evil.exe` cannot survive this either.
 */
export function soundFileName(id: string, originalPath: string): string {
  const ext = soundExt(originalPath)
  const safeId = id.replace(/[^a-z0-9]/gi, '').slice(0, 32) || 'sound'
  return `${safeId}${SOUND_EXTS.includes(ext) ? ext : '.wav'}`
}

/**
 * Drop entries whose file is gone, and drop any id the store no longer knows.
 *
 * Called on load. A custom sound is two things that can drift apart - a line in
 * config.json and a file in userData - and the drifted state is invisible until the
 * alert is due.
 */
export function pruneSounds(sounds: SoundConfig, exists: (file: string) => boolean): SoundConfig {
  const custom = sounds.custom.filter((c) => exists(c.file))
  const gone = new Set(sounds.custom.filter((c) => !custom.includes(c)).map((c) => CUSTOM_PREFIX + c.id))
  const keep = (id: string, fallback: string): string => (gone.has(id) ? fallback : id)
  return {
    ...sounds,
    custom,
    done: keep(sounds.done, DEFAULT_SOUNDS.done),
    stall: keep(sounds.stall, DEFAULT_SOUNDS.stall),
    bell: keep(sounds.bell, DEFAULT_SOUNDS.bell),
    volume: clampVolume(sounds.volume)
  }
}

/** Picker rows, built-ins grouped and the user's own first-class beside them. */
export function soundOptions(custom: CustomSound[] = []): { value: string; label: string; group: string }[] {
  return [
    ...SOUNDS.map((s) => ({ value: s.id, label: s.label, group: s.group })),
    ...custom.map((c) => ({ value: CUSTOM_PREFIX + c.id, label: c.name, group: 'Yours' }))
  ]
}
