import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export interface ComputeBinding {
  pane: string
  job: string
  owner: string
  capturedAt: string
  title: string
  cwd: string
  attempt?: { hash: string; submittedAt: string }
}
export interface ComputeResult {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  exitCode: number | null
  finishedAt: string
  containment: string
}
function validBinding(b: ComputeBinding): boolean {
  return Boolean(b && /^[a-zA-Z0-9_-]{8,80}$/.test(b.job) && /^[a-zA-Z0-9_-]{1,30}$/.test(b.pane) &&
    typeof b.owner === 'string' && b.owner.length >= 8 && typeof b.title === 'string' && typeof b.cwd === 'string' && Number.isFinite(Date.parse(b.capturedAt)))
}

function requestAttempt(home: string, binding: ComputeBinding) {
  const request = JSON.parse(readFileSync(join(home, binding.job, 'request.json'), 'utf8'))
  if (request.id !== binding.job || request.session !== binding.owner) throw new Error('Compute job ownership changed')
  if (!/^[a-f0-9]{64}$/.test(request.hash) || !Number.isFinite(Date.parse(request.submittedAt))) throw new Error('Compute attempt identity missing')
  return { hash: request.hash as string, submittedAt: request.submittedAt as string }
}
function sameAttempt(a: ComputeBinding['attempt'], b: ComputeBinding['attempt']) {
  return !!a && !!b && a.hash === b.hash && a.submittedAt === b.submittedAt
}
/** A shell prompt is never completion evidence. Only the worker's quiescent receipt is. */
export function computeResult(home: string, binding: ComputeBinding): ComputeResult | undefined {
  const lock = join(home, binding.job, '.retry-lock')
  if (existsSync(lock)) return undefined
  const result = readResult(home, binding)
  // Read twice around the receipt. Never create a queue lock that an app crash could strand.
  if (existsSync(lock) || !sameAttempt(binding.attempt, requestAttempt(home, binding))) return undefined
  return result
}
function readResult(home: string, binding: ComputeBinding): ComputeResult | undefined {
  const dir = join(home, binding.job)
  const attempt = requestAttempt(home, binding)
  if (!binding.attempt || !sameAttempt(binding.attempt, attempt)) return undefined
  let result: ComputeResult
  let state: ComputeResult
  try {
    result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))
    state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  } catch { return undefined } // absent/partial receipt retains the shell
  if (!['succeeded', 'failed', 'timed_out', 'cancelled'].includes(result.status) ||
      state.status !== result.status || state.finishedAt !== result.finishedAt ||
      result.containment !== 'windows-job-object' || !Number.isFinite(Date.parse(result.finishedAt)) ||
      Date.parse(result.finishedAt) < Date.parse(attempt.submittedAt) || Date.parse(result.finishedAt) > Date.now() ||
      (result.status === 'succeeded' && result.exitCode !== 0)) return undefined
  return result
}

/** Persist the association before watching. Reattach after restart; no quiet-time heuristic. */
export class ComputeReviews {
  private bindings: ComputeBinding[] = []
  private watchers = new Map<string, FSWatcher>()
  private checking = false
  constructor(private home: string, private file: string,
    private complete: (binding: ComputeBinding, result: ComputeResult, receipt: string) => boolean) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(saved)) this.bindings = saved.filter(b => validBinding(b) && b.attempt && /^[a-f0-9]{64}$/.test(b.attempt.hash) && Number.isFinite(Date.parse(b.attempt.submittedAt)))
    } catch { /* first launch */ }
    for (const binding of this.bindings) this.observe(binding)
  }
  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.bindings), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  bind(binding: ComputeBinding) {
    if (!validBinding(binding)) throw new Error('Invalid compute binding')
    {
      const lock = join(this.home, binding.job, '.retry-lock')
      if (existsSync(lock)) throw new Error('Compute retry is still being published')
      const attempt = requestAttempt(this.home, binding)
      const state = JSON.parse(readFileSync(join(this.home, binding.job, 'state.json'), 'utf8'))
      if (!['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'].includes(state.status)) throw new Error('Compute submission is not published')
      const old = this.bindings.find(b => b.pane === binding.pane)
      if (old && (old.job !== binding.job || old.owner !== binding.owner || !sameAttempt(old.attempt, attempt))) throw new Error('Shell already belongs to another compute attempt')
      if (existsSync(lock) || !sameAttempt(attempt, requestAttempt(this.home, binding))) throw new Error('Compute attempt changed while binding')
      if (!old) { binding = { ...binding, attempt }; this.bindings.push(binding); this.save() }
      this.observe(old ?? binding)
    }
    this.check()
  }
  private observe(binding: ComputeBinding) {
    if (this.watchers.has(binding.pane)) return
    try {
      const watcher = watch(join(this.home, binding.job), () => this.check())
      watcher.on('error', () => { watcher.close(); this.watchers.delete(binding.pane) })
      this.watchers.set(binding.pane, watcher)
    } catch { /* retain association; session events retry after unavailable storage */ }
  }
  check() {
    if (this.checking) return
    this.checking = true
    try {
      for (const binding of [...this.bindings]) {
        this.observe(binding)
        try {
          const completed = (() => {
            const result = computeResult(this.home, binding)
            if (!result) return false
            const receipts = `${this.file}.receipts`
            mkdirSync(receipts, { recursive: true })
            const receipt = join(receipts, `${binding.pane}-${binding.job}-${Date.parse(binding.attempt!.submittedAt)}.json`)
            const snapshot = JSON.stringify({ job: binding.job, owner: binding.owner, attempt: binding.attempt, result })
            if (existsSync(receipt)) {
              if (readFileSync(receipt, 'utf8') !== snapshot) throw new Error('Retained receipt changed')
            } else writeFileSync(receipt, snapshot, { flag: 'wx', mode: 0o600 })
            if (JSON.stringify(computeResult(this.home, binding)) !== JSON.stringify(result)) return false
            return this.complete(binding, result, receipt)
          })()
          if (!completed) continue
          this.bindings = this.bindings.filter(b => b !== binding)
          this.save()
          this.watchers.get(binding.pane)?.close()
          this.watchers.delete(binding.pane)
        } catch { /* evidence/recording failure must never close a shell */ }
      }
    } finally { this.checking = false }
  }
  dispose() { for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear() }
}
