// A pane named off a HANDLE takes the name the agent finds for it.
//
// The first thing typed at a pane in the clients tree was `working on $50 task from
// yesterday can you find that ...`, and the card wore `Working On 50 Task` for the rest of
// the day - the runway of a sentence whose whole point was that the subject was NOT yet
// named. The agent then found it, and said so on screen in the plainest shape there is:
//
//   $50 task = Travel Video Editor, Jacob P. (board id 794, stage In progress, ...)
//
// That line is the moment the pane learned what it is working on, and nothing read it. So
// this is the rule: an ask that points at its subject by a handle - a price, `from
// yesterday`, `that client` - is a question the reply answers, and the pane is named off the
// answer. The handle is read off the ASK (so a reply naming six things names the card for
// the one that was asked about), the name is read off the REPLY, and a reply that never
// resolves the handle names nothing. `npm run test:resolvedname`.

import { MAX_TITLE } from './clientName'

/** What is being pointed at: a task, a client, a job. */
const THING = '(?:task|tasks|job|jobs|gig|client|customer|project|order|ticket|lead|enquiry|inquiry|quote)'

/**
 * The shapes a subject is pointed at rather than named. Each alternative is one handle;
 * the match text IS the handle, so it can be found again in the reply.
 */
const HANDLES = [
  // `$50 task`, `the $1,200 job`, `50 dollar task`
  new RegExp(`\\$\\s?\\d[\\d,.]*k?\\s*${THING}`, 'i'),
  new RegExp(`\\d[\\d,.]*k?\\s*(?:dollar|dollars|aud|usd|bucks)\\s+${THING}`, 'i'),
  // `task from yesterday`, `client from last week`, `job from this morning`
  new RegExp(`${THING}\\s+from\\s+(?:yesterday|today|tonight|last\\s+\\w+|this\\s+\\w+|the\\s+other\\s+\\w+|earlier)`, 'i'),
  // `yesterday's task`, `that client`, `the new job`, `task #794`, `task 794`
  new RegExp(`(?:yesterday'?s|today'?s|that|those|the\\s+(?:new|latest|last|other|same|first|second|next))\\s+${THING}`, 'i'),
  new RegExp(`${THING}\\s*(?:#|no\\.?|number|id)\\s*\\d+`, 'i')
]

/**
 * The handle an ask points with, or nothing. Only the first clause: `fix the invoice and
 * look at that client` is about the invoice.
 */
export function handleOf(ask: string): string {
  const line = ask.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  if (!line || line.startsWith('/')) return ''
  const clause = (line.split(/[.;:?!()]/)[0] ?? '').split(/\s(?:and|but|then|also)\s/)[0] ?? ''
  for (const re of HANDLES) {
    const m = clause.match(re)
    if (m) return m[0].replace(/\s+/g, ' ').trim()
  }
  return ''
}

/** A word that may open a name: capitalised, all-caps, or a number (`Q3 Report`, `A4 Advocate`). */
const NAME_WORD = "(?:[A-Z][A-Za-z0-9'&.-]*|[0-9][A-Za-z0-9'&.-]*)"
/**
 * Joiners that may sit INSIDE a name without breaking it: `Property Investors of Alliance`.
 * Not `for`/`to`/`at`: `Travel Video Editor for Jacob` is a name and then who it is for.
 */
const JOINER = '(?:of|and|the|de|du|&)'
/** A run of name words, joiners allowed between them but never at either end. */
const NAME_RUN = `${NAME_WORD}(?:\\s+(?:${JOINER}\\s+)?${NAME_WORD}){0,5}`

/** What a name may not be: the shape of the ask, or a word about the session. */
const NOT_A_NAME = /^(?:task|tasks|job|jobs|gig|client|customer|project|order|ticket|the|this|that|it|one|none|nothing|unknown|tbd|n\/a|null|undefined|done|found|pending)$/i

/** Letters and digits only, so the handle is found in a reply that lost its spaces or its apostrophe. */
function loose(handle: string): string {
  const bits = handle
    .split(/[^A-Za-z0-9$#]+/)
    .filter(Boolean)
    .map((w) => w.replace(/[$#]/g, (c) => '\\' + c))
  return bits.join('[^A-Za-z0-9$#]*')
}

/**
 * The name a reply gives the handle, or nothing.
 *
 * Reads the FIRST line that says `<handle> = Name`, `<handle> is Name`, `<handle>: Name`
 * or `<handle> -> Name`, with the name either quoted or a run of capitalised words. The
 * reply is the agent's screen since the ask, ANSI already stripped; a CLI paints with
 * cursor moves, so the words of the handle may arrive with no space between them and the
 * match tolerates that. Everything after a comma, bracket or dash is detail about the
 * thing, not its name.
 */
export function resolvedName(reply: string, handle: string): string {
  if (!handle || !reply) return ''
  const h = loose(handle)
  const link = '\\s*(?:=|:|->|→|=>|—|–|\\bis\\b|\\bwas\\b|\\bturned\\s+out\\s+to\\s+be\\b|\\bturns\\s+out\\s+to\\s+be\\b)\\s*'
  const quoted = new RegExp(`${h}${link}(?:the\\s+)?["“'‘*_\`]+([^"”'’*_\`\\n]{3,${MAX_TITLE}})["”'’*_\`]+`, 'i')
  const plain = new RegExp(`${h}${link}(?:the\\s+)?(${NAME_RUN})`)
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    const m = line.match(quoted) ?? line.match(plain)
    if (!m) continue
    const name = tidy(m[1])
    if (name) return name
  }
  return ''
}

/** The name as a card would wear it: no trailing `task`, no dangling joiner, capped. */
function tidy(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim()
  // A trailing thing-word is what it IS, not what it is called: `the Travel Video Editor
  // task` is called `Travel Video Editor`.
  s = s.replace(new RegExp(`\\s+${THING}$`, 'i'), '')
  s = s.replace(new RegExp(`\\s+${JOINER}$`), '')
  s = s.replace(/[\s.,;:!?-]+$/, '')
  if (s.length < 3) return ''
  if (NOT_A_NAME.test(s)) return ''
  if (/^[\d\s$.,]+$/.test(s)) return ''
  // Nothing about the session names a card (see `SESSION_WORDS` in clientName.ts).
  if (/^(?:handoff|session|context|memory|summary|transcript)$/i.test(s)) return ''
  return s.slice(0, MAX_TITLE)
}
