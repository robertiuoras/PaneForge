// Which CLIENT a pane is working for, so its card says so without anybody typing it.
//
// A pane is named `basename(cwd)` and that is the right default everywhere except one
// folder: a client tree, where every pane is called `clients` and the only thing that
// tells them apart is which chat you happen to remember opening. Robert works one client
// per session deliberately, so the pane already HAS an identity - it is just not written
// anywhere.
//
// There are two places that identity can be read from, and they are ranked:
//
//  1. **The folder.** A pane opened in `<root>/clients/pia-team/campaigns` is that
//     client's pane and nothing can make it otherwise. This is evidence.
//  2. **The first thing asked.** A pane opened at the client tree's ROOT - which is the
//     common case, because the work crosses several folders - only says who it is for in
//     the prompt: "draft the piateam replies". This is inference, so it is fenced.
//
// The whole file is refusals, because the expensive failure is not a pane that keeps its
// folder name. It is a pane renamed to the WRONG client, which is a card that lies while
// somebody sends an invoice off it. So:
//
//  - a slug is only a client when the ROSTER on disk says so (`clients/tools` is not a
//    person, and guessing off the path alone would have made it one);
//  - a name read out of a prompt must match EXACTLY ONE client, on a word boundary,
//    with at least six characters of evidence;
//  - a word is only allowed to be an alias when it is unique across the whole roster,
//    which is computed rather than stop-listed: `alison` names one client here, `team`
//    and `management` name several and are therefore worth nothing;
//  - a pane somebody has already named themselves is never renamed.
//
// Pure, so scripts/client-name-test.mjs can compile this one file and assert the
// sentences. Everything that touches disk is in main/clients.ts.

/** A client the roster knows about. */
export interface ClientEntry {
  /** the folder name under the clients root - `right-key-alison` */
  slug: string
  /** what a person calls them - `Right Key Investment - Alison` */
  name: string
  /** every form of the name a prompt might use, lowercase, longest first */
  aliases: string[]
}

/** The folder a client roster lives in is always called this. */
export const CLIENTS_DIR = 'clients'

/** The shortest run of characters a prompt may be renamed on. */
export const MIN_ALIAS = 5

/**
 * Words that are never evidence, however unique they happen to be on one desk.
 *
 * Uniqueness across the roster does most of the work here - `team` and `finance` name
 * three clients each on this desk and are dropped without anybody deciding they are
 * generic. What it cannot catch is the word that happens to appear in exactly ONE client's
 * name and is still an ordinary English word somebody types about something else:
 * `group`, `level`, `right`. A prompt saying "the right report" is not a client.
 *
 * This is the ONLY hard-coded list in the file and it is deliberately small: it holds the
 * furniture of a business name, never a person's or a brand's. Anything not on it is
 * judged by the roster.
 */
const GENERIC = new Set([
  'group',
  'level',
  'right',
  'finance',
  'building',
  'management',
  'conveyancing',
  'consulting',
  'services',
  'holdings',
  'partners',
  'property',
  'solutions',
  'systems',
  'company',
  'ovens',
  'media',
  'agency',
  'studio',
  'global',
  'digital',
  'online',
  'united',
  'first',
  'prime',
  'invest',
  'investment',
  'investments',
  'limited',
  'trust',
  'works',
  'labs',
  'house',
  'point',
  'north',
  'south'
])

/** How long a pane title may be, matching `SessionManager.rename`. */
export const MAX_TITLE = 60

/** Path segments, whichever way the separators lean. */
function parts(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean)
}

/** Lowercase, and every run of punctuation is one space. Both sides of a comparison. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9À-￿]+/g, ' ')
    .trim()
}

/** The same thing with the spaces taken out: `pia-team`, `PIA Team` and `piateam` agree. */
export function squash(s: string): string {
  return normalise(s).replace(/\s+/g, '')
}

