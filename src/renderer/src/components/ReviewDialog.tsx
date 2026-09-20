import { useEffect, useMemo, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import type { ActivityEntry } from '@shared/activity'
import { KIND_WORDS } from '@shared/activity'
import type { PromptReviewReport } from '@shared/types'
import type { ReviewRecord } from '@shared/reviews'
import { formatTokens } from '@shared/tokenTally'
import { folderName } from '@shared/place'
import AgentLogo from './AgentLogo'
import useDialogFocus from './useDialogFocus'

const api = window.api
const DAY = 24 * 60 * 60 * 1000

interface Props {
  agents: AgentInfo[]
  activity: ActivityEntry[]
  onHistory: () => void
  onClose: () => void
}

/** One honest cross-session reading: submitted prompts, transcript token use and app actions. */
export default function ReviewDialog({ agents, activity, onHistory, onClose }: Props): JSX.Element {
  const dialog = useDialogFocus()
  const [report, setReport] = useState<PromptReviewReport | null>(null)
  const [completed, setCompleted] = useState<ReviewRecord[]>([])
  const [range, setRange] = useState<'today' | 'week'>('today')
  const [query, setQuery] = useState('')

  useEffect(() => {
    void Promise.all([api.dailyReview(), api.listReviews()]).then(([next, reviews]) => {
      setReport(next)
      setCompleted(reviews.reviews)
    })
  }, [])

  const midnight = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }, [])
  const since = range === 'today' ? midnight : midnight - 6 * DAY
  const q = query.trim().toLowerCase()
  const prompts = (report?.prompts ?? []).filter((x) =>
    x.at >= since && (!q || `${x.title} ${x.cwd} ${x.agent} ${x.text}`.toLowerCase().includes(q)))
  const actions = activity.filter((x) =>
    x.at >= since && (!q || `${KIND_WORDS[x.kind]} ${x.what} ${x.why ?? ''}`.toLowerCase().includes(q)))
  const count = range === 'today' ? report?.todayCount : report?.weekCount
  const sessions = range === 'today' ? report?.todaySessions : report?.weekSessions
  const agentIds = range === 'today' ? report?.todayAgents : report?.weekAgents
  const tokens = range === 'today' ? report?.tokens.today : report?.tokens.week
  const reviews = completed.filter((x) => {
    const at = Date.parse(x.completedAt ?? x.capturedAt ?? x.createdAt)
    return at >= since && (!q || `${x.title} ${x.provider} ${x.prompt} ${x.report}`.toLowerCase().includes(q))
  })

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div ref={dialog} className="dialog wide tall review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong id="review-title">Review</strong>
          <span className="hint">Every PaneForge session and agent on this machine</span>
          <button className="ghost small" onClick={onClose}>Close</button>
        </div>

        <div className="review-tabs" role="group" aria-label="Review period">
          <button className={range === 'today' ? 'on' : ''} onClick={() => setRange('today')}>Today</button>
          <button className={range === 'week' ? 'on' : ''} onClick={() => setRange('week')}>7 days</button>
        </div>

        <div className="review-metrics" aria-live="polite">
          <div><strong>{report ? count : '…'}</strong><span>prompts</span></div>
          <div><strong>{report ? formatTokens(tokens ?? 0) : '…'}</strong><span>tokens</span></div>
          <div><strong>{report ? sessions : '…'}</strong><span>sessions</span></div>
          <div><strong>{report ? agentIds?.length : '…'}</strong><span>agents</span></div>
        </div>

        <div className="review-note">
          {report?.recordingSince
            ? `Exact prompts recorded since ${new Date(report.recordingSince).toLocaleString()}. They remain until that saved session is deleted.`
            : 'Exact prompt recording starts with the first prompt sent after this update.'}
          {' '}Tokens come from local Claude and Codex transcripts. Chats outside PaneForge are not included.
        </div>

        <input className="search" aria-label="Search today’s review" placeholder="Search prompts, sessions, folders or agents" value={query} onChange={(e) => setQuery(e.target.value)} />

        <div className="review-scroll">
          <div className="review-section-head"><strong>Prompts</strong><span>{prompts.length} shown</span></div>
          <div className="review-list">
            {prompts.map((x) => (
              <article className="review-prompt" key={x.id}>
                <div className="review-row-head">
                  <AgentLogo id={x.agent} spec={agents.find((a) => a.id === x.agent)} size={13} />
                  <strong>{x.title}</strong>
                  <span>{x.agent} · {folderName(x.cwd)}</span>
                  <time>{new Date(x.at).toLocaleString()}</time>
                </div>
                <pre>{x.text}</pre>
              </article>
            ))}
            {report && !prompts.length && <div className="empty">No recorded prompts in this view.</div>}
            {!report && <div className="empty">Reading local prompt and token records…</div>}
          </div>

          <div className="review-section-head"><strong>Agent reports</strong><span>{reviews.length} shown</span></div>
          <div className="review-list">
            {reviews.map((x) => (
              <article className="review-prompt" key={x.id}>
                <div className="review-row-head">
                  <strong>{x.title}</strong>
                  <span>{x.provider} · {x.kind} · {x.proof}</span>
                  <time>{new Date(x.completedAt ?? x.capturedAt ?? x.createdAt).toLocaleString()}</time>
                </div>
                <pre>{x.report}</pre>
              </article>
            ))}
            {!reviews.length && <div className="empty">No agent reports in this view. Full terminal output remains in History.</div>}
          </div>

          <div className="review-section-head"><strong>Automatic PaneForge actions</strong><span>{actions.length} shown</span></div>
          <div className="review-actions">
            {actions.map((x) => <div key={x.id}><strong>{KIND_WORDS[x.kind]}</strong> {x.what}<span>{x.why ? ` · ${x.why}` : ''} · {new Date(x.at).toLocaleString()}</span></div>)}
            {!actions.length && <div className="empty">No automatic actions in this view.</div>}
          </div>
        </div>

        <div className="dialog-actions">
          <span className="hint">History holds full agent output and lets you reopen a session.</span>
          <button className="ghost" onClick={onHistory}>Open full History</button>
        </div>
      </div>
    </div>
  )
}
