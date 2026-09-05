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
export type ModelChoice =
  | string
  | {
      value: string
      label: string
      hint?: string
      /** menu heading; set when a list mixes hand-written shortcuts with a fetched one */
      group?: string
      /**
       * The human half of the hint - "fastest", "the one this entry was added for".
       *
       * Separate from `hint` because `hint` is where the PRICE lives, and a price typed
       * into this file is out of date the week after it is written. When the live
       * catalogue carries this id its hint REPLACES the hand-written one, and this is
       * what is kept and appended: the number comes from OpenRouter, the judgement from
       * whoever put the row on the list.
       */
      note?: string
      /**
       * The agent this model belongs to, when it is NOT the one whose menu it appears in.
       *
       * A model list is per agent for a good reason - `z-ai/glm-5.2` in a plain Claude Code
       * pane is a 401 - but that made a key pasted into Settings do nothing visible: the
       * runner dropdown still says "Claude Code", so the models the key just paid for are
       * two menus away and nothing on screen says which menu. Picking one of these switches
       * the runner AND the model in one press, which is what somebody who pasted an
       * OpenRouter key was asking for.
       */
      agent?: string
    }

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
  /**
   * args prepended to EVERY launch of this agent, fresh or resumed. `args` is the
   * fresh-session form and is dropped on a resume, so a flag that must hold for the
   * whole life of the pane cannot live there.
   */
  alwaysArgs?: string[]
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
  /**
   * How to move it to the newest release, same per-platform shape as `install`.
   *
   * Separate from `install` because for most of this catalogue they are NOT the same
   * line: `npm i -g` does update an npm package, but Codex ships its own `codex update`
   * that knows which of the four ways it might have been installed was used here, and
   * re-running an installer script instead would be this app guessing.
   */
  update?: string
  updateWin?: string
  updateMac?: string
  /** usable with no paid subscription (free tier, own API key, or fully local) */
  free?: boolean
  /** one line shown under the name in Settings: what it costs, what it needs */
  note?: string
  /** where to read more; opened in the browser from Settings */
  docs?: string
  /**
   * Environment the pty is started with, on top of the app's own.
   *
   * This is what makes a provider an entry in this catalogue rather than a branch in
   * the spawn path: every one of these CLIs is pointed at a different model by env
   * vars and nothing else, so "Claude Code on GLM" is a spec with two variables set
   * and the same binary as "Claude Code".
   *
   * A value of exactly `${OPENROUTER_KEY}` is filled in from Settings by
   * `resolveEnv`, which DROPS the variable when the key is blank rather than passing
   * the placeholder through - an agent that authenticates with the literal string
   * `${OPENROUTER_KEY}` fails as a 401 inside a healthy-looking pane, which is the
   * one failure nobody can act on.
   */
  env?: Record<string, string>
  /** true for entries the user added in Settings */
  custom?: boolean
}

