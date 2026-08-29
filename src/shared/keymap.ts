// Which key does what, as data rather than as twenty literals in one `if` chain.
//
// Every chord in this app used to be spelled inline in `App.tsx`'s keydown handler, which
// is why nothing could be rebound: the list a person reads in the help sheet and the list
// the app answers to were two different things written twice, and only one of them was
// executable. This file is the one list. `App.tsx` asks it whether a keystroke is an
// action; `ShortcutsDialog` draws it and lets a row be changed.
//
// It covers the MODIFIER-PLUS-LETTER chords and nothing else. The digits (Ctrl 1-9), Tab,
// the arrows, `+`/`-` and `,` are positional or numeric and rebinding them buys a person
// nothing while costing this file a second, weirder shape. They stay where they are, and
// the help sheet still prints them - as fixed rows, which is what they are.

/** A modifier chord: the modifier is always on (Cmd on a Mac, Ctrl elsewhere). */
export interface Chord {
  /** the letter, lower case */
  key: string
  /** whether Shift is part of it */
  shift?: boolean
}

export interface KeyAction {
  id: string
  /** what it does, in the words the help sheet already used */
  label: string
  chord: Chord
}

/**
 * The defaults, in the order the help sheet lists them.
 *
 * The `id` is what a saved override is filed under, so it may never be renamed - a rename
 * silently drops somebody's binding back to the default with nothing on screen saying so.
 */
export const KEY_ACTIONS: KeyAction[] = [
  { id: 'palette', label: 'Command palette', chord: { key: 'k' } },
  { id: 'newSession', label: 'New session', chord: { key: 't' } },
  { id: 'closePane', label: 'Close the focused session', chord: { key: 'w' } },
  { id: 'restart', label: 'Restart the focused agent in place', chord: { key: 'r', shift: true } },
  { id: 'fixUi', label: 'Fix the display: refit and repaint the pane', chord: { key: 'l', shift: true } },
  { id: 'switchAgent', label: 'Switch the pane to the next installed AI', chord: { key: 'a', shift: true } },
  { id: 'grid', label: 'Toggle grid view', chord: { key: 'g' } },
  { id: 'gridLayout', label: 'Cycle the grid arrangement', chord: { key: 'g', shift: true } },
  { id: 'zoom', label: 'Zoom the focused pane and back', chord: { key: 'z', shift: true } },
  { id: 'syncTyping', label: 'Type into every pane at once', chord: { key: 'y', shift: true } },
  { id: 'find', label: 'Find in this pane', chord: { key: 'f' } },
  { id: 'copyMode', label: 'Copy from this pane with the keyboard', chord: { key: 'u', shift: true } },
  { id: 'history', label: 'History of closed sessions', chord: { key: 'h' } },
  { id: 'stash', label: 'The Stash', chord: { key: 'v', shift: true } },
  { id: 'board', label: "This project's board", chord: { key: 'k', shift: true } },
  { id: 'devices', label: 'Devices - pair another machine or a phone', chord: { key: 'd', shift: true } },
  { id: 'swarm', label: 'Split a long ask into panes', chord: { key: 's', shift: true } }
]

export type Keymap = Record<string, Chord>

/** Every action at its default. */
export function defaultKeymap(): Keymap {
  const m: Keymap = {}
  for (const a of KEY_ACTIONS) m[a.id] = { ...a.chord }
  return m
}

/**
 * A chord as it is stored in config: `"shift+g"`, or `"g"`.
 *
 * A string and not the object, because config.json is read by hand and by scripts, and
 * `{"key":"g","shift":true}` per action is four times the file for the same fact.
 */
export function chordId(c: Chord): string {
  return (c.shift ? 'shift+' : '') + c.key.toLowerCase()
}

export function parseChordId(s: unknown): Chord | null {
  if (typeof s !== 'string') return null
  const t = s.trim().toLowerCase()
  const shift = t.startsWith('shift+')
  const key = shift ? t.slice(6) : t
  // One letter or digit. A saved value naming a modifier, a word, or nothing is a config
  // this build cannot honour, and honouring HALF of it - the letter out of `ctrl+alt+g` -
  // would bind a chord nobody asked for.
  return /^[a-z0-9]$/.test(key) ? { key, shift } : null
}

export function sameChord(a: Chord | undefined, b: Chord | undefined): boolean {
  if (!a || !b) return false
  return a.key.toLowerCase() === b.key.toLowerCase() && !!a.shift === !!b.shift
}

/**
 * The live map: the defaults with whatever has been saved over them.
 *
 * An unreadable or unknown entry is DROPPED rather than kept, so a config written by a
 * newer build (or by hand, wrongly) leaves this one working on its defaults instead of
 * with a hole where a shortcut was.
 */
export function resolveKeymap(saved: Record<string, string> | null | undefined): Keymap {
  const m = defaultKeymap()
  if (!saved) return m
  for (const [id, raw] of Object.entries(saved)) {
    if (!(id in m)) continue
    const c = parseChordId(raw)
    if (c) m[id] = c
  }
  return m
}

/**
 * Which actions a proposed chord would collide with.
 *
 * Returned rather than refused: two actions on one chord is a real state - the first one
 * in `KEY_ACTIONS` wins in the handler - and the honest thing is to say so at the moment
 * of choosing rather than to silently pick a winner later.
 */
export function conflictsWith(map: Keymap, id: string, c: Chord): string[] {
  return KEY_ACTIONS.filter((a) => a.id !== id && sameChord(map[a.id], c)).map((a) => a.id)
}

/** `⇧ G` on a Mac, `Ctrl Shift G` elsewhere - the same shape `platform.keyLabel` prints. */
export function chordWords(c: Chord | undefined, mac: boolean): string {
  if (!c) return ''
  const mod = mac ? '⌘' : 'Ctrl'
  const sh = c.shift ? (mac ? '⇧ ' : 'Shift ') : ''
  return `${mod} ${sh}${c.key.toUpperCase()}`
}

/**
 * The chord a keyboard event IS, or null when it is not one of ours.
 *
 * The caller has already established that the modifier is down and Alt is not: this only
 * turns the remaining half into the shape the map is keyed by.
 */
export function chordOf(e: { key: string; shiftKey: boolean }): Chord | null {
  const k = e.key.toLowerCase()
  return /^[a-z0-9]$/.test(k) ? { key: k, shift: e.shiftKey } : null
}
