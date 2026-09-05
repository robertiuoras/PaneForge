import { useEffect, useRef, useState } from 'react'
import type { RemoteState } from '@shared/types'
import type { OwnerStats } from '@shared/ownerStats'

export default function UsersDialog({ remote, onClose }: {
  remote: RemoteState | null
  onClose(): void
}): JSX.Element {
  const [stats, setStats] = useState<OwnerStats | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setStats(null)
    void window.api.ownerStats().then(result => {
      if (active) setStats(result)
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refresh])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { previous?.focus() }
  }, [])
  const devices = [
    ...(remote ? [{ id: remote.self.id, name: remote.self.name, address: remote.self.addresses.join(', '), status: 'This device', version: remote.self.version }] : []),
    ...(remote?.peers ?? []).map(peer => ({ id: peer.id, name: peer.name, address: peer.address, status: peer.status, version: peer.version ?? '' })),
    ...(remote?.guests ?? []).filter(guest => !remote?.peers.some(peer => peer.id === guest.id)).map(guest => ({ id: guest.id, name: guest.name, address: guest.address, status: 'Connected here', version: '' }))
  ]
  const windows = stats?.releases.reduce((sum, release) => sum + release.windows, 0) ?? 0
  const mac = stats?.releases.reduce((sum, release) => sum + release.mac, 0) ?? 0
  return <div className="overlay" onMouseDown={onClose}>
    <div ref={dialog} className="dialog users-dialog" role="dialog" aria-modal="true" aria-labelledby="users-title"
      onMouseDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])]
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
      <div className="dialog-head">
        <strong id="users-title">Users</strong>
        <span className="hint">Only your GitHub owner account</span>
        <button className="ghost small" aria-label="Close Users" onClick={onClose}>Close</button>
      </div>
      <div className="users-body">
        <p className="hint">PaneForge has no user accounts or global usage tracking. Downloads below are installer fetches, not unique people. IP addresses belong to devices connected to this desk.</p>
        <div className="users-heading"><h3>Release downloads</h3><button className="ghost small" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh</button></div>
        {loading && <p role="status">Reading GitHub downloads…</p>}
        {error && <p role="alert">{error}</p>}
        {stats && <>
          <div className="users-counts">
            <div><strong>{windows + mac}</strong><span>Installer downloads</span></div>
            <div><strong>{windows}</strong><span>Windows</span></div>
            <div><strong>{mac}</strong><span>macOS</span></div>
          </div>
          <p className="hint">Newest {stats.releases.length} releases · EXE and DMG files · checked {new Date(stats.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          <div className="users-table-wrap"><table><caption className="hint">Downloads by release</caption><thead><tr><th>Version</th><th>Published</th><th>Windows</th><th>macOS</th></tr></thead><tbody>
            {stats.releases.slice(0, 10).map(release => <tr key={release.version}><td>{release.version}</td><td>{release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : 'Unpublished'}</td><td>{release.windows}</td><td>{release.mac}</td></tr>)}
          </tbody></table></div>
        </>}
        <h3>Your devices</h3>
        <div className="users-table-wrap"><table><thead><tr><th>Device</th><th>Status</th><th>IP / address</th><th>Version</th></tr></thead><tbody>
          {devices.map(device => <tr key={device.id}><td>{device.name}</td><td>{device.status}</td><td>{device.address || 'Unavailable'}</td><td>{device.version || 'Unknown'}</td></tr>)}
        </tbody></table></div>
        {!devices.length && <p className="hint">Device details are not available.</p>}
      </div>
    </div>
  </div>
}
