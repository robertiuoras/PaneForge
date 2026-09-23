// What the panes a chat opened did, told back to that chat ONCE.
//
// Robert, 2026-09-23: "once all sessions consolidate if theres multiple running and they
// close then at end can get summary in 1 session and leave it open". A chat that hands
// three jobs to three panes used to hear nothing when the 3-minute auto-close took them
// (`shared/doneClose.ts`), and a `--close-when-done` pane sent one bare line each, with
// no word of what it did. Now every pane that knows who opened it (`reportTo`, which
// `pf open` fills from the opener's `PF_PANE`) leaves a note here as it closes, and the
// opener is told once, when the LAST of its panes has closed - one prompt, every
// summary. The opener itself is never auto-closed (`openedOthers` in doneClose.ts): it is
// where the summary lands.
//
// A pane that never finishes (a question nobody answers) must not hold the others'
// summaries for ever, so the digest also goes after `DIGEST_MAX_HOLD_MS`, saying how
// many are still open.
//
// Pure. `main/index.ts` feeds and flushes it; `npm run test:doneclose`.

export interface FinishedNote {
  id: string
  title: string
  project: string
  summary: string
  personSteps: string[]
}

/** How long the first finished pane's note may wait for its siblings. */
export const DIGEST_MAX_HOLD_MS = 30 * 60_000
/** One pane's summary, in characters. The whole reply is in Review. */
export const SUMMARY_CHARS = 360

/** The reply, minus its next-steps section and markdown, as one short line. */
export function summaryOf(reply: string, max = SUMMARY_CHARS): string {
  const body = reply.split(/^#{1,6}\s*next steps\b.*$/im)[0]
  const flat = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '') + '…'
}

function one(n: FinishedNote): string {
  const left = n.personSteps.length ? ` Left for you: ${n.personSteps.join('; ')}.` : ''
  return `"${n.title}" (${n.project}): ${n.summary || 'finished with no reply text.'}${left}`
}

/** The single prompt the opener receives. One line: it is typed into a CLI. */
export function digestText(notes: FinishedNote[], stillOpen = 0): string {
  const open = stillOpen ? ` ${stillOpen} other pane${stillOpen === 1 ? ' is' : 's are'} still open.` : ''
  if (notes.length === 1)
    return `The pane you opened for ${one(notes[0])} It closed into Review.${open}`
  const all = stillOpen ? `${notes.length} of the panes you opened have` : `All ${notes.length} panes you opened have`
  return `${all} finished and closed into Review. ` + notes.map((n, i) => `${i + 1}) ${one(n)}`).join(' ') + open
}

/** Notes waiting for their siblings, per opener. */
export class FinishedDigest {
  private pending = new Map<string, { firstAt: number; notes: FinishedNote[] }>()

  add(opener: string, note: FinishedNote, now = Date.now()): void {
    const p = this.pending.get(opener) ?? { firstAt: now, notes: [] }
    if (!p.notes.some((n) => n.id === note.id)) p.notes.push(note)
    this.pending.set(opener, p)
  }

  /** Tell every opener whose panes have all closed, or who has waited long enough. */
  flush(stillOpen: (opener: string) => number, tell: (opener: string, text: string) => boolean, now = Date.now()): string[] {
    const told: string[] = []
    for (const [opener, p] of this.pending) {
      const open = stillOpen(opener)
      if (open > 0 && now - p.firstAt < DIGEST_MAX_HOLD_MS) continue
      this.pending.delete(opener)
      // An opener that has gone cannot be told; every reply is still a Review row.
      if (tell(opener, digestText(p.notes, open))) told.push(opener)
    }
    return told
  }

  size(): number {
    return this.pending.size
  }
}
