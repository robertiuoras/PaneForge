import { useEffect, useMemo, useState } from 'react'
import type { ReviewRecord } from '@shared/reviews'
import { ago, filterReviews, firstLine, statusWord, visibleReviews, type ReviewFilter } from '@shared/reviewList'
import { folderName } from '@shared/place'
import useDialogFocus from './useDialogFocus'

const api = window.api

interface Props {
  onHistory: () => void
  onReopen: (r: ReviewRecord) => void
  onClose: () => void
}

const EMPTY_WORDS: Record<ReviewFilter, string> = {
  needs: 'Nothing needs you. Finished work is under Done.',
  done: 'No finished sessions yet. A pane that finishes its work closes into this list.',
  all: 'No finished sessions yet.'
}

/** One list of finished sessions: what was asked, what happened, and what still needs you. */
export default function ReviewDialog({ onHistory, onReopen, onClose }: Props): JSX.Element {
  const dialog = useDialogFocus()
  const [records, setRecords] = useState<ReviewRecord[]>([])
  const [filter, setFilter] = useState<ReviewFilter | null>(null)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    let request = 0
    const load = (): void => {
      const generation = ++request
      void api.listReviews().then((next) => {
        // A slow disk refresh from an earlier minute must not overwrite a newer read, and
        // closing Review must not leave it trying to update an unmounted dialog.
        if (!mounted || generation !== request) return
        setRecords(next.reviews)
      }).catch(() => {
        /* keep the last complete reading when the disk read is temporarily unavailable */
      })
    }
    load()
    const refresh = window.setInterval(load, 60_000)
    return () => {
      mounted = false
      window.clearInterval(refresh)
    }
  }, [])

  const visible = useMemo(() => visibleReviews(records), [records])
  const anyNeeds = useMemo(() => filterReviews(visible, 'needs').length > 0, [visible])
  const activeFilter: ReviewFilter = filter ?? (anyNeeds ? 'needs' : 'done')

  const q = query.trim().toLowerCase()
  const rows = useMemo(() => {
    const byFilter = filterReviews(visible, activeFilter)
    const matched = q
      ? byFilter.filter((r) => `${r.title} ${r.cwd} ${r.prompt} ${r.report} ${r.provider}`.toLowerCase().includes(q))
      : byFilter
    return [...matched].sort((a, b) => timeOf(b) - timeOf(a))
  }, [visible, activeFilter, q])

  useEffect(() => {
    if (openId && !rows.some((r) => r.id === openId)) setOpenId(null)
  }, [rows, openId])

  const move = (from: number, dir: 1 | -1): void => {
    const n = rows.length
    if (!n) return
    const next = ((from + dir) % n + n) % n
    const el = dialog.current?.querySelector<HTMLElement>(`[data-review-row="${rows[next].id}"]`)
    el?.focus()
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div ref={dialog} className="dialog wide tall review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong id="review-title">Review</strong>
          <span className="hint">Finished sessions on this machine</span>
          <button className="ghost small" onClick={onClose}>Close</button>
        </div>

        <div className="review-tabs" role="group" aria-label="Show">
          <button className={activeFilter === 'needs' ? 'on' : ''} onClick={() => setFilter('needs')}>Needs you</button>
          <button className={activeFilter === 'done' ? 'on' : ''} onClick={() => setFilter('done')}>Done</button>
          <button className={activeFilter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
        </div>

        <input
          className="search"
          aria-label="Search what was asked, what it did, or the project"
          placeholder="Search what was asked, what it did, or the project"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="review-scroll">
          <div className="review-list">
            {rows.map((r, i) => {
              const open = openId === r.id
              const status = statusWord(r)
              const accent = status === 'Needs you' || status === 'Blocked'
              return (
                <article className="review-row-wrap" key={r.id}>
                  <button
                    type="button"
                    className="review-row"
                    data-review-row={r.id}
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : r.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') { e.preventDefault(); move(i, 1) }
                      else if (e.key === 'ArrowUp') { e.preventDefault(); move(i, -1) }
                    }}
                  >
                    <span className="review-num">#{i + 1}</span>
                    <strong className="review-project">{folderName(r.cwd)}</strong>
                    <span className="review-ask">{firstLine(r.prompt)}</span>
                    <span className="review-result">{firstLine(r.report)}</span>
                    <span className={'review-status' + (accent ? ' accent' : '')}>{status}</span>
                    <span className="review-when">{ago(timeOf(r))}</span>
                  </button>
                  {open && (
                    <div className="review-body">
                      <div className="review-field">
                        <strong>What was asked</strong>
                        <pre>{r.prompt}</pre>
                      </div>
                      <div className="review-field">
                        <strong>What it did</strong>
                        <pre>{r.report}</pre>
                      </div>
                      {r.evidence && r.evidence.length > 0 && (
                        <div className="review-field">
                          <strong>Evidence</strong>
                          <ul>{r.evidence.map((e, ei) => <li key={ei}>{e}</li>)}</ul>
                        </div>
                      )}
                      {r.links && r.links.length > 0 && (
                        <div className="review-field">
                          <strong>Links</strong>
                          <ul className="review-links">
                            {r.links.map((l, li) => (
                              <li key={li}>
                                <button className="ghost small" onClick={() => api.openReview(r.id, li)}>{l.label}</button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div className="review-actions">
                        <button className="primary small" onClick={() => onReopen(r)} title="Opens this chat again in its folder, where it left off">Continue</button>
                        <button
                          className="ghost small"
                          onClick={() => {
                            void navigator.clipboard.writeText(`${r.prompt}\n\n${r.report}`)
                            setCopied(r.id)
                            window.setTimeout(() => setCopied((c) => (c === r.id ? null : c)), 1500)
                          }}
                        >
                          {copied === r.id ? 'Copied' : 'Copy'}
                        </button>
                        <button className="ghost small" onClick={() => api.openReview(r.id, -1)}>Open report</button>
                        {r.kind === 'result' && (
                          <button
                            className="ghost small"
                            onClick={() => {
                              void api.acknowledgeReview(r.id, !r.reviewedAt).then(() => {
                                void api.listReviews().then((next) => setRecords(next.reviews))
                              })
                            }}
                          >
                            {r.reviewedAt ? 'Mark unread' : 'Mark as read'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
            {!rows.length && <div className="review-empty">{EMPTY_WORDS[activeFilter]}</div>}
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

function timeOf(r: ReviewRecord): number {
  return Date.parse(r.closedAt ?? r.completedAt ?? r.createdAt)
}
