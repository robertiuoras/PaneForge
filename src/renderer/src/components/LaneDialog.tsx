import { useEffect, useState } from 'react'
import type { LaneBoard, LaneBoardEntry, LaneMergeResult, LaneWork, Session } from '@shared/types'
import { describePlace, paneRef } from '@shared/place'
import Blurb from './Blurb'
import { ago, laneBusy, laneDoing, laneState, samePath } from '../laneWords'

const api = window.api

/**
 * What is in this pane's lane, what is in every OTHER copy of the same project, and the
 * one button that ends this one.
 *
 * A lane is created without being asked (lanes.ts), and until now nothing ever ended
 * one: the commits stayed on `lane-a` and the folder stayed on disk. The lane chip on the
 * pane opens this, which answers the two questions that actually come up - "what is in
 * here?" and "how do I get it back into main?" - and refuses in plain words when the
 * merge is not safe, because the alternative is an agent being told to sort out a
 * half-finished merge in a folder the user has forgotten about.
 *
 * Two things were missing and both were reported as the same feeling ("still super
 * confusing ... when you click on that lane a it should show way more helpful for even a
 * beginner"):
 *
 *  - **What a lane IS, in the words of somebody who did not build it.** The card led with
 *    `lane-a → main` and two counts. Every one of those words is a git word. The first
 *    thing on the card now is a plain sentence about folders, and the git line is below it
 *    for the reader who wants it.
 *  - **The other copies.** A project with lanes has three or four checkouts and each has
 *    its own chat typing into it; from inside one of them there was no way to see the
 *    others at all, which is what made two chips on one card ("lane b", "lane a", "main
 *    checkout") read as one pane holding two lanes. They are separate copies of one
 *    project, and this now says so with a row each, who holds it, and what it is doing.
 *
 * Nothing here deletes anything. An empty lane is swept by the app on its own; a lane
 * with work in it is only ever emptied by merging it.
 */
interface Props {
  cwd: string
  /** every repo's lanes, as the sidebar strip already polls them */
  boards: LaneBoard[]
  sessions: Session[]
  onClose: () => void
  /** open the "How lanes work" card */
  onHelp: () => void
  /** switch to the pane holding another copy of this project */
  onFocus: (id: string) => void
  /**
   * Read the lane's changes line by line.
   *
   * This dialog used to answer "what is in here?" with two numbers and then offer a merge
   * button beside them, which is asking for a piece of an hour's agent work to be taken on
   * trust. The counts are still the summary; this is the answer.
   */
  onReview: () => void
}

function summary(w: LaneWork): string {
  const bits = [
    w.ahead ? `${w.ahead} commit${w.ahead === 1 ? '' : 's'} not in ${w.base}` : `nothing ${w.base} does not have`,
    w.dirty ? `${w.dirty} uncommitted file${w.dirty === 1 ? '' : 's'}` : 'nothing uncommitted'
  ]
  return bits.join(' · ')
}

/** Why the merge button is off, in the words the person needs to act on. */
function blocker(w: LaneWork): string | null {
  if (w.dirty) return `Commit or discard the ${w.dirty} changed file${w.dirty === 1 ? '' : 's'} in the lane first - a merge will not take uncommitted work with it.`
  if (!w.ahead) return `Nothing to merge. This lane will be removed on its own once no pane is in it.`
  if (w.baseDirty) return `${w.repo.split(/[\\/]/).pop()} has uncommitted changes of its own. Commit or stash them, then merge.`
  if (w.conflicts.length)
    return `This lane and ${w.base} both changed ${w.conflicts.slice(0, 4).join(', ')}${w.conflicts.length > 4 ? ` and ${w.conflicts.length - 4} more` : ''}. Merge it in the lane's own agent (git merge ${w.base}), resolve, commit - then this button will work.`
  return null
}

/**
 * One row of the "other copies" list: a checkout, whoever has it, and what is in it.
 *
 * `entry` is optional and that is the whole reason this is not just a LaneBoardEntry. Two
 * different things make a lane on this machine and only one of them writes the ledger the
 * board is read from: `scripts/lane.mjs` (the release engine, which every chat's hook
 * claims through) and the app's own `main/lanes.ts` (which moves a second pane in one
 * project into `<repo>-a` the moment it is opened). A copy made by the app alone therefore
 * has no board row at all - the probe that measured this dialog hit exactly that and got an
 * empty list - so a row is built from whatever knows about the folder: the ledger when it
 * has one, and the panes in this window either way.
 */
