// What the improver is allowed to hand back, and what may be typed into a live agent.
//
// This is the one file standing between the feature and a suggestion being typed into a
// real CLI with real tools in a real repository. Everything here is a refusal, and every
// refusal is a case in `prompt-insert-test.mjs`.
//
// The threat that is specific to PaneForge is not "the model says something silly". It is
// that the accepted text is *typed*, character by character, into an agent that acts on
// it. In Claude Code a line beginning `/` is a slash command and a line beginning `!` is
// a bash line. A stray `\r` submits. A paste-end marker closes the bracketed paste the
// payload is wrapped in and hands everything after it to the terminal as keys.
//
// So the draft reaches the model as data inside a labelled block, the model's answer is
// validated against a schema, and the string that reaches `write()` is what `sanitise()`
// returns or nothing at all.

export type TaskType =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'research'
  | 'design'
  | 'ops'
  | 'question'
  | 'other'

export const TASK_TYPES: readonly TaskType[] = [
  'feature',
  'bugfix',
  'refactor',
  'research',
  'design',
  'ops',
  'question',
  'other'
]

/** Hard ceiling, in code rather than by instruction. */
export const MAX_QUESTIONS = 3
export const MAX_IMPROVED_CHARS = 6000
export const MAX_ASSUMPTIONS = 4

export interface ImproveQuestion {
  /** <=80 chars. */
  question: string
  /** 2-4 concrete options. The user may always answer freely instead. */
  options: string[]
  /** One clause, only when the reason is not obvious. */
  why?: string
}

export interface Improvement {
  taskType: TaskType
  /** The improved draft. Never submitted; always shown first. */
  improved: string
  /** Reversible decisions taken instead of asking. One line each. */
  assumptions: string[]
  /** At most `MAX_QUESTIONS`, and only for information only the user has. */
  questions: ImproveQuestion[]
  /** What materially changed, in the model's words. Shown next to the diff. */
  changed: string[]
  /** Capability ids and note paths the brief drew on. Provenance, shown separately. */
  sources: string[]
}

export interface ValidationFailure {
  ok: false
  why: string
}
export type Validation<T> = { ok: true; value: T } | ValidationFailure

// Built from char codes rather than written as literals, for the reason `audit.ts` gives:
// an escape byte pasted into a source file is invisible to every later editor pass, and a
// regex nobody can see is a regex nobody can fix.
const ESC = String.fromCharCode(27)

/** Ctrl-U: empties a TUI agent's prompt box, and is offered back on Ctrl-Y. */
export const CTRL_U = String.fromCharCode(21)
/** Escape: empties a shell's line. Ctrl-U at a PowerShell prompt is a literal character. */
export const ESCAPE = ESC
export const PASTE_START = ESC + '[200~'
export const PASTE_END = ESC + '[201~'

const OSC = new RegExp(ESC + '\\][^\\u0007]*(?:\\u0007|' + ESC + '\\\\)', 'g')
const CSI = new RegExp(ESC + '[[\\]()#;?]*[0-9;?]*[ -/]*[@-~]', 'g')
const BARE_ESC = new RegExp(ESC, 'g')
/** Everything under space except \n, plus DEL. \r is normalised before this runs. */
const C0_EXCEPT_NEWLINE = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u007f]', 'g')
// With or without the ESC: the sequence is stripped of escapes first, so a payload
// carrying a bare "[201~" would otherwise survive and close the wrapper anyway.
const PASTE_MARKERS = new RegExp('\\u001b?\\[20[01]~', 'g')

/**
 * Make a model's text safe to type into a terminal, or refuse it.
 *
 * Order is deliberate. Escapes and control characters go first, so a leading `/` cannot be
 * hidden behind one and survive the prefix check below.
 */
