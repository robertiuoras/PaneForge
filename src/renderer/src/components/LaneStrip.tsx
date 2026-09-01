import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaneBoard, LaneBoardEntry, Session } from '@shared/types'
import { copyNumber, paneRef } from '@shared/place'
import { appVisible, onAppVisible } from '../appVisible'
import {
  ago,
  deviceTip,
  holdWords,
  laneBusy,
  laneChipLabel,
  laneLabel,
  laneProject,
  laneState,
  laneTip,
  laneWho,
  RELEASE_STUCK_MS
} from '../laneWords'

const api = window.api

interface Props {
  boards: LaneBoard[]
  sessions: Session[]
  /** focus the pane a job was handed to */
  onFocus: (id: string) => void
  /** open the "How lanes work" card */
  onHelp: () => void
}

/**
 * PaneForge's own development lanes.
 *
 * Several chats edit PaneForge at once, each in its own checkout, and the whole release
 * is automatic - which is fine until one lane's work will not merge into master. That
 * lane is then left out of every release, silently, until a human learns about it from a
 * sentence buried in another chat's hook output. Lane b sat like that for a day.
 *
 * The lane a pane holds is drawn ON that pane's card (LaneChip below), because that is
 * where you are already looking and a second list of the same sessions was two places to
 * read one fact. What is left over is what no card can say: a lane whose chat is gone,
 * finished work waiting on a release, a conflict nobody owns. Only those appear here, so
 * on an ordinary day this section is not on screen at all.
 */
export function useLaneBoards(): LaneBoard[] {
  const [boards, setBoards] = useState<LaneBoard[]>([])

  useEffect(() => {
    let live = true
    const poll = (): void => {
      // Not `document.hidden`: it never turns true in this window. See appVisible.ts.
      void appVisible().then((v) => {
        if (!v || !live) return
        api.laneBoard().then((b) => live && setBoards(b ?? []))
      })
    }
    poll()
    const t = window.setInterval(poll, 5000)
    const off = onAppVisible(poll)
    return () => {
      live = false
      window.clearInterval(t)
      off()
    }
  }, [])

  return boards
}

/**
 * The pane a lane belongs to.
 *
 * Answered in the main process (laneBoard.ts `attachLaneOwners`), which is the only side
 * that can: a lane records the CHAT holding it, and matching that to a pane needs the
 * pane's conversation id, which never leaves the main process. Matching by folder here
 * instead was wrong in the case that actually happens - every chat records the main
 * checkout it started in, so one new pane opened there "owned" two dead chats' lanes at
 * once and both disappeared off the strip while still held.
 */
export function laneOwner(lane: LaneBoardEntry, sessions: Session[]): Session | undefined {
  if (!lane.ownerPane) return undefined
  return sessions.find((s) => s.id === lane.ownerPane && s.status !== 'exited')
}

/** Lanes keyed by the pane holding them, for the chip on a session card - every repo's. */
export function useLanesByPane(boards: LaneBoard[]): Map<string, LaneBoardEntry> {
  return useMemo(() => {
    const m = new Map<string, LaneBoardEntry>()
    for (const b of boards) for (const l of b.lanes) if (l.ownerPane) m.set(l.ownerPane, l)
    return m
  }, [boards])
}

/** The lane a pane holds, if any. Callers hold the map from useLanesByPane. */
export function laneOfSession(
  lanes: Map<string, LaneBoardEntry>,
  sessionId: string
): LaneBoardEntry | undefined {
  return lanes.get(sessionId)
}

// The sentences themselves live in ../laneWords, which imports nothing: the strip only polls
// while the window is on screen, so what it would say is checked there rather than by reading
// a DOM that may not exist. See scripts/lane-holder-test.mjs.

/** The job handed to a chat to unstick a lane, in the form lane.mjs expects back. */
function fixPrompt(lane: LaneBoardEntry, repo: string): string {
  return (
    `${laneProject(lane)} lane ${lane.lane} is conflicted, so its finished work is left out of every release. ` +
    `Take it over: node scripts/lane.mjs resolve --repo ${repo} --session <this chat's session id> --lane ${lane.lane} ` +
    `(lane.mjs lives in the PaneForge checkout), ` +
    `resolve the files it lists in ${lane.dir}, commit, then node scripts/lane.mjs ready --repo ${repo} --session <same id> --lane ${lane.lane}.`
  )
}

/**
 * The lane a pane holds, on the pane's own card beside its agent and model.
 *
 * Colour carries the three states a release cares about, and nothing else: blue while a
 * chat is working in that checkout right now, green once its work is finished and waiting
 * for the next version, red when the work will not merge and is being left out of every
 * release. A lane merely held, with nobody typing, stays grey.
 */