interface Copy {
  dir: string
  /** "main", "a", "b" */
  slot: string
  /** the ledger's row, when this copy has one */
  entry?: LaneBoardEntry
  /** this window's pane holding it, when one is */
  pane?: { id: string; number: number; title: string; working: boolean }
  /** counts and last commit, once they have been read */
  work?: LaneWork | null
  /** the copy this dialog is about */
  self: boolean
  /** the project's own checkout, the one everything merges into */
  trunk: boolean
}

/**
 * The lane letter a folder is, given the project's own folder beside it: `foo-a` is `a`.
 *
 * Only a suffix of the trunk's own name counts, which is what keeps a real project called
 * `service-a` sitting next to `service` from being read as its lane (`test:projects` pins
 * the same rule for the sidebar). Anything else is not a copy of this project and gets no
 * row.
 */
function slotOf(dir: string, repo: string): string | null {
  const a = norm(dir)
  const b = norm(repo)
  if (a === b) return 'main'
  if (!a.startsWith(b + '-')) return null
  const rest = a.slice(b.length + 1)
  return /^([a-z]|w\d+)$/.test(rest) ? rest : null
}

/**
 * Two spellings of one folder, including the pair macOS makes of every path in `/tmp` and
 * `/var`.
 *
 * `laneWords.samePath` is the case-and-slash version and is right for what it does; this
 * needs one more thing, because the two sides of the comparison come from different places.
 * A pane records the folder it was opened in as it was typed (`/tmp/x`) and `laneWork` in
 * the main process answers with git's own realpath (`/private/tmp/x`) - so the trunk's row
 * said "no pane here" with a pane sitting in it, measured. The renderer has no realpath, and
 * `/private` is the only prefix on this platform that makes a difference.
 */
function norm(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^\/private\//, '/')
    .toLowerCase()
}

/** The same tolerance, for "is this the copy the dialog is about". */
function sameDir(a: string, b: string): boolean {
  return samePath(a, b) || norm(a) === norm(b)
}

