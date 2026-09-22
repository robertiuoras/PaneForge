// Which model a new pane starts on when the request did not name one.
//
// The New Session dialog has always filled the configured default (`config.defaultModels`)
// into its own request, so a pane opened by hand ran on the chosen model. Every launcher
// that reaches `sessions:start` WITHOUT that dialog - `pf open`, `sessions:startMany`, the
// phone, a paired desk's guest launch, `PaneForge --open` - sent no model at all, and the
// CLI then fell back to its own default. On 2026-09-23 seven `pf open --agent claude`
// panes started on claude-fable-5-1 while Settings said claude-opus-5-5.
//
// So main fills the gap at the one place every launcher meets. A model the caller named
// always wins; a shell has no model; an agent with no saved default is left to its CLI.

export interface ModelRequest {
  agent?: unknown
  model?: string
}

/** The agent id a start request means - the same coercion `SessionManager.start` makes. */
export function agentOf(asked: unknown): string {
  if (typeof asked === 'string' && asked) return asked
  return (asked as { id?: string } | null | undefined)?.id ?? 'claude'
}

export function withDefaultModel<T extends ModelRequest>(
  req: T,
  defaults: Record<string, string> | undefined
): T {
  if (req.model?.trim()) return req
  const agent = agentOf(req.agent)
  if (agent === 'shell') return req
  const model = defaults?.[agent]?.trim()
  return model ? { ...req, model } : req
}
