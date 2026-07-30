// Budgets, enforced rather than intended.
//
// Every leg of the pipeline has a cap and the cap is applied in code. The point is not
// frugality for its own sake: an improvement runs on a prompt that has not been sent yet
// and may never be, so it spends the user's plan on a maybe. A cap that lives only in the
// instructions is a cap the model decides.
//
// Token estimates are estimates. Nothing here needs a tokeniser: the numbers decide
// whether to truncate a context pack, not what to bill, and a 10% error in either
// direction changes nothing. ~3.8 characters per token is a reasonable figure for English
// prose mixed with code, and it is deliberately a slight UNDER-estimate of characters per
// token so the estimate errs high and truncates early.

export const CHARS_PER_TOKEN = 3.8

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export interface Budget {
  /** The whole improvement request, all legs together. */
  totalIn: number
  /** The user's draft, after the envelope. Over this, the draft is not improved at all. */
  draft: number
  /** Project context: stack, branch, memory, verify commands. */
  context: number
  /** Retrieved knowledge and capabilities. */
  knowledge: number
  /** The rules and the schema. Fixed text, measured so a rewrite cannot quietly grow. */
  instructions: number
  /** What the model may return. */
  out: number
}

/**
 * Three profiles, one per `optimise` setting.
 *
 * `tokens` is not simply "smaller". It cuts knowledge first and context second, because
 * those are the legs whose absence degrades an improvement gracefully - the model still
 * rewrites the draft, it just stops naming things. Cutting the draft budget instead would
 * mean refusing to improve longer prompts, which is the opposite of useful.
 */
/**
 * `instructions` is the same in all three because the rules are FIXED text sent on every
 * request - it is a ceiling on a constant, not a dial. Measured at 551 tokens for the
 * longest combination (a `design` task at `minimal` clarity); 600 is that plus enough
 * headroom for the `balanced` question policy, which is a little longer.
 * `prompt-improve-test.mjs` fails if a rewrite pushes past it, which is the only thing
 * stopping a paragraph that reads better from costing tokens on every request forever.
 */
export const BUDGETS: Record<'quality' | 'balanced' | 'tokens', Budget> = {
  quality: { totalIn: 4000, draft: 1600, context: 1000, knowledge: 900, instructions: 600, out: 900 },
  balanced: { totalIn: 2500, draft: 1200, context: 700, knowledge: 500, instructions: 600, out: 700 },
  tokens: { totalIn: 1400, draft: 700, context: 300, knowledge: 0, instructions: 600, out: 400 }
}

export function budgetFor(optimise: 'quality' | 'balanced' | 'tokens'): Budget {
  return BUDGETS[optimise] ?? BUDGETS.balanced
}

/** Cut text to a token budget, on a line boundary where one is close enough. */
export function fitTokens(text: string, tokens: number): string {
  const maxChars = Math.floor(tokens * CHARS_PER_TOKEN)
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n')
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()
}

/**
 * Collapse repeated context.
 *
 * The same fact reaching the prompt twice costs the budget twice and reads as two
 * independent sources. Line-level and case-insensitive, because the duplicates in
 * practice are a project fact restated by the memory file and by the stack fingerprint.
 */
export function dedupeLines(text: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of text.split('\n')) {
    const key = line.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!key) {
      // Keep blank lines as separators, but never two in a row.
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out.join('\n').trim()
}

/** What a single improvement cost, recorded for development metrics. */
export interface ImproveMetrics {
  originalTokens: number
  improvedTokens: number
  contextTokens: number
  knowledgeTokens: number
  knowledgeNotes: number
  ms: number
  questions: number
  taskType: string
  engine: string
  outcome: 'accepted' | 'rejected' | 'cancelled' | 'failed' | 'pending'
  secretsHeld: number
}