/** A spec plus what the machine actually has installed. */
export interface AgentInfo extends AgentSpec {
  available: boolean
  /** resolved absolute path, empty when not found */
  path: string
  /** the release on this machine, when the CLI was asked and answered */
  version?: string
  /**
   * The CLI says a newer release exists.
   *
   * Absent means nobody asked or nobody could tell - never "it is current". The only
   * thing built on this is offering an Update button, and a button offered on a guess
   * is worse than no button.
   */
  outdated?: boolean
  /** what `outdated` is measured against, so the button can say the number */
  latest?: string
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

/** The placeholder an agent's `env` uses to ask for the OpenRouter key from Settings. */
export const OPENROUTER_KEY_VAR = '${OPENROUTER_KEY}'

/**
 * OpenRouter's own address, and the one it answers the Anthropic Messages API on.
 *
 * NO `/v1` - the CLI appends `/v1/messages` itself, exactly as the DeepSeek and Z.ai
 * entries below document. This carried the suffix for eight days and every OpenRouter
 * pane in that time posted to `https://openrouter.ai/api/v1/v1/messages`, which is a
 * 404 HTML page. What the CLI prints for that is NOT a transport error: it is
 * `There's an issue with the selected model (<id>). It may not exist or you may not
 * have access to it.` - a sentence about the MODEL, in a pane whose model is fine, so
 * every report of it was a hunt for a model id that did not need fixing. Measured
 * 2026-08-23 against the real `claude` binary: with `/api/v1` both `stealth/ox-alpha`
 * and `z-ai/glm-5.2` print that line and exit; with `/api` both answer.
 */
export const OPENROUTER_BASE = 'https://openrouter.ai/api'

// A shortcut list, same as every other one here - OpenRouter carries hundreds of ids
// and any of them can be typed. These are the ones worth reaching for by name: GLM is
// what this entry was added for, and the rest are the other cheap long-context models
// that answer on the same key.
//
// Measured against openrouter.ai/api/v1/models on 2026-08-15. Prices are per million
// input tokens and are in the hint because the whole point of this entry is that a
// pane can cost a fiftieth of what the same pane costs on a frontier model.
//
// This is no longer the whole menu: `main/orModels.ts` fetches OpenRouter's own
// catalogue and `mergeOrModels` appends it, so a model published after this build was
// cut still reaches the picker. These stay because a hand-written row says WHY a model
// is worth reaching for, which a price and a context length cannot.
const OPENROUTER_MODELS: ModelChoice[] = [
  // Free, 1M context, tool calling, and published 2026-08-20 - after the prices below
  // were measured, which is the case the live catalogue exists for. "Stealth" means the
  // provider will not say who it is and KEEPS every prompt and completion (its terms say
  // it does not train on them). That belongs in the hint, where the choice is made,
  // rather than in a document nobody opens.
  {
    value: 'stealth/ox-alpha',
    label: 'Ox Alpha',
    hint: 'free · 1M context · anonymous provider keeps your prompts'
  },
  { value: 'z-ai/glm-5.2', label: 'GLM 5.2', hint: '$1.19/M · 1M context' },
  { value: 'z-ai/glm-5', label: 'GLM 5', hint: '$0.60/M' },
  { value: 'z-ai/glm-4.7', label: 'GLM 4.7', hint: '$0.40/M' },
  { value: 'z-ai/glm-4.7-flash', label: 'GLM 4.7 Flash', hint: '$0.06/M', note: 'fastest' },
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek' },
  { value: 'qwen/qwen3-coder', label: 'Qwen3 Coder' },
  { value: 'moonshotai/kimi-k2', label: 'Kimi K2' }
]

/**
 * Every Claude Code pane starts with permission prompts off. This is a deliberate
 * choice for a machine whose whole point is unattended lanes: a pane that stops on a
 * prompt is a lane that has silently stopped working, and the prompts were answered
 * "yes" every time anyway.
 *
 * `--dangerously-skip-permissions` STARTS the session in bypass;
 * `--allow-dangerously-skip-permissions` would only make the mode reachable from
 * shift+tab. Swap to the latter if a pane should ask by default again.
 */
const BYPASS_ARGS = ['--dangerously-skip-permissions']

// Model lists are deliberately short: they are a shortcut, not a whitelist. The UI
// lets you type any model string, so a CLI renaming its models cannot break launches.
export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    // Permission mode is decided at LAUNCH, not from settings: the CLI reads argv into
    // `isBypassPermissionsModeAvailable` and there is no settings key or env var that
    // turns it on afterwards, so without this flag shift+tab cannot reach bypass at all.
    alwaysArgs: BYPASS_ARGS,
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
    // Claude Code with two environment variables changed, which is all it takes:
    // OpenRouter answers the Anthropic Messages API at /api/v1/messages (probed
    // 2026-08-15 - it returns Anthropic's own `authentication_error` shape rather
    // than a 404, which is how you tell a real implementation from a rewrite of the
    // chat-completions endpoint). So the pane, the resume, the transcript and every
    // feature in this app that reads a Claude pane keep working, and the model
    // underneath is GLM.
    //
    // It is a separate id rather than a switch on `claude` on purpose: the two have
    // different conversation histories, different costs and different failure modes,
    // and a pane must say which one it is on its card.
    id: 'openrouter',
    label: 'Claude Code on OpenRouter',
    bin: 'claude',
    alwaysArgs: BYPASS_ARGS,
    resumeArgs: ['--continue'],
    resumeIdArgs: ['--resume'],
    modelFlag: '--model',
    models: OPENROUTER_MODELS,
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY_VAR,
      // Without this the CLI keeps talking to Anthropic's own telemetry and consent
      // endpoints with a token they have never heard of, which is a stream of
      // failures in a pane whose actual turns are fine.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    },
    color: '#8b5cf6',
    install: 'npm i -g @anthropic-ai/claude-code',
    uninstall: 'npm rm -g @anthropic-ai/claude-code',
    free: true,
    note: 'One OpenRouter key, any model on it - free ones included. Paste the key in Settings.',
    docs: 'https://openrouter.ai/docs/community/claude-code'
  },
  {
    // Same shape as the OpenRouter entry and for the same reason, but pointed at
    // DeepSeek's own Anthropic-protocol endpoint rather than at a broker: one hop
    // fewer, and the price is DeepSeek's rather than DeepSeek's plus a margin.
    //
    // The base URL carries the `/anthropic` suffix and NO `/v1` - the CLI appends
    // `/v1/messages` itself, so the request lands on
    // `https://api.deepseek.com/anthropic/v1/messages`. Probed 2026-08-18 with a junk
    // key: it answers 401 `authentication_error` in Anthropic's own error shape, which
    // is how a real implementation of that API is told from a rewrite of the
    // chat-completions one. Bare `api.deepseek.com` is the OpenAI-compatible endpoint
    // and is NOT a documented Messages host - it also answered 401 to that probe, so
    // the suffix is taken from DeepSeek's own Claude Code page rather than from a
    // failure that would announce itself. That page is also where `ANTHROPIC_AUTH_TOKEN`
    // (not `ANTHROPIC_API_KEY`) comes from.
    id: 'deepseek',
    label: 'Claude Code on DeepSeek',
    bin: 'claude',
    alwaysArgs: BYPASS_ARGS,
    resumeArgs: ['--continue'],
    resumeIdArgs: ['--resume'],
    modelFlag: '--model',
    // `[1m]` is not a decoration: it is the model id DeepSeek's own config example
    // uses to ask for the 1M-context variant, and it is passed through verbatim.
    models: [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', hint: 'strongest' },
      { value: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro 1M', hint: '1M context' },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', hint: 'fast, cheapest' }
    ],
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: keyVar('deepseek'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    },
    color: '#4d6bfe',
    install: 'npm i -g @anthropic-ai/claude-code',
    uninstall: 'npm rm -g @anthropic-ai/claude-code',
    free: true,
    note: 'DeepSeek key in Settings - no subscription, pay per token',
    docs: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/'
  },
  {
    // Z.ai publishes no coding CLI of its own - ZCode is a desktop app and
    // `@z_ai/coding-helper` is a wizard that writes these two variables into somebody
    // else's tool. So this entry IS that wizard's output, without the wizard.
    //
    // `/api/anthropic`, no `/v1`, same rule as DeepSeek above. The OpenAI-compatible
    // `/api/paas/v4` and the Coding-Plan `/api/coding/paas/v4` are different endpoints
    // and neither speaks the Messages API.
    id: 'glm',
    label: 'Claude Code on GLM',
    bin: 'claude',
    alwaysArgs: BYPASS_ARGS,
    resumeArgs: ['--continue'],
    resumeIdArgs: ['--resume'],
    modelFlag: '--model',
    models: [
      { value: 'glm-5.2', label: 'GLM 5.2', hint: 'flagship' },
      { value: 'glm-5.2[1m]', label: 'GLM 5.2 1M', hint: '1M context' },
      { value: 'glm-5.1', label: 'GLM 5.1' },
      { value: 'glm-5', label: 'GLM 5' },
      { value: 'glm-4.7', label: 'GLM 4.7' },
      { value: 'glm-4.7-flashx', label: 'GLM 4.7 FlashX', hint: 'fastest' }
    ],
    env: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: keyVar('zai'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    },
    color: '#14b8a6',
    install: 'npm i -g @anthropic-ai/claude-code',
    uninstall: 'npm rm -g @anthropic-ai/claude-code',
    free: true,
    note: 'Z.ai key in Settings - pay per token, or a GLM Coding Plan',
    docs: 'https://docs.z.ai/devpack/tool/claude'
  },
  {
    // xAI's own CLI, NOT Claude Code with a base URL: x.ai documents an
    // OpenAI-compatible endpoint and nothing else, and the "Grok speaks the Anthropic
    // Messages API" claims in circulation trace to no xAI-owned page. Shipping that as
    // a spec would be a pane that 404s several seconds into its first turn, which is
    // the one failure this catalogue is written to avoid.
    id: 'grok',
    label: 'Grok Build',
    bin: 'grok',
    modelFlag: '--model',
    models: [{ value: 'grok-4.6', label: 'Grok 4.6', hint: 'coding and agentic work' }],
    // Offered rather than required: the CLI signs in on its own as well, so a blank
    // key box leaves it on whatever login this machine already has.
    env: { XAI_API_KEY: keyVar('xai') },
    color: '#cbd5e1',
    // The curl script is the install x.ai documents. On Windows there is no shell to
    // pipe it into, so that platform gets the npm package instead.
    installMac: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    installWin: 'npm i -g @xai-official/grok',
    uninstallWin: 'npm rm -g @xai-official/grok',
    note: 'xAI account, or an xAI key in Settings',
    docs: 'https://docs.x.ai/build/overview'
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    // `resume` is a subcommand, not a flag, so it has to lead the argv.
    resumeArgs: ['resume', '--last'],
    // Codex 0.153.4 accepts `codex resume <SESSION_ID> [PROMPT]`; a named restore
    // must never fall back to `--last`, which can reopen a different conversation.
    resumeIdArgs: ['resume'],
    modelFlag: '-m',
    // Measured 2026-08-11 against a ChatGPT-plan login: every `gpt-5.1-codex*` id
    // is answered `400 invalid_request_error - not supported when using Codex with
    // a ChatGPT account`, and the CLI reports that as an error INSIDE a pane that
    // otherwise looks healthy, so a pane launched on one sits there having burned
    // its prompt. Only the ids below answer on a subscription login; an API-key
    // user can still type any string, which is what the list is for.
    // These are display names as well as picker choices. Leaving them as bare ids made
    // a Sol pane look like it had no model identity on a crowded card, while Terra was
    // only recognisable to somebody who knew the raw CLI spelling.
    // These are the FALLBACK, not the list. Codex keeps its own catalogue on disk and
    // `main/codexModels.ts` reads it, so a model published after this build was cut -
    // `gpt-6-astra` was, on a build whose list held only the two below - arrives at the
    // top of the picker with no edit here. What is left here is what to offer on a
    // machine whose Codex has never run and so has written no cache.
    models: [
      { value: 'gpt-6-astra', label: 'GPT-6 Astra', hint: 'newest, most capable' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', hint: 'balanced' },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', hint: 'deep reasoning' }
    ],
    color: '#10a37f',
    install: 'npm i -g @openai/codex',
    // Its own updater, not `npm i -g`: Codex can be installed four ways (npm, brew, the
    // shell script, the Desktop app) and this command is the one that knows which was
    // used here. Running the npm line over a brew install leaves two of them on PATH.
    update: 'codex update',
    uninstall: 'npm rm -g @openai/codex',
    note: 'ChatGPT plan or OpenAI API key',
    docs: 'https://developers.openai.com/codex/cli'
  },
  {
    // Where Gemini CLI's consumer login WENT, and why Gemini CLI is no longer in this
    // catalogue at all. Google moved the free, Pro and Ultra tiers onto this client on
    // 2026-06-18 and ended the old client's sign-in on 2026-08-23, leaving that binary
    // reachable only with a paid AI Studio key - a second, worse way to run Google's
    // models, offered beside this one. Removed 2026-08-26 on Robert's word. This is the
    // one that still signs in with a Google account, and a Google AI
    // Pro/Ultra subscription raises its limits rather than being the price of entry.
    //
    // A Go binary from Google's own installer, NOT an npm package - `npm i -g` finds only
    // unrelated community packages of the same name. It lands in `~/.local/bin/agy` on
    // macOS and Linux and `%LOCALAPPDATA%\agy\bin` on Windows, both of which `which.ts`
    // hydrates, so a pane finds it without the user's shell profile.
    id: 'antigravity',
    label: 'Antigravity CLI',
    bin: 'agy',
    // `--continue` is the newest conversation in this folder; `--conversation <id>` is the
    // one this pane was in. Both measured off `agy --help` (v1.1.21).
    resumeArgs: ['--continue'],
    resumeIdArgs: ['--conversation'],
    modelFlag: '--model',
    // No model list on purpose. The flag exists, but Google publishes no model IDS for it
    // anywhere - `agy models` refuses until the CLI is signed in, and the pricing page
    // names models in prose ("Gemini 3.1 Pro", "Claude Sonnet & Opus 4.6") rather than by
    // id. A guessed id here is a pane that dies on launch with a sentence about a model,
    // which is the exact failure the OpenRouter entry above documents. `/model` inside the
    // TUI picks one from the live list and persists it, and anything typed still reaches
    // the flag.
    color: '#5b6ef5',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    installWin: 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
    // No uninstall: the installer appends a PATH line to five shell profiles, and a button
    // that deletes the binary and leaves those behind is the half-removal this field's
    // contract refuses.
    free: true,
    note: 'Signs in with your Google account - AI Pro/Ultra raises the limits',
    docs: 'https://antigravity.google/docs/cli/getting-started'
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
    // Node 22 is its `engines` floor, not a suggestion: npm installs it anyway on
    // Node 20 with a warning nobody reads in an install log, and the CLI then fails
    // at its first launch inside a pane that looks like a bad install.
    note: 'Free daily quota with a Qwen account - needs Node 22+',
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
    models: [
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.1-codex',
      'google/gemini-2.5-pro',
      { value: 'openrouter/z-ai/glm-5.2', label: 'GLM 5.2 (OpenRouter)' }
    ],
    // Its OpenRouter provider reads this and nothing else, so one key in Settings
    // reaches every CLI here that speaks OpenRouter.
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY_VAR },
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
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY_VAR },
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
    models: [
      'sonnet',
      'gpt-5',
      'gemini/gemini-2.5-pro',
      'ollama/qwen2.5-coder',
      { value: 'openrouter/z-ai/glm-5.2', label: 'GLM 5.2 (OpenRouter)' }
    ],
    env: { OPENROUTER_API_KEY: OPENROUTER_KEY_VAR },
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
/**
 * The CLIs that read an image off the OS clipboard when a raw ^V reaches them.
 *
 * Claude Code does; the other twelve take a PATH and read the file. It matters for what a
 * dropped screenshot becomes: for these, the bytes can be put on the clipboard and pasted,
 * so the agent attaches a real IMAGE ("[Image #1]") and can see it. For the rest, a path
 * typed at the prompt is the only thing that works at all.
 *
 * `openrouter`, `deepseek` and `glm` are Claude Code with a different base URL, so they
 * read the clipboard too - the binary is what decides this, never the model behind it.
 */
