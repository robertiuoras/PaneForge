import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { verifiedPaneHandoff } from './handoffSteps'
import type { Session, StartSessionRequest } from '../shared/types'

export interface ContinuationDeps {
  session(id: string): Session | undefined
  snapshot(): StartSessionRequest[]
  sleep(id: string): Session | null
  wake(id: string): Session | null
  start(req: StartSessionRequest): Session
}
export function startContinuation(deps: ContinuationDeps, id: string, now = Date.now()): {
  ok: boolean; id?: string; reason?: string; digest?: string
} {
  const source = deps.session(id)
  if (!source) return { ok: false, reason: 'Source pane is gone.' }
  if (source.status !== 'idle' || source.runSince || source.ask || source.drafting ||
      source.handingOff || source.autoClearAt || source.backJob || !source.engaged) {
    return { ok: false, reason: 'Wait for a safe boundary with no draft or pending work.' }
  }
  const spec = deps.snapshot().find(x => x.scrollbackId === id)
  if (!spec?.resumeId) return { ok: false, reason: 'Source conversation is unavailable.' }
  const hand = verifiedPaneHandoff(source.cwd, id, source.agent, spec.resumeId, now)
  if (!hand?.path || !hand.digest || !hand.meta) return { ok: false, reason: 'No verified pane handoff. Prepare and review one first.' }
  if ((source.lastKeyboard ?? 0) > hand.meta.createdAt) return { ok: false, reason: 'The source changed after the handoff. Prepare an updated handoff.' }
  let asleep = false
  try {
    const bytes = readFileSync(hand.path)
    if (createHash('sha256').update(bytes).digest('hex') !== hand.digest) return { ok: false, reason: 'Handoff changed before delivery.' }
    // Use the established exact-ID sleep path before another writer takes this checkout.
    // The original conversation and its recovery file remain available.
    asleep = !!deps.sleep(id)?.asleep
    if (!asleep) return { ok: false, reason: 'Could not safely save the source conversation; no new pane was opened.' }
    const next = deps.start({ cwd: source.cwd, title: source.title, agent: source.agent,
      model: source.model, role: source.role, lane: source.lane, laneEnv: spec.laneEnv,
      prompt: bytes.toString('utf8') })
    return { ok: true, id: next.id, digest: createHash('sha256').update(bytes.toString('utf8').trim()).digest('hex') }
  } catch {
    if (asleep) { try { deps.wake(id) } catch { /* saved source is still recoverable */ } }
    return { ok: false, reason: 'Could not start the fresh chat. The source conversation and handoff remain available.' }
  }
}
