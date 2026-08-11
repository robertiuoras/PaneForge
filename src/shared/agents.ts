// The catalogue of coding agents PaneForge can run, and the rules for turning a
// launch request into an argv. Everything that is agent-specific (binary name,
// how to resume, which flag selects a model, how to install it) lives here so
// adding a new CLI is a single entry rather than a branch in the spawn path.
//
// Imported by both the main process and the renderer: keep it dependency-free,
// and never touch a Node global at module scope. With contextIsolation on there
// is no `process` in the renderer, so a bare `process.platform` here throws
// during module evaluation and takes the whole React tree down with it.

/** win32 / darwin / linux, resolved without assuming Node is present. */
export const PLATFORM: string = (() => {
  const p = (globalThis as { process?: { platform?: string } }).process
  if (p?.platform) return p.platform
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? ''
  if (/Mac/i.test(ua)) return 'darwin'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return 'win32'
})()

/**
 * A model the UI offers for an agent. A bare string is both the value and the
 * label; the object form exists so `claude-opus-4-8` can read as "Opus 4.8" in
 * the menu without hiding the real id that gets passed to the CLI.
 */
export type ModelChoice = string | { value: string; label: string; hint?: string }

/** How the model reaches the CLI: as `--model x` (default) or as a bare argument. */
export type ModelStyle = 'flag' | 'arg'

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
  /**
   * args that reopen ONE named conversation, with its id appended. "The newest chat in
   * this folder" and "the chat this pane was in" stop being the same answer the moment a
   * second pane opens on the same repo, or another window has a turn there afterwards -
   * so a restore that knows the id says the id. Omitted = only `resumeArgs` is possible.
   */
  resumeIdArgs?: string[]
  /** flag that selects a model, e.g. `--model`; omitted = the CLI has no such flag */
  modelFlag?: string
  /** 'arg' appends the model as a positional (ollama run <model>) instead of a flag */
  modelStyle?: ModelStyle
  /** suggestions only - any model string can be typed in */
  models?: ModelChoice[]
  /** dot colour in the UI so panes are distinguishable at a glance */
  color: string
  /** default install command, used when no per-platform one matches */
  install?: string
  /** platform-specific install commands, preferred over `install` when present */
  installWin?: string
  installMac?: string
  /**
   * How to take it back off, same per-platform shape as `install`. Omitted means the
   * CLI has no scripted removal and the UI shows no button for it: a button that
   * leaves half an install behind is worse than sending the user to the docs.
   */
  uninstall?: string
  uninstallWin?: string
  uninstallMac?: string
  /** usable with no paid subscription (free tier, own API key, or fully local) */
  free?: boolean
  /** one line shown under the name in Settings: what it costs, what it needs */
  note?: string
  /** where to read more; opened in the browser from Settings */
  docs?: string
  /** true for entries the user added in Settings */
  custom?: boolean
}

/** A spec plus what the machine actually has installed. */
export interface AgentInfo extends AgentSpec {
  available: boolean
  /** resolved absolute path, empty when not found */
  path: string
}

// Claude model ids are real ones read off the CLI, not guesses: the picker has to
// let you pin an exact generation (Opus 5 vs Opus 4.8) rather than only the moving
// `opus` alias, because "latest" changes under you mid-project.
const CLAUDE_MODELS: ModelChoice[] = [
  // No separate "[1m]" entry: plain claude-opus-5 already carries the 1M token
  // context window, so listing it twice only made the picker look like a choice
  // between two different models when both launch the same one.
  { value: 'claude-opus-5', label: 'Opus 5', hint: 'newest, 1M context' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'fast, cheaper' },
  { value: 'claude-fable-5', label: 'Fable 5', hint: 'heaviest' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: 'cheapest' },
  { value: 'opus', label: 'opus (alias)', hint: 'always the latest Opus' },
  { value: 'sonnet', label: 'sonnet (alias)' },
  { value: 'haiku', label: 'haiku (alias)' }
]

