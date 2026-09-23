// The main-side half of `shared/modelAdvice.ts`: the two facts the pure rule cannot know
// on its own (what effort level this desk is running at, and what a family resolves to
// in THIS build's catalogue), and the one place a decision is written to disk.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_AGENTS, findAgent, modelValue, type ModelChoice } from '../shared/agents'
import type { ModelFamily } from '../shared/modelAdvice'
import { logModelAdvice } from './activationLog'

/** Same override Claude Code itself honours - `claudeTrust.ts` reads the same folder. */
function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return override || join(homedir(), '.claude')
}

let cachedEffort: { at: number; level: string } | undefined
/** A settings file changes about as often as somebody opens Settings - a minute of
 * staleness costs nothing and saves a disk read on every single ask. */
const EFFORT_CACHE_MS = 60_000

/**
 * The effort level Claude Code itself is configured to run at, from
 * `~/.claude/settings.json`'s `effortLevel` - read once, cached, and never assumed:
 * a settings file that has never mentioned the key answers 'medium' rather than nothing,
 * because "unknown" and "the CLI's own default" are the same fact from here.
 */
export function currentEffortLevel(now = Date.now()): string {
  if (cachedEffort && now - cachedEffort.at < EFFORT_CACHE_MS) return cachedEffort.level
  let level = 'medium'
  try {
    const path = join(claudeHome(), 'settings.json')
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { effortLevel?: unknown }
      const found = String(raw?.effortLevel || '').trim().toLowerCase()
      if (found) level = found
    }
  } catch {
    /* unreadable or not JSON - 'medium' stands, same as "never set" */
  }
  cachedEffort = { at: now, level }
  return level
}

/** Claude Code's own model catalogue, `shared/agents.ts` `CLAUDE_MODELS`. */
const CLAUDE_MODELS: ModelChoice[] = findAgent(BUILTIN_AGENTS, 'claude').models ?? []

/**
 * The concrete catalogue id a family resolves to, so the card can say "Sonnet 5" rather
 * than the bare word "sonnet" - and so `/model <id>` lands on the same model the card
 * named, never a different one picked by a CLI alias behind the person's back.
 *
 * The first non-alias entry for that family: `CLAUDE_MODELS` lists newest first, so this
 * is always the newest dated model of the family, exactly what a fresh switch should
 * mean. Falls back to the alias word itself for a family this build has never catalogued
 * (a future model, or 'other') - the CLI accepts a bare model string it does not list.
 */
export function catalogueIdFor(family: ModelFamily): string {
  const prefix = `claude-${family}`
  const found = CLAUDE_MODELS.find((m) => modelValue(m).startsWith(prefix))
  return found ? modelValue(found) : family
}

/** One line per decision - never the prompt text, which is the whole point of the log. */
export function logAdvice(entry: Record<string, unknown>): void {
  logModelAdvice(entry)
}
