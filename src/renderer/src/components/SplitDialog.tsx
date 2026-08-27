// "Split this ask into panes."
//
// The counterpart to SwarmDialog: that one is several agents on ONE mission in ONE folder,
// this one is one long ask broken into the parts that do not need each other, a pane each.
// The reading is done by an agent CLI run once, headlessly (`main/splitPrompt.ts`); the
// rules that must hold whatever the model answers are in `shared/splitPlan.ts`.
//
// Nothing is opened until it has been read: the plan is drawn as editable rows, because
// the prompt a pane is opened with is the only thing that pane will ever be told, and a
// brief that is slightly wrong is twenty minutes of an agent being confidently wrong.
//
// Layout is the app's own dialog shape - `.overlay` / `.dialog` / `.dialog-head`, the same
// as SwarmDialog and NewSessionDialog - so it inherits the theme rather than inventing a
// second one. Every colour here is a token from `shared/theme.ts`.

import { useState } from 'react'
import type { Project, StartSessionRequest } from '@shared/types'
import { MIN_CHARS, splitWords, type SplitTask } from '@shared/splitPlan'
import Blurb from './Blurb'
import Select from './Select'

const api = window.api

interface Props {
  projects: Project[]
  /** Where the split itself runs, and the fallback folder for a task that names none. */
  cwd?: string
  /** Prefilled ask, when something already holds the words. */
  initial?: string
  onLaunch: (reqs: StartSessionRequest[]) => void
  onClose: () => void
}

/** A row as the dialog holds it: the plan's task plus the folder it will actually open in. */
interface Row extends SplitTask {
  path: string
}

/**
 * Which project a task's `project` names.
 *
 * The model answers a NAME ("toolstash"), never a path, so the match is against the real
 * project list and a name that matches nothing falls back to the folder the dialog was
 * opened on. Longest name first, so `service` inside `service-a` cannot win over it - the
 * same rule the mascot's parser uses.
 */
export function pathFor(name: string | undefined, projects: Project[], fallback: string): string {
  const want = (name ?? '').trim().toLowerCase()
  if (!want) return fallback
  const byName = [...projects].sort((a, b) => b.name.length - a.name.length)
  const hit =
    byName.find((p) => p.name.toLowerCase() === want) ??
    byName.find((p) => want.includes(p.name.toLowerCase()))
  return hit?.path ?? fallback
}

export default function SplitDialog({
  projects,
  cwd,
  initial,
  onLaunch,
  onClose
}: Props): React.JSX.Element {
  const [text, setText] = useState(initial ?? '')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fallback = cwd ?? projects[0]?.path ?? ''

  const split = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setRows(null)
    const answer = await api.splitPrompt(text)
    setBusy(false)
    if ('error' in answer && answer.error) {
      setError(answer.error)
      return
    }
    const plan = answer as { tasks: SplitTask[]; dropped: string[] }
    setNote(splitWords(plan))
    setRows(plan.tasks.map((t) => ({ ...t, path: pathFor(t.project, projects, fallback) })))
  }

  const edit = (i: number, patch: Partial<Row>): void =>
    setRows((r) => (r ? r.map((row, n) => (n === i ? { ...row, ...patch } : row)) : r))

  const launch = (): void => {
    if (!rows?.length) return
    onLaunch(
      rows
        .filter((r) => r.prompt.trim() && r.path)
        .map((r) => ({
          cwd: r.path,
          title: projects.find((p) => p.path === r.path)?.name,
          prompt: r.prompt.trim()
        }))
    )
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Split an ask into panes</strong>
          <span className="hint">One long request, one pane per part that can run alone</span>
        </div>
        <Blurb id="split" />

        <textarea
          className="split-ask"
          rows={6}
          autoFocus
          placeholder="Paste the whole thing. Six jobs in one message is what this is for."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {error && <div className="split-error">{error}</div>}
        {rows && !error && <div className="hint split-note">{note}</div>}

        {rows?.map((r, i) => (
          <div className="split-row" key={i}>
            <div className="split-row-head">
              <input
                className="search split-title"
                value={r.title}
                onChange={(e) => edit(i, { title: e.target.value })}
              />
              <Select
                value={r.path}
                onChange={(path) => edit(i, { path })}
                options={projects.map((p) => ({ value: p.path, label: p.name }))}
              />
            </div>
            <textarea
              className="split-ask"
              rows={4}
              value={r.prompt}
              onChange={(e) => edit(i, { prompt: e.target.value })}
            />
          </div>
        ))}

        <div className="dialog-foot">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="ghost"
            disabled={busy || text.trim().length < MIN_CHARS}
            title={
              text.trim().length < MIN_CHARS
                ? `An ask this short is one pane - ${MIN_CHARS} characters is the floor`
                : 'Read it and propose the panes'
            }
            onClick={() => void split()}
          >
            {busy ? 'Reading…' : rows ? 'Split again' : 'Split it'}
          </button>
          <button className="primary" disabled={!rows?.length} onClick={launch}>
            {rows?.length ? `Open ${rows.length} pane${rows.length > 1 ? 's' : ''}` : 'Open panes'}
          </button>
        </div>
      </div>
    </div>
  )
}
