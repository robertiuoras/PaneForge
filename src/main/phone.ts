/**
 * The phone client: this desk's own UI, served to a browser on this network.
 *
 * The renderer imports nothing from Electron and nothing from Node - it is pure UI over
 * `window.api` - so a phone client is not a second product, it is that object supplied
 * over HTTP (`shared/surface.ts` is the one list, `renderer/src/browserApi.ts` is the
 * other transport). Every call lands in the very handler the window's would, through
 * `ipcTap.ts`. Nothing about a pane moves: the pty, the checkout and the transcript stay
 * on this machine, exactly as in `remote/` - see `docs/design-notes.md`.
 *
 * Decisions worth not re-litigating:
 *
 * - **Server-sent events down, POST up.** No dependency, and the repo has three. A
 *   WebSocket here would mean either a fourth dependency or hand-rolled RFC 6455
 *   framing; SSE reconnects by itself, survives a phone's screen lock, and the one thing
 *   it costs - upstream on a separate request - is a POST we need anyway. Ordering of
 *   `send` calls is preserved by the client, which queues them: a keystroke followed by
 *   a resize must arrive that way round.
 * - **Off until switched on, and a code to get in.** Anything that can type into a pane
 *   can run commands on this machine, so the server does not exist until Settings says
 *   so, and a browser that has not proved the pairing code gets the pairing page and
 *   nothing else - not the UI, not one asset. The code is short because it is typed on a
 *   phone; what stops it being guessed is the lockout (5 tries, then a minute), and the
 *   only thing behind a wrong code is a 40-byte page.
 * - **The cookie is derived, never stored.** `hmac(deviceId, code)`, so a restart does
 *   not sign every phone out and rotating the code in Settings signs all of them out at
 *   once. There is no token file to leak or to keep in step.
 * - **Bytes travel as base64** (`shared/wireJson.ts`): two calls on this surface carry a
 *   Uint8Array and plain JSON silently turns those into `{"0":12,...}`.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  CHALLENGE_MS,
  UNLOCK_MS,
  checkUnlock,
  mintUnlock,
  newChallenge,
  verifyAssertion,
  verifyRegistration,
  type StoredKey
} from './passkey'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { markFor } from '../shared/deviceWatch'
import { NativeAuth, type NativeGrant, type NativePromptReceipt } from './nativeAuth'
import { deviceKind, hostOf, originOf } from '../shared/net'
import type { PhoneAsk, PhoneDevice, PhonePeer, PhoneState, Session } from '../shared/types'
import { decodeWire, encodeWire } from '../shared/wireJson'

/**
 * How long a phone's cookie is good for. Effectively permanent: an approved device says
 * "It stays signed in until you sign it out here", and a 30-day silent expiry made that
 * a lie. Revocation is explicit — sign the device out by name, or rotate the code.
 */
const COOKIE_DAYS = 3650
/** Wrong codes from one address before it waits. */
const TRY_LIMIT = 5
const LOCK_MS = 60_000
/** A comment down the stream often enough that no proxy or phone calls it dead. */
const KEEPALIVE_MS = 15_000
/** `transcribe` posts a wav. Anything past this is refused rather than buffered. */
const BODY_LIMIT = 24 * 1024 * 1024
/**
 * How long a request to be let in stands before it expires by itself.
 *
 * Long enough to walk to the desk, short enough that a card nobody answered is gone by
 * the time anybody wonders what it was. The phone polls, so an expiry is visible at both
 * ends rather than being a screen that waits for ever.
 */
const ASK_MS = 120_000
/** Requests one address may raise in ASK_WINDOW_MS. A card is cheap to refuse and
 *  expensive to be shown twenty of. */
const ASK_LIMIT = 5
const ASK_WINDOW_MS = 10 * 60_000

/**
 * Channels that exist for the window only, and are refused over HTTP whatever the cookie.
 *
 * A lock whose own switch is reachable from the thing it locks is not a lock. Both of these
 * are ways to make the typing gate stop applying - turning it off outright, or emptying the
 * list of keys it checks against - so they belong to somebody sitting at the desk, which is
 * the one place a passkey cannot be demanded because there is nobody remote to demand it of.
 *
 * `surfaceChannels()` is deliberately not the place for this: it is one list shared by both
 * transports, and a channel that is desk-only is a property of the TRANSPORT, not of the
 * surface. The window keeps reaching these through ipcMain exactly as before.
 */
// ...and `sessions:closing` is desk-only for the reason the pty's SIZE is: it is a
// decision made from facts that are true of the machine holding the pane. The phone runs
// the same renderer, so it would publish a deadline computed against ITS idea of which
// pane is focused - and the two would then overwrite each other's number on every session
// broadcast, which is the same last-writer-wins fight `shared/paneSize.ts` documents.
const DESK_ONLY = new Set([
  // Answers the Cmd-Q card. Only the desk can quit the desk.
  'app:quitAnswer',
  // Reads a vault off this machine's disk and opens the Obsidian app here - desk only.
  'vault:info', 'vault:graph', 'vault:open',
  'owner:access',
  'owner:stats',
  'phone:typeGate',
  'phone:forgetKey',
  'phone:clearMark',
  'sessions:closing',
  // A vault is opened from a folder dialog and the Obsidian app on THIS machine - a
  // phone has neither.
  'config:pickVault',
  'vault:info',
  'vault:graph',
  'vault:open'
])

/**
 * The channels a browser may not reach without a passkey touch.
 *
 * The line is "can this cause code to run on this desk", not "does this change something".
 * Resizing a pane and reading its buffer are how a phone WATCHES, and gating those would
 * make the gate fire constantly for nothing. Typing, starting, restarting, killing, piping
 * and opening things in the shell are the ones where a stolen cookie turns into a command.
 *
 * Every one of these is reachable ONLY over the HTTP surface. The app's own writes - the
 * "continue" that `recover` queues, the prompt `sessions:start` hands a new pane - are
 * raised in the main process and never pass through here, so they are exempt by
 * construction rather than by a flag.
 */
