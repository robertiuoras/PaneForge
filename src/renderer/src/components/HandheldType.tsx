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

export function HandheldType({ id }: { id: string }): JSX.Element {
  const [text, setText] = useState('')
  return (
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
  )
}
