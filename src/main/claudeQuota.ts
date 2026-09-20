import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const GUARDECK_USAGE = '/Applications/GuardDeck.app/Contents/Helpers/CodexBar/CodexBarCLI'
const CACHE_MS = 60_000

type WindowValue = {
  usedPercent?: unknown
  resetsAt?: unknown
}

type ClaudeUsage = {
  primary?: WindowValue
  secondary?: WindowValue
  extraRateWindows?: Array<{ title?: unknown; window?: WindowValue }>
}

export type ClaudeQuotaBlock = {
  scope: 'five-hour' | 'weekly' | 'fable'
  usedPercent: number
  resetsAt?: string
  message: string
}

const cached = new Map<string, { at: number; block: ClaudeQuotaBlock | null }>()
const pending = new Map<string, Promise<ClaudeQuotaBlock | null>>()

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function resetTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined
  return value
}

function resetLabel(value: string | undefined): string {
  if (!value) return 'its next reset'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function block(scope: ClaudeQuotaBlock['scope'], window: WindowValue): ClaudeQuotaBlock | null {
  const usedPercent = percent(window.usedPercent)
  if (usedPercent === undefined || usedPercent < 100) return null
  const resetsAt = resetTime(window.resetsAt)
  const name = scope === 'five-hour' ? 'five-hour' : scope === 'weekly' ? 'weekly' : 'Fable weekly'
  return {
    scope,
    usedPercent,
    resetsAt,
    message: `Claude's ${name} usage is exhausted until ${resetLabel(resetsAt)}. Choose Codex or wait for the reset.`
  }
}

/**
 * Turn CodexBar's provider-neutral payload into the one decision PaneForge needs.
 * The all-model windows outrank a model-scoped window because either one is sufficient
 * to refuse the launch. Unknown or incomplete telemetry does not invent exhaustion.
 */
export function claudeQuotaBlock(payload: unknown, model?: string): ClaudeQuotaBlock | null {
  if (!Array.isArray(payload)) return null
  const row = payload.find((item) => {
    if (!item || typeof item !== 'object') return false
    return (item as { provider?: unknown }).provider === 'claude'
  }) as { usage?: ClaudeUsage } | undefined
  const usage = row?.usage
  if (!usage || typeof usage !== 'object') return null

  const primary = usage.primary && block('five-hour', usage.primary)
  if (primary) return primary
  const secondary = usage.secondary && block('weekly', usage.secondary)
  if (secondary) return secondary

  if ((model ?? '').toLowerCase().includes('fable')) {
    const scoped = Array.isArray(usage.extraRateWindows)
      ? usage.extraRateWindows.find((entry) =>
          typeof entry?.title === 'string' && entry.title.toLowerCase().includes('fable'))
      : undefined
    if (scoped?.window) return block('fable', scoped.window)
  }
  return null
}

function readUsage(model?: string): Promise<ClaudeQuotaBlock | null> {
  return new Promise((resolve, reject) => {
    execFile(
      GUARDECK_USAGE,
      ['usage', '--provider', 'claude', '--source', 'web', '--format', 'json', '--json-only', '--no-credits'],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Could not check Claude usage before opening it: ${error.message}`))
          return
        }
        try {
          resolve(claudeQuotaBlock(JSON.parse(stdout), model))
        } catch (cause) {
          reject(new Error(
            `Could not check Claude usage before opening it: ${String((cause as Error)?.message ?? cause)}`
          ))
        }
      }
    )
  })
}

/** Check the existing authenticated usage feed without sending a Claude model request. */
export async function currentClaudeQuotaBlock(model?: string, fresh = false): Promise<ClaudeQuotaBlock | null> {
  if (!existsSync(GUARDECK_USAGE)) return null
  const key = (model ?? '').trim().toLowerCase()
  const prior = cached.get(key)
  if (!fresh && prior && Date.now() - prior.at < CACHE_MS) return prior.block
  const inflight = pending.get(key)
  if (!fresh && inflight) return inflight
  const request = readUsage(model).then((result) => {
    cached.set(key, { at: Date.now(), block: result })
    return result
  }).finally(() => {
    pending.delete(key)
  })
  pending.set(key, request)
  return request
}

/** Refuse only real Claude starts/sends. An asleep restored card does not contact Claude. */
export async function guardClaudeUsage(agent: unknown, model?: string, asleep = false): Promise<void> {
  const id = typeof agent === 'string'
    ? agent
    : ((agent as { id?: unknown } | null)?.id ?? 'claude')
  if (id !== 'claude' || asleep) return
  const exhausted = await currentClaudeQuotaBlock(model)
  if (exhausted) throw new Error(exhausted.message)
}
