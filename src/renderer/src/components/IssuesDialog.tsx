import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaneBoard, LaneWork, Session } from '@shared/types'
import { folderName, laneLabel } from '../laneWords'

const api = window.api

export type Issue = { key: string; title: string; detail: string; level: 'danger' | 'warning' }

export function folderInspectionResults(boards: LaneBoard[], results: PromiseSettledResult<string[] | null>[]): { folders: Record<string, string[]>; failed: boolean } {
  const folders: Record<string, string[]> = {}
  let failed = false
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled' || result.value === null) { failed = true; return }
    folders[boards[index].repo] = result.value
  })
  return { folders, failed }
}

/**
 * Turn the facts PaneForge already has into deliberately conservative warnings.  A missing
 * inspection is not evidence that a checkout is clean, so callers add its failure separately.
 */
const pathKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

export function laneIssues(boards: LaneBoard[], _sessions: Session[], work: Record<string, LaneWork | null>, folders: Record<string, string[]> = {}): Issue[] {
  const issues: Issue[] = []
  for (const board of boards) {
    const ledger = new Set(board.lanes.map(lane => pathKey(lane.dir)))
    if (board.hold) issues.push({ key: `${board.repo}:hold`, level: 'warning', title: `${folderName(board.repo)} release is held`, detail: board.hold.reason })
    for (const lane of board.lanes) {
      // Main is the base checkout, not a disposable copy. laneWork intentionally answers
      // null for it, so inspecting it would turn every board into a false warning.
      if (lane.lane === 'main') continue
      const name = laneLabel(lane)
      if (lane.conflicted) issues.push({ key: `${board.repo}:${lane.lane}:conflict`, level: 'danger', title: `${name} cannot merge`, detail: lane.conflictDetail || 'The lane has a merge conflict and remains outside a release.' })
      if (lane.peer) continue
      if (lane.gone) issues.push({ key: `${board.repo}:${lane.lane}:assignment`, level: 'warning', title: `${name} has a stale assignment`, detail: 'The lane backend confirmed its holder is gone. The lane remains held until its safety rules reclaim it.' })
      const inspected = work[lane.dir]
      if (inspected === null) {
        issues.push({ key: `${board.repo}:${lane.lane}:unknown`, level: 'warning', title: `${name} could not be inspected`, detail: 'PaneForge cannot confirm whether this known copy has work. Its safety is unknown.' })
        continue
      }
      if (inspected && (!lane.held || lane.gone) && (inspected.dirty > 0 || inspected.ahead > 0)) {
        const changes = [inspected.ahead ? `${inspected.ahead} unmerged commit${inspected.ahead === 1 ? '' : 's'}` : '', inspected.dirty ? `${inspected.dirty} uncommitted file${inspected.dirty === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')
        issues.push({ key: `${board.repo}:${lane.lane}:unowned-work`, level: 'danger', title: `${name} has work with no open pane`, detail: `${changes}. PaneForge will not discard it; inspect this copy before any lane cleanup.` })
      }
    }
    // These are physical worktrees that the ledger did not name. With no ledger record,
    // no holder exists to protect their changes, so any work is an orphan risk.
    for (const dir of folders[board.repo] ?? []) {
      if (ledger.has(pathKey(dir))) continue
      const inspected = work[dir]
      if (inspected === null) {
        issues.push({ key: `${board.repo}:${dir}:unknown`, level: 'warning', title: `${folderName(dir)} could not be inspected`, detail: 'PaneForge cannot confirm whether this physical copy has work. Its safety is unknown.' })
      } else if (inspected && (inspected.dirty > 0 || inspected.ahead > 0)) {
        const changes = [inspected.ahead ? `${inspected.ahead} unmerged commit${inspected.ahead === 1 ? '' : 's'}` : '', inspected.dirty ? `${inspected.dirty} uncommitted file${inspected.dirty === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')
        issues.push({ key: `${board.repo}:${dir}:physical-orphan`, level: 'danger', title: `${folderName(dir)} has work with no lane record`, detail: `${changes}. PaneForge will not discard it; inspect this copy before any lane cleanup.` })
      }
    }
  }
  return issues
}

function safeError(message: string): string {
  // Main already redacts detail to the footer. Persist only a generic receipt in browser
  // storage, so paths, command output and accidental secrets cannot be replayed here.
  return message.trim() ? 'PaneForge reported an error. Check the application error log for details.' : 'PaneForge reported an error.'
}

export function rememberIssueError(previous: string[], message: string): string[] {
  return [safeError(message), ...previous].slice(0, 8)
}

export function readIssueErrors(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed.slice(0, 8) : []
  } catch { return [] }
}

export default function IssuesDialog({ boards, sessions, errors, onClose }: { boards: LaneBoard[]; sessions: Session[]; errors: string[]; onClose(): void }): JSX.Element {
  const [work, setWork] = useState<Record<string, LaneWork | null>>({})
  const [folders, setFolders] = useState<Record<string, string[]>>({})
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const inspect = (): void => {
    setChecking(true); setCheckError(''); setWork({}); setFolders({})
    void Promise.allSettled(boards.map(board => api.laneFolders(board.repo))).then(folderResults => {
      const enumerated = folderInspectionResults(boards, folderResults)
      const nextFolders = enumerated.folders
      const dirs = new Set<string>()
      folderResults.forEach((result, index) => {
        if (result.status !== 'fulfilled' || result.value === null) return
        result.value.forEach(dir => dirs.add(dir))
      })
      if (enumerated.failed) setCheckError('Some physical copies could not be listed. Their safety is unknown.')
      // Keep ledger-only entries too: a failure to list physical copies must not erase a
      // known lane from the conservative inspection.
      boards.flatMap(board => board.lanes.filter(lane => !lane.peer && lane.lane !== 'main').map(lane => lane.dir)).forEach(dir => dirs.add(dir))
      setFolders(nextFolders)
      return Promise.allSettled([...dirs].map(dir => api.laneWork(dir).then(value => [dir, value] as const).catch(() => [dir, null] as const)))
    }).then(results => {
      const next: Record<string, LaneWork | null> = {}
      results.forEach(result => {
        if (result.status === 'fulfilled') next[result.value[0]] = result.value[1]
      })
      setWork(next)
    }).catch(() => setCheckError('Known copies could not be listed. Their safety is unknown.')).finally(() => setChecking(false))
  }
  useEffect(inspect, [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus()
  }, [])
  const issues = useMemo(() => laneIssues(boards, sessions, work, folders), [boards, sessions, work, folders])
  return <div className="overlay" onMouseDown={onClose}>
    <div ref={dialog} className="dialog issues-dialog" role="dialog" aria-modal="true" aria-labelledby="issues-title" onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <div className="dialog-head"><strong id="issues-title">Issues</strong><span className="hint">Current lane safety checks</span><button className="ghost small" aria-label="Close Issues" onClick={onClose}>Close</button></div>
      <div className="issues-body">
        <div className="issues-heading"><p className="hint">Checks run when this opens. They report known problems only and never repair, commit, merge or remove work.</p><button className="ghost small" disabled={checking} onClick={inspect}>{checking ? 'Checking…' : 'Refresh'}</button></div>
        {checkError && <p className="issues-row danger" role="alert">{checkError}</p>}
        {issues.map(issue => <article className={`issues-row ${issue.level}`} key={issue.key}><strong>{issue.title}</strong><p>{issue.detail}</p></article>)}
        {errors.map((error, index) => <article className="issues-row warning" key={`error-${index}`}><strong>Captured application error</strong><p>{error}</p></article>)}
        {!checking && !checkError && !issues.length && !errors.length && <p className="issues-empty">No issues were found in the checked known copies. This is not a backup audit.</p>}
      </div>
    </div>
  </div>
}
