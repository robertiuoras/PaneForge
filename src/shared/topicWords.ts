// Which words of an ask are the ask, and how they are spelled on a card.
//
// `clientName.ts` used to name a pane from the first words of a sentence, which works
// only for a sentence that opens on its subject. Robert's asks do not: they open on
// `cacan u see`, `do u have access to both`, `im clicking on teh`, and the thing the
// session is actually about arrives four or five words in. Naming from the front gave
// `Cacan See Hubspot Api`, `Access To Both Hello` and `Clicking On Teh Gpt` - the shape
// of the typing, never the work.
//
// So the words are SCORED rather than counted off. What survives is what a person would
// have underlined: the product, the system, the thing with a name. Word order is then put
// back, because `Billing API OpenAI` is not English either.
//
// Nothing here is a model or a request. It is a lexicon, a typo table and arithmetic, on
// the same contract as the rest of the naming - see `shared/gist.ts`.

/**
 * How a word is SPELLED once it reaches a card.
 *
 * An acronym title-cased by the generic rule reads as a misspelling - `Gpt`, `Api`, `Ghl`
 * - and a product with a capital inside it loses it (`Hubspot`, `Openai`). Both are
 * things the reader knows the shape of, so getting them wrong is the loudest possible
 * way to look automated.
 */
export const SPELLING: Record<string, string> = {
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

/**
 * Words that NAME something: a product, a system, a surface with an owner.
 *
 * A word in here outranks every ordinary noun in the sentence, because it is the half of
 * the ask a person would repeat when telling somebody else what they were doing.
 */
const NAMES = new Set([
  ...Object.keys(SPELLING),
  'invoice', 'invoices', 'quote', 'quotes', 'receipt', 'proposal', 'proposals', 'contract',
  'tax', 'billing', 'payment', 'payments', 'payout', 'refund', 'subscription', 'pricing',
  'lead', 'leads', 'client', 'clients', 'customer', 'contact', 'contacts', 'campaign',
  'campaigns', 'ads', 'ad', 'newsletter', 'email', 'emails', 'inbox', 'draft', 'drafts',
  'webhook', 'webhooks', 'endpoint', 'token', 'tokens', 'auth', 'login', 'signin',
  'password', 'credentials', 'quota', 'limit', 'limits', 'egress', 'usage', 'cost',
  'costs', 'budget', 'bot', 'agent', 'agents', 'cron', 'scheduler', 'queue', 'dispatcher',
  'pipeline', 'workflow', 'workflows', 'hook', 'hooks', 'lane', 'lanes', 'pane', 'panes',
  'session', 'dashboard', 'sidebar', 'statusline', 'composer', 'transcript', 'scrollback',
  'release', 'build', 'builds', 'deploy', 'installer', 'updater', 'migration', 'schema',
  'database', 'backup', 'backups', 'server', 'tunnel', 'proxy', 'cache', 'index',
  'search', 'history', 'backlog', 'ledger', 'todo', 'todos', 'checklist', 'board',
  'calendar', 'meeting', 'call', 'onboarding', 'verification', 'report', 'analytics',
  'screenshot', 'screenshots', 'video', 'image', 'images', 'logo', 'brand', 'theme',
  'button', 'buttons', 'card', 'cards', 'modal', 'dialog', 'page', 'pages', 'form',
  'table', 'chart', 'menu', 'header', 'footer', 'layout', 'font', 'colour', 'color',
  'prompt', 'prompts', 'model', 'models', 'memory', 'skill', 'skills', 'naming'
])

/**
 * How Robert actually types, so a card is not named after the mistake.
 *
 * Only spellings SEEN in this machine's own prompt history are in here. A general
 * spell-checker would need a dictionary and would still have to guess which correction
 * was meant; a table of the ones that have really happened cannot guess wrong.
 */
export const TYPOS: Record<string, string> = {
  cacan: 'can', teh: 'the', hte: 'the', taht: 'that', waht: 'what', nad: 'and',
  adn: 'and', anaylse: 'analyse', anaylze: 'analyse', analyse: 'analyse',
  genearted: 'generated', becuase: 'because', relaly: 'really', evry: 'every',
  instaed: 'instead', quicky: 'quickly', slighlty: 'slightly', wiht: 'with',
  recieve: 'receive', seperate: 'separate', assitant: 'assistant', sesion: 'session',
  sesison: 'session', sessino: 'session', promt: 'prompt', promts: 'prompts',
  serch: 'search', reserch: 'research', mispelt: 'misspelt', effiicent: 'efficient',
  intergration: 'integration', calender: 'calendar', langauge: 'language',
  defualt: 'default', lenght: 'length', widht: 'width', recomended: 'recommended',
  succesful: 'successful', occured: 'occurred', seprate: 'separate', alot: 'a lot',
  u: 'you', ur: 'your', r: 'are', pls: 'please', plz: 'please', tho: 'though',
  thru: 'through', cuz: 'because', wanna: 'want', gonna: 'going'
}

/** The typed word, spelled the way it was meant. */
export function repair(word: string): string {
  return TYPOS[word] ?? word
}

/**
 * Words that are in every ask on the desk, so they separate nothing.
 *
 * Wider than the clause-cutting lists in `clientName.ts`, because this one is asked about
 * every word rather than only the ones at the front: `properly`, `immediately` and
 * `sometimes` are real English and still say nothing about which session this is.
 */
const EMPTY = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'if', 'then', 'than', 'that', 'this',
  'these', 'those', 'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'do', 'does', 'did', 'done', 'doing', 'have', 'has', 'had', 'having',
  'can', 'could', 'would', 'should', 'shall', 'will', 'may', 'might', 'must',
  'i', 'im', 'ive', 'you', 'your', 'youre', 'we', 'weve', 'were', 'our', 'us', 'me',
  'my', 'they', 'them', 'their', 'theyre', 'he', 'she', 'his', 'her',
  'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'without', 'into', 'onto',
  'about', 'around', 'over', 'under', 'up', 'out', 'off', 'by', 'as', 'via',
  'not', 'no', 'yes', 'cant', 'wont', 'dont', 'didnt', 'doesnt', 'isnt', 'arent',
  'havent', 'hasnt', 'wasnt', 'werent', 'shouldnt', 'couldnt', 'wouldnt', 'idea', 'ideas', 'yeah', 'okay', 'ok', 'please', 'thanks', 'thank', 'sorry',
  'just', 'really', 'actually', 'basically', 'simply', 'very', 'too', 'quite', 'bit',
  'also', 'even', 'still', 'again', 'already', 'now', 'today', 'yesterday', 'tomorrow',
  'here', 'there', 'where', 'when', 'why', 'how', 'what', 'which', 'who', 'whose',
  'all', 'any', 'some', 'every', 'each', 'both', 'other', 'another', 'same', 'more',
  'most', 'much', 'many', 'few', 'less', 'least', 'lot', 'enough', 'only', 'own',
  'thing', 'things', 'stuff', 'something', 'anything', 'everything', 'nothing',
  'want', 'wants', 'need', 'needs', 'like', 'likes', 'think', 'know', 'see', 'seen',
  'look', 'looking', 'looks', 'make', 'makes', 'made', 'get', 'gets', 'got', 'give',
  'take', 'takes', 'go', 'goes', 'going', 'come', 'let', 'lets', 'help', 'try',
  'good', 'bad', 'better', 'best', 'worse', 'worst', 'right', 'wrong', 'sure',
  'whats', 'current', 'whole', 'entire', 'proper', 'properly', 'correctly', 'well', 'different',
  // A SYMPTOM is not a subject. `fix issue with this remote screen looking weird` is
  // about the remote screen; `weird` is how it announced itself and belongs in the ask,
  // not on the card - which already reads `Fixing`.
  'broken', 'breaks', 'breaking', 'weird', 'wrong', 'slow', 'stuck', 'missing', 'glitchy',
  'laggy', 'buggy', 'failing', 'fails', 'failed', 'crashing', 'crashes',
  // Words for SAYING, which every ask is made of.
  'say', 'says', 'said', 'tell', 'tells', 'show', 'shows', 'showing', 'mean', 'means',
  'immediately', 'sometimes', 'always', 'never', 'often', 'maybe', 'perhaps',
  'while', 'until', 'after', 'before', 'because', 'since', 'though', 'although',
  'through', 'between', 'against', 'per', 'else', 'etc', 'one', 'two', 'first', 'last'
])

