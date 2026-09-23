// Reading a rough ask into a full brief - see `shared/promptExpand.ts` for the part that
// must not depend on the model behaving. This file is the part that does: it runs the
// model, walks the code for a place to start, and shares one run between the speculative
// call a pane makes while Robert is still typing and the one it makes the moment he
// presses Enter - which is the whole reason the wait on the card is ever short.
//
// Nothing here is executed. The model's answer is parsed by `parseExpansion`, drawn as
// text a person reads, and sent only when a button is pressed.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import { specFor } from './agents'
import { getConfig, projectsRoot } from './config'
import { resolveEnv } from '../shared/agents'
import {
  BUNDLED_ITEMS,
  keywordsOf,
  parseExpansion,
  readWhere,
  scopeOf,
  shouldExpand,
  whereFromFiles,
  wordCount,
  expandArgs,
  EXPAND_WAIT_MS,
  type ExpandAnswer,
  type ExpandChoice,
  type ExpandWhere
} from '../shared/promptExpand'
import { HEADLESS, onDisk, runHeadless } from './headless'
import { which } from './which'

/** How long the code search may take, walking the repo for a place to start. */
const WHERE_BUDGET_MS = 4_000

/** How many levels up from a pane's cwd this looks for a code index before giving up. */
const CODEGRAPH_MAX_LEVELS = 8

/** A finished answer is trusted for this long before a repeat ask runs the model again. */
const FINISHED_MS = 10 * 60_000

/** At most this many finished answers are kept; the oldest is dropped first. */
const MAX_FINISHED = 20

/** One entry of a run in flight: the promise every caller for this text shares, and a way
 * to end it early when a DIFFERENT text supersedes it for the same pane. */
interface InFlight {
  promise: Promise<ExpandAnswer>
  supersede: () => void
}

/** Runs sharing their text, keyed by the exact text asked. */
const inFlight = new Map<string, InFlight>()

/** Finished answers, success only - an error is never worth serving stale. */
const finished = new Map<string, { at: number; answer: ExpandAnswer }>()

/** The text each pane last asked to expand, so a new DIFFERENT one can supersede the old. */
const paneRun = new Map<string, string>()

/** An empty folder under userData for the headless run to start in - see `splitPrompt.ts`'s
 * own copy of this idea; this feature gets its own folder so the two runs never collide. */
function quietDir(): string {
  const dir = join(app.getPath('userData'), 'expand')
  mkdirSync(dir, { recursive: true })
  return dir
}

function logPath(): string {
  return join(app.getPath('userData'), 'prompt-expand.log')
}

/** One JSON line appended to `prompt-expand.log`. Never the prompt text - see the header. */
function log(line: Record<string, unknown>): void {
  try {
    appendFileSync(logPath(), JSON.stringify(line) + '\n')
  } catch {
    // A logging failure is not a reason this feature stops answering.
  }
}

/**
 * Walk up from `cwd` for `.codegraph/codegraph.db`, the mark that this repo has a code
 * index worth asking. `null` past `CODEGRAPH_MAX_LEVELS` or at the filesystem root.
 */