export function LaneChip({
  lane,
  paneProject,
  onHelp
}: {
  lane: LaneBoardEntry
  /**
   * The project the card beside this chip has already named. When the lane is a copy of
   * that same project the chip drops the name and says only `lane a` - see
   * `laneChipLabel`. Left out, the chip always names the project, which is what the lane
   * strip's own rows want.
   */
  paneProject?: string
  onHelp?: () => void
}): JSX.Element {
  // "lane a" beside a "w2" worktree chip read as two halves of one fact, and they are not
  // related at all: w2 is this pane's own checkout of whatever project it opened, and this
  // is a lane in a release pool that the chat in this pane happens to hold.
  //
  // The prefix used to be the literal letters "PF", which was right while PaneForge was the
  // only repository with lanes and became a lie the day any repo could have them: a chat
  // holding taskdriver's lane b had a chip on it reading "PF lane b". It is the project's
  // own name now, from the lane's folder.
  const base = laneChipLabel(lane, paneProject)
  const label = lane.conflicted ? `${base} stuck` : lane.ready ? `${base} done` : base
  return (
    <span
      className={
        'chip pf-lane' +
        (lane.conflicted ? ' stuck' : lane.ready ? ' done' : laneBusy(lane) ? ' busy' : '')
      }
      role={onHelp ? 'button' : undefined}
      onClick={
        onHelp &&
        ((e) => {
          e.stopPropagation()
          onHelp()
        })
      }
      title={
        `This chat is also editing ${laneProject(lane)}, in its own copy of the folder ` +
        `- ${laneState(lane, true)}.\n` +
        `Nothing to do with the folder this pane is open in.\n${laneTip(lane)}` +
        (onHelp ? '\nClick: how lanes work.' : '')
      }
    >
      {label}
    </span>
  )
}

export default function LaneStrip({ boards, sessions, onFocus, onHelp }: Props): JSX.Element | null {
  // A job is handed over once. Keyed by when the conflict started, so a lane that gets
  // stuck again later is a new job and not one this ref has already forgotten about.
  const handed = useRef(new Set<string>())

  // Unsticking a lane never needed a human to decide anything - the button only ever
  // typed the same paragraph into whichever pane was free. So the app does that itself:
  // the lane's own chat gets its own conflict back, and once the conflict is adoptable
  // (its chat has gone quiet) any idle pane takes it. Never a pane that is mid-turn -
  // that job waits for a free one rather than landing in the middle of someone's answer.
  useEffect(() => {
    for (const board of boards)
      for (const lane of board.lanes) {
        if (!lane.conflicted || lane.resolver) continue
        const key = `${board.repo}:${lane.lane}:${lane.conflictSince ?? 0}`
        if (handed.current.has(key)) continue
        const own = laneOwner(lane, sessions)
        const target =
          own ??
          (lane.adoptable ? sessions.find((s) => s.status !== 'exited' && s.status !== 'working') : undefined)
        if (!target || target.status === 'working') continue
        handed.current.add(key)
        // Not `write(text + '\r')`. That is the shape measured failing on 2026-08-11 for
        // launch prompts and found failing here on 2026-08-17: the CLIs run with bracketed
        // paste on, so a paragraph written to the pty arrives as pasted text and the CR
        // glued to its end is one more character of the paste, not Enter. The job then sits
        // in the chat's prompt box until a person notices and presses Enter - which is the
        // whole point of an automatic hand-over, missed. `sendPrompt` waits for an idle
        // composer, then sends the return as its own keystroke and confirms it took.
        api.sendPrompt(target.id, fixPrompt(lane, board.repo))
      }
  }, [boards, sessions])

  // Whatever a session card already says is not repeated here. Every open repo's lanes
  // are listed, not just one winner's - each row already names its project (laneLabel),
  // so one flat list still reads unambiguously.
  const orphans = boards.flatMap((b) =>
    b.lanes
      .filter((l) => !laneOwner(l, sessions))
      // `here` travels with the row because a board is one machine's reading of one repo,
      // and a row may be about the other machine - see LaneRow's device tag.
      .map((l) => ({ repo: b.repo, lane: l, here: b.device, hold: b.hold }))
  )
  if (!orphans.length) return null
  const stuck = orphans.filter((o) => o.lane.conflicted).length
  // The oldest running release, so "releasing" can stop being said about one that is not.
  const releasingAt = boards
    .map((b) => b.releasing)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b)[0]
  const wedged = releasingAt !== undefined && Date.now() - releasingAt > RELEASE_STUCK_MS

  return (
    <>
      <div className="section">
        {/* The middle word is the first thing a narrow sidebar gives up: the heading was
            ellipsed to `LANES ELSEWHERE …` with the count - the one number on the line -
            inside the part that got cut. */}
        {/* "Lanes" is this app's word for a thing that already has a plain one: an extra
            copy of a project folder, so two chats can work on it without landing on each
            other. The heading says the plain one. The middle word is still the first
            thing a narrow sidebar gives up - the heading was ellipsed with the count, the
            one number on the line, inside the part that got cut. */}
        <span className="section-title">
          Other<span className="wide-word"> copies</span> ({orphans.length})
        </span>
        {stuck > 0 && (
          <span
            className="badge stuck"
            title="Two chats changed the same lines, so this work won't merge until someone picks. Everything else still ships."
          >
            {stuck} need you
          </span>
        )}
        {releasingAt !== undefined && (
          <span
            className={'badge ' + (wedged ? 'stuck' : 'run')}
            title={
              wedged
                ? 'A release started and never finished - usually a machine that went away mid-release. ' +
                  'It is dropped by itself after twenty minutes and the work goes out with the next one.'
                : 'Finished lanes are being folded into one update right now'
            }
          >
            {wedged ? `release stuck ${ago(releasingAt)}` : 'releasing'}
          </span>
        )}
        <button className="ghost small lane-what" onClick={onHelp} title="How lanes work">
          ?
        </button>
      </div>
      <div className="lanes">
        {/* The device is part of the key: both desks can hold `main` of one repo at once
            (lane.mjs calls it a shared trunk), which is two rows for one lane letter. */}
        {orphans.map((o) => (
          <LaneRow
            key={`${o.repo}:${o.lane.lane}:${o.lane.device ?? ''}`}
            lane={o.lane}
            repo={o.repo}
            here={o.here}
            hold={o.hold}
            sessions={sessions}
            onFocus={onFocus}
          />
        ))}
      </div>
    </>
  )
}

