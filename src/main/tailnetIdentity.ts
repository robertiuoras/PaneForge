/**
 * The tailscale CLI's half of "is this Robert's phone": who owns a tailnet address, and
 * which user this desk is. The rule is `shared/tailnetIdentity.ts`; this file only asks.
 *
 * Asked on the request path, so it is cached and bounded: `whois` measured 275-506 ms on
 * the PC (2026-10-02), an answer is kept a few minutes, a failure only seconds, and two
 * requests for the same address share one call. Same law as `funnel.ts`: `execFile` with a
 * timeout, `windowsHide`, never a throw.
 */

import { findTailscale, runTailscale } from './funnel'
import { parseSelfDns, parseSelfLogin, parseSelfUser, parseWhois, type TailnetNode } from '../shared/tailnetIdentity'

/** A node's owner and OS do not change under a running request; a re-pair re-asks. */
const NODE_MS = 3 * 60_000
const SELF_MS = 5 * 60_000
/** A failure is retried soon: tailscaled starting up is the common one. */
const MISS_MS = 15_000
/** On the request path, so far shorter than funnel's 8s. */
const CALL_MS = 3000
const MAX_ENTRIES = 256

export interface TailnetIdentityDeps {
  binary?: string
  run?(binary: string, args: string[], timeout: number): Promise<{ out: string; err: string; code: number }>
  now?(): number
}

interface Entry<T> {
  value: T
  until: number
}

export class TailnetIdentity {
  private nodes = new Map<string, Entry<TailnetNode | null>>()
  private self: Entry<{ id: string; login: string; dns: string }> | null = null
  private inflight = new Map<string, Promise<unknown>>()

  constructor(private deps: TailnetIdentityDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private async call(args: string[]): Promise<{ out: string; code: number }> {
    const binary = this.deps.binary ?? findTailscale()
    if (!binary) return { out: '', code: 127 }
    const run = this.deps.run ?? runTailscale
    const { out, code } = await run(binary, args, CALL_MS).catch(() => ({ out: '', err: '', code: 1 }))
    return { out, code }
  }

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const live = this.inflight.get(key)
    if (live) return live as Promise<T>
    const p = work().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  /** The node behind a tailnet address, or null for one tailscale does not know. */
  async whois(ip: string): Promise<TailnetNode | null> {
    const now = this.now()
    const hit = this.nodes.get(ip)
    if (hit && hit.until > now) return hit.value
    return this.once(`whois:${ip}`, async () => {
      const { out, code } = await this.call(['whois', '--json', ip])
      const node = code === 0 ? parseWhois(out) : null
      if (this.nodes.size >= MAX_ENTRIES) {
        for (const [k, e] of this.nodes) if (e.until <= this.now()) this.nodes.delete(k)
        if (this.nodes.size >= MAX_ENTRIES) this.nodes.clear()
      }
      this.nodes.set(ip, { value: node, until: this.now() + (node ? NODE_MS : MISS_MS) })
      return node
    })
  }

  /** This desk's own Tailscale user id; '' when tailscale is absent, stopped or silent. */
  async selfUser(): Promise<string> {
    return (await this.status()).id
  }

  /** This desk's own Tailscale login (email); '' when tailscale is absent, stopped or silent. */
  async selfLogin(): Promise<string> {
    return (await this.status()).login
  }

  /** This desk's own Tailscale DNS name (no trailing dot); '' when tailscale is absent, stopped or silent. */
  async selfDns(): Promise<string> {
    return (await this.status()).dns
  }

  /** One `status --json` answers all three, cached together. */
  private async status(): Promise<{ id: string; login: string; dns: string }> {
    if (this.self && this.self.until > this.now()) return this.self.value
    return this.once('self', async () => {
      const { out, code } = await this.call(['status', '--json'])
      const value = code === 0 ? { id: parseSelfUser(out), login: parseSelfLogin(out), dns: parseSelfDns(out) } : { id: '', login: '', dns: '' }
      this.self = { value, until: this.now() + (value.id ? SELF_MS : MISS_MS) }
      return value
    })
  }
}
