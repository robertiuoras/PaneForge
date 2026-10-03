import type { Session } from '@shared/types'
import { agentModelLabel, type AgentSpec } from '@shared/agents'
import { formatTokens } from '@shared/tokenTally'
import Elapsed from './Elapsed'

/** `15M tokens (subagents 14M)`: only the parts the native readings know; Codex only. */
function tokenText(parent?: number, subagents?: number): string {
  if (parent !== undefined && subagents !== undefined) return `${formatTokens(parent + subagents)} tokens (subagents ${formatTokens(subagents)})`
  if (subagents !== undefined) return `subagents ${formatTokens(subagents)} tokens`
  return parent !== undefined ? `${formatTokens(parent)} tokens` : ''
}

/** Visibility only. These readings never drive a pane's busy/close decisions. */
export default function Workers({ session, spec }: { session: Session; spec?: Pick<AgentSpec, 'models'> }): JSX.Element | null {
  if (session.agent !== 'codex' && session.agent !== 'claude') return null
  const reading = session.agent === 'codex' ? session.codexWorkers : session.claudeWorkers
  const workers = reading?.workers ?? []
  const running = workers.filter(w => w.state === 'running')
  // Nothing running = nothing to show. A standing "0 running" / "Count unavailable" strip
  // on every pane was noise (Robert 2026-10-03: "showing background workers even when 0
  // running ... no point").
  if (!running.length) return null
  const uncertain = !reading || reading.status !== 'fresh' || workers.some(w => w.state === 'unknown' || w.state === 'stale')
  const stopped = workers.length - running.length
  const summary = !reading || (reading.status === 'unknown' && !workers.length)
    ? 'Count unavailable'
    : `${running.length} ${uncertain ? 'confirmed ' : ''}running`
  const tokens = session.agent === 'codex' ? tokenText(reading?.parentTokens, reading?.subagentTokens) : ''
  const preview = running.map(w => w.action ? `${w.name}: ${w.action}` : w.name)
  return (
    <details className={`workers ${running.length ? 'workers-active' : ''}`} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      <summary aria-label={`${session.title}: ${session.agent === 'claude' ? 'background workers' : 'workers'}, ${summary}${tokens ? `, ${tokens}` : ''}`}>
        <span className="workers-dot" aria-hidden="true" />
        <span className="workers-label">{session.agent === 'claude' ? 'Background workers' : 'Workers'}</span>
        <span className="workers-count">{summary}{!!tokens && <span className="workers-tokens">{` · ${tokens}`}</span>}</span>
        <span className="workers-chevron" aria-hidden="true">⌄</span>
        {!!running.length && <span className="workers-preview" title={preview.join(', ')}>{preview.join(' · ')}</span>}
      </summary>
      <div className="workers-body">
        {workers.length ? <ul className="workers-list">{workers.map(w => (
          <li key={w.id} className={`worker worker-${w.state}`}>
            <div className="worker-heading"><span className="worker-name" title={w.name}>{w.name}</span><span className="worker-state">{w.state === 'stale' ? 'Not recently observed' : w.state === 'unknown' ? 'Status unknown' : w.state}</span></div>
            <div className="worker-meta">
              <span>{w.model ? agentModelLabel(spec, w.model) || w.model : w.requestedModel ? `Asked for ${agentModelLabel(spec, w.requestedModel) || w.requestedModel}` : 'Model unknown'}{w.effort ? ` · ${w.effort}` : ''}{w.tokens !== undefined ? ` · ${formatTokens(w.tokens)} tokens` : ''}</span>
              {w.startedAt !== undefined && (w.state === 'running' || w.endedAt !== undefined || w.updatedAt !== undefined)
                ? <Elapsed since={w.startedAt} until={w.state === 'running' ? undefined : w.endedAt ?? w.updatedAt} className="worker-time" title={w.state === 'running' ? 'Time since the native task started' : w.endedAt !== undefined ? 'Duration of this task' : 'Time observed; stopped at the last event'} />
                : <span className="worker-time">Time unknown</span>}
            </div>
            {!!w.action && <div className="worker-step" title={w.action}>{w.action}{w.actionAt !== undefined && <>{' · '}<Elapsed since={w.actionAt} className="worker-step-ago" title="Time since this step started" /> ago</>}</div>}
          </li>
        ))}</ul> : <p className="workers-note">{uncertain ? 'Nothing read about its workers yet.' : 'No running workers observed.'}</p>}
        {!!stopped && <p className="workers-note">{stopped} {stopped === 1 ? 'worker' : 'workers'} {uncertain ? 'not confirmed running' : 'stopped'}</p>}
        {reading?.status === 'limited' && <p className="workers-note">{session.agent === 'claude' ? 'Only the recent transcript was read. Earlier background tasks may exist.' : 'Showing the 20 newest workers. More may exist.'}</p>}
        {reading?.status === 'unknown' && !!workers.length && <p className="workers-note">Lookup unavailable. These are the last observed states.</p>}
        {session.agent === 'claude' && <p className="workers-note">Background tasks observed in this conversation. Executed models are unavailable.</p>}
      </div>
    </details>
  )
}
