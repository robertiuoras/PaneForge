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

/**
 * How a word is SPELLED once it reaches a card.
 *
 * An acronym title-cased by the generic rule reads as a misspelling - `Gpt`, `Api`, `Ghl`
 * - and a product with a capital inside it loses it (`Hubspot`, `Openai`). Both are
 * things the reader knows the shape of, so getting them wrong is the loudest possible
 * way to look automated.
 */
const SPELLING: Record<string, string> = {
  api: 'API', apis: 'APIs', ui: 'UI', ux: 'UX', cli: 'CLI', css: 'CSS', html: 'HTML',
  url: 'URL', urls: 'URLs', pdf: 'PDF', csv: 'CSV', json: 'JSON', sql: 'SQL', db: 'DB',
  ai: 'AI', gpt: 'GPT', llm: 'LLM', mcp: 'MCP', ssh: 'SSH', dns: 'DNS', ssl: 'SSL',
  seo: 'SEO', crm: 'CRM', ghl: 'GHL', cdp: 'CDP', ram: 'RAM', cpu: 'CPU', gpu: 'GPU',
  ios: 'iOS', macos: 'macOS', npm: 'npm', ci: 'CI', qr: 'QR', sms: 'SMS', otp: 'OTP',
  openai: 'OpenAI', hubspot: 'HubSpot', paneforge: 'PaneForge', taskdriver: 'Taskdriver',
  supabase: 'Supabase', vercel: 'Vercel', github: 'GitHub', gitlab: 'GitLab',
  mailchimp: 'Mailchimp', telegram: 'Telegram', discord: 'Discord', upwork: 'Upwork',
  zapier: 'Zapier', stripe: 'Stripe', shopify: 'Shopify', wordpress: 'WordPress',
  wix: 'Wix', canva: 'Canva', notion: 'Notion', slack: 'Slack', gmail: 'Gmail',
  whatsapp: 'WhatsApp', linkedin: 'LinkedIn', youtube: 'YouTube', tiktok: 'TikTok',
  instagram: 'Instagram', facebook: 'Facebook', meta: 'Meta', google: 'Google',
  claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', toolstash: 'Toolstash',
  safari: 'Safari', chrome: 'Chrome', electron: 'Electron', react: 'React',
  nextjs: 'Next.js', node: 'Node', python: 'Python', docker: 'Docker', launchd: 'launchd'
}

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
    // An acronym title-cased by the generic rule reads as a misspelling - `Api`, `Gpt`,
    // `Ghl` - and a product loses the capital inside it (`Hubspot`, `Openai`). Both are
    // shapes the reader knows, so getting them wrong is the loudest way to look automated.
    .map((w) => SPELLING[w] ?? w[0].toUpperCase() + w.slice(1))
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
 * The client several asks agree a pane is for, when the evidence is words somebody TYPED
 * rather than the folder the pane is in.
 *
 * A name lifted out of a sentence is inference - one
 * mention of a word that happens to match a client's alias is not evidence about what a
 * pane is FOR. "we need to tune the naming of session as well, broken like Cars" named a
 * PaneForge pane `Cars` off a single prompt, because the word appeared once inside a
 * sentence ABOUT naming rules, so a client read out of typing needs the same client named
 * again inside the last few asks. The FOLDER is exempt - `clientFromPath`
 * is a fact about where the pane runs, never a guess about what somebody typed - so this
 * only ever gates `clientFromText`.
 */
export function repeatedClient(asks: string[], roster: ClientEntry[]): ClientEntry | undefined {
  const recent = asks.slice(-ASK_WINDOW)
  if (recent.length < CLIENT_MIN_ASKS) return undefined
  const seen = new Map<string, number>()
  for (const a of recent) {
    const c = clientFromText(a, roster)
    if (c) seen.set(c.slug, (seen.get(c.slug) ?? 0) + 1)
  }
  const slug = [...seen].find(([, n]) => n >= CLIENT_MIN_ASKS)?.[0]
  return slug ? roster.find((c) => c.slug === slug) : undefined
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

/** The title a client gets, capped the way `rename` caps it. */
export function clientTitle(entry: ClientEntry): string {
  return entry.name.trim().slice(0, MAX_TITLE)
}

/**
 * The client's name AND the fact that they are a client - `Alison | clients`.
 *
 * `clientTitle` on its own is a person's name on a card, and a desk with six panes on it
 * gives no clue which of them is client work: Robert, 2026-09-04, "alison | clients would
 * popup so i know that its part of clients ... and auto renames the session from client to
 * that alison | clients". The second half is the roster folder's own name, so it says
 * where the work lives as well as who it is for.
 */
export function clientLabel(entry: ClientEntry): string {
  return `${clientTitle(entry)} | ${CLIENTS_DIR}`.slice(0, MAX_TITLE)
}

/**
 * How many asks must name the same client before a pane at the roster's ROOT is renamed
 * for them. One mention of a word that happens to match a client is not evidence: see
 * `repeatedClient`.
 */
export const CLIENT_MIN_ASKS = 2

/** How many recent asks are looked at, so a client that has moved on stops matching. */
export const ASK_WINDOW = 4