/**
 * The client folder a path is inside, if any.
 *
 * The LAST `clients` segment wins, because the tree here is `Projects/clients/clients/<who>`
 * - a repository called `clients` holding a folder called `clients` - and the outer one's
 * children are `tools`, `data`, `templates`, none of whom is a client. Taking the last
 * one gets that right without knowing anything about this particular tree, and the roster
 * check downstream catches it if it does not.
 */
export function slugFromPath(cwd: string): string | undefined {
  const seg = parts(cwd)
  for (let i = seg.length - 2; i >= 0; i--) {
    if (seg[i].toLowerCase() === CLIENTS_DIR) return seg[i + 1]
  }
  return undefined
}

/**
 * A client's display name, out of the first heading of their README.
 *
 * Real headings on this desk:
 *
 *   `# Angie C.`                                            -> Angie C.
 *   `# PIA Team (Property Investors Alliance) - Darren F.`   -> PIA Team
 *   `# Right Key Investment - Alison (澳洲Alison老師)`        -> Right Key Investment - Alison
 *
 * Two things come off and nothing else. A parenthetical is an expansion of the name
 * beside it, so it is never the thing on a card at 190px. A trailing `- Firstname X.` is
 * a CONTACT, not the client - and it is recognised by its shape (a capitalised word then
 * an initial), which is why `- Alison` survives: a bare first name is how that client is
 * actually referred to, and dropping it would leave a title nobody uses.
 */
