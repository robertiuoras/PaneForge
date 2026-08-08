// D3: the report goes back where the ask came from, and expires there.
//
// This desk does not hold the Discord bot token and must not - it is a laptop that
// travels. TaskDriver already owns both the token and the `prompt_log` row that knows
// which channel an ask arrived in, so the report is one POST, keyed by the same prompt
// fingerprint the shared archive uses. TaskDriver posts the message and deletes it after
// 24 hours; an ask typed at this desk matches no row there, and that is a miss, not an
// error.
//
// The per-step gate verdicts are IN the payload, not summarised: a report that says
// "verified" while its suite step was skipped is the failure mode `agentGate` was built
// to avoid.

import type { Goal } from '../shared/goals'
import { promptFingerprint } from './promptArchive'

export interface DispatchReportBody {
  promptKey: string
  repo: string
  branch: string
  sha: string
  verdict: string
  filesChanged: number
  insertions: number
  deletions: number
  gate: Record<string, 'pass' | 'fail' | 'skipped'>
  minutes: number
  tier: string
}

/** The payload for a finished dispatched goal, or null when there is nothing to say. */
export function buildReport(goal: Goal): DispatchReportBody | null {
  if (!goal.dispatch) return null
  const attempt = goal.attempts[goal.attempts.length - 1]
  if (!attempt) return null
  const lane = attempt.lanes[0]
  if (!lane) return null

  const gate: Record<string, 'pass' | 'fail' | 'skipped'> = {}
  for (const s of lane.gate ?? []) gate[s.name] = s.verdict

  // `branch@sha` is how `attemptOutcome` writes a ref; take the sha back out of it so
  // the report names the commit that was reviewed, not just the branch it sits on.
  const at = lane.branch ? attempt.outcome.match(new RegExp(`${lane.branch}@([0-9a-f]{7,40})`)) : null

  return {
    promptKey: promptFingerprint(goal.mission),
    repo: goal.cwd,
    branch: lane.branch,
    sha: at?.[1] ?? '',
    verdict: attempt.outcome,
    filesChanged: lane.files,
    insertions: lane.added,
    deletions: lane.removed,
    gate,
    minutes: Math.max(1, Math.round((attempt.endedAt - attempt.startedAt) / 60_000)),
    tier: goal.dispatch.tier
  }
}

/**
 * Fire and forget. A report must never cost the queue anything: not a throw, not a hang
 * (10s abort), not a retry - the next dispatched goal is a fresh chance to say something.
 */
export function postReport(url: string, body: DispatchReportBody, key = ''): void {
  if (!url) return
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  void fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-dispatch-key': key } : {})
    },
    body: JSON.stringify(body),
    signal: ctl.signal
  })
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
}