function LaneRow({
  lane,
  repo,
  here,
  hold,
  sessions,
  onFocus
}: {
  lane: LaneBoardEntry
  repo: string
  /** the machine this window is running on, to tell "here" from "the other desk" */
  here: string | null
  /** this repo's release gate, on why finished work has not gone out */
  hold: { reason: string; at: number } | null
  sessions: Session[]
  onFocus: (id: string) => void
}): JSX.Element {
  // The automatic hand-over waits for a pane that is not mid-turn, and leaves a conflict
  // whose own chat is still alive to that chat. This is the same job for someone who does
  // not want to wait for either, which is why it may land in a busy pane.
  const handOver = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const target = laneOwner(lane, sessions) ?? sessions.find((s) => s.status !== 'exited')
    if (!target) return
    onFocus(target.id)
    // Typed in, not sent: this one is a click, so the chat it lands in may be mid-thought.
    api.write(target.id, fixPrompt(lane, repo))
  }

  // The pane holding this lane, as its Ctrl-N number.
  //
  // Only the HOLDER can be resolved: `ownerPane` is matched in the main process, which is
  // the one side that can see a pane's conversation id (laneBoard.ts `attachLaneOwners`).
  // A resolver is recorded as a bare chat id with no such match, so it stays a short hex
  // string - `paneRef` prints whichever of the two it was given.
  const owner = laneOwner(lane, sessions)
  const holderPane = owner ? sessions.indexOf(owner) + 1 : undefined
  // Every row here belongs to a chat that is NOT a pane in this window - that is what the
  // strip is - so "somebody is working in it right now" is the one fact about it no card
  // can carry, and it was the one fact drawn in the same grey as a lane nobody has touched
  // since yesterday.
  const busy = laneBusy(lane)

  return (
    <div
      className={
        'row lane-row' +
        (lane.conflicted ? ' stuck' : '') +
        (lane.ready ? ' done' : '') +
        (busy ? ' busy' : '')
      }
      title={laneTip(lane, holderPane) + (lane.ready && hold ? `\n\n${hold.reason}` : '')}
    >
      {/* The copy's NUMBER, never its slot letter. `a` is scripts/lane.mjs's word for a
          position in a pool and means nothing to the person reading this row; the folder
          the project itself lives in is copy 1, so `a` is 2. A slot of neither shape is
          printed as it is rather than given an invented number (src/shared/place.ts). */}
      <span className={'lane-tag' + (lane.conflicted ? ' stuck' : busy ? ' busy' : '')}>
        {lane.lane === 'main' ? 1 : (copyNumber(lane.lane) ?? lane.lane)}
      </span>
      <div className="row-text">
        {/* Was `lane.branch`, which is the single word this whole change exists to stop
            printing: several rows saying `master`, for different repositories, with
            nothing on any of them naming one. */}
        {/* The folder, then what the chat in it was called. The folder alone answered
            "which copy" and never "which job", which is the question a list of seven is
            asking. Nothing is drawn for a copy whose chat left no name behind. */}
        <div className="row-title">
          {laneLabel(lane)}
          {laneWho(lane) && <span className="row-who"> {laneWho(lane)}</span>}
        </div>
        <div className="row-sub">
          {laneState(lane, false, Date.now(), holderPane, hold)}
          {lane.conflicted && lane.resolver ? ` - ${paneRef(undefined, lane.resolver)} has it` : ''}
        </div>
      </div>
      {/* Which desk, drawn only when it is the OTHER one.
          It used to be drawn on every row, and on a one-machine desk that is the same
          word repeated down the strip - 92px of reserved width (styles.css .lane-device)
          spent saying nothing, taken off the front of the line that carries the state.
          The row that has to be read differently is the one this window cannot free, and
          that is the only row that keeps the tag. `here` unknown keeps it too: a device
          we cannot compare against is not a device we can call ours. */}
      {lane.device && (!here || lane.device !== here) && (
        <span className="lane-device away" title={deviceTip(lane, here)}>
          {lane.device}
        </span>
      )}
      {lane.conflicted && !lane.resolver && !lane.peer && (
        <button className="ghost small lane-fix" onClick={handOver} title="Hand the job to a pane now">
          fix
        </button>
      )}
    </div>
  )
}