export default function LaneDialog({
  cwd,
  boards,
  sessions,
  onClose,
  onHelp,
  onFocus,
  onReview
}: Props): JSX.Element {
  const [work, setWork] = useState<LaneWork | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  /** other copies' readings, keyed by folder. Filled in as each answers. */
  const [others, setOthers] = useState<Record<string, LaneWork | null>>({})

  const load = (): void => {
    void api.laneWork(cwd).then(setWork)
  }
  useEffect(load, [cwd])

  // The board for the project this lane is a copy of. `work.repo` is the trunk's folder,
  // which is exactly the key laneBoard uses, so the two line up without a second git run.
  const board = work ? boards.find((b) => sameDir(b.repo, work.repo)) ?? null : null

  /**
   * What is in each of the OTHER copies.
   *
   * One `laneWork` per lane folder, and only while this dialog is open - it is seven git
   * commands per lane (laneWork.ts) and a person opened this, so the cost is paid once at
   * a press rather than on the 5s poll every card already pays for. The trunk is skipped
   * on purpose: `laneWork` answers null for a repo's own checkout by construction, and
   * what the trunk is doing is a `git status` this dialog has no business running in a
   * folder another chat may be mid-commit in.
   */
  useEffect(() => {
    if (!work) return
    let live = true
    const dirs = new Set<string>()
    for (const lane of board?.lanes ?? []) if (!lane.peer) dirs.add(lane.dir)
    for (const s of sessions) if (!s.remote && s.status !== 'exited') dirs.add(s.cwd)
    for (const dir of dirs) {
      if (sameDir(dir, work.repo) || sameDir(dir, cwd)) continue
      if (!slotOf(dir, work.repo)) continue
      void api.laneWork(dir).then((w) => {
        if (live) setOthers((prev) => ({ ...prev, [norm(dir)]: w }))
      })
    }
    return () => {
      live = false
    }
    // Keyed on the FOLDERS, not on `sessions.length`: a count is unchanged when one pane
    // closes and another opens between two polls, so the new folder was never read and its
    // row sat on "reading…" for as long as the dialog was open. Not the array either - the
    // sessions broadcast hands a fresh one every second and every field on it moves (output
    // clocks, run timers), which would re-run seven git commands per lane per second.
  }, [work?.repo, board?.lanes.map((l) => l.dir).join('|'), sessions.map((s) => s.cwd).join('|'), cwd])

  /**
   * Escape closes it, like every other dialog in the app.
   *
   * It was the one overlay that had no way out but the mouse: App's global Escape branch
   * closes nine dialogs by name and this was not among them, and unlike ConfirmDialog this
   * card focuses nothing on mount, so an `onKeyDown` on the overlay would never have run
   * either. The cost was not a missing shortcut - the backdrop covers the panes, so the
   * app looked DEAD rather than looking open. `npm run test:focus` reported it as four
   * lost-focus failures (`caret: nothing`, selection frozen on the pane whose chip opened
   * this) which were clicks landing on `div.dialog.confirm`; the run only recovered when a
   * later click happened to hit the backdrop and close it by mouse.
   *
   * Capture phase on the window for the same reason App's handler is: xterm swallows keys
   * otherwise. The "how lanes work" card opens FROM here and sits on top, so it owns
   * Escape while it is up - the same rule App applies to an open `.select-menu`.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.lane-help')) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const merge = (): void => {
    setBusy(true)
    setSaid(null)
    void api.mergeLane(cwd).then((r: LaneMergeResult) => {
      setBusy(false)
      if (r.ok) {
        setSaid(
          `Merged ${r.commits} commit${r.commits === 1 ? '' : 's'} into ${r.base}.` +
            (r.removed ? ' The lane folder is gone.' : ' The folder goes when this pane leaves it.')
        )
      } else if (r.reason === 'conflict') {
        setSaid(`Conflicts in ${r.conflicts?.join(', ')} - nothing was merged, and ${work?.base} is untouched.`)
      } else {
        setSaid(r.detail ?? 'Nothing to merge.')
      }
      load()
    })
  }

  const stop = work ? blocker(work) : null
  const project = work
    ? describePlace({ cwd: work.dir, branch: work.branch, lane: work.lane }).project
    : ''

  /**
   * Every copy of this project on this machine, this one included: the trunk, whatever the
   * ledger knows, and whatever this window's panes are sitting in.
   *
   * A peer row is another machine's claim on the trunk and has no folder here, so it is left
   * out - the sidebar strip is written for those and says which desk. Trunk first, then the
   * letters, which is the order lane.mjs keeps them in.
   */
  const copies: Copy[] = (() => {
    if (!work) return []
    const byDir = new Map<string, Copy>()
    const add = (dir: string, slot: string, over: Partial<Copy> = {}): void => {
      const key = norm(dir)
      const prev = byDir.get(key)
      byDir.set(key, {
        dir,
        slot,
        self: sameDir(dir, cwd),
        trunk: slot === 'main',
        ...prev,
        ...over
      })
    }
    add(work.repo, 'main')
    for (const lane of board?.lanes ?? []) {
      if (lane.peer) continue
      const slot = slotOf(lane.dir, work.repo) ?? lane.lane
      add(lane.dir, slot, { entry: lane })
    }
    for (const s of sessions) {
      if (s.status === 'exited' || s.remote) continue
      const slot = slotOf(s.cwd, work.repo)
      if (!slot) continue
      add(s.cwd, slot, {
        pane: {
          id: s.id,
          number: sessions.indexOf(s) + 1,
          title: s.title,
          working: s.status === 'working'
        }
      })
    }
    // A ledger row names the pane holding it by conversation id, which is a fact the folder
    // cannot give: several chats hold lanes from one folder. It beats the folder match above.
    for (const copy of byDir.values()) {
      const owner = copy.entry?.ownerPane
        ? sessions.find((s) => s.id === copy.entry!.ownerPane && s.status !== 'exited')
        : undefined
      if (owner)
        copy.pane = {
          id: owner.id,
          number: sessions.indexOf(owner) + 1,
          title: owner.title,
          working: owner.status === 'working'
        }
      copy.work = copy.self ? work : others[norm(copy.dir)]
    }
    return [...byDir.values()].sort((x, y) =>
      x.trunk === y.trunk ? x.slot.localeCompare(y.slot) : x.trunk ? -1 : 1
    )
  })()

  return (
    <div className="overlay confirm-overlay" onMouseDown={onClose}>
      <div className="dialog confirm lane-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>
            {work ? `Lane ${work.lane}` : 'Lane'}
            {project ? ` of ${project}` : ''}
          </strong>
          <button className="ghost small lane-what" onClick={onHelp} title="How lanes work">
            what is this?
          </button>
        </div>
        <Blurb id="lane" />
        {work === undefined && <div className="confirm-body">Reading the lane…</div>}
        {work === null && (
          // "This pane is not in a lane any more" was true and was a dead end: the chip
          // that opens this card says `copy a`, so the person pressing it is asking what
          // `copy a` MEANS, and being told the thing they just pressed does not exist
          // answers nothing. Reported 2026-08-31: "it doesnt make sense too confusing for
          // user and cant even click on the tag to find details about it".
          //
          // A folder that is not in the ledger is still a folder, and everything worth
          // saying about it is on screen already - which project it copies, where it is,
          // and that its work is put back by hand rather than by this card.
          <div className="confirm-body">
            <div className="lane-plain">
              This pane is typing in <code>{cwd}</code>, a second copy of{' '}
              <strong>{project || 'this project'}</strong> kept beside the main one so two
              chats can work on it without landing on each other.
            </div>
            <div className="lane-dialog-sub">
              PaneForge is not tracking this copy - it was made outside the app, or its
              work has already gone back - so there is nothing here to merge. Press
              <em> what is this?</em> for how copies work.
            </div>
          </div>
        )}
        {work && (
          <div className="confirm-body">
            {/* Plain words first, git words second. Every noun in `lane-a → main` is a git
                noun, and this card is opened by somebody who did not choose to have a
                lane at all - the app made it for them when a second chat opened the same
                project. */}
            <div className="lane-plain">
              This pane is typing in <code>{work.dir}</code>, a second copy of{' '}
              <strong>{project}</strong> on its own branch. Finishing means putting its
              commits back into the main copy, <code>{work.repo}</code>.
            </div>
            <div className="lane-git">
              <code>{work.branch}</code> → <code>{work.base}</code>
              <span className="lane-dialog-sub"> {summary(work)}</span>
            </div>
            {laneDoing(work) && <div className="lane-dialog-sub">{laneDoing(work)}</div>}
            {work.conflicts.length > 0 && (
              <div className="lane-dialog-warn">
                Conflicts with {work.base}: {work.conflicts.join(', ')}
              </div>
            )}
            {said && <div className="lane-dialog-said">{said}</div>}
            {!said && stop && <div className="lane-dialog-sub">{stop}</div>}
          </div>
        )}
        {copies.length > 1 && (
          <div className="confirm-body lane-copies">
            {/* The question this list answers is "who else is in this project, and what are
                they doing" - which nothing in the app could answer from inside a lane. */}
            <div className="lane-copies-title">
              {copies.length} copies of {project} on this machine
            </div>
            {copies.map((c) => (
              <CopyRow key={c.dir} copy={c} onFocus={onFocus} />
            ))}
          </div>
        )}
        <div className="dialog-row">
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          {/* Beside the merge button, not behind it: the point of reading the changes is
              to decide whether to press the other one. */}
          <button className="ghost" onClick={onReview} disabled={!work}>
            See the changes
          </button>
          <button
            className="primary"
            disabled={!work || busy || Boolean(blocker(work))}
            onClick={merge}
          >
            {busy ? 'Merging…' : `Merge into ${work?.base ?? 'main'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * One other copy of this project.
 *
 * Three facts per row and no more: which copy it is, who has it, and what is in it. The
 * pane number is the useful form of "who" - it is also the Ctrl key that switches there -
 * and pressing the row does that switch, which is the whole reason this list is worth
 * having over the tooltip that was already on the chip.
 */
function CopyRow({ copy, onFocus }: { copy: Copy; onFocus: (id: string) => void }): JSX.Element {
  const { dir, slot, entry, pane, work, self, trunk } = copy
  // A pane number is the useful form of "who has it" - it is the Ctrl key that switches
  // there - and it beats the ledger's own words, which can only name a chat. With neither,
  // the ledger's sentence is all there is; with no ledger row either, the folder is simply
  // sitting there and saying "free" would be a claim nothing here can make.
  const held = pane
    ? `${paneRef(pane.number)}${pane.working ? ' - working now' : ''}`
    : entry
      ? laneState(entry, false, Date.now())
      : 'no pane here'
  const doing = laneDoing(work ?? null)
  const counts =
    work === undefined
      ? trunk
        ? 'the copy every lane merges back into'
        : 'reading…'
      : work
        ? summary(work)
        : trunk
          ? 'the copy every lane merges back into'
          : 'nothing in it'

  return (
    <div
      className={
        'lane-copy' +
        (self ? ' self' : '') +
        (entry?.conflicted ? ' stuck' : '') +
        (entry?.ready ? ' done' : '') +
        (entry && laneBusy(entry) ? ' busy' : '')
      }
      role={pane && !self ? 'button' : undefined}
      onClick={pane && !self ? () => onFocus(pane.id) : undefined}
      title={
        `${dir}${entry?.branch ? ` (${entry.branch})` : ''}` +
        (self ? '\nThis pane.' : pane ? `\nClick to switch to ${paneRef(pane.number)}.` : '') +
        (entry?.seen ? `\nIts chat was last heard from ${ago(entry.seen)} ago.` : '')
      }
    >
      <span className="lane-copy-tag">{slot}</span>
      <div className="lane-copy-text">
        <div className="lane-copy-title">
          {trunk ? 'main checkout' : `lane ${slot}`}
          {self ? ' - this pane' : ''}
          <span className="lane-copy-held"> {held}</span>
        </div>
        <div className="lane-copy-sub">{doing || counts}</div>
      </div>
    </div>
  )
}
