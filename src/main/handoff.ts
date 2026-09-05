// Handing a pane to another device, whole: conversation, code and screen.
//
// The pty cannot move (it is a live process), so a handoff moves the three
// things that outlive it and lets the far end start a fresh pty on top of
// them. The git remote carries the code - the sender commits and pushes what
// is dirty as an `auto-sync:` subject (which deploys nothing), and the
// receiver pulls it. The link itself carries only the transcript file and the
// screen tail, because those exist nowhere but the sending disk.
//
// Everything here takes its dependencies as arguments and imports nothing from
// Electron, so the test drives both ends against real git repositories and a
// captured `start` without an app. The receiver never destroys local work: a
// dirty or unpushed checkout on this machine fails THAT pane's handoff by
// name, and the sender keeps its pane open when the far end says no.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  handoffConversationError,
  handoffAgentError,
  mapCwd,
  type HandoffItem,
  type HandoffRequest,
  type HandoffPayload,
  type HandoffRepo,
  type HandoffResult
} from '../shared/handoff'
import { queuedNote } from '../shared/autoHandoff'
import type { DevServer } from '../shared/devServers'
import type { Session, StartSessionRequest } from '../shared/types'

type Json = Record<string, unknown>
function rowsOf(file: Buffer): Json[] | null {
  try {
    const rows = file.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Json)
    return rows.length ? rows : null
  } catch {
    return null
  }
}

function hasCompleteReply(agent: string, rows: Json[]): boolean {
  return rows.some((row) => {
    const payload = row.payload as Json | undefined
    const message = row.message as Json | undefined
    return agent === 'codex'
      ? row.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant'
      : row.type === 'assistant' && (message?.role === 'assistant' || !message?.role)
  })
}

type CodexImport = { rows: Json[]; timestamp: Date }
function parseCodex(file: Buffer, id: string): CodexImport | null {
  const rows = rowsOf(file)
  if (!rows || !hasCompleteReply('codex', rows)) return null
  const metas = rows.filter((row) => row.type === 'session_meta')
  if (metas.length !== 1) return null
  const payload = metas[0].payload as Json | undefined
  const ids = [payload?.id, payload?.session_id].filter((value): value is string => typeof value === 'string')
  if (!payload || ids.length === 0 || ids.some((value) => value !== id)) return null
  const timestamp = new Date(typeof payload.timestamp === 'string' ? payload.timestamp : '')
  return Number.isNaN(timestamp.valueOf()) ? null : { rows, timestamp }
}

function importCodex(parsed: CodexImport, id: string, cwd: string): { file: Buffer; path: string } | null {
  const meta = parsed.rows.find((row) => row.type === 'session_meta')!
  ;(meta.payload as Json).cwd = cwd
  const stamp = parsed.timestamp.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-')
  const day = stamp.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  return {
    file: Buffer.from(parsed.rows.map((row) => JSON.stringify(row)).join('\n') + '\n'),
    path: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions', day.slice(0, 4), day.slice(5, 7), day.slice(8, 10), `rollout-${stamp}-${id}.jsonl`)
  }
}

function writeConversation(path: string, file: Buffer): string | null {
  if (existsSync(path)) {
    try {
      if (readFileSync(path).equals(file)) return null
    } catch { /* refuse below */ }
    return 'A different conversation file already exists here, so nothing was overwritten'
  }
  const directory = dirname(path)
  const temp = join(directory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temp, file, { flag: 'wx' })
    linkSync(temp, path)
    return null
  } catch {
    return existsSync(path) ? 'A different conversation file already exists here, so nothing was overwritten' : 'Conversation transcript could not be stored safely'
  } finally {
    try { unlinkSync(temp) } catch { /* already published or absent */ }
  }
}

/** How much screen goes with the pane. Same order as the pane's own buffer cap. */
const TAIL_BYTES = 200_000

