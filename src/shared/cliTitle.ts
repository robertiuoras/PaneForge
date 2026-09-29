// What a pane is called, taken from what the agent itself calls the conversation.
//
// For a year the app named panes off the words somebody typed: a lexicon, a typo table and
// "two asks agree on a word". Measured on both desks on 2026-09-28, about three of its
// thirty-odd names were any good - `Vverify Course Helped` ("of course", twice), `Prompt
// Anyways Delted`, `Cards Time Way Zoomed`, and one pane renamed five times in ninety
// minutes. Robert types fast, loosely and with typos, and no word-picker reads that.
//
// Claude Code already writes a title for every conversation - the one its own `/resume`
// list shows - into the transcript: `{"type":"ai-title","aiTitle":"Growth call sheet
// optimization"}`, generated once from the first real ask and re-appended as the file is
// saved. `/rename` inside the CLI writes `{"type":"custom-title","customTitle":...}` the same
// way. A model that read the whole ask wrote the first; a person wrote the second. So the
// app reads them instead of guessing, which costs nothing: the CLI already paid for it.
//
// Pure, so scripts/cli-title-test.mjs can compile this one file and assert real titles.

// `squash` = letters and digits only, so `taskdriver.ai`, `Taskdriver AI` and `taskdriver-ai` agree.
import { MAX_TITLE, squash } from './clientName'

/** The two titles a Claude Code transcript can carry, newest of each. */
export interface CliTitles {
  /** written by the CLI's own model from the first ask */
  ai?: string
  /** typed by a person with `/rename` - outranks everything automatic; '' = renamed back to nothing */
  custom?: string
}

/**
 * The newest title of each kind in a run of transcript lines.
 *
 * Both are "last wins" in the CLI's own reader, so the LAST line of each kind is the one
 * it would show. A line is only parsed when it already names the type, so a 4 MB tail
 * costs a string search, not four thousand `JSON.parse` calls.
 */
export function titlesIn(text: string): CliTitles {
  const out: CliTitles = {}
  for (const line of text.split('\n')) {
    const ai = line.includes('"type":"ai-title"')
    if (!ai && !line.includes('"type":"custom-title"')) continue
    let rec: { aiTitle?: unknown; customTitle?: unknown }
    try {
      rec = JSON.parse(line)
    } catch {
      continue // a line still being written when the file was read
    }
    const v = ai ? rec.aiTitle : rec.customTitle
    if (typeof v !== 'string') continue
    // Kept even when empty: a `/rename` back to nothing must overwrite the name an earlier
    // read found, not leave it standing.
    out[ai ? 'ai' : 'custom'] = v.trim()
  }
  return out
}

/**
 * Words about the desk's own housekeeping, never about the work.
 *
 * A conversation that opens on an automatic "Continue the handoff: work its Next steps"
 * gets titled for THAT - `Car handoff continuation`, `Taskdriver.ai handoff next steps`,
 * `Session handoff next steps` were a third of the Mac's titles in a day. The work is the
 * same work the pane was already named for, so such a title is only ever a CONTINUATION.
 * Whole words only, and `session` only in front of the handoff words: `SessionManager
 * sweep` and `Supabase session auth fix` are about the work.
 */
const HOUSEKEEPING =
  /\b(?:hand-?offs?|handovers?|continuations?|continu(?:ing|ed|e)|resum(?:ed|ing)|next steps?|(?<=hand-?offs? )steps?|sessions?(?= (?:hand-?offs?|handovers?|continu|resum|next steps?\b))|lane[ -][a-z])\b|\(cont(?:\.|inued)?\)/gi

/** Joining words a title may not end or start on once the housekeeping is cut out of it. */
const JOINER = /^(?:and|or|with|for|of|to|in|on|from|the|a|an|&|\+|-|–|—|:|,|;)$/i

/** What the CLI title says for this pane's card, and whether it is a continuation. */
export interface CardTitle {
  /** the name to wear, or '' when the title says nothing the folder name does not */
  title: string
  /** the title is about the desk's housekeeping (a handoff, a resume), not new work */
  continuing: boolean
}

/**
 * The card name a CLI title gives a pane in `project`.
 *
 * The housekeeping words come out; what is left is only a name when it says more than the
 * project the pane is already in - `Research lab lane B handoff continuation` in
 * `research-lab` says nothing, `Taskdriver mobile launch optimization handoff` says what the
 * job is.
 */
