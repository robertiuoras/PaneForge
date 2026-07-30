// What the improver is not allowed to see, and what it would waste the budget on.
//
// The draft may contain an API key, a private path, or four hundred lines of pasted
// source. All three are handled the same way: substitute a placeholder before the model
// runs, restore it byte-exact afterwards. The user's prompt keeps the value; the model
// never receives it.
//
// Precision over recall on secrets. A false positive costs one placeholder in a prompt
// the user reads before accepting. A false negative costs a key.
//
// `npm run test:redact` holds every detector and the round-trip.

export type HoldKind = 'secret' | 'code' | 'path'

export interface Hold {
  /** `«SECRET_1»` - what the model sees instead. */
  token: string
  kind: HoldKind
  /** The exact original text. Never leaves the device. */
  value: string
  /** What the model is told this is, e.g. "42 lines of TypeScript". Never the value. */
  label: string
}

export interface Envelope {
  /** Safe to send. */
  text: string
  holds: Hold[]
  counts: Record<HoldKind, number>
}

// Angle quotes rather than braces or brackets: a prompt is full of both, and a delimiter
// that also occurs in the content is a delimiter a model will invent halfway through.
const OPEN = '«'
const CLOSE = '»'
const TOKEN = new RegExp(OPEN + '(SECRET|CODE|PATH)_(\\d+)' + CLOSE, 'g')

/** Detectors, most specific first. Each is a whole-secret match, not a prefix. */
const SECRETS: Array<{ name: string; re: RegExp }> = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'github-fine', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // A Google key is `AIza` plus 35, but the length is matched as a range rather than
  // exactly: the `AIza` prefix is what carries the precision, and pinning the count means
  // a key that is one character off its documented length is a key that leaves.
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{30,45}/g },
  { name: 'slack', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'stripe', re: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { name: 'basic-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/g }
]

/**
 * `NAME=value` where the name reads like a credential and the value is long and random.
 *
 * Entropy as well as length because `DATABASE_URL=postgres://localhost:5432/dev` is
 * neither a secret nor random, and holding it back would cost the improver the one fact
 * it needed. 3.5 bits/char is roughly where prose ends and base64 begins.
 */
const ASSIGN = /\b([A-Z][A-Z0-9_]{2,})\s*[:=]\s*["']?([^\s"'`]{20,})["']?/g
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|SESSION|PRIVATE|SIGNING|ACCESS)/

