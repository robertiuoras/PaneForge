/**
 * A way in from anywhere, for somebody who has never heard of a VPN.
 *
 * The phone client already works: it is this window's UI over HTTP, and `phoneUrls()`
 * hands out the addresses of this machine. What those addresses have in common is that
 * they are all on this network. A tailnet address is the exception and it is the wrong
 * answer to ship - it needs an account, an app on the phone and an install on the desk,
 * which is three things a stranger will not do to look at a pane from a train.
 *
 * So: `cloudflared tunnel --url`, a quick tunnel, no account either side. Cloudflare gives
 * back an `https://<four-words>.trycloudflare.com` that reaches this port from any network
 * on earth, over real TLS, for nothing.
 *
 * Decisions worth not re-litigating:
 *
 * - **The URL is not the same fact as the tunnel being up.** cloudflared prints the
 *   hostname about four seconds in and says, in its own words, that it "may take some time
 *   to be reachable". Measured here: hostname at 3-6s, public DNS at 8-13s, first 200
 *   about a second after that. So `up` is set by a real HTTPS request against the real
 *   hostname coming back with our own bytes, never by the line appearing.
 * - **Do not look the hostname up before the tunnel has registered.** This is the trap
 *   that cost the most to find. The name does not exist yet - `*.trycloudflare.com` is not
 *   a wildcard - so an early query returns NXDOMAIN and the resolver CACHES that. Measured
 *   2026-08-08: polling from the moment the URL was printed gave `getaddrinfo ENOTFOUND`
 *   for 40 unbroken seconds while 1.1.1.1 had been answering since t=8s, and the very next
 *   run, asking only after public DNS had the record, resolved instantly and served 200 in
 *   1.07s. The tunnel was never the problem either time. Hence `REGISTERED` below, and a
 *   probe that backs off instead of hammering.
 * - **Everything cloudflared says comes out of stderr.** Its stdout was 0 bytes across
 *   every run. Watching the wrong pipe here looks exactly like a tunnel that never starts.
 * - **Nothing here may hold a phase for ever.** Same law as `updater.ts`: a transient phase
 *   carries `phaseAt` and anything that outlives its budget is dropped by the next caller,
 *   whatever wedged it. A tunnel that hung on `starting` would otherwise need the app
 *   restarting to try again.
 * - **The binary is fetched, not bundled.** It is 19-54 MB depending on platform, which is
 *   most of the installer, for a switch most people never touch. One already on PATH is
 *   preferred and nothing is downloaded in that case.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { TunnelState } from '../shared/types'
import { Funnel, type FunnelDeps } from './funnel'

/**
 * Every budget is overridable by env for the same reason `updater.ts` does it: the cases
 * worth testing are the SLOW ones - a program that prints nothing, an address that never
 * answers - and a test that waits out the real numbers is a test nobody runs.
 */
const ms = (name: string, fallback: number): number =>
  Math.max(1, Number(process.env[name]) || fallback)

/** cloudflared has printed a hostname but nothing has proved it serves yet. */
const URL_BUDGET_MS = ms('PF_TUNNEL_URL_MS', 60_000)
/** How long to wait for public DNS to carry the record before probing anyway. */
const RESOLVE_BUDGET_MS = ms('PF_TUNNEL_RESOLVE_MS', 30_000)
/** From the registered line to a real 200. Measured at ~10s; this is the give-up point. */
const PROBE_BUDGET_MS = ms('PF_TUNNEL_PROBE_MS', 120_000)
/** The whole start, from spawn to `up`. Past this the phase is dropped and it can retry. */
const START_BUDGET_MS = ms('PF_TUNNEL_START_MS', 180_000)
/** Downloading 19-54 MB on a bad hotel connection is slow, not broken. */
const FETCH_BUDGET_MS = ms('PF_TUNNEL_FETCH_MS', 300_000)

/** The line that means the tunnel has a live connection - and only then is DNS worth asking. */
const REGISTERED = /Registered tunnel connection/
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

