// What a pane's handoff says is still open.
//
// A pane's real state is not only what is on its screen: a session past the context line
// writes a handoff, and that file's `## Next steps` is the one place that says whether
// there is work left. The app could not read it, so two things were impossible - a card
// could not say "3 open", and the automatic-clear countdown listed steps handed to it by
// a script rather than steps read from the file it is about to act on.
//
// This is a MIRROR of the judgement in `claude-memory/claude-config/autoclear.mjs`
// (`openNextSteps` + `actionableNextSteps`), the same way `shared/promptKey.ts` mirrors the
// prompt-archive fingerprint. Editing one copy splits it in silence, so `handoff-steps-test`
// recomputes the canonical file's answers and SKIPS OUT LOUD when that file is not on this
// machine.

/**
 * The genuinely open items under `## Next steps`.
 *
 * "None" is the answer the reporting rules ask for when the work is closed and MUST NOT
 * read as an open step - a handoff saying None that counted as one would mark every
 * finished pane as having work left, for ever.
 */
export function openNextSteps(md: string): string[] {
  const text = String(md || '')
  const start = text.search(/^#{1,4}\s*Next steps\b/im)
  if (start < 0) return []
  const rest = text.slice(start).split('\n').slice(1)
  const steps: string[] = []
  for (const raw of rest) {
    if (/^#{1,4}\s/.test(raw)) break // the next section
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)
    if (!m) continue
    const body = m[1].replace(/^\[[ xX]\]\s*/, '').replace(/\*\*/g, '').trim()
    if (!body) continue
    if (/^(none|nothing|n\/a|-)\b/i.test(body)) continue
    steps.push(body)
  }
  return steps
}

/**
 * What is wrong with a handoff's shape, or null when `openNextSteps` can read it.
 *
 * A handoff the parser cannot read looks exactly like one that says None: no open steps,
 * no clear, the pane sits there and the next step is lost (wr-03, 2026-10-02). Two shapes
 * did that: no `## Next steps` heading at all (a bold `**Next steps:**` line, a `Todo`
 * heading), and the heading with the steps written as prose under it. A heading with a
 * list, `None`, or nothing under it is a shape the parser answers truthfully.
 */
export function handoffShapeProblem(md: string): 'no-next-steps' | 'steps-not-a-list' | null {
  const text = String(md || '')
  const start = text.search(/^#{1,4}\s*Next steps\b/im)
  if (start < 0) return 'no-next-steps'
  let prose = false
  for (const raw of text.slice(start).split('\n').slice(1)) {
    if (/^#{1,4}\s/.test(raw)) break
    const line = raw.trim()
    if (!line) continue
    if (/^(?:[-*]|\d+[.)])\s+\S/.test(line)) return null
    if (/^(none|nothing|n\/a)\b/i.test(line.replace(/\*\*/g, ''))) return null
    prose = true
  }
  return prose ? 'steps-not-a-list' : null
}

/**
 * Openers that describe a TRIGGER rather than a task. A step behind one of these cannot be
 * started by anybody right now.
 */
const BLOCKED_OPENER =
  /^(only\b|once\b|after\b|when\b|whenever\b|if\b|wait\b|waiting\b|blocked\b|pending\b|watch\b|monitor\b|leave\b|keep an eye\b)/i

/**
 * A step whose owner is a person.
 *
 * No bare `robert` here: naming him is not assigning him (`ROBERT_OWNED`). Every
 * alternative carries its own right anchor - the group's leading \b alone let `robert`
 * match inside `robertiuoras`, the home directory of every absolute path on this machine.
 * `(un)tick what|which` is a hand on a GuardDeck checkbox; `tick the` is a session editing
 * a file.
 */
const PERSON_OWNED =
  /\b(your call|his call|her call|their call|you own|you decide|you:|ask (?:him|her|them)|needs? (?:a )?(?:purchase|payment|password|credential|passphrase|approval)|sign in|log in|buy\b|approve\b|(?:un)?tick (?:what|which)\b)/i

/**
 * Robert owns a step only as its ACTOR: the subject of an obligation, behind an assignment
 * marker, the one being asked, or `Robert:` opening the step. "so the result reaches
 * Robert" is a session's work. `['’]s`: handoffs use the curly apostrophe as often as not.
 */
const ROBERT_OWNED =
  /\brobert(?:['’]s)?\s+(?:call|decision|choice|to\b|must\b|should\b|needs?\b|has to\b|will\b|can\b|decides?\b|chooses?\b|picks?\b|prefers?\b|wants?\b|confirms?\b|approves?\b|signs? off\b)|\b(?:ask|check with|confirm with|chase|wait for|waiting on|up to|owner:|owned by|assigned to|blocked on|needs)\s+robert\b|\(\s*robert\b|^robert:\s/i

/**
 * The step's words with anything QUOTED taken out - "..." (straight or curly) and `...`.
 * A quote is somebody else's words: a UI label an agent drives, a command, what Robert
 * said. None of it names who owns the step (pane s59, 2026-09-27: an agent tapping
 * "Sign in with Google" in a Simulator read as a person's sign-in).
 */
export function unquoted(body: string): string {
  return String(body).replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, ' ')
}

function personOwned(body: string): boolean {
  const plain = unquoted(body)
  return PERSON_OWNED.test(plain) || ROBERT_OWNED.test(plain)
}

/** What a `Once ...` trigger waits on that no session in this chat controls. */
const EXTERNAL_WAIT = /\b(?:ci\b|releas|install|deploy|merg|review|build|green|approv|robert\b|he\b|she\b|they\b|you\b)/i

/**
 * Can a fresh session start this step? `prev` = the step before it could. `Once X:`
 * right after a startable step is its second half, unless X waits on something outside
 * this chat ("Once CI is green, merge" stays blocked). Only `Once`: "Only after that"
 * is a hold whatever came before it.
 */
function stepActionable(body: string, prev: boolean): boolean {
  if (/\bblocked (?:until|on|by|pending)\b/i.test(body)) return false
  if (personOwned(body)) return false
  if (BLOCKED_OPENER.test(body)) {
    if (!prev || !/^once\s/i.test(body)) return false
    const trigger = body.replace(/^once\s+/i, '').split(/[:,;]|\s[-–—]\s/)[0]
    return !EXTERNAL_WAIT.test(unquoted(trigger))
  }
  return true
}

/**
 * The steps a FRESH SESSION could actually start on.
 *
 * The parse and the judgement are separate on purpose: the parse is literal and asserted
 * against real handoffs, this is the opinion about what counts as work.
 */
export function actionableNextSteps(md: string): string[] {
  const out: string[] = []
  let prev = false
  for (const body of openNextSteps(md)) {
    prev = stepActionable(body, prev)
    if (prev) out.push(body)
  }
  return out
}

/**
 * The steps only a PERSON can take - a login, a purchase, an approval, "your call".
 *
 * The other half of `actionableNextSteps`, kept as its own reading because a pane that
 * finishes with nothing but these is DONE from the app's point of view (`shared/doneClose.ts`)
 * and each of them becomes a GuardDeck to-do that names the machine it happens on. A step
 * behind a trigger word (`after`, `once`, `when`) is neither: nobody can start it now.
 */
export function personOwnedSteps(md: string): string[] {
  return openNextSteps(md).filter((body) => !BLOCKED_OPENER.test(body) && personOwned(body))
}

/**
 * How many steps a pane's handoff leaves open, as the card and `closeAfterResult` read it:
 * `undefined` when there is no handoff, AND when the handoff is older than the pane's last
 * prompt (`promptAt`, `ReplyRead.promptAt`) - that prompt, or one before it, read it and
 * went on, and the reply now says what is left.
 *
 * 27 Sep: `handoffFor` falls back to a project's unscoped handoff, so s78 and s81 - panes
 * born a day after it - read `session-handoff.md` written 26 Sep 04:41Z as "1 step open",
 * and a finished pane with one never closes.
 */
export function handoffOpenAfter(hand: { path: string | null; open: number; mtimeMs: number }, promptAt?: number): number | undefined {
  if (!hand.path) return undefined
  if (promptAt && hand.mtimeMs < promptAt) return undefined
  return hand.open
}

/** What a card says beside a pane, or null when there is nothing worth a chip. */
export function stepsWord(open: number): string | null {
  if (!open) return null
  return open === 1 ? '1 step open' : `${open} steps open`
}

/** A project directory as `~/.claude/projects` names it. */
export function slugFor(cwd: string): string {
  return String(cwd || '').replace(/[^A-Za-z0-9-]/g, '-')
}

/** A pane's own handoff slot. A pane id that is not a plain name gets none, never a path. */
export function paneSlot(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(String(id || '')) ? `.pane-${id}` : ''
}

/**
 * Every place this pane's handoff could be, in the order the hook looks.
 *
 * `symlinked` answers whether a project directory is a symlink - lane worktrees share ONE
 * memory folder through one, so `App-a` and `App` write into the same directory and need a
 * `.<checkout>` slot to tell their handoffs apart. It is injected because this file may not
 * touch the disk: the renderer imports it for `stepsWord`.
 */
export function handoffCandidates(
  cwd: string,
  paneId: string,
  claudeHome: string,
  symlinked: (path: string) => boolean
): string[] {
  const dir = String(cwd || '')
  const parts = dir.split(/[\\/]/)
  const base = parts[parts.length - 1] ?? ''
  const out: string[] = []
  const add = (proj: string, name: string): void => {
    const p = `${claudeHome}/projects/${proj}/memory/${name}`
    if (!out.includes(p)) out.push(p)
  }
  const cwdSlot = (d: string): string =>
    symlinked(`${claudeHome}/projects/${slugFor(d)}`)
      ? '.' + (d.split(/[\\/]/).pop() ?? '')
      : ''
  const proj = slugFor(dir)
  const cslot = cwdSlot(dir)
  add(proj, `session-handoff${paneSlot(paneId) || cslot}.md`)
  if (cslot) add(proj, `session-handoff${cslot}.md`)
  add(proj, 'session-handoff.md')
  const main = dir.replace(/-[a-z]$/, '')
  if (main !== dir) {
    if (paneSlot(paneId)) add(slugFor(main), `session-handoff${paneSlot(paneId)}.md`)
    add(slugFor(main), `session-handoff.${base}.md`)
    add(slugFor(main), 'session-handoff.md')
  }
  return out
}
