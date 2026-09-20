import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { HistoryEntry, PromptReviewEntry, PromptReviewReport, Session } from '../shared/types'
import type { TokenSpend } from '../shared/tokenTally'

const DAY = 24 * 60 * 60 * 1000

function dir(): string {
  return join(app.getPath('userData'), 'prompt-review')
}

function file(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid prompt review session ID')
  return join(dir(), `${id}.jsonl`)
}

function valid(row: unknown): row is PromptReviewEntry {
  const x = row as Partial<PromptReviewEntry>
  return Boolean(
    x && typeof x.id === 'string' && typeof x.at === 'number' &&
    typeof x.sessionId === 'string' && typeof x.title === 'string' &&
    typeof x.cwd === 'string' && typeof x.agent === 'string' && typeof x.text === 'string'
  )
}

/** Record exactly what was submitted. One file per session makes History deletion exact too. */
export function recordPromptReview(session: Session, text: string, at = Date.now()): void {
  if (!text.trim()) return
  try {
    if (!existsSync(dir())) mkdirSync(dir(), { recursive: true })
    const row: PromptReviewEntry = {
      id: randomUUID(),
      at,
      sessionId: session.id,
      title: session.title,
      cwd: session.cwd,
      agent: session.agent,
      text
    }
    appendFileSync(file(session.id), JSON.stringify(row) + '\n', 'utf8')
  } catch {
    /* An unwritable profile must never prevent a prompt from reaching its agent. */
  }
}

/** Deleting a saved session also deletes its exact prompt ledger. */
export function removePromptReview(id: string): void {
  try {
    rmSync(file(id), { force: true })
  } catch {
    /* already gone */
  }
}

function localDay(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function promptReview(tokens: TokenSpend, now = Date.now(), sessions: HistoryEntry[] = []): PromptReviewReport {
  const all: PromptReviewEntry[] = []
  try {
    for (const name of readdirSync(dir())) {
      if (!name.endsWith('.jsonl')) continue
      for (const line of readFileSync(join(dir(), name), 'utf8').split('\n')) {
        if (!line) continue
        try {
          const row: unknown = JSON.parse(line)
          if (valid(row)) all.push(row)
        } catch {
          /* tolerate a torn final append and keep every complete row */
        }
      }
    }
  } catch {
    /* first run: no ledger yet */
  }
  all.sort((a, b) => b.at - a.at)
  const todayAt = localDay(now)
  const weekAt = todayAt - 6 * DAY
  const week = all.filter((x) => x.at >= weekAt && x.at <= now)
  const today = week.filter((x) => x.at >= todayAt)
  const todayHistory = sessions.filter((x) => x.startedAt >= todayAt || (x.endedAt ?? 0) >= todayAt)
  const weekHistory = sessions.filter((x) => x.startedAt >= weekAt || (x.endedAt ?? 0) >= weekAt)
  const sessionCount = (prompts: PromptReviewEntry[], history: HistoryEntry[]): number =>
    new Set([...prompts.map((x) => x.sessionId), ...history.map((x) => x.id)]).size
  const agentList = (prompts: PromptReviewEntry[], history: HistoryEntry[]): Session['agent'][] =>
    [...new Set([...prompts.map((x) => x.agent), ...history.map((x) => x.agent)])].sort()
  return {
    generatedAt: now,
    recordingSince: all.length ? all[all.length - 1].at : null,
    prompts: week,
    todayCount: today.length,
    weekCount: week.length,
    todaySessions: sessionCount(today, todayHistory),
    weekSessions: sessionCount(week, weekHistory),
    todayAgents: agentList(today, todayHistory),
    weekAgents: agentList(week, weekHistory),
    tokens
  }
}
