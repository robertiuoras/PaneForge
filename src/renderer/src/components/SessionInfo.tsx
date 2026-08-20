// What this pane actually is, in one box.
//
// The card is 260px wide and every fact on it has had to fight for room - the sub-line
// wanted 313px of the 190px it has, which is why the project chip and the agent's name
// take turns. So the facts that lost that fight are here instead, where there is room to
// state them in full and to keep them TICKING: "open for 4h 12m" is the answer to "can I
// close this", and a frozen number is not that answer.
//
// Every clock on this screen is live (`useNow`, one shared timer for the whole app), and
// every reading is one the app already has - nothing here polls anything.

import type { AgentInfo } from '@shared/agents'
import type { Session } from '@shared/types'
import type { PaneUsage } from '@shared/usage'
import { describePlace } from '@shared/place'
import { formatCpu, formatMb } from '@shared/usage'
import { useEffect } from 'react'
import Elapsed, { formatElapsed, useNow } from './Elapsed'

interface Props {
  session: Session
  /** the Ctrl key that switches to it, which is also the only number that is a keystroke */
  paneNumber: number
  agents: AgentInfo[]
  usage?: PaneUsage
  onRename(): void
  onClose(): void
}

/** "just now" / "3m 20s ago" - a moment the app recorded, said as an age. */
function ago(at: number | undefined, now: number): string {
  if (!at) return 'never'
  const d = now - at
  return d < 2000 ? 'just now' : `${formatElapsed(d)} ago`
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="si-row">
      <span className="si-key">{label}</span>
      <span className="si-val">{children}</span>
    </div>
  )
}

export default function SessionInfo({ session: s, paneNumber, agents, usage, onRename, onClose }: Props): JSX.Element {
  const now = useNow()
  const place = describePlace({ cwd: s.cwd, lane: s.lane, pane: paneNumber })
  const agent = agents.find((a) => a.id === s.agent)

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  const state = s.ask
    ? 'waiting for your answer'
    : s.status === 'working'
      ? s.stalledSince
        ? 'working, but silent'
        : 'working'
      : s.status === 'exited'
        ? `exited${s.exitCode === undefined ? '' : ` (${s.exitCode})`}`
        : s.status

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog session-info" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`About ${s.title}`}>
        <div className="dialog-head">
          <strong>{s.title}</strong>
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="si-body">
          {/* The one everybody opened this for, and the only clock that counts from the
              moment the pane was opened: the header's clock is the TURN, which is the
              right number for "is it busy" and the wrong one for "how long has this been
              sitting here". */}
          <Row label="Open for">
            <Elapsed
              className="elapsed"
              since={s.openedAt ?? s.createdAt}
              title="Since this pane was opened"
            />
            <span className="si-dim"> · opened {new Date(s.openedAt ?? s.createdAt).toLocaleString()}</span>
          </Row>
          <Row label="State">
            {state}
            {s.runSince && (
              <span className="si-dim">
                {' '}
                · this turn <Elapsed since={s.runSince} className="si-inline" title="This turn" />
              </span>
            )}
            {!s.runSince && s.lastRunMs !== undefined && (
              <span className="si-dim"> · last turn took {formatElapsed(s.lastRunMs)}</span>
            )}
          </Row>
          <Row label="Last spoke">{ago(s.lastOutput, now)}</Row>
          <Row label="Last typed into">{ago(s.lastKeyboard, now)}</Row>
          <Row label="Agent">
            {agent?.label ?? s.agent}
            {s.model ? <span className="si-dim"> · {s.model}</span> : <span className="si-dim"> · its own default model</span>}
          </Row>
          <Row label="Where">
            {place.full}
            <div className="si-path" title={s.cwd}>
              {s.cwd}
            </div>
          </Row>
          {s.remote && <Row label="Runs on">{s.remote.name} (mirrored here)</Row>}
          {s.role && <Row label="Role">{s.role}</Row>}
          {s.piping && <Row label="Recording to">{s.piping.path}</Row>}
          {s.handingOff && <Row label="Moving">on its way to a paired device</Row>}
          {/* A reading, never a model: `src/main/usage.ts` samples the pty's whole
              descendant tree every few seconds, so this is the build the agent started as
              well as the agent. Absent for a mirror, whose processes are elsewhere. */}
          <Row label="Costing">
            {usage
              ? `${formatMb(usage.rssMb)} across ${usage.procs} process${usage.procs === 1 ? '' : 'es'}` +
                (formatCpu(usage.cpuPct) ? `, ${formatCpu(usage.cpuPct)} of one core` : '')
              : s.remote
                ? 'measured on the machine that runs it'
                : 'not measured yet'}
          </Row>
          <Row label="Switch key">{paneNumber <= 9 ? `Ctrl ${paneNumber}` : 'no key - past the ninth pane'}</Row>
          <Row label="Id">
            <code className="si-id">{s.id}</code>
          </Row>
        </div>

        <div className="dialog-foot si-foot">
          <button className="ghost" onClick={onRename}>
            Rename
          </button>
          <span className="si-spacer" />
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