// Model lists are deliberately short: they are a shortcut, not a whitelist. The UI
// lets you type any model string, so a CLI renaming its models cannot break launches.
export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    resumeArgs: ['--continue'],
    resumeIdArgs: ['--resume'],
    modelFlag: '--model',
    models: CLAUDE_MODELS,
    color: '#d97757',
    install: 'npm i -g @anthropic-ai/claude-code',
    uninstall: 'npm rm -g @anthropic-ai/claude-code',
    note: 'Anthropic subscription or API key',
    docs: 'https://docs.claude.com/en/docs/claude-code'
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    // `resume` is a subcommand, not a flag, so it has to lead the argv.
    resumeArgs: ['resume', '--last'],
    modelFlag: '-m',
    // Measured 2026-08-11 against a ChatGPT-plan login: every `gpt-5.1-codex*` id
    // is answered `400 invalid_request_error - not supported when using Codex with
    // a ChatGPT account`, and the CLI reports that as an error INSIDE a pane that
    // otherwise looks healthy, so a pane launched on one sits there having burned
    // its prompt. Only the ids below answer on a subscription login; an API-key
    // user can still type any string, which is what the list is for.
    models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
    color: '#10a37f',
    install: 'npm i -g @openai/codex',
    uninstall: 'npm rm -g @openai/codex',
    note: 'ChatGPT plan or OpenAI API key',
    docs: 'https://developers.openai.com/codex/cli'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    modelFlag: '--model',
    models: [
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'fastest' }
    ],
    color: '#4285f4',
    install: 'npm i -g @google/gemini-cli',
    uninstall: 'npm rm -g @google/gemini-cli',
    free: true,
    note: 'Free tier with a Google account - no card needed',
    docs: 'https://github.com/google-gemini/gemini-cli'
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    modelFlag: '--model',
    models: ['qwen3-coder-plus', 'qwen3-coder-flash'],
    color: '#7c3aed',
    install: 'npm i -g @qwen-code/qwen-code',
    uninstall: 'npm rm -g @qwen-code/qwen-code',
    free: true,
    note: 'Free daily quota with a Qwen account',
    docs: 'https://github.com/QwenLM/qwen-code'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    bin: 'ollama',
    args: ['run'],
    // `ollama run llama3` takes the model as a positional, so the usual --model
    // flag would be passed straight through to the model as a prompt.
    modelStyle: 'arg',
    models: ['qwen2.5-coder', 'llama3.2', 'deepseek-r1', 'codellama'],
    color: '#e5e7eb',
    installWin: 'winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements',
    installMac: 'brew install ollama',
    uninstallWin: 'winget uninstall --id Ollama.Ollama -e',
    uninstallMac: 'brew uninstall ollama',
    free: true,
    note: 'Fully local and offline - free forever, no account',
    docs: 'https://ollama.com'
  },
  {
    id: 'copilot',
    label: 'Copilot CLI',
    bin: 'copilot',
    resumeArgs: ['--continue'],
    modelFlag: '--model',
    color: '#c9d1d9',
    install: 'npm i -g @github/copilot',
    uninstall: 'npm rm -g @github/copilot',
    note: 'GitHub Copilot subscription (free tier available)',
    docs: 'https://github.com/features/copilot/cli'
  },
  {
    id: 'cursor',
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    resumeArgs: ['--resume'],
    modelFlag: '--model',
    color: '#a78bfa',
    installWin: 'powershell -NoProfile -Command "irm https://cursor.com/install.ps1 | iex"',
    installMac: 'curl https://cursor.com/install -fsS | bash',
    note: 'Cursor subscription',
    docs: 'https://cursor.com/cli'
  },
  {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    resumeArgs: ['--continue'],
    modelFlag: '--model',
    models: ['anthropic/claude-sonnet-5', 'openai/gpt-5.1-codex', 'google/gemini-2.5-pro'],
    color: '#fbbf24',
    install: 'npm i -g opencode-ai',
    uninstall: 'npm rm -g opencode-ai',
    free: true,
    note: 'Open source - bring any key, or point it at a local model',
    docs: 'https://opencode.ai'
  },
  {
    id: 'crush',
    label: 'Crush',
    bin: 'crush',
    modelFlag: '--model',
    color: '#f97316',
    install: 'npm i -g @charmland/crush',
    uninstall: 'npm rm -g @charmland/crush',
    free: true,
    note: 'Open source - works with free and local providers',
    docs: 'https://github.com/charmbracelet/crush'
  },
  {
    id: 'goose',
    label: 'Goose',
    bin: 'goose',
    color: '#22d3ee',
    installMac: 'brew install block-goose-cli',
    installWin: 'winget install --id Block.Goose -e --accept-package-agreements --accept-source-agreements',
    uninstallMac: 'brew uninstall block-goose-cli',
    uninstallWin: 'winget uninstall --id Block.Goose -e',
    free: true,
    note: 'Open source, runs on any model including local ones',
    docs: 'https://block.github.io/goose/'
  },
  {
    id: 'amp',
    label: 'Amp',
    bin: 'amp',
    color: '#f472b6',
    install: 'npm i -g @sourcegraph/amp',
    uninstall: 'npm rm -g @sourcegraph/amp',
    note: 'Sourcegraph account',
    docs: 'https://ampcode.com'
  },
  {
    id: 'aider',
    label: 'Aider',
    bin: 'aider',
    modelFlag: '--model',
    models: ['sonnet', 'gpt-5', 'gemini/gemini-2.5-pro', 'ollama/qwen2.5-coder'],
    color: '#34d399',
    install: 'python -m pip install aider-install && aider-install',
    uninstall: 'python -m pip uninstall -y aider-install aider-chat',
    free: true,
    note: 'Open source - free with a local Ollama model',
    docs: 'https://aider.chat'
  },
  {
    id: 'shell',
    label: 'Shell',
    bin: PLATFORM === 'win32' ? 'powershell' : 'bash',
    args: PLATFORM === 'win32' ? ['-NoLogo'] : [],
    color: '#8b8b99',
    free: true,
    note: 'A plain terminal in the same pane grid'
  }
]

