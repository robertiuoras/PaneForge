import { useEffect, useState } from 'react'
import type { LaneMergeResult, LaneWork } from '@shared/types'

const api = window.api

/**
 * What is in this pane's lane, and the one button that ends it.
 *
 * A lane is created without being asked (lanes.ts), and until now nothing ever ended
 * one: the commits stayed on `lane-a` and the folder stayed on disk. The lane chip on the
 * pane opens this, which answers the two questions that actually come up - "what is in
 * here?" and "how do I get it back into main?" - and refuses in plain words when the
 * merge is not safe, because the alternative is an agent being told to sort out a
 * half-finished merge in a folder the user has forgotten about.
 *
 * Nothing here deletes anything. An empty lane is swept by the app on its own; a lane
 * with work in it is only ever emptied by merging it.
 */
interface Props {
  cwd: string
  onClose: () => void
  /** open the "How lanes work" card */
  onHelp: () => void
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

export default function LaneDialog({ cwd, onClose, onHelp }: Props): JSX.Element {
  const [work, setWork] = useState<LaneWork | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const load = (): void => {
    void api.laneWork(cwd).then(setWork)
  }
  useEffect(load, [cwd])

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

  return (
    <div className="overlay confirm-overlay" onMouseDown={onClose}>
      <div className="dialog confirm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>{work ? `Lane ${work.lane}` : 'Lane'}</strong>
          <button className="ghost small lane-what" onClick={onHelp} title="How lanes work">
            what is this?
          </button>
        </div>
        {work === undefined && <div className="confirm-body">Reading the lane…</div>}
        {work === null && (
          <div className="confirm-body">This pane is not in a lane any more.</div>
        )}
        {work && (
          <div className="confirm-body">
            <div>
              <code>{work.branch}</code> → <code>{work.base}</code>
            </div>
            <div className="lane-dialog-sub">{summary(work)}</div>
            {work.conflicts.length > 0 && (
              <div className="lane-dialog-warn">
                Conflicts with {work.base}: {work.conflicts.join(', ')}
              </div>
            )}
            {said && <div className="lane-dialog-said">{said}</div>}
            {!said && stop && <div className="lane-dialog-sub">{stop}</div>}
          </div>
        )}
        <div className="dialog-row">
          <button className="ghost" onClick={onClose}>
            Close
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
