import { inputStart } from './promptBox'

/**
 * Did the prompt LEAVE the composer, or is it still sitting in it?
 *
 * `queuePrompt` proves a submit with a turn: `runSince` newer than the return. That proof
 * cannot fire for the prompt the app itself sent, because `write()` starts the run clock on
 * the very return being confirmed - `beginRun` stamps `runSince` inside `ourWrite('\r')`,
 * and `typedAt` is read a line later, so the stamp is always a hair OLDER than the thing it
 * is meant to prove. It only ever passed by luck: the CLI's own busy footer re-anchors
 * `runSince` off the clock it prints (`anchorRun`), and when that anchor happened to land
 * past `typedAt` the confirm settled. Measured in `autoclear-app.log` over 2026-09-17..18:
 * 8 panes settled `prompt submitted - a turn started`, 16 gave up 24s later as
 * `prompt left UNSENT: still painting` - on prompts that had gone in perfectly well and
 * were being answered at that moment. This session's own resume prompt is one of the 16.
 *
 * So the give-up needs a second reading, and it is the one the whole path exists to
 * prevent: a pane "sitting there holding a fully typed prompt nobody sent". That is a
 * question about the COMPOSER, not about the run clock - and the composer is on screen in
 * every frame, whether the pane is answering or booting.
 *
 * Deliberately not `composerAt` (`shared/promptBox.ts`): that one answers for the RENDERER,
 * off a cursor row and a rule above, and main has neither - it holds a plain tail of what
 * the pty printed. Measured on this pane's own frame while answering, Claude Code draws the
 * marker with the busy footer above it and the rule BELOW:
 *
 *     · Leavening… (3m 56s · ↓ 13.2k tokens)
 *     ❯
 *     ────────────────────────────────────────
 *
 * so a rule above cannot be required here.
 */

/** How much of the prompt has to be recognised. Shorter than this and the answer is null. */
const NEEDLE_CHARS = 24
const MIN_NEEDLE = 8

/** One line of the prompt, flattened the way a drawn composer flattens it. */
function flatten(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** A drawn horizontal rule, which is where the composer's own rows stop. */
const RULE = /^[\s]*[─-╿]{8,}[\s]*$/

/**
 * `true` the composer still holds this prompt, `false` it is drawn and does not,
 * `null` nothing readable - a torn frame, no composer painted, a prompt too short to
 * recognise. A caller may never read `null` as either answer.
 */
export function promptStillInBox(painted: string, prompt: string): boolean | null {
  const needle = flatten(String(prompt ?? '').split('\n').find((l) => l.trim()) ?? '').slice(0, NEEDLE_CHARS)
  if (needle.length < MIN_NEEDLE) return null
  const raw = String(painted ?? '').split('\n').map((r) => r.replace(/\r+$/, ''))
  const rows = raw.map((r) => r.replace(/[\s\u00a0]+$/, ''))
  // An EMPTY composer is the marker and nothing else, and `inputStart` answers 0 for that -
  // it looks for a marker followed by what was typed. That frame is exactly the one this is
  // here to recognise: a composer with nothing in it is a prompt that left.
  const markerOnly = (row: string): boolean => /^[>❯›»$#%][ \u00a0]*$/.test(row.trim())
  // The LAST marker row is the composer; an earlier one is the CLI echoing a message that
  // was already submitted, which is exactly the frame this must not read as unsent.
  let at = -1
  for (let r = rows.length - 1; r >= 0; r--) {
    if (inputStart(raw[r]) > 0 || markerOnly(rows[r])) {
      at = r
      break
    }
  }
  if (at < 0) return null
  // The composer is the marker row plus the rows it wrapped onto, which end at the rule
  // the CLI draws under it (or at the end of what has been painted).
  let block = rows[at].slice(inputStart(raw[at]))
  for (let r = at + 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row.trim() || RULE.test(row)) break
    block += ' ' + row
  }
  return flatten(block).includes(needle)
}
