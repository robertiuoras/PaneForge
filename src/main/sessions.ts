// Owns every agent process. One pseudo-terminal per session so `claude` behaves
// exactly as it does in Windows Terminal: colours, the input box, Ctrl-C, resize.
//
// Everything here runs in the Electron MAIN process. The renderer never touches a
// pty directly - it sends keystrokes over IPC and receives output events back.

import { EventEmitter } from 'node:events'
import * as pty from '@lydell/node-pty'
import { which } from './which'
import type { Agent, Session, SessionStatus, StartSessionRequest } from '../shared/types'

/** How long output must stay quiet before a session counts as waiting for you. */
const IDLE_AFTER_MS = 4000
/** Cap on retained scrollback per session (chars). Enough to redraw a pane. */
const BUFFER_LIMIT = 400_000

interface Live {
  meta: Session
  proc: pty.IPty
  buffer: string
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
    const agent: Agent = req.agent ?? 'claude'
    const id = `s${++this.seq}-${Date.now().toString(36)}`
    const args = req.resume ? ['--continue'] : []

    // Spawn the agent binary directly (not through cmd.exe): one less process in the
    // tree, so killing the session actually kills the agent instead of orphaning it.
    // shell:true equivalents on Windows also swallow Ctrl-C.
    const proc = pty.spawn(agentCommand(agent), args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: req.cwd,
      env: agentEnv()
    })

    const meta: Session = {
      id,
      title: req.title ?? basename(req.cwd),
      cwd: req.cwd,
      agent,
      status: 'starting',
      lastOutput: Date.now(),
      createdAt: Date.now()
    }
    const live: Live = { meta, proc, buffer: '' }
    this.sessions.set(id, live)

    proc.onData((data) => {
      live.buffer = (live.buffer + data).slice(-BUFFER_LIMIT)
      const wasIdle = meta.status !== 'working'
      meta.lastOutput = Date.now()
      meta.status = 'working'
      this.emit('data', id, data)
      if (wasIdle) this.emitSessions()
    })

    proc.onExit(({ exitCode }) => {
      meta.status = 'exited'
      meta.exitCode = exitCode
      this.emitSessions()
    })

    if (req.prompt) {
      // The agent needs a moment to draw its input box before it accepts keys.
      setTimeout(() => this.write(id, req.prompt + '\r'), 2500)
    }

    this.emitSessions()
    return meta
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || s.meta.status === 'exited') return
    try {
      s.proc.resize(Math.max(cols, 20), Math.max(rows, 5))
    } catch {
      // pty already gone between the renderer's measure and this call - harmless.
    }
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    try {
      s.proc.kill()
    } catch {
      /* already dead */
    }
    this.sessions.delete(id)
    this.emitSessions()
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  private sweepIdle(): void {
    let changed = false
    for (const { meta } of this.sessions.values()) {
      if (meta.status === 'working' && Date.now() - meta.lastOutput > IDLE_AFTER_MS) {
        meta.status = 'idle'
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
    // Electron injects its own runtime hints that confuse Node-based CLIs.
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}

function agentCommand(agent: Agent): string {
  return which(agent === 'codex' ? 'codex' : 'claude')
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export type SessionStatusType = SessionStatus
