/**
 * Tailscale Funnel: the same "way in from anywhere" as the cloudflared tunnel, on an
 * address that never changes.
 *
 * `tunnel.ts` explains why a way in exists at all. This file explains why it is tried
 * FIRST when the machine can do it:
 *
 * - **A quick tunnel's hostname is random per run.** `https://<four-words>.trycloudflare
 *   .com` is a different origin every launch, and a phone's sign-in is a cookie, and a
 *   cookie belongs to an origin. So every restart of the app signed every phone out and
 *   put a card back on the desk - which is the "I only want to approve a device once,
 *   forever" report, and it was never a bug in the approval code at all.
 * - **Funnel's hostname is the machine's own name** - `<machine>.<tailnet>.ts.net` -
 *   issued once and stable across reboots, updates and network changes. Approve a phone
 *   on it once and the cookie is still good months later, from any network, with nothing
 *   installed on the phone: Funnel is public HTTPS, not the tailnet. Tailscale is needed
 *   on the DESK only, and the desk is where the app already is.
 * - **It costs no download.** cloudflared is 19-54 MB fetched on demand; the Tailscale
 *   CLI is either already on this machine or this provider simply does not apply.
 * - **It is not always available**, and that is normal rather than an error: Funnel needs
 *   `nodeAttrs: funnel` on the tailnet. When it is refused we fall through to cloudflared
 *   and say nothing, because the user asked for a way in, not for a provider.
 *
 * Nothing here blocks: every call is `execFile` with a timeout, same law as `strays.ts`.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { funnelArgs, funnelDenied, funnelHost, funnelOffArgs, servingHost } from '../shared/funnel'

/** Where the CLI lives when it is not on PATH. The Mac app ships its own copy. */
const KNOWN = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale'
]

/** Long enough for a cold `tailscaled` to answer, short enough never to hold a quit. */
const CALL_MS = 8000

export interface FunnelDeps {
  /** overridable so the test drives a stub instead of a tailnet */
  binary?: string
  run?(binary: string, args: string[]): Promise<{ out: string; err: string; code: number }>
}

export function findTailscale(): string {
  for (const p of KNOWN) if (existsSync(p)) return p
  return ''
}

async function runReal(
  binary: string,
  args: string[]
): Promise<{ out: string; err: string; code: number }> {
  return await new Promise((resolve) => {
    execFile(binary, args, { windowsHide: true, timeout: CALL_MS }, (err, out, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ out: String(out ?? ''), err: String(stderr ?? ''), code })
    })
  })
}

export class Funnel {
  private host = ''
  constructor(private deps: FunnelDeps = {}) {}

  private get binary(): string {
    return this.deps.binary ?? findTailscale()
  }

  private run(args: string[]): Promise<{ out: string; err: string; code: number }> {
    const run = this.deps.run ?? runReal
    return run(this.binary, args)
  }

  /** Is this machine able to be funnelled at all? Cheap, and asked before any spawn. */
  async available(): Promise<string> {
    if (!this.binary) return ''
    const { out, code } = await this.run(['status', '--json'])
    if (code !== 0) return ''
    return funnelHost(out)
  }

  /**
   * Put `port` on the public internet. Returns the https address, or '' when this
   * machine cannot - which is a reason to use the other provider, never an error.
   */
  async start(port: number): Promise<{ url: string; denied: boolean; error: string }> {
    const host = await this.available()
    if (!host) return { url: '', denied: true, error: '' }
    const { out, err, code } = await this.run(funnelArgs(port))
    const said = `${out}\n${err}`
    if (code !== 0) {
      return { url: '', denied: funnelDenied(said), error: firstLine(said) || `tailscale funnel exited ${code}` }
    }
    // Believe the status rather than the exit code: `funnel --bg` prints its plan and
    // returns before tailscaled has necessarily published it, and a wrong hostname here
    // would be an address nobody can reach shown as if it worked.
    const served = servingHost((await this.run(['funnel', 'status'])).out) || servingHost(said)
    this.host = served || host
    return { url: `https://${this.host}`, denied: false, error: '' }
  }

  /**
   * Take it back off the internet.
   *
   * This is a configuration change owned by tailscaled, not a child process, so nothing
   * undoes it when the app dies - quitting has to say so explicitly, and so does turning
   * the switch off. A funnel left up is a public address into a port with nothing behind
   * it, which is not dangerous but is a promise the app is no longer keeping.
   */
  async stop(): Promise<void> {
    if (!this.binary) return
    this.host = ''
    await this.run(funnelOffArgs()).catch(() => ({ out: '', err: '', code: 1 }))
  }
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? ''
}
