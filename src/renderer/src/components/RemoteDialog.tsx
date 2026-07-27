import { useEffect, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import type { Project, RemoteFound, RemoteState } from '@shared/types'
import AgentLogo from './AgentLogo'
import { Switch } from './Controls'
import Select from './Select'

const api = window.api

/**
 * A machine, drawn once and reused at two sizes. It is a screen rather than a
 * laptop or a tower on purpose: the same mark has to read as "the desktop" and
 * "the laptop" without implying which one you are looking at.
 */
function DeviceGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="100%" height="100%" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 13.6h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M8 11.25v2.35" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

interface Props {
  state: RemoteState | null
  onState: (s: RemoteState) => void
  onClose: () => void
  flash: (message: string) => void
}

/**
 * Two machines, one desk.
 *
 * The shape of this is deliberately not "server and client". Both devices do both:
 * each one can answer for its own panes and mirror the other's, so there is no
 * setting that decides which machine you have to be sitting at. Leave the desktop
 * mid-run, open the laptop, and the desktop's panes are already in the window -
 * still running on the desktop, because that is where the checkout and the pty are.
 *
 * Pairing is one code typed once. It is not a password to a service: it is the key
 * the link is encrypted with, which is why regenerating it cuts every paired device
 * off rather than just changing what to type next time.
 */
export default function RemoteDialog({ state, onState, onClose, flash }: Props): JSX.Element {
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('7311')
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState(state?.self.name ?? '')
  const [showCode, setShowCode] = useState(false)
  /**
   * The device whose launcher is open, and what it answered when asked what it has.
   * Both come from over there: this machine's projects root and this machine's
   * installed CLIs say nothing about what is checked out or usable on the other one.
   */
  const [opening, setOpening] = useState<string | null>(null)
  const [far, setFar] = useState<{ projects: Project[]; agents: AgentInfo[] } | null>(null)
  const [farCwd, setFarCwd] = useState('')
  const [farAgent, setFarAgent] = useState('')

  const openLauncher = async (device: string): Promise<void> => {
    if (opening === device) {
      setOpening(null)
      return
    }
    setOpening(device)
    setFar(null)
    setError('')
    try {
      const [projects, agents] = await Promise.all([api.remoteProjects(device), api.remoteAgents(device)])
      const usable = agents.filter((a) => a.available)
      setFar({ projects, agents: usable })
      setFarCwd(projects[0]?.path ?? '')
      setFarAgent(usable[0]?.id ?? 'claude')
    } catch (e) {
      setError((e as Error).message)
      setOpening(null)
    }
  }

  const launchFar = async (device: string, deviceName: string): Promise<void> => {
    if (!farCwd || !farAgent) return
    try {
      await api.startRemote(device, { cwd: farCwd, agent: farAgent })
      setOpening(null)
      onClose()
      flash(`Started on ${deviceName}. The pane is in your list.`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Ask the network who is there while this is open. A device that was asleep when
  // the dialog opened should appear in it, not on the next launch.
  useEffect(() => {
    void api.scanRemote().then(onState)
    const t = window.setInterval(() => void api.scanRemote().then(onState), 4000)
    return () => window.clearInterval(t)
  }, [onState])

  useEffect(() => {
    if (state && !pairing) setName((n) => (n === '' ? state.self.name : n))
  }, [state, pairing])

  if (!state) {
    return (
      <div className="overlay" onMouseDown={onClose}>
        <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
          <div className="dialog-head">
            <strong>Devices</strong>
          </div>
          <p className="hint">Starting up...</p>
        </div>
      </div>
    )
  }

  const self = state.self

  const pair = async (input: { address: string; port: number; code: string; name?: string }): Promise<void> => {
    if (pairing) return
    setPairing(true)
    setError('')
    try {
      const res = await api.pairRemote(input)
      onState(res.state)
      if (!res.ok) {
        setError(res.error ?? 'Could not pair with that device.')
        return
      }
      setAddress('')
      setCode('')
      flash(`Paired with ${input.name || input.address}. Its panes are in your list.`)
    } finally {
      setPairing(false)
    }
  }

  /** Pair with something the LAN broadcast already told us the address of. */
  const pairFound = (f: RemoteFound): void => {
    if (!code.trim()) {
      setError(`Type ${f.name}'s pairing code below first - it is on that device, under Devices.`)
      return
    }
    void pair({ address: f.address, port: f.port, code, name: f.name })
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide devices" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Devices</strong>
          <span className="hint">work on this machine&rsquo;s panes from the other one, and back</span>
        </div>

        {/* ------------------------------------------------------------- this device
            The hero card. It is the only thing on this screen that is about the
            machine you are sitting at, so it gets the raised surface and everything
            else sits flat under headings. */}
        <div className="dev-hero">
          <div className="dev-hero-top">
            <span className={'dev-glyph ' + (self.hosting ? 'on' : 'off')} aria-hidden="true">
              <DeviceGlyph />
            </span>
            <div className="dev-hero-id">
              <input
                className="dev-name"
                value={name}
                maxLength={40}
                aria-label="This device's name"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name !== self.name && void api.renameDevice(name).then(onState)}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <span className="dev-hero-sub">this device</span>
            </div>
            <span className={'dev-state ' + (self.hosting ? 'on' : 'off')}>
              <span className={'dot ' + (self.hosting ? 'on' : 'off')} />
              {self.hosting ? 'Reachable' : 'Private'}
            </span>
          </div>

          <Switch
            checked={self.hosting}
            onChange={(on) => void api.setRemoteHost(on).then(onState)}
            label="Let my other devices connect"
            hint="They can watch and type into every pane open here. The agents keep running on this machine."
          />

          {self.error && <div className="dev-error">{self.error}</div>}

          {self.hosting && (
            <div className="dev-self">
              <div className="dev-field">
                <span className="dev-key">Pairing code</span>
                <code className={'dev-code' + (showCode ? '' : ' masked')}>
                  {showCode ? self.code : '••••-••••'}
                </code>
                <div className="dev-acts">
                  <button className="ghost small" onClick={() => setShowCode((v) => !v)}>
                    {showCode ? 'Hide' : 'Show'}
                  </button>
                  <button
                    className="ghost small"
                    onClick={() => {
                      api.copyText(self.code)
                      flash('Pairing code copied.')
                    }}
                  >
                    Copy
                  </button>
                  <button
                    className="ghost small"
                    title="New code. Every device paired with the old one is disconnected and has to pair again."
                    onClick={() => {
                      void api.rotateRemoteCode().then(onState)
                      flash('New pairing code. Paired devices have to be re-paired.')
                    }}
                  >
                    New code
                  </button>
                </div>
              </div>
              <div className="dev-field">
                <span className="dev-key">Address</span>
                <div className="dev-addrs">
                  {self.addresses.length ? (
                    self.addresses.map((a) => (
                      <code key={a} className="dev-addr">
                        {a}
                      </code>
                    ))
                  ) : (
                    <code className="dev-addr muted">no network</code>
                  )}
                </div>
                <div className="dev-acts">
                  <span className="dev-key">Port</span>
                  <input
                    className="dev-port"
                    aria-label="Port"
                    value={String(self.port)}
                    onChange={(e) => void api.setRemotePort(Number(e.target.value) || 0).then(onState)}
                  />
                </div>
              </div>
              <p className="hint">
                The other device only needs one of those addresses and the code, and usually not even
                that - it finds this one on its own while both are on the same network.
              </p>
            </div>
          )}

          {state.guests.length > 0 && (
            <div className="dev-guests">
              {state.guests.map((g) => (
                <div key={g.id + g.address} className="dev-guest">
                  <span className="dot on" />
                  <strong>{g.name}</strong>
                  <span className="hint">
                    {g.address} · watching {g.watching} {g.watching === 1 ? 'pane' : 'panes'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ----------------------------------------------------------- other devices */}
        <div className="setting">
          <div className="setting-row">
            <label>Paired devices</label>
            {state.peers.length > 0 && (
              <span className="hint">
                {state.peers.filter((p) => p.status === 'online').length} of {state.peers.length} online
              </span>
            )}
          </div>
          {state.peers.length === 0 && (
            <p className="dev-empty">
              None yet. Turn the switch above on over there, then pair with it below.
            </p>
          )}
          <div className="dev-list">
            {state.peers.map((p) => (
              <div key={p.id} className={'dev-entry ' + p.status + (opening === p.id ? ' open' : '')}>
                <div className={'dev-row ' + p.status}>
                  <span className={'dev-glyph small ' + p.status} aria-hidden="true">
                    <DeviceGlyph />
                  </span>
                  <div className="dev-text">
                    <div className="dev-title">
                      <span className="dev-nm">{p.name}</span>
                      {p.status === 'online' && (
                        <span className="chip remote">
                          {p.sessions} {p.sessions === 1 ? 'pane' : 'panes'}
                        </span>
                      )}
                      {p.status !== 'online' && p.seen && <span className="chip">on this network</span>}
                      {p.status === 'connecting' && <span className="chip">connecting</span>}
                    </div>
                    <div className="dev-sub">
                      <span className={'dot ' + p.status} />
                      {p.address}:{p.port}
                      {p.error ? ' · ' + p.error : ''}
                    </div>
                  </div>
                  <div className="dev-acts">
                    {p.status === 'online' && (
                      <button
                        className={'ghost small' + (opening === p.id ? ' active' : '')}
                        title={`Open a pane on ${p.name}, in one of its folders`}
                        onClick={() => void openLauncher(p.id)}
                      >
                        New pane
                      </button>
                    )}
                    <button
                      className="ghost small"
                      onClick={() =>
                        void api.connectRemote(p.id, p.status === 'off' || p.status === 'error').then(onState)
                      }
                    >
                      {p.status === 'off' || p.status === 'error' ? 'Connect' : 'Disconnect'}
                    </button>
                    <button
                      className="x"
                      title="Forget this device"
                      aria-label={`Forget ${p.name}`}
                      onClick={() => void api.forgetRemote(p.id).then(onState)}
                    >
                      ×
                    </button>
                  </div>
                </div>
                {opening === p.id && (
                  <div className="dev-launch">
                    {!far && <span className="hint">Asking {p.name} what it has...</span>}
                    {far && far.projects.length === 0 && (
                      <span className="hint">{p.name} has no projects under its root folder.</span>
                    )}
                    {far && far.projects.length > 0 && (
                      <>
                        <Select
                          value={farCwd}
                          onChange={setFarCwd}
                          menuWidth={380}
                          placeholder="Folder on that device"
                          options={far.projects.map((pr) => ({ value: pr.path, label: pr.name, hint: pr.path }))}
                        />
                        <Select
                          size="sm"
                          menuWidth={220}
                          value={farAgent}
                          onChange={setFarAgent}
                          options={far.agents.map((a) => ({
                            value: a.id,
                            label: a.label,
                            icon: <AgentLogo id={a.id} spec={a} size={13} />
                          }))}
                        />
                        <button className="primary" disabled={!farCwd} onClick={() => void launchFar(p.id, p.name)}>
                          Start there
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* --------------------------------------------------------------- pair a new */}
        <div className="setting">
          <div className="setting-row">
            <label>Pair another device</label>
            <span className="hint">its code is on that machine, under Devices</span>
          </div>

          {state.found.length > 0 && (
            <div className="dev-found">
              <span className="dev-key">On this network</span>
              {state.found.map((f) => (
                <button
                  key={f.id}
                  className="dev-chip"
                  disabled={pairing}
                  title={`Pair with ${f.name} at ${f.address}`}
                  onClick={() => pairFound(f)}
                >
                  <span className="dot connecting" />
                  <span className="dev-chip-nm">{f.name}</span>
                  <span className="hint">{f.address}</span>
                </button>
              ))}
            </div>
          )}

          <div className="dev-add">
            <input
              placeholder="Pairing code"
              aria-label="Pairing code"
              className="dev-code-in"
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <input
              placeholder="Address (only if it is not listed above)"
              aria-label="Address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <input
              className="dev-port"
              aria-label="Port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
            <button
              className="primary"
              disabled={pairing || !code.trim() || !address.trim()}
              onClick={() => void pair({ address, port: Number(port) || 7311, code })}
            >
              {pairing ? 'Pairing...' : 'Pair'}
            </button>
          </div>
          {error && <div className="dev-error">{error}</div>}
        </div>

        <div className="dialog-row">
          <span className="hint">
            Panes stay on the machine they were opened on. This window drives them; it does not move them.
          </span>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
