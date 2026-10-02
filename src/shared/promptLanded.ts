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

/** Blanks removed: Claude draws spaces as cursor moves, so a stripped stream loses them. */
const squash = (text: string): string => String(text ?? '').replace(/[\s\u00a0]+/g, '').toLowerCase()

/** A drawn horizontal rule, which is where the composer's own rows stop. */
const RULE = /^[\s]*[─-╿]{8,}[\s]*$/

/**
 * `true` the composer still holds this prompt, `false` it is drawn and does not,
 * `null` nothing readable - a torn frame, no composer painted, a prompt too short to
 * recognise. A caller may never read `null` as either answer.
 */
export function promptStillInBox(painted: string, prompt: string): boolean | null {
  // Matched with every blank squeezed out: a long prompt wraps across rows, and a word
  // split at the right edge reads `wo rd` once the rows are joined (s46-mud47sld: a
  // 2334-char brief wrapped over ~20 rows). The head is the first line's opening letters;
  // the tail is the prompt's closing letters, for a composer scrolled so its head is gone.
  const first = String(prompt ?? '').split('\n').find((l) => l.trim()) ?? ''
  // Too short is judged with its spaces kept, as before: `go on now` is still worth reading.
  if (first.replace(/[\s\u00a0]+/g, ' ').trim().length < MIN_NEEDLE) return null
  const head = squash(first).slice(0, NEEDLE_CHARS)
  const whole = squash(prompt)
  const tail = whole.length > NEEDLE_CHARS * 2 ? whole.slice(-NEEDLE_CHARS) : ''
  const holds = (text: string): boolean => {
    const flat = squash(text)
    return flat.includes(head) || (!!tail && flat.includes(tail)) || PASTED.test(text)
  }
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
  if (at < 0) {
    // No marker on screen: a composer taller than the screen has scrolled its first row
    // off the top. What is left of it sits above the last rule, and it ENDS with the prompt's
    // tail - a submitted echo further up has the CLI's reply and a rule drawn after it.
    let end = -1
    for (let r = rows.length - 1; r >= 0; r--) if (RULE.test(rows[r])) { end = r; break }
    if (end <= 0 || !tail) return null
    return squash(rows.slice(0, end).join('\n')).endsWith(tail) ? true : null
  }
  // The composer is the marker row plus the rows it wrapped onto, which end at the rule
  // the CLI draws under it (or at the end of what has been painted).
  let block = rows[at].slice(inputStart(raw[at]))
  for (let r = at + 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row.trim() || RULE.test(row)) break
    block += ' ' + row
  }
  return holds(block)
}

/**
 * A long paste is drawn as a placeholder, not as its words: Claude Code's `[Pasted text #1
 * +26 lines]`, Codex's `[Pasted Content 959 chars]` (codex-cli 0.157). Read for its words it is
 * a composer that does not hold the prompt - and a prompt still waiting in the box was
 * logged as gone. The placeholder IS the prompt still waiting there.
 */
const PASTED = /\[Pasted (?:text #\d+(?: \+\d+ lines?)?|Content \d+ chars)\]/