/** Is this word worth nothing on a card, whatever else is in the sentence? */
export function isEmpty(word: string): boolean {
  return EMPTY.has(word)
}

/**
 * How much this word tells a reader which session they are looking at.
 *
 * The ladder is what somebody would underline: a NAME first (a product, a system, a
 * document type), then a word the ask came back to, then simply a long word - a long word
 * is a specific one, which is why `verification` outranks `code`. Zero means it would
 * never have been underlined.
 */
export function weigh(word: string, seen: ReadonlyMap<string, number>): number {
  if (word.length < 2 || isEmpty(word)) return 0
  // Any word that is not filler starts at one, so a plain noun is still KEPT when there
  // is room for it - `check the rental car booking` must stay `Rental Car Booking`, and
  // `car` is three letters with no lexicon entry. The ladder below decides which words
  // survive a sentence too long for the card, not which words are allowed on it.
  let score = 1
  if (NAMES.has(word)) score += 5
  // A word carrying a digit is a version, an id or an amount - always specific.
  if (/\d/.test(word)) score += 3
  // A word the ask used more than once is the one it is ABOUT: `supabase is over limit
  // again same as before ... supabase egress` says supabase twice and `again` once.
  if ((seen.get(word) ?? 0) > 1) score += 2
  if (word.length >= 9) score += 2
  else if (word.length >= 6) score += 1
  return score
}

/** A word that finishes the verb in front of it rather than starting a new idea. */
const PARTICLE = new Set(['up', 'out', 'off', 'down', 'in', 'on', 'over', 'through'])

/**
 * The best `max` words of an ask, back in the order they were typed.
 *
 * Order is restored because a name is read as English: `openai billing api` is the phrase
 * somebody would say out loud, `api billing openai` is a scoring table with a capital
 * letter on it. Ties keep the earlier word, so an ask that opens on its subject is
 * unchanged - which is what keeps the sentences that were already fine already fine.
 */
export function pick(words: readonly string[], pool: readonly string[], max: number): string[] {
  const seen = new Map<string, number>()
  for (const w of pool) seen.set(w, (seen.get(w) ?? 0) + 1)
  const scored = words.map((w, i) => ({ w, i, s: weigh(w, seen) })).filter((x) => x.s > 0)
  if (!scored.length) return []
  const best = [...scored].sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max)
  best.sort((a, b) => a.i - b.i)
  // A particle sitting BETWEEN two kept words belongs to the one in front of it: `sort out
  // invoice reminders` is a phrase, `Sort Invoice Reminders` is the same phrase with a
  // hole in it. Only inside the picked range, so a trailing `for me` cannot come back.
  const out: string[] = []
  for (let k = 0; k < best.length; k++) {
    out.push(best[k].w)
    const next = best[k + 1]
    if (next && next.i === best[k].i + 2 && PARTICLE.has(words[best[k].i + 1]))
      out.push(words[best[k].i + 1])
  }
  return out
}
