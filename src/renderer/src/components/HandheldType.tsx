/**
 * The typing bar a phone gets while a pane holds the screen.
 *
 * xterm's own hidden textarea does summon the phone keyboard, but it receives raw
 * keystrokes, so the phone fights it with autocorrect, capitalisation and a caret the
 * pty has never heard of. A real input is what a phone keyboard is good at: compose the
 * line locally, send it whole with one Enter — the same bytes a paste would be, so the
 * prompt archive and every other tap on the pty path sees it unchanged.
 *
 * A bare Send with nothing typed still sends the Enter: answering a CLI's "press enter
 * to continue" is half of what a phone does to a pane.
 */

import { useState } from 'react'

const api = window.api

/**
 * The keys a phone keyboard does not have, and an agent's composer needs.
 *
 * This bar sends a whole line and then forgets it, which is right for writing an ask and
 * useless for changing one: the moment the words are in the CLI's own input box they
 * belong to the pty, and every way of touching them - move the caret, rub a word out,
 * escape the box - is a key this keyboard does not offer. So a phone could add to a
 * prompt and never edit it. Tapping the terminal already moves the CLI's cursor
 * (`shared/cursorMove.ts`, and inside a drawn input box it may go up and down too); these
 * are the rest of the editing keys, as bytes.
 *
 * Backspace is `DEL` (0x7f), not `BS` - that is what a terminal sends and what every one
 * of these CLIs reads as "rub out".
 */
const KEYS: { label: string; bytes: string; hint: string }[] = [
  { label: '⌫', bytes: '\x7f', hint: 'Backspace' },
  { label: '←', bytes: '\x1b[D', hint: 'Left' },
  { label: '→', bytes: '\x1b[C', hint: 'Right' },
  { label: '↑', bytes: '\x1b[A', hint: 'Up (previous line, or the last command)' },
  { label: '↓', bytes: '\x1b[B', hint: 'Down' },
  { label: 'esc', bytes: '\x1b', hint: 'Escape' }
]

export function HandheldType({ id }: { id: string }): JSX.Element {
  const [text, setText] = useState('')
  return (
    <>
      <div className="handheld-keys" role="group" aria-label="Editing keys">
        {KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            title={k.hint}
            aria-label={k.hint}
            // A key repeats while it is held on every other keyboard; here one press is
            // one key, because the alternative on a touch screen is a finger resting on
            // Backspace and a prompt that empties itself.
            onClick={() => api.write(id, k.bytes)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <form
        className="handheld-type"
        onSubmit={(e) => {
          e.preventDefault()
          api.write(id, text + '\r')
          setText('')
        }}
      >
        {/* Autocorrect, capitalisation and the spelling underline are all ON, which is the
            opposite of what a terminal input usually wants and is right here: what is typed
            into this bar is a sentence to an agent, not a shell command - the CLIs on the
            other end read English. They were off because this input was first written as a
            stand-in for xterm's hidden textarea, where every keystroke goes straight to the
            pty and a phone's substitutions would corrupt a command mid-word; nothing leaves
            this bar until Send is pressed, so the correction has already happened by the
            time any byte moves. `enterKeyHint` still labels the return key Send. */}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type to this pane…"
          aria-label="Type to this pane"
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck={true}
          enterKeyHint="send"
        />
        <button type="submit" aria-label="Send">
          ↵
        </button>
      </form>
    </>
  )
}
