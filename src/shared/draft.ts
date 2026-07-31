// What the user has typed but not sent yet.
//
// PaneForge has no composer. The only path text takes into an agent is `api.write(id,
// data)`, and the draft itself lives inside the agent CLI's own line editor, inside the
// pty. So the app does not own that text - it reconstructs it from the keystrokes it is
// relaying anyway.
//
// It already did that three times, each a little differently and each blind to the
// others: the scroll rail's `feedInput` (bracketed paste, 400 chars, newlines flattened),
// `slashTurn.typeLine` (is this line `/clear`, ESC chunks skipped whole, tail of 200) and
// `laneWork.trackTyped` (full CSI/SS3/OSC parsing, bare ESC abandons the line). Giving one
// of them a new case never gave it to the other two - which is how `ESC [ O`, the focus
// report xterm sends when a pane loses focus, made every line after a focus change begin
// "[O" in one of them and not the others.
//
// This is the one parser. The three callers keep their own question and their own limits,
// expressed as presets below rather than as three copies of the loop.
//
// `npm run test:draft` holds it, and `test:slash` / `test:lanework` / `test:rail` prove
// the callers still answer what they answered before.

/** How much of a line each caller keeps, and which end of it. */
export interface DraftOptions {
  /** Characters kept. A line longer than this is cut at `keep`'s far end. */
  max: number
  /** Which end survives the cut. The rail shows the start; `/clear` detection wants it too. */
  keep: 'head' | 'tail'
  /** Skip any chunk that begins with ESC instead of parsing it (slashTurn's older rule). */
  skipEscapeChunks: boolean
  /** Decode bracketed paste as text. Off means a paste is invisible. */
  paste: boolean
  /** A bare ESC at the end of a chunk is the Escape key and throws the line away. */
  escapeAbandons: boolean
  /**
   * Enter ends the line here. Off keeps it, which is what `slashTurn` needs: its caller
   * asks "was that a slash command" AFTER feeding the chunk that contained the Enter,
   * and then clears the line itself.
   */
  enterSubmits: boolean
  /**
   * Ctrl-C and Ctrl-U throw the line away. Off ignores them, which is `slashTurn`'s
   * behaviour as shipped - and changing it there would change when the bell arms, which
   * has been chased three times and is not this feature's to reopen.
   */
  killClears: boolean
}

/** The complete reconstruction: everything typed, paste included, nothing flattened. */
export const DRAFT_OPTIONS: DraftOptions = {
  max: 8000,
  keep: 'head',
  skipEscapeChunks: false,
  paste: true,
  escapeAbandons: true,
  enterSubmits: true,
  killClears: true
}

/**
 * What the scroll rail's hover label shows. The rail used to keep its own 400-character
 * copy; it now reads `DRAFT_OPTIONS`' state and flattens it at display time, so the pane
 * has one draft rather than one per consumer.
 */
export const RAIL_LABEL_CHARS = 400

/** "Is the line being submitted a slash command." Never needs a paste, never needs length. */
export const SLASH_OPTIONS: DraftOptions = {
  max: 200,
  keep: 'tail',
  skipEscapeChunks: true,
  paste: false,
  escapeAbandons: false,
  enterSubmits: false,
  killClears: false
}

/**
 * laneWork's `/clear` watch. Same question as `SLASH_OPTIONS` but it parses escapes
 * properly, and it keeps only the tail: a pasted prompt can be thousands of characters
 * and none of them can make the last word `/clear` on their own.
 */
export const LANE_OPTIONS: DraftOptions = {
  max: 32,
  keep: 'tail',
  skipEscapeChunks: false,
  paste: false,
  escapeAbandons: true,
  enterSubmits: true,
  killClears: true
}

export interface DraftState {
  /** The line as it currently stands, capped per `DraftOptions`. */
  text: string
  /**
   * Whether `text` can be trusted to be what is really in the CLI's prompt box.
   *
   * Goes false the moment something arrives that edits the line somewhere this cannot
   * follow - an arrow key (which is also history recall), Home/End, a Tab completion that
   * the CLI will expand into a path, an unknown Alt-chord. Reset by anything that starts a
   * fresh line: Enter, Ctrl-C, Ctrl-U, Escape.
   *
   * This is the flag that decides whether accepting an improvement may wipe the box. A
   * wrong shadow with `certain` false must never be typed over something the user has.
   */
  certain: boolean
  /** Mid bracketed paste: the closing marker has not arrived yet. */
  inPaste: boolean
}

