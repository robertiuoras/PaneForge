// Owns every agent process. One pseudo-terminal per session so `claude` behaves
// exactly as it does in Windows Terminal: colours, the input box, Ctrl-C, resize.
//
// Everything here runs in the Electron MAIN process. The renderer never touches a
// pty directly - it sends keystrokes over IPC and receives output events back.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import * as pty from '@lydell/node-pty'
import { audit, plainTail } from './audit'
import { which } from './which'
import { specFor } from './agents'
import { memoryPrelude } from './board'
import { endAll, recordData, recordEnd, recordStart } from './history'
import { buildArgs } from '../shared/agents'
import type {
  Agent,
  Session,
  SessionStatus,
  StartSessionRequest,
  SwarmRequest
} from '../shared/types'

/** How long output must stay quiet before the pane's dot stops saying "working". */
const IDLE_AFTER_MS = 4000
/**
 * How long it must stay quiet before the pane is treated as *waiting for you*.
 * A single turn goes quiet many times - the model thinking, a long tool call, a
 * slow API round trip - and every one of those gaps used to raise attention and
 * chime, so one prompt could ring a dozen times. End of turn is a much longer
 * silence than the idle dot needs.
 *
 * This is the backstop, used when nothing on screen ever told us the turn ended.
 */
const ATTENTION_AFTER_MS = 25_000
/**
 * The same wait, for a pane whose own footer told us the turn is over ("esc to
 * interrupt" disappeared). That is the honest end-of-turn signal, so waiting the
 * full backstop after it just makes the nudge feel late. It is still a wait and
 * not instant because the footer can blink off for a frame between two tool calls;
 * any blink back on re-arms the busy deadline and blocks the raise entirely.
 */
const ATTENTION_AFTER_FOOTER_MS = 12_000
/**
 * Output we caused ourselves, not work the agent is doing. Opening a pane refits
 * the terminal, resizes the pty and focuses it, and a full-screen CLI answers all
 * three with a complete repaint. That repaint used to flip a pane from "waiting
 * for you" to "working" every time you clicked it - green dot, ticking clock, on a
 * session sitting at an empty prompt. Output that lands this soon after something
 * *we* sent leaves the status and the quiet clock untouched. Typing clears the
 * window immediately, so a real turn still lights up at once.
 */
