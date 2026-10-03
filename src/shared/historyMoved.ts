import type { HistoryEntry, RemotePeerState } from './types'

/**
 * What History says about a chat that was sent to another computer.
 *
 * Sending a chat closes its copy on this one, and the row then read `closed` in red while
 * the same chat sat open on the other computer - 2026-10-03, a chat moved to the PC and
 * taken for finished. `open` is true only when that computer's own list of chats, which
 * this app already holds, still has it; otherwise the row says it was sent there and says
 * no more than it knows.
 */
export interface MovedView {
  /** the computer's name, as it calls itself now, else as it was when the chat went */
  name: string
  /** its pane list was read and still has the chat */
  open: boolean
}

/**
 * `null` is an ordinary closed row: it never moved, or that computer is connected and its
 * list no longer has the chat, which means it was closed over there.
 *
 * A computer that is not connected cannot be asked, and one that has just connected has
 * not sent its list yet (an empty list is not yet an answer): both stay `open: false`
 * rather than claim `closed`.
 */
export function movedView(
  e: Pick<HistoryEntry, 'endedAt' | 'movedTo'>,
  peers: ReadonlyArray<Pick<RemotePeerState, 'id' | 'name' | 'status' | 'panes'>> | undefined
): MovedView | null {
  const to = e.movedTo
  if (!to || typeof e.endedAt !== 'number') return null
  const peer = peers?.find((p) => p.id === to.device)
  const name = peer?.name || to.name
  if (!peer || peer.status !== 'online' || peer.panes.length === 0) return { name, open: false }
  return peer.panes.some((p) => p.id === to.pane) ? { name, open: true } : null
}