export function sanitise(raw: string): Validation<string> {
  if (typeof raw !== 'string') return { ok: false, why: 'not a string' }

  const text = raw
    // CR and CRLF both become LF. `\r` is Enter, and Enter submits: nothing downstream is
    // allowed to depend on remembering that.
    .replace(/\r\n?/g, '\n')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(PASTE_MARKERS, '')
    .replace(BARE_ESC, '')
    .replace(C0_EXCEPT_NEWLINE, '')
    .trim()

  if (!text) return { ok: false, why: 'empty after sanitising' }
  if (text.length > MAX_IMPROVED_CHARS) {
    return { ok: false, why: `over ${MAX_IMPROVED_CHARS} characters` }
  }
  // Belt and braces. If either of these is ever true the transformations above have a
  // hole in them, and the right answer is to write nothing rather than to write this.
  if (text.includes('\r')) return { ok: false, why: 'contains a carriage return' }
  if (text.includes(ESC)) return { ok: false, why: 'contains an escape' }

  // A leading `/`, `!` or `#` is a command in at least one of the CLIs this can be typed
  // into. Refused rather than escaped: an improvement that has to start with one of those
  // is not an improvement to a prompt.
  const first = text.trimStart()[0]
  if (first === '/' || first === '!' || first === '#') {
    return { ok: false, why: `starts with ${first}, which a CLI reads as a command` }
  }

  return { ok: true, value: text }
}

/** One line of model text for the sheet. Never typed anywhere, but still rendered. */
export function sanitiseLine(s: string, max: number): string {
  return s
    .replace(/\r\n?/g, ' ')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(PASTE_MARKERS, '')
    .replace(BARE_ESC, '')
    .replace(C0_EXCEPT_NEWLINE, '')
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, max)
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max).trim() : ''
}

function strList(v: unknown, max: number, count: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => sanitiseLine(s, max))
    .filter(Boolean)
    .slice(0, count)
}

/**
 * Validate the model's JSON.
 *
 * A model that returns something unexpected produces a failure, never a repair. Repairing
 * is how a response that ignored half the rules becomes one that appears to have followed
 * them.
 */
export function parseImprovement(raw: unknown): Validation<Improvement> {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'not a JSON object' }
  const r = raw as Record<string, unknown>

  const improved = sanitise(str(r.improved, MAX_IMPROVED_CHARS + 1))
  if (!improved.ok) return improved

  const declared = str(r.taskType, 20)
  const taskType = (TASK_TYPES as readonly string[]).includes(declared)
    ? (declared as TaskType)
    : 'other'

  const questions: ImproveQuestion[] = Array.isArray(r.questions)
    ? (r.questions as unknown[])
        .map((q) => {
          if (!q || typeof q !== 'object') return null
          const o = q as Record<string, unknown>
          const question = sanitiseLine(str(o.question, 200), 80)
          if (!question) return null
          const options = strList(o.options, 60, 4)
          // Two options is the minimum that is a question rather than a prompt for prose.
          // Free text is available in the sheet regardless.
          if (options.length < 2) return null
          const why = sanitiseLine(str(o.why, 200), 100)
          return why ? { question, options, why } : { question, options }
        })
        .filter((q): q is ImproveQuestion => q !== null)
        .slice(0, MAX_QUESTIONS)
    : []

  return {
    ok: true,
    value: {
      taskType,
      improved: improved.value,
      assumptions: strList(r.assumptions, 160, MAX_ASSUMPTIONS),
      questions,
      changed: strList(r.changed, 120, 6),
      sources: strList(r.sources, 120, 8)
    }
  }
}

/**
 * Pull the JSON object out of whatever the CLI printed.
 *
 * These CLIs wrap output in banners, spinners and occasionally a fenced block. Scanning
 * for the outermost balanced braces is more reliable than asking for bare JSON and
 * trusting it, and it costs nothing when the answer really is bare JSON.
 */
export function extractJson(stdout: string): unknown {
  const text = stdout.replace(OSC, '').replace(CSI, '')
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text)
  const candidates = fence ? [fence[1], text] : [text]
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (escape) {
        escape = false
        continue
      }
      if (inString) {
        if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

/**
 * The exact byte stream that accepting an improvement writes to the pty.
 *
 * A function rather than three `write()` calls at the call site, so a test can assert on
 * the whole stream instead of on the intent behind it.
 *
 * `wipe` is the key that empties that CLI's prompt box - the same table `clearPane()`
 * uses, and for the same measured reason: Escape empties PowerShell's line but leaves
 * Claude Code's box alone, and Ctrl-U empties Claude Code's box but arrives at a
 * PowerShell prompt as a literal character.
 *
 * There is no `\r` in the return value and no code path that adds one. The user presses
 * Enter.
 */
export function insertSequence(
  text: string,
  agent: string
): { wipe: string; payload: string; error?: string } {
  const wipe = agent === 'shell' ? ESCAPE : CTRL_U
  const clean = sanitise(text)
  if (!clean.ok) return { wipe: '', payload: '', error: clean.why }
  return { wipe, payload: PASTE_START + clean.value + PASTE_END }
}
