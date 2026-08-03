import { useEffect, useState } from 'react'
import type { ProjectBoard, TaskItem, TaskStatus } from '@shared/types'
import Blurb from './Blurb'

const api = window.api

interface Props {
  cwd: string
  /** send a task into the focused pane as a prompt */
  onSend?: (text: string) => void
  onClose: () => void
}

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'done', label: 'Done' }
]

/**
 * Tasks and shared memory for one project. Both files live in the project's own
 * `.paneforge/` folder rather than app storage, so the agents running in that
 * folder can read them - that is what makes this a coordination tool instead of
 * a private to-do list.
 */
export default function BoardDialog({ cwd, onSend, onClose }: Props): JSX.Element {
  const [board, setBoard] = useState<ProjectBoard | null>(null)
  const [draft, setDraft] = useState('')
  const [memory, setMemory] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api.board(cwd).then((b) => {
      setBoard(b)
      setMemory(b.memory)
    })
  }, [cwd])

  const save = (tasks: TaskItem[]): void => {
    setBoard((b) => (b ? { ...b, tasks } : b))
    api.saveTasks(cwd, tasks)
  }

  const add = (): void => {
    const title = draft.trim()
    if (!title || !board) return
    save([
      ...board.tasks,
      {
        id: `t${Date.now().toString(36)}`,
        title,
        status: 'todo',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ])
    setDraft('')
  }

  const move = (t: TaskItem, status: TaskStatus): void => {
    if (!board) return
    save(board.tasks.map((x) => (x.id === t.id ? { ...x, status, updatedAt: Date.now() } : x)))
  }

  const remove = (t: TaskItem): void => {
    if (!board) return
    save(board.tasks.filter((x) => x.id !== t.id))
  }

  const saveMemory = (): void => {
    api.saveMemory(cwd, memory).then(setBoard)
    setDirty(false)
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Board</strong>
          <span className="hint">{cwd}</span>
        </div>
        <Blurb id="board" />

        <div className="setting-row">
          <input
            className="search"
            placeholder="Add a task and press Enter"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="ghost" onClick={add}>
            Add
          </button>
        </div>

        <div className="board">
          {COLUMNS.map((col) => (
            <div key={col.key} className="board-col">
              <div className="board-head">
                {col.label}
                <span className="chip">{board?.tasks.filter((t) => t.status === col.key).length ?? 0}</span>
              </div>
              {board?.tasks
                .filter((t) => t.status === col.key)
                .map((t) => (
                  <div key={t.id} className="task">
                    <div className="task-title">{t.title}</div>
                    <div className="task-actions">
                      {col.key !== 'todo' && (
                        <button className="ghost small" title="Move left" onClick={() => move(t, prev(col.key))}>
                          ‹
                        </button>
                      )}
                      {col.key !== 'done' && (
                        <button className="ghost small" title="Move right" onClick={() => move(t, next(col.key))}>
                          ›
                        </button>
                      )}
                      {onSend && (
                        <button
                          className="ghost small"
                          title="Send this task to the focused pane"
                          onClick={() => onSend(t.title)}
                        >
                          Send
                        </button>
                      )}
                      <button className="x" title="Delete" onClick={() => remove(t)}>
                        x
                      </button>
                    </div>
                  </div>
                ))}
              {!board?.tasks.some((t) => t.status === col.key) && <div className="empty">nothing here</div>}
            </div>
          ))}
        </div>

        <div className="setting">
          <div className="setting-row">
            <label>Shared memory</label>
            <span className="hint">
              Every agent started in this folder is told to read it first: <code>.paneforge/MEMORY.md</code>
            </span>
          </div>
          <textarea
            className="memory"
            rows={8}
            value={memory}
            onChange={(e) => {
              setMemory(e.target.value)
              setDirty(true)
            }}
          />
        </div>

        <div className="dialog-row">
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          <button className="primary" disabled={!dirty} onClick={saveMemory}>
            {dirty ? 'Save memory' : 'Saved'}
          </button>
        </div>
      </div>
    </div>
  )
}

const prev = (s: TaskStatus): TaskStatus => (s === 'done' ? 'doing' : 'todo')
const next = (s: TaskStatus): TaskStatus => (s === 'todo' ? 'doing' : 'done')
