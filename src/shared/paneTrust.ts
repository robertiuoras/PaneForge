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
import { KEY_PROVIDERS, keyProviderFor } from './agents'

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

/** Whether this agent posts what it reads to a provider that is not the CLI's own. */
export function isThirdParty(spec: AgentSpec): boolean {
  return keyProviderFor(spec) !== ''
}

/**
 * The variable names a pane on `spec` must not inherit.
 *
 * Empty for a first-party pane, always - a guard that fires where there is no third
 * party is one that breaks a working desk for nothing.
 */
export function foreignKeyVars(spec: AgentSpec): string[] {
  const mine = keyProviderFor(spec)
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
