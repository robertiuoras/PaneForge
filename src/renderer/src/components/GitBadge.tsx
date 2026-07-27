import { useEffect, useState } from 'react'
import type { GitInfo } from '@shared/types'
import { appVisible, onAppVisible } from '../appVisible'

const api = window.api

interface Props {
  cwd: string
  /** hidden panes stop polling; the main process caches anyway, but this keeps it free */
  active: boolean
}

/**
 * Branch and uncommitted-file count for the pane's folder. An agent editing files is
 * the normal case here, so seeing the working tree go dirty (and on which branch) is
 * the fastest signal that it actually did something.
 */
export default function GitBadge({ cwd, active }: Props): JSX.Element | null {
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

  if (!info) return null
  const tip = [
    `branch ${info.branch}`,
    info.dirty ? `${info.dirty} changed (${info.staged} staged)` : 'clean',
    info.ahead ? `${info.ahead} to push` : '',
    info.behind ? `${info.behind} to pull` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span className={'git-badge' + (info.dirty ? ' dirty' : '')} title={tip}>
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
        <circle cx="4.5" cy="3.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="4.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="11.5" cy="7" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M4.5 5.3v5.4M6.3 7h3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span className="git-branch">{info.branch}</span>
      {info.dirty > 0 && <span className="git-count">{info.dirty}</span>}
      {info.ahead > 0 && <span className="git-count up">↑{info.ahead}</span>}
    </span>
  )
}
