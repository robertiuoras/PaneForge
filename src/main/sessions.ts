// Owns every agent process. One pseudo-terminal per session so `claude` behaves
// exactly as it does in Windows Terminal: colours, the input box, Ctrl-C, resize.
//
// Everything here runs in the Electron MAIN process. The renderer never touches a
// pty directly - it sends keystrokes over IPC and receives output events back.

import { execFile, spawn } from 'node:child_process'
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
import { jobTable } from './backJobs'
import { backJobInfo } from './usage'
import { forgetHandoff, handoffFor } from './handoffSteps'
import { clientForCwd, clientForText } from './clients'
import { trustAgyWorkspace } from './agyTrust'
import {
  clientTitle,
  mayRename,
  TOPIC_WINDOW,
  topicReading,
  type TopicReading
} from '../shared/clientName'
import { handleOf, resolvedName } from '../shared/resolvedName'
import { chromeCdpFor } from '../shared/peerChrome'
import type { ClientNamed } from '../shared/types'

/**
 * The refusal a caller must NOT override.
 *
 * `pane-clear.mjs` treats an unknown refusal as overridable and types the clear itself, so
 * this string is a contract with it: it is in that script's `overridable` deny-list beside
 * a human saying no.
 */
export const NOTHING_OPEN = 'the handoff lists nothing still open'
import { jobFromTable, paneJob, programName, SHELLS } from '../shared/paneJob'
import { canSleep } from '../shared/sleep'
import { doneEnough } from '../shared/closeWhenDone'
import { folderName, laneOfCheckout, projectOf } from '../shared/place'
import { dropStale, smallestBorrow, type Borrow } from '../shared/paneSize'
import { START_COLS, START_ROWS } from '../shared/paneGrid'
import { RESTORE_MARK_TEXT } from '../shared/replayWidth'
import { ARM_CLEAR_LEAD_MS, ARM_QUIET_MS, CLEAR_PROMPT_START_MS, DRAFT_RETRY_MS, SUBMIT_GAP_MS, armDecision, clearChunks, resumeOf, dropFor, dropWords, expiryDecision, queuedPromptDecision, quietEnoughToArm, type DropReason, type QueuedPromptVerdict } from '../shared/autoclear'
import { acLog } from './autoclearLog'

/**
 * One request to clear a pane: what the Stop hook asks for, and what the watcher asks for.
 *
 * `command` and `tokens` are the watcher's half - it drives CLIs that are not Claude Code
 * and it is the only caller that has measured a size. Both optional so the hook path,
 * which knows neither, is unchanged.
 */
export interface AutoClearArm {
  /** Model alias typed into the fresh session between the clear and the resume prompt. */
  model?: string
  steps: string[]
  prompt: string
  seconds: number
  noResume?: boolean
  /** The CLI's own word for it: `/clear`, or `/new` in Codex. Defaults to `/clear`. */
  command?: string
  /** Roughly how much context this frees, for the card to say a number. */
  tokens?: number
}
import { feedPipe, startPipe, stopAllPipes, stopPipe, type PipeOptions } from './pipe'
import { forgetSession, noteSession, resumeIdFor } from './transcripts'
import { endHookDeny, feedHookDeny } from './hookDeny'
import { continueAfterRestore, restoredClock } from '../shared/restoreTurn'

/**
 * Extra patience for the "continue" a restore sends. `queuePrompt` waits for an idle
 * composer either way; this only widens its deadline, because a CLI replaying a long
 * transcript can be quiet-then-busy several times before it really settles.
 */
const RESTORE_CONTINUE_MS = Number(process.env.PF_RESTORE_CONTINUE_MS ?? 8000)
import { killPaneStrays, trackStrays } from './strays'
import {
  clearsConversation,
  feedSubmitLine,
  isBareReturn,
  isQuietSlash,
  isSlashCommand,
  newSubmitLine,
  typeLine
} from '../shared/slashTurn'
import { feedDraft, newDraft, type DraftState } from '../shared/draft'
import { OutBuffer } from './outBuffer'
import { allAgents, buildArgs, hasAgent, resolveEnv } from '../shared/agents'
import { homedir } from 'node:os'
import { allowsCwd, scrubForeignKeys } from '../shared/paneTrust'
import { anchoredStart, readsBusy, type BusyReason } from '../shared/busy'
import { outputIsWork } from '../shared/fleet'
import { nextCwdGone, reapForMissingCwd } from '../shared/cwdGone'
import { askKeyOf, autoAnswerAt, DEFAULT_AUTO_ANSWER, dueForAuto, pickAnswer } from '../shared/autoAnswer'
import { countIntervention } from './interventions'
import { deskFocused } from './gameMode'
import { askSignature, CHOOSE_GAP_MS, keysForChoice, readAsk, sameAsk } from '../shared/choices'
import { stripAnsi as strip } from '../shared/ansi'
import { silenceMs, stalledNow } from '../shared/alerts'
import { DEFAULT_RECOVER, recover, TAIL_CHARS } from '../shared/recover'
import { getConfig } from './config'
import { spawnQuiet } from './spawnQuiet'
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
 * How often a pane's cwd is asked whether it still exists. A `statSync` per pane per
 * second is a syscall nobody needs: a folder disappearing is a once-a-week event and
 * the card it affects is already dead, so a lazy answer is the right answer.
 */
const CWD_CHECK_MS = 10_000
/**
 * How long a pane must be BOTH exited and folder-less before its card is removed.
 * Long enough that a folder removed and recreated in two steps - which is what a
 * checkout swap, a `mv` or an installer looks like from out here - never reaps.
 */
const CWD_GONE_REAP_MS = 60_000

const WIN = process.platform === 'win32'

/**
 * How often Windows re-reads the process table for what its shell panes are running.
 *
 * 4s rather than the 1s sweep, because this one is a CIM query rather than a syscall - the
 * same figure `usage.ts` settled on, and for the same reason: the answer is read by a
 * person glancing at a row, not by a control loop. POSIX needs none of it.
 */
const TABLE_JOB_MS = 4000
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
/**
 * What proves a queued line went in. A prompt is proven by the TURN it starts; a slash
 * command (`/model opus`) starts none and is proven by the composer coming back idle.
 */
type PromptProof = 'turn' | 'idle'
const PROMPT_CONFIRM_MS = ms('PF_PROMPT_CONFIRM_MS', 4000)
/**
 * How many returns may be sent before the prompt is left for a person.
 *
 * A return at an empty composer is a no-op in every CLI this types into, so the cost of
 * one more try is nothing and the cost of running out is the whole handoff. Three was
 * measured running out: on 2026-08-30 pane s6-mtfk52fr was cleared, the resume prompt was
 * typed, and every return went in while Claude Code was still running its SessionStart
 * hook chain - which on this desk paints in bursts with second-long gaps, so `idle()` reads
 * ready and the CLI eats the key. The budget was gone in ~12s, the exit was silent, and
 * Robert found the prompt sitting in the box and submitted it himself.
 */
const PROMPT_ENTER_TRIES = ms('PF_PROMPT_ENTER_TRIES', 6)
/**
 * The wait budget for the resume prompt after an automatic `/clear`, which is not the
 * budget an ordinary launch prompt gets.
 *
 * `/clear` RESTARTS the CLI: banner, MCP servers, then this desk's whole SessionStart hook
 * chain. 45s is a fair ceiling on a CLI that is merely booting and is not one on a CLI
 * that is booting and then running hooks - and the failure at the end of it is the worst
 * one this function has, a prompt typed and never sent, with the context already thrown
 * away. Nothing waits on this timer: the pane is usable throughout.
 */
const CLEAR_RESUME_BUDGET_MS = ms('PF_CLEAR_RESUME_BUDGET_MS', 180_000)
/**
 * The hard ceiling on the handover curtain.
 *
 * Longer than the prompt's own wait (`PROMPT_WAIT_MAX_MS` plus its confirm retries) so the
 * normal path always settles first, and short enough that the worst case is a few seconds
 * of a pane refusing keys rather than a pane that has to be closed. The renderer enforces
 * it too, off the deadline it was handed - see `setHandover`.
 */
const handoverMaxMs = (budgetMs = PROMPT_WAIT_MAX_MS): number =>
  budgetMs + PROMPT_CONFIRM_MS * PROMPT_ENTER_TRIES + 5_000
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
 * The two captions a sleeping pane gets, in the same shape and for the same reason as
 * `RESTORE_MARK`: dim, one line, attributes reset first because the pane is cut mid-frame.
 * Nothing else marks the seam - the screen above it is genuinely the screen it had.
 */
const SLEEP_MARK = '\x1b[0m\r\n\x1b[2m--- asleep: the agent has been stopped, press to wake it ---\x1b[0m\r\n'
const WAKE_MARK = '\x1b[0m\r\n\x1b[2m--- awake ---\x1b[0m\r\n'

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
  /**
   * Null while the pane is ASLEEP - a card with no process behind it. That is a real
   * state a pane can be BORN in (a restore, see `shared/restoreTurn.ts`), not only one it
   * is put into, so every sweep that walks the live panes has to expect it.
   */
  proc: pty.IPty | null
  buffer: OutBuffer
  req: StartSessionRequest
  cols: number
  rows: number
  /** the size the DESK window last fitted this pane to - see `resize` */
  deskCols: number
  deskRows: number
  /**
   * The program this pane was spawned as, and what `shared/paneJob.ts` last saw running
   * in front of it. Only a SHELL pane ever has a job: an agent CLI's turn is tracked by
   * its own footer, which knows things a foreground reading cannot.
   */
  runner: string
  jobName: string | null
  /** the last few things asked at this pane, for `repeatedTopic` - see `topicFor` */
  topicAsks?: string[]
  /** a phone is holding the pty at its own shape, and owes the desk its size back */
  borrowed?: boolean
  /**
   * Every screen currently borrowing this pane, keyed by who it is, and the grid each one
   * asked for. `borrowed` above is now "this map is not empty".
   *
   * A map rather than one set of numbers because a pane is routinely drawn by more than
   * one viewer at once - a phone and a mirror, or two paired devices - and last-writer-wins
   * makes those viewers fight over the pty for as long as they are both open. See
   * `shared/paneSize.ts`.
   */
  borrows?: Map<string, Borrow>
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
   * The handle the last ask pointed at its subject with (`$50 task`), while the card is
   * still waiting for the reply to say what that is. Unset once named, or when an ask
   * names its subject outright. `shared/resolvedName.ts`.
   */
  handle?: string
  /** How much of the screen had been painted when that ask went in: the reply starts there. */
  handleSeen: number
  /**
   * When the question now on this pane's screen was first seen, and what it was.
   *
   * The signature carries where the arrow is (`askSignature`), so a person arrowing at
   * the desk restarts the clock rather than having the answer pressed out from under
   * them mid-move. Zero means there is no question.
   */
  askSince: number
  askHold: number
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
  /**
   * The SAME keystrokes, read a second way - see `slashTurn.isBareReturn`.
   *
   * `typed` is deliberately blind to a paste and to a history recall, so it cannot tell
   * an empty composer from one holding a pasted prompt. This one can, and that is the
   * only question it is asked: did this Enter send anything at all.
   */
  submitLine: DraftState
  /**
   * The SAME keystrokes a third time, and this one keeps everything: paste decoded, no
   * cap worth hitting. The rail's prompt tags are built from keystrokes in the RENDERER,
   * which means a prompt this app typed (an autoclear's resume, `pf open --prompt`) or a
   * phone typed never got one - "there was a prompt but no tag to scroll to it". Main is
   * the one place every byte into the pty passes, so the line is rebuilt here too and
   * handed to the window as `typed` when it did not come from the window itself.
   */
  draft: DraftState
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

