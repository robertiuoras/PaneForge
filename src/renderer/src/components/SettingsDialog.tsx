import { useEffect, useState } from 'react'
import type { AgentInfo, AgentSpec } from '@shared/agents'
import type { Agent, Config } from '@shared/types'

const api = window.api

interface Props {
  config: Config
  agents: AgentInfo[]
  onChange: (patch: Partial<Config>) => void
  onClose: () => void
}

/**
 * Adding an agent is four prompts rather than a form: it happens once per CLI, and
 * a full editor would be more UI than the feature is worth. The stored shape is the
 * same AgentSpec the built-ins use, so a custom entry is a first-class agent.
 */
function addCustom(config: Config, onChange: (patch: Partial<Config>) => void): void {
  const label = window.prompt('Name (shown in the picker)')?.trim()
  if (!label) return
  const bin = window.prompt('Command to run (on PATH, or a full path)', label.toLowerCase())?.trim()
  if (!bin) return
  const args = window.prompt('Arguments for a fresh session (space separated, can be empty)', '') ?? ''
  const resume = window.prompt('Arguments that resume the last session (empty = not supported)', '') ?? ''
  const modelFlag = window.prompt('Flag that selects a model (e.g. --model, empty = none)', '')?.trim()
  const models = modelFlag
    ? (window.prompt('Model suggestions, comma separated (optional)', '') ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    : []

  const spec: AgentSpec = {
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
    bin,
    args: args.split(/\s+/).filter(Boolean),
    resumeArgs: resume.trim() ? resume.split(/\s+/).filter(Boolean) : undefined,
    modelFlag: modelFlag || undefined,
    models: models.length ? models : undefined,
    color: '#7dd3fc',
    custom: true
  }
  onChange({ customAgents: [...config.customAgents.filter((c) => c.id !== spec.id), spec] })
}

export default function SettingsDialog({ config, agents, onChange, onClose }: Props): JSX.Element {
  const [admin, setAdmin] = useState(false)

  useEffect(() => {
    api.isAdmin().then(setAdmin)
  }, [])

  const pickRoot = async (): Promise<void> => {
    const dir = await api.pickRoot()
    if (dir) onChange({ root: dir })
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Settings</strong>
          <span className="hint">saved instantly, no restart needed</span>
        </div>

        <div className="setting">
          <label>Projects folder</label>
          <div className="setting-row">
            <input className="search" readOnly value={config.root} />
            <button className="ghost" onClick={pickRoot}>
              Browse
            </button>
          </div>
        </div>

        <div className="setting">
          <label>Default agent</label>
          <select
            value={config.defaultAgent}
            onChange={(e) => onChange({ defaultAgent: e.target.value as Agent })}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.available}>
                {a.label}
                {a.available ? '' : ' (not installed)'}
              </option>
            ))}
          </select>
        </div>

        <div className="setting">
          <label>Agents on this machine</label>
          <div className="agent-grid">
            {agents.map((a) => (
              <div key={a.id} className={'agent-card' + (a.available ? '' : ' off')}>
                <span className="agent-dot" style={{ background: a.color }} />
                <span className="agent-name">{a.label}</span>
                {a.custom && <span className="tag">custom</span>}
                <span className="hint">
                  {a.available ? a.path : a.install ? `install: ${a.install}` : `${a.bin} not on PATH`}
                </span>
                {a.custom && (
                  <button
                    className="x"
                    title="Remove this custom agent"
                    onClick={() =>
                      onChange({ customAgents: config.customAgents.filter((c) => c.id !== a.id) })
                    }
                  >
                    x
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="setting-row">
            <span className="hint">Any other CLI can be added - it runs in a real terminal pane.</span>
            <button className="ghost" onClick={() => addCustom(config, onChange)}>
              Add agent
            </button>
          </div>
        </div>

        <div className="setting">
          <label>Terminal font size ({config.fontSize}px)</label>
          <input
            type="range"
            min={9}
            max={22}
            value={config.fontSize}
            onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          />
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={config.notifyOnIdle}
            onChange={(e) => onChange({ notifyOnIdle: e.target.checked })}
          />
          Notify me when a background session goes quiet
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={config.confirmClose}
            onChange={(e) => onChange({ confirmClose: e.target.checked })}
          />
          Ask before closing a session that is still running
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={config.launchAtLogin}
            onChange={(e) => onChange({ launchAtLogin: e.target.checked })}
          />
          Start PaneForge when Windows starts
        </label>

        <div className="setting">
          <label>Privileges</label>
          <div className="setting-row">
            <span className="hint">
              {admin
                ? 'Running as admin - agents can stop admin-owned processes.'
                : 'Running as a normal user. Agents cannot kill admin-owned processes (e.g. a service on port 8000).'}
            </span>
            {!admin && (
              <button className="ghost" onClick={() => api.relaunchAsAdmin()}>
                Restart as admin
              </button>
            )}
          </div>
        </div>

        <div className="dialog-row">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