export function newDraft(): DraftState {
  return { text: '', certain: true, inPaste: false }
}

export interface DraftResult {
  state: DraftState
  /** Lines Enter was pressed on during this chunk, trimmed, oldest first. */
  submitted: string[]
}

function cap(text: string, o: DraftOptions): string {
  if (text.length <= o.max) return text
  return o.keep === 'head' ? text.slice(0, o.max) : text.slice(-o.max)
}

/** Erase back over trailing whitespace and then one word - Ctrl-W. */
function killWord(text: string): string {
  return text.replace(/\s*\S*$/, '')
}

/**
 * Fold one chunk of keystrokes into the line so far.
 *
 * Pure, and returns a new state rather than mutating: three callers share it and one of
 * them is React, which is free to re-run the function that owns the state.
 */
export function feedDraft(
  prev: DraftState,
  chunk: string,
  options: Partial<DraftOptions> = {}
): DraftResult {
  const o = { ...DRAFT_OPTIONS, ...options }
  const submitted: string[] = []
  let { text, certain, inPaste } = prev

  if (!chunk) return { state: { text, certain, inPaste }, submitted }
  // The old slashTurn rule, kept because it is the reading that errs toward "a real
  // prompt": anything it cannot follow leaves the line alone rather than corrupting it.
  if (o.skipEscapeChunks && chunk.charCodeAt(0) === 0x1b) {
    return { state: { text, certain, inPaste }, submitted }
  }

  const submit = (): void => {
    submitted.push(text.trim())
    text = ''
    certain = true
  }
  const abandon = (): void => {
    text = ''
    certain = true
  }

  for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i)

    if (code === 0x1b) {
      // An ESC with nothing after it in this chunk is the Escape key itself.
      if (i === chunk.length - 1) {
        if (o.escapeAbandons) abandon()
        break
      }
      const next = chunk[i + 1]

      if (next === '[' || next === 'O') {
        // CSI and SS3 both run to a final byte in @ to ~. Collect the parameters on the
        // way so a paste marker and a focus report can be told apart from an arrow key.
        const introducer = next
        let j = i + 2
        let params = ''
        while (j < chunk.length) {
          const c = chunk.charCodeAt(j)
          if (c >= 0x40 && c <= 0x7e) break
          params += chunk[j]
          j++
        }
        const final = j < chunk.length ? chunk[j] : ''
        i = j

        if (introducer === '[' && params === '200' && final === '~') {
          if (o.paste) inPaste = true
          continue
        }
        if (introducer === '[' && params === '201' && final === '~') {
          inPaste = false
          continue
        }
        // ESC [ I and ESC [ O are xterm's focus reports. They are not typing and they are
        // not an edit: treating them as either is the bug that made every line after a
        // focus change start with "[O".
        if (introducer === '[' && (final === 'I' || final === 'O') && !params) continue
        // Cursor movement, history recall, Home/End/Delete/PgUp - the line is now being
        // edited somewhere this parser is not watching.
        if ('ABCDHF'.includes(final) || (final === '~' && /^\d+$/.test(params))) certain = false
        continue
      }

      if (next === ']') {
        // OSC - a window title, a hyperlink. Runs to BEL or to ESC \.
        let j = i + 2
        while (j < chunk.length) {
          if (chunk.charCodeAt(j) === 7) break
          if (chunk.charCodeAt(j) === 0x1b && chunk[j + 1] === '\\') {
            j++
            break
          }
          j++
        }
        i = j
        continue
      }

      // Alt+Enter is how these CLIs put a newline in the prompt box without submitting
      // it, so it is the one two-byte escape that is real typing.
      if (next === '\r' || next === '\n') {
        i += 1
        if (!inPaste) {
          text = cap(text + '\n', o)
          continue
        }
        continue
      }

      // Some other Alt-chord. It edits the line in a way this cannot model.
      i += 1
      certain = false
      continue
    }

    if (inPaste) {
      // Newlines inside a paste are content, not submissions. Normalised so a Windows
      // clipboard and a Unix one produce the same draft.
      if (code === 13) {
        if (chunk[i + 1] === '\n') i++
        text = cap(text + '\n', o)
      } else if (code === 10 || code >= 0x20 || code === 9) {
        text = cap(text + chunk[i], o)
      }
      continue
    }

    if (code === 13 || code === 10) {
      if (o.enterSubmits) submit()
      continue
    }
    if (code === 8 || code === 127) {
      text = text.slice(0, -1)
      continue
    }
    // Ctrl-C and Ctrl-U both throw the line away. Ctrl-U is offered back on Ctrl-Y by
    // Claude Code, which is why accepting an improvement can use it as its undo.
    if (code === 3 || code === 21) {
      if (o.killClears) abandon()
      continue
    }
    if (code === 23) {
      text = killWord(text)
      continue
    }
    // Tab is completion: the CLI is about to write something into the box itself.
    if (code === 9) {
      certain = false
      continue
    }
    // Ctrl-A / Ctrl-E move the cursor off the end, so later characters no longer append.
    if (code === 1 || code === 5) {
      certain = false
      continue
    }
    if (code < 0x20) continue
    text = cap(text + chunk[i], o)
  }

  return { state: { text, certain, inPaste }, submitted }
}