const GATED_SEND = new Set([
  // Reviewed 2026-09-07. Both end in a line arriving in a pane's composer: `pane:tell`
  // hands one to a named pane, and `login:done` tells whichever pane asked for the
  // sign-in that the wall is down - over ssh, when that pane is on the other desk. The
  // sign-in picture is a desk surface (a phone never draws it), so gating these costs a
  // phone nothing it could have used.
  'pane:tell',
  'login:done',
  // It types into a browser that is signed in to somebody's accounts, on a machine the
  // person holding the phone may not be near. Strictly worse than `pty:write`.
  'login:input',
  // It kills a process: the countdown card's `Close now`. The invoke half, `devs:stop`,
  // is gated for the same reason.
  'devs:stopNow',
  'pty:write',
  // Strictly more than `pty:write`: it types text into a pane AND presses Enter for it, so
  // a stolen cookie needs no second call to make the agent act.
  'pty:prompt',
  'shell:reveal',
  'shell:external',
  // Same rule as the invoke side, and the same omission: these are fire-and-forget, so a
  // stolen cookie gets no answer back - it does not need one. `app:relaunchAsAdmin` restarts
  // this app ELEVATED, `game:installAnyway` runs the installer now instead of when the desk
  // is idle, `restore:answer` accepts the offer that re-opens a deskful of panes (each one a
  // process), and `stash:reveal` opens a file manager here exactly as `shell:reveal` does.
  'app:relaunchAsAdmin',
  'game:installAnyway',
  'restore:answer',
  'stash:reveal'
])
const GATED_INVOKE = new Set([
  // `login:need` puts a card on the desk that offers to open a browser; `login:open`
  // opens an ssh forward and drives a browser through it. Both start something.
  'login:need',
  'login:open',
  // Reviewed 2026-08-31. `projects:create` writes a directory into the projects root from
  // a name somebody typed. `shared/projectName.ts` refuses every name that could mean a
  // folder somewhere else, so the worst case is an empty folder with an odd name - but it
  // is still the only path where a phone makes something on this disk, so it costs the
  // same passkey touch as starting a session in it does.
  'projects:create',
  // Reviewed 2026-08-28. `prompt:split` starts an agent CLI on this desk to read one long
  // ask into a plan. It is the first class in the list - it runs a process here - and it
  // spends somebody's tokens doing it, so it is gated with `sessions:start` rather than
  // with the reads. The panes the plan opens go through `sessions:start`, which is gated
  // in its own right.
  'prompt:split',
  'autoclear:ask',
  'sessions:start',
  'sessions:prepareContinuation',
  'sessions:continueFresh',
  'sessions:startMany',
  'sessions:restart',
  'sessions:switchAgent',
  'sessions:kill',
  // Sleeping ends a real process and waking SPAWNS one - the same class as `kill` and
  // `start`, which is what these two are made of (see `shared/sleep.ts`).
  'sessions:sleep',
  'sessions:wake',
  'sessions:pipe',
  'sessions:swarm',
  'sessions:split',
  // Answering a question IS typing - it sends arrows and a return into the pane. It
  // arrives as an `invoke` rather than through `pty:write`, so leaving it out of this
  // set was a door straight past the gate: a stolen cookie could pick "1. Yes, run it"
  // on any permission prompt on screen without a passkey touch.
  'pty:choose',
  // Reviewed 2026-09-06. Switching a Codex pane's reasoning effort on, or pinning it to a
  // level, ends in arrow keys and a return going into that pane before its next turn - the
  // same class as `pty:choose`, and gated for the same reason. It also spends more of
  // somebody's weekly limit per turn, which is nobody's decision to make through a stolen
  // cookie.
  'sessions:setEffort',
  // Typing, on a delay. `autoclear:ask` ends in `/clear` plus a prompt typed into a pane
  // unless somebody at the desk stops it, and `autoclear:answer` with 'now' skips even
  // that wait - so both are the same class as `pty:write`, not a lesser one.
  'autoclear:ask',
  'autoclear:answer',
  // Elevation. `admin:enable` registers the scheduled task that relaunches this app
  // ELEVATED with no UAC prompt (index.ts, enableAdminMode) - the single biggest thing a
  // cookie could buy on this desk, and it sat outside the gate because the rule was read
  // as "does it type into a pane" rather than "can it cause code to run here". `disable`
  // is gated too: turning the task off is not dangerous, but leaving it ungated lets a
  // stolen cookie flip the setting Robert reads on screen to decide whether he is elevated.
  'admin:enable',
  'admin:disable',
  // Stopping a dev server is killing a process on this desk - the same class as
  // `sessions:kill`, and worse in one way: what it kills is not on screen anywhere, so a
  // stolen cookie taking down whatever this machine is serving leaves nothing to notice.
  'devs:stop',

  // --- runs a process on this desk ------------------------------------------------------
  // Each of these ends in something spawned here: an agent CLI invoked with a prompt, a
  // package manager, an editor, an installer. `pty:attach*` inserts a path into a live
  // pane, which is typing.
  'shell:editor',
  // Opens a file manager here, exactly as `shell:reveal` does on the send side - it only
  // reaches a different folder (the project a lane belongs to, rather than the lane).
  'shell:revealProject',
  // Same reasoning as `shell:revealProject` just above - it opens a file manager here,
  // only at the pane's own working folder rather than the project it belongs to.
  'shell:revealPane',
  'pty:attach',
  'pty:attachPaths',
  'pty:attachClipboard',
  'agents:install',
  'agents:uninstall',
  // Same class as the two above: it runs an installer on this machine.
  'agents:update',
  'update:install',
  'voice:install',
  'lanes:merge',
  // Runs on ANOTHER desk, which is worse rather than better: the passkey enrolled here is
  // the only thing between a stolen cookie and a session on a machine whose own gate was
  // never asked.
  'remote:start',
  'remote:handoff',
  // The same move asked for from the other side of it: it kills a pane on the paired
  // machine and starts one here, so it is weighed exactly as handing one out.
  'remote:bringHere',
  // Cancelling a queued move destroys nothing, but it decides where a pane runs, which is
  // the same authority as starting one. Same class as its opposite, for one touch.
  'remote:handoffCancel',
  // A read, and a cheap one - but it runs `git` in a folder the caller names, so it is
  // weighed with the rest of the handoff family rather than left open.
  'remote:handoffReady',

  // --- changes who may reach this desk --------------------------------------------------
  // The lock's own perimeter. `config:set` is here because the config carries agent commands
  // and the projects root, so a write to it decides what `sessions:start` will run. The
  // pairing and tunnel channels each hand out a way in, so a cookie that could use them
  // would not need to stay stolen - it could mint its own access and outlive the rotation.
  'config:set',
  'phone:serve',
  'phone:port',
  'phone:rotate',
  'phone:tunnel',
  'phone:answerAsk',
  'phone:forget',
  'phone:asking',
  'remote:host',
  'remote:port',
  'remote:rotate',
  'remote:pair',
  'remote:pairText',
  'remote:pairClipboard',
  'remote:invite',
  'remote:clipboardInvite',
  'remote:answer',
  'remote:pairByAsking',
  'remote:forget',
  'remote:connect',

  // --- takes something away, or reads what was never on screen --------------------------
  // `history:delete` is the one irreversible read-side channel. `clipboard:read` returns the
  // DESK's clipboard, which is where a password manager's paste lives for thirty seconds: a
  // phone reading it is the feature, a cookie polling it is exfiltration.
  'history:delete',
  'clipboard:read',
  // The write side of the same clipboard. A phone dropping an image already has a path
  // that works (`pty:attach` sends the bytes and the desk saves them), so nothing over
  // the wire needs this - and a cookie that can REPLACE the desk's clipboard can swap a
  // wallet address under a paste the person at the desk is about to make.
  'clipboard:writeImage'
])

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Served with the wrong type a manifest is ignored in silence, and the home-screen
  // icon quietly stops being an app and goes back to being a Safari tab.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
}

export interface PhoneDeps {
  /** the built renderer - the same files the window loads */
  staticDir: string
  /** current pairing code, read fresh so a rotation takes effect without a restart */
  code(): string
  /** this device's stable id; with the code it makes the cookie */
  secret(): string
  /** into the real ipcMain.handle body */
  invoke(channel: string, args: unknown[]): Promise<unknown>
  /** into the real ipcMain.on body */
  send(channel: string, args: unknown[]): void
  /** channels a client may reach, which is the app's own surface and nothing else */
  channels: { invoke: string[]; send: string[]; on: string[] }
  /** told whenever the client count or the error changes, for Settings */
  onChange?(): void
  /** devices approved on this desk, with their secrets. Read fresh, same as `code`. */
  devices?(): PhoneDevice[]
  /** a device was approved, or forgotten: persist the new list */
  saveDevices?(list: PhoneDevice[]): void
  /** may a browser ask to be let in, rather than typing the code */
  canAsk?(): boolean
  /** passkeys enrolled on this desk, read fresh for the same reason `code` is */
  keys?(): StoredKey[]
  /** a passkey was enrolled, or its counter moved on: persist the new list */
  saveKeys?(list: StoredKey[]): void
  /**
   * Is the typing gate on at all. Off means the surface behaves exactly as it did before
   * passkeys existed - which is what a desk with no public address wants, and what an
   * existing install gets until somebody turns it on.
   */
  typeGate?(): boolean
  /** opaque native mobile grants, persisted as token hashes only */
  nativeGrants?(): NativeGrant[]
  saveNativeGrants?(list: NativeGrant[]): void
  nativePromptReceipts?(): NativePromptReceipt[]
  saveNativePromptReceipts?(list: NativePromptReceipt[]): void
  sessions?(): Session[]
  sessionBuffer?(id: string): string
  /** Exact provider conversation, resolved from this pane's claimed transcript. */
  semanticConversation?(id: string, agent: string, cursor?: string | null): {
    messages: Array<{
      id: string
      role: 'user' | 'assistant' | 'system'
      provider: 'claude' | 'codex' | 'terminal'
      at: string | null
      blocks: Array<
        | { type: 'text'; text: string }
        | { type: 'code'; text: string; language?: string }
        | { type: 'tool'; name: string; input: string; output: string; state: 'requested' | 'running' | 'complete' | 'error'; callId?: string; phase?: 'call' | 'result' }
        | { type: 'notice'; text: string }
      >
      raw: string
    }>
    nextCursor: string | null
    rawOutput: string
  } | null
  sleepSession?(id: string): boolean
  wakeSession?(id: string): unknown
  setKeepOpen?(id: string, keepOpen: boolean): boolean
  isKeepOpen?(id: string): boolean
  sendNativePrompt?(id: string, text: string): boolean
  /** the last watching browser has gone: give back anything a phone was holding */
  onIdle?(): void
}

interface Client extends PhonePeer {
  res: ServerResponse
  alive: boolean
  /** the approved device this stream belongs to, '' for one that typed the code */
  device: string
}

/** The card's half of a request: everything except the token it is holding for it. */
function askView(a: PhoneAsk & { token?: string }): PhoneAsk {
  const { id, sas, address, kind, origin, at } = a
  return { id, sas, address, kind, origin, at }
}

export class PhoneServer {
  private server: Server | null = null
  private clients = new Set<Client>()
  private tries = new Map<string, { n: number; until: number }>()
  /** the one browser waiting on Approve, plus how it will be answered */
  private asking:
    | (PhoneAsk & { answered: 'yes' | 'no' | null; token: string; ua: string })
    | null = null
  private askTries = new Map<string, { n: number; since: number }>()
  private nextAsk = 1
  /** challenges handed out and not yet answered, with the moment they stop being valid */
  private challenges = new Map<string, number>()
  /** Native approval consumes a fresh WebAuthn assertion, never an old unlock cookie. */
  private freshPasskeys = new Map<string, number>()
  private nativeStarts = new Map<string, { since: number; n: number }>()
  private nativeTokens = new Map<string, { since: number; n: number }>()
  private keepalive: NodeJS.Timeout | null = null
  private lastError = ''
  private listening = 0
  private nextPeer = 1
  private native: NativeAuth

