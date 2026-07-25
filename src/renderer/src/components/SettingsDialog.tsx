import { useEffect, useState } from 'react'
import type { Agent, Config } from '@shared/types'

const api = window.api

interface Props {
  config: Config
  onChange: (patch: Partial<Config>) => void
  onClose: () => void
}

export default function SettingsDialog({ config, onChange, onClose }: Props): JSX.Element {
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
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
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
