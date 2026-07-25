import { useMemo, useRef, useState, useEffect } from 'react'
import type { Agent, Project, StartSessionRequest } from '@shared/types'

interface Props {
  projects: Project[]
  onStart: (req: StartSessionRequest) => void
  onCancel: () => void
}

export default function NewSessionDialog({ projects, onStart, onCancel }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [resume, setResume] = useState(false)
  const [agent, setAgent] = useState<Agent>('claude')
  const [prompt, setPrompt] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? projects.filter((p) => p.name.toLowerCase().includes(needle))
      : projects
    return list.slice(0, 40)
  }, [projects, q])

  useEffect(() => setSel(0), [q])

  const go = (p?: Project): void => {
    const target = p ?? shown[sel]
    if (!target) return
    onStart({
      cwd: target.path,
      title: target.name,
      agent,
      resume,
      prompt: prompt.trim() || undefined
    })
  }

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="search"
          placeholder="Filter projects, Enter to start"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, shown.length - 1))
            else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0))
            else if (e.key === 'Enter') go()
          }}
        />

        <div className="proj-list">
          {shown.map((p, i) => (
            <div
              key={p.path}
              className={'proj' + (i === sel ? ' sel' : '')}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(p)}
            >
              <span className="proj-name">{p.name}</span>
              <span className="proj-age">{ago(p.lastUsed)}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="empty">No match</div>}
        </div>

        <input
          className="search prompt"
          placeholder="Optional first message to the agent"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />

        <div className="dialog-row">
          <label>
            <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
            Resume last session
          </label>
          <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
          <button className="primary" onClick={() => go()}>
            Start
          </button>
        </div>
      </div>
    </div>
  )
}

function ago(t: number): string {
  if (!t) return 'never'
  const m = (Date.now() - t) / 60000
  if (m < 60) return `${Math.round(m)}m ago`
  if (m < 1440) return `${Math.round(m / 60)}h ago`
  const d = Math.round(m / 1440)
  return d < 30 ? `${d}d ago` : new Date(t).toISOString().slice(0, 10)
}
