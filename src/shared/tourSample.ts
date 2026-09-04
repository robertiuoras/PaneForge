/**
 * AN EXAMPLE CHAT, so a step about History has something to look at.
 *
 * A dev copy has its own profile, so its History is somebody else's - usually nobody's.
 * Step 20 of 39 opened History to show `Show every prompt`, and the list behind the card
 * was empty: no chats, no prompts, no button (Robert 2026-09-04: "the example its showing
 * for that step 20 is bad because the dev version doesnt have any prompts in a session in
 * history it doesnt have the real sessions we have"). The step was pointing at nothing.
 *
 * So the tour puts one made-up chat there. It is written as an ordinary History row - the
 * same metadata file every real chat has - because a row drawn by a special case would
 * prove nothing about the code the step is describing.
 *
 * It is NEVER the installed app's History: `main/tourSample.ts` refuses unless the tour
 * itself is allowed, which is a dev copy only. And it is never mistaken for real work -
 * the id is prefixed, the folder is a made-up one, and the tour deletes it when it ends.
 */

/** Every example row's id starts with this, which is also how they are found and removed. */
export const SAMPLE_ID = 'tour-example-'

/** One example chat: what it was working on, and every prompt it was given. */
export interface SampleChat {
  id: string
  cwd: string
  agent: string
  /** Oldest first. The first is the row's own line; the rest are what `Show every prompt` lists. */
  asks: string[]
  /** How long ago it ended, in minutes, so the row reads `closed 20 min ago`. */
  endedMinutesAgo: number
  /** Minutes it was open for. */
  ranMinutes: number
}

/**
 * Three prompts in one chat, because the button this step is about only appears where
 * there are MORE prompts than the row already prints. One would draw no button at all.
 */
export const SAMPLE_CHATS: SampleChat[] = [
  {
    id: `${SAMPLE_ID}orders`,
    cwd: '/Users/example/Projects/orders-site',
    agent: 'claude',
    asks: [
      'Add a search box to the orders page',
      'Make it search the customer name too',
      'The results flash white for a moment - fix that'
    ],
    endedMinutesAgo: 2,
    ranMinutes: 34
  },
  {
    id: `${SAMPLE_ID}invoices`,
    cwd: '/Users/example/Projects/invoices',
    agent: 'claude',
    asks: ['Why is the invoice total a penny out?', 'Round it the way the bank does', 'Write a test for it'],
    endedMinutesAgo: 9,
    ranMinutes: 12
  }
]

/** One row as History itself stores it, ready to be written to disk. */
export interface SampleRow {
  id: string
  cwd: string
  agent: string
  title: string
  gist: string
  chapters: string[]
  askLines: string[]
  asks: number
  startedAt: number
  endedAt: number
  cols: number
}

export function sampleRows(now: number, chats: SampleChat[] = SAMPLE_CHATS): SampleRow[] {
  return chats.map((c) => {
    const endedAt = now - c.endedMinutesAgo * 60_000
    return {
      id: c.id,
      cwd: c.cwd,
      agent: c.agent,
      title: 'Example chat',
      gist: c.asks[0],
      chapters: [c.asks[0]],
      askLines: c.asks,
      asks: c.asks.length,
      startedAt: endedAt - c.ranMinutes * 60_000,
      endedAt,
      cols: 120
    }
  })
}

/** What the transcript of an example chat reads as, so opening one is not an empty screen. */
export function sampleLog(chat: SampleChat): string {
  const lines: string[] = [
    'This chat is an example, put here by the tour so History has something in it.',
    'It is deleted when the tour ends.',
    ''
  ]
  for (const a of chat.asks) lines.push(`> ${a}`, '', 'Done.', '')
  return lines.join('\r\n')
}

/** How many rows a person actually reads before deciding the list is empty of anything. */
export const LOOKED_AT = 4

/**
 * IS AN EXAMPLE NEEDED? Only when the rows a person can SEE show the step nothing.
 *
 * The first rule written here asked whether ANY row in History had a prompt list, and
 * that is not the question. The dev copy had 272 rows and every one on screen read
 * `PaneForge - closed 6 min ago - open 4m 38s - 1 KB` with no prompt on it at all: the
 * tour's own throwaway shell panes and every `npm run try` launch. One real row buried at
 * position 90 made the rule answer "no example needed" while the step still pointed at a
 * wall of empty rows.
 *
 * So it looks at the NEWEST few - the ones the dialog draws first, and the ones the
 * examples themselves land among, since they are stamped minutes old.
 *
 * A dev copy that has been used for real work recently keeps its own rows and gets no
 * example: the real thing is always the better demonstration.
 */
export function needsSample(
  rows: { id: string; askLines?: string[]; chapters?: string[]; endedAt?: number; startedAt?: number }[]
): boolean {
  if (rows.some((r) => r.id.startsWith(SAMPLE_ID))) return false
  const when = (r: { endedAt?: number; startedAt?: number }): number => r.endedAt ?? r.startedAt ?? 0
  const top = [...rows].sort((a, b) => when(b) - when(a)).slice(0, LOOKED_AT)
  return !top.some((r) => (r.askLines?.length ?? 0) > (r.chapters?.length ?? 0))
}

/** Which rows on disk are the tour's, for taking them away again. */
export function sampleIds(rows: { id: string }[]): string[] {
  return rows.filter((r) => r.id.startsWith(SAMPLE_ID)).map((r) => r.id)
}