  constructor(private deps: PhoneDeps) {
    this.native = new NativeAuth(
      () => this.deps.nativeGrants?.() ?? [],
      (list) => { if (!this.deps.saveNativeGrants) throw new Error('native grant storage unavailable'); this.deps.saveNativeGrants(list) },
      () => createHash('sha256').update(this.deps.code()).digest('hex'),
      () => 'localhost',
      () => this.deps.nativePromptReceipts?.() ?? [],
      (list) => { if (!this.deps.saveNativePromptReceipts) throw new Error('native receipt storage unavailable'); this.deps.saveNativePromptReceipts(list) },
      (device) => (this.deps.devices?.() ?? []).some((row) => row.id === device)
    )
  }

  /**
   * Collapse a device list that was written before approvals were deduplicated.
   *
   * Nine rows for three phones is what this desk's own config held, and it is not a
   * cosmetic problem: `Sign out` is per row, so a list nobody can read is a list where
   * revoking a device stops being a thing anybody does. Two rules, both conservative:
   * legacy rows (no user-agent to match on) that agree about what KIND of device they are
   * and which side of the front door they came from are one device, newest kept - and a
   * row that was approved over a day ago and has never once connected was not a device at
   * all. Anything with a user-agent, and anything that has ever been seen, is left alone.
   */
  private tidyDevices(): void {
    const list = this.deps.devices?.() ?? []
    if (!list.length) return
    const dayOld = Date.now() - 86_400_000
    const keep: PhoneDevice[] = []
    for (const d of [...list].sort((a, b) => (b.seen || b.at) - (a.seen || a.at))) {
      if (d.ua) {
        keep.push(d)
        continue
      }
      if (!d.seen && d.at < dayOld) continue
      if (keep.some((k) => !k.ua && k.kind === d.kind && k.origin === d.origin)) continue
      keep.push(d)
    }
    if (keep.length !== list.length) this.deps.saveDevices?.(keep)
  }

