// Owns every agent process. One pseudo-terminal per session so `claude` behaves
// exactly as it does in Windows Terminal: colours, the input box, Ctrl-C, resize.
//
// Everything here runs in the Electron MAIN process. The renderer never touches a
// pty directly - it sends keystrokes over IPC and receives output events back.

import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import * as pty from '@lydell/node-pty'
import { which } from './which'
import { specFor } from './agents'
import { memoryPrelude } from './board'
import { recordData, recordEnd, recordStart } from './history'
import { buildArgs } from '../shared/agents'
import type {
  Agent,
  Session,
  SessionStatus,
  StartSessionRequest,
  SwarmRequest
} from '../shared/types'

/** How long output must stay quiet before a session counts as waiting for you. */
const IDLE_AFTER_MS = 4000
/** Cap on retained scrollback per session (chars). Enough to redraw a pane. */
const BUFFER_LIMIT = 400_000
/** Full terminal reset - written on restart so the pane does not stack two runs. */
const RESET = '\x1bc'

interface Live {
  meta: Session
  proc: pty.IPty
  buffer: string
  req: StartSessionRequest
  cols: number
  rows: number
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Live>()
  private seq = 0

  constructor() {
    super()
    // Single timer for all sessions: flipping working -> idle per session with its
    // own timer would mean N timers doing the same 1s tick.
    setInterval(() => this.sweepIdle(), 1000).unref()
  }

  list(): Session[] {
    return [...this.sessions.values()].map((s) => s.meta)
  }

  buffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? ''
  }

  start(req: StartSessionRequest): Session {
    if (!req.cwd || !existsSync(req.cwd)) throw new Error(`Folder not found: ${req.cwd}`)
    const agent: Agent = req.agent ?? 'claude'
    const id = `s${++this.seq}-${Date.now().toString(36)}`

    const meta: Session = {
      id,
      title: req.title ?? basename(req.cwd),
      cwd: req.cwd,
      agent,
      model: req.model || undefined,
      status: 'starting',
      lastOutput: Date.now(),
      createdAt: Date.now(),
      role: req.role
    }
    const live: Live = { meta, proc: this.spawn(req, agent, 120, 30), buffer: '', req, cols: 120, rows: 30 }
    this.sessions.set(id, live)
    this.attach(live)
    recordStart(meta)
    this.queuePrompt(id, req.prompt, req.promptDelay)

    this.emitSessions()
    return meta
  }

  /**
   * Launch one pane per role in the same folder, each told what it owns. The
   * mission text is shared; the role brief is what stops three agents editing the
   * same file at once. Panes are staggered because N agents hitting one repo in
   * the same millisecond makes for a confusing first 10 seconds.
   */
  startSwarm(req: SwarmRequest): Session[] {
    const roles = req.roles.filter((r) => r.enabled && r.name.trim())
    if (!roles.length) throw new Error('No roles enabled.')
    const prelude = memoryPrelude(req.cwd)
    const others = roles.map((r) => r.name).join(', ')

    return roles.map((role, i) => {
      const prompt = [
        `You are the ${role.name} in a team of ${roles.length} agents working in this repo (${others}).`,
        role.brief.trim(),
        prelude,
        `Mission: ${req.mission.trim()}`,
        'Stay inside your role. Do not edit files another role owns; leave a note instead.'
      ]
        .filter(Boolean)
        .join(' ')

      return this.start({
        cwd: req.cwd,
        title: role.name,
        agent: role.agent,
        model: role.model,
        role: role.name,
        prompt,
        // Stagger: N agents typing into N CLIs in the same millisecond makes for a
        // confusing first few seconds, and some CLIs drop input while still drawing.
        promptDelay: i * 900
      })
    })
  }

  /**
   * Kill and respawn the agent under the same id, so the pane, its position and the
   * user's selection all survive. Used for "restart" and for reviving an exited run.
   */
  restart(id: string): Session | null {
    const live = this.sessions.get(id)
    if (!live) return null
    try {
      live.proc.kill()
    } catch {
      /* already dead */
    }
    recordEnd(id)
    live.proc = this.spawn(live.req, live.meta.agent, live.cols, live.rows)
    live.buffer = RESET
    live.meta.status = 'starting'
    live.meta.exitCode = undefined
    live.meta.attention = false
    live.meta.createdAt = Date.now()
    live.meta.lastOutput = Date.now()
    this.emit('data', id, RESET)
    this.attach(live)
    recordStart(live.meta)
    this.queuePrompt(id, live.req.prompt, live.req.promptDelay)
    this.emitSessions()
    return live.meta
  }

  /**
   * Point an existing pane at a different CLI (or a different model of the same
   * CLI) and respawn it. The folder, title, position and id all survive, so
   * "try this in Codex instead" is one click rather than a new session.
   */
  switchAgent(id: string, agent: Agent, model?: string): Session | null {
    const live = this.sessions.get(id)
    if (!live) return null
    live.req = { ...live.req, agent, model, prompt: undefined }
    live.meta.agent = agent
    live.meta.model = model || undefined
    return this.restart(id)
  }

  rename(id: string, title: string): void {
    const s = this.sessions.get(id)
    if (!s || !title.trim()) return
    s.meta.title = title.trim().slice(0, 60)
    this.emitSessions()
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  /** Same line to every live session - "/clear" or a shared instruction in one go. */
  broadcast(text: string): void {
    for (const s of this.sessions.values()) {
      if (s.meta.status === 'exited') continue
      try {
        s.proc.write(text + '\r')
      } catch {
        /* dying pty */
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || s.meta.status === 'exited') return
    s.cols = Math.max(cols, 20)
    s.rows = Math.max(rows, 5)
    try {
      s.proc.resize(s.cols, s.rows)
    } catch {
      // pty already gone between the renderer's measure and this call - harmless.
    }
  }

  clearAttention(id: string): void {
    const s = this.sessions.get(id)
    if (!s?.meta.attention) return
    s.meta.attention = false
    this.emitSessions()
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      /* already dead */
    }
    recordEnd(id)
    this.sessions.delete(id)
    this.emitSessions()
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  private spawn(req: StartSessionRequest, agent: Agent, cols: number, rows: number): pty.IPty {
    // Spawn the agent binary directly (not through cmd.exe): one less process in the
    // tree, so killing the session actually kills the agent instead of orphaning it.
    // shell:true equivalents on Windows also swallow Ctrl-C.
    const spec = specFor(agent)
    // resume is per-CLI: `claude --continue` but `codex resume --last`, and some
    // agents have nothing at all - buildArgs drops the flag rather than guessing.
    const args = buildArgs(spec, { resume: req.resume, model: req.model })
    return pty.spawn(which(spec.bin), args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: req.cwd,
      env: agentEnv()
    })
  }

  private attach(live: Live): void {
    const { meta } = live
    const id = meta.id
    const proc = live.proc

    proc.onData((data) => {
      // A late event from the previous process of a restarted session would append
      // dead output into the fresh buffer.
      if (live.proc !== proc) return
      live.buffer = (live.buffer + data).slice(-BUFFER_LIMIT)
      recordData(id, data)
      const wasIdle = meta.status !== 'working'
      meta.lastOutput = Date.now()
      meta.status = 'working'
      this.emit('data', id, data)
      if (wasIdle) this.emitSessions()
    })

    proc.onExit(({ exitCode }) => {
      if (live.proc !== proc) return
      meta.status = 'exited'
      meta.exitCode = exitCode
      recordEnd(id)
      this.emitSessions()
    })
  }

  private queuePrompt(id: string, prompt?: string, extraDelay = 0): void {
    if (!prompt) return
    // The agent needs a moment to draw its input box before it accepts keys.
    setTimeout(() => this.write(id, prompt + '\r'), 2500 + Math.max(0, extraDelay))
  }

  private sweepIdle(): void {
    let changed = false
    for (const { meta } of this.sessions.values()) {
      if (meta.status === 'working' && Date.now() - meta.lastOutput > IDLE_AFTER_MS) {
        meta.status = 'idle'
        meta.attention = true
        this.emit('attention', meta)
        changed = true
      } else if (meta.status === 'starting' && Date.now() - meta.createdAt > IDLE_AFTER_MS * 3) {
        meta.status = 'idle'
        changed = true
      }
    }
    if (changed) this.emitSessions()
  }

  private emitSessions(): void {
    this.emit('sessions', this.list())
  }
}

function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    // Claude Code marks its own child processes; inheriting those markers makes the
    // spawned agent run as a "child session" with transcript saving disabled, so the
    // session never shows up in history or /resume.
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue
    // Same idea for Codex: these mark a process as running inside Codex's own
    // sandbox and make a nested run refuse to touch the filesystem.
    if (k.startsWith('CODEX_SANDBOX')) continue
    // Electron injects its own runtime hints that confuse Node-based CLIs.
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export type SessionStatusType = SessionStatus