/** Built-ins first, then the user's own entries; a custom id overrides a built-in. */
export function allAgents(custom: AgentSpec[] = []): AgentSpec[] {
  const out = [...BUILTIN_AGENTS]
  for (const c of custom) {
    const spec = { ...c, custom: true }
    const i = out.findIndex((a) => a.id === c.id)
    // An override keeps the built-in's cosmetics (colour, note, model list) unless
    // the custom entry sets its own, so "point Claude at a different exe" does not
    // silently lose the model menu.
    if (i >= 0) out[i] = { ...out[i], ...stripEmpty(spec) }
    else out.push(spec)
  }
  return out
}

function stripEmpty(spec: AgentSpec): Partial<AgentSpec> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(spec)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out as Partial<AgentSpec>
}

export function findAgent(agents: AgentSpec[], id: string | undefined): AgentSpec {
  return agents.find((a) => a.id === id) ?? agents[0]
}

/** The install command for this machine, or '' when the agent has no scripted install. */
export function installCommand(spec: AgentSpec, platform: string = PLATFORM): string {
  if (platform === 'win32') return spec.installWin ?? spec.install ?? ''
  if (platform === 'darwin') return spec.installMac ?? spec.install ?? ''
  return spec.install ?? ''
}

/** The uninstall command for this machine, or '' when the agent has no scripted removal. */
export function uninstallCommand(spec: AgentSpec, platform: string = PLATFORM): string {
  if (platform === 'win32') return spec.uninstallWin ?? spec.uninstall ?? ''
  if (platform === 'darwin') return spec.uninstallMac ?? spec.uninstall ?? ''
  return spec.uninstall ?? ''
}

/**
 * The toolchain an install line needs before it can run at all.
 *
 * Most of this catalogue is `npm i -g`, which on a machine with no Node says
 * "npm is not recognized" and nothing else - the one failure a person who is not a
 * developer cannot act on, and the reason a fresh Windows box could install none of
 * these. Reading it off the command rather than a field per agent means a custom
 * agent someone adds in Settings gets the same treatment.
 */
export type Prereq = 'node' | 'python'

export function prereqFor(command: string): { need: Prereq; bin: string } | null {
  const c = command.trim().toLowerCase()
  if (/^(npm|npx)\b/.test(c) || /&&\s*(npm|npx)\b/.test(c)) return { need: 'node', bin: 'npm' }
  if (/^python\b|^pip3?\b|\bpython -m pip\b/.test(c)) return { need: 'python', bin: 'python' }
  return null
}

/** How to get that toolchain, per platform. '' when we should not guess. */
export function prereqInstall(need: Prereq, platform: string = PLATFORM): string {
  if (platform === 'win32') {
    return need === 'node'
      ? 'winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements'
      : 'winget install --id Python.Python.3.12 -e --accept-package-agreements --accept-source-agreements'
  }
  if (platform === 'darwin') return need === 'node' ? 'brew install node' : 'brew install python'
  return ''
}

/** Where to send someone whose machine has no package manager to bootstrap from. */
export function prereqDocs(need: Prereq): string {
  return need === 'node' ? 'https://nodejs.org/en/download' : 'https://www.python.org/downloads/'
}

export function modelValue(m: ModelChoice): string {
  return typeof m === 'string' ? m : m.value
}

export function modelLabel(m: ModelChoice): string {
  return typeof m === 'string' ? m : m.label
}

export function modelHint(m: ModelChoice): string | undefined {
  return typeof m === 'string' ? undefined : m.hint
}

/** Full argv for one launch: resume form or fresh form, plus the model. */
export function buildArgs(
  spec: AgentSpec,
  opts: { resume?: boolean; resumeId?: string; model?: string }
): string[] {
  const named = opts.resume && opts.resumeId && spec.resumeIdArgs
  const argv = named
    ? [...(spec.resumeIdArgs as string[]), opts.resumeId as string]
    : opts.resume && spec.resumeArgs
      ? [...spec.resumeArgs]
      : [...(spec.args ?? [])]
  const model = opts.model?.trim()
  if (!model) return argv
  if (spec.modelStyle === 'arg') argv.push(model)
  else if (spec.modelFlag) argv.push(spec.modelFlag, model)
  return argv
}

/** True when this agent can take a model at all - drives whether the UI shows the menu. */
export function supportsModel(spec: AgentSpec | undefined): boolean {
  return Boolean(spec && (spec.modelFlag || spec.modelStyle === 'arg'))
}