  /** Start answering. Resolves once the port is really bound, or with `error` set. */
  async start(port: number, bind = '0.0.0.0'): Promise<Omit<PhoneState, 'tunnel' | 'typeGate' | 'keys'>> {
    await this.stop()
    this.tidyDevices()
    this.lastError = ''
    const server = createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        this.plain(res, 500, String(err instanceof Error ? err.message : err))
      })
    })
    // A phone that locks its screen leaves a half-open socket; without this they pile up.
    server.keepAliveTimeout = 120_000
    server.headersTimeout = 125_000
    await new Promise<void>((resolve) => {
      server.once('error', (err: Error) => {
        this.lastError = err.message
        this.server = null
        resolve()
      })
      server.listen(port, bind, () => {
        this.server = server
        this.listening = port
        resolve()
      })
    })
    if (this.server) {
      this.keepalive = setInterval(() => this.tick(), KEEPALIVE_MS)
      // A timer in the main process must never be the reason the app cannot quit.
      this.keepalive.unref?.()
    }
    this.deps.onChange?.()
    return this.state()
  }

  async stop(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    for (const c of this.clients) {
      c.alive = false
      try {
        c.res.end()
      } catch {
        /* a client that is already gone is the normal case here */
      }
    }
    this.clients.clear()
    // Ending the streams by hand does not run the per-client close path that normally
    // notices the last one leaving, so a pty borrowed by a phone would stay bent to that
    // phone's shape after serving was switched off entirely - there being no phone left
    // to ever give it back.
    this.deps.onIdle?.()
    const server = this.server
    this.server = null
    this.listening = 0
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // close() waits for live sockets; the SSE ones were just ended, and anything
      // slower must not hold a quit open.
      setTimeout(resolve, 500).unref?.()
    })
    this.deps.onChange?.()
  }

  get running(): boolean {
    return !!this.server
  }

  /**
   * Everything this server knows. NOT the tunnel: that is a separate child process with a
   * separate switch, and `main/index.ts` merges the two into the one `PhoneState` the
   * panel redraws - so a server that has never heard of cloudflared stays testable on its
   * own, and there is one repaint rather than two.
   */
  state(): Omit<PhoneState, 'tunnel' | 'typeGate' | 'keys'> {
    const port = this.listening || 0
    const live = new Set([...this.clients].map((c) => c.device).filter(Boolean))
    return {
      on: !!this.server,
      port,
      code: this.deps.code(),
      urls: this.server ? phoneUrls(port) : [],
      clients: this.clients.size,
      peers: [...this.clients].map(({ id, address, kind, origin, since }) => ({
        id,
        address,
        kind,
        origin,
        since
      })),
      // The token never leaves this process, so the view is built by dropping it rather
      // than by remembering not to mention it.
      devices: (this.deps.devices?.() ?? []).map(({ token: _t, ...d }) => ({
        ...d,
        live: live.has(d.id)
      })),
      ask: this.asking && !this.asking.answered ? askView(this.asking) : null,
      asking: this.deps.canAsk?.() ?? true,
      error: this.lastError || undefined
    }
  }

  // ---- being let in without a code ---------------------------------------------

  /**
   * Answer the browser that is waiting. Called from the card on this desk.
   *
   * Approving MINTS the device: a fresh 32-byte token, kept here and set as that
   * browser's cookie when it next polls. That is the difference between this and the
   * pairing code - the code makes one cookie that every phone shares, so it can only be
   * revoked for all of them at once and there is no list of who is in.
   */
  answerAsk(ok: boolean): void {
    const ask = this.asking
    if (!ask || ask.answered) return
    ask.answered = ok ? 'yes' : 'no'
    if (ok) {
      const list = this.deps.devices?.() ?? []
      // One row per device, not one per approval. The same phone asks again whenever its
      // cookie is gone - a cleared browser, a private tab, and until the address was made
      // stable, every single restart of the app - and appending each time is what turned
      // this list into eight rows for three phones. Matched on the user-agent because it
      // is the only thing about a browser that survives losing the cookie; an address is
      // not (a phone changes network) and neither is anything the phone could be asked to
      // remember, since the reason it is here is that it remembered nothing.
      // A row written before this app knew to record a user-agent has nothing exact to
      // match on, so it is collapsed on the two things it does carry - what kind of device
      // it is and which side of the front door it came from. That is deliberately loose:
      // it converges the pile of legacy duplicates as each phone next signs in, and the
      // worst it can do is sign out an older phone of the same make, which asks again.
      const same = (d: PhoneDevice): boolean =>
        d.ua ? d.ua === ask.ua : d.kind === ask.kind && d.origin === ask.origin
      this.deps.saveDevices?.([
        ...list.filter((d) => !same(d)),
        {
          id: ask.id,
          kind: ask.kind,
          address: ask.address,
          origin: ask.origin,
          // Kept from the row it replaces: "signed in since" is a fact about the device,
          // and re-approving after a cleared cookie did not make it a new phone.
          at: list.find(same)?.at ?? Date.now(),
          seen: list.find(same)?.seen ?? 0,
          ua: ask.ua,
          token: ask.token
        }
      ])
    }
    this.deps.onChange?.()
  }

  /**
   * Sign one device out - or every one of them, with `*`. Its cookie stops matching at
   * once, because `who()` looks the token up in this list on every single request, and its
   * stream is ended rather than left drawing a desk it is no longer allowed to see.
   */
  /**
   * Notice that a signed-in device has stopped looking like itself, and keep it on the row.
   *
   * The long-lived cookie is the point of the feature - a phone that has to be re-approved
   * at the desk is the manual step this whole path exists to delete - so the answer to "it
   * lasts ten years" is that a copy of it should be VISIBLE rather than that it should
   * expire. Nothing here refuses the request: see the header of `shared/deviceWatch.ts` for
   * why a watcher that revokes on suspicion is worse than no watcher at all.
   *
   * An existing mark is never overwritten by a quieter one and never cleared by an ordinary
   * arrival - only `clearMark` on the desk takes it off. A warning that a later, innocent
   * request wipes out is a warning nobody ever sees, because the browser holding the stolen
   * cookie is making requests too.
   */
  private noticeArrival(device: string, address: string, ua: string): void {
    const list = this.deps.devices?.() ?? []
    const known = list.find((d) => d.id === device)
    if (!known || known.mark) return
    const elsewhere = [...this.clients]
      .filter((c) => c.alive && c.device === device)
      .map((c) => c.origin)
    const mark = markFor(known, { address, origin: originOf(address), ua, at: Date.now() }, elsewhere)
    if (!mark) return
    this.deps.saveDevices?.(list.map((d) => (d.id === device ? { ...d, mark } : d)))
    this.deps.onChange?.()
  }

  /** "That was me." Desk-only, and it takes the mark off without touching the sign-in. */
  clearMark(id: string): void {
    const list = this.deps.devices?.() ?? []
    this.deps.saveDevices?.(list.map((d) => (d.id === id || id === '*' ? { ...d, mark: null } : d)))
    this.deps.onChange?.()
  }

  forgetDevice(id: string): void {
    if (id === '*') {
      this.deps.saveNativeGrants?.([])
    }
    else this.native.revokeBrowser(id)
    const list = this.deps.devices?.() ?? []
    this.deps.saveDevices?.(id === '*' ? [] : list.filter((d) => d.id !== id))
    for (const c of [...this.clients]) {
      if (!c.device || (id !== '*' && c.device !== id)) continue
      c.alive = false
      try {
        c.res.end()
      } catch {
        /* already gone */
      }
      this.clients.delete(c)
    }
    this.deps.onChange?.()
  }

  private async ask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(this.deps.canAsk?.() ?? true)) return this.plain(res, 403, 'asking is off')
    const who = addressOf(req)
    const now = Date.now()
    const seen = this.askTries.get(who)
    const win = seen && now - seen.since < ASK_WINDOW_MS ? seen : { n: 0, since: now }
    // An expired request is not a live one: it must not hold the single slot for ever.
    if (this.asking && (this.asking.answered || now - this.asking.at > ASK_MS)) this.asking = null
    if (this.asking) {
      // The same browser asking again gets its own request back rather than a refusal -
      // a reload while waiting is the normal case, not a second device.
      if (this.asking.address === who) return this.json(res, 200, askView(this.asking))
      return this.plain(res, 409, 'another device is already asking')
    }
    if (win.n >= ASK_LIMIT) return this.plain(res, 429, 'too many requests')
    this.askTries.set(who, { n: win.n + 1, since: win.since })
    const ua = String(req.headers['user-agent'] ?? '')
    this.asking = {
      id: `d${now.toString(36)}${this.nextAsk++}`,
      // Four digits, generated HERE and shown in both places. Not a secret: what it
      // proves is that the phone in your hand is the one the card is about.
      sas: String(randomBytes(2).readUInt16BE(0) % 10000).padStart(4, '0'),
      address: who,
      kind: deviceKind(ua),
      origin: originOf(who),
      at: now,
      answered: null,
      token: randomBytes(32).toString('hex'),
      ua
    }
    this.deps.onChange?.()
    this.json(res, 200, askView(this.asking))
  }

  /**
   * "Has it been approved yet?" - polled by the waiting page.
   *
   * The cookie is set HERE rather than when Approve is pressed, because the desk has no
   * way to reach that browser: the request it is waiting on is the only door back.
   */
  private askState(req: IncomingMessage, res: ServerResponse, id: string): void {
    const ask = this.asking
    if (!ask || ask.id !== id) return this.json(res, 200, { state: 'gone' })
    if (Date.now() - ask.at > ASK_MS && !ask.answered) {
      this.asking = null
      this.deps.onChange?.()
      return this.json(res, 200, { state: 'gone' })
    }
    if (ask.answered === 'no') {
      this.asking = null
      this.deps.onChange?.()
      return this.json(res, 200, { state: 'no' })
    }
    if (ask.answered !== 'yes') return this.json(res, 200, { state: 'waiting' })
    // Approved: hand this browser its own cookie and let go of the slot.
    this.asking = null
    this.deps.onChange?.()
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': cookieFor(req, ask.token)
    })
    res.end('{"state":"yes"}')
  }

  /** One of main's own pushes, on its way to every paired browser. */
  broadcast(channel: string, args: unknown[]): void {
    if (!this.clients.size) return
    if (!this.deps.channels.on.includes(channel)) return
    const frame = `data: ${encodeWire({ channel, args })}\n\n`
    for (const c of this.clients) {
      if (!c.alive) continue
      try {
        c.res.write(frame)
      } catch {
        c.alive = false
      }
    }
  }

  private tick(): void {
    for (const c of [...this.clients]) {
      if (!c.alive) {
        this.clients.delete(c)
        continue
      }
      try {
        c.res.write(': ping\n\n')
      } catch {
        c.alive = false
        this.clients.delete(c)
      }
    }
  }

  // ---- request routing -------------------------------------------------------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    // This tiny manifest describes only the pairing entry page. It is deliberately
    // available before authentication so a home-screen shortcut can retain its own
    // origin and standalone chrome, while every renderer asset remains behind auth.
    if (path === '/pf-entry.webmanifest') return this.entryManifest(res)
    if (path === '/pf/native/v1/auth/start' && req.method === 'POST') return await this.nativeStart(req, res)
    if (path === '/pf/native/v1/auth/token' && req.method === 'POST') return await this.nativeToken(req, res)
    if (path === '/pf/native/v1/auth/revoke' && req.method === 'POST') return this.nativeRevoke(req, res)
    if (path === '/pf/native/v1/sessions' && req.method === 'GET') return this.nativeSessions(req, res)
    if (path.startsWith('/pf/native/v1/prompts/') && req.method === 'GET') return this.nativePromptStatus(req, res, path)
    if (path.startsWith('/pf/native/v1/sessions/') && req.method === 'GET') return this.nativeConversation(req, res, path)
    if (path.startsWith('/pf/native/v1/sessions/') && req.method === 'POST') return await this.nativeSessionAction(req, res, path)
    if (path === '/pf/native/v1/auth/authorize') return this.nativeAuthorize(req, res, url.searchParams.get('request') ?? '')
    if (path === '/pf/native/v1/auth/approve' && req.method === 'POST') return await this.nativeApprove(req, res)
    if (path === '/pf/pair' && req.method === 'POST') return await this.pair(req, res)
    // Both halves of being let in without a code, and both of them before the auth check:
    // a browser that has not been approved yet is exactly who is asking.
    if (path === '/pf/ask' && req.method === 'POST') return await this.ask(req, res)
    if (path === '/pf/ask') return this.askState(req, res, url.searchParams.get('id') ?? '')
    if (!this.authed(req)) {
      // Anything under /pf is machinery: say no rather than handing back a page.
      if (path.startsWith('/pf/')) return this.plain(res, 401, 'pair first')
      return this.pairPage(res)
    }
    if (path === '/pf/events') return this.events(req, res)
    // The passkey gate. All three are behind `authed` on purpose: enrolling a key is a
    // thing a signed-in phone does, not a way to become one.
    if (path === '/pf/key/state') return this.keyState(req, res)
    if (path === '/pf/key/enrol' && req.method === 'POST') return await this.keyEnrol(req, res)
    if (path === '/pf/key/unlock' && req.method === 'POST') return await this.keyUnlock(req, res)
    if (path === '/pf/call' && req.method === 'POST') return await this.call(req, res)
    if (path === '/pf/send' && req.method === 'POST') return await this.fire(req, res)
    return this.static(path, res)
  }

  // ---- native system-browser pairing -----------------------------------------

  private async nativeStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTls(req)) return this.plain(res, 400, 'https required')
    if (!this.nativeRate(req, this.nativeStarts, 10)) return this.plain(res, 429, 'try later')
    const body = await this.readWire<Record<string, string>>(req, res)
    if (!body) return
    try {
      const host = String(req.headers.host ?? '')
      // Native never selects a redirect. The app claims its registered taskdriver URI after
      // the browser page has verified a fresh WebAuthn assertion.
      const start = this.native.start({
        codeChallenge: String(body.codeChallenge ?? ''), state: String(body.state ?? ''),
        deviceId: String(body.deviceId ?? ''), deviceName: String(body.deviceName ?? ''),
        grantId: body.grantId ? String(body.grantId) : undefined
      })
      this.json(res, 200, { authorizationUrl: start.authorizationUrl.replace('https://localhost', `https://${host}`) })
    } catch { this.plain(res, 400, 'native authorization refused') }
  }

  private nativeAuthorize(req: IncomingMessage, res: ServerResponse, request: string): void {
    if (!isTls(req)) return this.plain(res, 400, 'https required')
    const pending = this.native.pendingForBrowser(request)
    if (!pending) return this.plain(res, 410, 'authorization expired')
    // Legacy code cookies have no revocable browser identity. Pair once before
    // approving a native credential so it can be revoked with its parent browser.
    if (!this.who(req)?.device) return this.nativePairPage(res, request)
    const csrf = this.native.csrfFor(request)
    if (!csrf) return this.plain(res, 410, 'authorization expired')
    // The page has no general renderer assets and starts a new required WebAuthn ceremony.
    // The request id is unguessable and is consumed during the later token exchange.
    const nonce = randomBytes(18).toString('base64')
    const esc = (v: string) => JSON.stringify(v).replace(/</g, '\\u003c')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` })
    res.end(String.raw`<!doctype html><html lang="en"><head>
<meta name="referrer" content="no-referrer"><title>Approve PaneForge</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">body{font:17px system-ui;line-height:1.5;max-width:32rem;margin:3rem auto;padding:0 1.5rem;color:#152f32;background:#f5f8f6}button{min-height:48px;padding:12px 20px;font:inherit;border:0;border-radius:12px;color:white;background:#165c50}#status{overflow-wrap:anywhere}</style>
</head><body><p id="label"></p><button id="ok" type="button">Approve with passkey</button><p id="status" role="status"></p>
<script nonce="${nonce}">
const request=${esc(request)},csrf=${esc(csrf)},name=${esc(pending.deviceName)};
document.querySelector('#label').textContent='Approve '+name+' to read and control PaneForge?';
const s=document.querySelector('#status'),b=document.querySelector('#ok');
const u=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const e=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
b.onclick=async()=>{
  try{
    b.disabled=true;s.textContent='Waiting for passkey…';
    if(!window.PublicKeyCredential||!navigator.credentials)throw Error('This browser does not support passkeys.');
    const stateResponse=await fetch('/pf/key/state');
    if(!stateResponse.ok)throw Error('Browser pairing expired. Start this connection again.');
    const st=await stateResponse.json();
    let r;
    if(!st.ids.length){
      // This is already a desk-approved browser. Enrolment performs the same required
      // user verification as an assertion and opens the server's fresh-touch window.
      const userId=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(st.rpId)));
      const c=await navigator.credentials.create({publicKey:{
        challenge:u(st.challenge),rp:{id:st.rpId,name:'PaneForge'},
        user:{id:userId,name:'this desk',displayName:'this desk'},
        pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],
        authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'preferred'},
        attestation:'none',timeout:60000
      }});
      if(!c)throw Error('Passkey creation was cancelled.');
      const a=c.response;
      r=await fetch('/pf/key/enrol',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        challenge:st.challenge,clientDataJSON:e(a.clientDataJSON),attestationObject:e(a.attestationObject),label:name
      })});
    }else{
      const c=await navigator.credentials.get({publicKey:{challenge:u(st.challenge),rpId:st.rpId,allowCredentials:st.ids.map(id=>({type:'public-key',id:u(id)})),userVerification:'required',timeout:60000}});
      if(!c)throw Error('Passkey approval was cancelled.');
      const a=c.response;
      r=await fetch('/pf/key/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        challenge:st.challenge,id:c.id,clientDataJSON:e(a.clientDataJSON),authenticatorData:e(a.authenticatorData),signature:e(a.signature)
      })});
    }
    if(!r.ok)throw Error('Passkey refused. Please try again.');
    r=await fetch('/pf/native/v1/auth/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request,csrf})});
    if(!r.ok)throw Error('Approval refused. Start this connection again.');
    const out=await r.json();
    location.replace('taskdriver://auth/paneforge?code='+encodeURIComponent(out.code)+'&state='+encodeURIComponent(out.state));
  }catch(x){s.textContent=x.message||'Approval failed';b.disabled=false}
};
</script></body></html>`)
  }

  /** First-time browser pairing retains only the opaque request id, then resumes locally. */
  private nativePairPage(res: ServerResponse, request: string): void {
    const nonce = randomBytes(18).toString('base64')
    const encoded = JSON.stringify(request).replace(/</g, '\\u003c')
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    })
    res.end(`<!doctype html><title>Pair browser</title><meta name="viewport" content="width=device-width,initial-scale=1"><style nonce="${nonce}">body{font:17px system-ui;line-height:1.5;max-width:32rem;margin:3rem auto;padding:0 1.5rem;color:#152f32;background:#f5f8f6}button{min-height:48px;padding:12px 20px;font:inherit;border:0;border-radius:12px;color:white;background:#165c50}#status{overflow-wrap:anywhere}</style><p>Ask the PaneForge desk to approve this browser, then this connection will continue.</p><p id="status">Requesting approval…</p><script nonce="${nonce}">const request=${encoded},s=document.querySelector('#status');(async()=>{try{let a=await fetch('/pf/ask',{method:'POST'});if(!a.ok)throw Error('Could not request pairing');let q=await a.json();s.textContent='Approve the matching code '+q.sas+' on PaneForge.';let poll=async()=>{let r=await fetch('/pf/ask?id='+encodeURIComponent(q.id));let x=await r.json();if(x.state==='yes')return location.replace('/pf/native/v1/auth/authorize?request='+encodeURIComponent(request));if(x.state==='waiting')return setTimeout(poll,1500);s.textContent='Pairing was not approved.'};poll()}catch(e){s.textContent=e.message||'Pairing failed.'}})()</script>`)
  }

  private async nativeApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = String(req.headers.origin ?? '')
    const expected = `https://${String(req.headers.host ?? '')}`
    if (!isTls(req) || origin !== expected || !this.authed(req) || !this.unlocked(req)) return this.plain(res, 403, 'fresh passkey required')
    const body = await this.readWire<Record<string, string>>(req, res)
    if (!body) return
    try {
      const browser = this.who(req)?.device ?? ''
      // Empty identifies the legacy code cookie, which cannot be revoked per browser.
      if (!browser || !this.takeFreshPasskey(browser)) throw new Error('fresh browser assertion required')
      this.json(res, 200, this.native.approve(String(body.request ?? ''), String(body.csrf ?? ''), browser, ['read', 'control']))
    } catch { this.plain(res, 400, 'native approval refused') }
  }

  private async nativeToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTls(req)) return this.plain(res, 400, 'https required')
    if (!this.nativeRate(req, this.nativeTokens, 20)) return this.plain(res, 429, 'try later')
    const body = await this.readWire<Record<string, string>>(req, res)
    if (!body) return
    try { this.json(res, 200, this.native.exchange(String(body.code ?? ''), String(body.codeVerifier ?? ''), String(body.deviceId ?? ''))) }
    catch { this.plain(res, 400, 'native exchange refused') }
  }

  private nativeSessions(req: IncomingMessage, res: ServerResponse): void {
    if (!isTls(req) || !this.native.bearer(this.nativeBearer(req), 'read')) return this.plain(res, 401, 'unauthorized')
    const sessions = (this.deps.sessions?.() ?? []).filter((s) => s.status !== 'exited' || s.asleep).map((s) => ({ id: s.id, title: s.title, provider: s.agent === 'codex' ? 'codex' : s.agent === 'claude' ? 'claude' : 'terminal', state: s.asleep ? 'sleeping' : s.status === 'working' ? 'working' : s.ask ? 'needs-input' : 'idle', hostName: 'PaneForge', keepOpen: this.deps.isKeepOpen?.(s.id) ?? false, updatedAt: new Date(s.lastOutput || s.createdAt).toISOString() }))
    this.json(res, 200, { sessions })
  }

  private nativeConversation(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (!isTls(req) || !this.native.bearer(this.nativeBearer(req), 'read')) return this.plain(res, 401, 'unauthorized')
    const id = decodeURIComponent(path.split('/')[5] ?? '')
    const session = (this.deps.sessions?.() ?? []).find((s) => s.id === id)
    if (!session) return this.plain(res, 404, 'not found')
    const cursor = new URL(req.url ?? '/', 'http://localhost').searchParams.get('cursor')
    const semantic = this.deps.semanticConversation?.(id, session.agent, cursor)
    if (semantic) {
      return this.json(res, 200, {
        sessionId: id,
        messages: semantic.messages,
        nextCursor: semantic.nextCursor,
        transcriptAvailable: true,
        rawOutput: semantic.rawOutput,
        updatedAt: new Date(session.lastOutput || session.createdAt).toISOString()
      })
    }
    const raw = this.deps.sessionBuffer?.(id) ?? ''
    const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : Math.max(0, raw.length - 12_000)
    if (!Number.isSafeInteger(start) || start < 0 || start > raw.length) return this.plain(res, 400, 'invalid cursor')
    const end = Math.min(raw.length, start + 12_000)
    // Terminal replay is a separate, explicitly non-semantic fallback while the provider
    // has not yet created, or PaneForge cannot prove, this pane's transcript.
    this.json(res, 200, { sessionId: id, messages: [], nextCursor: end < raw.length ? String(end) : null, transcriptAvailable: false, rawOutput: raw.slice(start, end), updatedAt: new Date(session.lastOutput || session.createdAt).toISOString() })
  }

  private async nativeSessionAction(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const grant = isTls(req) ? this.native.bearer(this.nativeBearer(req), 'control') : null
    if (!grant) return this.plain(res, 401, 'unauthorized')
    if (grant.unlockedUntil <= Date.now()) return this.plain(res, 423, 'locked')
    const parts = path.split('/'); const id = decodeURIComponent(parts[5] ?? ''); const action = parts[6] ?? ''
    if (!(this.deps.sessions?.() ?? []).some((s) => s.id === id)) return this.plain(res, 404, 'not found')
    if (action === 'sleep' || action === 'keep-open') {
      const body = await this.readWire<Record<string, unknown>>(req, res)
      if (!body || typeof body[action === 'sleep' ? 'asleep' : 'keepOpen'] !== 'boolean') return this.plain(res, 400, 'invalid action')
      const value = Boolean(body[action === 'sleep' ? 'asleep' : 'keepOpen'])
      if (action === 'sleep') {
        const result = value ? this.deps.sleepSession?.(id) : this.deps.wakeSession?.(id)
        return result === false || result === null ? this.plain(res, 409, 'session action refused') : this.json(res, 200, {})
      }
      return this.deps.setKeepOpen?.(id, value) ? this.json(res, 200, {}) : this.plain(res, 409, 'session action refused')
    }
    if (action === 'prompt') {
      const body = await this.readWire<Record<string,string>>(req,res)
      const clientMessageId = String(body?.clientMessageId ?? ''); const text = String(body?.text ?? '')
      if (!body || !/^[A-Za-z0-9_-]{8,128}$/.test(clientMessageId) || !text.trim() || text.length > 20_000) return this.plain(res,400,'invalid prompt')
      try {
        const existing = this.native.prompt(grant, clientMessageId)
        const receipt = this.native.acceptPrompt(grant, clientMessageId, id, text)
        // A pre-existing pending receipt may be a crash between queueing and marking.
        // It can be reported as unknown, but must never enqueue the text again.
        if (existing) return this.json(res, 202, this.nativeReceipt(receipt))
        // sendPrompt has accepted the text into PaneForge's durable queue. It does not
        // imply the CLI submitted it, so a queued receipt makes no stronger claim.
        if (!this.deps.sendNativePrompt?.(id, text)) return this.json(res, 202, this.nativeReceipt(this.native.markPrompt(grant, clientMessageId, 'unknown')))
        return this.json(res, 202, this.nativeReceipt(this.native.markPrompt(grant, clientMessageId, 'queued')))
      } catch { return this.plain(res, 409, 'prompt receipt refused') }
    }
    return this.plain(res, 404, 'not found')
  }

  private nativeRevoke(req: IncomingMessage, res: ServerResponse): void {
    if (!isTls(req) || !this.native.revoke(this.nativeBearer(req))) return this.plain(res, 401, 'unauthorized')
    this.json(res, 200, { ok: true })
  }

  private nativePromptStatus(req: IncomingMessage, res: ServerResponse, path: string): void {
    const grant = isTls(req) ? this.native.bearer(this.nativeBearer(req), 'read') : null
    const id = decodeURIComponent(path.split('/')[5] ?? '')
    if (!grant || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) return this.plain(res, 401, 'unauthorized')
    const receipt = this.native.prompt(grant, id)
    if (!receipt) return this.plain(res, 404, 'not found')
    this.json(res, 200, this.nativeReceipt(receipt))
  }

  private nativeReceipt(receipt: NativePromptReceipt): Record<string, string> {
    return { clientMessageId: receipt.clientMessageId, state: receipt.state === 'pending' ? 'unknown' : receipt.state, acceptedAt: receipt.acceptedAt }
  }

  private nativeRate(req: IncomingMessage, bucket: Map<string, { since: number; n: number }>, limit: number): boolean {
    const key = addressOf(req); const now = Date.now()
    for (const [address, entry] of bucket) if (now - entry.since >= 60_000) bucket.delete(address)
    const old = bucket.get(key)
    if (!old && bucket.size >= 1024) return false
    const row = old ?? { since: now, n: 0 }
    row.n += 1; bucket.set(key, row)
    return row.n <= limit
  }

  private nativeBearer(req: IncomingMessage): string | undefined {
    const value = String(req.headers.authorization ?? '')
    return value.startsWith('Bearer ') ? value.slice(7) : undefined
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = addressOf(req)
    const lock = this.tries.get(who)
    if (lock && lock.until > Date.now()) return this.plain(res, 429, 'too many tries')
    const body = await readBody(req).catch(() => '')
    let typed = ''
    try {
      typed = String((JSON.parse(body || '{}') as { code?: string }).code ?? '')
    } catch {
      typed = ''
    }
    if (!sameCode(typed, this.deps.code())) {
      const n = (lock?.n ?? 0) + 1
      this.tries.set(who, { n, until: n >= TRY_LIMIT ? Date.now() + LOCK_MS : 0 })
      return this.plain(res, 403, 'wrong code')
    }
    this.tries.delete(who)
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': cookieFor(req, this.token())
    })
    res.end('{"ok":true}')
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    const address = addressOf(req)
    const device = this.who(req)?.device ?? ''
    if (device) {
      // Before the row is overwritten with where it is NOW, ask whether what just arrived
      // still looks like the thing that was approved. It has to happen here rather than on
      // every request because the answer needs the old address and the old user-agent, and
      // this is the last moment they exist. Advisory only: `markFor` never refuses.
      this.noticeArrival(device, address, String(req.headers['user-agent'] ?? ''))
      // "Last seen" is the stream, not the request: a device that opened the page and
      // walked away is not one that is watching. The ADDRESS is refreshed with it, because
      // the row is read as a place - "a phone in this room" and "a phone off the internet"
      // are different sentences - and the address it was approved from months ago is not
      // where it is now.
      const list = this.deps.devices?.() ?? []
      const now = Date.now()
      this.deps.saveDevices?.(
        list.map((d) =>
          d.id === device
            ? { ...d, seen: now, address, origin: originOf(address), ua: d.ua || String(req.headers['user-agent'] ?? '') }
            : d
        )
      )
    }
    const client: Client = {
      res,
      alive: true,
      device,
      id: `p${this.nextPeer++}`,
      address,
      kind: deviceKind(req.headers['user-agent'] ?? ''),
      origin: originOf(address),
      since: Date.now()
    }
    this.clients.add(client)
    res.write('retry: 2000\n\n')
    res.write(`data: ${encodeWire({ channel: 'phone:hello', args: [] })}\n\n`)
    res.on('close', () => {
      client.alive = false
      this.clients.delete(client)
      // The last phone put its screen down. Anything it bent to a phone's shape - a pane's
      // pty size - belongs to the desk again, and nothing else would ever say so: a browser
      // that is closed, locked or out of range never gets to send a parting message.
      if (!this.clients.size) this.deps.onIdle?.()
      this.deps.onChange?.()
    })
    this.deps.onChange?.()
  }

  private async call(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const msg = await this.readWire<{ id?: number; channel?: string; args?: unknown[] }>(req, res)
    if (!msg) return
    const { id = 0, channel = '', args = [] } = msg
    if (!this.deps.channels.invoke.includes(channel) || DESK_ONLY.has(channel)) {
      // Deliberately the same answer for both: a browser learning which channels exist but
      // are refused is a map of what to attack next.
      return this.json(res, 400, { id, error: `unknown channel ${channel}` })
    }
    // Answered inside the envelope rather than as a 423, because `call` has a reply the
    // client is already waiting on and an HTTP status would lose the id it belongs to.
    if (GATED_INVOKE.has(channel) && !this.unlocked(req)) {
      return this.json(res, 200, { id, error: 'locked', locked: true })
    }
    try {
      const value = await this.deps.invoke(channel, args)
      this.json(res, 200, { id, value })
    } catch (err) {
      this.json(res, 200, { id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async fire(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const msg = await this.readWire<{ calls?: { channel: string; args: unknown[] }[] }>(req, res)
    if (!msg) return
    const calls = msg.calls ?? []
    // Refused as a WHOLE batch, before a single call is made, and never call-by-call. These
    // are keystrokes in order: dropping the gated ones and running the rest would deliver a
    // word with letters missing, and dropping them silently is worse still. 423 is the one
    // status the client retries after unlocking, so the batch it holds is re-sent intact.
    if (calls.some((c) => GATED_SEND.has(c.channel)) && !this.unlocked(req)) {
      return this.plain(res, 423, 'locked')
    }
    // A batch, because typing is one of these per keystroke and they must stay in order.
    for (const c of calls) {
      // `call` refuses DESK_ONLY and this loop did not, so the two handlers disagreed about
      // what the HTTP surface is allowed to reach. No send is desk-only today, which is
      // exactly why it went unnoticed: the first one added would have been reachable from a
      // browser with nothing saying so. Skipped rather than 400-ing the batch, same as an
      // unknown channel - a browser learning which channels are refused is a map.
      if (!this.deps.channels.send.includes(c.channel) || DESK_ONLY.has(c.channel)) continue
      try {
        this.deps.send(c.channel, c.args ?? [])
      } catch {
        /* a desktop-only gesture refusing is not the request's failure */
      }
    }
    this.json(res, 200, { ok: true })
  }

  private static(path: string, res: ServerResponse): void {
    const dir = this.deps.staticDir
    if (!existsSync(dir)) {
      return this.plain(res, 503, 'this build has no renderer on disk yet - run npm run build')
    }
    const rel = normalize(decodeURIComponent(path === '/' ? '/index.html' : path)).replace(
      /^([/\\])+/,
      ''
    )
    // What stops `/../../secret` is the normalize ABOVE, not this line: the path always
    // starts with `/`, and normalizing an absolute path folds away every `..` that would
    // leave the root - `/assets/../../x` becomes `/x`. Kept as a backstop for the day the
    // input stops being absolute, which is the change that would otherwise open the disk.
    if (rel.startsWith('..' + sep) || rel === '..') return this.plain(res, 403, 'no')
    let file = join(dir, rel)
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html')
    if (!existsSync(file)) return this.plain(res, 404, 'not found')
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // The renderer's file names are content-hashed; index.html must not be cached.
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=86400'
    })
    createReadStream(file).pipe(res)
  }

  // ---- the passkey gate ------------------------------------------------------

  /**
   * Is the gate armed for THIS request? Three things have to be true, and each one of them
   * is a case that would otherwise be broken rather than protected:
   *
   * - the setting is on at all;
   * - the request arrived over TLS, because `navigator.credentials` does not exist outside
   *   a secure context - arming over plain http would lock out a phone that has no way to
   *   satisfy the gate, which is a phone on the LAN, which is the common case;
   * - it did not come from this machine. `pf-ctl` and the window itself are already inside
   *   the trust boundary: they can read the pairing code out of config.json.
   */
  private armed(req: IncomingMessage): boolean {
    if (!this.deps.typeGate?.()) return false
    if (!isTls(req)) return false
    return originOf(addressOf(req)) !== 'this machine'
  }

  /** True when this request may reach a gated channel - including when nothing is gated. */
  private unlocked(req: IncomingMessage): boolean {
    if (!this.armed(req)) return true
    const cookie = /(?:^|;\s*)pfu=([^;]+)/.exec(req.headers.cookie ?? '')
    if (!cookie) return false
    return checkUnlock(this.gateSecret(), decodeURIComponent(cookie[1]), this.deps.keys?.() ?? [])
  }

  /**
   * The key the unlock cookie is signed with. Deliberately derived from the pairing code as
   * well as the device secret: rotating the code is the one lever that is already understood
   * to sign everything out, and an unlock window that survived a rotation would be a hole in
   * exactly the response somebody reaches for when they think they have been broken into.
   */
  private gateSecret(): string {
    return createHmac('sha256', this.deps.secret()).update(`gate|${this.deps.code()}`).digest('hex')
  }

  /** A challenge is good once, and only for the couple of minutes after it is handed out. */
  private issueChallenge(): string {
    const now = Date.now()
    for (const [c, until] of this.challenges) if (until <= now) this.challenges.delete(c)
    const challenge = newChallenge()
    this.challenges.set(challenge, now + CHALLENGE_MS)
    return challenge
  }

  private takeChallenge(challenge: string): boolean {
    const until = this.challenges.get(challenge)
    this.challenges.delete(challenge)
    return !!until && until > Date.now()
  }

  /**
   * What the browser needs to build a WebAuthn call: who we are to it, whether it has to
   * bother at all, and a fresh challenge.
   *
   * `rpId` is the host without its port - a relying party id is a domain, and including the
   * port makes every assertion fail with an error that says nothing useful.
   */
  private keyState(req: IncomingMessage, res: ServerResponse): void {
    const host = String(req.headers.host ?? '').split(':')[0]
    const keys = this.deps.keys?.() ?? []
    this.json(res, 200, {
      armed: this.armed(req),
      unlocked: this.unlocked(req),
      rpId: host,
      origin: `https://${String(req.headers.host ?? '')}`,
      // Only ids, never the keys themselves: this is what `allowCredentials` needs and
      // nothing on the phone has any use for a public key.
      ids: keys.map((k) => k.id),
      challenge: this.issueChallenge()
    })
  }

  private async keyEnrol(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readWire<Record<string, string>>(req, res)
    if (!body) return
    try {
      if (!this.takeChallenge(String(body.challenge ?? ''))) throw new Error('stale challenge')
      const key = verifyRegistration(
        { clientDataJSON: body.clientDataJSON, attestationObject: body.attestationObject, label: body.label },
        this.expect(req, String(body.challenge))
      )
      const keys = (this.deps.keys?.() ?? []).filter((k) => k.id !== key.id)
      this.deps.saveKeys?.([...keys, key])
      // Enrolling IS a verified touch - the authenticator just checked the human - so the
      // window opens here rather than making them do it twice in a row.
      this.markFreshPasskey(req)
      this.unlockRes(req, res, key.id)
    } catch (err) {
      this.plain(res, 400, err instanceof Error ? err.message : 'enrolment refused')
    }
  }

  private async keyUnlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readWire<Record<string, string>>(req, res)
    if (!body) return
    try {
      if (!this.takeChallenge(String(body.challenge ?? ''))) throw new Error('stale challenge')
      const keys = this.deps.keys?.() ?? []
      const moved = verifyAssertion(
        {
          id: String(body.id ?? ''),
          clientDataJSON: body.clientDataJSON,
          authenticatorData: body.authenticatorData,
          signature: body.signature
        },
        this.expect(req, String(body.challenge)),
        keys
      )
      this.deps.saveKeys?.(keys.map((k) => (k.id === moved.id ? moved : k)))
      this.markFreshPasskey(req)
      this.unlockRes(req, res, moved.id)
    } catch (err) {
      this.plain(res, 403, err instanceof Error ? err.message : 'refused')
    }
  }

  private markFreshPasskey(req: IncomingMessage): void {
    const device = this.who(req)?.device
    if (device) this.freshPasskeys.set(device, Date.now())
  }

  private takeFreshPasskey(device: string): boolean {
    const at = this.freshPasskeys.get(device)
    this.freshPasskeys.delete(device)
    return !!at && Date.now() - at <= 120_000
  }

  private expect(req: IncomingMessage, challenge: string): { challenge: string; rpId: string; origin: string } {
    const host = String(req.headers.host ?? '')
    return { challenge, rpId: host.split(':')[0], origin: `https://${host}` }
  }

  private unlockRes(req: IncomingMessage, res: ServerResponse, credId: string): void {
    const cookie =
      `pfu=${mintUnlock(this.gateSecret(), credId)}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${Math.floor(UNLOCK_MS / 1000)}` +
      (isTls(req) ? '; Secure' : '')
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': cookie
    })
    res.end(JSON.stringify({ ok: true, until: Date.now() + UNLOCK_MS }))
  }

  // ---- plumbing --------------------------------------------------------------

  private token(): string {
    return createHmac('sha256', this.deps.secret()).update(this.deps.code()).digest('hex')
  }

  private authed(req: IncomingMessage): boolean {
    return this.who(req) !== null
  }

  /**
   * Which device this request is, or null for one that may not be here.
   *
   * Two kinds of cookie are good, and they are the two ways in: the derived one, which is
   * `hmac(deviceId, code)` and identical on every browser that ever typed the code, and a
   * device token minted when somebody pressed Approve. Both are 64 hex characters and
   * both are compared in constant time; the difference is that a token can be taken away
   * from one device without touching the others.
   */
  private who(req: IncomingMessage): { device: string } | null {
    const cookie = /(?:^|;\s*)pf=([a-f0-9]{64})/.exec(req.headers.cookie ?? '')
    if (!cookie) return null
    const got = Buffer.from(cookie[1], 'hex')
    const same = (hex: string): boolean => {
      const want = Buffer.from(hex, 'hex')
      return got.length === want.length && timingSafeEqual(got, want)
    }
    if (same(this.token())) return { device: '' }
    for (const d of this.deps.devices?.() ?? []) if (same(d.token)) return { device: d.id }
    return null
  }

  private async readWire<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
    try {
      const body = await readBody(req)
      return decodeWire(body || '{}') as T
    } catch (err) {
      this.plain(res, 413, err instanceof Error ? err.message : 'bad body')
      return null
    }
  }

  private json(res: ServerResponse, code: number, value: unknown): void {
    const body = encodeWire(value)
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(body)
  }

  private plain(res: ServerResponse, code: number, text: string): void {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(text)
  }

  private pairPage(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAIR_PAGE)
  }

  private entryManifest(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-store'
    })
    // Relative values preserve the hostname that the shortcut was installed from.
    // There is intentionally no renderer asset or service worker here: pairing remains
    // a one-page boundary and an unauthenticated request learns nothing behind it.
    res.end('{"name":"PaneForge","short_name":"PaneForge","start_url":"./","scope":"./","display":"standalone","background_color":"#17150f","theme_color":"#17150f"}')
  }
}