function findCodegraphRoot(cwd: string, maxLevels = CODEGRAPH_MAX_LEVELS): string | null {
  let dir = resolve(cwd || '.')
  for (let i = 0; i <= maxLevels; i++) {
    if (existsSync(join(dir, '.codegraph', 'codegraph.db'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/** Where `code-map.mjs` lives - `PF_CODEMAP`, or the copy this desk's own memory keeps. */
function codeMapPath(): string {
  return process.env.PF_CODEMAP || join(projectsRoot(), 'claude-memory', 'claude-config', 'code-map.mjs')
}

/**
 * Where to start, from whichever search this machine can run.
 *
 * A code index answers first, in the repo it belongs to, run as plain node
 * (`ELECTRON_RUN_AS_NODE`, the same trick `laneBoard.ts` uses to make Electron's own
 * binary behave like the node this script needs). No index falls back to `git ls-files`
 * and a keyword score. Any failure - no git, no node, a search that ran past its budget -
 * answers `[]` rather than guessing: an empty "Where to start" section is honest, and a
 * wrong one sends somebody reading the wrong file.
 */
async function findWhere(text: string, cwd: string): Promise<ExpandWhere[]> {
  const keywords = keywordsOf(text)
  try {
    const root = findCodegraphRoot(cwd)
    const mapPath = codeMapPath()
    if (root && existsSync(mapPath)) {
      const { promise } = runHeadless({
        bin: process.execPath,
        args: [mapPath, 'where', keywords.join(' ')],
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeoutMs: WHERE_BUDGET_MS
      })
      const r = await promise
      return r.out.trim() ? readWhere(r.out) : []
    }
    const { promise } = runHeadless({
      bin: 'git',
      args: ['ls-files'],
      cwd,
      env: process.env,
      timeoutMs: WHERE_BUDGET_MS
    })
    const r = await promise
    if (!r.out.trim()) return []
    const files = r.out.split('\n').map((s) => s.trim()).filter(Boolean)
    return whereFromFiles(files, keywords)
  } catch {
    return []
  }
}

/**
 * Start one run: the model and the code search in parallel, settled once, and killable
 * from outside before either finishes - which is what a superseding text needs.
 */
function startRun(body: string, cwd: string, paneId: string): InFlight {
  let settled = false
  let resolveOuter!: (a: ExpandAnswer) => void
  const promise = new Promise<ExpandAnswer>((res) => {
    resolveOuter = res
  })
  const settle = (a: ExpandAnswer): void => {
    if (settled) return
    settled = true
    resolveOuter(a)
  }
  let modelKill: () => void = () => {}

  const run = async (): Promise<void> => {
    const cfg = getConfig()
    // Claude Code only, whatever the desk's default agent is - see `expandArgs`.
    const id = 'claude'
    if (!onDisk(id)) {
      settle({ error: 'Claude Code is not installed on this machine.' })
      return
    }
    const spec = specFor(id)
    let bin: string
    try {
      bin = which(spec.bin)
    } catch {
      settle({ error: `${spec.label} is not installed on this machine.` })
      return
    }
    const args = [
      ...(spec.alwaysArgs ?? []),
      ...HEADLESS[id],
      ...expandArgs(body)
    ]
    // Runs on the CLI's own subscription login, never a paid key - the same reason
    // `splitPrompt.ts` never touches these either. Deleted rather than left unset: a key
    // present in `process.env` from an earlier lane or a shell profile would otherwise
    // still be inherited.
    const env: Record<string, string | undefined> = { ...process.env, ...resolveEnv(spec, cfg.providerKeys ?? {}) }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_BASE_URL
    delete env.OPENAI_API_KEY

    const modelStart = Date.now()
    const headless = runHeadless({
      bin,
      args,
      cwd: quietDir(),
      env,
      // The card gives up at the same mark, so a run past it has nobody left to answer.
      timeoutMs: EXPAND_WAIT_MS
    })
    modelKill = headless.kill
    const [modelResult, where] = await Promise.all([headless.promise, findWhere(body, cwd)])
    const ms = Date.now() - modelStart
    if (settled) return // a supersede already answered for this caller

    const words = wordCount(body)
    if (!modelResult.out.trim()) {
      // First line only, capped: the log is read by people, and a CLI's stderr can run long.
      const error = (modelResult.err || `${spec.label} answered nothing.`).split('\n')[0].slice(0, 200)
      log({ at: Date.now(), pane: paneId, words, ms, ok: false, error, agent: id, where: where.length })
      settle({ error })
      return
    }
    const expansion = parseExpansion(modelResult.out)
    if (!expansion) {
      log({ at: Date.now(), pane: paneId, words, ms, ok: false, error: 'not a brief', agent: id, where: where.length })
      settle({ error: `${spec.label} did not answer with a brief.` })
      return
    }
    log({ at: Date.now(), pane: paneId, words, ms, ok: true, agent: id, where: where.length })
    settle({ expansion, where, bundled: scopeOf(body).items >= BUNDLED_ITEMS, ms })
  }

  void run()
  return {
    promise,
    supersede: () => {
      modelKill()
      settle({ error: 'superseded' })
    }
  }
}

/**
 * Read a rough ask into a full brief.
 *
 * Refuses empty or unqualifying text with `{error}` - never silence, because the renderer
 * needs to know the card should not open. The exact same text asked twice, from the same
 * pane or a different one, shares the one run in flight: that is what lets the SPECULATIVE
 * call started while Robert is still typing hide the latency of the one Enter makes.
 */
export async function expandPrompt(text: string, cwd: string, paneId: string): Promise<ExpandAnswer> {
  const body = String(text || '').trim()
  if (!body || !shouldExpand(body)) return { error: 'Not a long enough ask for a fuller brief.' }

  const prev = paneRun.get(paneId)
  if (prev && prev !== body) inFlight.get(prev)?.supersede()
  paneRun.set(paneId, body)

  const fin = finished.get(body)
  if (fin && Date.now() - fin.at < FINISHED_MS) return fin.answer

  let entry = inFlight.get(body)
  if (!entry) {
    entry = startRun(body, cwd, paneId)
    inFlight.set(body, entry)
    void entry.promise.then((answer) => {
      if (inFlight.get(body) === entry) inFlight.delete(body)
      if (!('error' in answer)) {
        finished.set(body, { at: Date.now(), answer })
        while (finished.size > MAX_FINISHED) {
          const oldest = finished.keys().next().value
          if (oldest === undefined) break
          finished.delete(oldest)
        }
      }
    })
  }
  return entry.promise
}

/** What the person did with a card. Fire-and-forget; the log is the feature's outcome rate. */
export function noteExpandChoice(
  choice: ExpandChoice,
  meta: { paneId: string; words: number; ms?: number; waitedMs?: number }
): void {
  log({ at: Date.now(), kind: 'choice', pane: meta.paneId, words: meta.words, ms: meta.ms, waitedMs: meta.waitedMs, choice })
}
