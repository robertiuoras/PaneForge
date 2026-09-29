import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { PaneAnswerIdentity, PaneAnswerRequest, PaneAnswerReceipt } from '../shared/paneAnswer'

type Row = PaneAnswerReceipt & { digest: string }
/** No answer text in this ledger. A crash never authorizes replay into a new process. */
export class PaneAnswers {
  private rows: Record<string, Row>
  constructor(private file: string) {
    try { this.rows = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.rows = {}
    }
    for (const row of Object.values(this.rows)) {
      if (row.state === 'waiting' || row.state === 'submitted') {
        row.state = 'uncertain'
        row.reason = 'Application restarted; delivery will not be replayed'
      }
    }
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file + '.tmp', JSON.stringify(this.rows), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
  status(req: PaneAnswerIdentity): PaneAnswerReceipt | null {
    if (!req || typeof req.requestId !== 'string') throw new Error('Invalid answer identity')
    if (!Object.hasOwn(this.rows, req.requestId)) return null
    const row = this.rows[req.requestId]
    if (!row) return null
    if (row.paneId !== req.paneId || row.expectedConversationId !== req.expectedConversationId) throw new Error('Answer request identity mismatch')
    const { digest: _digest, ...receipt } = row
    return receipt
  }
  accept(req: PaneAnswerRequest): { fresh: boolean; receipt: PaneAnswerReceipt } {
    if (!req || !/^s[\w-]+$/.test(req.paneId) || !/^[a-f0-9-]{36}$/i.test(req.expectedConversationId) ||
      !/^[\w.-]{1,160}$/.test(req.requestId) || typeof req.text !== 'string' || !req.text.trim() ||
      req.text.length > 64_000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(req.text) || /^[\s]*[!/]/.test(req.text)) throw new Error('Invalid answer request')
    const digest = createHash('sha256').update(req.text).digest('hex')
    const prior = this.status(req)
    if (prior) {
      if (this.rows[req.requestId].digest !== digest) throw new Error('Answer request ID already used for different text')
      return { fresh: false, receipt: prior }
    }
    // Reject prototype keys even if the request id otherwise matches the public grammar.
    if (req.requestId in Object.prototype) throw new Error('Invalid answer request ID')
    this.rows[req.requestId] = { paneId: req.paneId, expectedConversationId: req.expectedConversationId,
      requestId: req.requestId, acceptedAt: Date.now(), state: 'waiting', digest }
    try { this.save() } catch (error) { delete this.rows[req.requestId]; throw error }
    return { fresh: true, receipt: this.status(req)! }
  }
  update(req: PaneAnswerIdentity, change: Partial<Pick<PaneAnswerReceipt, 'state' | 'reason' | 'submittedAt' | 'confirmedAt' | 'transcriptAt'>>): PaneAnswerReceipt {
    if (!this.status(req)) throw new Error('Unknown answer request')
    const prior = this.rows[req.requestId]
    this.rows[req.requestId] = { ...prior, ...change }
    try { this.save() } catch (error) { this.rows[req.requestId] = prior; throw error }
    return this.status(req)!
  }
}