/**
 * Who typed the bytes. `desk` is this machine's window, which tags its own prompts;
 * `app` is this process (`queuePrompt`); `phone` is a browser client over `phone.ts`.
 */
export type WriteOrigin = 'desk' | 'app' | 'phone'

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Live>()
  /**
   * Windows only: what each shell pane's pty had running at the last table read.
   * Empty on POSIX, where the tty answers the same question for free.
   */
  private tableJobs = new Map<string, { name: string; elapsed?: number }>()
  /** One armed /clear per pane, cleared by every path that stands one down. */
  private autoClearTimers = new Map<string, NodeJS.Timeout>()
  /**
   * The wait in FRONT of a countdown, one per pane. Separate from `autoClearTimers`, which
   * is the countdown itself: this one has not drawn anything yet and cancelling a countdown
   * must not cancel it, nor the other way round.
   */
  private autoClearArmTimers = new Map<string, NodeJS.Timeout>()
  /**
   * Asks that arrived while the pane was mid-turn, waiting for it to go quiet.
   *
   * This is the whole reason autoclear never fired. The Stop hook runs INSIDE the turn it
   * is ending, so at the moment it asks, the pane is still `working` by definition - and
   * `armAutoClear` refused every such ask outright. `~/.claude/autoclear.log` shows the
   * pattern exactly: every `clear` decision followed within the same second by
   * "no countdown: the pane started another turn", six of seven arms on 2026-08-24, and
   * the session then grew until Robert asked why it had never cleared. A busy pane is a
   * reason to WAIT, not to refuse: the countdown starts the moment the turn ends.
   */
  private autoClearPending = new Map<string, AutoClearArm>()
  private tableJobsBusy = false
  private seq = 0
  /** The app is quitting: no more IPC, no more idle sweeps, teardown runs once. */
  private down = false
  /** pane id -> when its cwd was last checked for existence. See `markCwdGone`. */
  private cwdCheckedAt = new Map<string, number>()

  constructor() {
    super()
    // Single timer for all sessions: flipping working -> idle per session with its
    // own timer would mean N timers doing the same 1s tick.
    setInterval(() => this.sweepIdle(), 1000).unref()
    // Windows only, and it stops itself when no shell pane is open. See `sweepWinJobs`.
    setInterval(() => this.sweepTableJobs(), TABLE_JOB_MS).unref()
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
      .map(([id, s]) => ({ id, pid: s.proc?.pid ?? 0 }))
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
      // A SLEEPING pane is `exited` too and is not an ended run - it is a card somebody
      // is deliberately keeping, so it comes back, and it comes back ASLEEP: `start()`
      // takes `asleep` and makes the card without the pty. Waking one that was put to
      // sleep on purpose would undo the press that saved the memory.
      .filter((s) => s.meta.status !== 'exited' || Boolean(s.meta.asleep))
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
        // Put to sleep on purpose, so it comes back that way.
        asleep: Boolean(s.meta.asleep),
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
    if (!req.cwd) throw new Error('Folder not specified')
    // Before anything reads the folder: a lane the sweep reclaimed while this pane was
    // closed is still the pane's remembered cwd, and a CLI spawned into a folder that is
    // not there loses every hook to `posix_spawn '/bin/sh'` ENOENT. See ensureLaneFolder.
    ensureLaneFolder(req.cwd)
    if (!existsSync(req.cwd)) {
      const base = req.cwd.replace(/-(w\d+|[a-z])$/, '')
      if (base && base !== req.cwd && existsSync(base)) {
        req.cwd = base
      } else {
        throw new Error(`Folder not found: ${req.cwd}`)
      }
    }
    // Coerce, because this request crosses IPC, the phone server, the device link and
    // `pf-ctl call`: a caller handing over the whole AgentInfo instead of its id typechecks
    // nowhere and arrives anyway, and the object then reaches history and the renderer.
    const asked = req.agent as unknown
    const agent: Agent = (typeof asked === 'string'
      ? asked
      : ((asked as { id?: string } | null)?.id ?? 'claude')) as Agent
    // Before the CLI is spawned, not after: it reads .claude.json at startup and would
    // already be sitting on the trust prompt by the time anything here could help.
    // Refuse a name this machine does not know rather than quietly running Claude Code -
    // see `hasAgent`. A remote start crosses the device link as a bare id, so this is the
    // only place that can tell the difference between "no agent asked for" and "an agent
    // this build has never heard of".
    if (!hasAgent(allAgents(getConfig().customAgents), agent))
      throw new Error(
        `This machine has no agent called "${agent}" - it may be running an older PaneForge, or the agent was removed.`
      )
    if (agent === 'claude') ensureTrusted(req.cwd)
    // Before the pty exists, because there is no taking it back afterwards: an agent
    // pointed at another provider posts every file it opens to that provider, and this
    // is the only moment the folder can still be refused.
    const trust = allowsCwd(specFor(agent), req.cwd, getConfig().paneTrust, homedir())
    if (!trust.ok) throw new Error(trust.reason)
    const id = `s${++this.seq}-${Date.now().toString(36)}`
    const clock = restoredClock(req, Date.now())

    const meta: Session = {
      id,
      // The PROJECT, never the folder: a pane opened in the `PaneForge-a` worktree is
      // still working on PaneForge, and the `-a` is a slot id this app invented. The
      // copy is already said by the chip beside the name (`copy 2`), so the folder
      // spelling here was the machinery leaking onto the card twice.
      title: req.title ?? projectOf(req.cwd, req.lane),
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
      cols: START_COLS,
      rows: START_ROWS
    }
    // A pane the restore is bringing back with no agent in it. The card, its place and
    // its screen are all built below exactly as an awake pane's are; the only difference
    // is that nothing is spawned and nothing is attached to. `status` goes to `exited`
    // beside `asleep` for the same reason `sleep()` does it: every guard in this app that
    // asks whether a pane has a live process already reads that word.
    const born = Boolean(req.asleep)
    if (born) {
      meta.status = 'exited'
      meta.asleep = Date.now()
    }
    const live: Live = {
      meta,
      proc: born ? null : this.spawn(req, agent, START_COLS, START_ROWS, id),
      buffer: new OutBuffer(BUFFER_LIMIT),
      req,
      cols: START_COLS,
      rows: START_ROWS,
      deskCols: START_COLS,
      deskRows: START_ROWS,
      runner: specFor(agent).bin,
      jobName: null,
      busyUntil: 0,
      ackedAt: 0,
      repaintUntil: 0,
      turnPending: false,
      footerEndedAt: 0,
      sawFooter: false,
      recoverSeen: 0,
      handleSeen: 0,
      recoverTries: 0,
      askSince: 0,
      askHold: 0,
      askSig: '',
      askKey: '',
      autoRun: 0,
      autoKey: '',
      autoAt: 0,
      lastTail: '',
      typed: '',
      submitLine: newSubmitLine(),
      draft: newDraft(),
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
      // ...and into THIS session's own log, because the next desk will name this id, not
      // the one it was read from (`scrollbackId: s.meta.id` in `snapshot`). A pane that
      // came back asleep prints nothing, so its log held only the marks, and the restart
      // after that one replayed an empty file: measured 2026-09-02, pane 2's log 1,222
      // bytes with a 2.3 MB predecessor on disk. Robert: "cant scroll up session 2 and
      // see the history of it". Bounded by `BUFFER_LIMIT`, the same cap `tail` reads.
      recordData(id, back.text)
      if (back.cols > 0) noteCols(id, back.cols)
    }
    this.sessions.set(id, live)
    if (born) {
      // Nothing to attach to, nothing to type at, and no run to record - `wake()` does
      // all three the moment somebody presses the chip. The gist is still read, because
      // the card has to be able to say what this pane was doing before it is woken.
      meta.gist = gistFor(id)
      this.emitSessions()
      return meta
    }
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
    // A pane opened straight into a lane worktree this app did not create carries no
    // lane, so every strip that names it printed the folder - `taskdriver.ai-c` where
    // the answer is `taskdriver.ai lane c`. The branch is the proof and it is one git
    // read, async because a blocked main process is the Windows busy cursor. It cannot
    // be done in `place.ts`: half the callers draw the strip with no branch in hand.
    this.stampLane(id)

    // ...and WHO this pane is for, when the folder proves it. A title the caller supplied
    // is a person's answer to the same question and is never argued with.
    if (!req.title) this.nameForClient(id, 'folder')

    this.emitSessions()
    return meta
  }

  /**
   * Name a pane for the client it is working for, and say so.
   *
   * One client per pane is how this desk is actually driven, and until now the pane knew
   * it and could not say it: every card in a client tree is called `clients`, so the only
   * thing separating seven of them is which chat you remember opening. The identity is
   * already on disk (the folder) or already typed (the first prompt); this writes it down.
   *
   * The rename happens and THEN reports, rather than asking first, for the reason every
   * other automatic thing in this app is arranged that way: a card in the corner of a
   * window that is usually behind something else is not a question anybody answers. So
   * the automatic direction is the one that is right nearly always, and `was` is carried
   * out with the event so Cancel is a real undo rather than "type the old name again".
   *
   * Every refusal is in `shared/clientName.ts`, and they are the feature: a pane renamed
   * to the WRONG client is a card that lies while somebody works off it, which is a worse
   * outcome than the folder name it replaced.
   */
  private nameForClient(id: string, from: 'folder' | 'prompt', text?: string): void {
    const live = this.sessions.get(id)
    if (!live) return
    const s = live.meta
    if (s.clientOff) return
    // Only a pane still wearing the name the APP gave it, with one exception: a subject
    // read out of the first prompt is a guess, and a client identified afterwards is
    // evidence, so evidence is allowed to replace the guess. Nothing replaces a client,
    // and nothing at all replaces a name a person typed.
    const untitled = mayRename(s.title, s.cwd)
    const upgradable = s.autoTitled === 'topic'
    if (!untitled && !upgradable) return

    const found =
      from === 'folder' ? clientForCwd(s.cwd) : text ? clientForText(s.cwd, text) : undefined
    if (found && found.slug === s.clientSlug) return
    // A pane in a client tree doing something else entirely is still a pane nobody can
    // tell apart, so it gets the subject of what was asked instead. Never on the folder
    // reading, which has no words to read.
    // A subject is only ever written over the word `clients`: see `mayTopicName`.
    // Outside a client roster the folder name is already true, so a subject may only
    // replace it once the desk has asked about the same thing three times: see
    // `repeatedTopic`. Inside the tree every card says `clients` and nothing tells them
    // apart, so the first ask still names them.
    const topic: TopicReading =
      !found && from === 'prompt' && text
        ? this.topicFor(live, text)
        : { title: '', strong: false }
    // An ask that points at its subject rather than naming it (`$50 task from
    // yesterday`) is a question the reply answers; the sweep reads the answer off the
    // screen and names the card for it. Remembered only while no client is found and
    // the card still wears an app-given name - the same gate as every rename here.
    if (!found && from === 'prompt' && text) {
      const handle = handleOf(text)
      live.handle = handle || undefined
      live.handleSeen = handle ? strip(live.buffer.read()).length : 0
    }
    // ...and a subject already on the card may be replaced by a BETTER one. The first
    // few asks in a repo are usually an errand ("what did we ship yesterday") and the
    // card then wears that errand through the job that follows it, which is the name
    // Robert kept looking at after a `/clear`. Only a STRONG reading may do it - three
    // of the last four asks agreeing - so one sentence cannot re-name a pane, and a
    // title a person typed is still never touched.
    if (!found && !untitled && !(upgradable && topic.strong)) return
    const title = found ? clientTitle(found) : topic.title
    if (!title || title === s.title) return
    const was = s.title
    s.title = title
    s.clientSlug = found?.slug
    s.autoTitled = found ? 'client' : 'topic'
    this.emit('clientNamed', {
      id,
      slug: found?.slug ?? '',
      title,
      was,
      from: found ? from : 'topic'
    } satisfies ClientNamed)
    this.emitSessions()
  }

  /**
   * The subject this pane may be named for, given what has been asked of it.
   *
   * The asks are kept here rather than read back out of the transcript because they are
   * already passing through this process on their way to the pty - the same feed the
   * prompt archive and the rail run off - so remembering four of them costs nothing and
   * needs no CLI to cooperate.
   */
  private topicFor(live: Live, text: string): TopicReading {
    const asks = (live.topicAsks ??= [])
    asks.push(text)
    if (asks.length > TOPIC_WINDOW) asks.splice(0, asks.length - TOPIC_WINDOW)
    return topicReading(live.meta.cwd, asks, text)
  }

  /** Cancel on the card: put the name back, and stop reading this pane for a client. */
  undoClientName(id: string): void {
    const live = this.sessions.get(id)
    if (!live) return
    live.meta.clientOff = true
    live.meta.clientSlug = undefined
    live.meta.title = projectOf(live.meta.cwd, live.meta.lane)
    this.emitSessions()
  }

  /**
   * Fill in a pane's lane from the branch its folder is on, when nothing else knew.
   *
   * Only ever ADDS one: a lane this app handed out is already right, and a folder whose
   * branch does not name a lane is left alone rather than guessed at (`laneOfCheckout`).
   * The stamp lands on `meta`, so it goes out with the next session list and survives a
   * restart through `snapshot()`.
   */
  private stampLane(id: string): void {
    const live = this.sessions.get(id)
    if (!live || live.meta.lane) return
    const cwd = live.meta.cwd
    execFile('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 4000 }, (err, out) => {
      if (err) return
      const lane = laneOfCheckout(cwd, String(out))
      const now = this.sessions.get(id)
      if (!lane || !now || now.meta.lane) return
      now.meta.lane = lane
      now.req = { ...now.req, lane }
      // The title was written before the lane was known, so a pane opened straight into
      // a worktree this app did not create was called `PaneForge-a`. Only a title that
      // is still the bare folder name is rewritten - a typed name or a client name is
      // somebody's answer and is never argued with.
      if (now.meta.title === folderName(cwd)) now.meta.title = projectOf(cwd, lane)
      this.emitSessions()
    })
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
      live.proc?.kill()
    } catch {
      /* already dead */
    }
    // A sleeping pane can be restarted rather than woken - it is an `exited` pane and the
    // menu offers both. Restarting is the louder of the two (a full RESET below), so the
    // sleep ends here as well, and the request stops asking to arrive asleep.
    live.meta.asleep = undefined
    live.req = { ...live.req, asleep: undefined }
    recordEnd(id, resumeIdFor(id))
    // A restart is a new conversation unless the CLI is being asked to resume one, and
    // either way the pane is writing a different file from here.
    noteSession(
      id,
      live.meta.cwd,
      live.meta.agent,
      live.req.resume ? live.req.resumeId : undefined
    )
    live.proc = this.spawn(live.req, live.meta.agent, live.cols, live.rows, live.meta.id)
    live.runner = specFor(live.meta.agent).bin
    live.jobName = null
    live.meta.job = undefined
    live.buffer.set(RESET)
    live.meta.status = 'starting'
    live.meta.printed = undefined
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
   * End this pane's agent and keep its card.
   *
   * The pane keeps its id, its place in the sidebar and its terminal, so the renderer
   * never unmounts the xterm and what is on screen stays on screen - which is why this
   * writes no RESET and replays nothing. `shared/sleep.ts` holds the refusals and the
   * reasoning; the one this side cannot make is a background job an agent left running,
   * which is a reading of the process table that lives on the usage sample, so the menu
   * refuses that one before it ever gets here.
   *
   * `status` goes to `exited` alongside `asleep` on purpose: every guard in this app that
   * asks whether a pane has a live process already reads that word.
   */
  sleep(id: string): Session | null {
    const live = this.sessions.get(id)
    if (!live) return null
    if (
      !canSleep({
        status: live.meta.status,
        asleep: live.meta.asleep,
        busy: Boolean(live.meta.runSince) || live.busyUntil > Date.now(),
        asking: Boolean(live.meta.ask),
        job: live.meta.job
      })
    )
      return null
    // Before the pty dies, while its pid still names a group and a tree - the same order
    // `kill()` uses, and for the same reason: what the pane started detached is reachable
    // from neither afterwards.
    if (live.proc) killPaneStrays(id, live.proc.pid)
    try {
      live.proc?.kill()
    } catch {
      /* already dead */
    }
    stopPipe(id)
    live.meta.piping = undefined
    recordEnd(id, resumeIdFor(id))
    // What waking spawns from. The conversation it was in is read NOW, while the
    // transcript still names this session - and the launch prompt is dropped, or waking
    // would re-run the work the pane was opened to do.
    live.req = { ...live.req, resume: true, resumeId: resumeIdFor(id), prompt: undefined }
    this.endRun(live)
    live.jobName = null
    live.meta.job = undefined
    live.meta.status = 'exited'
    live.meta.asleep = Date.now()
    live.meta.attention = false
    live.meta.bell = false
    live.meta.stalledSince = undefined
    live.stallRaised = false
    this.emit('data', id, SLEEP_MARK)
    live.buffer.push(SLEEP_MARK)
    this.emitSessions()
    return live.meta
  }

  /**
   * Start a sleeping pane's agent again, in the conversation it was in.
   *
   * Deliberately not `restart()`, which writes a full terminal reset: the screen this
   * pane went to sleep with is the screen it must wake with, and it is still in the
   * renderer's own xterm buffer. Nothing is replayed, so there is no width to get wrong.
   */
  wake(id: string): Session | null {
    const live = this.sessions.get(id)
    if (!live || !live.meta.asleep) return null
    noteSession(id, live.meta.cwd, live.meta.agent, live.req.resume ? live.req.resumeId : undefined)
    // Cleared before anything else reads the request: it is what made this pane arrive
    // asleep, and a later restart of a pane somebody has woken must not send it back.
    live.req = { ...live.req, asleep: undefined }
    live.proc = this.spawn(live.req, live.meta.agent, live.cols, live.rows, live.meta.id)
    live.runner = specFor(live.meta.agent).bin
    live.meta.asleep = undefined
    live.meta.status = 'starting'
    live.meta.printed = undefined
    live.meta.exitCode = undefined
    live.meta.engaged = false
    live.busyUntil = 0
    live.ackedAt = 0
    live.turnPending = false
    live.footerEndedAt = 0
    live.sawFooter = false
    live.meta.runSince = undefined
    // NOT createdAt: that is the age of this process and three timers read it as one.
    // `openedAt` is the pane's own age and a sleep does not interrupt it.
    live.meta.createdAt = Date.now()
    live.meta.lastOutput = Date.now()
    live.meta.lastKeyboard = Date.now()
    live.repaintUntil = 0
    this.emit('data', id, WAKE_MARK)
    live.buffer.push(WAKE_MARK)
    this.attach(live)
    recordStart(live.meta)
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

  write(id: string, data: string, origin: WriteOrigin = 'desk'): void {
    const live = this.sessions.get(id)
    if (!live || !live.proc) return
    live.proc.write(data)
    // Rebuild the line being typed, before the isTyping gate: a lone backspace is not
    // "typing" to the gate below, but it still has to erase from this record.
    live.typed = typeLine(live.typed, data)
    live.submitLine = feedSubmitLine(live.submitLine, data)
    // The whole line, for the rail. The window builds its own tags from the keystrokes it
    // relays, so a line that came FROM the window is already tagged there; only a line
    // typed by this app or by a phone needs telling. `Live.draft` says why.
    const whole = feedDraft(live.draft, data)
    live.draft = whole.state
    if (origin !== 'desk') {
      // The origin travels with the line. A person typed it on a phone or on a paired
      // machine; the APP typed `/clear` and an autoclear's resume text, and those must not
      // arm the keeper a second time or be archived as an ask somebody made.
      for (const line of whole.submitted)
        if (line.trim().length > 1) this.emit('typed', id, line, origin)
    }
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
    // Did this keystroke throw the conversation away? `/clear` is the one command that
    // puts a pane back to the state a brand new one is in - nothing has been asked of it
    // and there is nothing waiting to be read - which is the ONLY thing "Ready" is meant
    // to mean. Without this, `engaged` is sticky for the life of the session, so a pane
    // stayed in "Your move" for ever after its first turn and the Ready group only ever
    // held panes that happened never to have been typed into: "ready should only be
    // sessions after a /clear, not just randomly there". Read here rather than off the
    // screen for the reason the whole of `slashTurn.ts` is: the keystrokes look the same
    // for every CLI and the drawn composer does not.
    let cleared = false
    // A return pressed at an EMPTY composer sent nothing, so it asked nothing.
    //
    // This used to be indistinguishable from a real prompt and the cost was the one
    // thing "Ready" is for: Claude Code's completion menu takes the FIRST return of a
    // `/clear` (measured in a dev copy 2026-08-23 - the command is completed into the
    // box and stays there), so the return that actually runs it is a second keypress at
    // a composer this app has already emptied. That second one read as a fresh prompt:
    // `engaged` came straight back on and the pane a person had just cleared went to
    // Running and then sat under "Your move" for ever. Reported as "even after doing
    // /clear it moves the pane to running when it should've gone to ready".
    //
    // Every stray return has the same shape - answering nothing, waking a screensaver,
    // a phone's send button on an empty box - and none of them is work anybody is
    // waiting on.
    let bare = false
    // What was actually asked, kept before the composer is emptied a few lines down: the
    // client reading needs the words, and by the time the block ends they are gone.
    const asked = submitted ? live.typed : ''
    if (submitted) {
      live.meta.lastKeyboard = Date.now()
      const slash = isSlashCommand(live.typed)
      cleared = slash && clearsConversation(live.typed)
      bare = !slash && isBareReturn(live.submitLine)
      // A7: how often a person had to step in. Counted here because this is the one place
      // that knows all four readings at once - who did it, whether anything was sent,
      // whether the pane was holding a question, and whether a turn was running.
      // `shared/interventions.ts` decides; an `app` write never counts.
      live.meta.interventions = countIntervention(
        { hand: origin, submitted: true, bare, asking: Boolean(live.meta.ask), running: Boolean(live.meta.runSince) },
        live.meta.interventions ?? 0,
        { id, project: basename(live.meta.cwd || '') }
      )
      live.submitLine = newSubmitLine()
      // `/clear` and `/resume` are the two ways a pane changes which conversation it is
      // in without restarting. The pane keeps its transcript until told otherwise (a
      // second pane on the same repo must not be able to drift onto it), so this is
      // where being told happens.
      if (slash && /^\s*\/(clear|resume)\b/.test(live.typed)) {
        noteSession(id, live.meta.cwd, live.meta.agent)
      }
      const quiet = slash && isQuietSlash(live.typed)
      live.typed = ''
      // A bare return starts no turn. If it turns out to have answered a chooser the
      // agent's own busy footer starts one a moment later, which is the same path a
      // turn this app never saw typed has always come in on.
      if (!bare) this.beginRun(live)
      // A slash command still gets the run clock (the readout should say how long
      // /compact took) but not the bell: turnPending stays down unless the run turns
      // out to be real work - see SLASH_TURN_MS where the footer ends.
      live.slashAt = slash ? Date.now() : 0
      // ...except for the ones that finish with nothing to read, which are never
      // promoted however long they run. A real prompt sets this back to 0, so typing a
      // question straight after a /clear arms the bell again immediately.
      live.slashQuietUntil = quiet ? Date.now() + QUIET_SLASH_MS : 0
      if (slash) live.turnPending = false
      // A slash command is a command to the CLI, not a sentence about the work, so it
      // never names anybody. A bare return said nothing at all.
      if (!slash && !bare) this.nameForClient(id, 'prompt', asked)
    }
    // Typing into a pane is both "I have asked it something" (so its next quiet
    // moment is a real end-of-turn) and "I have seen it" (so drop any nag). A bare
    // return is only the second of those: somebody is at the pane, and nothing was
    // asked of the agent.
    let touched = false
    if (live.meta.attention) {
      live.meta.attention = false
      touched = true
    }
    if (!bare && !live.meta.engaged) {
      live.meta.engaged = true
      touched = true
    }
    if (touched || submitted) this.emitSessions()
    // ...and a `/clear` un-asks it, AFTER the rule above has treated the keystroke as
    // engagement: the two are both true of the same keypress and this is the one that
    // survives it. The run clock still counts the clear itself (the pane reads Running
    // while its hooks flap), and the pane falls into Ready the moment that ends.
    // A `/clear` ends the job the pane was named for, so the asks that earned that name
    // stop counting towards the next one: the card keeps what it has - flickering back to
    // the folder name would be a worse reading, not a truer one - until three fresh asks
    // agree on something else.
    if (cleared) live.topicAsks = []
    if (cleared && live.meta.engaged) {
      live.meta.engaged = false
      live.meta.attention = false
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
    // The bell belongs to the turn that rang it. Nothing clears it but a person looking at
    // the pane, so one left unacknowledged used to follow the pane into its next turn and
    // claim a running agent was waiting on an answer. Only on a genuinely NEW turn - the
    // idempotent path above has already returned, so a bell rung mid-turn survives.
    live.meta.bell = false
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
    // The pane just went quiet, which is the moment a deferred ask has been waiting for.
    this.resumePendingAutoClear(live.meta.id)
    return true
  }

  /**
   * Close a pane that was opened to do one thing, once it has done it - and say so.
   *
   * The reading is the sweep's rather than the turn ending, because the expensive failure
   * is closing a pane with work still in it: an agent that started a build in the
   * background goes quiet the moment its turn ends (`shared/paneBackJobs.ts`), and that
   * answer comes off a process table sampled every four seconds. So this asks for the
   * whole set - printed at least once, out of its turn, no question, nothing running by
   * either reading - and then for `CLOSE_DONE_QUIET_MS` of quiet on top.
   *
   * The opener is told through `queuePrompt`, which waits for an idle composer, so the
   * line lands between that pane's own turns instead of inside one. It is sent BEFORE the
   * kill: `kill()` deletes this session, and with it the request that names who to tell.
   */
  private sweepCloseWhenDone(live: Live, now: number, quiet: number): void {
    const { meta } = live
    if (!doneEnough({ ...meta, busyUntil: live.busyUntil }, quiet, now)) return
    const told = live.req.reportTo
    if (told) {
      const opener = this.sessions.get(told) ?? [...this.sessions.values()].find((l) => l.meta.title === told)
      if (opener && opener.meta.id !== meta.id)
        this.queuePrompt(
          opener.meta.id,
          `The pane you opened for "${meta.title}" (${meta.cwd}) has finished and closed itself.`
        )
    }
    console.info(`close-when-done: ${meta.id} finished and closed itself${told ? ` - told ${told}` : ''}`)
    this.kill(meta.id)
  }

  /** Start a countdown that was queued while the pane was mid-turn. */
  private resumePendingAutoClear(id: string): void {
    const ask = this.autoClearPending.get(id)
    if (!ask) return
    this.autoClearPending.delete(id)
    const res = this.armAutoClear(id, ask)
    console.info(
      res.ok
        ? `autoclear: ${id} countdown started - the turn ended (${ask.seconds}s)`
        : `autoclear: ${id} dropped after the turn - ${res.reason}`,
    )
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
  resize(
    id: string,
    cols: number,
    rows: number,
    borrowed = false,
    viewer = 'guest',
    /**
     * false RE-APPLIES a borrow without recording it against anybody.
     *
     * `smallestBorrow` mins each axis SEPARATELY, so the grid it returns is regularly one
     * no single viewer asked for - and recording it under a name is then a lie about what
     * that screen wants. `returnSize` used to hand the surviving `[0]` key those numbers,
     * which overwrote a real request with somebody else's and left every later smallest
     * calculation reading from a corrupted entry. Invisible with two borrowers, because
     * the survivor IS the smallest; permanent with three.
     */
    record = true
  ): void {
    const s = this.sessions.get(id)
    // An ASLEEP pane is not a dead one, and this guard could not tell them apart.
    //
    // A sleeping pane wears `status: 'exited'` on purpose (see `sleep()`), so every resize
    // for one was dropped here: `s.cols` stayed at whatever it was spawned with, `meta.cols`
    // never moved, and `wake()` then spawned the CLI at THAT grid - into a terminal the
    // renderer had long since fitted to its own box. Everything an agent prints is absolute
    // column moves and a terminal clamps a column it cannot reach, so the woken CLI painted
    // one word over the last down the right-hand edge. That is the reported screen after an
    // update restart, and it is the common case rather than a corner: `restoreAsleep` brings
    // most of a restored desk back asleep, which is the launch every update gets.
    //
    // Measured 2026-08-29 with `npm run boot-timing --panes 8`: 4 of 7 restored panes ended
    // with the terminal at 26x17 and the pty still recorded at 120x30 (`START_COLS`).
    //
    // A pane with no pty has nothing to resize, and `s.proc?.resize` below is already
    // null-safe - so all this does is let the size be RECORDED, which is the half that was
    // missing. A genuinely dead pane still records nothing.
    if (!s || (s.meta.status === 'exited' && !s.meta.asleep)) return
    // Several screens may be borrowing this pane at once, so a borrow is RECORDED against
    // whoever asked and the pty is then set to the one grid they can all draw - never to
    // the last number that arrived. Without this two viewers flip the pty between their
    // two windows for as long as both are open. See `shared/paneSize.ts`.
    if (borrowed) {
      const borrows = s.borrows ?? (s.borrows = new Map())
      // A borrow whose screen stopped ticking is not a borrow any more - see `at` in
      // shared/paneSize.ts. Swept on the read path as well as on the tick, or a pane
      // nobody is drawing keeps a dead phone's grid until somebody else resizes it.
      dropStale(borrows, Date.now())
      if (record)
        borrows.set(viewer, {
          cols: Math.max(cols, 20),
          rows: Math.max(rows, 5),
          // A screen on the far side of the link has no tick of ours to renew with, so it
          // holds no lease and lets go when the connection does. See `at` in paneSize.ts.
          at: viewer.startsWith('guest') ? 0 : Date.now()
        })
      const all = smallestBorrow(borrows.values())
      if (all) {
        cols = all.cols
        rows = all.rows
      }
      // Nothing to do when the pty is already at that grid: a mirror re-states its size on
      // every repaint, and obeying each one costs the CLI a full redraw for no change.
      if (s.cols === cols && s.rows === rows && s.borrowed) return
    }
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
      // ...unless every screen holding it has gone quiet. A stuck borrow used to be
      // unrecoverable BY CONSTRUCTION: this branch swallows every desk resize while
      // `borrowed` is set, so the one repair anybody would reach for - drag the window -
      // could never work, and the pane stayed at phone width until the app was restarted.
      // Measured on the live desk 2026-08-25: s24-mt81jexv, 72x33 with clients:0, and a
      // `pty:return` for every viewer name it could have been filed under changed nothing.
      this.sweepBorrows()
      if (!s.borrowed) return this.resize(id, cols, rows, false, viewer, record)
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
      // A desk resize takes ownership back from EVERY borrower, or the next repaint from
      // a viewer that is still attached re-applies the old minimum on top of it.
      s.borrowed = false
      s.borrows?.clear()
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
      s.proc?.resize(s.cols, s.rows)
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
  /**
   * One pane's size back, for the borrower that can name it.
   *
   * `returnSizes()` is the phone's shape of this - a phone stops looking and every
   * borrow ends at once. A mirrored pane is per-pane: another device may be watching
   * three of this desk's panes and stop watching one, and returning the other two with
   * it would snap two panes somebody is still looking at.
   */
  returnSize(id: string, viewer?: string): void {
    const s = this.sessions.get(id)
    if (!s || !s.borrowed) return
    // One viewer looking away is not every viewer looking away. Drop that one's borrow and,
    // if anybody is still watching, re-apply the smallest of what is left - the pane goes
    // back to the desk only when the last screen has let go.
    if (viewer !== undefined && s.borrows?.size) {
      s.borrows.delete(viewer)
      const rest = smallestBorrow(s.borrows.values())
      if (rest) {
        // Applied, not recorded: nobody asked for this grid, it is the floor of what the
        // viewers still watching asked for. See `record` on resize().
        this.resize(id, rest.cols, rest.rows, true, '', false)
        return
      }
    }
    s.borrows?.clear()
    s.borrowed = false
    if (s.cols === s.deskCols && s.rows === s.deskRows) {
      if (s.meta.borrowed) {
        s.meta.borrowed = false
        this.emitSessions()
      }
      return
    }
    this.resize(id, s.deskCols, s.deskRows)
    this.redraw(id)
  }

  /**
   * A screen says it is still looking, so its borrows keep their lease - and every
   * borrow whose screen has gone quiet loses one.
   *
   * Fed by `pty:visible`, which every screen already re-states every 30s. That makes
   * "the phone let go" an expiry rather than an announcement, which is the only shape
   * that survives a handset that locked, backgrounded or walked out of range: those
   * never send `pty:return`, and the pane sat at phone width on the desk for ever.
   *
   * The sweep runs over EVERY pane, not only the ones named: the tick that renews one
   * screen's borrows is also the heartbeat that proves another screen's are dead.
   */
  touchBorrows(viewer: string, ids: string[]): void {
    const now = Date.now()
    const on = new Set(ids)
    for (const [id, s] of this.sessions) {
      const b = s.borrows?.get(viewer)
      if (b && on.has(id)) b.at = now
    }
    this.sweepBorrows(now)
  }

  /** Give back every pane whose borrowers have all stopped ticking. */
  sweepBorrows(now = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (!s.borrowed || !s.borrows) continue
      if (!dropStale(s.borrows, now)) continue
      const rest = smallestBorrow(s.borrows.values())
      // Somebody is still watching: fall back to the floor of what is left, exactly as
      // one viewer looking away does. Nobody left: the desk owns it again.
      if (rest) this.resize(id, rest.cols, rest.rows, true, '', false)
      else this.returnSize(id)
    }
  }

  returnSizes(viewer?: string): void {
    // With a viewer named this is just `returnSize` over every pane it is holding - the
    // phone's "I have looked away" now has to leave a mirror's borrow alone.
    if (viewer !== undefined) {
      for (const [id, s] of this.sessions) {
        if (s.borrows?.has(viewer)) this.returnSize(id, viewer)
      }
      return
    }
    for (const [id, s] of this.sessions) {
      if (!s.borrowed) continue
      s.borrows?.clear()
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
      s.proc?.resize(Math.max(20, s.cols - 1), s.rows)
      setTimeout(() => {
        try {
          if (this.sessions.get(id) === s) s.proc?.resize(s.cols, s.rows)
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
  choose(id: string, n: number, hand: WriteOrigin = 'desk'): boolean {
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
        // The hand travels with the keys. `autoAnswer` presses through this same method,
        // and a question the APP answered must not read as one a person answered - that
        // is the whole difference A7's number is made of.
        this.write(id, k, hand)
      }, i * CHOOSE_GAP_MS)
    )
    return true
  }

  /**
   * The renderer's read of whether the agent's own UI still says it is running. Panes
   * repeat it every second or so, so the deadline it sets expires by itself if the pane
   * goes away.
   */
  /**
   * When the idle clock is going to close this pane, as decided by the window.
   *
   * The decision lives in the renderer because that is where the two facts it needs live -
   * which pane has focus, and the config the sweep is already reading - so this is the
   * PUBLISHING half: it puts the deadline on the session, where the sidebar reads it and
   * where a paired device gets it for free with everything else about that pane.
   *
   * A viewer may not compute this for itself. The deadline is a fact about THIS machine's
   * settings and its own refusals, and a mirror drawing its own guess would count down on
   * a pane nobody is going to close. `sessions:closing` is refused for a mirrored id in
   * `index.ts` for exactly the reason `sessions:busy` is.
   */
  setClosingAt(id: string, at: number | null, kept = false): void {
    const s = this.sessions.get(id)
    if (!s) return
    const next = at && at > 0 ? at : undefined
    const heldOpen = next ? kept || undefined : undefined
    // Only when it MOVED: this arrives on every session change, and emitting a fresh list
    // in response to one would be a loop that never settles. Both halves, or a pane that
    // stops being held keeps the word `kept` on an ordinary idle countdown.
    if (s.meta.closingAt === next && s.meta.closeKept === heldOpen) return
    s.meta.closingAt = next
    s.meta.closeKept = heldOpen
    this.emitSessions()
  }

  setBusyOnScreen(id: string, busy: boolean, tail = '', clock?: TurnClock, reason?: BusyReason): void {
    const s = this.sessions.get(id)
    if (!s) return
    const now = Date.now()
    // Every FLIP of the pane's own busy reading, written down as it happens.
    //
    // "It printed while the card said Your move" has now been reported twice and chased
    // once with an instrument that cannot be read: `window.__paneBusy` lives in renderer
    // memory, and the app Robert actually runs has no debug port. The reading that
    // decides it arrives here and nowhere else, so this is the one place the evidence
    // can be on disk before anybody goes looking. The state recorded is the state the
    // flip is about to act on - a `false` landing on `engaged` with no `runSince` is the
    // exact shape of the report - and `tail` is the frame the pane judged, so a footer
    // sitting in it names the bug outright. One line per flip: a turn is two.
    if (busy !== (s.busyUntil > now)) {
      audit('busy-flip', {
        title: s.meta.title,
        agent: s.meta.agent,
        reads: busy,
        reason: reason ?? null,
        status: s.meta.status,
        engaged: Boolean(s.meta.engaged),
        runSince: s.meta.runSince ? now - s.meta.runSince : null,
        quietMs: now - s.meta.lastOutput,
        agentSaysMs: clock?.ms ?? null,
        tail: plainTail(tail || s.lastTail, 4)
      })
    }
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
  /**
   * Arm this pane's own /clear, `seconds` from now, and report it on the session.
   *
   * The typing goes through `write` in the SPLIT `clearChunks` gives, on the
   * `chunkDelayMs` schedule: a long chunk arriving in one pty read is a paste to Claude
   * Code and a CR inside a paste is a newline, and a submit CR arriving while the CLI is
   * still redrawing after /clear is swallowed outright - both left the resume prompt
   * sitting unsent in the box.
   */
  armAutoClear(id: string, ask: AutoClearArm): { ok: boolean; reason?: string } {
    const s = this.sessions.get(id)
    if (!s) return { ok: false, reason: 'no such pane' }
    const why = dropFor({ ...s.meta, typed: s.typed })
    // 'working' is deferred, everything else is still refused. A pane holding a question,
    // or one that has gone, cannot be cleared later either - but a pane mid-turn is the
    // NORMAL state when the Stop hook asks, and refusing it is what made this feature
    // dead on arrival.
    const decision = armDecision(why)
    if (decision === 'queue') {
      this.autoClearPending.set(id, ask)
      acLog(`${id} queued until this turn ends (${why})`)
      return { ok: true, reason: 'queued until this turn ends' }
    }
    if (decision === 'refuse') {
      acLog(`${id} refused: ${dropWords(why as DropReason)}`)
      return { ok: false, reason: dropWords(why as DropReason) }
    }
    // Idle, but only just. See `ARM_QUIET_MS`: the Stop hook that asks for this runs after
    // the reply is on screen and before the turn is really over, and a hook that BLOCKS
    // makes the model write another reply into the same pane. Rather than drawing a
    // countdown over that and requeueing it a second later, the arm waits out the
    // remainder and asks again - by which time `dropFor` sees the new turn and queues it
    // properly. Re-entering here is safe: a pane that stayed quiet arms on the second pass.
    const quiet = Date.now() - s.meta.lastOutput
    if (!quietEnoughToArm(quiet)) {
      const wait = Math.max(250, ARM_QUIET_MS - quiet)
      const prev = this.autoClearArmTimers.get(id)
      if (prev) clearTimeout(prev)
      acLog(`${id} holding ${wait}ms: the pane printed ${quiet}ms ago and may not be finished`)
      const t = setTimeout(() => {
        this.autoClearArmTimers.delete(id)
        this.armAutoClear(id, ask)
      }, wait)
      t.unref?.()
      this.autoClearArmTimers.set(id, t)
      return { ok: true, reason: 'waiting for the pane to settle' }
    }
    // The steps that reached here are a PHOTOGRAPH, and everything above this line is a
    // delay: the Stop hook decides inside the turn it ends, `armDecision` queues a mid-turn
    // pane into `autoClearPending`, and the quiet wait above re-enters minutes later. The
    // session works through all of it and routinely finishes the very steps this clear
    // exists to continue - measured 2026-08-30, `clear ... steps=3` armed a countdown 2.5
    // minutes after the session had done all three and rewritten its handoff to `None`.
    // So the file is re-read at the LAST moment, and the card lists what it says now.
    //
    // A `--no-resume` cost clear is exempt: it carries no steps by design. And only a
    // handoff that EXISTS may refuse - `path: null` is a pane that never wrote one, which
    // is not evidence the work is done.
    const plan = { ...ask }
    if (!plan.noResume) {
      const hand = handoffFor(s.meta.cwd, id)
      if (hand.path && hand.open === 0) {
        acLog(`${id} refused: ${NOTHING_OPEN} (${hand.path})`)
        return { ok: false, reason: NOTHING_OPEN }
      }
      if (hand.path && hand.steps.length) plan.steps = hand.steps
    }
    this.cancelAutoClear(id, 'cancelled')
    const at = Date.now() + plan.seconds * 1000
    s.meta.autoClearAt = at
    s.meta.autoClearPrompt = plan.prompt
    s.meta.autoClearSteps = plan.steps
    // Decided HERE, once, and typed verbatim when the timer fires. The command is the
    // CLI's own (`/new` in Codex), and a pane's agent cannot change under an armed
    // countdown, so there is nothing to gain from re-deriving it at the last moment - and
    // one thing to lose, which is the two copies of one contract this feature was buried
    // by the first time.
    s.meta.autoClearChunks = clearChunks(plan.prompt, plan.command ?? '/clear', plan.model ?? '')
    if (ask.noResume) s.meta.autoClearNoResume = true
    if (ask.tokens) s.meta.autoClearTokens = ask.tokens
    acLog(`${id} armed: fires at ${new Date(at).toISOString()} (${plan.seconds}s, ${JSON.stringify(s.meta.autoClearChunks[0])})`)
    // The timer body is a named function rather than an inline closure because it can now
    // re-arm ITSELF: an unsent line in the box makes the clear wait instead of standing
    // down, and waiting means another timer against a deadline that has moved on.
    const fire = (armedAt: number): void => {
      this.autoClearTimers.delete(id)
      const live = this.sessions.get(id)
      // Asked again at the last moment: the pane may have started a turn during the
      // countdown, and a snapshot taken when it was armed is not a licence to clear now.
      // 'working' is neither a fire nor a refusal - it goes back on the pending queue
      // below. (Refusing outright is what made a countdown everybody watched expire into
      // nothing: measured 2026-08-26 in ~/.claude/autoclear.log, 15 countdowns started,
      // 14 queued, nothing cleared - so the ask is KEPT either way.)
      // Every branch below is a named verdict and every one of them is LOGGED - the s2
      // incident could not be diagnosed because three of these exits were silent.
      const verdict = expiryDecision({
        exists: !!live,
        metaAt: live?.meta.autoClearAt,
        armedAt,
        now: Date.now(),
        drop: live ? dropFor({ ...live.meta, typed: live.typed }) : 'gone'
      })
      acLog(
        `${id} expiry: ${verdict} (armed ${armedAt}, meta ${live?.meta.autoClearAt ?? 'none'})`
      )
      if (verdict === 'vanished' || verdict === 'foreign') return
      // Held off, not stood down. The card stays up and keeps its button; only the moment
      // moves. The meta's deadline moves WITH it, or the toast freezes at 0:00 - which is
      // the exact shape of the s2 incident this file already carries a note about.
      if (verdict === 'wait') {
        const next = Date.now() + DRAFT_RETRY_MS
        live!.meta.autoClearAt = next
        acLog(`${id} waiting: ${dropWords('drafting')} - asking again at ${new Date(next).toISOString()}`)
        this.emitSessions()
        const again = setTimeout(() => fire(next), DRAFT_RETRY_MS)
        again.unref?.()
        this.autoClearTimers.set(id, again)
        return
      }
      if (verdict === 'stale') {
        // Meta left behind by an arm this timer no longer owns, with no live countdown
        // to clean it - exactly the state that froze the toast at 0:00. Clean it up.
        this.clearAutoClearMeta(live!)
        this.setAutoClearOutcome(id, 'stood down - the countdown was superseded')
        this.emitSessions()
        return
      }
      // A turn started under the countdown. Typing anyway put `/clear`, the resume prompt
      // and its submit into Claude Code's mid-turn queue, where the clear ran first and
      // took the other two with it: the pane was cleared and continued nothing (2026-08-28,
      // s11-mtck156b). Waiting for the turn is the arm path's own behaviour, so use it -
      // `cancelAutoClear` leaves a 'working' pending entry alone, and `endRun` re-arms.
      if (verdict === 'working') {
        this.autoClearPending.set(id, ask)
        this.cancelAutoClear(id, 'working')
        acLog(`${id} requeued at expiry - ${dropWords('working')}`)
        return
      }
      if (verdict !== 'fire') {
        this.cancelAutoClear(id, verdict)
        return
      }
      const chunks = live!.meta.autoClearChunks ?? clearChunks(live!.meta.autoClearPrompt ?? '')
      this.clearAutoClearMeta(live!)
      this.setAutoClearOutcome(id, 'cleared')
      this.emitSessions()
      // The keeper that pushes the screen into scrollback ahead of the CLI's clear is fed
      // by KEYSTROKES (`feedInput` in TerminalPane), and nothing here is a keystroke: this
      // writes straight to the pty, so the renderer never saw the `/clear` and never
      // armed. That left every automatic clear relying on the 80% screen-loss fallback,
      // which Claude Code's banner-over-the-turn clear does not trip - so the tail of the
      // conversation was gone. Tell the pane first, and give it a beat to file the rows
      // before the command lands.
      acLog(`${id} armclear emitted, ${ARM_CLEAR_LEAD_MS}ms before the clear`)
      this.emit('armclear', id)
      const clearCmd = chunks[0]
      const { switchCmd, resume } = resumeOf(chunks)
      const t = setTimeout(() => {
        if (!this.sessions.get(id)) return acLog(`${id} clear skipped: pane gone`)
        acLog(`${id} typing ${JSON.stringify(clearCmd)}`)
        this.write(id, clearCmd, 'app')
        // Everything after the clear goes through the machinery that already knows how to
        // put text into a CLI's composer: it waits for the composer to be IDLE rather than
        // guessing at a settle time, sends the return as its own write a beat later, and
        // re-sends only after READING the pane and finding it still idle.
        //
        // The blind schedule this replaces cost time on every clear and fired stray
        // returns into live sessions. Measured over the 16 clears in autoclear-app.log on
        // 2026-08-27/28: the prompt was typed at a fixed +2500ms, its submit at +3700ms,
        // and then two unconditional CRs went out at +6700ms and +11700ms - 28 retries
        // across 16 clears, both of them every time, including the fourteen where the
        // first submit had plainly landed. Nothing read the pane at any point.
        if (!resume) return acLog(`${id} cleared with no resume prompt`)
        acLog(`${id} resume prompt queued (idle-composer wait, start +${CLEAR_PROMPT_START_MS}ms, budget ${CLEAR_RESUME_BUDGET_MS}ms)`)
        // The window this feature kept losing. Between the `/clear` above and the resume
        // prompt going in, the pane looks like an ordinary fresh session - so somebody
        // reads it, types their own question, and the queued prompt lands inside THEIR
        // turn (2026-08-30, s4-mtednh9i). The prompt is now dropped when that happens,
        // which stops the collision but still costs the handoff. So the pane says out
        // loud that it is mid-handover and swallows keys until it is not, with a way out.
        this.setHandover(id, Date.now() + handoverMaxMs(CLEAR_RESUME_BUDGET_MS))
        const typeResume = (): void =>
          this.queuePrompt(id, resume, 0, switchCmd ? SUBMIT_GAP_MS : CLEAR_PROMPT_START_MS, () => this.setHandover(id, 0), CLEAR_RESUME_BUDGET_MS)
        if (!switchCmd) return typeResume()
        // The model switch first, through the same idle-composer wait, then a bare CR a
        // beat later: leaving Fable opens a confirm dialog that the Enter accepts, and on
        // an empty composer the Enter is a no-op. Only then the resume prompt. The switch
        // is proven by the composer coming back ('idle'), never by a turn - a slash
        // command starts none.
        acLog(`${id} model switch queued: ${JSON.stringify(switchCmd)}`)
        this.queuePrompt(id, switchCmd, 0, CLEAR_PROMPT_START_MS, () => {
          const c = setTimeout(() => {
            if (!this.sessions.get(id)) return acLog(`${id} model switch confirm skipped: pane gone`)
            this.write(id, '\r', 'app')
            typeResume()
          }, SUBMIT_GAP_MS)
          c.unref?.()
        }, CLEAR_RESUME_BUDGET_MS, 'idle')
      }, ARM_CLEAR_LEAD_MS)
      t.unref?.()
    }
    const timer = setTimeout(() => fire(at), plan.seconds * 1000)
    timer.unref?.()
    this.autoClearTimers.set(id, timer)
    this.emitSessions()
    return { ok: true }
  }

  /** Drop an armed countdown. Silent when there is none - every caller asks blind. */
  cancelAutoClear(id: string, why: DropReason): boolean {
    // Somebody using the pane means the whole idea is off, queue included. A 'working'
    // cancel is the internal re-queue above and must leave the pending ask alone.
    if (why !== 'working') this.autoClearPending.delete(id)
    // ...and the wait in FRONT of the countdown, or pressing Keep on a card is undone a
    // few seconds later by an arm nobody can see. A 'working' cancel is this class's own
    // re-queue and leaves it alone, exactly as it leaves the pending ask alone.
    if (why !== 'working') {
      const arming = this.autoClearArmTimers.get(id)
      if (arming) {
        clearTimeout(arming)
        this.autoClearArmTimers.delete(id)
      }
    }
    const s = this.sessions.get(id)
    const timer = this.autoClearTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.autoClearTimers.delete(id)
    }
    if (!s?.meta.autoClearAt) return false
    this.clearAutoClearMeta(s)
    console.info(`autoclear: ${id} stood down - ${dropWords(why)}`)
    acLog(`${id} stood down - ${dropWords(why)}`)
    this.setAutoClearOutcome(id, `stood down - ${dropWords(why)}`)
    this.emitSessions()
    return true
  }

  /** The six countdown fields, deleted together - the fire path and every drop share it. */
  private clearAutoClearMeta(s: { meta: Session }): void {
    delete s.meta.autoClearAt
    delete s.meta.autoClearPrompt
    delete s.meta.autoClearSteps
    delete s.meta.autoClearChunks
    delete s.meta.autoClearNoResume
    delete s.meta.autoClearTokens
  }

  /**
   * Say how the countdown ended, on the session, for ~5s.
   *
   * ADDENDUM 2026-08-27: a countdown that stood down used to vanish without a word, and
   * one that went wrong froze at 0:00 - either way nobody watching could tell what the
   * app decided. The toast draws this instead of silently disappearing.
   */
  private setAutoClearOutcome(id: string, text: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.meta.autoClearOutcome = text
    s.meta.autoClearOutcomeAt = Date.now()
    const t = setTimeout(() => {
      const cur = this.sessions.get(id)
      // A newer outcome owns the field now - never wipe somebody else's sentence.
      if (!cur || cur.meta.autoClearOutcome !== text) return
      delete cur.meta.autoClearOutcome
      delete cur.meta.autoClearOutcomeAt
      this.emitSessions()
    }, 6000)
    t.unref?.()
  }

  setHandingOff(id: string, on: boolean, queuedAt?: number | null): void {
    const s = this.sessions.get(id)
    if (!s) return
    const was = !!s.meta.handingOff
    const wasAt = s.meta.handoffQueuedAt
    if (on) s.meta.handingOff = true
    else delete s.meta.handingOff
    // A queued pane and one actually in transit are the same paint to `reclaim.ts` and two
    // different sentences to a person, so the moment it stops waiting and starts moving is
    // a change the card has to see.
    //
    // Three values, not two, and the third is the bug this had. `undefined` means LEAVE THE
    // STAMP ALONE; only an explicit `null` takes a waiting pane off its clock. Every entry
    // into a handoff paints the pane before it knows whether it will be sent or queued, so
    // an `undefined` that CLEARED meant a second press - or the budget sweep asking again -
    // silently turned `waiting 12m` into `moving` on a pane that was still only waiting for
    // its turn to end. Measured live 2026-08-23: `handingOff: true`, no `handoffQueuedAt`,
    // and `remote:handoffPending` listing that very pane. That is the whole of "I pressed
    // hand off, it says moving, and it is not moving".
    if (!on || queuedAt === null) delete s.meta.handoffQueuedAt
    else if (queuedAt) s.meta.handoffQueuedAt = queuedAt
    if (was === on && wasAt === s.meta.handoffQueuedAt) return
    this.emitSessions()
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    // Before the pty dies, while its pid still names a group and a tree. What the pane
    // started detached is not reachable from either, which is what strays.ts is for.
    if (s.proc) killPaneStrays(id, s.proc.pid)
    try {
      s.proc?.kill()
    } catch {
      /* already dead */
    }
    stopPipe(id)
    recordEnd(id, resumeIdFor(id))
    forgetSession(id)
    this.sessions.delete(id)
    forgetHandoff(id)
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
    endAll(ids, resumeIdFor)

    if (process.platform === 'win32') {
      const args = live
        .map((s) => s.proc?.pid ?? 0)
        .filter((pid) => typeof pid === 'number' && pid > 0)
        .flatMap((pid) => ['/PID', String(pid)])
      if (args.length) {
        // No taskkill on PATH - the pty kill below is still the real one. `spawnQuiet`
        // for the same reason as everywhere else: the failure this comment names is an
        // EVENT, and an unlistened one takes the main process down on the way out.
        spawnQuiet(
          'taskkill',
          ['/F', '/T', ...args],
          { detached: true, stdio: 'ignore', windowsHide: true },
          'shutdown taskkill'
        )
      }
    }
    // Still ask node-pty: it is what releases the ConPTY handles, and it is the only
    // path that works off Windows.
    for (const s of live) {
      try {
        s.proc?.kill()
      } catch {
        /* already dead */
      }
    }
  }

  private spawn(
    req: StartSessionRequest,
    agent: Agent,
    cols: number,
    rows: number,
    /** the pane this process IS, so anything it runs can name its own pane to `pf` */
    id?: string
  ): pty.IPty {
    // Spawn the agent binary directly (not through cmd.exe): one less process in the
    // tree, so killing the session actually kills the agent instead of orphaning it.
    // shell:true equivalents on Windows also swallow Ctrl-C.
    const spec = specFor(agent)
    // resume is per-CLI: `claude --continue` but `codex resume --last`, and some
    // agents have nothing at all - buildArgs drops the flag rather than guessing.
    const args = buildArgs(spec, { resume: req.resume, resumeId: req.resumeId, model: req.model })
    // Antigravity opens on `Yes, I trust this folder` in any folder it has not seen, and
    // a pane this app was asked to open is not a question anybody wants to answer twice.
    // No-op for every other agent and on a desk where that CLI is not installed.
    if (spec.id === 'antigravity') trustAgyWorkspace(req.cwd)
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
      env: {
        ...scrubForeignKeys(agentEnv(), spec),
        ...resolveEnv(spec, agentKeys()),
        // Which pane this is. `pf open --report-to` defaults to it, so an agent that opens
        // a pane for a sub-task is told when that pane is done without being able to name
        // itself any other way - nothing else in the environment says which card this is.
        ...(id ? { PF_PANE: id } : {}),
        // Where the Chrome this pane may drive is, when the pane was started for another
        // desk: browser work stops being a reason to keep a pane here. `shared/peerChrome.ts`.
        ...(chromeCdpFor(req.fromAddress) ? { PF_CHROME_CDP: chromeCdpFor(req.fromAddress)! } : {}),
        ...(req.laneEnv ?? {})
      }
    })
  }

  private attach(live: Live): void {
    const { meta } = live
    const id = meta.id
    const proc = live.proc
    // A pane with no process: `wake()` calls this again once there is one.
    if (!proc) return

    proc.onData((data) => {
      // A late event from the previous process of a restarted session would append
      // dead output into the fresh buffer.
      if (live.proc !== proc) return
      live.buffer.push(data)
      recordData(id, data)
      // A gate in the pane refusing a command is not output the pane produced and not
      // anything this app decided, but it costs the pane a whole round trip and nothing
      // on screen says it happened. Counted here, drawn once per stretch on the bell.
      feedHookDeny(id, data)
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
      // The first byte out of THIS process. A restored pane comes back with a full screen
      // of its own history, so nothing on screen says whether the CLI has started yet -
      // this is what the pane's "Starting…" line waits on. One extra broadcast per pane
      // per launch, at the one moment the answer changes.
      const firstByte = meta.printed === undefined
      if (firstByte) meta.printed = now
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
      // still only booting its CLI. A pane counts as working when a TURN is running, which
      // `outputIsWork` decides and `npm run test:fleet` pins - never merely because the session
      // has been typed into before (`engaged` is set by the first keystroke and never cleared,
      // so the echo of typing moved the card between Running and Your move). Anything else keeps
      // the status it had, so a fresh pane stays amber 'starting' and settles into 'idle'.
      if (outputIsWork({ ...meta, turnPending: live.turnPending, busyUntil: live.busyUntil, now }))
        meta.status = 'working'
      this.emit('data', id, data)
      if (firstByte || (wasIdle && meta.status === 'working')) this.emitSessions()
    })

    proc.onExit(({ exitCode }) => {
      if (live.proc !== proc) return
      meta.status = 'exited'
      // A pane put to sleep killed this process itself and has already said everything
      // below. Writing the kill's exit code onto it would put `exited 143` on a card
      // whose whole point is that nothing went wrong - see `sleep()`.
      if (meta.asleep) return
      meta.exitCode = exitCode
      // The pane has stopped talking for good: a tee left open would hold the file
      // handle for as long as the dead card sits in the list, and on Windows that is
      // enough to stop the watcher deleting or rotating it.
      stopPipe(id)
      meta.piping = undefined
      this.endRun(live)
      recordEnd(id, resumeIdFor(id))
      // A stretch of refusals that is still counting when the pane dies is written out
      // now: a row that never arrives because the pane closed first is the same as no
      // reading at all.
      endHookDeny(id)
      this.emitSessions()
    })
  }

  /**
   * Raise or drop the handover curtain on a pane, and tell the renderer.
   *
   * `until` is an absolute deadline rather than a boolean on purpose: the renderer takes
   * the curtain down by itself when the clock runs out, so a main process that dies, hangs
   * or forgets to settle cannot leave a pane nobody can type into. The app-side settle is
   * the fast path, not the safety.
   */
  private setHandover(id: string, until: number): void {
    const live = this.sessions.get(id)
    if (!live) return
    if ((live.meta.handoverUntil ?? 0) === until) return
    live.meta.handoverUntil = until || undefined
    this.emit('handover', id, until)
    this.emitSessions()
  }

  /**
   * A person taking the pane back mid-handover.
   *
   * Moving `lastKeyboard` is what actually cancels the queued resume prompt: `queuePrompt`
   * compares it against the mark it took when the prompt was queued, and anything later
   * reads as somebody owning the pane. Doing it this way rather than with a second flag
   * means the take-over and a real keystroke cannot disagree.
   */
  takeOver(id: string): boolean {
    const live = this.sessions.get(id)
    if (!live) return false
    live.meta.lastKeyboard = Date.now()
    this.setHandover(id, 0)
    return true
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
  private queuePrompt(
    id: string,
    prompt?: string,
    extraDelay = 0,
    startMs = PROMPT_START_MS,
    onSettled?: () => void,
    budgetMs = PROMPT_WAIT_MAX_MS,
    proof: PromptProof = 'turn'
  ): void {
    if (!prompt) return onSettled?.()
    // Called exactly once, however this ends - typed and submitted, dropped, or the pane
    // gone. The handover curtain is raised on it, and a curtain with an exit this does not
    // reach is a pane nobody can type into: every `return` below goes through `settle`.
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      onSettled?.()
    }
    const deadline = Date.now() + Math.max(0, budgetMs) + Math.max(0, extraDelay)
    // `lastKeyboard` as it stands NOW, which is after whatever write queued this prompt -
    // an autoclear's own `/clear\r` goes through `write` and bumps it. Anything later is a
    // person submitting into the pane, and `queuedPromptDecision` drops the queued prompt
    // rather than delivering it into the turn that person just started. Our own writes
    // re-stamp the mark so the confirm returns never read as somebody else.
    let mark = this.sessions.get(id)?.meta.lastKeyboard ?? Date.now()
    const ourWrite = (data: string): void => {
      this.write(id, data, 'app')
      const after = this.sessions.get(id)
      if (after) mark = Math.max(mark, after.meta.lastKeyboard ?? 0)
    }
    const verdict = (live: Live, composerIdle: boolean): QueuedPromptVerdict =>
      queuedPromptDecision({
        exists: true,
        lastKeyboard: live.meta.lastKeyboard,
        mark,
        drafting: !!live.typed && !!live.typed.trim(),
        composerIdle,
        expired: Date.now() >= deadline
      })
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

    // THE WAIT'S DEADLINE MAY NOT ALSO BE THE CONFIRM'S. `deadline` caps how long we
    // wait for an idle composer; once the prompt is typed and a return sent, the return
    // needs its own time to be PROVEN - and a prompt typed at the very edge of the budget
    // had none. Measured 2026-09-01, pane s31-mti4yatg: /clear at 04:37:05, the composer
    // only read idle at 04:40:06 (181s, right on the 180s budget), return sent, and 4s
    // later the first confirm found the pane still painting with the deadline already
    // past - so it logged UNSENT immediately, on its first look, with five retries unused.
    // The pane sat cleared holding a fully typed prompt nobody sent, which is exactly the
    // failure this whole path exists to prevent. `handoverMaxMs` already sizes the curtain
    // as `budgetMs + PROMPT_CONFIRM_MS * PROMPT_ENTER_TRIES`, so the confirm was always
    // meant to outlive the wait; only this branch disagreed.
    let confirmUntil = 0
    const submit = (tries: number): void => {
      const live = this.sessions.get(id)
      if (!live) return settle()
      // A confirm return is still a keystroke into a live CLI. If somebody has sent their
      // own message since the prompt went in, that return would land on THEIR turn.
      if ((live.meta.lastKeyboard ?? 0) > mark) {
        acLog(`${id} prompt left UNSENT: the pane was typed into by hand before the return`)
        return settle()
      }
      ourWrite('\r')
      acLog(`${id} return sent (try ${tries + 1}/${PROMPT_ENTER_TRIES})`)
      const typedAt = Date.now()
      if (!confirmUntil) confirmUntil = typedAt + PROMPT_CONFIRM_MS * PROMPT_ENTER_TRIES
      const confirm = (): void => {
        setTimeout(() => {
          const still = this.sessions.get(id)
          if (!still) return settle()
          // A TURN is the only proof the return went in. `runSince` is set when one starts
          // - by this submit or by the agent's own busy footer - so a value newer than the
          // return is the answer being written.
          if ((still.meta.runSince ?? 0) >= typedAt) {
            acLog(`${id} prompt submitted - a turn started`)
            return settle()
          }
          if ((still.meta.lastKeyboard ?? 0) > mark) {
            acLog(`${id} prompt left UNSENT: the pane was typed into by hand while confirming`)
            return settle()
          }
          // A SLASH COMMAND STARTS NO TURN. `/model opus` prints one line ("Set model to
          // Opus 5 and saved as your default") and hands the composer straight back, so
          // the turn proof above can never fire for it. Measured on every autoclear from
          // 2026-09-02 05:43 (the first with a model switch) to 2026-09-03 03:58: the
          // switch went in on its first return, the confirm then read an idle composer
          // with no turn behind it and fed it two more bare returns, and only at
          // PROMPT_CONFIRM_MS x PROMPT_ENTER_TRIES (24s) did it give up as "still
          // painting" - 24s and two stray keystrokes on every clear, before the resume
          // prompt was even queued. For a command, the composer coming back idle IS the
          // proof, read at the poll cadence rather than the confirm's.
          if (proof === 'idle' && idle(still)) {
            acLog(`${id} command landed - the composer is idle again (no turn expected)`)
            return settle()
          }
          if (!idle(still)) {
            // PAINTING IS NOT PROGRESS, and reading it as progress is what stranded pane
            // s7-mtfk52fv on 2026-08-30: `/clear` restarts the CLI, its banner and hook
            // chain paint for seconds, and the one return this sent during that window was
            // swallowed. The old branch settled here - "something came back, so it must
            // have gone in" - and the pane sat at a composer holding a fully typed prompt
            // nobody had sent, with the app's own log ending at that write. So a busy pane
            // is now WAITED OUT rather than counted as a submit; only a turn, a person, or
            // the deadline ends this.
            if (Date.now() >= confirmUntil) {
              acLog(
                `${id} prompt left UNSENT: still painting ${PROMPT_CONFIRM_MS * PROMPT_ENTER_TRIES}ms after the return`
              )
              return settle()
            }
            return confirm()
          }
          // Idle at the composer with no turn behind it: the return was eaten. Send another.
          if (tries + 1 >= PROMPT_ENTER_TRIES) {
            acLog(`${id} prompt left UNSENT: ${PROMPT_ENTER_TRIES} returns were swallowed`)
            return settle()
          }
          submit(tries + 1)
        }, proof === 'idle' ? PROMPT_POLL_MS : PROMPT_CONFIRM_MS)
      }
      confirm()
    }

    const tick = (): void => {
      const live = this.sessions.get(id)
      if (!live) return settle()
      const what = verdict(live, idle(live))
      if (what === 'wait') {
        setTimeout(tick, PROMPT_POLL_MS)
        return
      }
      if (what === 'abandon') {
        acLog(
          `${id} queued prompt dropped - ${
            (live.meta.lastKeyboard ?? 0) > mark ? 'the pane was used by hand' : 'an unsent draft outlasted the wait'
          }`
        )
        return settle()
      }
      ourWrite(prompt)
      acLog(`${id} prompt typed (${prompt.length} chars), return in ${PROMPT_ENTER_MS}ms`)
      setTimeout(() => this.sessions.get(id) && submit(0), PROMPT_ENTER_MS)
    }
    setTimeout(tick, Math.max(0, startMs) + Math.max(0, extraDelay))
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
   * Name the pane for what its reply said the handle was.
   *
   * `Working On 50 Task` sat on a card all day (2026-09-03) while the first line the
   * agent printed was `$50 task = Travel Video Editor, Jacob P. (board id 794 ...)`. The
   * ask carried the handle, the reply carried the name; this joins them. Only output since
   * the ask is read, and only once: a handle is spent the first time a reply resolves it,
   * and dropped the moment a person types a title or a client is found.
   */
  private sweepResolved(live: Live): void {
    const handle = live.handle
    if (!handle) return
    const s = live.meta
    if (s.clientOff || s.clientSlug || !(mayRename(s.title, s.cwd) || s.autoTitled === 'topic')) {
      live.handle = undefined
      return
    }
    const text = strip(live.buffer.read())
    if (text.length < live.handleSeen) live.handleSeen = 0
    const name = resolvedName(text.slice(live.handleSeen), handle)
    if (!name) return
    live.handle = undefined
    if (name === s.title) return
    const was = s.title
    s.title = name
    s.autoTitled = 'topic'
    console.info(`clientname: ${s.id} "${was}" -> "${name}" (reply resolved "${handle}")`)
    this.emit('clientNamed', { id: s.id, slug: '', title: name, was, from: 'reply' } satisfies ClientNamed)
    this.emitSessions()
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
    // Somebody is at this window, so the wait has not started: stamp the hold, which is the
    // second start line `autoAnswer` reads. Both the presser and the countdown come off
    // that one number, so they cannot promise different seconds. A mirrored pane is left
    // alone - the desk that owns the pty owns this decision, and our focus says nothing
    // about whether anybody is at THAT one.
    const held = !!ask && cfg.holdWhileWatching !== false && !live.meta.remote && deskFocused()
    if (held) live.askHold = Date.now()
    const due = ask ? autoAnswerAt(live, cfg, ask) : 0
    const n = ask && (due || held) ? pickAnswer(ask, cfg)?.n : undefined
    // Held is drawn instead of a clock, never beside one: a deadline that restarts the
    // moment the window is left is not a countdown, and drawing one would be a promise
    // about a second that never arrives.
    const heldNow = held && !!n ? true : undefined
    // ...and "instead of" has to mean the DEADLINE goes, not only that the pane draws a
    // different row. `autoAnswerAt` is read in three places, and the pane was the only one
    // that looked at `held` beside it: the card's `AskClock` and the desk's tick (the
    // SOONEST `autoAnswerAt` on the desk, `soonestAuto` in `App.tsx`) read the number
    // alone. So clicking onto a pane holding a question stamped the hold, moved the
    // deadline 30s out - and the card went on counting down and the tick went on ticking,
    // once a second, at somebody who had just arrived to answer it by hand. Held is
    // deadline-less everywhere or it is deadline-less nowhere.
    const at = heldNow ? 0 : due
    if (
      live.meta.autoAnswerAt === (at || undefined) &&
      live.meta.autoAnswerN === n &&
      live.meta.autoAnswerHeld === heldNow
    )
      return false
    live.meta.autoAnswerAt = at || undefined
    live.meta.autoAnswerN = n
    live.meta.autoAnswerHeld = heldNow
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
    this.choose(live.meta.id, pick.n, 'app')
  }

  /**
   * The command running in front of a pane, and when it started, or null.
   *
   * Two readings for two platforms, because Windows has none of the cheap one: measured on
   * the PC, `IPty.process` there answers with the terminal NAME whatever is running, so
   * believing it would mark every shell pane on that machine working for ever. There it is
   * the process table instead, sampled on its own slower timer.
   *
   * The POSIX call is wrapped because it reads the tty, and a pane whose pty has just died
   * throws from it - inside a sweep that runs every second, for every pane.
   */
  private jobOf(live: Live, now: number): { name: string; since: number } | null {
    if (WIN) {
      const found = this.tableJobs.get(live.meta.id)
      // The table knows how long it has been alive, so the pane's clock is the command's
      // real age rather than the moment this app noticed it - which matters most for the
      // pane that was already running when the app restarted.
      return found ? { name: found.name, since: now - (found.elapsed ?? 0) * 1000 } : null
    }
    try {
      const name = live.proc ? paneJob(live.proc.process, live.runner) : ''
      if (name) return { name, since: now }
    } catch {
      // A pane whose pty has just died throws from the tty read, inside a sweep that runs
      // every second for every pane. Fall through: the table may still know.
    }
    // Nothing in the FOREGROUND is not the same as nothing running. `cmd &` leaves the
    // SHELL itself in front of the tty, so `paneJob` is silent about a background job that
    // may run for hours - and silence there means no `runSince`, which means `busy` is
    // false in `reclaim.ts` and the idle clock starts counting down on a working pane.
    // Reported 2026-08-24: "1 shell 2 monitors running in session 2, why is it trying to
    // close it". The table sees them, because on POSIX the pty pid IS the shell and every
    // child of it is a job somebody started. It is sampled on the slower timer, so a
    // background job is invisible for at most TABLE_JOB_MS - which costs a clock that
    // starts a beat late, never a pane that is closed.
    const found = this.tableJobs.get(live.meta.id)
    return found ? { name: found.name, since: now - (found.elapsed ?? 0) * 1000 } : null
  }

  /**
   * One process table, folded into `tableJobs`.
   *
   * Windows needs it for EVERY shell pane: `IPty.process` there returns the terminal name
   * whether or not anything is running, so there is no foreground reading at all. POSIX
   * needs it for one case the exact reading cannot see - a job the shell was told to run
   * in the BACKGROUND, where the foreground is the shell itself.
   *
   * On demand rather than always - a table read is a whole `ps`/CIM query and most desks
   * have no shell pane at all - and never twice at once. Silent about everything it cannot
   * read: an empty table leaves every pane exactly as it was, because "the table did not
   * answer" and "nothing is running" must not share a shape.
   */
  private sweepTableJobs(): void {
    if (this.tableJobsBusy) return
    const shells = [...this.sessions.values()].filter((l) => {
      if (l.meta.status === 'exited') return false
      if (!SHELLS.has(programName(l.runner).toLowerCase())) return false
      // POSIX: the tty already answered, exactly and for free, so do not pay for a table
      // to repeat it. Only a pane whose foreground IS its own shell has anything left to
      // find out about.
      if (!WIN) {
        try {
          if (l.proc && paneJob(l.proc.process, l.runner)) return false
        } catch {
          // A pty that has just died: let the table have the question.
        }
      }
      return true
    })
    if (!shells.length) {
      if (this.tableJobs.size) this.tableJobs.clear()
      return
    }
    this.tableJobsBusy = true
    void jobTable()
      .then((procs) => {
        if (!procs.length) return
        this.tableJobs.clear()
        for (const live of shells) {
          const found = live.proc ? jobFromTable(procs, live.proc.pid, live.runner) : null
          if (found) this.tableJobs.set(live.meta.id, found)
        }
      })
      .finally(() => {
        this.tableJobsBusy = false
      })
  }

  private sweepIdle(): void {
    let changed = false
    const now = Date.now()
    const reap: string[] = []
    for (const live of this.sessions.values()) {
      const { meta } = live
      const quiet = now - meta.lastOutput
      if (this.markCwdGone(live, now)) changed = true
      // A dead pty whose folder has also gone is a card about nothing: no process to
      // go back to, and no directory left to resume in. Only that PAIR reaps. A live
      // pane keeps its card however missing the folder is - a rename, a `git clean`, a
      // worktree moved out from under a working session must never close the chat, and
      // the shell recovers to $HOME on its own. The grace window is so a folder that is
      // replaced in two steps (remove, recreate) does not take the pane with it.
      if (
        reapForMissingCwd({
          status: meta.status,
          cwdGone: meta.cwdGone,
          now,
          graceMs: CWD_GONE_REAP_MS
        })
      )
        reap.push(meta.id)
      // Does the pane's own footer still say the agent is running? This outranks the
      // quiet clock everywhere below: silence during a five minute tool call is not
      // the same thing as silence at an empty prompt, and treating them alike is what
      // made the dot go grey mid-turn and the bell ring over a running agent.
      // What a SHELL pane is running, which is the one kind of pane nothing else in this
      // loop can speak about: no prompt this app watched being submitted, no CLI footer.
      // It costs one syscall (the tty already knows its own foreground process) and it
      // feeds straight into `busyOnScreen` below, because a live command is exactly what
      // that flag means everywhere else - the pane is working, do not call the turn over.
      const job = meta.status === 'exited' ? null : this.jobOf(live, now)
      const jobName = job?.name ?? null
      if (jobName !== live.jobName) {
        live.jobName = jobName
        meta.job = jobName ?? undefined
        // The clock has to count the COMMAND. A shell pane's `runSince` is otherwise
        // never set by anything, and a pane sorted into Running with no clock on it is
        // half an answer: it says something is happening and not for how long.
        if (job) meta.runSince = meta.runSince ?? job.since
        changed = true
      }
      // ...and what an AGENT pane left running in the BACKGROUND, which is the other half
      // of the same question and is believed by a different amount. `shared/paneBackJobs.ts`
      // is a heuristic over the process table (a shell subtree under the pty, older than
      // its floor), so it deliberately does NOT reach `busyOnScreen` below: a false job
      // there is a pane the idle sweep never closes and a budget that never moves. It
      // reaches the sessions list and nothing else, where being wrong costs a heading.
      const back = meta.status === 'exited' ? null : backJobInfo(meta.id)
      if ((back?.label ?? null) !== (meta.backJob ?? null)) {
        meta.backJob = back?.label
        meta.backJobSince = back?.since
        changed = true
      }
      // ...and whether a screen elsewhere is drawing it. Read off the borrow map the phone
      // and the mirror already keep alive, expired here on the same TTL `resize` uses, so a
      // viewer that vanished stops counting within `BORROW_TTL_MS` and not never.
      if (live.borrows) dropStale(live.borrows, now)
      const watched = !!live.borrows && live.borrows.size > 0
      if (watched !== !!meta.watched) {
        meta.watched = watched || undefined
        changed = true
      }
      // ...and what this pane's HANDOFF says is left. Same seam and the same contract as
      // `backJob`: it decorates and ranks nothing that could close a pane. It is cached for
      // CACHE_MS inside `handoffFor`, so the sweep is a Map lookup on all but one tick in
      // thirty. A pane with no handoff answers `undefined`, which is not `0`.
      const hand = handoffFor(meta.cwd, meta.id, now)
      const open = hand.path ? hand.open : undefined
      if (open !== meta.handoffOpen) {
        meta.handoffOpen = open
        changed = true
      }
      const busyOnScreen = live.busyUntil > now || jobName !== null
      // A SHELL pane's turn is its foreground command and nothing else, so it ends the
      // moment that command does - no quiet clock in front of it.
      //
      // The backstop below waits for the pane to go QUIET, and a shell echoes every
      // keystroke, so `lastOutput` moves on every character typed. A shell pane that had
      // ever submitted anything therefore kept `runSince` for as long as somebody was
      // typing into it - which is the pane reading "Running" while a prompt is being
      // written. Measured in a dev copy before this: `true\r`, then 38 characters typed
      // with no return, still reported `status: working, runSince: true` two seconds later.
      //
      // POSIX only, because there the FOREGROUND reading is exact and asked every sweep
      // (`paneJob` is the tty's own foreground process). Windows has no such reading: the
      // table is sampled every TABLE_JOB_MS and asynchronously, so a command would read as
      // finished for the seconds before the table first sees it. There, the quiet backstop
      // stays. A POSIX BACKGROUND job comes off that same table, so for up to TABLE_JOB_MS
      // one may end the run clock early - a clock that restarts, never a pane that closes,
      // because `reclaim.ts` refuses on `job` as well as on `busy`.
      const shellDone =
        !WIN &&
        !jobName &&
        live.busyUntil <= now &&
        SHELLS.has(programName(live.runner).toLowerCase())
      if (shellDone && meta.runSince) {
        if (this.endRun(live)) changed = true
      }
      // Backstop for the run clock: an agent whose footer this app cannot read (or
      // a pane that was torn down mid-turn) would otherwise count forever. Quiet,
      // and nothing on screen claiming to be busy, is the end of the turn.
      if (meta.runSince && !busyOnScreen && quiet > IDLE_AFTER_MS) {
        if (this.endRun(live)) changed = true
      }
      if (busyOnScreen && meta.status !== 'working' && meta.status !== 'exited') {
        meta.status = 'working'
        changed = true
      } else if (
        meta.status === 'working' &&
        !busyOnScreen &&
        // Same reading, same reason: for a shell pane the foreground process IS the
        // answer, so it does not have to go quiet first - and it never will while
        // somebody is typing at its prompt.
        (quiet > IDLE_AFTER_MS || shellDone)
      ) {
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

      // A pane that asked about `$50 task` and has now been told what that is.
      if (live.handle && !meta.runSince) this.sweepResolved(live)

      // A question with an obvious answer, pressed rather than waited on. Here rather
      // than where the question is READ, for the same reason as recover: the frame
      // arrives many times a second while the CLI redraws its chooser, and the wait this
      // needs is measured from when the question settled, not from when it was painted.
      if (live.meta.ask) this.sweepAutoAnswer(live)
      // A pane automation opened for one job, once that job is really over.
      if (live.req.closeWhenDone) this.sweepCloseWhenDone(live, now, quiet)
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
    // After the loop: `kill` mutates the map this was iterating.
    for (const id of reap) {
      audit('reap-cwd-gone', { id, cwd: this.sessions.get(id)?.meta.cwd ?? null })
      this.kill(id)
    }
    if (changed) this.emitSessions()
  }

  /**
   * Has this pane's folder been deleted out from under it?
   *
   * Stamped rather than flagged, because the reap wants to know for HOW LONG, and the
   * renderer wants to say so on the card. Cleared the moment the folder is back, so a
   * worktree that is reset and recreated leaves nothing behind. Only the timestamp is
   * new state; nothing here closes anything, that decision is in `sweepIdle`.
   */
  private markCwdGone(live: Live, now: number): boolean {
    if (now - (this.cwdCheckedAt.get(live.meta.id) ?? 0) < CWD_CHECK_MS) return false
    this.cwdCheckedAt.set(live.meta.id, now)
    const gone = !!live.meta.cwd && !existsSync(live.meta.cwd)
    const { value, changed } = nextCwdGone(gone, live.meta.cwdGone, now)
    if (!changed) return false
    if (value === undefined) delete live.meta.cwdGone
    else live.meta.cwdGone = value
    return true
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
