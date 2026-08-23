// What a pane running on somebody else's inference provider may still see.
//
// `shared/agents.ts` makes "Claude Code on GLM" one binary pointed at another host,
// which is a catalogue entry and nothing more. The thing that entry does NOT change is
// the environment the pty inherits: the app's own `process.env`, whole. So a pane whose
// every prompt, file read and tool result is posted to a third party was starting with
// this machine's OTHER inference credentials in its environment - an `ANTHROPIC_API_KEY`
// that a Z.ai pane has no use for, and that an agent can print, echo into a command, or
// be talked into using.
//
// OpenRouter says of `stealth/ox-alpha` that the provider is anonymous and that prompts
// and completions are RETAINED. A key that reaches a transcript held by somebody unnamed
// is not a key any more. Dropping it costs that pane nothing, because the credential it
// actually authenticates with is put back by `resolveEnv` one spread later.
//
// Deliberately NARROW: only inference credentials, and only for a pane already pointed
// at a third-party provider.
//
//   - `GITHUB_TOKEN`, `AWS_*`, `SSH_AUTH_SOCK` and the rest are what the pane is FOR -
//     an agent that cannot push is an agent nobody can use, so taking those is a scope
//     decision for a person, not a guard that ships itself on.
//   - A first-party Claude Code / Codex / Gemini pane keeps everything. Its provider is
//     the one whose key that is.
//
// It is also not a sandbox and must not be described as one: the agent still reads every
// file it is pointed at, and a `.env` in the repo it is working in reaches the provider
// the moment it is opened. The only thing this closes is the environment the pane starts
// with. Which repos are safe to point at a retaining provider stays a judgement.

import type { AgentSpec } from './agents'
import { KEY_PROVIDERS, PLATFORM, keyProviderFor } from './agents'

/**
 * Inference credentials, by the provider they belong to.
 *
 * Keyed by `KEY_PROVIDERS` id where there is one, so a pane keeps its OWN provider's
 * variable - a Gemini pane authenticating out of the ambient `GEMINI_API_KEY` rather
 * than out of Settings must not be broken by a guard about somebody else's key. The
 * `''` bucket is every provider PaneForge cannot be pointed at, and is dropped whole.
 */
export const PROVIDER_ENV: Record<string, string[]> = {
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zai: ['ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'],
  xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  '': [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'AZURE_OPENAI_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
    'TOGETHER_API_KEY',
    'FIREWORKS_API_KEY',
    'CEREBRAS_API_KEY',
    'PERPLEXITY_API_KEY',
    'REPLICATE_API_TOKEN',
    'HUGGINGFACE_API_KEY',
    'HF_TOKEN'
  ]
}

/**
 * Which third-party provider this agent is pointed at, by its `env` alone.
 *
 * NOT `keyProviderFor`, which answers a different question - "can this pane run at all
 * without a key" - and only looks at the three variables a CLI authenticates its MODEL
 * with. Measured against the catalogue: that reads `openrouter`, `deepseek`, `zai` and
 * `google`, and is blind to `opencode`, `crush`, `aider` and `grok`, every one of which
 * names a provider placeholder in a variable of its own. Four runners posting a repo to
 * a third party while a guard about third parties said they were first-party is exactly
 * the silent hole this file exists to close, so this asks EVERY value.
 */
export function providerOf(spec: AgentSpec): string {
  for (const v of Object.values(spec.env ?? {})) {
    const id = KEY_BY_ENV_PLACEHOLDER.get(v)
    if (id) return id
  }
  return keyProviderFor(spec)
}

const KEY_BY_ENV_PLACEHOLDER = new Map(KEY_PROVIDERS.map((p) => [p.placeholder, p.id]))

/** Whether this agent posts what it reads to a provider that is not the CLI's own. */
export function isThirdParty(spec: AgentSpec): boolean {
  return providerOf(spec) !== ''
}

/**
 * The variable names a pane on `spec` must not inherit.
 *
 * Empty for a first-party pane, always - a guard that fires where there is no third
 * party is one that breaks a working desk for nothing.
 */
export function foreignKeyVars(spec: AgentSpec): string[] {
  const mine = providerOf(spec)
  if (!mine) return []
  const out: string[] = []
  for (const [provider, vars] of Object.entries(PROVIDER_ENV)) {
    if (provider && provider === mine) continue
    out.push(...vars)
  }
  return out
}

