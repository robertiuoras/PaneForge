// Which background agents a Claude Code conversation still has running.
//
// A Claude Code pane whose TURN is over can still be working: the `Agent` tool launches a
// subagent in the background ("Async agent launched ... agentId: ..."), the turn ends, the
// footer goes quiet, and the subagent keeps going INSIDE that CLI process. Anything that
// ends the process - a move to the other machine, a sleep, a close - ends the subagent with
// it, and the far end resumes to "Background agent ... didn't finish before the previous
// session ended". That happened on 2026-09-22: pane s24-mud0n7wb (liftgym) was moved to the
// PC by the queue the moment its turn ended, with "Visual review Design 4 pages" still
// running, and the review was lost.
//
// The transcript says it plainly, so this reads it. Ported from `runningAgentsOf` in
// claude-config/handoff-state.mjs (the autoclear refusal `agent_running`, 2026-09-19):
//
//   - an `Agent` (or `SendMessage`) tool_use is a launch,
//   - its tool_result saying "Async agent launched ... agentId: X" (or carrying a
//     `resumedAgentId`) makes it a BACKGROUND agent; any other result is a foreground
//     agent whose result IS its report, so it is finished; an error result never started,
//   - a `<task-notification>` naming the launch's `<tool-use-id>` means it stopped. Claude
//     Code writes that as a `queue-operation` line the moment the agent finishes, even
//     while the main loop is busy, and again as the user line that delivers it.
//
// Pure and incremental: `scanAgentLines` is fed only the lines appended since the last
// read, so the main-side reader never re-reads a transcript it has already seen.

export interface AgentScan {
  /** tool_use id -> what was launched */
  launched: Map<string, { via: string; at: number | null; label?: string; model?: string }>
  /** tool_use id -> the agent id its own result named (background agents only) */
  answered: Map<string, string>
  /** tool_use ids a task-notification has said stopped */
  notified: Set<string>
  /**
   * Background `Bash` commands (`run_in_background`). Tracked APART from the agents: what
   * `runningAgents()` returns and when it refuses is unchanged. Only `pendingBackground`
   * reads this.
   */
  shells: Map<string, { id?: string; at: number | null; label?: string }>
  /**
   * tool_use id -> launch time of a background task whose `<task-notification>` was only
   * ENQUEUED/DEQUEUED: the conversation has not acted on it yet. If the CLI dies in that
   * window nobody ever will (pane 2, 2026-10-01: the notification was enqueued 08:24:32Z,
   * dequeued 08:25:41Z, the app was killed 08:25:54Z, and the pane came back asleep).
   */
  undelivered: Map<string, number | null>
}

export interface RunningAgent {
  /** the agent id Claude Code gave it */
  id: string
  toolUseId: string
  /** `Agent`, `SendMessage` or `Workflow` */
  via: string
  /** epoch ms of the launch, when the line carried a timestamp */
  at: number | null
  /** the launch's own `description`, e.g. "Visual review Design 4 pages" */
  label?: string
  /** the model the launch ASKED for (`input.model`); never proof of what ran */
  model?: string
}

/**
 * The oldest launch still believed. A notification this reader never saw (a format change,
 * a line past the tail it started from) must not hold a pane for the rest of its life: an
 * automatic move or sleep that is refused for ever is a feature switched off.
 */
export const AGENT_MAX_AGE_MS = 3 * 60 * 60_000

export function newAgentScan(): AgentScan {
  return { launched: new Map(), answered: new Map(), notified: new Set(), shells: new Map(), undelivered: new Map() }
}

const NOTIFIED = /<tool-use-id>([^<]+)<\/tool-use-id>/g
const ASYNC = /Async agent launched[\s\S]*?agentId:\s*([A-Za-z0-9_-]+)/
const RESUMED = /"resumedAgentId"\s*:\s*"([^"]+)"/
/** A `Workflow` graph runs in-process like a subagent and ends in the same task-notification. */
const WORKFLOW = /Workflow launched in background\.\s*Task ID:\s*([A-Za-z0-9_-]+)/

