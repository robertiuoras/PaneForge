// Every key the app answers to, and the way back to this list is the first thing on it:
// a shortcut sheet you can only find by already knowing its shortcut is furniture.

import { useMemo, useState } from 'react'
import MicIcon from './MicIcon'

interface Props {
  onClose: () => void
}

/** The one that opens this list. Kept out of KEYS so it can lead, highlighted. */
const HELP_KEY: [string, string] = [
  'F1  or  Ctrl /',
  'This list, from anywhere - also the ? button next to the gear'
]

/** key, what it does, and whether the row is called out rather than merely listed. */
type Key = [string, string, boolean?]

const KEYS: Key[] = [
  ['Ctrl K', 'Command palette: jump to a session, start a project, run any action'],
  ['Ctrl T', 'New session (tick several projects to start them together)'],
  ['Ctrl W', 'Close the focused session'],
  ['Ctrl Shift R', 'Restart the focused agent in place'],
  ['Ctrl Shift L', 'Fix the display: refit and repaint the pane without losing the run'],
  ['Ctrl Shift A', 'Switch the focused pane to the next installed AI (Claude, Codex, ...)'],
  ['Ctrl G', 'Toggle grid view (every session at once)'],
  ['Ctrl 1 - 9', 'Jump to that session'],
  ['Ctrl Tab', 'Next session'],
  ['Ctrl Shift Tab', 'Previous session'],
  ['Ctrl + / Ctrl -', 'Terminal font bigger / smaller'],
  ['Ctrl C', 'Copy the selection; with nothing selected it interrupts the agent as usual'],
  ['Ctrl Shift C', 'Always copy, never interrupt'],
  ['Ctrl V', 'Paste (images go to the agent untouched)'],
  ['Ctrl Shift V', 'The Stash: click text, a screenshot or a stashed file into the focused pane'],
  [
    'Ctrl Alt V',
    'The floating Stash, from any app: click a line to copy it back, → sends it to the pane, ✕ forgets it'
  ],
  ['Drop a file on the Stash', 'Parks a copy you can drag straight back out into any other app'],
  ['Drag the Stash title', 'Move the Stash anywhere; double-click it to put it back'],
  ['Right-click', 'Copy the selection, or paste when nothing is selected'],
  ['Drag files onto a pane', 'Types their paths at the prompt, ready to describe'],
  ['Ctrl Shift S', 'Swarm: one mission, one pane per role'],
  ['Ctrl Shift K', 'Tasks and shared memory for the focused folder'],
  ['Ctrl H', 'Search every past session'],
  ['Ctrl Shift D', 'Devices: another machine’s panes, in this window'],
  // Called out: the mic is the one control here people ask where to find, and the key
  // is faster than the button it points at.
  [
    'Ctrl Shift Space',
    'Talk to the agent: dictate into the focused pane. Press once to start, again to transcribe - same as the mic button floating over the prompt box at the bottom-left of the pane',
    true
  ],
  ['Ctrl ,', 'Settings'],
  ['F12', 'Developer tools'],
  ['Double-click a title', 'Rename that session']
]

export default function ShortcutsDialog({ onClose }: Props): JSX.Element {
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return KEYS
    return KEYS.filter(([k, what]) => (k + ' ' + what).toLowerCase().includes(needle))
  }, [q])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Keyboard</strong>
          <span className="hint">Esc closes</span>
        </div>
        <div className="key-row lead">
          <span className="kbd-box">{HELP_KEY[0]}</span>
          <span>{HELP_KEY[1]}</span>
        </div>
        <input
          className="key-filter"
          autoFocus
          placeholder="Filter - type what you want to do"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="keys">
          {rows.map(([k, what, hot]) => (
            <div className={'key-row' + (hot ? ' hot' : '')} key={k}>
              <span className="kbd-box">{k}</span>
              <span>
                {what}
                {hot && <MicIcon size={12} />}
              </span>
            </div>
          ))}
          {!rows.length && <div className="hint">Nothing matches "{q}".</div>}
        </div>
        <div className="dialog-row">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