export function cardTitle(cliTitle: string, project: string): CardTitle {
  const raw = cliTitle.replace(/\s+/g, ' ').trim()
  const cut = raw.replace(HOUSEKEEPING, ' ')
  const continuing = cut !== raw
  const words = cut
    .replace(/\s*([,:;])\s*/g, '$1 ')
    .split(' ')
    .map((w) => w.trim())
    .filter(Boolean)
  // Tidy the seams the cut left: a joiner or bare punctuation at either end, and a comma
  // or colon hanging off the last word.
  while (words.length && JOINER.test(words[0].replace(/[,:;]$/, ''))) words.shift()
  while (words.length && JOINER.test(words[words.length - 1].replace(/[,:;]$/, ''))) words.pop()
  if (words.length) words[words.length - 1] = words[words.length - 1].replace(/[,:;]+$/, '')
  const title = words.join(' ')
  const name = squash(title)
  const home = squash(project)
  // Only the project again (`Taskdriver` in `taskdriver-mobile`, `Car` in `Car`), the
  // project's lane folder (`PaneForge-a handoff next steps`, `-w2`), or nothing at all: the
  // folder name already says it.
  if (!name || (home && (home.startsWith(name) || name === home))) return { title: '', continuing }
  if (home && name.startsWith(home) && /^(?:[a-z]|w\d+)$/.test(name.slice(home.length))) return { title: '', continuing }
  return { title: capTitle(title), continuing }
}

/** What a pane is wearing now, as far as naming is concerned. */
export interface PaneName {
  title: string
  /** `agent` = the CLI's title, `client` = the roster; unset = the app's default or a person's */
  autoTitled?: 'client' | 'agent'
  /** the title is still the one the app gave it at birth: the folder or project name */
  appDefault: boolean
}

/**
 * The name a pane should switch to after reading its transcript, or nothing.
 *
 * `seen` is what the previous read found - `undefined` on the first read since the pane
 * started, which matters for the person's `/rename`: on a first read it may be OLDER than a
 * name typed into the app since, so it is only taken when the card still wears something
 * the app chose. After that, a `/rename` that CHANGES is a person acting now, and wins.
 *
 * The CLI's own title is taken only over a name the app chose (the folder, or an earlier CLI
 * title) - never over a person's, an opener's (`pf open --title`), or a client from the
 * roster - and never as a continuation over a name the pane already earned: an automatic
 * handoff is the same job going on, so the card keeps saying what that job is. The CLI
 * writes its title once per conversation, so a card changes name at most once per `/clear`
 * that starts new work, never mid-chat.
 *
 * A title that is ONLY housekeeping (`Taskdriver AI handoff next steps`) on a card still
 * wearing its folder name takes the name of the conversation it continues instead: `earlier`
 * lists the titles of the conversations the same CLI ran before this one, newest first (see
 * `main/cliChain.ts`). Without it the card stayed on its folder for good - an automatic
 * handoff's next conversation is another handoff - which is what cards 3 and 4 on the Mac
 * showed on 2026-09-29 (`taskdriver.ai`, `PaneForge`). Only asked for when it is needed.
 */
export function nextTitle(
  pane: PaneName,
  read: CliTitles,
  seen: CliTitles | undefined,
  project: string,
  earlier?: () => CliTitles[]
): { title: string; by: 'person' | 'agent' } | undefined {
  const appChosen = pane.appDefault || pane.autoTitled === 'agent'
  if (read.custom && read.custom !== seen?.custom) {
    if (seen || appChosen) return read.custom === pane.title ? undefined : { title: read.custom.slice(0, MAX_TITLE), by: 'person' }
    return undefined
  }
  if (!read.ai || read.ai === seen?.ai || read.custom || !appChosen) return undefined
  const next = cardTitle(read.ai, project)
  if (next.continuing && pane.autoTitled === 'agent') return undefined
  const title = next.title || (next.continuing && pane.appDefault && earlier ? continuedTitle(earlier(), project) : '')
  if (!title || title === pane.title) return undefined
  return { title, by: 'agent' }
}

/** The newest earlier conversation's name that says what the work is, or ''. */
function continuedTitle(earlier: CliTitles[], project: string): string {
  for (const t of earlier) {
    if (t.custom) return t.custom.slice(0, MAX_TITLE)
    const name = t.ai ? cardTitle(t.ai, project).title : ''
    if (name) return name
  }
  return ''
}

/**
 * The id of the CLI process a transcript was written by, when that is not its own.
 *
 * `/clear` starts a new transcript file under a new id, but the CLI keeps stamping the id it
 * was STARTED with on its attachment records (`"session_id":"100b6a8b-..."` inside
 * `be6d5f8a-....jsonl`). Measured on the Mac on 2026-09-29: all 300 conversations of the
 * last three days whose title was only housekeeping were born from a `/clear` and carry it.
 * It sits after the SessionStart hook output, ~265 KB into the file, so `head` must reach it.
 */
export function startedAs(head: string, own: string): string | undefined {
  const m = /"session_id":"([0-9a-f-]{36})"/.exec(head)
  return m && m[1] !== own ? m[1] : undefined
}

/** At most `MAX_TITLE` characters, cut at a whole word. */
function capTitle(s: string): string {
  if (s.length <= MAX_TITLE) return s
  const cut = s.slice(0, MAX_TITLE + 1)
  const at = cut.lastIndexOf(' ')
  return (at > 20 ? cut.slice(0, at) : s.slice(0, MAX_TITLE)).replace(/[\s,:;&+-]+$/, '')
}
