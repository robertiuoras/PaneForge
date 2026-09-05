import { useEffect, useRef, useState } from 'react'
import type { ProjectBoard, TaskItem, TaskStatus } from '@shared/types'
import Blurb from './Blurb'
import './board-swarm.css'

const api = window.api
interface Props {
  cwd: string
  onSend?: (text: string) => void
  onClose: () => void
}
const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'done', label: 'Done' }
]

export default function BoardDialog({ cwd, onSend, onClose }: Props): JSX.Element {
  const [board, setBoard] = useState<ProjectBoard | null>(null)
  const [draft, setDraft] = useState('')
  const [memory, setMemory] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [retryMemory, setRetryMemory] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const request = useRef(0)
  const saveRequest = useRef(0)
  const memoryVersion = useRef(0)
  const load = (): void => {
    const turn = ++request.current
    setLoading(true)
    setError('')
    setRetryMemory(false)
    void api
      .board(cwd)
      .then((next) => {
        if (turn !== request.current) return
        setBoard(next)
        setMemory(next.memory)
        setDirty(false)
      })
      .catch(() => turn === request.current && setError('Could not load this board.'))
      .finally(() => turn === request.current && setLoading(false))
  }
  useEffect(() => {
    load() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])
  const requestClose = (): void => {
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      requestClose()
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  })
  const saveTasks = async (tasks: TaskItem[]): Promise<boolean> => {
    if (!board || saving) return false
    const turn = request.current
    const saveTurn = ++saveRequest.current
    setSaving(true)
    setError('')
    try {
      const next = await api.saveTasks(cwd, tasks)
      if (turn !== request.current) return false
      // The main process deliberately tolerates a read-only project folder. Its reply is
      // then the old board, so treat that as a failed save instead of pretending it worked.
      if (JSON.stringify(next.tasks) !== JSON.stringify(tasks)) {
        setError('Could not save the task change. The project folder may be read-only.')
        return false
      }
      setBoard(next)
      return true
    } catch {
      if (turn === request.current) setError('Could not save the task change. Your board was not changed.')
      return false
    } finally {
      if (saveTurn === saveRequest.current) setSaving(false)
    }
  }
  const add = (): void => {
    const title = draft.trim()
    if (!title || !board || saving) return
    void saveTasks([
      ...board.tasks,
      {
        id: `t${Date.now().toString(36)}`,
        title,
        status: 'todo',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]).then((saved) => saved && setDraft(''))
  }
  const move = (task: TaskItem, status: TaskStatus): void => {
    if (board)
      void saveTasks(
        board.tasks.map((item) => (item.id === task.id ? { ...item, status, updatedAt: Date.now() } : item))
      )
  }
  const remove = (task: TaskItem): void => {
    if (board) void saveTasks(board.tasks.filter((item) => item.id !== task.id))
  }
  const saveMemory = async (): Promise<void> => {
    if (!dirty || saving) return
    const turn = request.current
    const saveTurn = ++saveRequest.current
    const savedMemory = memory
    const savedVersion = memoryVersion.current
    setSaving(true)
    setError('')
    try {
      const next = await api.saveMemory(cwd, savedMemory)
      if (turn !== request.current) return
      if (next.memory !== savedMemory) {
        setError('Could not save shared memory. Your unsaved text is still here.')
        setRetryMemory(true)
        return
      }
      setBoard(next)
      if (memoryVersion.current === savedVersion) {
        setMemory(next.memory)
        setDirty(false)
      }
    } catch {
      if (turn === request.current) {
        setError('Could not save shared memory. Your unsaved text is still here.')
        setRetryMemory(true)
      }
    } finally {
      if (saveTurn === saveRequest.current) setSaving(false)
    }
  }
  return (
    <div className="overlay" onMouseDown={requestClose}>
      <div className="dialog wide pf-board-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Board</strong>
          <span className="hint">{cwd}</span>
        </div>
        <Blurb id="board" />
        <div className="pf-board-add">
          <input
            className="search"
            aria-label="New task"
            placeholder="Add a task"
            value={draft}
            disabled={loading || saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && add()}
          />
          <button className="primary pf-touch" disabled={!draft.trim() || loading || saving} onClick={add}>
            Add task
          </button>
        </div>
        {error && (
          <div className="pf-feedback error" role="alert">
            {error}{' '}
            <button className="ghost small" onClick={() => (retryMemory ? void saveMemory() : load())}>
              {retryMemory ? 'Retry save' : 'Retry'}
            </button>
          </div>
        )}
        {loading ? (
          <div className="pf-board-loading">Loading board…</div>
        ) : (
          <div className="pf-board">
            {COLUMNS.map((column) => {
              const tasks = board?.tasks.filter((task) => task.status === column.key) ?? []
              return (
                <section key={column.key} className="pf-board-col" aria-label={column.label}>
                  <div className="pf-board-head">
                    <strong>{column.label}</strong>
                    <span className="chip">{tasks.length}</span>
                  </div>
                  {tasks.map((task) => (
                    <article key={task.id} className="pf-task">
                      <div className="pf-task-title">{task.title}</div>
                      <div className="pf-task-actions">
                        {column.key !== 'todo' && (
                          <button
                            className="ghost small pf-touch"
                            disabled={saving}
                            onClick={() => move(task, prev(column.key))}
                          >
                            Move to {label(prev(column.key))}
                          </button>
                        )}
                        {column.key !== 'done' && (
                          <button
                            className="ghost small pf-touch"
                            disabled={saving}
                            onClick={() => move(task, next(column.key))}
                          >
                            Move to {label(next(column.key))}
                          </button>
                        )}
                        {onSend && (
                          <button className="ghost small pf-touch" onClick={() => onSend(task.title)}>
                            Send to pane
                          </button>
                        )}
                        <button
                          className="ghost small pf-touch danger"
                          disabled={saving}
                          onClick={() => remove(task)}
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                  {!tasks.length && <div className="empty">No tasks yet</div>}
                </section>
              )
            })}
          </div>
        )}
        <div className="setting pf-memory-setting">
          <div className="setting-row">
            <label>Shared memory</label>
            <span className="hint">
              Agents in this folder read <code>.paneforge/MEMORY.md</code> first.
            </span>
          </div>
          <textarea
            className="memory"
            rows={8}
            value={memory}
            disabled={loading}
            onChange={(event) => {
              setMemory(event.target.value)
              memoryVersion.current++
              setDirty(true)
            }}
          />
        </div>
        <div className="dialog-row">
          <span className="hint">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
          <button className="ghost pf-touch" onClick={requestClose}>
            Close
          </button>
          <button
            className="primary pf-touch"
            disabled={!dirty || saving || loading}
            onClick={() => void saveMemory()}
          >
            {saving ? 'Saving…' : 'Save memory'}
          </button>
        </div>
      </div>
      {confirmDiscard && (
        <div className="overlay" onMouseDown={(event) => event.stopPropagation()}>
          <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-head">
              <strong>Discard unsaved memory?</strong>
            </div>
            <p className="hint">Your shared-memory edits have not been saved.</p>
            <div className="dialog-row">
              <button className="ghost pf-touch" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </button>
              <button className="primary pf-touch" onClick={onClose}>
                Discard and close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
const prev = (status: TaskStatus): TaskStatus => (status === 'done' ? 'doing' : 'todo')
const next = (status: TaskStatus): TaskStatus => (status === 'todo' ? 'doing' : 'done')
const label = (status: TaskStatus): string => COLUMNS.find((column) => column.key === status)?.label ?? status