const CLIPBOARD_IMAGE_AGENTS = new Set([
  'claude',
  'openrouter',
  'deepseek',
  'glm',
  'claude-code',
  'anthropic'
])

/** Would a raw ^V put an image in front of this agent, rather than nothing? */
export function pastesClipboardImage(agent: string | undefined): boolean {
  return !!agent && CLIPBOARD_IMAGE_AGENTS.has(agent)
}

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

/**
 * Does this machine know that agent at all?
 *
 * `findAgent` falls back to `agents[0]` - Claude Code - which is right for a LABEL and
 * catastrophic for a LAUNCH: a pane asked for on another device travels as a bare id, and
 * a device on an older build (measured 2026-08-27: the PC on 0.8.157, which predates the
 * Antigravity entry) does not have it. The fallback then spawned `claude` in a pane the
 * person had asked to run something else, with nothing on screen saying so. A start must
 * refuse a name it does not know, so the caller can say WHICH machine is missing WHAT.
 */
export function hasAgent(agents: AgentSpec[], id: string | undefined): boolean {
  return !id || agents.some((a) => a.id === id)
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
 * The update command for this machine, or '' when the agent has no scripted update.
 *
 * Falls back to the INSTALL line, which is right for every `npm i -g` in this catalogue:
 * re-running it is how npm moves a global package forward. It is NOT right for the two
 * shell-script installers here, which is why both of those name their own `update`.
 */
export function updateCommand(spec: AgentSpec, platform: string = PLATFORM): string {
  const own = platform === 'win32' ? spec.updateWin : platform === 'darwin' ? spec.updateMac : undefined
  return own ?? spec.update ?? installCommand(spec, platform)
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

/** The menu heading a choice sits under, when its list has headings at all. */
export function modelGroup(m: ModelChoice): string | undefined {
  return typeof m === 'string' ? undefined : m.group
}

/** The runner a choice belongs to, when picking it also changes the runner. */
export function modelAgent(m: ModelChoice): string | undefined {
  return typeof m === 'string' ? undefined : m.agent
}

/**
 * Models from the OTHER runners that share this one's binary and have their key.
 *
 * Every "Claude Code on <provider>" entry here is the same binary with two variables
 * set, so the CLI in the pane is identical and only the endpoint differs - which is
 * exactly why a person who pasted an OpenRouter key expects its models where the models
 * are. They are offered on the sibling's own heading, so nothing pretends a GLM id will
 * run against Anthropic, and picking one carries `agent` so the press switches both.
 *
 * Two refusals, and both are the point:
 *   - **only a provider whose key is actually saved.** Offering a model that cannot
 *     authenticate is a pane that 401s inside a healthy-looking window, the failure this
 *     repo refuses everywhere else. `hasKey` is passed in so this stays pure.
 *   - **only a sibling on the same `bin`.** Codex's models in Claude Code's menu would be
 *     a launch that dies in a second, and the runner dropdown is still one press away.
 */
export function siblingModels(
  spec: AgentSpec,
  all: AgentSpec[],
  hasKey: (provider: string) => boolean
): ModelChoice[] {
  if (!supportsModel(spec)) return []
  const mine = new Set((spec.models ?? []).map(modelValue))
  const out: ModelChoice[] = []
  for (const other of all) {
    if (other.id === spec.id || other.bin !== spec.bin || !supportsModel(other)) continue
    const provider = keyProviderFor(other)
    if (!provider || !hasKey(provider)) continue
    for (const m of other.models ?? []) {
      const value = modelValue(m)
      if (mine.has(value)) continue
      mine.add(value)
      const heading = modelGroup(m)
      out.push({
        value,
        label: modelLabel(m),
        hint: modelHint(m),
        // The PROVIDER's name, never the runner's. "Claude Code on OpenRouter" as a
        // heading over a model list reads as a second product to choose between, which
        // is the confusion this borrowing exists to remove - the runner is plumbing and
        // the person is picking a model. "OpenRouter · Free" says where the model comes
        // from and what it costs, which is the whole of the decision.
        group: heading ? `${providerLabel(provider) ?? other.label} · ${heading}` : providerLabel(provider) ?? other.label,
        agent: other.id
      })
    }
  }
  return out
}

/** What Settings calls a provider, for the heading its models sit under. */
export function providerLabel(id: string): string | undefined {
  return KEY_PROVIDERS.find((p) => p.id === id)?.label
}

/** The friendly model name for a pane card, without ever changing what reaches the CLI. */
export function agentModelLabel(agent: Pick<AgentSpec, 'models'> | undefined, value: string): string {
  const choice = agent?.models?.find((m) => modelValue(m) === value)
  if (choice) return modelLabel(choice)
  // An id this build's catalogue does not have is not a model NAME anybody can act on: a
  // pane saved before a rename kept `builtin` on it for months and drew it as a chip beside
  // Claude Code, which defines no such id. So a runner that HAS a catalogue answers ''
  // - the card draws no chip - and the raw value stays on the hover, where it is evidence
  // rather than a label.
  //
  // A runner with NO catalogue is the opposite case and must still print it: Antigravity
  // ships no model list on purpose (Google publishes the names in prose and the ids
  // nowhere), so whatever was typed there is the only thing that says which model this is.
  return agent?.models?.length ? '' : value
}

/**
 * The keys Settings holds, by provider id. `Record`, not a field per provider: the
 * providers are a list here, so a new one is an entry in `KEY_PROVIDERS` and nothing
 * else - a typed field would need a matching edit in the config, the settings dialog
 * and the session spawn, which is three places for one fact.
 */
export type AgentKeys = Record<string, string | undefined>

/** Where one provider's key comes from, and what it is called on the way in. */
export interface KeyProvider {
  /** stable id, and the key under which the pasted string is stored in config */
  id: string
  label: string
  /** the literal an agent's `env` uses to ask for it, e.g. `${OPENROUTER_KEY}` */
  placeholder: string
  /** shown in the empty input, so a pasted key can be eyeballed as the right shape */
  hint: string
  /** where to go and make one */
  url: string
  /** one line under the field: what having this key buys */
  note: string
}

/** The literal an `env` value uses to ask Settings for a provider's key. */
export function keyVar(id: string): string {
  return '${' + id.toUpperCase() + '_KEY}'
}

/**
 * Every provider PaneForge can hold a key for.
 *
 * Adding a provider is an entry here plus an agent whose `env` names `keyVar(id)`.
 * Settings draws its field off this list, so there is no per-provider UI to forget.
 */
export const KEY_PROVIDERS: KeyProvider[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    placeholder: OPENROUTER_KEY_VAR,
    hint: 'sk-or-...',
    url: 'https://openrouter.ai/keys',
    note: 'One key, hundreds of models - GLM, DeepSeek, Qwen, Kimi, Grok.'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    placeholder: keyVar('deepseek'),
    hint: 'sk-...',
    url: 'https://platform.deepseek.com/api_keys',
    note: 'Runs Claude Code straight on DeepSeek V4, at DeepSeek prices.'
  },
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    placeholder: keyVar('zai'),
    hint: 'your Z.ai API key',
    url: 'https://z.ai/manage-apikey/apikey-list',
    note: 'Runs Claude Code on GLM 5.2, including a GLM Coding Plan subscription.'
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    placeholder: keyVar('xai'),
    hint: 'xai-...',
    url: 'https://console.x.ai',
    note: 'The key Grok Build reads. It can also sign in on its own.'
  }
]

