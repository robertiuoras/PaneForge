import { useMemo, useRef, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { modelGroup, modelHint, modelLabel, modelValue, supportsModel } from '@shared/agents'
import type { Project, SwarmRole } from '@shared/types'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'
import Select from './Select'
import './board-swarm.css'
const api = window.api
export interface SwarmStart {
  cwd?: string
  mission?: string
}
interface Props {
  projects: Project[]
  agents: AgentInfo[]
  roles: SwarmRole[]
  defaultModels: Record<string, string>
  initial?: SwarmStart
  onSaveRoles: (roles: SwarmRole[]) => void
  onClose: () => void
  onLaunched: (count: number) => void
}
export default function SwarmDialog({
  projects,
  agents,
  roles,
  defaultModels,
  initial,
  onSaveRoles,
  onClose,
  onLaunched
}: Props): JSX.Element {
  const [cwd, setCwd] = useState(initial?.cwd ?? projects[0]?.path ?? '')
  const [mission, setMission] = useState(initial?.mission ?? '')
  const [local, setLocal] = useState<SwarmRole[]>(roles)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const launching = useRef(false)
  const [error, setError] = useState('')
  const usable = agents.filter((agent) => agent.available)
  const chosen = local.filter((role) => role.enabled)
  const invalid = useMemo(
    () =>
      chosen.filter(
        (role) => !role.name.trim() || !role.brief.trim() || !usable.some((agent) => agent.id === role.agent)
      ),
    [chosen, usable]
  )
  const ready = Boolean(cwd && mission.trim() && chosen.length && !invalid.length && !busy)
  const patch = (id: string, value: Partial<SwarmRole>): void =>
    setLocal((items) => items.map((item) => (item.id === id ? { ...item, ...value } : item)))
  const launch = async (): Promise<void> => {
    if (!ready || launching.current) return
    launching.current = true
    setBusy(true)
    setError('')
    try {
      onSaveRoles(local)
      const started = await api.startSwarm({
        cwd,
        mission: mission.trim(),
        roles: local.map((role) => ({
          ...role,
          model: role.model || defaultModels[role.agent] || undefined
        }))
      })
      onLaunched(started.length)
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? `Could not launch: ${reason.message}`
          : 'Could not launch the swarm. Nothing was started.'
      )
    } finally {
      setBusy(false)
      launching.current = false
    }
  }
  const unavailable = !usable.length
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide pf-swarm-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>Swarm</strong>
          <span className="hint">One mission, clear ownership, one shared folder.</span>
        </div>
        <Blurb id="swarm" />
        <div className="setting">
          <label>Project</label>
          <Select
            value={cwd}
            onChange={setCwd}
            menuWidth={420}
            placeholder="Pick a folder"
            options={projects.map((project) => ({
              value: project.path,
              label: project.name,
              hint: project.path
            }))}
          />
        </div>
        <div className="setting">
          <label>Mission</label>
          <textarea
            className="mission"
            autoFocus
            rows={3}
            placeholder="Describe the outcome and limits for this team."
            value={mission}
            onChange={(event) => setMission(event.target.value)}
          />
        </div>
        <div className="pf-swarm-status" aria-live="polite">
          {unavailable
            ? 'No available coding agents on this device.'
            : invalid.length
              ? `${invalid.length} enabled role${invalid.length === 1 ? ' needs' : 's need'} a name, brief, or available agent.`
              : ready
                ? `${chosen.length} agents are ready to launch.`
                : 'Choose a project, mission, and at least one role.'}
        </div>
        {error && (
          <div className="pf-feedback error" role="alert">
            {error}
          </div>
        )}
        <div className="setting">
          <div className="setting-row">
            <label>Roles ({chosen.length} panes)</label>
            <button
              className="ghost small pf-touch"
              disabled={busy || unavailable}
              onClick={() =>
                setLocal((items) => [
                  ...items,
                  {
                    id: `r${Date.now().toString(36)}`,
                    name: '',
                    agent: usable[0]?.id ?? 'claude',
                    brief: '',
                    enabled: true
                  }
                ])
              }
            >
              Add role
            </button>
          </div>
          <div className="pf-roles">
            {local.map((role) => {
              const spec = agents.find((agent) => agent.id === role.agent)
              const unavailableRole = role.enabled && !usable.some((agent) => agent.id === role.agent)
              return (
                <div
                  key={role.id}
                  className={'pf-role' + (role.enabled ? '' : ' off') + (unavailableRole ? ' invalid' : '')}
                >
                  <label className="pf-role-enabled">
                    <input
                      type="checkbox"
                      checked={role.enabled}
                      disabled={busy}
                      onChange={(event) => patch(role.id, { enabled: event.target.checked })}
                    />
                    <span>{role.enabled ? 'Included' : 'Off'}</span>
                  </label>
                  <input
                    className="role-name"
                    aria-label="Role name"
                    placeholder="Role name"
                    value={role.name}
                    disabled={busy}
                    onChange={(event) => patch(role.id, { name: event.target.value })}
                  />
                  <Select
                    size="sm"
                    menuWidth={240}
                    value={role.agent}
                    disabled={busy || unavailable}
                    onChange={(value) => patch(role.id, { agent: value, model: '' })}
                    options={agents.map((agent) => ({
                      value: agent.id,
                      label: agent.label,
                      disabled: !agent.available,
                      hint: agent.available ? undefined : 'Unavailable on this device',
                      icon: <AgentLogo id={agent.id} spec={agent} size={13} />
                    }))}
                  />
                  {supportsModel(spec) && (
                    <Select
                      size="sm"
                      menuWidth={240}
                      value={role.model ?? ''}
                      placeholder="Default model"
                      disabled={busy}
                      onChange={(value) => patch(role.id, { model: value })}
                      options={[
                        { value: '', label: 'Default model' },
                        ...(spec?.models ?? []).map((model) => ({
                          value: modelValue(model),
                          label: modelLabel(model),
                          hint: modelHint(model),
                          group: modelGroup(model)
                        }))
                      ]}
                    />
                  )}
                  <button
                    className="ghost small pf-touch"
                    disabled={busy}
                    onClick={() => setEditing(editing === role.id ? null : role.id)}
                  >
                    {editing === role.id ? 'Hide brief' : 'Edit brief'}
                  </button>
                  <button
                    className="ghost small pf-touch danger"
                    disabled={busy}
                    onClick={() => setLocal((items) => items.filter((item) => item.id !== role.id))}
                  >
                    Remove
                  </button>
                  {(editing === role.id || !role.brief.trim()) && (
                    <textarea
                      className="brief"
                      rows={3}
                      placeholder="What this role owns, and what it must leave to the others."
                      value={role.brief}
                      disabled={busy}
                      onChange={(event) => patch(role.id, { brief: event.target.value })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <div className="dialog-row">
          <span className="hint">Each pane reads shared memory before it starts.</span>
          <button className="ghost pf-touch" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary pf-touch" disabled={!ready} onClick={() => void launch()}>
            {busy ? 'Launching…' : `Launch ${chosen.length} agents`}
          </button>
        </div>
      </div>
    </div>
  )
}
