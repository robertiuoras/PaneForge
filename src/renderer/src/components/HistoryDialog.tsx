import { useEffect, useMemo, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { summaryFull, summaryOf } from '@shared/gist'
import type { HistoryEntry, HistoryHit } from '@shared/types'
import { whenWords } from '@shared/elapsed'
import { renderLines } from '../termRender'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'
import Elapsed, { useNow } from './Elapsed'

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
  /** A transcript search is in flight, so an empty list is not yet an answer. */
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState<HistoryEntry | null>(null)
  const [text, setText] = useState('')
  /**
   * Rows whose whole summary is showing. The row clips to three chapters and two lines,
   * which is the recognise-this-row reading; the whole thing is `summaryFull`, and it was
   * only reachable by opening the transcript or hovering for a tooltip. Costs nothing to
   * show - the chapters are already on the entry.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // The rows say how long AGO, so they go stale sitting on screen. One clock for the whole
  // list, on the minute - the same subscription every other clock in the app shares, and
  // the only unit `whenWords` moves in inside a day.
  const now = useNow(60_000)

  useEffect(() => {
    api.listHistory().then(setEntries)
  }, [])

  // Searching the TRANSCRIPTS runs in the main process over half a gigabyte of logs, so
  // debounce rather than search per key - and drop an answer that arrived after the query
  // moved on, which is what made the box feel like it was fighting the typing: a slow
  // answer for `pizz` used to land on top of the results for `pizzasrus`.
  useEffect(() => {
    if (query.trim().length < 2) {
      setHits(null)
      return
    }
    let dead = false
    setSearching(true)
    const t = window.setTimeout(() => {
      api.searchHistory(query).then((h) => {
        if (dead) return
        setHits(h)
        setSearching(false)
      })
    }, 250)
    return () => {
      dead = true
      window.clearTimeout(t)
    }
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

  /** Every matched line, by the session it came from. */
  const byId = useMemo(() => {
    const map = new Map<string, HistoryHit[]>()
    for (const h of hits ?? []) map.set(h.id, [...(map.get(h.id) ?? []), h])
    return map
  }, [hits])

  /**
   * What the list shows: every session, or the ones the query names.
   *
   * A session is found by its NAME as well as by what it printed. Searching `pizzasrus`
   * returned nothing at all for a pane called Pizzasrus unless the word also happened to
   * appear in its output - which is the opposite of the question being asked, since the
   * reason to type a session's name is to open it again. The name, the folder and the
   * asks are already here, in a few hundred small objects, so this costs one pass and no
   * round trip; only the transcripts need main.
   *
   * Name matches lead, then whichever printed the word most. And the rows are the SAME
   * rows as the unsearched list, so `Open again`, `Delete` and the clocks are all still
   * there - the old search results were a different, actionless row, so finding the
   * session you wanted left you with nothing to press.
   */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return entries
    const named = (e: HistoryEntry): boolean =>
      [e.title, e.cwd, e.gist, ...(e.chapters ?? [])].some((t) => t?.toLowerCase().includes(q))
    return entries
      .filter((e) => named(e) || byId.has(e.id))
      .sort((a, b) => {
        const byName = Number(named(b)) - Number(named(a))
        if (byName) return byName
        return (byId.get(b.id)?.length ?? 0) - (byId.get(a.id)?.length ?? 0)
      })
  }, [entries, byId, query])

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
        ) : (
          <div className="hist-list">
            {shown.map((e) => (
              /* Still open or closed is the first thing the eye needs off this list - a
                 row for the pane that is on screen right now reads exactly like a row
                 for one closed a week ago. Green edge for live, red for closed, and the
                 chip below carries the same two colours so the answer is not carried by
                 hue alone. */
              <div key={e.id} className={`hist-item ${e.endedAt ? 'closed' : 'live'}`}>
                <div className="hist-head" onClick={() => setOpen(e)}>
                  <AgentLogo id={e.agent} spec={agents.find((a) => a.id === e.agent)} size={13} />
                  <strong>{e.title}</strong>
                  <span className="hint">{e.cwd}</span>
                  {/* The time the list is SORTED by, so the order can be read off the
                      rows: newest closed at the top. A session still open has no closing
                      time and says when it started instead.

                      Said as a DISTANCE inside a day (`closed 5 min ago`) and as a date
                      past that. The question this list is open for is "which one did I just
                      close", and a wall-clock timestamp makes the reader subtract it from
                      the clock in their own status bar first. The exact moment is still
                      there, on the hover. */}
                  <span
                    className={`chip ${e.endedAt ? 'dead' : 'kept'}`}
                    title={
                      e.endedAt
                        ? `Closed ${new Date(e.endedAt).toLocaleString()}, opened ${new Date(e.startedAt).toLocaleString()}`
                        : `Still open, since ${new Date(e.startedAt).toLocaleString()}`
                    }
                  >
                    {e.endedAt
                      ? `closed ${whenWords(e.endedAt, now)}`
                      : `open since ${whenWords(e.startedAt, now)}`}
                  </span>
                  {/* How long the window was actually open, which is the question the
                      two timestamps make somebody do arithmetic on. Frozen for a closed
                      session (`until`), live for one still running - and a frozen
                      `Elapsed` subscribes to no timer at all, so a list of eighty rows
                      costs nothing. */}
                  <span className="chip" title="How long this session was open">
                    open <Elapsed since={e.startedAt} until={e.endedAt} className="hist-open" />
                  </span>
                  <span className="chip">{Math.max(1, Math.round(e.bytes / 1024))} KB</span>
                </div>
                {/* What it was working on: the opening ask, plus the first ask after each
                    clear, because a session that cleared four times is four subjects in
                    one window and only the first of them used to be shown. Absent rather
                    than guessed for a session that closed before the app recorded one - a
                    wrong sentence about which session to bring back is worse than none. */}
                {summaryOf(e) &&
                  (expanded.has(e.id) ? (
                    <div className="hist-chapters">{summaryFull(e)}</div>
                  ) : (
                    <div className="hist-gist" title={summaryFull(e)}>
                      {summaryOf(e)}
                    </div>
                  ))}
                {/* The lines this session PRINTED that the query matched, when the query
                    did not simply name it. Four of them, which is enough to recognise
                    which session this is without turning the row into a transcript. */}
                {(byId.get(e.id)?.length ?? 0) > 0 && (
                  <div className="hist-lines">
                    {byId.get(e.id)!.slice(0, 4).map((h, i) => (
                      <div key={i} className="hist-line">
                        {h.line}
                      </div>
                    ))}
                    {byId.get(e.id)!.length > 4 && (
                      <div className="hint">{byId.get(e.id)!.length} matching lines</div>
                    )}
                  </div>
                )}
                <div className="hist-actions">
                  {/* Only where there is something the row is not already showing: one
                      chapter is printed whole, so a button offering to print it again is
                      a button that does nothing. */}
                  {((e.chapters?.length ?? 0) > 1 || Boolean(e.dropped)) && (
                    <button
                      className="ghost small"
                      onClick={() =>
                        setExpanded((s) => {
                          const next = new Set(s)
                          if (!next.delete(e.id)) next.add(e.id)
                          return next
                        })
                      }
                    >
                      {expanded.has(e.id) ? 'Show less' : 'View all'}
                    </button>
                  )}
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
            {!shown.length && (
              <div className="empty">
                {!entries.length
                  ? 'No transcripts yet.'
                  : searching
                    ? 'Searching every transcript…'
                    : 'Nothing matched.'}
              </div>
            )}
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
