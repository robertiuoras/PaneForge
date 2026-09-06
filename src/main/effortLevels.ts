// Which reasoning levels each Codex model actually offers, asked of Codex itself.
//
// Not a list in this build's source: the ladder is the model's own, it grew a rung
// (`ultra`) between two releases of the CLI, and a build that hard-codes it starts
// pressing an arrow into a menu that ends one rung earlier. `codex app-server` answers
// `model/list` with every model's `supportedReasoningEfforts`, which is a first-hand
// reading and costs no tokens.
//
// The contract is `codexInstalledVersion`'s (`main/codexModels.ts`): the FIRST call
// answers with what is known so far - `{}` - and starts the ask; the answer reaches the
// next caller. Nothing here ever blocks the main thread, and every failure leaves the app
// exactly as it was, which for this feature means the pane keeps whatever level it has.

import { spawn } from 'node:child_process'
import { ladderFromModelList } from '../shared/effort'
import { logEffort } from './activationLog'

/** Long enough for a cold binary on a busy machine, short enough to give up on. */
const ASK_TIMEOUT_MS = 20_000

let ladders: Record<string, string[]> = {}
let asking = false

/** A test or a demo can hand the answer over rather than starting a child. */
function fromEnv(): Record<string, string[]> | null {
  const raw = process.env.PF_EFFORT_LADDERS?.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, string[]>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Every model's ladder, or `{}` until Codex has answered.
 *
 * `{}` is not "no levels" - it is "nobody has said yet", and every caller treats it that
 * way: `decideBeforeTurn` refuses with `no-ladder` and the pane is left alone.
 */
export function codexLadders(bin: string, onNew?: () => void): Record<string, string[]> {
  const stubbed = fromEnv()
  if (stubbed) return stubbed
  if (Object.keys(ladders).length || asking) return ladders
  asking = true
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
  } catch (err) {
    asking = false
    logEffort({ ladders: 'could not start', error: String(err) })
    return ladders
  }
  const done = (why: string, found?: Record<string, string[]>): void => {
    if (!asking) return
    asking = false
    clearTimeout(timer)
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    if (found && Object.keys(found).length) {
      ladders = found
      logEffort({ ladders: Object.keys(found).length, why })
      onNew?.()
    } else {
      logEffort({ ladders: 'none', why })
    }
  }
  const timer = setTimeout(() => done('timed out'), ASK_TIMEOUT_MS)
  // The child outliving a quit would be a stray; it is killed on every path above, and
  // this one keeps the timer from holding the event loop open in the meantime.
  timer.unref?.()
  let out = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8')
    // Newline-delimited JSON-RPC. Only the answer to id 2 is of any interest; everything
    // else on the stream (status notifications, the initialize result) is skipped.
    const lines = out.split('\n')
    out = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (!text || text[0] !== '{') continue
      let row: { id?: number } & Record<string, unknown>
      try {
        row = JSON.parse(text)
      } catch {
        continue
      }
      if (row.id !== 2) continue
      const found: Record<string, string[]> = {}
      const rows = (row.result as { data?: Array<{ id?: string }> } | undefined)?.data ?? []
      for (const model of rows) {
        const id = String(model?.id || '').trim()
        if (!id) continue
        const ladder = ladderFromModelList(row, id)
        if (ladder) found[id] = ladder
      }
      done('answered', found)
      return
    }
  })
  child.on('error', (err) => done(`could not run: ${err.message}`))
  child.on('exit', () => done('exited before answering'))
  try {
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'paneforge', version: '0' } }
      }) + '\n'
    )
    child.stdin?.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} }) + '\n'
    )
  } catch (err) {
    done(`could not ask: ${String(err)}`)
  }
  return ladders
}

/** Everything, for a test that wants the ask to happen again. */
export function forgetCodexLadders(): void {
  ladders = {}
  asking = false
}
