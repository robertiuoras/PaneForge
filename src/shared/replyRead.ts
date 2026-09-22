// What a CLI's own transcript says the agent last replied, and whether it left a subagent
// running.
//
// The app's Review list needs the REPLY, not the screen: the screen is raw terminal bytes
// hard-wrapped at one width, and a closed pane's "what it did" has to read as text. The
// Claude CLI writes every turn to `~/.claude/projects/<slug>/<id>.jsonl` and Codex to its
// rollout, so the answer is on disk already. Pure over the file's text: `main/doneClose.ts`
// reads the tail and hands it here, `npm run test:replyread` asserts the shapes.
//
// The running-subagent reading is a MIRROR of `claude-config/handoff-state.mjs`
// `runningAgentsOf`, the way `shared/handoffSteps.ts` mirrors `autoclear.mjs`: an
// `Agent`/`SendMessage` tool_use whose result said `Async agent launched` and whose
// `<task-notification>` has not arrived yet. Closing a pane on that would kill the build
// the agent is running (2026-09-19: a `/clear` did exactly that).

/** One reply as the Review list wants it. */
export interface ReplyRead {
  /** The last assistant message, text blocks joined. Empty when the tail holds none. */
  text: string
  /** Subagents launched in the background and not yet reported back. */
  runningAgents: number
  /** The last thing the person typed, when the tail holds it. */
  prompt?: string
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: string }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** A `user` line the person actually typed - not a tool result, not the harness talking. */
function typedPrompt(text: string): string | undefined {
  const t = text.trim()
  if (!t || t.startsWith('<') ) return undefined
  if (/^\[Request interrupted/.test(t)) return undefined
  return t
}

/** The Claude CLI's JSONL, any stretch of it (the first line may be half a record). */
export function readClaudeReply(jsonl: string): ReplyRead {
  let text = ''
  let prompt: string | undefined
  const launched = new Set<string>()
  const answered = new Set<string>()
  const notified = new Set<string>()
  for (const line of String(jsonl || '').split('\n')) {
    if (!line) continue
    // The notification arrives as a queued command (`attachment` / `queue-operation` rows),
    // never inside a tool result - a tool result QUOTING one (a grep over this very code)
    // must not count, or a pane would close on top of the agent it was waiting for.
    if (line.includes('<task-notification>') && !line.includes('"tool_result"')) {
      for (const m of line.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) notified.add(m[1])
    }
    if (!/"type":"(assistant|user)"/.test(line)) continue
    let j: { type?: string; isSidechain?: boolean; message?: { role?: string; content?: unknown } }
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.isSidechain) continue
    const content = j.message?.content
    if (j.type === 'assistant') {
      const t = textOf(content)
      if (t.trim()) text = t
      if (Array.isArray(content))
        for (const c of content as Array<{ type?: string; id?: string; name?: string }>)
          if (c.type === 'tool_use' && c.id && (c.name === 'Agent' || c.name === 'SendMessage')) launched.add(c.id)
    } else if (j.type === 'user') {
      if (Array.isArray(content)) {
        let plain = false
        for (const c of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: string }>) {
          if (c.type === 'tool_result' && c.tool_use_id && launched.has(c.tool_use_id)) {
            const r = textOf(c.content)
            if (c.is_error) launched.delete(c.tool_use_id)
            else if (/Async agent launched|"resumedAgentId"/.test(r)) answered.add(c.tool_use_id)
            else launched.delete(c.tool_use_id) // foreground: its result IS the report
          } else if (c.type === 'text') plain = true
        }
        if (plain) {
          const p = typedPrompt(textOf(content))
          if (p) prompt = p
        }
      } else if (typeof content === 'string') {
        const p = typedPrompt(content)
        if (p) prompt = p
      }
    }
  }
  let runningAgents = 0
  for (const id of answered) if (!notified.has(id)) runningAgents++
  return { text, runningAgents, prompt }
}

/** A Codex rollout: `response_item` rows whose payload is an assistant message. */
export function readCodexReply(jsonl: string): ReplyRead {
  let text = ''
  let prompt: string | undefined
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.includes('"response_item"')) continue
    let row: { type?: string; payload?: { type?: string; role?: string; content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'response_item' || row.payload?.type !== 'message') continue
    const t = (Array.isArray(row.payload.content) ? row.payload.content : [])
      .map((c) => (c && typeof c === 'object' && /text$/.test(String((c as { type?: string }).type)) ? String((c as { text?: string }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
    if (!t.trim()) continue
    if (row.payload.role === 'assistant') text = t
    else if (row.payload.role === 'user' && !t.startsWith('<')) prompt = t
  }
  return { text, runningAgents: 0, prompt }
}

/** Which machine a step happens on, read off its own words. `null` = not said. */
export function machineOf(step: string): 'pc' | 'mac' | null {
  const s = String(step || '')
  if (/\b(on|at|from|to) (the )?(pc|windows( box| machine)?|desktop)\b/i.test(s)) return 'pc'
  if (/\b(on|at|from|to) (the |my )?(mac|macbook|laptop)\b/i.test(s)) return 'mac'
  return null
}
