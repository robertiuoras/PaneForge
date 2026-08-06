import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffFile, DiffScope, DiffSet } from '@shared/types'
import { parsePatch } from '@shared/patch'
import { describePlace } from '@shared/place'
import Blurb from './Blurb'

const api = window.api

interface Props {
  cwd: string
  /** the worktree copy this pane was given, so the head names the place the way the pane does */
  lane?: string
  pane?: number
  /** what to show first - a lane chip opens on the whole lane, a pane on what is uncommitted */
  scope?: DiffScope
  onClose: () => void
}

/**
 * What the agent in this folder has actually changed.
 *
 * The app has shown a COUNT next to every pane for months, and the lane chip offered to
 * merge on the strength of it. "17 changed" and a merge button is not review. This is the
 * missing half: the files, and the lines in them, without leaving the window and without
 * asking the agent to print a diff into its own terminal - which is the workaround it
 * replaces, and which costs a turn, scrolls away, and cannot be scrolled back through.
 *
 * Three scopes, because "what changed" is three different questions with four agents
 * running, and the useful one depends on whether this pane is in a lane. Uncommitted work
 * is what an agent has done since it last committed; the branch is the whole piece of
 * work; both together is the lane's answer to "what has this done to my repo", which is
 * the question the merge button is really asking.
 *
 * Nothing here writes: no staging, no committing, no discarding. Reading is the whole
 * feature, and a review dialog that can also destroy an hour of an agent's work with a
 * misclick is a worse trade than leaving those to the pane's own agent.
 */
