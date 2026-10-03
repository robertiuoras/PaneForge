/**
 * Keeps GuardDeck's "Prompt not sent" cards in step with `Session.promptUnsent`.
 *
 * What goes up and what comes down is `shared/unsentCard.ts`; this is the file half: the
 * notices folder is read, a card is written once per occurrence (atomically, the way
 * waiting-card.mjs writes one), and a card whose prompt went in or whose chat is gone is
 * deleted. Packaged Mac app only (`mayNotify`), the gate every PaneForge notice has.
 */
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planUnsentCards, unsentRows, UNSENT_PREFIX } from '../shared/unsentCard'
import type { RemotePeerState, Session } from '../shared/types'
import { mayNotify, noticesDir, thisMachine } from './doneClose'

/**
 * One pass over `dir`. `posted` is every occurrence already written - kept across passes so a
 * card Robert dismissed (GuardDeck deletes its file) is not written again - and loses the
 * ones that are over, so it never grows past the chats with a prompt stuck right now.
 */
export function syncUnsentCards(dir: string, rows: Parameters<typeof planUnsentCards>[0], posted: Set<string>): { wrote: string[]; removed: string[] } {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    // no notices folder yet: nothing to take down
  }
  const onDisk = names.filter((n) => n.startsWith(UNSENT_PREFIX) && n.endsWith('.json')).map((n) => n.slice(0, -5))
  const plan = planUnsentCards(rows, onDisk, posted)
  const wrote: string[] = []
  const removed: string[] = []
  if (plan.write.length) mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const card of plan.write) {
    const tmp = join(dir, `.${card.id}.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(card) + '\n', { mode: 0o600 })
    renameSync(tmp, join(dir, `${card.id}.json`))
    posted.add(card.id)
    wrote.push(card.id)
  }
  for (const id of plan.remove) {
    try {
      unlinkSync(join(dir, `${id}.json`))
      removed.push(id)
    } catch {
      // already gone (Robert dismissed it between the read and now)
    }
  }
  for (const id of [...posted]) if (!plan.live.has(id)) posted.delete(id)
  return { wrote, removed }
}

/** Every 15 s, the same beat as the finished-chat sweep. */
export function watchUnsentPrompts(sessions: () => Session[], peers: () => RemotePeerState[]): void {
  const posted = new Set<string>()
  setInterval(() => {
    if (!mayNotify()) return
    try {
      const { wrote, removed } = syncUnsentCards(noticesDir(), unsentRows(sessions(), peers(), thisMachine()), posted)
      for (const id of wrote) console.info(`unsent-prompt: GuardDeck card up ${id}`)
      for (const id of removed) console.info(`unsent-prompt: GuardDeck card down ${id}`)
    } catch (e) {
      console.warn(`unsent-prompt: GuardDeck card sync failed - ${(e as Error).message}`)
    }
  }, 15_000).unref()
}
