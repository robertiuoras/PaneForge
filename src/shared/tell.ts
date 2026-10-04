/**
 * What happened to a prompt sent to a pane with `pf tell` (or the phone, or another computer).
 *
 * Before this, `pf tell` printed "told" whatever happened: a pane on another computer was
 * never looked up at all, and a pane mid-turn held the prompt for up to 45 minutes and then
 * dropped it, both reading as "told" (s42-mus4a344, 2026-10-03). Every caller now gets one of
 * these back and prints `tellLine`, so the words on screen say what is actually true.
 */
export type TellOutcome =
  | { kind: 'delivered'; id: string; title: string; at: number; how: 'typed' | 'steered'; receipt: string }
  | { kind: 'queued'; id: string; title: string; busySince?: number; reason: string }
  | { kind: 'failed'; id: string; title: string; reason: string }
  | { kind: 'missing'; ref: string }

/**
 * How long `tellPane` waits for a receipt before answering 'queued' while the prompt is being
 * typed. A Codex submit gives up after about 27-29 s (6 Enter retries plus the rollout-file
 * poll), so the window is wider than that: an unsent prompt answers 'failed', not 'queued'.
 * A wait for a turn or a person answers in seconds instead (`TELL_EARLY` in sessions.ts).
 */
export const TELL_WAIT_MS = 40_000

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `4:10am Fri` in this computer's local time. */
export function clockDay(at: number): string {
  const d = new Date(at)
  const h = d.getHours()
  const hour = h % 12 === 0 ? 12 : h % 12
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${hour}:${min}${h < 12 ? 'am' : 'pm'} ${DAYS[d.getDay()]}`
}

function who(id: string, title: string): string {
  return title ? `${id} (${title})` : id
}

/** The one line pf prints for an outcome. Plain words; only a delivered prompt says "told". */
export function tellLine(o: TellOutcome): string {
  switch (o.kind) {
    case 'delivered': {
      const how = o.how === 'steered' ? 'added to the turn it was already working on' : 'typed and sent'
      return `told ${who(o.id, o.title)}: ${how} at ${clockDay(o.at)}; ${o.receipt}`
    }
    case 'queued': {
      const since = o.busySince ? ` (busy since ${clockDay(o.busySince)})` : ''
      return `not sent yet to ${who(o.id, o.title)}: ${o.reason}${since}. The prompt stays waiting for that chat.`
    }
    case 'failed':
      return `not sent to ${who(o.id, o.title)}: ${o.reason}`
    case 'missing':
      return `not sent: no chat matches "${o.ref}"`
  }
}