const REPAINT_GRACE_MS = 1200
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
  /**
   * What the pane can see and this process cannot: the agent's own footer still
   * says it is running ("esc to interrupt"). A long tool call is silent for
   * minutes, which used to look exactly like a finished turn and chimed for it.
   *
   * Kept as a deadline rather than a flag: the pane re-states it while the agent is
   * busy, so a pane that is torn down mid-turn cannot leave a session muted forever.
   */
  busyUntil: number
  /**
   * When the user last acknowledged this pane. Attention is only raised for output
   * newer than that, which is what makes it once per quiet stretch: the focused pane
   * acknowledges itself on every session update, and without this the sweep re-raised
   * it a second later, forever - one system notification per second while the window
   * sat in the background.
   */
  ackedAt: number
  /** epoch ms until which incoming output is treated as a repaint we triggered */
  repaintUntil: number
  /**
   * Has a real turn happened since the user last looked at this pane?
   *
   * This is what stops the chime firing at random. Attention used to hang off
   * "engaged plus 25 seconds of quiet", and `engaged` is sticky for the life of the
   * session, so ANY stray byte a CLI printed on its own - a rotating tip, a context
   * meter, a redraw after a window event - restarted the cycle and rang the bell
   * about a pane that had been sitting at an empty prompt for an hour. A turn is
   * something that was actually started: a submitted prompt, or the agent's own
   * footer saying it is running. Nothing else can raise your hand.
   */
  turnPending: boolean
  /**
   * When the pane's footer last stopped saying "running". Zero when the footer has
   * never been readable for this session (an agent whose UI we cannot parse), which
   * is what selects the slower backstop wait instead.
   */
  footerEndedAt: number
  /**
   * Has this pane's footer EVER been readable for this session? Once it has, silence
   * from the pane means the pane stopped talking - not that the turn ended - so the
   * bell must wait for the pane to actually say "the footer is gone". Without this the
   * busy deadline expiring by itself was enough to announce a session as waiting for
   * you while the agent was still running, which is the random chime.
   */
  sawFooter: boolean
  /** The frame the pane was looking at when it last said the turn was over. Diagnostics. */
  lastTail: string
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Live>()
  private seq = 0
  /** The app is quitting: no more IPC, no more idle sweeps, teardown runs once. */
  private down = false

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

  /**
   * What it would take to open these panes again - used to carry the workspace
   * across an update restart. The original launch prompt is dropped on purpose:
   * replaying it would re-run work the agent already did before the restart.
   *
   * Exited panes are left out. They stay in the list so an ended run can be revived
   * in place, but restoring one would silently start a fresh agent in a pane the
   * user had already finished with - which is how a workspace grows a tab per
   * update until the window is full of CLIs nobody asked for.
   */
  snapshot(): StartSessionRequest[] {
    return [...this.sessions.values()]
      .filter((s) => s.meta.status !== 'exited')
      .map((s) => ({
        cwd: s.meta.cwd,
        title: s.meta.title,
        agent: s.meta.agent,
        model: s.meta.model,
        role: s.meta.role,
        // Already the lane's own folder: reopening must land back in it, not be
        // treated as a fresh clash and pushed one lane further along.
        lane: s.meta.lane
      }))
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
      // A launch with a prompt is engaged from the start; a bare CLI is not doing
      // anything for you yet, so its first quiet moment is not "finished".
      engaged: Boolean(req.prompt),
      role: req.role,
      lane: req.lane,
      laneNote: req.laneNote
    }
    const live: Live = {
      meta,
      proc: this.spawn(req, agent, 120, 30),
      buffer: '',
      req,
      cols: 120,
      rows: 30,
      busyUntil: 0,
      ackedAt: 0,
      repaintUntil: 0,
      turnPending: false,
      footerEndedAt: 0,
      sawFooter: false,
      lastTail: ''
    }
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
    live.meta.engaged = Boolean(live.req.prompt)
    live.busyUntil = 0
    live.ackedAt = 0
    live.turnPending = false
    live.footerEndedAt = 0
    live.sawFooter = false
    live.meta.runSince = undefined
    live.meta.lastRunMs = undefined
    live.meta.createdAt = Date.now()
    live.meta.lastOutput = Date.now()
    live.repaintUntil = 0
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
    const live = this.sessions.get(id)
    if (!live) return
    live.proc.write(data)
    if (!isTyping(data)) {
      // Terminal chatter - focus reports, cursor/device replies sent when a pane
      // is shown or hidden. The CLI answers them with a redraw; that redraw is
      // not the agent starting work.
      live.repaintUntil = Date.now() + REPAINT_GRACE_MS
      return
    }
    // A real keystroke: whatever comes back next IS work.
    live.repaintUntil = 0
    // Submitting is what starts the clock. The pane's busy footer confirms it a
    // moment later, but a turn that is still drawing its first frame is already
    // running, and starting here is what makes the readout mean "since I asked".
    const submitted = data.includes('\r') || data.includes('\n')
    if (submitted) this.beginRun(live)
    // Typing into a pane is both "I have asked it something" (so its next quiet
    // moment is a real end-of-turn) and "I have seen it" (so drop any nag).
    if (!live.meta.engaged || live.meta.attention) {
      live.meta.engaged = true
      live.meta.attention = false
      this.emitSessions()
    } else if (submitted) {
      this.emitSessions()
    }
  }

  /**
   * Start of a turn. Idempotent: the submit keystroke and the pane's busy footer
   * both report the same turn, and whichever lands first owns the start time.
   */
  private beginRun(live: Live): void {
    // Set even when a turn is already counting: this is the flag that says "there is
    // something here worth telling you about when it goes quiet", and a second prompt
    // sent into a running turn is still work you are waiting on.
    live.turnPending = true
    live.footerEndedAt = 0
    if (live.meta.runSince) return
    live.meta.runSince = Date.now()
    live.meta.lastRunMs = undefined
  }

  /** End of a turn: freeze what it took and stop counting. */
  private endRun(live: Live): boolean {
    if (!live.meta.runSince) return false
    live.meta.lastRunMs = Date.now() - live.meta.runSince
    live.meta.runSince = undefined
    return true
  }

  /** Same line to every live session - "/clear" or a shared instruction in one go. */
  broadcast(text: string): void {
    for (const s of this.sessions.values()) {
      if (s.meta.status === 'exited') continue
      try {
        s.proc.write(text + '\r')
        s.meta.engaged = true
        s.meta.attention = false
        this.beginRun(s)
      } catch {
        /* dying pty */
      }
    }
    this.emitSessions()
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s || s.meta.status === 'exited') return
    s.cols = Math.max(cols, 20)
    s.rows = Math.max(rows, 5)
    // Showing a pane refits it and lands here; the CLI repaints in response.
    s.repaintUntil = Date.now() + REPAINT_GRACE_MS
    try {
      s.proc.resize(s.cols, s.rows)
    } catch {
      // pty already gone between the renderer's measure and this call - harmless.
    }
  }

  /**
   * Poke the size and put it straight back. A full-screen CLI redraws its whole
   * frame on SIGWINCH, which is the only reliable way to fix a pane that got
   * garbled - torn box drawing, doubled lines - by a resize the app half-missed.
   */
  redraw(id: string): void {
    const s = this.sessions.get(id)
    if (!s || s.meta.status === 'exited') return
    try {
      s.proc.resize(Math.max(20, s.cols - 1), s.rows)
      setTimeout(() => {
        try {
          if (this.sessions.get(id) === s) s.proc.resize(s.cols, s.rows)
        } catch {
          /* pty died between the two halves of the nudge */
        }
      }, 90)
    } catch {
      /* already gone */
    }
  }

  /**
   * The renderer's read of whether the agent's own UI still says it is running. Panes
   * repeat it every second or so, so the deadline it sets expires by itself if the pane
   * goes away.
   */
  setBusyOnScreen(id: string, busy: boolean, tail = ''): void {
    const s = this.sessions.get(id)
    if (!s) return
    const now = Date.now()
    // Once a pane has read this agent's "running" footer even once, this session's
    // turn boundaries are knowable, and the bell stops trusting the quiet clock alone.
    if (busy) s.sawFooter = true
    else if (tail) s.lastTail = tail
    // Deadline rather than a flag, and a short one: the pane re-states a true reading
    // every two minutes while the agent is running, so three minutes of silence from
    // the pane means the pane is gone, not that the turn is still going. The old ten
    // minute deadline was longer than the heartbeat by so much that a pane torn down
    // mid-turn left its session frozen as "working" for the rest of the ten minutes.
    s.busyUntil = busy ? now + 180_000 : 0
    // The footer is the honest turn boundary, so it drives the run clock too: it
    // starts a turn the app never saw typed (a queued prompt, /clear, a resumed
    // session) and ends one the instant the agent stops saying it is running.
    if (busy) {
      const wasRunning = Boolean(s.meta.runSince)
      this.beginRun(s)
      // A silent tool call produces no output for minutes, and the idle sweep used to
      // grey the dot out in the middle of it - the pane read as finished while the
      // agent was demonstrably still working. On-screen busy outranks the quiet clock.
      const wasWorking = s.meta.status === 'working'
      if (s.meta.status !== 'exited') s.meta.status = 'working'
      if (!wasRunning || !wasWorking) this.emitSessions()
      return
    }
    // Remember when the footer went quiet, so the nudge can come sooner than the
    // blind backstop for the agents whose UI we can actually read.
    if (!s.footerEndedAt) s.footerEndedAt = now
    let changed = this.endRun(s)
    // The footer going away is the turn ending, so the dot says so now instead of a
    // minute later. The quiet clock used to own this transition, which left a pane that
    // was plainly waiting for a reply showing green "working" for the whole IDLE_AFTER_MS
    // - and a pane sitting on a permission prompt shows no footer at all, so it read as
    // working for as long as it sat there. Only ever downgrades a *working* pane:
    // 'starting' has its own timer and 'exited' is final.
    if (s.meta.status === 'working') {
      s.meta.status = 'idle'
      changed = true
    }
    if (changed) this.emitSessions()
  }

  clearAttention(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    // Recorded even when nothing was raised: the pane you are looking at acknowledges
    // itself continuously, and this is what stops the sweep raising it again a second
    // later off the same silence.
    const now = Date.now()
    s.ackedAt = now
    // Watching a pane that has already finished spends the turn: you have seen what it
    // did, so the next quiet stretch is not a fresh reason to ring. Deliberately NOT
    // done while the turn is still running - looking at a pane for a second on the way
    // past must not cancel the nudge for work that has not finished yet, which is the
    // whole point of the feature ("ask it, go and do something else").
    if (!s.meta.runSince && s.busyUntil < now) s.turnPending = false
    if (!s.meta.attention) return
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

  /**
   * Teardown for quitting, as opposed to killAll() which is the interactive one.
   *
   * Closing a pane by hand is one pty, so the per-session work in kill() is invisible.
   * Quitting with several panes open did all of it serially: a full history flush, a
   * metadata read-modify-write and a complete session list pushed to a renderer nobody
   * is looking at any more, per pane, before the first agent had been asked to die.
   *
   * So: no IPC, one history pass, and on Windows one taskkill for every process tree at
   * once. That taskkill is the part that matters for correctness rather than speed -
   * ConPTY's own kill returns before anything has actually died, and hardExit() does not
   * wait around, so without it an update could come back to a machine with orphaned
   * `claude` processes holding locks on the files it had just replaced. /T takes the
   * grandchildren too: an agent CLI is node, which spawns ripgrep, git and its own
   * subagents.
   */
  shutdown(): void {
    if (this.down) return
    this.down = true
    const live = [...this.sessions.values()]
    const ids = [...this.sessions.keys()]
    this.sessions.clear()
    if (!live.length) return
    endAll(ids)

    if (process.platform === 'win32') {
      const args = live
        .map((s) => s.proc.pid)
        .filter((pid) => typeof pid === 'number' && pid > 0)
        .flatMap((pid) => ['/PID', String(pid)])
      if (args.length) {
        try {
          spawn('taskkill', ['/F', '/T', ...args], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          }).unref()
        } catch {
          /* no taskkill on PATH - the pty kill below is still the real one */
        }
      }
    }
    // Still ask node-pty: it is what releases the ConPTY handles, and it is the only
    // path that works off Windows.
    for (const s of live) {
      try {
        s.proc.kill()
      } catch {
        /* already dead */
      }
    }
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
      const now = Date.now()
      const wasIdle = meta.status !== 'working'
      // A repaint we asked for is not a turn: paint it, but do not touch the
      // status or the quiet clock the attention nudge runs on.
      if (wasIdle && now < live.repaintUntil) {
        this.emit('data', id, data)
        return
      }
      // Output alone deliberately does not start the run clock: a CLI painting its
      // own banner is not working for you. Submitting a prompt starts it, and the
      // agent's busy footer starts one this app never saw typed.
      meta.lastOutput = now
      meta.status = 'working'
      this.emit('data', id, data)
      if (wasIdle) this.emitSessions()
    })

    proc.onExit(({ exitCode }) => {
      if (live.proc !== proc) return
      meta.status = 'exited'
      meta.exitCode = exitCode
      this.endRun(live)
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
    const now = Date.now()
    for (const live of this.sessions.values()) {
      const { meta } = live
      const quiet = now - meta.lastOutput
      // Does the pane's own footer still say the agent is running? This outranks the
      // quiet clock everywhere below: silence during a five minute tool call is not
      // the same thing as silence at an empty prompt, and treating them alike is what
      // made the dot go grey mid-turn and the bell ring over a running agent.
      const busyOnScreen = live.busyUntil > now
      // Backstop for the run clock: an agent whose footer this app cannot read (or
      // a pane that was torn down mid-turn) would otherwise count forever. Quiet,
      // and nothing on screen claiming to be busy, is the end of the turn.
      if (meta.runSince && !busyOnScreen && quiet > IDLE_AFTER_MS) {
        if (this.endRun(live)) changed = true
      }
      if (busyOnScreen && meta.status !== 'working' && meta.status !== 'exited') {
        meta.status = 'working'
        changed = true
      } else if (meta.status === 'working' && !busyOnScreen && quiet > IDLE_AFTER_MS) {
        meta.status = 'idle'
        changed = true
      } else if (meta.status === 'starting' && now - meta.createdAt > IDLE_AFTER_MS * 3) {
        meta.status = 'idle'
        changed = true
      }
      // Raised once per quiet stretch, never re-raised until output resumes and
      // goes quiet again. A CLI that has only painted its own welcome screen is
      // quiet, not done: `engaged` keeps a fresh pane from claiming to be waiting
      // on you the moment it finishes drawing, and lastOutput moving past
      // createdAt keeps a pane that has printed nothing at all out of it.
      // busyOnScreen is the last gate and the strongest one: a pane whose footer
      // still reads "esc to interrupt" is mid-turn no matter how long it has been
      // silent, and that silence - a long tool call, a slow API - is exactly what
      // used to chime early.
      //
      // turnPending is the gate that stops the bell going off at random: without it
      // any byte a CLI printed to itself was enough to restart the quiet clock on a
      // session that had been idle for hours, and the app would announce it as
      // "waiting for you". Nothing raises a hand now unless a turn was really run.
      // The run clock must also have stopped, so "waiting" can never contradict the
      // ticking timer next to it in the same row.
      const needQuiet = live.footerEndedAt ? ATTENTION_AFTER_FOOTER_MS : ATTENTION_AFTER_MS
      // The pane has to SAY the turn ended - a busy deadline that simply ran out is not
      // an ending. This is the random chime: a pane whose agent went quiet for three
      // minutes mid-turn (a long tool call, a stalled API round trip, a renderer whose
      // timers Windows throttled while minimised) stopped restating "busy", the deadline
      // lapsed, and the sweep read the resulting silence as a finished turn. Every one of
      // those cases is "no news from the pane", never "the footer is gone", so the two
      // are told apart explicitly now. The blind backstop still exists, but only for a
      // session whose footer has never been readable at all - there, quiet is all we have.
      const endedOnScreen = !live.sawFooter || live.footerEndedAt > 0
      if (
        endedOnScreen &&
        meta.status === 'idle' &&
        live.turnPending &&
        !meta.runSince &&
        meta.engaged &&
        !meta.attention &&
        !busyOnScreen &&
        meta.lastOutput > meta.createdAt &&
        meta.lastOutput > live.ackedAt &&
        quiet > needQuiet
      ) {
        // One raise per turn. Anything the agent prints afterwards is the same
        // finished turn, not a new one, so it cannot ring twice.
        live.turnPending = false
        // Written every time, not only when it goes wrong: "was that chime honest"
        // is unanswerable after the fact otherwise, and it has cost three rounds of
        // guessing already. `tail` is the frame the pane judged - if the agent's
        // "esc to interrupt" footer is sitting in it, the raise was wrong and the
        // reason is right there on the line.
        audit('attention', {
          title: meta.title,
          agent: meta.agent,
          quietMs: quiet,
          needQuiet,
          sawFooter: live.sawFooter,
          footerEndedMsAgo: live.footerEndedAt ? now - live.footerEndedAt : null,
          tail: plainTail(live.lastTail)
        })
        meta.attention = true
        this.emit('attention', meta)
        changed = true
      }
    }
    if (changed) this.emitSessions()
  }

  private emitSessions(): void {
    if (this.down) return
    this.emit('sessions', this.list())
  }
}

/**
 * Did a human put this in the pane, or is it the terminal talking to the agent?
 *
 * xterm answers the CLI's own startup queries - device attributes, cursor
 * position, colour support - through the very same write path as a keystroke.
 * Counting those as "you asked it something" made every pane engaged within a
 * second of launching, which is exactly the false "waiting for you" this is
 * meant to prevent. Escape-prefixed replies and lone control bytes do not count;
 * printable text and a bare Enter do.
 */
function isTyping(data: string): boolean {
  if (!data || data.startsWith('\x1b')) return false
  // Anything that is not a control byte counts, so accented and CJK input works.
  return data === '\r' || data === '\n' || /[^\x00-\x1f\x7f]/.test(data)
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
