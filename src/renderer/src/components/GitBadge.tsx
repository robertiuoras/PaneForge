import { useEffect, useState } from 'react'
import type { GitInfo } from '@shared/types'
import { describePlace } from '@shared/place'
import { appVisible, onAppVisible } from '../appVisible'

const api = window.api

interface Props {
  cwd: string
  /** hidden panes stop polling; the main process caches anyway, but this keeps it free */
  active: boolean
  /** the worktree copy this pane was given ("w2"), when it was given one */
  lane?: string
  /** this pane's Ctrl-N number, so the tooltip names it the way the sidebar does */
  pane?: number
}

/**
 * Where this pane is, and whether anything has changed there.
 *
 * It used to print the branch alone, which is the fact that says least when it is
 * `master`: four panes in four different projects all read "master", and the header said
 * nothing at all about which project any of them was in. So the label starts with the
 * PROJECT now, and the branch is appended only when it is telling you something the
 * project name is not - not on the trunk, and not when it is a branch some tool generated
 * to hold a worktree. shared/place.ts owns those rules and is tested without a window.
 *
 * The separate `lane` chip that used to sit beside this is gone with it: "w2" next to
 * "master" was two chips about one place, and neither of them named the place.
 */
export default function GitBadge({ cwd, active, lane, pane }: Props): JSX.Element | null {
  const [info, setInfo] = useState<GitInfo | null>(null)

  useEffect(() => {
    if (!active) return
    let live = true
    const poll = (): void => {
      // A minimised window has nobody reading this badge, and every poll is a `git status`
      // process against a real working tree. The check used to be `document.hidden`, which
      // is pinned false in this window (see appVisible.ts) - so this had never once
      // skipped a poll, and a minimised app kept spawning git for a badge on nothing.
      void appVisible().then((v) => {
        if (!v || !live) return
        api.gitInfo(cwd).then((g) => live && setInfo(g))
      })
    }
    poll()
    // Matched to the main process cache, so a grid of panes costs one status per repo
    // per tick rather than one per pane.
    const t = window.setInterval(poll, 6000)
    // Coming back to the window should be current straight away rather than up to six
    // seconds stale.
    const off = onAppVisible(poll)
    return () => {
      live = false
      window.clearInterval(t)
      off()
    }
  }, [cwd, active])

  // Drawn before git answers, and drawn at all for a folder that is not a repository:
  // the project name is the part that was missing, and it does not come from git. Only
  // the counts wait for `info`.
  const place = describePlace({ cwd, branch: info?.branch, lane, pane })
  // The branch earned a place on the label, so it earns one on the badge.
  const showBranch = !place.onTrunk && place.short.endsWith(place.branch)
  const tip = [
    place.full,
    info
      ? [
          info.dirty ? `${info.dirty} changed (${info.staged} staged)` : 'clean',
          info.ahead ? `${info.ahead} to push` : '',
          info.behind ? `${info.behind} to pull` : ''
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span className={'git-badge' + (info?.dirty ? ' dirty' : '')} title={tip}>
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
        <circle cx="4.5" cy="3.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="4.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="11.5" cy="7" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4.5 5.3v5.4M6.3 7h3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="git-project">{place.project}</span>
      {/* Lit, because "am I in the right one of these two checkouts" is the question this
          badge exists to answer without a click. */}
      {place.slot && <span className="git-slot">{place.role}</span>}
      {showBranch && <span className="git-branch">{place.branch}</span>}
      {!!info?.dirty && <span className="git-count">{info.dirty}</span>}
      {!!info?.ahead && <span className="git-count up">↑{info.ahead}</span>}
    </span>
  )
}
