import { useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { modelLabel, modelValue, supportsModel } from '@shared/agents'
import type { Project, SwarmRole } from '@shared/types'
import AgentLogo from './AgentLogo'
import Select from './Select'

const api = window.api

interface Props {
  projects: Project[]
  agents: AgentInfo[]
  roles: SwarmRole[]
  defaultModels: Record<string, string>
  onSaveRoles: (roles: SwarmRole[]) => void
  onClose: () => void
  onLaunched: (count: number) => void
}

/**
 * One mission, several agents, one folder. The value is not "more agents" - it is
 * that each pane is told what it owns, so they stop colliding on the same files
 * and the shared memory file becomes the handover point between them.
 */
export default function SwarmDialog({
  projects,
  agents,
  roles,
  defaultModels,
  onSaveRoles,
  onClose,
  onLaunched
}: Props): JSX.Element {
  const [cwd, setCwd] = useState(projects[0]?.path ?? '')
  const [mission, setMission] = useState('')
  const [local, setLocal] = useState<SwarmRole[]>(roles)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const usable = agents.filter((a) => a.available)
  const chosen = local.filter((r) => r.enabled)

  const patch = (id: string, p: Partial<SwarmRole>): void =>
    setLocal((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const launch = async (): Promise<void> => {
    if (!cwd || !mission.trim() || !chosen.length || busy) return
    setBusy(true)
    onSaveRoles(local)
    try {
      const started = await api.startSwarm({
        cwd,
        mission,
        // Roles fall back to the agent's remembered default model when none is set.
        roles: local.map((r) => ({ ...r, model: r.model || defaultModels[r.agent] || undefined }))
      })
      onLaunched(started.length)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Swarm</strong>
          <span className="hint">one mission, one pane per role, all in the same folder</span>
        </div>

        <div className="setting">
          <label>Project</label>
          <Select
            value={cwd}
            onChange={setCwd}
            menuWidth={420}
            placeholder="Pick a folder"
            options={projects.map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
          />
        </div>

        <div className="setting">
          <label>Mission</label>
          <textarea
            className="mission"
            autoFocus
            rows={3}
            placeholder="Add offer replies to the dashboard, with tests."
            value={mission}
            onChange={(e) => setMission(e.target.value)}
          />
        </div>

        <div className="setting">
          <div className="setting-row">
            <label>Roles ({chosen.length} panes)</label>
            <button
              className="ghost small"
              onClick={() =>
                setLocal((rs) => [
                  ...rs,
                  {
                    id: `r${Date.now().toString(36)}`,
                    name: 'New role',
                    agent: usable[0]?.id ?? 'claude',
                    brief: 'You own ...',
                    enabled: true
                  }
                ])
              }
            >
              Add role
            </button>
          </div>

          <div className="roles">
            {local.map((r) => {
              const spec = agents.find((a) => a.id === r.agent)
              return (
                <div key={r.id} className={'role' + (r.enabled ? '' : ' off')}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  />
                  <input
                    className="role-name"
                    value={r.name}
                    onChange={(e) => patch(r.id, { name: e.target.value })}
                  />
                  <Select
                    size="sm"
                    menuWidth={240}
                    value={r.agent}
                    onChange={(v) => patch(r.id, { agent: v, model: '' })}
                    options={usable.map((a) => ({
                      value: a.id,
                      label: a.label,
                      icon: <AgentLogo id={a.id} spec={a} size={13} />
                    }))}
                  />
                  {supportsModel(spec) && (
                    <Select
                      size="sm"
                      menuWidth={240}
                      value={r.model ?? ''}
                      placeholder="default"
                      onChange={(v) => patch(r.id, { model: v })}
                      options={[
                        { value: '', label: 'Default model' },
                        ...(spec?.models ?? []).map((m) => ({
                          value: modelValue(m),
                          label: modelLabel(m)
                        }))
                      ]}
                    />
                  )}
                  <button
                    className="ghost small"
                    title="Edit what this role is told to do"
                    onClick={() => setEditing(editing === r.id ? null : r.id)}
                  >
                    Brief
                  </button>
                  <button className="x" title="Remove role" onClick={() => setLocal((rs) => rs.filter((x) => x.id !== r.id))}>
                    x
                  </button>
                  {editing === r.id && (
                    <textarea
                      className="brief"
                      rows={3}
                      value={r.brief}
                      onChange={(e) => patch(r.id, { brief: e.target.value })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="dialog-row">
          <span className="hint">
            Each pane is told its role, the mission, and to read <code>.paneforge/MEMORY.md</code> first.
          </span>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!cwd || !mission.trim() || !chosen.length || busy} onClick={launch}>
            {busy ? 'Starting...' : `Launch ${chosen.length} agents`}
          </button>
        </div>
      </div>
    </div>
  )
}