/** Addresses a phone on this network can actually type, best first. */
export function phoneUrls(port: number, nets = networkInterfaces()): string[] {
  const out: string[] = []
  for (const [, list] of Object.entries(nets)) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue
      out.push(`http://${net.address}:${port}`)
    }
  }
  // The QR encodes the FIRST of these, and what a phone's camera opens must be an address
  // a plain phone can reach: the LAN. A tailnet address (100.64.0.0/10) answers only for
  // a phone that runs Tailscale itself — leading with it is what made the QR a dead link
  // on every ordinary phone the moment this desk had a tailscale interface up.
  const rank = (u: string): number =>
    originOf(hostOf(u)) === 'this network' ? 0 : isTailscale(u) ? 1 : 2
  out.sort((a, b) => rank(a) - rank(b))
  return out
}

function isTailscale(url: string): boolean {
  const m = /^http:\/\/100\.(\d+)\./.exec(url)
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127
}

/**
 * No vowels and no lookalikes: it is read off a screen and typed once.
 *
 * **Six is a LAN number, not a secret.** 27 characters to the sixth is 387 million, which
 * nobody walks through the front door of a private address - the lockout is five tries per
 * address and there is nothing behind a wrong one but a 40-byte page. Put a public https
 * address in front of the same door and that arithmetic changes: attempts come from as
 * many addresses as the attacker likes, the per-address lockout stops counting for them,
 * and 387 million at a thousand a second is about four and a half days for a shell on this
 * machine. So the tunnel lengthens it rather than trusting the lockout - and it costs
 * nothing, because the QR carries the code and nobody types it.
 */
