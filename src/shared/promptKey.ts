// Whether two prompts are the same ask.
//
// "fix the githublinks pagination bug" and "the githublinks pagination is broken, fix it"
// have to answer yes. Filler, word order and punctuation are noise; the nouns are the ask.
//
// ─── this file is a MIRROR, and that is deliberate ──────────────────────────────────────
//
// The same algorithm already exists, byte-for-byte, in three places outside this repo:
// Robert's `claude-memory/claude-config/prompt-key.mjs` (the Claude Code hook), the
// TaskDriver archive server, and the Discord bot that files prompts posted in his channels.
// Those three share one archive, and if any copy drifts the archive silently splits into
// separate archives that never see each other's entries.
//
// PaneForge is a fourth copy, and it is a copy rather than an import because the app ships
// to people who have none of that: the feature has to work with nothing but its own local
// history. `npm run test:promptkey` pins it — it computes both this file's answers and the
// canonical `prompt-key.mjs`'s answers over the same corpus and asserts they agree, and it
// SKIPS OUT LOUD when that file is not on the machine, rather than passing quietly and
// letting the two drift apart unobserved.
//
// Everything here is pure and dependency-free on purpose: the renderer imports it to score a
// draft as it is typed, and `node:crypto` cannot cross into the renderer bundle. Hashing —
// the one part that needs crypto — lives in `main/promptArchive.ts` instead.

const STOPWORDS = new Set([
  'a','about','actually','add','after','again','all','also','am','an','and','any',
  'are','as','at','back','be','because','been','before','being','below','between',
  'both','but','by','can','cant','could','did','do','does','doing','dont','down',
  'during','each','even','few','first','for','from','further','get','got','had',
  'has','have','having','he','her','here','hers','him','his','how','i','if','im',
  'in','into','is','it','its','itself','just','know','let','like','ll','make',
  'maybe','me','might','more','most','much','must','my','need','needs','no','nor',
  'not','now','of','off','on','once','only','or','other','otherwise','ought','our',
  'ours','out','over','own','please','really','re','said','same','see','she',
  'should','simply','so','some','still','such','sure','than','that','the','their',
  'theirs','them','then','there','these','they','thing','things','this','those',
  'through','to','too','try','under','until','up','us','use','used','using','ve',
  'very','want','was','way','we','were','what','when','where','which','while',
  'who','whom','why','will','with','would','you','your','yours','yourself'
])

/**
 * Strip everything that is chrome rather than ask.
 *
 * Code fences and paths go because a prompt that quotes a stack trace is still the same ask
 * as one that describes it, and a path left in survives as a run of tokens that makes two
 * unrelated prompts about the same repo look alike. The Discord-shaped rules (mentions,
 * channel refs, custom emoji, `<t:…>` stamps, `-#` subtext) are here for the same reason
 * they are in the canonical copy: a snowflake id survives `[^a-z0-9]` as a numeric token, so
 * two unrelated prompts that both ping the same person would score as related.
 */
