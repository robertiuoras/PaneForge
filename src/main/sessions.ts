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
import { ensureTrusted } from './claudeTrust'
import { ensureLaneFolder } from './lanes'
import { which } from './which'
import { specFor } from './agents'
import { memoryPrelude } from './board'
import { colsOf, endAll, gistFor, noteCols, recordData, recordEnd, recordStart, tail } from './history'
import { RESTORE_MARK_TEXT } from '../shared/replayWidth'
import { feedPipe, startPipe, stopAllPipes, stopPipe, type PipeOptions } from './pipe'
import { forgetSession, noteSession, resumeIdFor } from './transcripts'
import { continueAfterRestore, restoredClock } from '../shared/restoreTurn'

/**
 * Extra patience for the "continue" a restore sends. `queuePrompt` waits for an idle
 * composer either way; this only widens its deadline, because a CLI replaying a long
 * transcript can be quiet-then-busy several times before it really settles.
 */
const RESTORE_CONTINUE_MS = Number(process.env.PF_RESTORE_CONTINUE_MS ?? 8000)
import { killPaneStrays, trackStrays } from './strays'
import { isQuietSlash, isSlashCommand, typeLine } from '../shared/slashTurn'
import { OutBuffer } from './outBuffer'
import { buildArgs, resolveEnv } from '../shared/agents'
import { anchoredStart, readsBusy } from '../shared/busy'
import { askKeyOf, autoAnswerAt, DEFAULT_AUTO_ANSWER, dueForAuto, pickAnswer } from '../shared/autoAnswer'
import { askSignature, CHOOSE_GAP_MS, keysForChoice, readAsk, sameAsk } from '../shared/choices'
import { stripAnsi as strip } from '../shared/ansi'
import { silenceMs, stalledNow } from '../shared/alerts'
import { DEFAULT_RECOVER, recover, TAIL_CHARS } from '../shared/recover'
import { getConfig } from './config'
import type {
  Agent,
  PipeInfo,
  Session,
  SessionStatus,
  StartSessionRequest,
  SwarmRequest,
  TurnClock
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
/**
 * How long a launching CLI must stop painting before its prompt is typed in, how
 * long to keep waiting for that, and the beat between the prompt and its return.
 * See `queuePrompt`: the quiet is the readiness signal, the separate return is what
 * stops the CLI reading it as part of a paste.
 */
const ms = (name: string, fallback: number): number => Number(process.env[name]) || fallback
const PROMPT_START_MS = ms('PF_PROMPT_START_MS', 2500)
const PROMPT_QUIET_MS = ms('PF_PROMPT_QUIET_MS', 900)
const PROMPT_WAIT_MAX_MS = ms('PF_PROMPT_WAIT_MAX_MS', 45_000)
const PROMPT_POLL_MS = ms('PF_PROMPT_POLL_MS', 300)
const PROMPT_ENTER_MS = ms('PF_PROMPT_ENTER_MS', 350)
/** How much of the pane's tail the busy read looks at, and the confirm-and-retry. */
const PROMPT_TAIL_CHARS = 2000
const PROMPT_CONFIRM_MS = ms('PF_PROMPT_CONFIRM_MS', 4000)
const PROMPT_ENTER_TRIES = 3
/** Full terminal reset - written on restart so the pane does not stack two runs. */
const RESET = '\x1bc'
/**
 * Where the old pane's output ends and this one's begins. Dim, one line, no colour of its
 * own: it is a caption on somebody else's output, not an event.
 *
 * `\x1b[0m` first because the tail is cut mid-run: whatever attribute was in force at the
 * cut would otherwise bleed into the caption and into everything the new process writes.
 */
const RESTORE_MARK = `\x1b[0m\r\n\x1b[2m${RESTORE_MARK_TEXT}\x1b[0m\r\n`

/**
 * What a restored pane replays, or '' when there is nothing honest to put back.
 *
 * The bytes are already on disk - `history.ts` has appended every pane's raw output to
 * `userData/history/<id>.log` since long before this - so restoring what was on screen is
 * a read, not a new store, and it inherits that file's cap and its pruning. What was
 * missing was only the id: a restored pane is a NEW session, so without `scrollbackId`
 * written into the desk there is nothing joining it to the log it used to write.
 *
 * Two things this deliberately does not do. It does not replay into a pane that is not
 * coming back from a desk (a fresh pane in the same folder is a fresh pane). And it does
 * not try to be the live terminal's own scrollback: the cap is the buffer's, so what
 * comes back is the same amount a pane already keeps in memory, not the whole day.
 */
function restoredTail(scrollbackId: string | undefined): { text: string; cols: number } {
  if (!scrollbackId) return { text: '', cols: 0 }
  const back = tail(scrollbackId, BUFFER_LIMIT)
  if (!back) return { text: '', cols: 0 }
  // The width those bytes were PAINTED at, carried out to the pane with them. A CLI draws
  // in absolute column moves, and a terminal clamps one it cannot reach - so replayed into
  // a narrower pane the old screen collapses onto its right-hand edge and the reopened
  // pane's history is unreadable. See `shared/replayWidth.ts`.
  return { text: back + RESTORE_MARK, cols: colsOf(scrollbackId) }
}
/**
 * A slash command that is still running after this long is real work, not
 * housekeeping - a user-invoked skill earns the bell, /clear's hook flash (a second or
 * two) and /help never get near it.
 */
const SLASH_TURN_MS = 30_000
/**
 * How long a pane stays un-bellable after a command that ends with nothing to read
 * (`isQuietSlash`: /clear, /compact, /resume).
 *
 * Longer than SLASH_TURN_MS on purpose - the whole point is that the 30-second
 * promotion must not reach these - and long enough to cover a slow SessionStart hook
 * run plus the busy/quiet flapping that follows it. It costs nothing to be generous:
 * the next real prompt typed into the pane clears it outright, so the only thing this
 * window can silence is the settling of the command itself.
 */
const QUIET_SLASH_MS = 90_000
/**
 * A gap between one turn ending and the next beginning that is too short to be two
 * questions. Anything under this is one turn that got cut, and is written to the audit
 * log so the next report of "the clock reset" comes with the frame that caused it.
 */
const TURN_SPLIT_MS = 60_000
/**
 * How long a turn may print nothing at all before the pane says it is stuck. Set from
 * the config (`silenceAlertMin`), because the right number is a matter of what the
 * user runs: a repo whose test suite is silent for four minutes wants a bigger one.
 * 0 turns it off.
 */
let stallAfterMs = silenceMs(5)

export function setSilenceAlert(minutes: number | undefined): void {
  stallAfterMs = silenceMs(minutes)
}

interface Live {
  meta: Session
  proc: pty.IPty
  buffer: OutBuffer
  req: StartSessionRequest
  cols: number
  rows: number
  /** the size the DESK window last fitted this pane to - see `resize` */
  deskCols: number
  deskRows: number
  /** a phone is holding the pty at its own shape, and owes the desk its size back */
  borrowed?: boolean
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
  /**
   * How much of this pane's output has already been read for a truncated turn.
   *
   * The error line stays in the buffer for ever, so "is it in the last 4000 characters"
   * would keep answering yes long after it was dealt with and would spend the whole retry
   * budget on one failure. Only output produced SINCE the last look is considered - the
   * same trick `queuePrompt` uses, and for the same reason.
   */
  recoverSeen: number
  /** Auto-continues sent in a row on this pane. Reset by any turn that ends whole. */
  recoverTries: number
  /**
   * When the question now on this pane's screen was first seen, and what it was.
   *
   * The signature carries where the arrow is (`askSignature`), so a person arrowing at
   * the desk restarts the clock rather than having the answer pressed out from under
   * them mid-move. Zero means there is no question.
   */
  askSince: number
  askSig: string
  /**
   * The same question WITHOUT the arrow (`askKeyOf`), which is what "have I already
   * pressed this one" has to be asked of: the arrow moves as our own keys land, so a
   * signature carrying it calls the question being answered a new question.
   */
  askKey: string
  /** Questions answered by `autoAnswer` in a row on this pane, the last one, and when. */
  autoRun: number
  autoKey: string
  autoAt: number
  /** The frame the pane was looking at when it last said the turn was over. Diagnostics. */
  lastTail: string
  /**
   * What the user has typed since they last submitted, rebuilt from the keystrokes
   * this process relays anyway. It exists to answer one question at Enter: does the
   * line start with "/"? A slash command is housekeeping typed AT the CLI, not a
   * question asked OF the agent - /clear redraws the screen, flashes a spinner while
   * its hooks run, and settles, which walked through every gate below and rang the
   * bell over a pane the user had cleared two seconds earlier and was still sitting at.
   */
  typed: string
  /** When a slash command was submitted; 0 outside one. See SLASH_TURN_MS. */
  slashAt: number
  /**
   * A slash command that finishes with nothing to read is still settling until this
   * moment; 0 outside one. `slashAt`'s 30-second window is a suspicion that a long run
   * became real work, and for `/clear`, `/compact` and `/resume` that suspicion is
   * simply wrong however long they take - see `isQuietSlash`. Kept as its own deadline
   * rather than folded into `slashAt` because it has to outlive the promotion, and
   * outlive the footer flapping busy/quiet several times while hooks run.
   */
  slashQuietUntil: number
  /**
   * The silence alert has already been raised for this quiet stretch. Cleared by the
   * next byte out of the pane, so a turn that stalls twice is told twice and a turn
   * that stalls once is told once - not once a second for as long as it lasts.
   */
  stallRaised: boolean
  /**
   * When the last turn's clock was stopped. Only ever read to notice a turn that was
   * stopped and restarted seconds later, which is a turn boundary this app invented -
   * see the `turn-split` audit in beginRun.
   */
  runEndedAt?: number
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
    // Write down what the panes have started, while their parent links still say so.
    // Asked for the pids each sample rather than handed them: see strays.ts.
    trackStrays(() => this.roots())
  }

  /**
   * Live pane ptys, as `id -> pid`.
   *
   * Two samplers want this and neither wants a Session: the stray ledger (which is
   * recording what to kill later) and the usage readout (which is adding up what each
   * pane costs). Both walk the same trees from the same roots, and both must ask per
   * sample rather than hold a list - see strays.ts.
   */
  roots(): { id: string; pid: number }[] {
    return [...this.sessions.entries()]
      .map(([id, s]) => ({ id, pid: s.proc.pid }))
      .filter((p) => typeof p.pid === 'number' && p.pid > 0)
  }

  list(): Session[] {
    return [...this.sessions.values()].map((s) => s.meta)
  }

  buffer(id: string): string {
    return this.sessions.get(id)?.buffer.read() ?? ''
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
        // Where it was handed here from, or the restart is what breaks the loop guard: the
        // pane comes back with no `arrivedFrom`, and this desk's budget is then free to
        // hand it straight back to the machine that sent it - which is the exact ping-pong
        // that field exists to stop, arriving one restart later.
        arrivedFrom: s.meta.arrivedFrom,
        // Already the lane's own folder: reopening must land back in it, not be
        // treated as a fresh clash and pushed one lane further along.
        lane: s.meta.lane,
        // The conversation this pane is actually in, so restoring reopens THAT one
        // rather than whatever happens to be newest in the folder by then.
        resumeId: resumeIdFor(s.meta.id),
        // ...and what was on screen in it. `resumeId` restores the AGENT's memory and
        // not one line of the terminal, which is why a pane comes back blank after an
        // update even though it picks the conversation up mid-sentence.
        scrollbackId: s.meta.id,
        // The port the pane's dev server was told to use, kept across the restart
        // so a server started before an update comes back on the same one.
        laneEnv: s.req.laneEnv,
        // ...and what the PERSON knows about this pane, which a new session cannot work
        // out for itself: how long it has been open, its last turn's length, whether it
        // has been asked anything, and whether it was mid-turn when we went down. Without
        // these a restored row draws no clock and a grey dot. See shared/restoreTurn.ts.
        openedAt: s.meta.openedAt ?? s.meta.createdAt,
        lastRunMs: s.meta.lastRunMs,
        engaged: s.meta.engaged,
        // `runSince` is the turn clock: it is set exactly while the agent is producing an
        // answer, so it is the one honest reading of "mid-turn" at the moment we die.
        wasWorking: Boolean(s.meta.runSince)
      }))
  }

  start(req: StartSessionRequest): Session {
    if (!req.cwd || !existsSync(req.cwd)) throw new Error(`Folder not found: ${req.cwd}`)
    const agent: Agent = req.agent ?? 'claude'
    // Before anything reads the folder: a lane the sweep reclaimed while this pane was
    // closed is still the pane's remembered cwd, and a CLI spawned into a folder that is
    // not there loses every hook to `posix_spawn '/bin/sh'` ENOENT. See ensureLaneFolder.
    ensureLaneFolder(req.cwd)
    // Before the CLI is spawned, not after: it reads .claude.json at startup and would
    // already be sitting on the trust prompt by the time anything here could help.
    if (agent === 'claude') ensureTrusted(req.cwd)
    const id = `s${++this.seq}-${Date.now().toString(36)}`
    const clock = restoredClock(req, Date.now())

    const meta: Session = {
      id,
      title: req.title ?? basename(req.cwd),
      cwd: req.cwd,
      agent,
      model: req.model || undefined,
      status: 'starting',
      lastOutput: Date.now(),
      lastKeyboard: Date.now(),
      createdAt: Date.now(),
      // The display clock, and deliberately NOT createdAt - see shared/restoreTurn.ts.
      openedAt: clock.openedAt,
      // Its last finished turn, so a reopened row still has a number rather than a blank.
      lastRunMs: clock.lastRunMs,
      // A launch with a prompt is engaged from the start; a bare CLI is not doing
      // anything for you yet, so its first quiet moment is not "finished". A RESTORED
      // pane inherits it: the conversation is live even though nobody has typed since.
      engaged: clock.engaged,
      role: req.role,
      // Which device handed this pane over, when one did. Kept because the budget rule
      // must never send it straight back: two desks each keeping two agents would
      // otherwise pass one pane between them for ever, each one correct on its own.
      arrivedFrom: req.arrivedFrom,
      lane: req.lane,
      laneNote: req.laneNote,
      cols: 120,
      rows: 30
    }
    const live: Live = {
      meta,
      proc: this.spawn(req, agent, 120, 30),
      buffer: new OutBuffer(BUFFER_LIMIT),
      req,
      cols: 120,
      rows: 30,
      deskCols: 120,
      deskRows: 30,
      busyUntil: 0,
      ackedAt: 0,
      repaintUntil: 0,
      turnPending: false,
      footerEndedAt: 0,
      sawFooter: false,
      recoverSeen: 0,
      recoverTries: 0,
      askSince: 0,
      askSig: '',
      askKey: '',
      autoRun: 0,
      autoKey: '',
      autoAt: 0,
      lastTail: '',
      typed: '',
      slashAt: 0,
      slashQuietUntil: 0,
      stallRaised: false
    }
    // What this pane had on screen last time, put back before the new process says
    // anything. It is the previous session's transcript, replayed raw - see `restoredTail`.
    const back = restoredTail(req.scrollbackId)
    if (back.text) {
      live.buffer.set(back.text)
      if (back.cols > 0) meta.replayCols = back.cols
    }
    this.sessions.set(id, live)
    this.attach(live)
    recordStart(meta)
    // A reopened pane keeps its id, so History already knows what it was asked to do -
    // and a restored row that cannot say which conversation it is is the whole reason
    // this reading is on the session at all.
    meta.gist = gistFor(id)
    // Started ON a conversation (a reopened desk) rather than into a fresh one: say so,
    // or the pane spends its life holding a file older than itself and looking for a
    // newer one to belong to.
    noteSession(id, req.cwd, agent, req.resume ? req.resumeId : undefined)
    this.queuePrompt(id, req.prompt, req.promptDelay)
    // The pane was mid-turn when the app went down. `--resume` brings the conversation
    // back and not the answer that was being written, so the CLI comes back at an empty
    // composer - idle, green, and indistinguishable from a pane that finished. Same
    // machinery and same switch as a turn the transport cut in half: `queuePrompt` waits
    // for an idle composer and confirms the return took, so a CLI still replaying its
    // transcript is never typed over. Cleared from `req` so a later manual restart of
    // this pane does not continue a turn that ended hours ago.
    if (continueAfterRestore(req, (getConfig().recover ?? DEFAULT_RECOVER).enabled)) {
      const text = (getConfig().recover ?? DEFAULT_RECOVER).text || DEFAULT_RECOVER.text
      console.info(`restore: ${id} was mid-turn when the app went down - continuing it`)
      this.queuePrompt(id, text, RESTORE_CONTINUE_MS)
    }
    req.wasWorking = false

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
    // A restart is a new conversation unless the CLI is being asked to resume one, and
    // either way the pane is writing a different file from here.
    noteSession(
      id,
      live.meta.cwd,
      live.meta.agent,
      live.req.resume ? live.req.resumeId : undefined
    )
    live.proc = this.spawn(live.req, live.meta.agent, live.cols, live.rows)
    live.buffer.set(RESET)
    live.meta.status = 'starting'
    live.meta.exitCode = undefined
    live.meta.attention = false
    live.meta.bell = false
    live.meta.stalledSince = undefined
    live.stallRaised = false
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
    live.meta.lastKeyboard = Date.now()
    live.repaintUntil = 0
    this.emit('data', id, RESET)
    this.attach(live)
    recordStart(live.meta)
    this.queuePrompt(id, live.req.prompt, live.req.promptDelay)
    this.emitSessions()
    return live.meta
  }

  /**
   * A pane's folder no longer exists, and this is where its project lives now.
   *
   * The only thing that removes a folder under a pane is the lane sweep, and it
   * refuses while a pane is live in one - so this reaches ended panes, which stay in
   * the list to be restarted. Restarting into a deleted worktree fails with a path
   * error about a folder the user never typed; pointing the card back at the project
   * makes it start where the work ended up. The lane label goes with it: the pane is
   * not in a lane any more, and the chip would be describing a folder that is gone.
   */
  relocate(from: string, to: string): boolean {
    // Same folder, different spelling: these two arrive from different places, so one
    // of them has backslashes or a trailing one and === quietly matches nothing.
    const key = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const same = (a: string, b: string): boolean => key(a) === key(b)
    let moved = false
    for (const live of this.sessions.values()) {
      if (!same(live.meta.cwd, from)) continue
      live.meta.cwd = to
      live.meta.lane = undefined
      live.meta.laneNote = undefined
      // The request is what a restart spawns from, so it moves too - along with the
      // lane's dev-server port, which belonged to the lane and not to the project.
      live.req = { ...live.req, cwd: to, lane: undefined, laneEnv: undefined }
      moved = true
    }
    if (moved) this.emitSessions()
    return moved
  }

  /**
   * Point an existing pane at a different folder and respawn it there. The pane, its
   * title, its position and its id all survive.
   *
   * Used for one thing: a pane that was moved into a worktree lane, whose lane has
   * turned out to hold nothing, going back to the project folder it came from (see
   * main/laneWork.ts). Never resumes - the only caller does this because the
   * conversation was just cleared, and `--continue` would fetch it straight back.
   */
  moveTo(id: string, cwd: string, patch: Partial<StartSessionRequest> = {}): Session | null {
    const live = this.sessions.get(id)
    if (!live) return null
    live.req = { ...live.req, ...patch, cwd, prompt: undefined, resume: false }
    live.meta.cwd = cwd
    live.meta.lane = patch.lane
    live.meta.laneNote = patch.laneNote
    return this.restart(id)
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

  /**
   * Put the panes in the order the sidebar was just dragged into.
   *
   * The Map's insertion order IS the pane order - `list()` walks it, and so do the
   * grid, the Ctrl-N keys and the snapshot taken across an update restart. Rebuilding
   * it is therefore the whole of "move this card up two". Ids this does not mention
   * (a pane that started while the drag was in flight, a mirrored `@device/id` the
   * other machine owns) keep their places at the end rather than disappearing.
   */
  reorder(ids: string[]): void {
    const next = new Map<string, Live>()
    for (const id of ids) {
      const live = this.sessions.get(id)
      if (live) next.set(id, live)
    }
    for (const [id, live] of this.sessions) if (!next.has(id)) next.set(id, live)
    // Same panes, different order, or nothing happened at all.
    if (next.size !== this.sessions.size) return
    let same = true
    const before = [...this.sessions.keys()]
    const after = [...next.keys()]
    for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) same = false
    if (same) return
    this.sessions = next
    this.emitSessions()
  }

  /**
   * A prompt was submitted in this pane, and History worked out what it says about it.
   *
   * Pushed rather than pulled: everything that talks about a live pane (the mascot's
   * sentence about a close, the countdown before one) is holding a session and has no
   * way to reach a file on disk in the moment that matters.
   */
  noteGist(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    const line = gistFor(id)
    if (!line || s.meta.gist === line) return
    s.meta.gist = line
    this.emitSessions()
  }

  rename(id: string, title: string): void {
    const s = this.sessions.get(id)
    if (!s || !title.trim()) return
    s.meta.title = title.trim().slice(0, 60)
    this.emitSessions()
  }

  /**
   * Hand a pane a job to do: type the text into its composer and press Enter for real.
   *
   * The same machinery a launch prompt uses (`queuePrompt`), exposed because a lane
   * hand-over is the identical problem arriving later in a pane's life. LaneStrip used to
   * do it itself with one `write(id, text + '\r')`, which is exactly the shape that was
   * measured failing on 2026-08-11: the CR is the last byte of a paste rather than a
   * keystroke, so the paragraph sits in the prompt box and the chat waits for a human to
   * press Enter. Robert found one of these on 2026-08-17 - the conflicted-lane job was in
   * his box, unsent - which is what this method exists to stop.
   *
   * Nothing about this is specific to startup: it waits for an idle composer, writes the
   * text, sends the return SEPARATELY a beat later, and re-sends it if the pane is still
   * sitting idle afterwards.
   */
  sendPrompt(id: string, text: string): void {
    if (!this.sessions.has(id)) return
    this.queuePrompt(id, text)
  }

  write(id: string, data: string): void {
    const live = this.sessions.get(id)
    if (!live) return
    live.proc.write(data)
    // Rebuild the line being typed, before the isTyping gate: a lone backspace is not
    // "typing" to the gate below, but it still has to erase from this record.
    live.typed = typeLine(live.typed, data)
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
    if (submitted) {
      live.meta.lastKeyboard = Date.now()
      const slash = isSlashCommand(live.typed)
      // `/clear` and `/resume` are the two ways a pane changes which conversation it is
      // in without restarting. The pane keeps its transcript until told otherwise (a
      // second pane on the same repo must not be able to drift onto it), so this is
      // where being told happens.
      if (slash && /^\s*\/(clear|resume)\b/.test(live.typed)) {
        noteSession(id, live.meta.cwd, live.meta.agent)
      }
      const quiet = slash && isQuietSlash(live.typed)
      live.typed = ''
      this.beginRun(live)
      // A slash command still gets the run clock (the readout should say how long
      // /compact took) but not the bell: turnPending stays down unless the run turns
      // out to be real work - see SLASH_TURN_MS where the footer ends.
      live.slashAt = slash ? Date.now() : 0
      // ...except for the ones that finish with nothing to read, which are never
      // promoted however long they run. A real prompt sets this back to 0, so typing a
      // question straight after a /clear arms the bell again immediately.
      live.slashQuietUntil = quiet ? Date.now() + QUIET_SLASH_MS : 0
      if (slash) live.turnPending = false
    }
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
  private beginRun(live: Live, clock?: TurnClock): boolean {
    // Set even when a turn is already counting: this is the flag that says "there is
    // something here worth telling you about when it goes quiet", and a second prompt
    // sent into a running turn is still work you are waiting on.
    live.turnPending = true
    live.footerEndedAt = 0
    if (live.meta.runSince) return this.anchorRun(live, clock)
    // A turn that stopped and started again within a minute is a turn boundary this app
    // invented: nobody asks two questions a few seconds apart and calls the first answer
    // finished. Written down rather than guessed at, because "the clock reset mid-turn"
    // has now been reported three times and each round of it was argued from memory of
    // what the screen looked like. `clock` is the number the CLI itself is showing, so a
    // line where it says 28m next to a run this app just ended at 4m names the bug
    // outright - and one where the CLI also restarted says the turn really did end.
    if (live.runEndedAt && Date.now() - live.runEndedAt < TURN_SPLIT_MS) {
      audit('turn-split', {
        title: live.meta.title,
        agent: live.meta.agent,
        endedMsAgo: Date.now() - live.runEndedAt,
        lastRunMs: live.meta.lastRunMs ?? null,
        agentSaysMs: clock?.ms ?? null,
        quietMs: Date.now() - live.meta.lastOutput,
        tail: plainTail(live.lastTail)
      })
    }
    // Start where the AGENT says the turn started, not where this app noticed it. A pane
    // that mounts onto a turn already in progress - a restored desk, a session opened in
    // a second window, a turn whose first frames this app read as idle - would otherwise
    // count from now and report a fraction of the real time.
    live.meta.runSince = Date.now() - (clock?.ms ?? 0)
    live.meta.lastRunMs = undefined
    return true
  }

  /**
   * Pull the run clock onto the agent's own counter.
   *
   * This is the fix for "the pane says 12m and the terminal says 24m". The app's start
   * time is a guess made at one moment - whichever of the submit keystroke or the first
   * busy frame it saw - and every way of getting that moment wrong (a footer missed for
   * a second, a turn boundary invented mid-turn, a pane remounted) is silent and
   * permanent for the rest of the turn. The CLI is printing the true elapsed on every
   * frame, so the pane sends it up every fifteen seconds and the clock is corrected
   * against it.
   *
   * Only when the two disagree by more than the CLI's own rounding: a reading of "24m"
   * says nothing about the seconds, and correcting by less than that would drag the
   * readout backwards every minute.
   */
  private anchorRun(live: Live, clock?: TurnClock): boolean {
    if (!clock || !live.meta.runSince) return false
    const want = anchoredStart(Date.now(), live.meta.runSince, clock)
    if (want === null) return false
    live.meta.runSince = want
    return true
  }

  /** End of a turn: freeze what it took and stop counting. */
  private endRun(live: Live): boolean {
    if (!live.meta.runSince) return false
    live.meta.lastRunMs = Date.now() - live.meta.runSince
    live.meta.runSince = undefined
    live.runEndedAt = Date.now()
    // The turn is over, however it ended: a pane cannot still be "stuck mid-turn"
    // while the chime is announcing that its turn finished.
    live.stallRaised = false
    live.meta.stalledSince = undefined
    return true
  }

  /**
   * One pty cannot be two shapes at once.
   *
   * A pane is drawn by the desk window AND, when it is serving one, by a phone - and
   * both of them fit their own screen and say so here. Whoever spoke last won, which
   * meant a phone that looked at a pane left the pty 50 columns wide and the desk drew
   * its 157-column pane with every line wrapped a third of the way across. Nothing gave
   * it back, so the desk stayed broken until the window was resized by hand. Measured:
   * desk terminal 157x57, pty 50x50, and the phone had been closed for minutes.
   *
   * So the desk OWNS the size and a phone BORROWS it. A borrowed resize bends the pty to
   * the phone and leaves `deskCols/deskRows` alone; `returnSizes` puts every borrowed pty
   * back, and it is called when the phone leaves the pane (`pty:return`) and when the last
   * phone stream closes. A desk resize takes ownership back on the spot: a window the user
   * is dragging is a person at the desk, and they win.
   */
  resize(id: string, cols: number, rows: number, borrowed = false): void {
    const s = this.sessions.get(id)
    if (!s || s.meta.status === 'exited') return
    // A DESK resize arriving while a phone is holding this pane is remembered, not
    // obeyed. "The desk wins on the spot" was written for a borrow that had OUTLIVED the
    // phone, and the desk does not only resize when somebody drags the window: showing a
    // pane, toggling the grid, opening a dialog and the window's own layout all refit and
    // land here. Each one snapped the pty back to 157 columns underneath a phone that was
    // still drawing it at 50, and a CLI's repaint is cursor-up-and-overwrite arithmetic
    // done in the width it thinks it has - so every "thinking" frame missed the line it
    // meant to paint over and landed under the last one instead. That is "the output is
    // very buggy on mobile, it spams the Claude thinking info". The borrow ends the way
    // it always did: `returnSizes`, when the phone looks away or its stream closes.
    if (!borrowed && s.borrowed) {
      s.deskCols = Math.max(cols, 20)
      s.deskRows = Math.max(rows, 5)
      return
    }
    s.cols = Math.max(cols, 20)
    s.rows = Math.max(rows, 5)
    // History replays this pane's raw bytes at whatever width they were written for, so
    // the last one wins. In memory only - a dragged window resizes many times a second.
    noteCols(id, s.cols)
    if (borrowed) {
      s.borrowed = true
    } else {
      s.borrowed = false
      s.deskCols = s.cols
      s.deskRows = s.rows
    }
    // Carried on the session itself so a device mirroring this pane can draw it at the
    // size it actually is. Only pushed when the numbers moved: a window drag is dozens
    // of these a second and they mostly land on the same cell count.
    //
    // `borrowed` rides with them, because the desk needs to know it is not the one
    // deciding: drawn at its own width against a 50-column pty it wraps every line, which
    // is the same soup on the other screen. A pane whose size is borrowed is drawn at the
    // pty's grid instead.
    if (s.meta.cols !== s.cols || s.meta.rows !== s.rows || s.meta.borrowed !== s.borrowed) {
      s.meta.cols = s.cols
      s.meta.rows = s.rows
      s.meta.borrowed = s.borrowed
      this.emitSessions()
    }
    // Showing a pane refits it and lands here; the CLI repaints in response.
    s.repaintUntil = Date.now() + REPAINT_GRACE_MS
    try {
      s.proc.resize(s.cols, s.rows)
    } catch {
      // pty already gone between the renderer's measure and this call - harmless.
    }
  }

  /**
   * Give every borrowed pty back to the desk.
   *
   * Called when a phone stops looking at a pane and when the last phone stream closes,
   * because those are the two ways "a phone is drawing this" ends. Idempotent, and it
   * asks the CLI to repaint: the frame on the desk was drawn for a phone and would
   * otherwise sit there at a third of the width until the agent printed something.
   */
  returnSizes(): void {
    for (const [id, s] of this.sessions) {
      if (!s.borrowed) continue
      s.borrowed = false
      if (s.cols === s.deskCols && s.rows === s.deskRows) {
        // Same numbers, but the desk is drawing this pane as a borrowed one until it is
        // told otherwise - so the flag still has to travel even when nothing resizes.
        if (s.meta.borrowed) {
          s.meta.borrowed = false
          this.emitSessions()
        }
        continue
      }
      this.resize(id, s.deskCols, s.deskRows)
      this.redraw(id)
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
   * Answer the question on a pane by number.
   *
   * Arrows and a return, spaced out, never the digit and never one write - the reasons
   * are in `shared/choices.ts` and in `queuePrompt` above respectively: a chooser that
   * only reads the arrows ignores a digit silently, and a burst of keys in one write
   * arrives at a widget that has not finished redrawing between them.
   *
   * It refuses rather than guesses when the pane is not on that question any anymore.
   * A button on a phone is pressed seconds after the frame it was drawn from, and in
   * that gap somebody at the desk may have answered it - at which point the keys would
   * land in a composer, as an arrow through history and a return that submits it.
   */
  choose(id: string, n: number): boolean {
    const live = this.sessions.get(id)
    const ask = live?.meta.ask
    if (!live || !ask) return false
    const keys = keysForChoice(ask, n)
    if (!keys) return false
    // Answering is engaging with the pane, the same as typing in it: the turn that
    // follows is one somebody asked for, so it may ring when it ends.
    live.meta.engaged = true
    // Re-checked before EVERY key, not only before the first one.
    //
    // The keys are spread over a few hundred milliseconds, and the question can end
    // inside that window - the agent answers, the pane reports busy, and `ask` is
    // cleared. A closure that only asks whether the session still exists then writes
    // the remaining arrows into whatever replaced the chooser: a composer, where an
    // up-arrow is the previous command and the return submits it. Checking the session
    // was never the guard; being on the SAME question is.
    keys.forEach((k, i) =>
      setTimeout(() => {
        const now = this.sessions.get(id)
        if (!now || !sameAsk(now.meta.ask, ask)) return
        this.write(id, k)
      }, i * CHOOSE_GAP_MS)
    )
    return true
  }

  /**
   * The renderer's read of whether the agent's own UI still says it is running. Panes
   * repeat it every second or so, so the deadline it sets expires by itself if the pane
   * goes away.
   */
  setBusyOnScreen(id: string, busy: boolean, tail = '', clock?: TurnClock): void {
    const s = this.sessions.get(id)
    if (!s) return
    const now = Date.now()
    // Once a pane has read this agent's "running" footer even once, this session's
    // turn boundaries are knowable, and the bell stops trusting the quiet clock alone.
    if (busy) s.sawFooter = true
    else if (tail) s.lastTail = tail
    // A question and a running agent are never on screen together - ASK_PROMPT outranks
    // every busy footer in `readsBusy` - so a busy pane has no question by construction
    // and clearing it here is the whole of "the question went away". The frame arrives
    // only with a `false`, which is exactly when one can be live.
    const wasAsk = s.meta.ask
    const ask = busy ? null : readAsk(tail)
    s.meta.ask = ask ?? undefined
    // The question's own clock, for `autoAnswer`. The signature includes the arrow, so
    // moving it at the desk restarts the wait rather than having a press land from the
    // position somebody just moved away from. A pane with no question resets the run
    // counter: what that counter guards against is one question being answered over and
    // over, not a session that asks a lot of them.
    const sig = ask ? askSignature(tail) : ''
    if (sig !== s.askSig) {
      s.askSig = sig
      s.askSince = sig ? now : 0
    }
    s.askKey = askKeyOf(ask)
    this.refreshAutoPlan(s)
    // The run counter is given back by the pane going BUSY, and by nothing else.
    //
    // "No question on screen" is the wrong signal for it: a chooser mid-repaint reads as
    // no question for one frame, so resetting there hands the budget back several times
    // during a single question and `maxRun` stops bounding anything. A busy pane means
    // the agent took an answer and went back to work, which is the only evidence that
    // these presses are getting somewhere.
    if (busy) {
      s.autoRun = 0
      s.autoKey = ''
      s.autoAt = 0
    }
    // The arrow moving is a change worth emitting (it is what `chooseOption` counts
    // from) but is NOT a new question, so it must not be treated as one by anything
    // that notifies. Callers compare with `sameAsk`.
    if (!sameAsk(wasAsk, ask) || wasAsk?.selected !== ask?.selected) this.emitSessions()
    // A question that was not there a frame ago, once, on the way in. Only a NEW one
    // (`sameAsk` ignores where the arrow is), so arrowing through the options at the desk
    // cannot send a second message about the same question - and the wording of that guard
    // matters more than it looks: the arrow moving comes through this same path several
    // times per question.
    if (ask && !sameAsk(wasAsk, ask)) this.emit('ask', s.meta)
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
      const moved = this.beginRun(s, clock)
      // Inside a slash command's window the footer confirming "busy" is the /clear
      // hook flash, and beginRun just re-armed the bell for it; hold it down until
      // the run has lasted long enough to be real work.
      if (s.slashAt) {
        if (now - s.slashAt >= SLASH_TURN_MS) s.slashAt = 0
        else s.turnPending = false
      }
      // A quiet command outranks that promotion and outlives it: the hooks after a
      // /clear flap the footer busy several times, and each flap comes back through
      // beginRun with the bell re-armed.
      if (now < s.slashQuietUntil) s.turnPending = false
      // A silent tool call produces no output for minutes, and the idle sweep used to
      // grey the dot out in the middle of it - the pane read as finished while the
      // agent was demonstrably still working. On-screen busy outranks the quiet clock.
      const wasWorking = s.meta.status === 'working'
      if (s.meta.status !== 'exited') s.meta.status = 'working'
      if (!wasRunning || !wasWorking || moved) this.emitSessions()
      return
    }
    // Remember when the footer went quiet, so the nudge can come sooner than the
    // blind backstop for the agents whose UI we can actually read.
    if (!s.footerEndedAt) s.footerEndedAt = now
    // The slash command's run is over. If it ran long enough to be real work after
    // all, raise the hand it was denied at submit; either way the window closes here.
    if (s.slashAt) {
      if (now - s.slashAt >= SLASH_TURN_MS) s.turnPending = true
      s.slashAt = 0
    }
    // Nothing to read at the end of a /clear, /compact or /resume, however long it took.
    if (now < s.slashQuietUntil) s.turnPending = false
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
    // A bell is a request for a person, and a person is now looking at the pane. The
    // stall mark goes with it: you have seen the pane that was quiet, and the alert
    // has nothing left to tell you. Neither re-arms until the pane earns it again.
    const marked = s.meta.bell || s.meta.stalledSince !== undefined
    if (marked) {
      s.meta.bell = false
      s.meta.stalledSince = undefined
    }
    if (!s.meta.attention && !marked) return
    s.meta.attention = false
    this.emitSessions()
  }

  /**
   * Tee this pane's live output to a file, or stop the tee it has. `null` stops.
   *
   * The tee belongs to the PANE, not to the app: it dies with the session and is not
   * remembered across a restart of PaneForge. A file that quietly started filling up
   * again days later, because of a menu item clicked once, is the wrong surprise.
   */
  pipe(id: string, opts: PipeOptions | null): PipeInfo | null {
    const live = this.sessions.get(id)
    if (!live) return null
    if (!opts) {
      stopPipe(id)
      live.meta.piping = undefined
      this.emitSessions()
      return null
    }
    // Same object the tee mutates, so the byte counter on the pane header is current
    // whenever anything else re-emits the session list - no timer of its own.
    live.meta.piping = startPipe(id, opts)
    this.emitSessions()
    return live.meta.piping
  }

  /**
   * Paint a pane as on its way to another device, or take the paint off.
   *
   * Set the moment a move starts and cleared on every way out of one, including a refusal.
   * Two things read it: the pane, which should say it is leaving before it does, and
   * `reclaim.ts`, which must not close a pane a handoff is mid-flight on - that would free
   * the same memory and lose the work, since the far end is about to resume from it.
   */
  setHandingOff(id: string, on: boolean, queuedAt?: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    const was = !!s.meta.handingOff
    const wasAt = s.meta.handoffQueuedAt
    if (on) s.meta.handingOff = true
    else delete s.meta.handingOff
    // A queued pane and one actually in transit are the same paint to `reclaim.ts` and two
    // different sentences to a person, so the moment it stops waiting and starts moving is
    // a change the card has to see.
    if (on && queuedAt) s.meta.handoffQueuedAt = queuedAt
    else delete s.meta.handoffQueuedAt
    if (was === on && wasAt === s.meta.handoffQueuedAt) return
    this.emitSessions()
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    // Before the pty dies, while its pid still names a group and a tree. What the pane
    // started detached is not reachable from either, which is what strays.ts is for.
    killPaneStrays(id, s.proc.pid)
    try {
      s.proc.kill()
    } catch {
      /* already dead */
    }
    stopPipe(id)
    recordEnd(id)
    forgetSession(id)
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
    // Before the early return: a pane that was teed and then closed by hand is gone
    // from the map, but its stream is only closed here if anything went wrong above.
    stopAllPipes()
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
    const args = buildArgs(spec, { resume: req.resume, resumeId: req.resumeId, model: req.model })
    return pty.spawn(which(spec.bin), args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: req.cwd,
      // A lane's own PORT belongs to the pane, not to the app: it must not leak
      // into a session started in the original folder afterwards.
      //
      // The agent's own env sits between the two: it is what makes this agent this
      // agent (the OpenRouter base URL and key), so it beats whatever the app was
      // launched with, and a lane's variables still beat it.
      env: { ...agentEnv(), ...resolveEnv(spec, agentKeys()), ...(req.laneEnv ?? {}) }
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
      live.buffer.push(data)
      recordData(id, data)
      // Before the repaint gate below: a tee is a copy of what the pane printed, and a
      // repaint is something the pane printed. Only the status machinery cares why.
      feedPipe(id, data)
      // The pane is talking again, so the silence that was reported is over. Also
      // before the repaint gate: a repaint proves the process is alive, which is the
      // one thing the stall alert is claiming it is not.
      if (live.stallRaised) {
        live.stallRaised = false
        meta.stalledSince = undefined
      }
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
      // Output alone is not work either, and the status used to say it was: eight panes
      // relaunched at startup all painted their own banner within a second and the whole
      // sidebar went green - running clocks, lit Ctrl-N keys - while every one of them was
      // still only booting its CLI. A pane counts as working when it has been ASKED
      // something (`engaged`: a prompt at launch, or a keystroke since) or when its own
      // footer says the agent is running (`busyUntil`, set by setBusyOnScreen). Anything
      // else keeps the status it had, so a fresh pane stays amber 'starting' and settles
      // into 'idle' on its own timer.
      if (meta.engaged || live.busyUntil > now) meta.status = 'working'
      this.emit('data', id, data)
      if (wasIdle && meta.status === 'working') this.emitSessions()
    })

    proc.onExit(({ exitCode }) => {
      if (live.proc !== proc) return
      meta.status = 'exited'
      meta.exitCode = exitCode
      // The pane has stopped talking for good: a tee left open would hold the file
      // handle for as long as the dead card sits in the list, and on Windows that is
      // enough to stop the watcher deleting or rotating it.
      stopPipe(id)
      meta.piping = undefined
      this.endRun(live)
      recordEnd(id)
      this.emitSessions()
    })
  }

  /**
   * Type a launch prompt into a pane and submit it.
   *
   * A fixed delay is not enough and the failure it causes is silent. Codex starts its
   * MCP servers before the composer takes keys - measured 2026-08-11, still painting
   * `Starting MCP servers (0/2)` well past the old 2500ms - and a CLI that is still
   * booting replays what arrived during the boot INTO the composer, where the trailing
   * carriage return of `prompt + '\r'` is one more character of the paste rather than a
   * keystroke. The pane then sits for ever holding a fully typed prompt nobody sent,
   * looking exactly like a person who walked away mid-sentence. Two #momin bundles sat
   * like that for hours.
   *
   * So the wait is for an IDLE COMPOSER, not for a clock: the pane's own output has to
   * stop AND stop saying it is working, which is `readsBusy` - the same reading the
   * board draws - over the tail of what the pty has printed. Quiet alone is not enough
   * and was measured failing: Codex pauses mid-startup with `Starting MCP servers
   * (0/4) ... esc to interrupt` on screen, and a return sent into that screen cancels
   * the startup instead of submitting anything.
   *
   * Then the return goes as a SEPARATE write a beat later, so the CLI sees a keystroke
   * on a composer it has already drawn rather than the last byte of a paste - and the
   * submit is CONFIRMED, not assumed: if the pane is still idle a few seconds later the
   * return is sent again, up to `PROMPT_ENTER_TRIES`. Every step is capped, so the worst
   * case is a prompt typed late and left on screen for a person, never a hang.
   */
  private queuePrompt(id: string, prompt?: string, extraDelay = 0): void {
    if (!prompt) return
    const deadline = Date.now() + PROMPT_WAIT_MAX_MS + Math.max(0, extraDelay)
    // The busy read is of the LAST THING PAINTED, never of a window of scrollback:
    // `esc to interrupt` printed during the boot stays in the buffer for ever, so a
    // fixed tail reports a pane as working long after it went quiet at its composer
    // and the prompt is never typed at all. What is asked here is "what was on screen
    // when it stopped", which is the newest output and nothing older.
    let seen = 0
    let painted = ''
    const idle = (live: Live): boolean => {
      const text = strip(live.buffer.read())
      if (text.length < seen) seen = 0
      if (text.length > seen) {
        painted = text.slice(seen).slice(-PROMPT_TAIL_CHARS)
        seen = text.length
      }
      return Date.now() - live.meta.lastOutput >= PROMPT_QUIET_MS && !readsBusy(painted)
    }

    const submit = (tries: number): void => {
      const live = this.sessions.get(id)
      if (!live) return
      this.write(id, '\r')
      if (tries + 1 >= PROMPT_ENTER_TRIES) return
      setTimeout(() => {
        const still = this.sessions.get(id)
        // Work of any kind means it went in: the agent is answering, or the CLI is at
        // least painting something back. A pane still sitting at an idle composer has
        // eaten the return, so send another one.
        if (still && idle(still)) submit(tries + 1)
      }, PROMPT_CONFIRM_MS)
    }

    const tick = (): void => {
      const live = this.sessions.get(id)
      if (!live) return
      if (!idle(live) && Date.now() < deadline) {
        setTimeout(tick, PROMPT_POLL_MS)
        return
      }
      this.write(id, prompt)
      setTimeout(() => this.sessions.get(id) && submit(0), PROMPT_ENTER_MS)
    }
    setTimeout(tick, PROMPT_START_MS + Math.max(0, extraDelay))
  }

  /**
   * Finish a turn that was cut in half, or reset the budget because one ended whole.
   *
   * Only output produced since the last look is considered. The error line stays in the
   * buffer for ever, so a fixed tail would keep reporting the same failure until the retry
   * budget was gone - the same trap `queuePrompt`'s busy read documents, one function up.
   *
   * The send goes through `queuePrompt`, which is the machinery that already knows how to
   * put text into a CLI's composer and confirm the return actually took: a bare write here
   * would be the blind 2500ms timer that left two panes holding a typed prompt nobody sent.
   */
  private sweepRecover(live: Live): void {
    const cfg = getConfig().recover ?? DEFAULT_RECOVER
    if (!cfg.enabled) return
    const text = strip(live.buffer.read())
    if (text.length < live.recoverSeen) live.recoverSeen = 0
    if (text.length <= live.recoverSeen) return
    const fresh = text.slice(live.recoverSeen)
    const found = recover(
      { painted: fresh.slice(-TAIL_CHARS), busy: false, tries: live.recoverTries },
      cfg
    )
    // Everything from here has been read, whichever way it went: a turn that ended whole
    // gives the budget back, so a pane that drops once an hour never runs out of tries.
    live.recoverSeen = text.length
    if (!found) {
      live.recoverTries = 0
      return
    }
    live.recoverTries++
    console.info(
      `recover: ${live.meta.id} continuing a cut-off turn (${live.recoverTries}/${cfg.maxTries}) - ${found.because}`
    )
    this.queuePrompt(live.meta.id, found.text)
  }

  /**
   * Press the obvious answer to the question on this pane, if there is one.
   *
   * The decision is `shared/autoAnswer.ts` and the keystrokes are `choose`, which already
   * re-checks the question before EVERY key - so a question answered at the desk in the
   * gap cannot have the rest of an auto-answer's arrows land in a composer.
   *
   * Everything here is the timing half. A question is answered only once it has sat
   * unchanged for `waitMs` (the window in which a person who disagrees can reach it), and
   * only once per signature: a press that does not take leaves the same question on screen,
   * and pressing again every second is the app arguing with a widget.
   */
  /**
   * What autoAnswer is going to do about this pane's question, and when.
   *
   * Written onto the session so the pane can say so BEFORE it happens, and carrying the
   * same guards `sweepAutoAnswer` presses under - a question this will never answer shows
   * no clock at all.
   *
   * Called from BOTH the frame path and the timer, which is not belt and braces: a frame
   * only arrives when the screen changes, so computing it there alone meant turning the
   * setting on while a question was already up produced no countdown at all and then a
   * press out of nowhere. Measured that way on 2026-08-19 against a live trust prompt -
   * the answer went in, the clock never appeared. Returns whether anything moved, so the
   * timer can emit only when it did.
   */
  private refreshAutoPlan(live: Live): boolean {
    const cfg = getConfig().autoAnswer ?? DEFAULT_AUTO_ANSWER
    const ask = live.meta.ask
    const at = ask ? autoAnswerAt(live, cfg, ask) : 0
    const n = at && ask ? pickAnswer(ask, cfg)?.n : undefined
    if (live.meta.autoAnswerAt === (at || undefined) && live.meta.autoAnswerN === n) return false
    live.meta.autoAnswerAt = at || undefined
    live.meta.autoAnswerN = n
    return true
  }

  private sweepAutoAnswer(live: Live): void {
    const cfg = getConfig().autoAnswer ?? DEFAULT_AUTO_ANSWER
    const ask = live.meta.ask
    if (!ask) return
    if (this.refreshAutoPlan(live)) this.emitSessions()
    if (!dueForAuto(live, cfg, Date.now())) return
    const pick = pickAnswer(ask, cfg)
    if (!pick) return
    live.autoKey = live.askKey
    live.autoAt = Date.now()
    // The clock has run out; nothing is pending any more. The next frame recomputes it,
    // but a countdown left sitting at 0 while the keys land reads as a stuck timer.
    live.meta.autoAnswerAt = undefined
    live.meta.autoAnswerN = undefined
    live.autoRun++
    console.info(
      `autoAnswer: ${live.meta.id} answering ${pick.n} (${live.autoRun}/${cfg.maxRun}) - ${pick.why}`
    )
    this.choose(live.meta.id, pick.n)
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

      // A turn the transport cut in half, finished without anybody noticing.
      //
      // Deliberately here, in the sweep, rather than on the output stream: the decision
      // needs the turn to have ENDED, and "the pane stopped and stopped saying it was
      // working" is the one thing this loop already knows how to establish. Reading the
      // error the instant it is painted would fire while the CLI is still redrawing its
      // composer underneath it.
      if (
        meta.status === 'idle' &&
        !busyOnScreen &&
        !meta.runSince &&
        quiet > IDLE_AFTER_MS &&
        live.proc
      ) {
        this.sweepRecover(live)
      }

      // A question with an obvious answer, pressed rather than waited on. Here rather
      // than where the question is READ, for the same reason as recover: the frame
      // arrives many times a second while the CLI redraws its chooser, and the wait this
      // needs is measured from when the question settled, not from when it was painted.
      if (live.meta.ask) this.sweepAutoAnswer(live)
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

      // The other half of the same question. Attention above is "the turn ended and
      // you were not looking"; this is "the turn did NOT end and nothing has come out
      // of it for minutes", which is the case the app was previously silent about -
      // the run clock ticking away next to a pane whose agent is stuck on a lock, or
      // waiting behind a prompt that has scrolled off, or gone entirely.
      if (
        stalledNow({
          quiet,
          runSince: meta.runSince,
          engaged: meta.engaged,
          raised: live.stallRaised,
          silenceMs: stallAfterMs
        })
      ) {
        live.stallRaised = true
        meta.stalledSince = meta.lastOutput
        audit('stalled', {
          title: meta.title,
          agent: meta.agent,
          quietMs: quiet,
          runMs: meta.runSince ? now - meta.runSince : 0,
          busyOnScreen,
          tail: plainTail(live.lastTail)
        })
        this.emit('stalled', meta)
        changed = true
      }
    }
    if (changed) this.emitSessions()
  }

  /**
   * The pane's terminal rang its bell (`\x07`).
   *
   * It is reported by the renderer rather than sniffed out of the byte stream here,
   * because 0x07 is also how an OSC sequence ends - every window title a CLI sets
   * contains one, and treating those as bells would ring on every `cd`. xterm's
   * parser already knows the difference, and it is the thing drawing the frame.
   */
  bell(id: string): void {
    const live = this.sessions.get(id)
    if (!live || live.meta.bell) return
    live.meta.bell = true
    this.emit('bell', live.meta)
    this.emitSessions()
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

/** The provider keys Settings holds, read fresh so pasting one reaches the next pane. */
function agentKeys(): Record<string, string> {
  return { ...(getConfig().providerKeys ?? {}) }
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