/** A `Bash` with `run_in_background` answers with this and ends its turn's wait. */
const SHELL_STARTED = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('\n')
}

/** Feed complete JSONL lines (any number, newline separated) into the scan. */
export function scanAgentLines(scan: AgentScan, text: string): void {
  for (const line of text.split('\n')) {
    if (!line) continue
    if (line.includes('<task-notification>')) {
      // Was this line the conversation ACTING on the notification, or only the queue
      // holding it? Claude Code writes `queue-operation` enqueue/dequeue rows when the
      // notification is queued, and a user row / `queued_command` attachment / a
      // `remove` (absorbed mid-turn) when it reaches the model.
      let queued = false
      try {
        const o = JSON.parse(line) as { type?: unknown; operation?: unknown }
        queued = o.type === 'queue-operation' && (o.operation === 'enqueue' || o.operation === 'dequeue')
      } catch { /* an unreadable line is not proof of anything pending */ }
      for (const m of line.matchAll(NOTIFIED)) {
        const known = scan.shells.get(m[1]) ?? scan.launched.get(m[1])
        if (known) {
          if (queued) scan.undelivered.set(m[1], known.at)
          else {
            scan.undelivered.delete(m[1])
            scan.shells.delete(m[1])
          }
        } else if (!queued) scan.undelivered.delete(m[1])
        scan.notified.add(m[1])
        // Finished: nothing about it is needed again, so a long conversation's maps do
        // not grow with every agent it ever ran.
        if (scan.answered.has(m[1])) {
          scan.answered.delete(m[1])
          scan.launched.delete(m[1])
          scan.notified.delete(m[1])
        }
      }
      continue
    }
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue
    let j: { timestamp?: string; message?: { content?: unknown } }
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const content = j.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content as Array<Record<string, unknown>>) {
      if (!c || typeof c !== 'object') continue
      if (c.type === 'tool_use' && (c.name === 'Agent' || c.name === 'SendMessage' || c.name === 'Workflow') && typeof c.id === 'string') {
        const input = (c.input ?? {}) as { description?: unknown; scriptPath?: unknown; name?: unknown; model?: unknown }
        const graph = c.name === 'Workflow' ? `workflow ${String(input.name ?? input.scriptPath ?? '').split('/').pop()?.replace(/\.m?js$/, '') ?? ''}`.trim() : undefined
        const at = j.timestamp ? Date.parse(j.timestamp) : NaN
        scan.launched.set(c.id, {
          via: c.name as string,
          at: Number.isFinite(at) ? at : null,
          label: graph ?? (typeof input.description === 'string' && input.description.trim() ? input.description.trim().slice(0, 80) : undefined),
          ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim().slice(0, 80) } : {})
        })
      } else if (c.type === 'tool_use' && c.name === 'Bash' && typeof c.id === 'string' && (c.input as { run_in_background?: unknown } | undefined)?.run_in_background === true) {
        const input = c.input as { description?: unknown }
        const at = j.timestamp ? Date.parse(j.timestamp) : NaN
        scan.shells.set(c.id, {
          at: Number.isFinite(at) ? at : null,
          label: typeof input.description === 'string' && input.description.trim() ? input.description.trim().slice(0, 80) : undefined
        })
      } else if (c.type === 'tool_result' && typeof c.tool_use_id === 'string' && scan.shells.has(c.tool_use_id)) {
        const sh = scan.shells.get(c.tool_use_id)!
        const m = c.is_error ? null : SHELL_STARTED.exec(textOf(c.content))
        if (m) sh.id = m[1]
        else scan.shells.delete(c.tool_use_id)
      } else if (c.type === 'tool_result' && typeof c.tool_use_id === 'string' && scan.launched.has(c.tool_use_id)) {
        const id = c.tool_use_id
        if (c.is_error) {
          scan.launched.delete(id)
          continue
        }
        const t = textOf(c.content)
        const bg = ASYNC.exec(t)
        const resumed = RESUMED.exec(t)
        const graph = WORKFLOW.exec(t)
        if (bg) scan.answered.set(id, bg[1])
        else if (graph) scan.answered.set(id, graph[1])
        else if (resumed) scan.answered.set(id, resumed[1])
        // A foreground agent: its result is the report, so it is finished.
        else scan.launched.delete(id)
        // The notification can be written before the result line is (the queue-operation
        // is enqueued the instant the agent stops): honour it now.
        if (scan.notified.has(id)) {
          scan.answered.delete(id)
          scan.launched.delete(id)
          scan.notified.delete(id)
        }
      }
    }
  }
}