function stripNoise(input: string): string {
  return String(input || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^[ \t]*-#[ \t].*$/gm, ' ')
    .replace(/<(?:@[!&]?|#)\d+>/g, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/<t:\d+(?::[tTdDfFR])?>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[a-z]:\\[^\s"']+/gi, ' ')
    .replace(/\/[\w.-]+\/[\w./-]+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
}

/**
 * Crude suffix stemmer. Enough to collapse paginate/pagination/paginated and link/links, and
 * deliberately not a real Porter stemmer: the cost of a wrong stem here is a missed match,
 * which shows nothing, not a wrong answer, which would show the wrong prior work.
 */
function stem(w: string): string {
  // Longest suffixes first, and the whole -ate family together, so
  // paginate/paginated/paginating/pagination all land on the same root.
  if (w.length > 6 && w.endsWith('ation')) return w.slice(0, -5)
  if (w.length > 6 && w.endsWith('ating')) return w.slice(0, -5)
  if (w.length > 6 && w.endsWith('ated')) return w.slice(0, -4)
  if (w.length > 5 && w.endsWith('ate')) return w.slice(0, -3)
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Significant tokens: stemmed, sorted, uniqued, stopwords and 1-char noise dropped. */
export function promptTokens(input: string): string[] {
  const seen = new Set<string>()
  for (const t of stripNoise(input).split(' ')) {
    if (t.length < 2) continue
    if (STOPWORDS.has(t)) continue
    const s = stem(t)
    if (STOPWORDS.has(s)) continue
    seen.add(s)
  }
  return [...seen].sort()
}

/** Jaccard overlap of two token sets, 0..1. */
export function promptSimilarity(a: string[], b: string[]): number {
  if (!a?.length || !b?.length) return 0
  const setB = new Set(b)
  let shared = 0
  for (const t of new Set(a)) if (setB.has(t)) shared++
  const union = new Set([...a, ...b]).size
  return union ? shared / union : 0
}

// Jaccard alone is too strict for a real reword: "fix the githublinks pagination bug" vs
// "the githublinks pagination is broken, fix it" shares 3 of 5 tokens = 0.60, and loosening
// the Jaccard threshold to catch that starts matching unrelated work in the same repo. The
// three tests together are what separate them:
//   containment — how much of the SHORTER prompt the longer one covers
//   jaccard     — guards against a 3-word ask matching an essay
//   shared      — an absolute floor, so two tiny prompts cannot hit 1.0
const MIN_CONTAINMENT = 0.7
const MIN_JACCARD = 0.4
const MIN_SHARED = 3

// Counting every token as equally informative is what makes an unweighted score blunt: "fix
// the discord bot deploy" and "the discord bot deploy is slow" share three tokens that
// appear in half the archive, so they score the same as two prompts sharing three RARE
// tokens. Given a corpus, promptTokenIdf() scores a token by how rare it is and
// promptMatchWeighted() spends the containment/jaccard budget accordingly.
//
// A token the corpus has never seen is treated as rare but not infinitely so; a fixed value
// keeps the score stable as the archive grows.
const UNSEEN_WEIGHT = 2
const MIN_TOKEN_WEIGHT = 0.25

/**
 * token -> inverse document frequency over a corpus of token arrays. Pass the result to
 * promptMatchWeighted() as its third argument.
 */
export function promptTokenIdf(corpus: string[][]): Map<string, number> {
  const docs = Array.isArray(corpus) ? corpus : []
  const df = new Map<string, number>()
  for (const tokens of docs) {
    for (const t of new Set(tokens || [])) df.set(t, (df.get(t) || 0) + 1)
  }
  const total = docs.length || 1
  const idf = new Map<string, number>()
  for (const [t, count] of df) {
    // Floored rather than allowed to reach 0: a token every prompt shares is weak evidence,
    // not zero evidence.
    idf.set(t, Math.max(MIN_TOKEN_WEIGHT, Math.log((total + 1) / (count + 0.5))))
  }
  return idf
}

function tokenWeight(weights: Map<string, number> | null, token: string): number {
  if (!weights) return 1
  const w = weights.get(token)
  return typeof w === 'number' && w > 0 ? w : UNSEEN_WEIGHT
}

/**
 * Match score for the "have we done this before" lookup: the containment figure when the
 * pair clears all three tests, otherwise 0.
 *
 * `weights` is optional. Omitted (or null) every token counts 1, which is exactly
 * promptMatch() — that equivalence is what lets the copies of this file be compared against
 * each other.
 */
export function promptMatchWeighted(
  a: string[],
  b: string[],
  weights: Map<string, number> | null
): number {
  if (!a?.length || !b?.length) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let shared = 0
  let sharedWeight = 0
  let weightA = 0
  let weightB = 0
  for (const t of setA) {
    const w = tokenWeight(weights, t)
    weightA += w
    if (setB.has(t)) {
      shared++
      sharedWeight += w
    }
  }
  for (const t of setB) weightB += tokenWeight(weights, t)
  if (shared < MIN_SHARED) return 0
  const smaller = Math.min(weightA, weightB)
  const containment = smaller ? sharedWeight / smaller : 0
  const union = weightA + weightB - sharedWeight
  const jaccard = union ? sharedWeight / union : 0
  if (containment < MIN_CONTAINMENT || jaccard < MIN_JACCARD) return 0
  return containment
}

/** Unweighted match — every token equally informative. */
export function promptMatch(a: string[], b: string[]): number {
  return promptMatchWeighted(a, b, null)
}

// ─── the thresholds the feature itself acts on ─────────────────────────────────────────
//
// Separate from the maths above because they are a product decision, not an algorithm: what
// score is worth interrupting someone over.

/** Fewer significant tokens than this is conversational filler — "yes do it", "continue",
    "ok now the other one". Scoring those would match everything and warn about nothing. */
export const MIN_PROMPT_TOKENS = 4

/** Worth showing as "you have asked something like this". */
export const NEAR_MATCH = 0.7

/** Confident enough to call it the same ask outright. */
export const STRONG_MATCH = 0.85

/**
 * A repeat inside this window is the SAME piece of work — a retry, a follow-up, a reworded
 * second go at something that just failed. Warning there is pure noise, and it is the case
 * that would make people turn the feature off.
 */
export const QUIET_MS = 6 * 60 * 60 * 1000

/** How much rarity weighting needs before it helps rather than hurts. Below this the corpus
    is too small for "rare" to mean anything and every shared token looks common. */
export const IDF_MIN_CORPUS = 25
