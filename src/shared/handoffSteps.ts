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
 * Openers that describe a TRIGGER rather than a task. A step behind one of these cannot be
 * started by anybody right now.
 */
const BLOCKED_OPENER =
  /^(only\b|once\b|after\b|when\b|whenever\b|if\b|wait\b|waiting\b|blocked\b|pending\b|watch\b|monitor\b|leave\b|keep an eye\b)/i

/**
 * A step whose owner is a person.
 *
 * `robert` carries its OWN trailing \b. The leading \b belongs to the whole group and the
 * alternatives inside it are otherwise unanchored on the right, so a bare `robert` matched
 * inside `robertiuoras` - which is in the home directory of every absolute path on this
 * machine, and made every step naming a path read as person-owned. Every alternative added
 * here needs its own right anchor for the same reason.
 */
const PERSON_OWNED =
  /\b(your call|his call|her call|their call|robert\b|you own|you decide|you:|ask (?:him|her|them)|needs? (?:a )?(?:purchase|payment|password|credential|passphrase|approval)|sign in|log in|buy\b|approve\b)/i

/**
 * The steps a FRESH SESSION could actually start on.
 *
 * The parse and the judgement are separate on purpose: the parse is literal and asserted
 * against real handoffs, this is the opinion about what counts as work.
 */
export function actionableNextSteps(md: string): string[] {
  return openNextSteps(md).filter((body) => !BLOCKED_OPENER.test(body) && !PERSON_OWNED.test(body))
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
