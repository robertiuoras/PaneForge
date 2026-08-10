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
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type to this pane…"
        aria-label="Type to this pane"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
      />
      <button type="submit" aria-label="Send">
        ↵
      </button>
    </form>
  )
}