/**
 * Re-checked here even though the sender checked it.
 *
 * The sender is another machine, so everything it says is a claim. This is the only thing
 * between a payload and a script name being spoken into a shell on this desk.
 */
const SCRIPT = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,39}$/

function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n')[0] || 'git failed'))
        else resolve(stdout.trim())
      }
    )
  })
}

const slash = (p: string): string => p.replace(/\\/g, '/')

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** `path` relative to `root` with forward slashes, or null when outside it. */
function relUnder(path: string, root: string): string | null {
  const r = slash(root).replace(/\/+$/, '')
  const p = slash(path)
  if (p.toLowerCase() === r.toLowerCase()) return ''
  if (!p.toLowerCase().startsWith(r.toLowerCase() + '/')) return null
  return p.slice(r.length + 1)
}

/**
 * Could this pane's CODE reach another machine at all - asked BEFORE anything moves.
 *
 * `pushRepo` below already refuses a checkout with no origin and one outside the projects
 * root, but it refuses them from inside the move: by then the app has picked that pane,
 * named a machine, counted fifteen seconds down at somebody, and the only outcome
 * available is a failure and a cooldown. Robert, 2026-08-28: it "should've checked first
 * if the work being done can be done remote or from the shared repo that remote pc should
 * be synced with".
 *
 * So this is the same two questions, read cheaply and up front, and the automatic sweeps
 * refuse a pane it says no to (`AutoPane.shareable`). It deliberately does NOT ask whether
 * the work is pushed: dirty and unpushed are what the move itself fixes, by committing
 * under an `auto-sync:` subject and pushing. Only a repo with nowhere to push TO, or one
 * that is not a repo at all, is a "no" - those cannot become yes by trying harder.
 *
 * Cached for `SHARE_TTL_MS` by folder, because the sweeps ask about every pane on a timer
 * and `git remote get-url` is two processes.
 */
const SHARE_TTL_MS = 5 * 60_000
const shareCache = new Map<string, { at: number; ok: boolean }>()

export async function shareable(cwd: string, root: string, now = Date.now()): Promise<boolean> {
  const hit = shareCache.get(cwd)
  if (hit && now - hit.at < SHARE_TTL_MS) return hit.ok
  const ok = await readShareable(cwd, root)
  shareCache.set(cwd, { at: now, ok })
  return ok
}

