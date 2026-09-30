// The questions GuardDeck is showing, read off disk for auto-answer and auto-close holds.
//
// `claude-config/ask-popup.mjs` writes one JSON file per question under
// `~/.claude/guarddeck/questions/` (or `GD_QUESTIONS_DIR`). Sweeps read at most once
// a second, whatever number of panes ask; the auto-answer sweep runs per pane per tick and
// a directory read per pane would be the sweep's whole cost. A missing folder or a file
// that is not JSON is simply not a question - `heldByGuardDeck` decides, this only reads.
// The final close boundary reads afresh before killing a pane.
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const READ_EVERY_MS = 1000

export function questionsDir(): string {
  return process.env.GD_QUESTIONS_DIR || join(homedir(), '.claude', 'guarddeck', 'questions')
}

let cache: { dir: string; at: number; files: unknown[] } | null = null

/** Every parseable record in `dir`, cached for `READ_EVERY_MS`. */
export function guardDeckQuestions(dir = questionsDir(), now = Date.now()): unknown[] {
  if (cache && cache.dir === dir && now - cache.at < READ_EVERY_MS) return cache.files
  const files = readGuardDeckQuestions(dir)
  cache = { dir, at: now, files }
  return files
}

/** Fresh records at the final close boundary, including questions newer than the cache. */
export function readGuardDeckQuestions(dir = questionsDir()): unknown[] {
  const files: unknown[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    names = []
  }
  for (const name of names) {
    try {
      files.push(JSON.parse(readFileSync(join(dir, name), 'utf8')))
    } catch {
      // Half-written or foreign: not a question.
    }
  }
  return files
}