export function nameFromHeading(heading: string, slug: string): string {
  const raw = heading.replace(/^#+\s*/, '').trim()
  const paren = /\(([^)]*)\)/.exec(raw)?.[1]?.trim() ?? ''
  let s = raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  s = s.replace(/\s+[-–—]\s+[A-Z][\w'-]*\s+[A-Z]\.?$/, '').trim()
  // A trading name with the PERSON in brackets - `A4 Advocate (Adie Bradley)` - is a card
  // about Adie Bradley: that is who the work is with and what a person says out loud. An
  // expansion of the trading name (`PIA Team (Property Investors Alliance)`) is the same
  // client said longer and is dropped, which is why `isPerson` refuses one.
  if (paren && isPerson(paren, s)) s = paren
  // ...and a heading that spells out the ROLE - `Adie Bradley Client` - says nothing a
  // pane in a client tree did not already say.
  s = s.replace(/\s+clients?$/i, '').replace(/^clients?\s+/i, '').trim()
  if (!s) s = titleCase(slug)
  return s.length > 34 ? s.slice(0, 33).trimEnd() + '…' : s
}

/**
 * Whether a parenthetical is a PERSON rather than the outer name said longer.
 *
 * Two or three capitalised latin words, none of them the furniture of a business name,
 * and - the load-bearing half - whose initials are not the outer name spelled out.
 * `Property Investors Alliance` initials P,I,A are `PIA`, so it is an expansion; `Adie
 * Bradley` against `A4 Advocate` is not, so it is somebody.
 */
function isPerson(paren: string, outer: string): boolean {
  const words = paren.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 3) return false
  if (!words.every((w) => /^[A-Z][a-z'’-]+$/.test(w))) return false
  if (words.some((w) => GENERIC.has(w.toLowerCase()))) return false
  const initials = words.map((w) => w[0].toLowerCase()).join('')
  const outerWords = outer.split(/\s+/).filter(Boolean)
  if (outerWords.map((w) => w[0]?.toLowerCase()).join('') === initials) return false
  if (outerWords.some((w) => w.toLowerCase() === initials)) return false
  return true
}

/** `right-key-alison` -> `Right Key Alison`, for a client with no readable heading. */
export function titleCase(slug: string): string {
  return normalise(slug)
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Every form of every client's name that a prompt is allowed to be matched on.
 *
 * Computed over the WHOLE roster in one pass, because the interesting half is the
 * uniqueness test: a single word out of a client's name is a usable alias exactly when no
 * other client on this desk shares it. That is what makes `alison` and `angie` work while
 * `team`, `group`, `finance` and `management` - each of which appears two or three times
 * in this tree - are worth nothing and are dropped without anybody maintaining a list of
 * them. A roster with one client in it has no ambiguity to protect against, so its words
 * are all unique and all usable, which is correct rather than a special case.
 */
export function withAliases(raw: { slug: string; name: string }[]): ClientEntry[] {
  const seen = new Map<string, number>()
  const wordsOf = (c: { slug: string; name: string }): string[] =>
    [...new Set([...normalise(c.slug).split(' '), ...normalise(c.name).split(' ')])].filter(
      (w) => w.length >= MIN_ALIAS
    )
  for (const c of raw) for (const w of wordsOf(c)) seen.set(w, (seen.get(w) ?? 0) + 1)

  return raw.map((c) => {
    const forms = new Set<string>()
    for (const s of [c.name, c.slug]) {
      const n = normalise(s)
      if (n) forms.add(n)
      const q = squash(s)
      if (q) forms.add(q)
    }
    for (const w of wordsOf(c)) if (seen.get(w) === 1 && !GENERIC.has(w)) forms.add(w)
    return {
      ...c,
      aliases: [...forms].filter((a) => a.length >= MIN_ALIAS).sort((a, b) => b.length - a.length)
    }
  })
}

/** The roster entry for a folder, when the roster agrees that folder is a client. */
export function clientFromPath(cwd: string, roster: ClientEntry[]): ClientEntry | undefined {
  const slug = slugFromPath(cwd)
  if (!slug) return undefined
  const want = slug.toLowerCase()
  return roster.find((c) => c.slug.toLowerCase() === want)
}

/**
 * The one client a piece of text names, or nobody.
 *
 * Two matched clients is not "pick the better one", it is a sentence about both of them
 * and there is no evidence in it about which pane this is. Same for none. The only answer
 * this returns is an unambiguous one.
 */
export function clientFromText(text: string, roster: ClientEntry[]): ClientEntry | undefined {
  const words = normalise(text)
  const solid = squash(text)
  if (!words) return undefined
  const hit = roster.filter((c) =>
    c.aliases.some((a) =>
      a.includes(' ')
        ? new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(words)
        : new RegExp(`(^| )${a}( |$)`).test(words) || solid.includes(a)
    )
  )
  return hit.length === 1 ? hit[0] : undefined
}

/**
 * Whether this pane may be renamed for a client at all.
 *
 * A title somebody typed is the one fact here that came from a person, and it outranks
 * every reading in this file. `basename(cwd)` is what the app itself put there, so it is
 * not a name in that sense - it is the absence of one.
 */
export function mayRename(title: string, cwd: string, dismissed?: boolean): boolean {
  if (dismissed) return false
  const base = parts(cwd).pop() ?? ''
  return title.trim() === base.trim()
}

/**
 * What a prompt is ABOUT, in a few words, for a pane that turned out not to be a client's.
 *
 * A client tree holds unrelated work too - "we just needed a claude session" - and the
 * folder name is no better an answer there than it was for the client panes. The subject
 * of the first thing asked is: `check the rental car booking` is `Rental Car` on a card,
 * which is what a person was going to type if they got round to it.
 *
 * Deliberately blunt. It drops the polite runway a request starts with (`can you`,
 * `please`, `i think we should`), which is where the words are that describe the ASKING
 * rather than the work, keeps four words, and refuses anything left too short to identify
 * a pane. There is no model here and there should not be: this is a label, and a wrong
 * label somebody can retype costs nothing, while a request per prompt costs money for ever.
 */
/**
 * Words a title may not END on: they join a phrase to something that was cut off.
 *
 * Not the same list as the openers stripped off the front - `check` and `fix` are fine
 * to end a title on ("Deploy Check"), and `and`/`with`/`to` never are.
 */
const DANGLING_WORDS =
  'and|or|but|so|then|with|without|for|from|to|of|in|on|at|by|into|onto|about|that|this|these|those|is|are|was|were|be|its|it|my|our|your|their|his|her|has|have|had'
const DANGLING = new RegExp(`^(?:${DANGLING_WORDS})$`)

/**
 * Whether a pane in this folder may be renamed to the SUBJECT of what was asked.
 *
 * Only inside a client tree. The reason topic naming exists is that every pane under
 * `clients/` is called `clients` and nothing tells them apart; a pane opened in
 * `Projects/PaneForge` is already called PaneForge, which is the truest thing that can be
 * written on it - one repo is worked on across many subjects, so renaming it to the first
 * sentence typed replaces a fact with a guess, and the guess goes stale the moment the
 * conversation moves on ("Pizzasrus And" on a PaneForge pane).
 *
 * The folder is the fence rather than a cleverer reading of the prompt, because the whole
 * of this file is the same bet: a card that keeps its folder name is as useful as it was
 * yesterday, and a card that lies is worse than either.
 */
const NO_IDENTITY = new Set([
  CLIENTS_DIR,
  'desktop',
  'documents',
  'downloads',
  'projects',
  'tmp',
  'temp',
  'home',
  'users'
])

export function mayTopicName(cwd: string): boolean {
  const seg = parts(cwd)
  if (seg.some((s) => s.toLowerCase() === CLIENTS_DIR)) return true
  // ...and a pane opened in a folder that is nobody's project - `Desktop`, `Downloads`,
  // the projects root itself - has the same problem the client tree has: the folder name
  // is not about the work. Those get the subject of the first ask too. A real project
  // folder still keeps its own name until the desk has said the same thing three times.
  const last = seg[seg.length - 1]?.toLowerCase() ?? ''
  return NO_IDENTITY.has(last)
}

export function topicTitle(prompt: string, anchor?: ReadonlySet<string>): string {
  const line = prompt.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  if (!line || line.startsWith('/')) return ''
  let s = normalise(line)
  for (;;) {
    const cut = s.replace(
      /^(?:hi|hey|ok|okay|so|also|and|but|please|pls|can|could|would|you|we|i|it|lets|let|us|need|needs|needed|want|wanna|think|maybe|just|help|me|to|for|the|a|an|do|does|did|is|are|should|check|make|now|were|was|able|been|have|has|had|will|gonna|going|thats|its|im|ive|weve|youre|still|already|yes|yeah|no|not|that|this)\s+/,
      ''
    )
    if (cut === s) break
    s = cut
  }
  // Articles anywhere, not only at the front: `Fix The Invoice Template` spends a quarter
  // of a four-word label on a word that identifies nothing.
  let words = s
    .split(' ')
    // Articles anywhere, and the single letters `normalise` leaves behind when it splits
    // `i'm` and `we've` - a card called `M Looking For Cheap` spends its first word on
    // half a contraction.
    // ...and never a word about the session itself: see `SESSION_WORDS`.
    .filter((w) => w.length > 1 && !/^(?:the|a|an)$/.test(w) && !SESSION_WORDS.includes(w))
  // A phrase earned by REPETITION must contain a word that was repeated. The first four
  // words of "so you were able to switch models for me? ... does fable have cached now"
  // named a toolstash pane `Were Able To Switch` (2026-09-01) - the sentence's runway,
  // with the subject the three asks agreed on ("fable", "models") still ahead. So when
  // the opening words hold no anchor, the phrase starts one word before the first anchor
  // and reads on from there, and an ask with no anchor at all names nothing.
  if (anchor) {
    const at = words.findIndex((w) => anchor.has(w))
    if (at < 0) return ''
    if (!words.slice(0, 4).some((w) => anchor.has(w))) words = words.slice(Math.max(0, at - 1))
  }
  words = words.slice(0, 4)
  // A label may not end on a word that is only there to join it to the words that were
  // cut off. Taking the first four words of "pizzasrus and the invoice template" left a
  // card called `Pizzasrus And`, which reads as an unfinished sentence rather than a name
  // - the reader spends a beat looking for the missing half. Trimmed AFTER the slice,
  // because that is where the dangling word comes from.
  while (words.length && DANGLING.test(words[words.length - 1])) words.pop()
  // The 26-character cap takes whole WORDS. Slicing the string left the card wearing half
  // a word - `pizzasrus and the invoice template` became `Pizzasrus And Invoice Tem`,
  // which reads as a name that got corrupted rather than one that got shortened.
  const kept: string[] = []
  for (const w of words) {
    const next = kept.length ? kept.join(' ').length + 1 + w.length : w.length
    if (kept.length && next > 26) break
    kept.push(w)
  }
  // ...and dropping the last word can leave the one that joined it on the end.
  while (kept.length && DANGLING.test(kept[kept.length - 1])) kept.pop()
  const out = kept.join(' ').slice(0, 26)
  if (out.length < 5) return ''
  return titleCase(out)
}

/** The title a client gets, capped the way `rename` caps it. */
export function clientTitle(entry: ClientEntry): string {
  return entry.name.trim().slice(0, MAX_TITLE)
}

/**
 * The subject a pane keeps coming back to, when several asks in a row agree on it.
 *
 * Naming a pane off the FIRST sentence typed is a guess made from one reading, and it is
 * wrong as often as it is right: the first thing asked in a repo is usually an errand
 * ("what did we ship yesterday") and the card then wears that errand for the rest of the
 * day. Repetition is the evidence that was missing. Three asks that share a word are not
 * a sentence about the work, they ARE the work, and a pane can be named for it without a
 * model, a request, or a fence around one folder.
 *
 * So this is the rule outside a client roster: the folder name stands until the desk has
 * said the same thing three times, and only then does the card take a subject.
 */
export const TOPIC_MIN_ASKS = 3

/** How many recent asks are looked at, so a subject that has moved on stops matching. */
export const TOPIC_WINDOW = 4

/**
 * A repeated subject is a LABEL, not a sentence, and it sits beside a client name on the
 * same card - so it is held to the same width a person would type. Shorter than
 * `topicTitle`'s 26: the words here are the ones that survived three asks, so there are
 * fewer of them worth keeping.
 */
export const SHORT_TITLE = 26

/** The most words a repeated subject may spend. */
const TOPIC_MAX_WORDS = 3

/**
 * Words that carry no subject: the runway a request starts with, the verbs every ask
 * uses, and the joining words. A word repeated three times only means something if it is
 * about the WORK - "please" and "should" are in every prompt on the desk.
 */
/**
 * Words about the SESSION rather than about the work.
 *
 * A pane in `Projects/PaneForge` came back from a `/clear` called `Handoff`, because the
 * three asks that earned the rename were all about continuing a handoff - which is
 * housekeeping the desk does to itself between jobs, not the job. Naming a card for it is
 * the same failure the folder fence was built to stop: a fact ("PaneForge") replaced by a
 * word that will be wrong the moment the session gets going.
 *
 * Held out of BOTH readings - the keywords that earn a repeat, and the phrase a
 * client-tree pane takes off its first ask - so no path can name a pane after the plumbing.
 */
const SESSION_WORDS = [
  'handoff', 'handoffs', 'handover', 'clear', 'clears', 'cleared', 'clearing',
  'compact', 'compacted', 'resume', 'resumed', 'resuming', 'continue', 'continues',
  'continued', 'continuing', 'context', 'session', 'sessions', 'chat', 'transcript',
  'transcripts', 'memory', 'summarise', 'summarize', 'summary', 'recap'
]

const TOPIC_STOP = new Set(
  (
    'hi hey okay also please pls can could would you your we our they them this that these those ' +
    'need needs needed want wanna think maybe just help lets let does did done doing what which ' +
    'when where why how there here from with without into onto about again still then than they ' +
    'make made makes making check checks checked look looks looked have has had been being will ' +
    'shall must some more most much many any all every each other another same thing things stuff ' +
    'good bad better best right wrong sure okay yeah yes not dont cant wont sorry thanks thank ' +
    'now today tomorrow yesterday really actually basically simply file files code stuff work ' +
    'working works worked run runs running fix fixes fixed add adds added change changes changed ' +
    'were able thats theyre youre gonna going already'
  ).split(' ').concat(SESSION_WORDS)
)

/** The words in one ask that could name a subject, in the order they were typed. */
export function topicKeywords(prompt: string): string[] {
  const line = prompt.trim()
  if (!line || line.startsWith('/')) return []
  const out: string[] = []
  for (const w of normalise(line).split(' ')) {
    if (w.length < 4 || /^\d+$/.test(w)) continue
    if (TOPIC_STOP.has(w) || DANGLING.test(w)) continue
    if (!out.includes(w)) out.push(w)
  }
  return out
}

/**
 * The title several asks agree on, or nothing.
 *
 * Nothing is the common answer and it is the point: a desk that jumps between subjects
 * keeps its folder name, which is the truest thing that can be written on that card.
 */
export function repeatedTopic(asks: string[]): string {
  const recent = asks.slice(-TOPIC_WINDOW)
  if (recent.length < TOPIC_MIN_ASKS) return ''
  const words = recent.map(topicKeywords)
  if (words.some((w) => w.length === 0)) {
    // A window holding an ask with no subject at all (`ok`, a pasted path) has not said
    // the same thing three times - it has said it twice with something else in between.
    if (words.filter((w) => w.length > 0).length < TOPIC_MIN_ASKS) return ''
  }
  const seen = new Map<string, number>()
  for (const w of words) for (const word of w) seen.set(word, (seen.get(word) ?? 0) + 1)
  const shared = new Set([...seen].filter(([, n]) => n >= TOPIC_MIN_ASKS).map(([w]) => w))
  if (!shared.size) return ''
  // The label is the SENTENCE the desk keeps coming back to, not the words it has in
  // common: `Invoice Reminders` reads like something a person would type on a card,
  // `Invoice` reads like a search term. The EARLIEST ask in the window is the one that
  // states the job - the later ones are follow-ups about a corner of it - so the phrase
  // comes off that one, and the repetition is only what earns the rename.
  for (let i = 0; i < recent.length; i++) {
    if (!words[i].some((w) => shared.has(w))) continue
    const phrase = topicTitle(recent[i], shared)
    if (phrase) return phrase
  }
  return ''
}

/** What a pane may call itself, and how much evidence is behind it. */
export interface TopicReading {
  /** the subject to write on the card, or '' for nothing */
  title: string
  /**
   * Did several asks agree on it?
   *
   * A first-ask phrase is one sentence read in a folder whose name says nothing - a
   * guess, good enough to replace `clients` and not good enough to replace a subject
   * already on the card. A repeated one is evidence: three of the last four asks about
   * the same thing are not a sentence about the work, they are the work.
   */
  strong: boolean
}

/**
 * The subject a pane should wear, given every ask it has taken and the newest one.
 *
 * The repeated reading is tried FIRST, in every folder. A pane in a client tree takes its
 * first ask because nothing else tells it apart, but once the desk has said the same
 * thing three times that is the better answer there too - and it is the only reading
 * allowed to replace a name the pane already earned.
 */
export function topicReading(cwd: string, asks: string[], text: string): TopicReading {
  const repeated = repeatedTopic(asks)
  if (repeated) return { title: repeated, strong: true }
  if (mayTopicName(cwd)) return { title: topicTitle(text), strong: false }
  return { title: '', strong: false }
}