/**
 * The background agents still running.
 *
 * `since` is when THIS CLI process started, when known: an agent launched before it was
 * launched by a process that is gone, and died with it - which is exactly what a pane
 * resumed on the other machine has in its transcript. `now` bounds the age.
 */
export function runningAgents(scan: AgentScan, opts: { since?: number; now?: number } = {}): RunningAgent[] {
  const out: RunningAgent[] = []
  for (const [toolUseId, agent] of scan.answered) {
    if (scan.notified.has(toolUseId)) continue
    const l = scan.launched.get(toolUseId)
    if (!l) continue
    if (l.at != null && opts.since != null && l.at < opts.since) continue
    if (l.at != null && opts.now != null && opts.now - l.at > AGENT_MAX_AGE_MS) continue
    out.push({ id: agent, toolUseId, via: l.via, at: l.at, label: l.label, ...(l.model ? { model: l.model } : {}) })
  }
  return out
}

export interface PendingBackground {
  agents: RunningAgent[]
  shells: Array<{ toolUseId: string; id?: string; at: number | null; label?: string }>
  /** background tasks whose notification the conversation has not acted on yet */
  undelivered: number
}

/**
 * Everything a pane's CLI still owes work to: its running agents, its background shell
 * commands, and notifications that were queued but never reached the model. Same `since` /
 * age rules as `runningAgents`. This is what a restart must not lose; the refusals
 * (`runningAgents`) are unchanged.
 */
export function pendingBackground(scan: AgentScan, opts: { since?: number; now?: number } = {}): PendingBackground {
  const live = (at: number | null) =>
    !(at != null && opts.since != null && at < opts.since) && !(at != null && opts.now != null && opts.now - at > AGENT_MAX_AGE_MS)
  const shells: PendingBackground['shells'] = []
  for (const [toolUseId, sh] of scan.shells) if (sh.id && live(sh.at)) shells.push({ toolUseId, ...sh })
  let undelivered = 0
  for (const at of scan.undelivered.values()) if (live(at)) undelivered++
  return { agents: runningAgents(scan, opts), shells, undelivered }
}

export function hasPendingBackground(scan: AgentScan, opts: { since?: number; now?: number } = {}): boolean {
  const p = pendingBackground(scan, opts)
  return p.agents.length > 0 || p.shells.length > 0 || p.undelivered > 0
}

/** One-shot form over a whole transcript's text - what the tests and the hook port read. */
export function runningAgentsIn(text: string, opts: { since?: number; now?: number } = {}): RunningAgent[] {
  const scan = newAgentScan()
  scanAgentLines(scan, text)
  return runningAgents(scan, opts)
}

/**
 * What a card and a log line say, or undefined when nothing is running:
 * `a background agent (Visual review Design 4 pages)`, `2 background agents`.
 */
export function agentWords(list: RunningAgent[] | null | undefined): string | undefined {
  if (!list || !list.length) return undefined
  if (list.length === 1) return list[0].label ? `a background agent (${list[0].label})` : 'a background agent'
  return `${list.length} background agents`
}
