// Which chats the Ctrl K box shows, open and closed, for what was typed.
//
// The box used to list only the panes on screen plus a `Start <project>` row for every
// folder, and a closed chat could not be found from it at all: History was a separate
// window behind its own shortcut. Robert, 2026-09-24: "doesnt show history in the search
// ... im looking for a session that was looking how to invest 10k in stocks austrlia, i
// would search like stocks it should popup first". The chat he meant was named
// `taskdriver.ai`, its first line was `/model`, and `stocks` was only in what he ASKED - so
// a name-only match or a subsequence over the title finds nothing, and the one ranking that
// already reads the asks is History's (`historySearch.ts`). This reuses it rather than
// growing a second idea of what "matches" means.
//
// Pure, so scripts/chat-search-test.mjs can pin it without a window.

import { scoreSession, MIN_QUERY, type Named } from './historySearch'

/** One chat the box can show: a pane on screen, or one that was closed. */
export interface ChatRow extends Named {
  id: string
  open: boolean
  /** epoch ms: when a closed chat ended, when an open one started */
  at: number
  /** the newest real ask, which `askLines` stops keeping after 80 */
  lastAsk?: string
}

/** Rows each half of the empty box may spend, so the actions under them stay in view. */
export const FIRST_OPEN = 6
export const FIRST_CLOSED = 6

/** Chats a typed query may show before the actions under them. */
export const MAX_FOUND = 8

/**
 * The chats to show, best first.
 *
 * Nothing typed: the panes on screen in the order they are on screen, then the most
 * recently closed - a box that is an index of what you were just in. Something typed:
 * every chat the words name, open or closed in one list, by how well they match; the dot
 * on the row says which is which. On a tie the open one leads (it costs nothing to switch
 * to), then the more recent.
 */
export function findChats<T extends ChatRow>(rows: T[], q: string): T[] {
  const needle = q.trim()
  if (needle.length < MIN_QUERY) {
    const open = rows.filter((r) => r.open).slice(0, FIRST_OPEN)
    const closed = rows.filter((r) => !r.open).sort((a, b) => b.at - a.at).slice(0, FIRST_CLOSED)
    return [...open, ...closed]
  }
  return rows
    .map((r) => ({ r, s: scoreSession(r, needle) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(b.r.open) - Number(a.r.open) || b.r.at - a.r.at)
    .slice(0, MAX_FOUND)
    .map((x) => x.r)
}

/** A slash command is something done TO the pane (`/model`), never what it worked on. */
const isCommand = (line: string): boolean => line.startsWith('/')

/**
 * The line under a chat's name: what it is about.
 *
 * With a query, the ask that matched it - the row has to show WHY it is here, and for the
 * invest chat that is "invest 10,000 into stocks in Australia", not its name. Without one,
 * an open pane says what it is doing now (its latest ask) and a closed chat what it was for
 * (the ask that opened it). A bare slash command is never the answer when anything else is.
 */
export function aboutLine(row: Named & { open?: boolean; lastAsk?: string }, q = ''): string {
  const asks = (row.askLines ?? []).filter((a) => !isCommand(a))
  const topics = (row.chapters ?? []).filter((c) => !isCommand(c))
  const gist = row.gist && !isCommand(row.gist) ? row.gist : ''
  const needle = q.trim()
  if (needle.length >= MIN_QUERY) {
    let best = ''
    let top = 0
    for (const line of [...topics, ...asks, gist]) {
      if (!line) continue
      const s = scoreSession({ title: line }, needle)
      if (s > top) {
        top = s
        best = line
      }
    }
    if (best) return best
  }
  if (row.open) {
    const now = row.lastAsk && !isCommand(row.lastAsk) ? row.lastAsk : ''
    return now || (asks[asks.length - 1] ?? topics[topics.length - 1] ?? gist)
  }
  return topics[0] ?? asks[0] ?? gist
}