/**
 * Which asset this machine needs. Named exactly as the release publishes them - a wrong
 * name here is a 404 that reads as "no internet", so `tunnel-test` asserts every one of
 * these against the real release listing when it is allowed to reach the network.
 */
export function assetFor(platform: string, arch: string): { name: string; tar: boolean } | null {
  if (platform === 'darwin') {
    return { name: arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz', tar: true }
  }
  if (platform === 'win32') {
    return { name: arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe', tar: false }
  }
  if (platform === 'linux') {
    return { name: arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64', tar: false }
  }
  return null
}

export function downloadUrl(asset: string): string {
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`
}

/**
 * Pull one file out of a gzipped tar without a dependency.
 *
 * The darwin asset is a tarball holding exactly one entry, so this is the 30 lines that
 * walk 512-byte headers rather than a package: name at 0, size as octal at 124, payload
 * padded up to the next 512. Anything more elaborate would be carrying a general tar
 * reader to read one file that has had the same shape for years.
 */
export function untarOne(tgz: Buffer, want = 'cloudflared'): Buffer | null {
  const tar = gunzipSync(tgz)
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = tar.subarray(at, at + 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    const size = parseInt(tar.subarray(at + 124, at + 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    const body = at + 512
    if (name === want || name.endsWith('/' + want)) return tar.subarray(body, body + size)
    at = body + Math.ceil(size / 512) * 512
  }
  return null
}

export interface TunnelDeps {
  /** where a downloaded binary is kept, normally userData */
  dir: string
  /** an already-installed one; '' when there is none on PATH */
  onPath?: string
  /** told whenever the phase changes, so the panel repaints without polling */
  onChange?(state: TunnelState): void
  /** overridable so the test can point at a stub instead of the real program */
  binary?: string
  /** proves the hostname really serves this desk; overridable for the same reason */
  probe?(url: string): Promise<boolean>
  /** answers "does public DNS carry this name yet", without touching the system resolver */
  resolve?(host: string): Promise<boolean>
  /**
   * The provider that is tried FIRST, because its address never changes. Passing
   * `{ binary: '' }` is how a test - or a machine without Tailscale - gets the
   * cloudflared path it used to be the only one of.
   */
  funnel?: FunnelDeps
}

export class Tunnel {
  private child: ChildProcess | null = null
  private phase: TunnelState['phase'] = 'off'
  private phaseAt = 0
  private url = ''
  private lastError = ''
  private stopping = false
  /** the one download in flight, shared so prefetch and start never race two writers */
  private fetching: Promise<string> | null = null
  private funnel: Funnel
  private via: TunnelState['via'] = ''

  constructor(private deps: TunnelDeps) {
    this.funnel = new Funnel(deps.funnel ?? {})
  }

  state(): TunnelState {
    const up = this.phase === 'up'
    return {
      phase: this.phase,
      url: up ? this.url : '',
      via: up ? this.via : '',
      // The one fact the panel needs in words: an address that never changes is one a
      // phone can be signed into once and for good, and a random one is not.
      stable: up && this.via === 'tailscale',
      error: this.lastError || undefined
    }
  }

  /**
   * True while a start is genuinely in flight. A phase that has outlived its budget is
   * NOT busy - it is a wedge, and saying otherwise is what would make a user reinstall
   * rather than press the switch again.
   */
  private busy(): boolean {
    if (this.phase !== 'fetching' && this.phase !== 'starting') return false
    const budget = this.phase === 'fetching' ? FETCH_BUDGET_MS : START_BUDGET_MS
    if (Date.now() - this.phaseAt < budget) return true
    this.note('off', `gave up after ${Math.round((Date.now() - this.phaseAt) / 1000)}s`)
    this.kill()
    return false
  }

  private note(phase: TunnelState['phase'], error = ''): void {
    this.phase = phase
    this.phaseAt = Date.now()
    this.lastError = error
    this.deps.onChange?.(this.state())
  }

  get running(): boolean {
    return this.phase === 'up' || this.phase === 'starting'
  }

  /** Open a way in to `port`. Resolves once it really serves, or with `error` set. */
  async start(port: number): Promise<TunnelState> {
    if (this.busy()) return this.state()
    await this.stop()
    this.stopping = false
    this.note('starting')

    // Tailscale Funnel first, always, when this machine can do it: same public HTTPS,
    // nothing installed on the phone, no 20 MB download - and, the reason it leads, an
    // address that is the same one tomorrow. A random address per launch is a new origin
    // per launch, and an origin is what a signed-in phone's cookie belongs to.
    const stable = await this.tryFunnel(port)
    if (stable || this.stopping) return this.state()

    let binary = this.deps.binary || this.deps.onPath || ''
    if (!binary) {
      const kept = join(this.deps.dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
      if (existsSync(kept)) binary = kept
      else {
        this.note('fetching')
        try {
          binary = await this.ensureBinary(kept)
        } catch (err) {
          this.note('off', `could not download cloudflared - ${msg(err)}`)
          return this.state()
        }
        if (this.stopping) return this.state()
      }
    }

    this.note('starting')
    return await this.run(binary, port)
  }

  /**
   * True when the machine's own permanent address is now serving this port.
   *
   * Silent on every refusal. A tailnet without the funnel attribute, no Tailscale at
   * all, a stopped tailscaled: none of those are things the person who flipped a switch
   * called "a way in from anywhere" asked about, and every one of them has cloudflared
   * waiting behind it. The only thing that is reported is a funnel that claimed to start
   * and then did not answer, because that one would otherwise be an address in the panel
   * that nothing reaches.
   */
  private async tryFunnel(port: number): Promise<boolean> {
    const started = await this.funnel.start(port).catch(() => ({ url: '', denied: true, error: '' }))
    if (!started.url) return false
    if (this.stopping) {
      await this.funnel.stop()
      return false
    }
    // Probed exactly like the quick tunnel is, and for the same reason: the address
    // existing is not the address answering. No DNS gate, because a `.ts.net` name is
    // published long before this app asks - the NXDOMAIN trap this file documents is a
    // property of `*.trycloudflare.com` being minted per run, which is the very thing
    // this provider exists not to do.
    const serving = await this.waitUntilServing(started.url, true)
    if (this.stopping) return false
    if (!serving) {
      await this.funnel.stop()
      this.lastError = ''
      return false
    }
    this.url = started.url
    this.via = 'tailscale'
    this.note('up')
    return true
  }

  private async run(binary: string, port: number): Promise<TunnelState> {
    await sweepOrphans(port, this.child ? [this.child.pid ?? 0] : [])
    const child = spawn(
      binary,
      [
        'tunnel',
        '--url',
        `http://127.0.0.1:${port}`,
        '--no-autoupdate',
        // Its metrics listener picks a fixed port by default and a second copy of the app
        // would collide with the first; nothing here reads it.
        '--metrics',
        '127.0.0.1:0'
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    this.child = child

    const found = await new Promise<{ url: string; registered: boolean }>((resolve) => {
      let url = ''
      let registered = false
      let settled = false
      const finish = (v: { url: string; registered: boolean }): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      // Armed BEFORE the awaits, not from a `finally`: a cloudflared that prints nothing
      // at all must still end this, or the phase sits on `starting` for ever.
      const timer = setTimeout(() => finish({ url, registered }), URL_BUDGET_MS)
      timer.unref?.()
      // stderr, and only stderr: its stdout was empty on every measured run.
      child.stderr?.on('data', (b: Buffer) => {
        const text = b.toString('utf8')
        if (!url) {
          const m = QUICK_URL.exec(text)
          if (m) url = m[0]
        }
        if (REGISTERED.test(text)) registered = true
        // Both halves, because the hostname alone is not permission to look it up.
        if (url && registered) {
          clearTimeout(timer)
          finish({ url, registered })
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (!url) this.lastError = `cloudflared exited (${code})`
        finish({ url, registered })
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        this.lastError = msg(err)
        finish({ url: '', registered: false })
      })
    })

    if (this.stopping) return this.state()
    if (!found.url) {
      this.note('off', this.lastError || 'cloudflared never printed an address')
      this.kill()
      return this.state()
    }

    this.url = found.url
    const serving = await this.waitUntilServing(found.url)
    if (this.stopping) return this.state()
    if (!serving) {
      this.note('off', 'the address never answered')
      this.kill()
      return this.state()
    }
    this.note('up')
    return this.state()
  }

  /**
   * Ask the real hostname over the real internet until it hands back our own bytes.
   *
   * Backs off rather than hammering, and the FIRST request is what starts the clock: the
   * whole reason this is not called earlier is that one lookup of a name that does not
   * exist yet leaves a cached NXDOMAIN behind, and after that the machine will keep
   * answering "no such host" for a tunnel that is already serving everybody else.
   */
  private async waitUntilServing(url: string, published = false): Promise<boolean> {
    const probe = this.deps.probe ?? defaultProbe
    // A stubbed probe touches no resolver, so it needs no gate; the real one does. The
    // gate asks 1.1.1.1 over DoH — which bypasses the system resolver's cache entirely —
    // until the record exists, and only then is the hostname itself looked up. Probing
    // straight after `Registered` was the residue of the NXDOMAIN trap this file already
    // documents: the record appears 8-13s later, so the FIRST system lookup cached the
    // NXDOMAIN and the probe then failed for 40s against a tunnel that was serving.
    const resolve =
      this.deps.resolve ?? (published || this.deps.probe ? alwaysThere : defaultResolve)
    const host = url.replace(/^https?:\/\//, '')
    const deadline = Date.now() + PROBE_BUDGET_MS
    const resolveBy = Math.min(deadline, Date.now() + RESOLVE_BUDGET_MS)
    // Scaled to the budget so the shrunken test budgets still get several polls in;
    // at the real 30s budget this is the measured-sensible 1.5s.
    const step = Math.max(250, Math.min(1500, RESOLVE_BUDGET_MS / 20))
    while (Date.now() < resolveBy && !this.stopping) {
      if (await resolve(host).catch(() => false)) break
      await sleep(step)
    }
    let wait = 1000
    while (Date.now() < deadline && !this.stopping) {
      if (await probe(url).catch(() => false)) return true
      await sleep(wait)
      // DNS is confirmed by the time this runs, so the answer is seconds away: a cap of
      // 8s here is what used to turn a 13s activation into a 16s one.
      wait = Math.min(wait * 1.5, 4000)
    }
    return false
  }

  /**
   * Download the binary ahead of need, quietly. Called when the Devices panel opens, so
   * that flipping the tunnel switch later starts at "starting", not at a 20 MB download —
   * which was most of the wait the switch was blamed for. Failing is not an event: the
   * switch still downloads on demand, with its own error reporting.
   */
  prefetch(): void {
    if (this.deps.binary || this.deps.onPath) return
    const kept = join(this.deps.dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
    if (existsSync(kept)) return
    void this.ensureBinary(kept).catch(() => {})
  }

  /** One download at a time, whoever asks: both callers get the same promise. */
  private ensureBinary(to: string): Promise<string> {
    if (!this.fetching) {
      this.fetching = this.fetchBinary(to).finally(() => {
        this.fetching = null
      })
    }
    return this.fetching
  }

  private async fetchBinary(to: string): Promise<string> {
    const asset = assetFor(process.platform, process.arch)
    if (!asset) throw new Error(`no cloudflared build for ${process.platform}/${process.arch}`)
    const res = await fetch(downloadUrl(asset.name), { redirect: 'follow' })
    if (!res.ok) throw new Error(`${res.status} from GitHub`)
    const body = Buffer.from(await res.arrayBuffer())
    const bytes = asset.tar ? untarOne(body) : body
    if (!bytes?.length) throw new Error('the download held no program')
    mkdirSync(this.deps.dir, { recursive: true })
    // Through a temp name and a rename: a half-written binary that a later launch decides
    // is "already downloaded" is a switch that never works again.
    const temp = `${to}.${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.part`
    writeFileSync(temp, bytes)
    chmodSync(temp, 0o755)
    try {
      renameSync(temp, to)
    } catch (err) {
      try {
        unlinkSync(temp)
      } catch {
        /* the rename failing is the error worth reporting, not the tidy-up */
      }
      throw err
    }
    return to
  }

  private kill(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill()
    } catch {
      /* already gone is the normal case */
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.kill()
    this.url = ''
    // Not a child process: `funnel --bg` is a setting tailscaled keeps, so nothing here
    // dying takes it down. Said unconditionally rather than only when `via` was tailscale,
    // because the state that most needs clearing is the one a crashed run left behind.
    if (this.via === 'tailscale' || !this.via) await this.funnel.stop().catch(() => {})
    this.via = ''
    if (this.phase !== 'off') this.note('off')
  }
}

/**
 * Kill a cloudflared this app started and then lost.
 *
 * `stop()` kills the child, and both quit paths call it, but neither runs when the process
 * dies without them: a crash, a force quit, an installer swapping the app out. What is left
 * behind is not an idle process, it is a PUBLIC address still reaching this desk, on a
 * hostname the app no longer knows and nobody is watching.
 *
 * What was actually measured, 2026-08-11: two cloudflareds alive at once against one phone
 * port, the older by four and a half hours than the app run that owned it. The old one did
 * exit on its own some minutes later, so the leak is not proven permanent, and this is
 * cheap insurance rather than a fix for a demonstrated hang: at most one process should be
 * carrying a given port out to the internet, and after this, exactly one is.
 *
 * Matched on the port in the argument list rather than on the program name, so a second
 * profile (`npm run try`, which serves its phone on its own port) is never in scope. Async
 * throughout and silent on failure: this is tidy-up in front of a spawn, never a gate in
 * front of it.
 */
export async function sweepOrphans(port: number, mine: number[] = []): Promise<void> {
  const run = async (file: string, args: string[]): Promise<string> =>
    await new Promise((resolve) => {
      execFile(file, args, { windowsHide: true, timeout: 4000 }, (_err, out) =>
        resolve(String(out ?? ''))
      )
    })
  const want = `127.0.0.1:${port}`
  try {
    let pids: number[] = []
    if (process.platform === 'win32') {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${want}*' } | ` +
          `ForEach-Object { $_.ProcessId }`
      ])
      pids = out.split(/\r?\n/).map((l) => Number(l.trim())).filter(Boolean)
    } else {
      const out = await run('/usr/bin/pgrep', ['-f', `cloudflared tunnel --url http://${want}`])
      pids = out.split('\n').map((l) => Number(l.trim())).filter(Boolean)
    }
    for (const pid of pids) {
      if (pid === process.pid || mine.includes(pid)) continue
      if (process.platform === 'win32') await run('taskkill.exe', ['/F', '/PID', String(pid)])
      else {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* gone between listing and killing is the normal case */
        }
      }
    }
  } catch {
    /* a sweep that could not run must never stop the tunnel starting */
  }
}

const alwaysThere = async (): Promise<boolean> => true

/**
 * "Does public DNS carry this name yet" — asked of Cloudflare's DoH endpoint, never of
 * the system resolver, because a negative answer from the system resolver is CACHED and
 * keeps answering "no such host" long after the record exists.
 */
async function defaultResolve(host: string): Promise<boolean> {
  const res = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
    { headers: { accept: 'application/dns-json' } }
  )
  if (!res.ok) return false
  const body = (await res.json()) as { Answer?: { type: number }[] }
  return !!body.Answer?.some((a) => a.type === 1)
}

/** A real request over the real internet: anything but our own bytes is not proof. */
async function defaultProbe(url: string): Promise<boolean> {
  const res = await fetch(url, { redirect: 'manual' })
  // Unpaired gets the pairing page, which is a 200 and is exactly what a phone would see.
  return res.status === 200 || res.status === 401
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref?.()
  })
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
