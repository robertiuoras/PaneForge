interface Props {
  onClose: () => void
}

const KEYS: [string, string][] = [
  ['Ctrl K', 'Command palette: jump to a session, start a project, run any action'],
  ['Ctrl T', 'New session (tick several projects to start them together)'],
  ['Ctrl W', 'Close the focused session'],
  ['Ctrl Shift R', 'Restart the focused agent in place'],
  ['Ctrl Shift A', 'Switch the focused pane to the next installed AI (Claude, Codex, ...)'],
  ['Ctrl G', 'Toggle grid view (every session at once)'],
  ['Ctrl 1 - 9', 'Jump to that session'],
  ['Ctrl Tab', 'Next session'],
  ['Ctrl Shift Tab', 'Previous session'],
  ['Ctrl + / Ctrl -', 'Terminal font bigger / smaller'],
  ['Ctrl C', 'Copy the selection; with nothing selected it interrupts the agent as usual'],
  ['Ctrl Shift C', 'Always copy, never interrupt'],
  ['Ctrl V', 'Paste (images go to the agent untouched)'],
  ['Right-click', 'Copy the selection, or paste when nothing is selected'],
  ['Ctrl B', 'Focus the broadcast box (one line to every session)'],
  ['Ctrl Shift S', 'Swarm: one mission, one pane per role'],
  ['Ctrl Shift K', 'Tasks and shared memory for the focused folder'],
  ['Ctrl H', 'Search every past session'],
  ['Ctrl Shift Space', 'Push to talk: dictate into the focused pane'],
  ['Ctrl ,', 'Settings'],
  ['F1', 'This list'],
  ['F12', 'Developer tools'],
  ['Double-click a title', 'Rename that session']
]

export default function ShortcutsDialog({ onClose }: Props): JSX.Element {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Keyboard</strong>
          <span className="hint">Esc closes</span>
        </div>
        <div className="keys">
          {KEYS.map(([k, what]) => (
            <div className="key-row" key={k}>
              <span className="kbd-box">{k}</span>
              <span>{what}</span>
            </div>
          ))}
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
