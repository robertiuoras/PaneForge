import { useCallback, useEffect, useState } from 'react'
import type { PullsAnswer } from '@shared/types'
import {
  agoWords,
  branchWords,
  needsSomebody,
  pullWords,
  sortPulls,
  unsavedWords,
  type PullRow,
  type RepoPulls
} from '@shared/pulls'
import useDialogFocus from './useDialogFocus'

const api = window.api

/**
 * Everything waiting on GitHub for the projects open on this desk, on one screen.
 *
 * Rows follow the app's own `tool-action` pattern and the badge scale measured off
 * Linear in `design-vault/linear.app.md` (12px / 510). Nothing here polls: the dialog
 * asks once when it opens, and the button asks again.
 *
 * The local half is the part GitHub cannot tell anyone about, and it is the half that
 * gets forgotten: work sitting on this machine that has never been pushed.
 */
export default function PullsDialog({ cwds, onClose }: {
  cwds: string[]
  onClose(): void
}): JSX.Element {
  const box = useDialogFocus()
  const [answer, setAnswer] = useState<PullsAnswer | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true)
      void api.pulls(cwds, refresh).then((a) => {
        setAnswer(a)
        setLoading(false)
      })
    },
    [cwds.join('|')]
  )
  useEffect(() => load(false), [load])

  const now = Date.now()
  const empty =
    answer &&
    !answer.blocked &&
    answer.repos.every((r) => !r.pulls.length && !r.branches.length && !r.unsaved)

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog pulls-dialog"
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pulls-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <strong id="pulls-title">Waiting on GitHub</strong>
          <button className="ghost small" disabled={loading} onClick={() => load(true)}>
            {loading ? 'Looking…' : 'Look again'}
          </button>
          <button className="ghost small" aria-label="Close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="pulls-body">
          {!answer && loading && <p className="hint">Asking GitHub about your projects…</p>}
          {answer?.blocked && <p className="hint warn">{answer.blocked}</p>}
          {empty && (
            <div className="tools-empty">
              <strong>Nothing is waiting</strong>
              <p>
                No open pull requests, and every change on this machine is already in the
                main copy of its project.
              </p>
            </div>
          )}
          {answer?.repos.map((repo) => (
            <Repo key={repo.path} repo={repo} now={now} />
          ))}
          {answer && !loading && (
            <p className="hint dim">
              Read {agoWords(answer.at, now)}. Only the projects with a session open here.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Repo({ repo, now }: { repo: RepoPulls; now: number }): JSX.Element | null {
  if (!repo.pulls.length && !repo.branches.length && !repo.trouble && !repo.unsaved) return null
  const pulls = sortPulls(repo.pulls)
  const loose = repo.branches.filter((b) => !b.pushed)
  const pushed = repo.branches.filter((b) => b.pushed)
  return (
    <section className="pulls-repo">
      <div className="pr-head">
        <strong>{repo.name}</strong>
        {repo.remote ? (
          <small>{repo.remote}</small>
        ) : (
          <small>not on GitHub</small>
        )}
      </div>
      {repo.trouble && <p className="hint warn">{repo.trouble}</p>}
      {pulls.map((p) => (
        <button
          className="ghost tool-action pr-row"
          key={p.url}
          onClick={() => api.openExternal(p.url)}
        >
          <span className={'pr-dot ' + dotClass(p)} aria-hidden="true" />
          <span>
            <strong>{p.title}</strong>
            <small>
              {pullWords(p)} · #{p.number} · {p.mine ? 'yours' : p.author} ·{' '}
              {agoWords(p.updatedAt, now)}
            </small>
          </span>
        </button>
      ))}
      {loose.map((b) => (
        <div className="tool-action pr-row flat" key={'l' + b.name}>
          <span className="pr-dot local" aria-hidden="true" />
          <span>
            <strong>{b.name}</strong>
            <small>
              {branchWords(b, repo.main)} · {agoWords(b.updatedAt, now)}
            </small>
          </span>
        </div>
      ))}
      {repo.unsaved > 0 && (
        <div className="tool-action pr-row flat">
          <span className="pr-dot local" aria-hidden="true" />
          <span>
            <strong>In this folder right now</strong>
            <small>{unsavedWords(repo.unsaved)}</small>
          </span>
        </div>
      )}
      {pushed.map((b) => (
        <div className="tool-action pr-row flat" key={'p' + b.name}>
          <span className="pr-dot waiting" aria-hidden="true" />
          <span>
            <strong>{b.name}</strong>
            <small>
              {branchWords(b, repo.main)} · no pull request yet · {agoWords(b.updatedAt, now)}
            </small>
          </span>
        </div>
      ))}
    </section>
  )
}

/** The dot's colour is the row's own sentence, not a severity scale of its own. */
function dotClass(p: PullRow): string {
  if (p.draft) return 'draft'
  if (p.checks === 'failing' || !p.mergeable || p.review === 'changes') return 'bad'
  if (p.checks === 'running') return 'running'
  if (p.review === 'approved') return 'good'
  return needsSomebody(p) ? 'waiting' : 'good'
}
