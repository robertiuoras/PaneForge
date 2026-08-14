import { useEffect, useMemo, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { gistLine } from '@shared/gist'
import type { HistoryEntry, HistoryHit } from '@shared/types'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'

const api = window.api

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

  useEffect(() => {
    if (open) api.readHistory(open.id).then(setText)
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
            <pre className="transcript">{text || 'Empty transcript.'}</pre>
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
                {/* What it was working on. Absent rather than guessed for a session that
                    closed before the app recorded one - a wrong sentence about which
                    session to bring back is worse than no sentence. */}
                {e.gist && (
                  <div className="hist-gist" title={e.gist}>
                    {gistLine(e.gist, e.asks)}
                  </div>
                )}
                <div className="hist-actions">
                  <button className="ghost small" onClick={() => onResume(e)}>
                    Open again
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
