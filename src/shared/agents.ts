// The catalogue of coding agents PaneForge can run, and the rules for turning a
// launch request into an argv. Everything that is agent-specific (binary name,
// how to resume, which flag selects a model) lives here so adding a new CLI is a
// single entry rather than a branch in the spawn path.
//
// Imported by both the main process and the renderer: keep it dependency-free.

export interface AgentSpec {
  /** stable key stored in config and on every session */
  id: string
  label: string
  /** executable name looked up on PATH (or an absolute path) */
  bin: string
  /** args used for a fresh session */
  args?: string[]
  /** args that continue the last conversation in the same folder; omitted = unsupported */
  resumeArgs?: string[]
  /** flag that selects a model, e.g. `--model`; omitted = the CLI has no such flag */
  modelFlag?: string
  /** suggestions only - any model string can be typed in */
  models?: string[]
  /** dot colour in the UI so panes are distinguishable at a glance */
  color: string
  /** shown when the binary is missing */
  install?: string
  /** true for entries the user added in Settings */
  custom?: boolean
}

/** A spec plus what the machine actually has installed. */
export interface AgentInfo extends AgentSpec {
  available: boolean
  /** resolved absolute path, empty when not found */
  path: string
}

// Model lists are deliberately short: they are a shortcut, not a whitelist. The UI
// lets you type any model string, so a CLI renaming its models cannot break launches.
export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    resumeArgs: ['--continue'],
    modelFlag: '--model',
    models: ['fable', 'opus', 'sonnet', 'haiku'],
    color: '#d97757',
    install: 'npm i -g @anthropic-ai/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    // `resume` is a subcommand, not a flag, so it has to lead the argv.
    resumeArgs: ['resume', '--last'],
    modelFlag: '-m',
    models: ['gpt-5.6-terra', 'gpt-5.1-codex-max', 'gpt-5.1-codex'],
    color: '#10a37f',
    install: 'npm i -g @openai/codex'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    modelFlag: '--model',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    color: '#4285f4',
    install: 'npm i -g @google/gemini-cli'
  },
  {
    id: 'copilot',
    label: 'Copilot CLI',
    bin: 'copilot',
    resumeArgs: ['--continue'],
    modelFlag: '--model',
    color: '#c9d1d9',
    install: 'npm i -g @github/copilot'
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    resumeArgs: ['--resume'],
    modelFlag: '--model',
    color: '#a78bfa',
    install: 'https://cursor.com/cli'
  },
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    resumeArgs: ['--continue'],
    modelFlag: '--model',
    color: '#fbbf24',
    install: 'npm i -g opencode-ai'
  },
  {
    id: 'amp',
    label: 'Amp',
    bin: 'amp',
    color: '#f472b6',
    install: 'npm i -g @sourcegraph/amp'
  },
  {
    id: 'aider',
    label: 'Aider',
    bin: 'aider',
    modelFlag: '--model',
    models: ['sonnet', 'gpt-5', 'gemini/gemini-2.5-pro'],
    color: '#34d399',
    install: 'python -m pip install aider-install && aider-install'
  },
  {
    id: 'shell',
    label: 'Shell',
    bin: process.platform === 'win32' ? 'powershell' : 'bash',
    args: process.platform === 'win32' ? ['-NoLogo'] : [],
    color: '#8b8b99'
  }
]

/** Built-ins first, then the user's own entries; a custom id overrides a built-in. */
export function allAgents(custom: AgentSpec[] = []): AgentSpec[] {
  const out = [...BUILTIN_AGENTS]
  for (const c of custom) {
    const spec = { ...c, custom: true }
    const i = out.findIndex((a) => a.id === c.id)
    if (i >= 0) out[i] = spec
    else out.push(spec)
  }
  return out
}

export function findAgent(agents: AgentSpec[], id: string | undefined): AgentSpec {
  return agents.find((a) => a.id === id) ?? agents[0]
}

/** Full argv for one launch: resume form or fresh form, plus the model flag. */
export function buildArgs(spec: AgentSpec, opts: { resume?: boolean; model?: string }): string[] {
  const argv = opts.resume && spec.resumeArgs ? [...spec.resumeArgs] : [...(spec.args ?? [])]
  const model = opts.model?.trim()
  if (model && spec.modelFlag) argv.push(spec.modelFlag, model)
  return argv
}
