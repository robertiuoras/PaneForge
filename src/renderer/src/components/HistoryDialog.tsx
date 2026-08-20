import { useEffect, useMemo, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { summaryFull, summaryOf } from '@shared/gist'
import type { HistoryEntry, HistoryHit } from '@shared/types'
import { renderLines } from '../termRender'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'

const api = window.api

/**
 * How much of a session's transcript to read back. The per-session log is capped at 8 MB
 * as it is written, so this is "all of it" for every session there has ever been.
 */
const LOG_BYTES = 8 * 1024 * 1024

interface Props {
  agents: AgentInfo[]
  /** relaunch a past session in its old folder with its old agent */
  onResume: (e: HistoryEntry) => void
  onClose: () => void
}

/**
 * Everything every pane has ever printed, searchable. The reason this exists is
 * that the useful part of an agent session is usually a sentence it printed an
 * hour ago, and closing the pane used to destroy it.
 */
export default function HistoryDialog({ agents, onResume, onClose }: Props): JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<HistoryHit[] | null>(null)
  const [open, setOpen] = useState<HistoryEntry | null>(null)
  const [text, setText] = useState('')

  useEffect(() => {
    api.listHistory().then(setEntries)
  }, [])

  // Search runs in the main process over files, so debounce rather than search per key.
  useEffect(() => {
    if (query.trim().length < 2) {
      setHits(null)
      return
    }
    const t = window.setTimeout(() => {
      api.searchHistory(query).then(setHits)
    }, 250)
    return () => window.clearTimeout(t)
  }, [query])

  /**
   * The whole terminal window of that session, as it looked - not as it was stripped.
   *
   * `readHistory` strips the escape sequences, and a transcript is a stream of REPAINTS:
   * every frame of an agent's "thinking" line and every keystroke of a redrawn composer
   * then lands on its own line, which is pages of noise around the answer somebody opened
   * this to read. So the raw bytes are replayed through an off-screen terminal at the
   * width the pane was, exactly as the phone's text sheet does it, and its buffer is what
   * is shown. Stripping stays as the fallback: a transcript that will not render is still
   * worth reading.
   */
  useEffect(() => {
    if (!open) return
    let dead = false
    setText('')
    void (async () => {
      try {
        const raw = await api.paneLog(open.id, LOG_BYTES)
        if (dead) return
        if (!raw) {
          setText(await api.readHistory(open.id))
          return
        }
        const lines = await renderLines(raw, open.cols ?? 100)
        if (!dead) setText(lines.join('\n'))
      } catch {
        if (!dead) api.readHistory(open.id).then((t) => !dead && setText(t))
      }
    })()
    return () => {
      dead = true
    }
  }, [open])

  const grouped = useMemo(() => {
    if (!hits) return null
    const map = new Map<string, HistoryHit[]>()
    for (const h of hits) map.set(h.id, [...(map.get(h.id) ?? []), h])
    return [...map.entries()]
  }, [hits])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide tall" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>History</strong>
          <span className="hint">{entries.length} saved sessions on this machine</span>
        </div>
        <Blurb id="history" />

        <input
          className="search"
          autoFocus
          placeholder="Search everything every agent printed"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {open ? (
          <>
            <div className="setting-row">
              <span className="hint">
                {open.title} · {open.cwd} · {new Date(open.startedAt).toLocaleString()}
              </span>
              <button className="ghost small" onClick={() => setOpen(null)}>
                Back
              </button>
            </div>
            {/* What the session worked on, in order - the chapters the row could only
                count. Above the transcript because it is the map of what is below it. */}
            {summaryFull(open) && <div className="hist-chapters">{summaryFull(open)}</div>}
            <pre className="transcript">{text || 'Reading the transcript…'}</pre>
          </>
        ) : grouped ? (
          <div className="hist-list">
            {grouped.map(([id, list]) => {
              const entry = entries.find((e) => e.id === id)
              return (
                <div key={id} className="hist-item">
                  <div className="hist-head" onClick={() => entry && setOpen(entry)}>
                    <AgentLogo id={list[0].agent} spec={agents.find((a) => a.id === list[0].agent)} size={13} />
                    <strong>{list[0].title}</strong>
                    <span className="hint">{list[0].cwd}</span>
                    <span className="chip">{list.length} hits</span>
                  </div>
                  {list.slice(0, 4).map((h, i) => (
                    <div key={i} className="hist-line">
                      {h.line}
                    </div>
                  ))}
                </div>
              )
            })}
            {!grouped.length && <div className="empty">Nothing matched.</div>}
          </div>
        ) : (
          <div className="hist-list">
            {entries.map((e) => (
              <div key={e.id} className="hist-item">
                <div className="hist-head" onClick={() => setOpen(e)}>
                  <AgentLogo id={e.agent} spec={agents.find((a) => a.id === e.agent)} size={13} />
                  <strong>{e.title}</strong>
                  <span className="hint">{e.cwd}</span>
                  <span className="chip">{new Date(e.startedAt).toLocaleString()}</span>
                  <span className="chip">{Math.max(1, Math.round(e.bytes / 1024))} KB</span>
                </div>
                {/* What it was working on: the opening ask, plus the first ask after each
                    clear, because a session that cleared four times is four subjects in
                    one window and only the first of them used to be shown. Absent rather
                    than guessed for a session that closed before the app recorded one - a
                    wrong sentence about which session to bring back is worse than none. */}
                {summaryOf(e) && (
                  <div className="hist-gist" title={summaryFull(e)}>
                    {summaryOf(e)}
                  </div>
                )}
                <div className="hist-actions">
                  {/* A folder that is not there any more cannot be reopened, and pressing
                      the button did nothing at all: main catches a missing folder per
                      request so one bad row cannot abort a workspace launch, and the row
                      was then silently not started. Most of this list is temp folders from
                      tests and swept lane worktrees, so say it on the row instead. The
                      transcript is still readable and Delete still works - the session's
                      output is the reason to keep the row. */}
                  <button
                    className="ghost small"
                    disabled={e.gone}
                    title={e.gone ? `${e.cwd} is not on this machine any more` : undefined}
                    onClick={() => !e.gone && onResume(e)}
                  >
                    {e.gone ? 'Folder is gone' : 'Open again'}
                  </button>
                  <button
                    className="ghost small"
                    onClick={() => api.deleteHistory(e.id).then(() => api.listHistory().then(setEntries))}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {!entries.length && <div className="empty">No transcripts yet.</div>}
          </div>
        )}

        <div className="dialog-row">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
