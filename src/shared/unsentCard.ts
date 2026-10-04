/**
 * The GuardDeck card for a prompt that never left a chat's input box (`Session.promptUnsent`).
 *
 * A Codex chat whose prompt was typed but never submitted reads as working on its card, and
 * nobody looks at it for an hour (s40-mus3teu4, 2026-10-03). The card tag and `pf list` say
 * so on this desk; this puts it in front of Robert wherever he is looking.
 *
 * One card per OCCURRENCE: the id carries the pane and the moment the prompt was given up on,
 * so a second unsent prompt in the same chat is a second card, and the card for the first is
 * taken down when the stamp clears (Robert typed into the pane, or a later prompt went in).
 * A `waiting: true` card with no pid stays on GuardDeck while its file exists
 * (GuardDeck `WaitingNotices.plan`); Robert dismissing it deletes the file, and `posted`
 * keeps a dismissed card from being written again for the same occurrence.
 *
 * Pure: the main-process glue is `main/unsentCards.ts`.
 */
import { clockDay } from './tell'
import { MACHINE_NAME, type Machine } from './paneLabel'
import type { RemotePeerState, Session } from './types'

/** Every card this writes starts with it, so only these files are ever taken down. */
export const UNSENT_PREFIX = 'paneforge-unsent-'

export interface UnsentRow {
  id: string
  title: string
  cwd?: string
  promptUnsent?: number
  /** the card label as `pf list` prints it: `3`, `PC 3`, `Mac 3` */
  label?: string
  number?: number
  /** the machine the chat runs on */
  machine: Machine
}

export interface UnsentCard {
  id: string
  actor: 'paneforge'
  waiting: true
  at: number
  title: string
  detail: string
  chat: string
  machine: Machine
  pane: string
  cwd: string
}

/** The file-safe id of one occurrence: the pane and the moment, nothing else. */
export function unsentCardId(paneId: string, at: number): string {
  return `${UNSENT_PREFIX}${paneId.replace(/[^A-Za-z0-9_-]/g, '-')}-${Math.floor(at).toString(36)}`
}

/** "PC 3" / "Mac 3" whatever the desk prints: GuardDeck cards always name the computer. */
function cardName(row: UnsentRow): string {
  if (row.label && /^(Mac|PC) \d+$/.test(row.label)) return row.label
  const where = MACHINE_NAME[row.machine]
  const n = row.number ?? (row.label && /^\d+$/.test(row.label) ? Number(row.label) : undefined)
  return n ? `${where} ${n}` : where
}

export function unsentCard(row: UnsentRow & { promptUnsent: number }): UnsentCard {
  const name = cardName(row)
  const title = row.title || row.id
  return {
    id: unsentCardId(row.id, row.promptUnsent),
    actor: 'paneforge',
    waiting: true,
    at: row.promptUnsent,
    title: `Prompt not sent to ${name}`,
    detail:
      `${title}: a prompt was typed into this chat's input box at ${clockDay(row.promptUnsent)} and the agent never took it. ` +
      `It is still in the box. Open the chat and press Enter to send it.`,
    chat: `${name} · ${title}`,
    machine: row.machine,
    pane: row.id,
    cwd: row.cwd ?? ''
  }
}

/**
 * What to write and what to take down, given the chats now, the card files on disk (names
 * without `.json`) and the occurrences already posted. A card is written once per
 * occurrence; one whose occurrence is over (stamp cleared, chat gone) is removed.
 */
export function planUnsentCards(
  rows: UnsentRow[],
  onDisk: string[],
  posted: ReadonlySet<string>
): { write: UnsentCard[]; remove: string[]; live: Set<string> } {
  const live = new Set<string>()
  const write: UnsentCard[] = []
  for (const row of rows) {
    if (typeof row.promptUnsent !== 'number' || !Number.isFinite(row.promptUnsent) || row.promptUnsent <= 0) continue
    const card = unsentCard({ ...row, promptUnsent: row.promptUnsent })
    if (live.has(card.id)) continue
    live.add(card.id)
    if (!posted.has(card.id)) write.push(card)
  }
  const remove = onDisk.filter((id) => id.startsWith(UNSENT_PREFIX) && !live.has(id))
  return { write, remove, live }
}

/**
 * Every chat this desk can see, as card rows: its own panes, the ones mirrored from the other
 * computer, and the ones only LISTED from it - the PC posts no GuardDeck cards (that is the
 * Mac's app alone), so a Codex chat on the PC is carded from here or not at all. A pane both
 * mirrored and listed counts once.
 */
export function unsentRows(sessions: Session[], peers: RemotePeerState[], here: Machine): UnsentRow[] {
  const rows: UnsentRow[] = []
  const seen = new Set<string>()
  for (const s of sessions) {
    seen.add(s.id)
    const machine = s.remote ? s.remote.machine : here
    if (!machine) continue
    rows.push({ id: s.id, title: s.title, cwd: s.cwd, promptUnsent: s.promptUnsent, label: s.label, number: s.number, machine })
  }
  for (const peer of peers) {
    if (peer.status !== 'online') continue
    for (const pane of peer.panes ?? []) {
      const id = `@${peer.id}/${pane.id}`
      if (pane.watched || seen.has(id) || !pane.machine) continue
      rows.push({ id, title: pane.title, cwd: pane.cwd, promptUnsent: pane.promptUnsent, number: pane.number, machine: pane.machine })
    }
  }
  return rows
}
