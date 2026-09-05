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
import { interventionWords } from '@shared/interventions'
import type { Session, ContextUsage } from '@shared/types'
import type { PaneUsage } from '@shared/usage'
import { describePlace } from '@shared/place'
import { formatCpu, formatMb } from '@shared/usage'
import { useEffect, useState, useRef } from 'react'
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
  const [continuation, setContinuation] = useState('')
  const [freshId, setFreshId] = useState<string | null>(null)
  const [continuing, setContinuing] = useState(false)
  const continuationLock = useRef(false)
  const continuationAction = async (action: 'prepare' | 'start'): Promise<void> => {
    if (continuationLock.current) return
    continuationLock.current = true
    setContinuing(true)
    try {
      const result = action === 'prepare' ? await window.api.prepareContinuation(s.id) : await window.api.continueFresh(s.id)
      setContinuation(result.reason ?? (result.ok ? 'Queued.' : 'Unavailable.'))
      if ('id' in result && typeof result.id === 'string') setFreshId(result.id)
    } catch { setContinuation('Could not request the continuation. Your source remains available.') }
    finally { continuationLock.current = false; setContinuing(false) }
  }
  const [context, setContext] = useState<ContextUsage | null | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    setContext(undefined)
    const read = (): void => {
      void window.api.continuationStatus(freshId ?? s.id).then((value) => { if (!disposed && value) setContinuation(value.reason) }).catch(() => {})
      void window.api.contextUsage(s.id).then((value) => {
      if (!disposed) setContext(value)
    }).catch(() => { if (!disposed) setContext(null) }) }
    read()
    const timer = window.setInterval(read, 15_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [s.id, s.agent, s.asleep, s.cwd, freshId])

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
          {/* A7: how often a person had to step in. The number the autonomous-task
              milestone aims at (0-2 per feature) and the only thing that makes any claim
              about autonomy falsifiable. `interventions.log` under userData carries the
              same count per pane for arithmetic afterwards. */}
          {s.interventions !== undefined && (
            <Row label="Your help">{interventionWords(s.interventions)}</Row>
          )}
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
          <Row label="Context">
            {context === undefined ? 'checking exact session…' : context ? `${context.percent}% used · ${context.used.toLocaleString()} / ${context.window.toLocaleString()} tokens${context.advisory === 'prepare' ? ' · prepare a handoff soon' : context.advisory === 'boundary' ? ' · consider a fresh chat at a safe task boundary' : ''}` : 'unavailable until this session reports fresh context usage'}
            {context && <div className="si-dim">{context.model} · measured {ago(context.at, now)}. Capacity information, not a quality score.</div>}
          </Row>
          {(s.agent === 'codex' || s.agent === 'claude') && !s.remote && <Row label="Fresh chat">
            <div>For an unfinished task, compaction remains available in the CLI. For a deliberate fresh chat, prepare and review a handoff first. Opening a fresh chat saves the source asleep for recovery.</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button disabled={continuing || s.status !== 'idle' || !!s.runSince || !!s.drafting || !!s.ask} onClick={() => { void continuationAction('prepare') }}>Prepare handoff</button>
              <button disabled={continuing || s.status !== 'idle' || !!s.runSince || !!s.drafting || !!s.ask} onClick={() => { void continuationAction('start') }}>Open fresh chat</button>
            </div>
            {continuation && <div role="status" style={{ marginTop: 8 }}>{continuation}</div>}
          </Row>}
          <Row label="Where">
            {place.full}
            <div className="si-path" title={s.cwd}>
              {s.cwd}
            </div>
          </Row>
          {s.remote && <Row label="Runs on">{s.remote.name} (mirrored here)</Row>}
          {s.role && <Row label="Role">{s.role}</Row>}
          {s.piping && <Row label="Recording to">{s.piping.path}</Row>}
          {s.handingOff &&
            (s.handoffQueuedAt ? (
              <Row label="Queued">waiting for this turn to end, then it moves to a paired device</Row>
            ) : (
              <Row label="Moving">on its way to a paired device</Row>
            ))}
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