const KEY_BY_PLACEHOLDER = new Map(KEY_PROVIDERS.map((p) => [p.placeholder, p.id]))

/**
 * The extra environment one agent's pty gets, with the key placeholders filled in.
 *
 * A variable whose value is a placeholder and whose key is blank is DROPPED, never
 * passed through. A CLI given `ANTHROPIC_AUTH_TOKEN=${OPENROUTER_KEY}` authenticates
 * with that literal string and fails as a 401 several seconds into a pane that looks
 * perfectly healthy; dropped, it falls back to whatever login the machine already has
 * and says so in its own words on the first line.
 *
 * An UNKNOWN placeholder is dropped too. It can only mean a custom agent asking for a
 * provider this build has never heard of, and handing a CLI the literal `${FOO_KEY}`
 * is the exact failure above with nobody to blame it on.
 */
export function resolveEnv(spec: AgentSpec, keys: AgentKeys = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (/^\$\{[A-Z0-9_]+\}$/.test(v)) {
      const provider = KEY_BY_PLACEHOLDER.get(v)
      const key = provider ? keys[provider]?.trim() : ''
      if (key) out[k] = key
      continue
    }
    out[k] = v
  }
  return out
}

/**
 * The provider whose key this agent AUTHENTICATES with, or '' when it has a login of
 * its own. Only the entries whose auth token is the placeholder, never the ones that
 * merely pass a key along: opencode and aider run on their own logins and take
 * OpenRouter as one option among several.
 */
export function keyProviderFor(spec: AgentSpec): string {
  // GEMINI_API_KEY is here for the same reason the Anthropic pair is and NOT for the
  // reason XAI_API_KEY is absent: Grok can still sign itself in, and Gemini CLI cannot
  // any more - its own login now answers `UNSUPPORTED_CLIENT`. So a Gemini pane with no
  // key is blocked, and Settings must say so rather than leaving somebody to find out
  // when the pane's first turn dies.
  const token =
    spec.env?.ANTHROPIC_AUTH_TOKEN ?? spec.env?.ANTHROPIC_API_KEY ?? spec.env?.GEMINI_API_KEY ?? ''
  return KEY_BY_PLACEHOLDER.get(token) ?? ''
}

/** Whether this agent cannot run at all until a key is pasted into Settings. */
export function needsOpenRouterKey(spec: AgentSpec): boolean {
  return keyProviderFor(spec) === 'openrouter'
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
  if (spec.alwaysArgs?.length) argv.unshift(...spec.alwaysArgs)
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