export function newPhoneCode(length = 6): string {
  const alphabet = '23456789BCDFGHJKMNPQRSTVWXZ'
  // rejection-sampled: `% 27` over 256 favours the first 13 letters by about 1.2x, which
  // is a real bias in a secret this short.
  const out: string[] = []
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 243) continue
      out.push(alphabet[b % alphabet.length])
      if (out.length === length) break
    }
  }
  return out.join('')
}

function sameCode(typed: string, real: string): boolean {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const a = Buffer.from(clean(typed))
  const b = Buffer.from(clean(real))
  if (!b.length || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The Set-Cookie that keeps a phone signed in, and the two details that decide whether it
 * really does.
 *
 * - **`SameSite=Lax`, not `Strict`.** Strict withholds the cookie on a CROSS-SITE
 *   navigation, and every way this address is actually opened is one: a QR scanned in the
 *   Camera app, a link tapped in Messages or Notes, a bookmark opened from another app's
 *   in-app browser. The desk then sees a request with no cookie, decides this browser has
 *   never been here, and serves the pairing page - so a phone that WAS signed in asks to
 *   be let in again, and the sign-in that was working looked broken. Lax sends it on
 *   top-level navigations, which is exactly that case, and still withholds it from
 *   cross-site POSTs and subresources, which is what the flag is for.
 * - **`Secure` only when the request arrived over TLS.** Behind Funnel or the tunnel that
 *   is `x-forwarded-proto: https`, and a Secure cookie is what stops the same token being
 *   sent in clear if the LAN address is ever opened. On plain http over the LAN, marking
 *   it Secure would mean the browser stores a cookie it will never send back - a phone
 *   that signs in successfully and is asked again on the very next request.
 */
function cookieFor(req: IncomingMessage, token: string): string {
  const tls = isTls(req)
  return (
    `pf=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}` +
    (tls ? '; Secure' : '')
  )
}

/**
 * Did this request arrive over TLS? Only a proxy can tell us - the socket here is always
 * plain http, because cloudflared and Funnel both terminate TLS and re-issue locally. Same
 * trust rule as `addressOf`: a header is believed because the one hop in front of us is one
 * we put there ourselves.
 */
function isTls(req: IncomingMessage): boolean {
  const proto = header(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase()
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true
  // The listener is reachable on the LAN, so only our loopback TLS terminator may assert
  // a forwarded protocol. A header from a direct caller never upgrades cleartext.
  return isLoopback(normalise(req.socket.remoteAddress ?? '')) && proto === 'https'
}

/**
 * Node hands back an IPv4-mapped IPv6 address (`::ffff:192.168.1.5`) whenever the listener
 * is dual-stack, which is every time it binds `0.0.0.0`. Normalising here rather than at
 * the two call sites matters: this string is BOTH the lockout key and what the panel
 * prints, and the two must be the same address or a phone can be locked out under one
 * spelling and shown under another.
 */
function addressOf(req: IncomingMessage): string {
  const socket = normalise(req.socket.remoteAddress ?? '?')
  // Behind the tunnel EVERY phone arrives from 127.0.0.1: cloudflared holds the TLS
  // connection and re-issues the request locally. Believing the socket there collapses
  // every device on earth into one identity, and this string is the ask slot, the lockout
  // key and the words the panel prints - so a second phone scanning while a first waited
  // was handed the first one's request and its four digits, five scans from anywhere in the
  // world locked the door for ten minutes, and a phone on a train was labelled "this
  // machine", which is the one label that turns the card's internet warning off.
  //
  // The header is believed ONLY from loopback, which is the one hop we put there ourselves.
  // A local process could spoof it, and that grants nothing: it is already inside the trust
  // boundary (it can read the pairing code out of config.json, which is what `pf-ctl` does)
  // and the only thing it could buy is an escape from a rate limit it never had to obey.
  if (!isLoopback(socket)) return socket
  const forwarded =
    header(req, 'cf-connecting-ip') ||
    // The left-most entry of `x-forwarded-for` is the client; the rest are the proxies.
    header(req, 'x-forwarded-for').split(',')[0].trim()
  const claimed = normalise(forwarded)
  // Shape-checked before it is believed: this string is printed in the panel and in the
  // card, and a header is written by whoever sent the request.
  const looksLikeAddress = /^[0-9a-fA-F.:]{3,45}$/.test(claimed)
  return looksLikeAddress && !isLoopback(claimed) ? claimed : socket
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

function normalise(raw: string): string {
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(raw)
  return mapped ? mapped[1] : raw
}

function isLoopback(address: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.')
}


async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let size = 0
    const parts: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The only thing an unpaired browser is given. Deliberately one file with no assets: it
 * is what the open internet would see if this port were ever exposed, so it holds no
 * hint of what is behind it and nothing that has to be kept in step with the app.
 *
 * **The code may arrive in the URL fragment**, which is what the QR in Settings encodes -
 * `http://<address>:<port>/#<code>` - so a camera does the pairing and nothing is typed.
 * A fragment rather than a query on purpose: a browser never sends it to the server, so
 * the code stays out of the access log, out of any proxy in front of this, and out of the
 * `Referer` of anything the app later loads. The page posts it exactly as a person would,
 * which means the same lockout counts it, and drops it out of the address bar afterwards.
 * A wrong or stale one just falls through to the form rather than dead-ending.
 */
const PAIR_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>PaneForge</title><style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;background:#17150f;color:#f3ece0;
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));box-sizing:border-box}
main{width:min(360px,100%);text-align:center}
h1{font-size:17px;font-weight:600;letter-spacing:.02em;margin:0 0 4px}
p{margin:0 0 22px;opacity:.6;font-size:14px}
input{width:100%;min-height:56px;box-sizing:border-box;font:600 28px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
letter-spacing:.28em;text-align:center;text-transform:uppercase;padding:16px 12px;border-radius:12px;
border:1px solid #3a3327;background:#1f1c14;color:#f3ece0}
input:focus{outline:2px solid #f0a868;outline-offset:1px}
button{margin-top:14px;width:100%;min-height:48px;padding:14px;border:0;border-radius:12px;background:#f0a868;
color:#211a10;font:600 16px/1 inherit}
.bad{margin-top:14px;color:#f08a7a;font-size:14px;min-height:20px}
.sas{font:700 44px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.22em;
margin:6px 0 2px;text-indent:.22em}
.dots{display:inline-flex;gap:5px;margin-top:16px}
.dots i{width:6px;height:6px;border-radius:50%;background:#f0a868;opacity:.25;
animation:b 1.2s ease-in-out infinite}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes b{40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.dots i{animation:none;opacity:.6}}
[hidden]{display:none!important}
</style><meta name="theme-color" content="#17150f"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="PaneForge"><link rel="manifest" href="/pf-entry.webmanifest"></head><body>
<main id=wait hidden>
<h1>PaneForge</h1><p id=waitsay>Check this number on the desk, then press Approve there.</p>
<div class=sas id=sas></div>
<div class=dots><i></i><i></i><i></i></div>
<div class=bad id=asked></div>
</main>
<main id=manual hidden><form id=f>
<h1>Connect this phone</h1><p>This shortcut reached PaneForge, but this browser is not signed in here yet. Scan the current code in Devices, or enter it below.</p>
<input id=c autocomplete=off autocapitalize=characters spellcheck=false inputmode=text maxlength=16>
<button>Connect</button><div class=bad id=e></div></form></main>
<main id=busy hidden><p>Connecting&hellip;</p></main>
<script>
var el=function(id){return document.getElementById(id)}
var f=el('f'),c=el('c'),e=el('e')
function show(id){['wait','manual','busy'].forEach(function(k){el(k).hidden=k!==id})}
function pair(code){return fetch('/pf/pair',{method:'POST',body:JSON.stringify({code:code})})}
function fail(r){e.textContent=r&&r.status===429?'Too many tries. Wait a minute.':'That code is not right.'
c.value='';c.focus()}
function typeIt(msg){show('manual');if(msg)e.textContent=msg;c.focus()}
f.onsubmit=function(ev){ev.preventDefault();e.textContent=''
pair(c.value).then(function(r){if(r.ok){location.reload();return}fail(r)})
.catch(function(){e.textContent='No answer from the desk.'})}

/* Being let in with nothing typed. The desk raises a card carrying the same four digits
   this page shows; the poll below is the only way back to this browser, so the cookie
   arrives on it rather than on the press. A refusal, an expiry or asking being switched
   off all land on the code form rather than on a dead end. */
function askToGetIn(){show('wait')
fetch('/pf/ask',{method:'POST'}).then(function(r){
if(!r.ok)return typeIt(r.status===429?'Too many requests from here. Wait a few minutes, or type the code.':'')
return r.json().then(function(a){el('sas').textContent=a.sas.slice(0,2)+' '+a.sas.slice(2)
poll(a.id)})}).catch(function(){typeIt('No answer from the desk.')})}
function poll(id){setTimeout(function(){
fetch('/pf/ask?id='+encodeURIComponent(id)).then(function(r){return r.json()}).then(function(s){
if(s.state==='yes'){show('busy');location.replace(location.pathname);return}
if(s.state==='no')return typeIt('That was refused on the desk.')
if(s.state==='gone')return typeIt('That request timed out.')
poll(id)}).catch(function(){poll(id)})},1200)}

var scanned=(location.hash||'').replace(/^#/,'').replace(/[^A-Za-z0-9]/g,'')
if(scanned){show('busy')
pair(scanned).then(function(r){
if(r.ok){location.replace(location.pathname);return}
/* A stale code in an old QR is not a dead end: ask instead. */
askToGetIn()}).catch(function(){typeIt('No answer from the desk.')})}else{askToGetIn()}
</script></body></html>`
