import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export type NativeScope = 'read' | 'control'
export interface NativeGrant {
  id: string
  deviceId: string
  deviceName: string
  browserDevice: string
  scopes: NativeScope[]
  tokenHash: string
  createdAt: number
  expiresAt: number
  unlockedUntil: number
  codeVersion: string
}

export interface NativePromptReceipt {
  grantId: string
  deviceId: string
  clientMessageId: string
  sessionId: string
  textHash: string
  acceptedAt: string
  state: 'pending' | 'queued' | 'unknown'
  updatedAt: string
}

export interface NativeStart {
  codeChallenge: string
  state: string
  deviceId: string
  deviceName: string
  grantId?: string
}

interface Pending extends NativeStart {
  id: string
  expiresAt: number
  codeVersion: string
  browserDevice?: string
  scopes?: NativeScope[]
  code?: string
  csrf?: string
  source?: string
}

const PENDING_MS = 5 * 60_000
const GRANT_MS = 30 * 24 * 60 * 60_000
const UNLOCK_MS = 15 * 60_000
const MAX_PENDING = 32
const MAX_GRANTS = 32
const MAX_PROMPT_RECEIPTS = 5_000
const b64 = (bytes: number): string => randomBytes(bytes).toString('base64url')
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const challengeFor = (value: string): string => createHash('sha256').update(value).digest('base64url')
const equal = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Native bearer authority is deliberately separate from browser cookies and IPC. */
export class NativeAuth {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly grants: () => NativeGrant[],
    private readonly save: (grants: NativeGrant[]) => void,
    private readonly codeVersion: () => string,
    private readonly hostName: () => string,
    private readonly receipts: () => NativePromptReceipt[],
    private readonly saveReceipts: (receipts: NativePromptReceipt[]) => void,
    private readonly browserExists: (device: string) => boolean
  ) {}

  start(input: NativeStart, source?: string): { request: string; authorizationUrl: string } {
    this.sweep()
    if (!/^[-_A-Za-z0-9]{43}$/.test(input.codeChallenge)) throw new Error('invalid PKCE challenge')
    if (!/^[-_A-Za-z0-9]{22,128}$/.test(input.state)) throw new Error('invalid state')
    if (!/^[-_A-Za-z0-9]{22,128}$/.test(input.deviceId)) throw new Error('invalid device id')
    if (!/^[A-Za-z0-9][A-Za-z0-9 .()_'/-]{0,79}$/.test(input.deviceName)) throw new Error('invalid device name')
    if (input.grantId && !/^[A-Za-z0-9_-]{22,128}$/.test(input.grantId)) throw new Error('invalid grant id')
    for (const [id, pending] of this.pending) {
      if (pending.deviceId === input.deviceId && !pending.code && pending.source === source) this.pending.delete(id)
    }
    if ([...this.pending.values()].some((p) => p.deviceId === input.deviceId || (source && p.source === source))) throw new Error('authorization already pending')
    if (this.pending.size >= MAX_PENDING) throw new Error('too many pending authorizations')
    const id = b64(24)
    this.pending.set(id, { ...input, source, deviceName: input.deviceName.trim(), id, expiresAt: Date.now() + PENDING_MS, codeVersion: this.codeVersion() })
    return { request: id, authorizationUrl: `https://${this.hostName()}/pf/native/v1/auth/authorize?request=${encodeURIComponent(id)}` }
  }

  pendingForBrowser(id: string): Omit<Pending, 'code' | 'codeChallenge' | 'codeVersion'> | null {
    this.sweep()
    const p = this.pending.get(id)
    return p ? { id: p.id, state: p.state, deviceId: p.deviceId, deviceName: p.deviceName, grantId: p.grantId, expiresAt: p.expiresAt } : null
  }

  csrfFor(id: string): string | null {
    const p = this.pending.get(id)
    if (!p || p.expiresAt <= Date.now()) return null
    p.csrf ||= b64(24)
    return p.csrf
  }

  approve(id: string, csrf: string, browserDevice: string, scopes: NativeScope[]): { code: string; state: string } {
    this.sweep()
    const p = this.pending.get(id)
    if (!p || !p.csrf || p.code || !equal(p.csrf, csrf)) throw new Error('authorization expired')
    if (!browserDevice) throw new Error('browser device required')
    if (!scopes.length || scopes.some((s) => s !== 'read' && s !== 'control')) throw new Error('invalid scope')
    p.browserDevice = browserDevice
    p.scopes = [...new Set(scopes)]
    p.code = b64(32)
    p.csrf = undefined
    return { code: p.code, state: p.state }
  }

  exchange(code: string, verifier: string, deviceId: string): { accessToken: string; expiresAt: string; unlockedUntil: string; deviceId: string; grantId: string; hostName: string } {
    if (!/^[-_A-Za-z0-9]{43}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[-_A-Za-z0-9]{22,128}$/.test(deviceId)) throw new Error('invalid exchange')
    this.sweep()
    const p = [...this.pending.values()].find((x) => x.code && equal(x.code, code))
    if (!p || !p.code || !p.browserDevice || !this.browserExists(p.browserDevice) || !p.scopes || p.codeVersion !== this.codeVersion()) throw new Error('invalid authorization code')
    if (p.deviceId !== deviceId || challengeFor(verifier) !== p.codeChallenge) throw new Error('binding refused')
    const now = Date.now()
    const token = b64(32)
    const existing = p.grantId ? this.grants().find((g) => g.id === p.grantId) : undefined
    if (p.grantId && (!existing || existing.deviceId !== p.deviceId || existing.browserDevice !== p.browserDevice || existing.codeVersion !== p.codeVersion)) {
      throw new Error('grant binding refused')
    }
    const grant: NativeGrant = {
      id: p.grantId || b64(24), deviceId: p.deviceId, deviceName: p.deviceName, browserDevice: p.browserDevice,
      scopes: p.scopes, tokenHash: hash(token), createdAt: now, expiresAt: now + GRANT_MS,
      unlockedUntil: now + UNLOCK_MS, codeVersion: p.codeVersion
    }
    const list = this.grants().filter((g) => g.id !== grant.id && g.deviceId !== grant.deviceId)
    if (list.length >= MAX_GRANTS) throw new Error('native device limit reached')
    this.pending.delete(p.id) // all bindings and capacity checked; consume before persistence
    this.save([...list, grant])
    return { accessToken: token, expiresAt: new Date(grant.expiresAt).toISOString(), unlockedUntil: new Date(grant.unlockedUntil).toISOString(), deviceId: grant.deviceId, grantId: grant.id, hostName: this.hostName() }
  }

  bearer(value: string | undefined, scope: NativeScope): NativeGrant | null {
    this.sweep()
    if (!value || !/^[-_A-Za-z0-9]{43}$/.test(value)) return null
    const now = Date.now()
    const grant = this.grants().find((g) => g.tokenHash === hash(value) && g.expiresAt > now && g.codeVersion === this.codeVersion() && g.scopes.includes(scope))
    if (!grant || !this.browserExists(grant.browserDevice)) return null
    return grant
  }

  revoke(value: string | undefined): boolean {
    const grant = this.bearer(value, 'read')
    if (!grant) return false
    this.save(this.grants().filter((g) => g.id !== grant.id))
    return true
  }

  revokeBrowser(device: string): void {
    const revoked = new Set(this.grants().filter((g) => g.browserDevice === device).map((g) => g.id))
    if (!revoked.size) return
    this.save(this.grants().filter((g) => !revoked.has(g.id)))
  }

  /** Write the unknown receipt before handing text to the asynchronous pane manager. */
  acceptPrompt(grant: NativeGrant, clientMessageId: string, sessionId: string, text: string): NativePromptReceipt {
    const textHash = hash(text)
    const existing = this.receipts().find((r) => r.deviceId === grant.deviceId && r.clientMessageId === clientMessageId)
    if (existing) {
      if (existing.deviceId !== grant.deviceId || existing.sessionId !== sessionId || existing.textHash !== textHash) throw new Error('prompt id conflict')
      return existing
    }
    // Preserve every replay receipt. At capacity, reject new work before queueing;
    // silently evicting old identities could submit an old retry twice.
    if (this.receipts().length >= MAX_PROMPT_RECEIPTS) throw new Error('prompt receipt capacity reached')
    const now = new Date().toISOString()
    const receipt: NativePromptReceipt = { grantId: grant.id, deviceId: grant.deviceId, clientMessageId, sessionId, textHash, acceptedAt: now, state: 'pending', updatedAt: now }
    this.saveReceipts([...this.receipts(), receipt])
    return receipt
  }

  markPrompt(grant: NativeGrant, clientMessageId: string, state: 'queued' | 'unknown'): NativePromptReceipt {
    const existing = this.receipts().find((r) => r.deviceId === grant.deviceId && r.clientMessageId === clientMessageId)
    if (!existing) throw new Error('prompt receipt absent')
    if (existing.state === state) return existing
    const next = { ...existing, state, updatedAt: new Date().toISOString() }
    this.saveReceipts(this.receipts().map((r) => r === existing ? next : r))
    return next
  }

  prompt(grant: NativeGrant, clientMessageId: string): NativePromptReceipt | null {
    return this.receipts().find((r) => r.deviceId === grant.deviceId && r.clientMessageId === clientMessageId) ?? null
  }
  private sweep(): void {
    const now = Date.now()
    for (const [id, p] of this.pending) if (p.expiresAt <= now || p.codeVersion !== this.codeVersion()) this.pending.delete(id)
    const list = this.grants()
    const keep = list.filter((g) => g.expiresAt > now && g.codeVersion === this.codeVersion())
    if (keep.length !== list.length) this.save(keep)
  }
}
