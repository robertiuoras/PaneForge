import { useMemo, useRef, useState, useEffect } from 'react'
import type { AgentInfo } from '@shared/agents'
import type { Agent, Project, StartSessionRequest } from '@shared/types'
import AgentPicker from './AgentPicker'

interface Props {
  projects: Project[]
  defaultAgent: Agent
  /** last model used per agent, so the pick sticks between launches */
  defaultModels: Record<string, string>
  agents: AgentInfo[]
  onStart: (reqs: StartSessionRequest[]) => void
  /** save the current tick-list as a named workspace without launching it */
  onSaveWorkspace: (name: string, reqs: StartSessionRequest[]) => void
  onCancel: () => void
}

/**
 * Project picker. Tick several projects to launch them in one go - that is the part
 * that replaces the fixed five-pane .bat, except the list is chosen per launch.
 */
export default function NewSessionDialog({
  projects,
  defaultAgent,
  defaultModels,
  agents,
  onStart,
  onSaveWorkspace,
  onCancel
}: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [ticked, setTicked] = useState<string[]>([])
  const [resume, setResume] = useState(false)
  const [agent, setAgent] = useState<Agent>(defaultAgent)
  const [model, setModel] = useState(defaultModels[defaultAgent] ?? '')
  const [prompt, setPrompt] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects
    return list.slice(0, 60)
  }, [projects, q])

  useEffect(() => setSel(0), [q])

  const canResume = !!agents.find((a) => a.id === agent)?.resumeArgs

  const toggle = (path: string): void =>
    setTicked((t) => (t.includes(path) ? t.filter((p) => p !== path) : [...t, path]))

  /** Ticked projects if any, otherwise whatever row is highlighted. */
  const chosen = (p?: Project): StartSessionRequest[] => {
    const paths = ticked.length ? ticked : p ? [p.path] : shown[sel] ? [shown[sel].path] : []
    return paths.map((path) => {
      const proj = projects.find((x) => x.path === path)
      return {
        cwd: path,
        title: proj?.name,
        agent,
        model: model || undefined,
        resume: resume && canResume,
        prompt: prompt.trim() || undefined
      }
    })
  }

  const go = (p?: Project): void => {
    const reqs = chosen(p)
    if (reqs.length) onStart(reqs)
  }

  const save = (): void => {
    const reqs = chosen()
    if (!reqs.length) return
    const name = window.prompt('Workspace name', reqs.map((r) => r.title).join(' + ').slice(0, 40))
    if (name?.trim()) onSaveWorkspace(name.trim(), reqs)
  }

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>New session</strong>
          <span className="hint">Space ticks a project, Enter starts everything ticked</span>
        </div>

        <input
          ref={input}
          className="search"
          placeholder="Filter projects"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === ' ' && q === '') {
              // Space only ticks when it cannot be part of a search term.
              e.preventDefault()
              if (shown[sel]) toggle(shown[sel].path)
            } else if (e.key === 'Enter') {
              go()
            }
          }}
        />

        <div className="proj-list">
          {shown.map((p, i) => (
            <div
              key={p.path}
              className={'proj' + (i === sel ? ' sel' : '') + (ticked.includes(p.path) ? ' on' : '')}
              onMouseEnter={() => setSel(i)}
              onClick={(e) => {
                // Plain click launches that one project; the tickbox builds a set.
                if ((e.target as HTMLElement).dataset.tick) return
                go(p)
              }}
            >
              <span
                className="tick"
                data-tick="1"
                onClick={(e) => {
                  e.stopPropagation()
                  toggle(p.path)
                }}
              >
                {ticked.includes(p.path) ? '[x]' : '[ ]'}
              </span>
              <span className="proj-name">{p.name}</span>
              {!p.isGit && <span className="tag">no git</span>}
              <span className="proj-age">{ago(p.lastUsed)}</span>
            </div>
          ))}
          {shown.length === 0 && <div className="empty">No match</div>}
        </div>

        <input
          className="search prompt"
          placeholder="Optional first message, sent to every session started here"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />

        <div className="dialog-row">
          <label title={canResume ? '' : `${agents.find((a) => a.id === agent)?.label ?? agent} has no resume flag`}>
            <input
              type="checkbox"
              checked={resume && canResume}
              disabled={!canResume}
              onChange={(e) => setResume(e.target.checked)}
            />
            Resume last session
          </label>
          <AgentPicker
            agents={agents}
            agent={agent}
            model={model}
            onChange={(a, m) => {
              setAgent(a)
              // Switching CLI carries its own remembered model, not the previous one's.
              setModel(a === agent ? m : defaultModels[a] ?? '')
            }}
          />
          <button className="ghost" onClick={save} disabled={!ticked.length}>
            Save as workspace
          </button>
          <button className="primary" onClick={() => go()}>
            Start {ticked.length > 1 ? `${ticked.length} sessions` : ''}
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
