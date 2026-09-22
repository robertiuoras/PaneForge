import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export interface ComputeBinding {
  pane: string
  job: string
  owner: string
  capturedAt: string
  title: string
  cwd: string
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

/** A shell prompt is never completion evidence. Only the worker's quiescent receipt is. */
export function computeResult(home: string, binding: ComputeBinding): ComputeResult | undefined {
  const dir = join(home, binding.job)
  const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))
  if (request.id !== binding.job || request.session !== binding.owner) throw new Error('Compute job ownership changed')
  let result: ComputeResult
  try { result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) }
  catch { return undefined } // absent/partial receipt retains the shell
  if (!['succeeded', 'failed', 'timed_out', 'cancelled'].includes(result.status) ||
      result.containment !== 'windows-job-object' || !Number.isFinite(Date.parse(result.finishedAt)) ||
      Date.parse(result.finishedAt) > Date.now() ||
      (result.status === 'succeeded' && result.exitCode !== 0)) return undefined
  return result
}

/** Persist the association before watching. Reattach after restart; no quiet-time heuristic. */
export class ComputeReviews {
  private bindings: ComputeBinding[] = []
  private watchers = new Map<string, FSWatcher>()
  private checking = false
  constructor(private home: string, private file: string,
    private complete: (binding: ComputeBinding, result: ComputeResult) => boolean) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(saved)) this.bindings = saved.filter(validBinding)
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
    computeResult(this.home, binding) // validates the existing request, even while running
    const old = this.bindings.find(b => b.pane === binding.pane)
    if (old && (old.job !== binding.job || old.owner !== binding.owner)) throw new Error('Shell already belongs to another compute job')
    if (!old) { this.bindings.push(binding); this.save() }
    this.observe(old ?? binding)
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
          const result = computeResult(this.home, binding)
          if (!result || !this.complete(binding, result)) continue
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
