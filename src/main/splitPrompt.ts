// Running an agent CLI once, headlessly, to read a long ask into panes.
//
// This is the only place in the app that starts an agent OUTSIDE a pane. Everything about
// it is written to be refusable: a CLI with no headless flag is named and refused rather
// than launched with a guess, the run has a budget, and an answer that is not a plan is
// `null` - never an empty plan, which is a different, real answer ("this is one job").
//
// The flags are keyed by agent id and are deliberately short: `HEADLESS` here holds only
// the CLIs measured answering a one-shot prompt on a subscription login. Grok is absent
// for the reason it is absent from `shared/agents.ts`' own headless table - its flags are
// unverified, and refusing beats a guess that opens a window nobody asked for.

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { specFor } from './agents'
import { getConfig } from './config'
import { resolveEnv } from '../shared/agents'
import { parseSplit, splitInstruction, MAX_TASKS, type SplitAnswer } from '../shared/splitPlan'
import { loadTemplate } from './promptForge'
import { which } from './which'

/**
 * How each CLI is asked one question with no TUI. The prompt is appended as one arg.
 *
 * Claude Code's flags carry the thing this feature could not work without: a headless run
 * started from this machine loads the DESK's own settings - its hooks, its output style,
 * its CLAUDE.md. Measured here, the first working split answered `Noted. Next reply
 * shorter.`, which is this user's reply-length Stop hook answering on the model's behalf.
 * `--settings` with empty hooks and the default style is what makes the answer be about
 * the prompt; `--strict-mcp-config` keeps a dozen MCP servers from being started for a
 * question that needs no tools. The login stays in `~/.claude`, which is why this is NOT
 * done with `CLAUDE_CONFIG_DIR` - pointing that elsewhere answers `Not logged in`.
 */
const HEADLESS: Record<string, string[]> = {
  claude: ['-p', '--strict-mcp-config', '--settings', '{"hooks":{},"outputStyle":"default"}'],
  codex: ['exec']
}

/**
 * How long a split may take.
 *
 * Measured on this machine at 12-24s for a six-part ask. Two minutes is the point past
 * which the answer has stopped being worth waiting for with a dialog open - and the
 * budget exists at all because a CLI waiting for an auth prompt nobody can see never
 * returns on its own.
 */
export const SPLIT_BUDGET_MS = 120_000

/**
 * Which INSTALLED agent can answer a split, given the one Settings prefers.
 *
 * The preference is a preference: a desk defaulted to a CLI with no headless mode still
 * gets a split, from one that has both the mode and a binary on this machine. `installed`
 * is passed in rather than probed here so the decision is testable without a PATH.
 */
export function splitAgent(preferred: string | undefined, installed: (id: string) => boolean): string | null {
  if (preferred && HEADLESS[preferred] && installed(preferred)) return preferred
  return Object.keys(HEADLESS).find((id) => installed(id)) ?? null
}

/** Is this agent's binary on this machine? */
function onDisk(id: string): boolean {
  try {
    which(specFor(id).bin)
    return true
  } catch {
    return false
  }
}

/** An empty folder under userData for the headless run to start in. See the call below. */
function quietDir(): string {
  const dir = join(app.getPath('userData'), 'split')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Ask an agent to break `text` into panes.
 *
 * Nothing in the answer is executed: it is parsed as JSON and drawn as rows somebody has
 * to read and press.
 */
export async function splitPrompt(text: string): Promise<SplitAnswer> {
  const body = text.trim()
  if (!body) return { error: 'Nothing to split.' }
  const cfg = getConfig()
  const id = splitAgent(cfg.defaultAgent, onDisk)
  if (!id) return { error: 'No installed agent can answer a split on its own.' }
  const spec = specFor(id)
  let bin: string
  try {
    bin = which(spec.bin)
  } catch {
    return { error: `${spec.label} is not installed on this machine.` }
  }
  // The exemplar comes from Robert's own library on disk. `multi-item-opener` is the
  // template for exactly this shape - several unrelated asks in one message - and about
  // half his openers are one. A machine with no promptlib gets the built-in copy, which
  // carries the judgement and no example; nothing about the split depends on it.
  const args = [
    ...(spec.alwaysArgs ?? []),
    ...HEADLESS[id],
    splitInstruction(body, MAX_TASKS, loadTemplate('multi-item-opener'))
  ]
  const raw = await new Promise<{ out: string; err?: string }>((resolve) => {
    execFile(
      bin,
      args,
      {
        // An EMPTY folder, deliberately, and not the project the ask is about. A headless
        // run loads the settings and the CLAUDE.md of the directory it starts in, and this
        // desk's project hooks answered the split for it - twice, with `Noted - next reply
        // shorter.`, which is a reply-length Stop hook talking. `--settings` covers the
        // user-level file and cannot cover a project one, so the folder is the fix. The
        // split reads only the text it is given; it needs no repo.
        cwd: quietDir(),
        timeout: SPLIT_BUDGET_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...resolveEnv(spec, cfg.providerKeys ?? {}) },
        windowsHide: true
      },
      (err, stdout, stderr) => {
        // A non-zero exit with usable output is still an answer: several CLIs exit 1 on a
        // warning they printed to stderr. The parser is what decides, not the exit code.
        if (err && !stdout.trim()) resolve({ out: '', err: stderr.trim() || err.message })
        else resolve({ out: stdout })
      }
    )
  })
  if (!raw.out.trim()) return { error: raw.err || `${spec.label} answered nothing.` }
  const plan = parseSplit(raw.out, MAX_TASKS)
  // The head of what it DID say, because "not a plan" on its own is unactionable: the two
  // real causes look nothing alike on screen (a refusal sentence, or this desk's own hooks
  // answering for it) and the first 160 characters separate them.
  if (!plan)
    return {
      error: `${spec.label} did not answer with a plan: ${raw.out.trim().slice(0, 160)}`
    }
  return plan
}