async function readShareable(cwd: string, root: string): Promise<boolean> {
  let top = ''
  try {
    top = await git(cwd, ['rev-parse', '--show-toplevel'], 10_000)
  } catch {
    // Not a repo. A shell pane in a scratch folder has nothing to send and nothing to
    // resume from, and moving it would start an agent over there in an empty directory.
    return false
  }
  if (relUnder(top, root) === null && relUnder(real(top), real(root)) === null) return false
  try {
    return !!(await git(cwd, ['remote', 'get-url', 'origin'], 10_000))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Sending

export interface SendDeps {
  root(): string
  /** say which half of the move is running, for the pane's chip */
  stage?(id: string, stage: string | null): void
  /** one line per step into handoff.log - the evidence "it says moving and never moves" needs */
  log?(line: string): void
  list(): Session[]
  /** the same specs a desk restore uses - resumeId and scrollbackId included */
  snapshot(): StartSessionRequest[]
  kill(id: string): void
  /** the pane's screen, from its history file - raw bytes, ANSI intact */
  tailOf(id: string, bytes: number): string
  /**
   * The width those bytes were painted at. History's own reading, never the live pane's
   * `cols` - a pane whose size a phone or a mirror has BORROWED reports the borrower's
   * grid, and the bytes on disk were painted at the desk's.
   */
  tailColsOf?(id: string): number
  /** where the pane's conversation lives on this disk, if anywhere */
  transcriptFileFor(cwd: string, resumeId: string, agent: string): string | null
  canResume?(device: string, agent: string): boolean
  deliver(device: string, payload: HandoffPayload, file: Buffer | null): Promise<HandoffResult>
  deviceName(device: string): string
  /** This device's own id, stamped on the pane over there so it is never sent back here. */
  selfDevice?(): string
  /**
   * Whether this pane is mid-turn, or sitting on a question it drew on screen.
   *
   * A handoff kills the pty, and a pty killed mid-turn takes the answer being written with
   * it - the far end resumes from a transcript holding only what the CLI already flushed.
   * So a busy pane is handed to `queue` instead of moved, and moves when its turn ends.
   * Absent means "never busy", which is the behaviour this had before the queue existed.
   */
  busy?(s: Session): boolean
  /** Take this pane, to be moved to `device` once it goes quiet. */
  queue?(id: string, device: string, closeReceiverWhenDone: boolean): void
  /** The dev servers this pane has running, as script names its repo really has. */
  devServersOf?(id: string, cwd: string): Promise<{ servers: DevServer[]; notes: string[] }>
}

/**
 * Hand panes to a device, one at a time so a failure names its pane and takes
 * nothing else with it. `ids` empty means every local live pane. A pane is
 * killed here only after the far end has said its replacement is running.
 */
export async function sendHandoff(deps: SendDeps, device: string, request: HandoffRequest = {}): Promise<HandoffItem[]> {
  const wanted = new Set(request.ids ?? [])
  const panes = deps
    .list()
    .filter((s) => !s.id.startsWith('@') && s.status !== 'exited')
    .filter((s) => wanted.size === 0 || wanted.has(s.id))
  const out: HandoffItem[] = []
  const closeAfter = request.closeReceiverWhenDone === true
  for (const pane of panes) {
    // Do this before a busy pane enters the queue. A countdown for a provider
    // that cannot carry its conversation is a false promise, not useful work.
    const snapshot = deps.snapshot().find((r) => r.scrollbackId === pane.id)
    const agent = snapshot?.agent || pane.agent || 'claude'
    const unsupported = handoffAgentError(agent)
    if (unsupported) {
      deps.log?.(`${pane.id} -> ${deps.deviceName(device)}: refused before queue - ${unsupported}`)
      out.push({ id: pane.id, title: pane.title, ok: false, error: unsupported, notes: [] })
      continue
    }
    if (agent !== 'shell' && deps.canResume?.(device, agent) !== true) {
      const error = `The receiving device does not support safe ${agent === 'codex' ? 'Codex' : 'Claude'} resume yet, so this pane stayed here`
      deps.log?.(`${pane.id} -> ${deps.deviceName(device)}: refused before queue - ${error}`)
      out.push({ id: pane.id, title: pane.title, ok: false, error, notes: [] })
      continue
    }
    // Mid-turn: queued, never killed. `waitForTurn` defaults on - the caller has to say
    // out loud that an unfinished answer is expendable.
    if (request.waitForTurn !== false && deps.busy?.(pane) && deps.queue) {
      deps.queue(pane.id, device, closeAfter)
      out.push({
        id: pane.id,
        title: pane.title,
        ok: false,
        pending: true,
        error: queuedNote(deps.deviceName(device)),
        notes: []
      })
      continue
    }
    try {
      out.push(await sendOne(deps, device, pane, closeAfter))
    } catch (err) {
      out.push({ id: pane.id, title: pane.title, ok: false, error: (err as Error).message, notes: [] })
    }
  }
  return out
}

async function sendOne(deps: SendDeps, device: string, pane: Session, closeReceiverWhenDone: boolean): Promise<HandoffItem> {
  const spec = deps.snapshot().find((r) => r.scrollbackId === pane.id)
  if (!spec) return { id: pane.id, title: pane.title, ok: false, error: 'Pane has already closed', notes: [] }
  const notes: string[] = []
  const where = deps.deviceName(device)
  const t0 = Date.now()

  // This comes before git add/commit/push. A handoff that cannot carry the
  // conversation is not a useful handoff, and may not leave an auto-sync
  // commit behind while it refuses.
  const handoffSpec: StartSessionRequest = { ...spec, resume: spec.agent === 'claude' || spec.agent === 'codex' ? true : undefined }
  let file: Buffer | null = null
  let transcript: HandoffPayload['transcript']
  if ((handoffSpec.agent === 'claude' || handoffSpec.agent === 'codex') && handoffSpec.resumeId) {
    const path = deps.transcriptFileFor(handoffSpec.resumeCwd ?? pane.cwd, handoffSpec.resumeId, handoffSpec.agent || 'claude')
    try {
      if (path) {
        const size = statSync(path).size
        transcript = { name: `${handoffSpec.resumeId}.jsonl`, size }
        const error = handoffConversationError(handoffSpec, transcript)
        if (error) return { id: pane.id, title: pane.title, ok: false, error, notes }
        const rows = rowsOf(readFileSync(path))
        if (!rows || !hasCompleteReply(handoffSpec.agent, rows)) {
          return {
            id: pane.id,
            title: pane.title,
            ok: false,
            error: `${handoffSpec.agent === 'codex' ? 'Codex' : 'Claude'} conversation is malformed or has no completed assistant reply to resume, so it was not handed off`,
            notes
          }
        }
        file = readFileSync(path)
        const changed = handoffConversationError(handoffSpec, transcript, file.length)
        if (changed) return { id: pane.id, title: pane.title, ok: false, error: changed, notes }
      }
    } catch {
      return { id: pane.id, title: pane.title, ok: false, error: 'Claude conversation transcript could not be read, so it was not handed off', notes }
    }
  }
  const conversationError = handoffConversationError(handoffSpec, transcript, file?.length)
  if (conversationError) {
    deps.log?.(`${pane.id} -> ${where}: refused before repo push - ${conversationError}`)
    return { id: pane.id, title: pane.title, ok: false, error: conversationError, notes }
  }

  deps.log?.(`${pane.id} -> ${where}: pushing the repo (${pane.title})`)
  deps.stage?.(pane.id, 'pushing the repo')

  const repo = await pushRepo(pane.cwd, deps.root(), where)
  if (typeof repo === 'string') {
    deps.log?.(`${pane.id} -> ${where}: refused after ${Date.now() - t0} ms - ${repo}`)
    return { id: pane.id, title: pane.title, ok: false, error: repo, notes }
  }
  deps.log?.(`${pane.id} -> ${where}: repo ready in ${Date.now() - t0} ms`)
  if (!repo) notes.push('Not a git repo - only the pane moved, not code')

  // Read BEFORE the pane is killed: the tree is the only record of what it was running,
  // and `kill()` takes the whole tree with it.
  let dev: DevServer[] = []
  if (deps.devServersOf) {
    try {
      const found = await deps.devServersOf(pane.id, pane.cwd)
      dev = found.servers
      notes.push(...found.notes)
    } catch {
      /* a locked-down process table is a missing note, never a failed handoff */
    }
  }

  const payload: HandoffPayload = {
    spec: handoffSpec,
    senderRoot: deps.root(),
    senderDevice: deps.selfDevice?.() || undefined,
    repo: repo ?? undefined,
    tail: deps.tailOf(pane.id, TAIL_BYTES) || undefined,
    tailCols: deps.tailColsOf?.(pane.id) || undefined,
    closeReceiverWhenDone: closeReceiverWhenDone || undefined,
    dev: dev.length ? dev : undefined
  }
  if (handoffSpec.agent !== 'shell') payload.sourceRetained = true
  if (transcript) payload.transcript = transcript

  deps.stage?.(pane.id, `sending to ${where}`)
  const t1 = Date.now()
  const result = await deps.deliver(device, payload, file).catch((err: Error) => {
    deps.log?.(`${pane.id} -> ${where}: send failed after ${Date.now() - t1} ms - ${err.message}`)
    throw err
  })
  if (!result.ok) {
    deps.log?.(`${pane.id} -> ${where}: refused over there after ${Date.now() - t1} ms - ${result.error || 'no reason given'}`)
    return { id: pane.id, title: pane.title, ok: false, error: result.error || 'Refused over there', notes }
  }
  if (handoffSpec.agent !== 'shell') {
    const kept = 'Remote conversation opened, but this original pane stays open because PaneForge cannot yet confirm the remote agent accepted the resume.'
    deps.log?.(`${pane.id} -> ${where}: remote process started after ${Date.now() - t1} ms; original kept - resume acceptance is not confirmed`)
    return { id: pane.id, title: pane.title, ok: true, sourceKept: true, notes: [...notes, ...result.notes, kept] }
  }
  deps.log?.(`${pane.id} -> ${where}: running there after ${Date.now() - t1} ms (${Date.now() - t0} ms in all)`)
  // The far end's pane is running; this one is now a second window onto old state.
  deps.kill(pane.id)
  return { id: pane.id, title: pane.title, ok: true, notes: [...notes, ...result.notes] }
}

/**
 * Put the pane's repo somewhere the other machine can reach: commit what is
 * dirty under an `auto-sync:` subject (deploy guards ignore those) and push
 * the branch. Returns the repo facts, null for "not a repo", or the error
 * string that should fail this pane - unpushable work must not be handed off
 * as if it travelled.
 */
async function pushRepo(cwd: string, root: string, deviceName: string): Promise<HandoffRepo | null | string> {
  let top = ''
  try {
    top = await git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
  // git answers with the REAL path, and roots are routinely symlinks (macOS /var,
  // a linked ~/Projects) - so a miss is retried with both sides resolved.
  const dirRel = relUnder(top, root) ?? relUnder(real(top), real(root))
  if (dirRel === null) return `Repo lives outside the projects root (${top})`
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') return 'Repo is on a detached HEAD - check out a branch first'
  let url = ''
  try {
    url = await git(cwd, ['remote', 'get-url', 'origin'])
  } catch {
    return 'Repo has no origin remote - the other machine has no way to fetch it'
  }
  let dirty = false
  if (await git(cwd, ['status', '--porcelain'])) {
    dirty = true
    await git(cwd, ['add', '-A'])
    await git(cwd, ['commit', '-m', `auto-sync: handoff to ${deviceName}`])
  }
  // A push of a branch the remote already has is still a full round trip - 944 ms measured
  // against this repo's real origin, with nothing to transfer - and it is a third of the
  // whole handoff. Skipped only on the reading that means it genuinely has nothing to say:
  // nothing was committed just now, and no commit here is missing from every remote branch.
  // That is `git-risk`'s definition of unbacked and not `@{u}..HEAD`, which counts commits
  // origin already holds under another name.
  let unpushed = true
  if (!dirty) {
    try {
      unpushed = (await git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])) !== '0'
    } catch {
      /* a repo with no remote refs yet: push, the way this always did */
    }
  }
  if (dirty || unpushed) {
    try {
      await git(cwd, ['push', 'origin', branch], 120_000)
    } catch (err) {
      return `Push failed, so the code cannot follow: ${(err as Error).message}`
    }
  }
  let sha = ''
  try {
    sha = await git(cwd, ['rev-parse', 'HEAD'])
  } catch {
    /* an empty repo has no HEAD; the receiver then falls back to fetching */
  }
  return { url, branch, dirRel, sha: sha || undefined }
}

// ---------------------------------------------------------------------------
// Receiving

export interface ReceiveDeps {
  root(): string
  /** the same lane split a local launch goes through, deciding the final cwd */
  place(req: StartSessionRequest): Promise<StartSessionRequest>
  start(req: StartSessionRequest): Session | Promise<Session>
  /** where this machine keeps pane history logs */
  historyDir(): string
  /**
   * Record the width the arriving screen was painted at, against the id it is written
   * under. `restoredTail` asks `colsOf` for exactly this a moment later, and an unknown
   * width means the far desk's frame is replayed raw into this one.
   */
  noteTailCols?(id: string, cols: number): void
  /** where this machine's Claude CLI keeps transcripts for a folder */
  claudeProjectDir(cwd: string): string
  /**
   * Start a dev server the sender had running, in the pane's folder here.
   *
   * Given a SCRIPT NAME, never a command: the command is rebuilt from this machine's own
   * package.json and lockfile, so a payload can only ever name something the repo's own
   * author wrote. Returns the note to report, or null when it started cleanly.
   */
  startDev?(dir: string, script: string): string | null
}

/**
 * The other machine handed a pane over. Pull the branch, write the transcript
 * where the CLI here will look for it, seed the screen, start the pane.
 */
export async function receiveHandoff(
  deps: ReceiveDeps,
  payload: HandoffPayload,
  file: Buffer | null
): Promise<HandoffResult> {
  const notes: string[] = []
  const spec = payload.spec
  const conversationError = handoffConversationError(spec, payload.transcript, file ? file.length : null)
  if (conversationError) return { ok: false, error: conversationError, notes }
  if (spec.agent !== 'shell' && payload.sourceRetained !== true) {
    return { ok: false, error: 'Sender cannot prove it retained the original agent pane, so this conversation was not started', notes }
  }
  // Parse every received byte before a repo pull, folder creation, or lane placement. The
  // target cwd is intentionally applied later, after `place()` has selected its lane.
  const codex = spec.agent === 'codex' && file && spec.resumeId ? parseCodex(file, spec.resumeId) : null
  if (file && payload.transcript && spec.agent === 'codex' && !codex) {
    return { ok: false, error: 'Conversation transcript is malformed, incomplete, or does not match its resume ID', notes }
  }
  if (file && payload.transcript && spec.agent === 'claude') {
    const rows = rowsOf(file)
    if (!rows || !hasCompleteReply('claude', rows)) {
      return { ok: false, error: 'Conversation transcript is malformed, incomplete, or does not match its resume ID', notes }
    }
  }
  const mapped = mapCwd(spec.cwd, payload.senderRoot, deps.root())
  if (!mapped) {
    return { ok: false, error: `No matching folder here for ${spec.cwd}`, notes }
  }
  if (payload.repo) {
    const err = await ensureRepo(payload.repo, payload.senderRoot, deps.root())
    if (err) return { ok: false, error: err, notes }
  }
  if (!existsSync(mapped)) {
    if (payload.repo) return { ok: false, error: `Pulled the repo but ${mapped} does not exist in it`, notes }
    mkdirSync(mapped, { recursive: true })
    notes.push('Folder did not exist here - created empty')
  }

  const req = await deps.place({
    cwd: mapped,
    title: spec.title,
    agent: spec.agent,
    model: spec.model,
    role: spec.role,
    laneEnv: spec.laneEnv
  })

  // Where it came from, kept on the pane. The budget rule over here is the same rule that
  // sent it, so without this the two desks pass one pane between them for ever.
  if (payload.senderDevice) req.arrivedFrom = payload.senderDevice

  // After placement, never before: a lane split moves the cwd, and the CLI reads
  // transcripts from a folder named after the cwd it actually starts in.
  if (file && payload.transcript && /^[A-Za-z0-9._-]+\.jsonl$/.test(payload.transcript.name)) {
    const target = spec.agent === 'codex'
      ? importCodex(codex!, spec.resumeId || '', req.cwd)
      : (() => { const rows = rowsOf(file); return rows && hasCompleteReply('claude', rows) ? { file, path: join(deps.claudeProjectDir(req.cwd), payload.transcript!.name) } : null })()
    if (!target) return { ok: false, error: 'Conversation transcript is malformed, incomplete, or does not match its resume ID', notes }
    const conflict = writeConversation(target.path, target.file)
    if (conflict) return { ok: false, error: conflict, notes }
    req.resume = true
    req.resumeId = spec.resumeId
  } else if (spec.resumeId) {
    notes.push('Conversation did not travel - the agent starts fresh in the right folder')
  }

  if (payload.tail) {
    const sid = `handoff-${randomBytes(5).toString('hex')}`
    const dir = deps.historyDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sid}.log`), payload.tail)
    // Before the pane starts, or `restoredTail` asks `colsOf` about an id nothing has
    // ever said a width for and replays the far desk's frame raw into this one.
    if (payload.tailCols && payload.tailCols > 0) deps.noteTailCols?.(sid, payload.tailCols)
    req.scrollbackId = sid
  }

  const session = await deps.start(req)

  // After the agent's pane, and only after: a dev server is what the pane was working ON,
  // and a failure to start one may not cost the handoff the pane it just completed.
  for (const d of payload.dev ?? []) {
    if (!SCRIPT.test(d.script)) {
      notes.push(`Refused a dev server name from the wire: ${JSON.stringify(d.script).slice(0, 40)}`)
      continue
    }
    try {
      const note = deps.startDev?.(req.cwd, d.script)
      notes.push(note ?? `Restarted the dev server here: run ${d.script}`)
    } catch (err) {
      notes.push(`Could not restart ${d.script}: ${(err as Error).message}`)
    }
  }
  return { ok: true, session, notes }
}

/**
 * Make this machine's checkout hold the pushed branch, touching nothing that
 * is not already on the remote. Returns an error string, or '' when the repo
 * is in place.
 */
async function ensureRepo(repo: HandoffRepo, senderRoot: string, root: string): Promise<string> {
  const target = mapCwd(slash(senderRoot).replace(/\/+$/, '') + (repo.dirRel ? '/' + repo.dirRel : ''), senderRoot, root)
  if (!target) return 'Could not place the repo under the projects root here'
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true })
    try {
      await git(dirname(target), ['clone', '--branch', repo.branch, repo.url, target], 300_000)
      return ''
    } catch (err) {
      return `Clone failed: ${(err as Error).message}`
    }
  }
  try {
    if (await git(target, ['status', '--porcelain'])) {
      return `${target} has uncommitted work on this machine - not touching it`
    }
    // Already standing on the commit being handed over, on the branch it was handed over
    // on: there is nothing to fetch and nothing to check out. Asked before the network
    // because the answer is 33 ms of local git against a 1042 ms fetch, and on two desks
    // that autosync it is the ordinary answer. The refusals above and below are untouched -
    // this only skips work that would end where the checkout already is.
    if (repo.sha) {
      const [head, branch] = await Promise.all([
        git(target, ['rev-parse', 'HEAD']),
        git(target, ['rev-parse', '--abbrev-ref', 'HEAD'])
      ])
      if (head === repo.sha && branch === repo.branch) return ''
    }
    await git(target, ['fetch', 'origin', repo.branch], 120_000)
    let has = true
    try {
      await git(target, ['rev-parse', '--verify', repo.branch])
    } catch {
      has = false
    }
    if (!has) {
      await git(target, ['checkout', '-b', repo.branch, `origin/${repo.branch}`])
      return ''
    }
    const ahead = await git(target, ['rev-list', '--count', `origin/${repo.branch}..${repo.branch}`])
    if (ahead !== '0') {
      return `${target} has ${ahead} unpushed commit(s) on ${repo.branch} here - not touching it`
    }
    await git(target, ['checkout', repo.branch])
    await git(target, ['merge', '--ff-only', `origin/${repo.branch}`])
    return ''
  } catch (err) {
    return `Could not update ${target}: ${(err as Error).message}`
  }
}