export default function DiffDialog({ cwd, lane, pane, scope: first, onClose }: Props): JSX.Element {
  const [scope, setScope] = useState<DiffScope>(first ?? 'all')
  const [set, setSet] = useState<DiffSet | undefined>(undefined)
  const [path, setPath] = useState<string | null>(null)
  const [patch, setPatch] = useState<{ path: string; text: string; truncated: boolean } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // The file list is re-read for every scope rather than cached per scope: an agent is
  // editing this folder while the dialog is open, so a remembered list is a wrong list.
  useEffect(() => {
    let live = true
    setSet(undefined)
    setPatch(null)
    void api.diffFiles(cwd, scope).then((d) => {
      if (!live) return
      setSet(d)
      // Land on something readable rather than an empty right-hand pane. The first file
      // with actual lines in it, since a diff often opens on a lockfile alphabetically.
      const pick = d.files.find((f) => !f.binary && f.added + f.removed > 0) ?? d.files[0]
      setPath(pick ? pick.path : null)
    })
    return () => {
      live = false
    }
  }, [cwd, scope])

  const files = set?.files ?? []
  const current = files.find((f) => f.path === path) ?? null

  useEffect(() => {
    if (!current) {
      setPatch(null)
      return
    }
    let live = true
    setPatch(null)
    void api.diffPatch(cwd, scope, current.path, current.untracked).then((p) => {
      if (live) setPatch(p)
    })
    return () => {
      live = false
    }
  }, [cwd, scope, current?.path, current?.untracked])

  const parsed = useMemo(() => (patch ? parsePatch(patch.text, patch.truncated) : null), [patch])

  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 }
  )

  // Up and down walk the file list, which is the only navigation a review needs and the
  // one a mouse is worst at with sixty files in the list.
  const step = (by: number): void => {
    if (!files.length) return
    const at = files.findIndex((f) => f.path === path)
    const next = files[Math.min(files.length - 1, Math.max(0, (at < 0 ? 0 : at) + by))]
    if (next) setPath(next.path)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '')) return
      e.preventDefault()
      step(e.key === 'ArrowDown' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  // Keep the selected row on screen when the keyboard is what moved it.
  useEffect(() => {
    listRef.current?.querySelector('.diff-file.on')?.scrollIntoView({ block: 'nearest' })
  }, [path])

  const place = describePlace({ cwd, branch: set?.branch, lane, pane })
  const scopes: { id: DiffScope; label: string; tip: string }[] = [
    { id: 'working', label: 'Uncommitted', tip: 'Everything not committed yet, including files git has never seen.' },
    {
      id: 'branch',
      label: 'This branch',
      tip: set?.base ? `Every commit ${set.branch} has that ${set.base} does not.` : 'Every commit this branch has that its base does not.'
    },
    { id: 'all', label: 'Everything', tip: 'Both at once - the whole difference between this folder and its base branch.' }
  ]

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide tall diff" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Changes</strong>
          <span className="hint">
            {place.full}
            {set?.base && scope !== 'working' ? ` · against ${set.base}` : ''}
          </span>
        </div>
        <Blurb id="changes" />

        <div className="diff-scopes">
          {scopes.map((s) => (
            <button
              key={s.id}
              className={'ghost small' + (scope === s.id ? ' on' : '')}
              title={s.tip}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
          <span className="diff-totals">
            {set === undefined ? (
              'Reading…'
            ) : (
              <>
                {files.length} file{files.length === 1 ? '' : 's'}
                {totals.added ? <span className="diff-plus"> +{totals.added}</span> : null}
                {totals.removed ? <span className="diff-minus"> −{totals.removed}</span> : null}
                {set.truncated ? ' · list cut short' : ''}
              </>
            )}
          </span>
        </div>

        {set?.problem && <div className="diff-problem">{set.problem}</div>}

        <div className="diff-body">
          <div className="diff-files" ref={listRef}>
            {set !== undefined && !files.length && !set.problem && (
              <div className="empty">
                {scope === 'working' ? 'Nothing uncommitted here.' : 'Nothing this branch has that its base does not.'}
              </div>
            )}
            {files.map((f) => (
              <button
                key={f.path}
                className={'diff-file' + (f.path === path ? ' on' : '')}
                onClick={() => setPath(f.path)}
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <span className={'diff-status ' + f.status} aria-hidden="true">
                  {f.untracked ? 'N' : f.status[0].toUpperCase()}
                </span>
                <span className="diff-name">
                  <span className="diff-dir">{dirOf(f.path)}</span>
                  {baseOf(f.path)}
                </span>
                {f.binary ? (
                  <span className="diff-counts hint">binary</span>
                ) : (
                  <span className="diff-counts">
                    {f.added ? <span className="diff-plus">+{f.added}</span> : null}
                    {f.removed ? <span className="diff-minus">−{f.removed}</span> : null}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="diff-patch">
            {!current && <div className="empty">Pick a file.</div>}
            {current && !parsed && <div className="empty">Reading {current.path}…</div>}
            {current && parsed && parsed.binary && (
              <div className="empty">Binary file - there is nothing to show as lines.</div>
            )}
            {current && parsed && !parsed.binary && !parsed.hunks.length && (
              <div className="empty">
                {current.status === 'renamed'
                  ? `Renamed from ${current.oldPath}, with no changes to its contents.`
                  : 'No line changes - only the file mode or its name changed.'}
              </div>
            )}
            {current && parsed?.hunks.map((h, i) => (
              <div className="diff-hunk" key={i}>
                <div className="diff-hunk-head">
                  @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                  {h.heading ? <span className="diff-hunk-fn"> {h.heading}</span> : null}
                </div>
                {h.lines.map((l, j) => (
                  <div className={'diff-line ' + l.kind} key={j}>
                    <span className="diff-no">{l.oldNo ?? ''}</span>
                    <span className="diff-no">{l.newNo ?? ''}</span>
                    <span className="diff-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                    <span className="diff-text">{l.text || ' '}</span>
                  </div>
                ))}
              </div>
            ))}
            {parsed?.truncated && (
              <div className="diff-problem">
                This file is too big to show whole; everything above is the start of it.
              </div>
            )}
          </div>
        </div>

        <div className="dialog-row">
          <span className="hint">↑↓ moves between files. Nothing here changes anything.</span>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** The folder part, dimmed, so a list of forty files reads by filename first. */
function dirOf(p: string): string {
  const at = p.lastIndexOf('/')
  return at < 0 ? '' : p.slice(0, at + 1)
}
function baseOf(p: string): string {
  const at = p.lastIndexOf('/')
  return at < 0 ? p : p.slice(at + 1)
}