export function shannon(s: string): number {
  if (!s) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** A fenced block, or an indented run, long enough that paraphrasing it is the point. */
const FENCE = /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g
const MIN_CODE_LINES = 15

/** An absolute path that names the machine or a folder outside the project. */
const WIN_PATH = /\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]*/g
const NIX_PATH = /(?:^|\s)(\/(?:Users|home|var|opt|etc|private)\/[^\s:;,'")]+)/g

function langOf(fence: string): string {
  const m = /^(?:```|~~~)([A-Za-z0-9+#._-]*)/.exec(fence)
  const raw = (m?.[1] ?? '').toLowerCase()
  const named: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript',
    js: 'JavaScript',
    jsx: 'JavaScript',
    py: 'Python',
    python: 'Python',
    rs: 'Rust',
    go: 'Go',
    sh: 'shell',
    bash: 'shell',
    ps1: 'PowerShell',
    powershell: 'PowerShell',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    sql: 'SQL',
    css: 'CSS',
    html: 'HTML'
  }
  return named[raw] ?? (raw || 'code')
}

export interface RedactOptions {
  /** Keep paths under this root as-is: they are the project the agent is already in. */
  projectPath?: string
  /** Elide fenced blocks longer than this. 0 disables code elision. */
  minCodeLines?: number
}

/**
 * Substitute everything that must not be sent, and hand back the map that puts it back.
 *
 * Order matters: secrets first, so a key inside a code block is still recorded as a
 * secret rather than swallowed by the block's placeholder and restored into a prompt the
 * user then reads as safe.
 */
export function envelope(text: string, options: RedactOptions = {}): Envelope {
  const holds: Hold[] = []
  const counts: Record<HoldKind, number> = { secret: 0, code: 0, path: 0 }
  let out = text

  const hold = (kind: HoldKind, value: string, label: string): string => {
    counts[kind] += 1
    const token = `${OPEN}${kind.toUpperCase()}_${counts[kind]}${CLOSE}`
    holds.push({ token, kind, value, label })
    return token
  }

  for (const { name, re } of SECRETS) {
    out = out.replace(re, (m) => hold('secret', m, name))
  }
  out = out.replace(ASSIGN, (m, name: string, value: string) => {
    if (!SECRETISH.test(name)) return m
    if (shannon(value) < 3.5) return m
    return m.slice(0, m.indexOf(value)) + hold('secret', value, `${name} value`)
  })

  const minLines = options.minCodeLines ?? MIN_CODE_LINES
  if (minLines > 0) {
    out = out.replace(FENCE, (block) => {
      const lines = block.split('\n').length - 2
      if (lines < minLines) return block
      return hold('code', block, `${lines} lines of ${langOf(block)}`)
    })
  }

  const inProject = (p: string): boolean => {
    const root = options.projectPath
    if (!root) return false
    const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    return norm(p).startsWith(norm(root))
  }
  out = out.replace(WIN_PATH, (m) => (inProject(m) ? m : hold('path', m, 'an absolute path')))
  out = out.replace(NIX_PATH, (m, p: string) =>
    inProject(p) ? m : m.replace(p, hold('path', p, 'an absolute path'))
  )

  return { text: out, holds, counts }
}

/** Put every placeholder back, byte for byte. */
export function restore(text: string, holds: Hold[]): string {
  const byToken = new Map(holds.map((h) => [h.token, h.value]))
  return text.replace(TOKEN, (m) => byToken.get(m) ?? m)
}

/**
 * Did the model hand back exactly the placeholders it was given?
 *
 * Both directions are failures and both are cheap to check. A DROPPED placeholder means
 * the improved prompt silently lost the user's key or their code. An INVENTED one means
 * the model wrote `«SECRET_9»` out of nowhere, and restoring it is a no-op that leaves a
 * strange token in a prompt about to be typed into an agent.
 */
export function placeholdersMatch(
  improved: string,
  holds: Hold[]
): { ok: boolean; dropped: string[]; invented: string[] } {
  const given = new Set(holds.map((h) => h.token))
  const found = new Set<string>()
  for (const m of improved.matchAll(TOKEN)) found.add(m[0])
  const dropped = [...given].filter((t) => !found.has(t))
  const invented = [...found].filter((t) => !given.has(t))
  return { ok: dropped.length === 0 && invented.length === 0, dropped, invented }
}

/**
 * A one-line description of what was held back, for the sheet.
 *
 * Counts, never values - this string is also what the audit log is allowed to record.
 */
export function heldSummary(counts: Record<HoldKind, number>): string {
  const parts: string[] = []
  if (counts.secret) parts.push(`${counts.secret} secret${counts.secret > 1 ? 's' : ''}`)
  if (counts.code) parts.push(`${counts.code} code block${counts.code > 1 ? 's' : ''}`)
  if (counts.path) parts.push(`${counts.path} path${counts.path > 1 ? 's' : ''}`)
  return parts.length ? `held back: ${parts.join(', ')}` : ''
}

/**
 * Does this text look like it still carries a live credential?
 *
 * Used on anything about to be written to the audit log or to telemetry, where the answer
 * has to be "refuse" rather than "substitute": a log line is not read before it is kept.
 */
export function looksSecret(text: string): boolean {
  for (const { re } of SECRETS) {
    re.lastIndex = 0
    if (re.test(text)) return true
  }
  ASSIGN.lastIndex = 0
  for (const m of text.matchAll(ASSIGN)) {
    if (SECRETISH.test(m[1]) && shannon(m[2]) >= 3.5) return true
  }
  return false
}