/**
 * `env` with every other provider's inference credential removed.
 *
 * Returns a NEW object rather than editing in place: the caller spreads this into a
 * pty's environment beside `resolveEnv`, and a mutation would reach whatever else that
 * map is shared with.
 */
export function scrubForeignKeys(
  env: Record<string, string>,
  spec: AgentSpec
): Record<string, string> {
  const drop = new Set(foreignKeyVars(spec))
  if (!drop.size) return { ...env }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (!drop.has(k)) out[k] = v
  return out
}

/** Which providers this build knows a variable name for - the list the test walks. */
export const KNOWN_PROVIDER_IDS = KEY_PROVIDERS.map((p) => p.id)

/**
 * Which folders a pane on somebody else's provider may be opened in.
 *
 * The scrub above closes the pane's ENVIRONMENT. It does nothing about the far larger
 * hole, which is that an agent reads whatever it is pointed at: a `.env`, a
 * `~/.render/cli.yaml`, a Supabase service key in a config file, the transcripts under
 * `~/.claude/projects`. All of that reaches a retaining provider the moment the agent
 * opens it, and no guard inside this app can un-send it.
 *
 * So the control is the FOLDER, decided before the pty is spawned. An allowlist rather
 * than a denylist on purpose: a list of forbidden places is wrong the day a new repo is
 * cloned, and the failure is silent - the pane opens and the secret leaves. A list of
 * permitted places fails the other way, with a named refusal on screen.
 *
 * Off unless asked for. A guard that arrives switched on with an empty list refuses
 * every third-party pane on an existing desk, which reads as the feature being broken.
 */
export interface PaneTrustConfig {
  /** whether a third-party pane is confined at all */
  restrictThirdParty?: boolean
  /** absolute folders (and everything under them) such a pane may be opened in */
  allowedRoots?: string[]
}

/** `~/x` against a real home, so a root can be written the way a person says it. */
export function expandRoot(root: string, home: string): string {
  const r = root.trim()
  if (r === '~') return home
  if (r.startsWith('~/') || r.startsWith('~\\')) return home.replace(/[\\/]+$/, '') + '/' + r.slice(2)
  return r
}

/** Compare paths the way the filesystem does, without asking it anything. */
function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return PLATFORM === 'win32' ? s.toLowerCase() : s
}

/**
 * Whether `cwd` is `root` or sits under it.
 *
 * The boundary is the point: a plain `startsWith` puts `/Projects/PaneForge-secrets`
 * inside `/Projects/PaneForge`, which is the whole failure this is meant to prevent
 * and it would pass every test written with tidy paths.
 */
export function withinRoot(root: string, cwd: string): boolean {
  const r = norm(root)
  const c = norm(cwd)
  if (!r) return false
  return c === r || c.startsWith(r + '/')
}

export type TrustVerdict = { ok: true } | { ok: false; reason: string }

/**
 * May a pane running `spec` be opened in `cwd`?
 *
 * Every refusal names the folder AND the setting, because the person seeing it is
 * usually not the person who turned this on: a pane that will not open with no reason
 * given is indistinguishable from a broken agent.
 */
export function allowsCwd(
  spec: AgentSpec,
  cwd: string,
  trust: PaneTrustConfig | undefined,
  home = ''
): TrustVerdict {
  if (!trust?.restrictThirdParty) return { ok: true }
  if (!isThirdParty(spec)) return { ok: true }
  const roots = (trust.allowedRoots ?? []).map((r) => expandRoot(r, home)).filter(Boolean)
  // An empty list confines the pane to nowhere. Say that, rather than reporting it as
  // this folder being the problem - the folder is not what needs changing.
  if (!roots.length) {
    return {
      ok: false,
      reason:
        `${spec.label} sends everything it reads to another provider, and no folder is on the ` +
        `allowed list yet. Settings - Agents - "Where a third-party model may work".`
    }
  }
  if (roots.some((r) => withinRoot(r, cwd))) return { ok: true }
  return {
    ok: false,
    reason:
      `${spec.label} sends everything it reads to another provider, so it is confined to the ` +
      `folders on the allowed list. ${cwd} is not one of them - add it in Settings - Agents, ` +
      `or open this folder on a first-party model.`
  }
}
