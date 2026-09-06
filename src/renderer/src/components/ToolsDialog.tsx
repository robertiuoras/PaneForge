import { useEffect, useState } from 'react'
import type { DeskRow } from '@shared/desk'
import { fleetRow } from '@shared/fleet'
import { BoardIcon, SwarmIcon, GearIcon, BellIcon } from './Icons'
import useDialogFocus from './useDialogFocus'

export default function ToolsDialog({ waiting, hasSession, onFocus, onBoard, onSwarm, onHelp, onSettings, onClose }: {
  waiting: DeskRow[]
  hasSession: boolean
  onFocus(row: DeskRow): void
  onBoard(): void
  onSwarm(): void
  onHelp(): void
  onSettings(): void
  onClose(): void
}): JSX.Element {
  const [attention, setAttention] = useState(false)
  const box = useDialogFocus()
  useEffect(() => { box.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [attention])
  return <div className="overlay" onMouseDown={onClose}>
    <div className="dialog tools-dialog" ref={box} role="dialog" aria-modal="true" aria-labelledby="tools-title"
      onMouseDown={event => event.stopPropagation()}>
      <div className="dialog-head">
        <strong id="tools-title">{attention ? 'Needs attention' : 'Tools'}</strong>
        {attention && <button className="ghost small" onClick={() => setAttention(false)}>Back to tools</button>}
        <button className="ghost small" aria-label="Close tools" onClick={onClose}>Close</button>
      </div>
      <div className="tools-body">
        {attention ? <>
          <p className="hint">Questions, completed turns and stalled work across your connected devices. Choose a session to pick it up.</p>
          {waiting.length === 0 && <div className="tools-empty"><strong>Nothing needs you right now</strong><p>Work can carry on. New questions and stalled sessions will appear here.</p></div>}
          {waiting.map(row => <button className="ghost tool-action" key={row.key} onClick={() => onFocus(row)}>
            <BellIcon />
            <span><strong>{row.session?.title || row.listed?.pane.title || 'Session'}</strong><small>{fleetRow(row).label} · {row.listed?.device.name || row.session?.remote?.name || 'This device'}</small></span>
          </button>)}
        </> : <>
          <p className="hint">Open these when you need them. Your sessions keep working while this is closed.</p>
          <button className="ghost tool-action" onClick={() => setAttention(true)}><BellIcon /><span><strong>Needs attention</strong><small>{waiting.length ? `${waiting.length} session${waiting.length === 1 ? '' : 's'} ready for you` : 'Nothing waiting for you'}</small></span></button>
          <button className="ghost tool-action" disabled={!hasSession} onClick={onBoard}><BoardIcon /><span><strong>Project board</strong><small>{hasSession ? 'Review tasks and shared project notes' : 'Open a session to see its project board'}</small></span></button>
          <button className="ghost tool-action" onClick={onSwarm}><SwarmIcon /><span><strong>Start a swarm</strong><small>Brief several agents on a shared mission</small></span></button>
          <button className="ghost tool-action" onClick={onHelp}><span className="tool-help" aria-hidden="true">?</span><span><strong>Keyboard shortcuts</strong><small>Move around without reaching for the toolbar</small></span></button>
          <button className="ghost tool-action" onClick={onSettings}><GearIcon /><span><strong>Settings</strong><small>Adjust sessions, appearance and automation</small></span></button>
        </>}
      </div>
    </div>
  </div>
}