/** One line, no newlines, capped - what a hover label and a chip can show. */
export function flatDraft(text: string, max = 400): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, max)
}

/**
 * Is this draft worth offering to improve?
 *
 * Deliberately a heuristic and deliberately free: it gates whether a chip appears, never
 * whether a model runs. Generation only ever starts on a deliberate action.
 *
 * The rules are about not interrupting a thought. A line still being typed usually ends
 * mid-clause, and a slash command or a one-word answer is not a prompt at all.
 */
export function looksFinished(text: string, min = 40): boolean {
  const t = flatDraft(text).trim()
  if (t.length < min) return false
  if (t.startsWith('/') || t.startsWith('!') || t.startsWith('#')) return false
  // Trailing conjunctions, articles and commas: the sentence is going somewhere.
  if (/[,;:]$|\b(and|or|but|the|a|an|to|for|with|of|in|on|that|which|is|are)$/i.test(t)) {
    return false
  }
  return true
}

/**
 * Verbs that name a piece of WORK rather than a question about it. A prompt with several
 * of these is a prompt that is several jobs, which is the thing worth splitting.
 */
const DOING =
  /\b(add|build|make|create|write|implement|wire|port|migrate|refactor|rework|redesign|rename|move|delete|remove|drop|fix|repair|handle|support|show|hide|update|change|replace|document|test|cover|ship|release|expose|extract|split|merge|cache|optimi[sz]e|speed up|clean up|set up)\b/i

/**
 * Does this draft ask for several separate jobs?
 *
 * The same contract as `looksFinished`: free, wrong sometimes, and it only ever decides
 * whether a chip appears. Nothing is planned and no pane is opened until the chip is
 * clicked, because a plan costs a whole CLI start-up (measured at 61.5 s bare for this
 * repo) and panes that open by themselves are panes nobody asked for.
 *
 * A "job" is a bullet, a numbered item, or a sentence with a doing-verb in it. Counting
 * conjunctions instead was the obvious rule and it is useless: half of ordinary English
 * has an "and" in it, and a chip that appears on every prompt is a chip nobody reads.
 */
export function looksSplittable(text: string, min = 120): boolean {
  const raw = text.replace(/\r/g, '')
  if (!looksFinished(raw, 60)) return false
  if (flatDraft(raw).length < min) return false
  const listed = raw.split('\n').filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l))
  const jobs = listed.length
    ? listed.filter((l) => DOING.test(l))
    : flatDraft(raw)
        .split(/(?<=[.!?;])\s+|\s+(?:and (?:then |also )?|then |plus )(?=\w)/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 12 && DOING.test(s))
  return jobs.length >= 3
}
