import { useEffect, useState, type ReactNode } from 'react'
import type { AgentInfo } from '@shared/agents'
import type {
  PhoneDeviceView,
  PhonePeer,
  PhoneState,
  Project,
  RemoteFound,
  RemoteState
} from '@shared/types'
import { reachWords } from '@shared/net'
import { handoffReport } from '@shared/handoff'
import { versionGap } from '@shared/remoteVersion'
import { ageWords, jobsSummary, type BackJob } from '@shared/backJobs'
import { PairQr } from './PairQr'
import AgentLogo from './AgentLogo'
import AgentPicker from './AgentPicker'
import Blurb from './Blurb'
import { Checkbox, Switch } from './Controls'
import Select from './Select'
import './devices-mobile.css'

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

/**
 * A heading that opens.
 *
 * This screen had grown two of everything - a code, an address list, a port and a New code
 * beside them, twice over, once for a phone and once for another desktop - and all of it
 * was on screen at once, above and below the one picture somebody actually needs. None of
 * it is wrong; it is what pairing is MADE of, and it is what you reach for when the picture
 * or the invite did not work. So it is still here, one click away, and closed until then.
 */
function Fold({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <details className="dev-fold">
      <summary>{label}</summary>
      <div className="dev-fold-body">{children}</div>
    </details>
  )
}

/**
 * What a paired machine is running that has no pane.
 *
 * The sessions list already carries every pane the other device has, which answered "what
 * is open over there". It could not answer the question actually being asked of a machine
 * that runs work unattended: the `claude -p` a scheduled task fires, the loop that has been
 * wedged since Tuesday, the dev server on a port nobody can reach. None of that is a pane,
 * so none of it was anywhere in this app - you went and looked over SSH.
 *
 * Asked on demand, never on a tick: answering it is a whole process table read on the
 * other machine (`shared/backJobs.ts`), and this panel is opened rarely and read slowly.
 * A refusal is printed as a sentence rather than as an empty list - "nothing is running"
 * is the answer somebody came here to check, and a read that could not happen must never
 * be able to look like it.
 */
function PeerJobs({ id, name }: { id: string | null; name: string }): JSX.Element {
  const [jobs, setJobs] = useState<BackJob[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    setBusy(true)
    setErr('')
    // `id === null` is THIS machine. The reading is the same one (`shared/backJobs.ts`
    // over one process table), and it was answerable from the window all along -
    // `listJobs` shipped in the surface, was handled in main, and nothing ever called
    // it. So the panel could tell you what the PC was running unattended and not what
    // the machine you are sitting at was, which is the half you can actually act on.
    void (id === null ? api.listJobs() : api.listRemoteJobs(id))
      .then((list) => setJobs(list))
      .catch((e: Error) => setErr(e.message || `${name} did not answer`))
      .finally(() => setBusy(false))
  }

  // Once when the device card appears, and by hand after that. A machine's background work
  // changes on the scale of minutes, and a poll would be a process table per tick.
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const who = id === null ? 'this machine' : name

  return (
    <div className="dev-jobs">
      <div className="dev-jobs-head">
        <span className="hint">
          {err
            ? `Could not ask ${who}: ${err}`
            : jobs === null
              ? `Asking ${who} what else it is running…`
              : jobs.length === 0
                ? `Nothing running on ${who} outside its panes.`
                : `Outside its panes, ${who} is running ${jobsSummary(jobs)}.`}
        </span>
        <button className="ghost small" disabled={busy} onClick={load} title={`Ask ${who} again`}>
          {busy ? 'Asking…' : 'Refresh'}
        </button>
      </div>
      {jobs?.map((j) => (
        <div key={j.pid} className={'dev-job ' + j.kind} title={j.cmd}>
          <span className={'dev-job-kind ' + j.kind}>
            {j.kind === 'agent' ? (j.headless ? 'agent run' : 'agent') : j.kind === 'dev' ? 'dev' : 'script'}
          </span>
          <span className="dev-job-nm">{j.label}</span>
          {j.port ? <code className="dev-job-port">:{j.port}</code> : null}
          {j.where ? <span className="dev-job-where">{j.where}</span> : null}
          <span className="dev-job-age">{ageWords(j.elapsed)}</span>
        </div>
      ))}
    </div>
  )
}

interface Props {
  state: RemoteState | null
  onState: (s: RemoteState) => void
  onClose: () => void
  flash: (message: string) => void
}

/**
 * The phone client: this window's UI, in a browser on the network.
 *
 * Deliberately plainer than the hero card above it, and deliberately blunt in its words.
 * The switch grants a browser the ability to type into a pane, which is the ability to run
 * commands on this machine, so the hint says that rather than "share your desk". What
 * makes it safe to leave on is the code below it - six characters, typed once per phone,
 * and rotating it signs every one of them out.
 *
 * It keeps its own state rather than taking it from `RemoteState`: the two features share
 * a screen and nothing else, and folding a phone into a list of paired desktops is what
 * would make somebody expect a pane to move.
 */
/**
 * A way in from a network that is not this one.
 *
 * Its own switch under the phone's rather than folded into it, because the two are
 * different promises and the second one is the bigger. Serving on the LAN puts this desk
 * behind a private address that nobody outside the building can reach at all; a public
 * https address in front of it makes the pairing code the entire lock, which is why
 * turning this on rotates the code to a long one and says so rather than doing it quietly.
 *
 * The words under it name Cloudflare on purpose. Traffic goes through their edge and they
 * terminate the TLS, so this is somebody else being able to see what is typed into a pane
 * - a thing the person pressing the switch is entitled to know before they press it, not
 * after.
 */
function PhoneTunnel({
  state,
  setState
}: {
  state: PhoneState
  setState: (s: PhoneState) => void
}): JSX.Element {
  const t = state.tunnel
  const working = t.phase === 'fetching' || t.phase === 'starting'
  return (
    <div className="dev-field dev-tunnel">
      <span className="dev-key">Anywhere</span>
      <div className="tunnel-body">
        <Switch
          checked={t.phase !== 'off'}
          disabled={working}
          onChange={(on) => void api.setPhoneTunnel(on).then(setState)}
          label="Reachable from outside this network"
          hint="Gives this desk a public https address that works on any network, with nothing to install on the phone. Tailscale Funnel is used when this machine can - its address is this machine's own name and never changes, so a phone signs in once and stays in. Otherwise a Cloudflare quick tunnel, whose address is new every launch and whose edge can see what is typed into a pane. Either way the pairing code becomes the only lock, so switching this on makes it a longer one."
        />
        {/* A phase is never the claim. `up` is set by a real request against the real
            address coming back with this desk's own bytes - see main/tunnel.ts. */}
        {t.phase === 'fetching' && (
          <span className="hint">Downloading cloudflared once (about 20 MB)&hellip;</span>
        )}
        {t.phase === 'starting' && (
          <span className="hint">Opening the tunnel&hellip; this takes about twenty seconds.</span>
        )}
        {t.phase === 'up' && t.url && (
          <div className="dev-addrs">
            <span className="dev-addr-row">
              <code className="dev-addr">{t.url}</code>
              {/* The difference between the two providers, in the only words that matter
                  to somebody holding a phone: whether this address is worth putting on a
                  home screen. A cloudflared hostname is minted per run, so the phone is
                  signed out by the next launch however long its cookie says it is good
                  for; a Funnel address is this machine's name and outlives everything. */}
              <span className="dev-reach">
                {t.stable ? 'works anywhere · this address never changes' : 'works anywhere'}
              </span>
            </span>
            {!t.stable && (
              <span className="hint">
                A new address every launch, so phones sign in again each time. Turn Funnel on
                in Tailscale for one that sticks.
              </span>
            )}
          </div>
        )}
        {t.error && <div className="dev-error">{t.error}</div>}
      </div>
    </div>
  )
}

/**
 * The phones that are in, and the ones watching right now.
 *
 * This used to be able to say only "somebody is watching": the cookie was
 * `hmac(deviceId, code)`, identical on every browser that ever typed the code, so there
 * was no per-device identity to keep, no way to sign one out, and `New code` - which took
 * all of them - was the only revoke there could honestly be.
 *
 * A device approved on this desk holds a secret of its own, so this is a real list now: a
 * row per device, `Sign out` per row, and it means it - the token is looked up on every
 * request, so the stream ends and the next one is refused. A browser that typed the code
 * still has no identity, so it appears only while it is watching, under the honest word.
 *
 * `origin` is on every row because "a phone is signed in" reads one way for the one in
 * this room and another for an address off the internet.
 */
function PhoneDevices({
  devices,
  peers,
  setState,
  flash
}: {
  devices: PhoneDeviceView[]
  peers: PhonePeer[]
  setState: (s: PhoneState) => void
  flash: (message: string) => void
}): JSX.Element {
  // The only moving part is "how long ago", so this repaints itself rather than waiting
  // for a push that will not come - the desk pushes on connect and disconnect, not on the
  // clock ticking.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!devices.length && !peers.length) return
    const timer = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [devices.length, peers.length])

  // A browser that typed the code has no device row to sit in, so it is shown as what it
  // is - a live stream and nothing more. Anything belonging to an approved device is
  // already drawn above it, by name.
  const anon = peers.filter((p) => !devices.some((d) => d.live && d.address === p.address))

  return (
    <div className="dev-field dev-peers">
      <span className="dev-key">Signed in</span>
      {devices.length || anon.length ? (
        <ul className="peer-list">
          {devices.map((d) => (
            <li
              key={d.id}
              className={
                `peer peer-${d.origin.replace(/\s+/g, '-')}` + (d.mark ? ' peer-marked' : '')
              }
            >
              <span className={'peer-dot' + (d.live ? ' live' : '')} aria-hidden="true" />
              <span className="peer-kind">{d.kind}</span>
              <code className="peer-addr">{d.address}</code>
              <span className="peer-where">{d.origin}</span>
              <span className="peer-since">{d.live ? 'watching' : lastWords(d.seen)}</span>
              <button
                className="ghost small"
                title="Sign this device out. It has to be approved again to come back."
                onClick={() => {
                  void api.forgetPhoneDevice(d.id).then(setState)
                  flash('Signed out. That device has to be approved again.')
                }}
              >
                Sign out
              </button>
              {/*
                The sentence sits UNDER the row rather than inside it because it is the one
                thing here somebody has to read rather than scan, and the row is already at
                its width. `Sign out` above is the action; this only explains it.
              */}
              {d.mark && (
                <p className="peer-mark">
                  <span className="peer-mark-when">{sinceWords(d.mark.at)}</span>
                  {d.mark.words}
                  <button
                    className="ghost small"
                    title="Dismiss this. The device stays signed in."
                    onClick={() => {
                      void api.clearPhoneMark(d.id).then(setState)
                      flash('Dismissed. That device is still signed in.')
                    }}
                  >
                    That was me
                  </button>
                </p>
              )}
            </li>
          ))}
          {anon.map((p) => (
            <li key={p.id} className={`peer peer-${p.origin.replace(/\s+/g, '-')}`}>
              <span className="peer-dot live" aria-hidden="true" />
              <span className="peer-kind">{p.kind}</span>
              <code className="peer-addr">{p.address}</code>
              <span className="peer-where">{p.origin}</span>
              <span className="peer-since">typed the code · {sinceWords(p.since)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="hint">Nothing signed in yet. Scan the picture above with a phone.</span>
      )}
      {devices.length > 1 && (
        <div className="dev-acts">
          <button
            className="ghost small"
            onClick={() => {
              void api.forgetPhoneDevice('*').then(setState)
              flash('Every phone signed out.')
            }}
          >
            Sign out all
          </button>
        </div>
      )}
    </div>
  )
}

/** A device that is not watching: when it last was, or that it never has been. */
function lastWords(seen: number): string {
  return seen ? `last seen ${sinceWords(seen)}` : 'not since it was approved'
}

/** Rounded hard: a stream's exact age is never the question, "just now or all morning" is. */
function sinceWords(since: number): string {
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function PhonePanel({ flash }: { flash: (message: string) => void }): JSX.Element {
  const [state, setState] = useState<PhoneState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Opening this panel IS the intent to pair, so serving starts here rather than
    // behind a switch: the QR must be on screen the moment the panel is. The one thing
    // the old switch did that mattered — turning it off — lives on as a button in the
    // fold, and the OFF it sets holds only until this panel is opened again.
    void api.phoneState().then((s) => {
      setState(s)
      if (!s.on) {
        setBusy(true)
        void api
          .setPhoneServing(true)
          .then(setState)
          .finally(() => setBusy(false))
      }
    })
    // A browser arriving or leaving changes the count without anybody asking, so this is
    // pushed rather than polled - see `onChange` in main/phone.ts.
    return api.onPhone(setState)
  }, [])

  if (!state) return <></>
  // The public address wins the QR whenever there is one. Scanning is the path this
  // expects to be used, and a QR that quietly encodes a LAN address while a tunnel is up
  // is the version of this feature that works at the desk and nowhere else.
  const url = (state.tunnel.phase === 'up' && state.tunnel.url) || state.urls[0] || ''
  const hasStableUrl = state.tunnel.phase === 'up' && !!state.tunnel.url && state.tunnel.stable

  return (
    <section className="setting phone-setup" aria-labelledby="phone-setup-title">
      <div className="setting-row">
        <div>
          <strong id="phone-setup-title">Connect your phone or tablet</strong>
          <p className="hint phone-setup-lead">Open your PaneForge desk from this phone. It only watches and types into panes that stay on this computer.</p>
        </div>
        {state.on && state.clients > 0 && (
          <span className="hint">
            {state.clients} {state.clients === 1 ? 'browser' : 'browsers'} watching
          </span>
        )}
      </div>
      {state.error && <div className="dev-error">{state.error}</div>}
      {!state.on && !busy && (
        <div className="dev-acts">
          <span className="hint">Serving is stopped.</span>
          <button
            className="ghost small"
            onClick={() => {
              setBusy(true)
              void api
                .setPhoneServing(true)
                .then(setState)
                .finally(() => setBusy(false))
            }}
          >
            Start again
          </button>
        </div>
      )}
      {state.on && (
        <div className="dev-self">
          {/* The picture IS the setup, so it is the whole of what this panel shows until
              somebody opens the fold. Scanning takes one tap and types nothing; the address
              and the code under `Other ways in` are what is left for a phone with no camera
              or an address the first one could not reach. */}
          <div className="pair-hero">
            {/* No code in the picture while a phone can ask for itself: what it opens is
                the bare address, and what lets it in is a press on this desk. So a
                photograph of this screen is worth nothing, and there is no secret on
                screen to be read over a shoulder. With asking switched off the code goes
                back into the fragment, which is the old zero-tap path. */}
            <PairQr url={url} code={state.asking ? undefined : state.code} size={168} />
            <div className="pair-scan-say">
              <strong className="pair-scan-lead">Scan this with the phone you want to use</strong>
              <p className="hint">
                {state.asking
                  ? 'Open the link, compare the four digits on both screens, then approve it here. That adds this phone as its own device.'
                  : 'Open the link and it is in. Nothing to type. If an older shortcut asks for a code, scan this picture again from that phone.'}
              </p>
              {/* What this particular picture reaches, in the same words the address list
                  uses - a QR that works at the desk and nowhere else must not look like one
                  that works from a train. */}
              {url && <span className="pair-reach">{hasStableUrl ? 'Best for a saved home-screen shortcut · ' : ''}{reachWords(url)}</span>}
            </div>
          </div>
          <PhoneTunnel state={state} setState={setState} />
          <PhoneDevices
            devices={state.devices}
            peers={state.peers}
            setState={setState}
            flash={flash}
          />
          <Fold label="Trouble opening a saved shortcut?">
            <p className="hint phone-recovery">
              A shortcut is tied to its address. Open the current link below on that phone and scan this picture again if it shows the code screen. Tailscale connects the network; this step signs the browser into PaneForge.
            </p>
            {!state.asking && (
              <p className="hint phone-recovery">
                Entering the code works too. It signs the browser in, but does not create a separately named device in this list.
              </p>
            )}
            <div className="dev-field">
              <span className="dev-key">Current links</span>
              <div className="dev-addrs">
                {/* Each address says what it actually reaches. Without this the list is
                    several equal-looking numbers, and the one difference that matters -
                    whether it still works from a train - is invisible until it fails. */}
                {state.urls.length ? (
                  state.urls.map((u) => (
                    <span key={u} className="dev-addr-row">
                      <code className="dev-addr">{u}</code>
                      <span className="dev-reach">{reachWords(u)}</span>
                    </span>
                  ))
                ) : (
                  <code className="dev-addr muted">no network</code>
                )}
              </div>
              <div className="dev-acts">
                <button
                  className="ghost small"
                  disabled={!url}
                  onClick={() => {
                    api.copyText(url)
                    flash('Address copied.')
                  }}
                >
                  Copy
                </button>
                <span className="dev-key">Port</span>
                <input
                  className="dev-port"
                  aria-label="Phone port"
                  value={String(state.port)}
                  onChange={(e) => void api.setPhonePort(Number(e.target.value) || 0).then(setState)}
                />
              </div>
            </div>
            <div className="dev-field">
              <span className="dev-key">Code</span>
              {/* Not masked, unlike the pairing code below: this one is typed while looking
                  at this screen from the phone in your other hand. */}
              <code className="dev-code">{state.code}</code>
              <div className="dev-acts">
                <button
                  className="ghost small"
                  onClick={() => {
                    api.copyText(state.code)
                    flash('Code copied.')
                  }}
                >
                  Copy
                </button>
                <button
                  className="ghost small"
                  title="New code. Every phone signed in with the old one is signed out."
                  onClick={() => {
                    void api.rotatePhoneCode().then(setState)
                    flash('New code. Phones have to sign in again.')
                  }}
                >
                  New code
                </button>
              </div>
            </div>
            <p className="hint">
              The code is the way in for a browser that cannot scan, or when asking is off
              below. A new code signs out every phone that used one. Approved devices hold
              a secret of their own and are signed out by name, above.
            </p>
            <Switch
              checked={state.asking}
              onChange={(on) => void api.setPhoneAsking(on).then(setState)}
              label="Let a browser ask to be let in"
              hint="It raises a card on this screen with four digits and the same four on the phone. Nothing is granted until you press Approve here. Off, and a phone has to type the code."
            />
            <Switch
              checked={state.typeGate}
              onChange={(on) => void api.setPhoneTypeGate(on).then(setState)}
              label="Ask for a passkey before typing"
              hint="Watching a pane stays free; the first keystroke asks for Face ID or Windows Hello, then stays unlocked for fifteen minutes. Only applies to a phone coming in over the public address — on this network there is no way for a browser to prove a passkey, so nothing changes there."
            />
            {state.keys.length > 0 && (
              <div className="dev-field dev-peers">
                <span className="dev-key">Passkeys</span>
                <ul className="peer-list">
                  {state.keys.map((k) => (
                    <li key={k.id} className="peer">
                      <span className="peer-dot" aria-hidden="true" />
                      <span className="peer-kind">{k.label}</span>
                      <span className="peer-since">added {lastWords(k.at)}</span>
                      <button
                        className="ghost small"
                        title="Remove this passkey. Anything it unlocked stops working now, not when the window runs out."
                        onClick={() => {
                          void api.forgetPhoneKey(k.id).then(setState)
                          flash('Passkey removed. That device has to enrol again to type.')
                        }}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="dev-acts">
              <button
                className="ghost small"
                title="Closes the phone page. Opening this panel starts it again."
                onClick={() => {
                  setBusy(true)
                  void api
                    .setPhoneServing(false)
                    .then(setState)
                    .finally(() => setBusy(false))
                }}
              >
                Stop serving this desk
              </button>
            </div>
          </Fold>
        </div>
      )}
    </section>
  )
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
  /** An invite already on this machine's clipboard: pairing is then one button. */
  const [waiting, setWaiting] = useState<{ name: string; expires: number } | null>(null)
  /** The typed-by-hand fallback, hidden until it is asked for. */
  const [manual, setManual] = useState(false)
  const [name, setName] = useState(state?.self.name ?? '')
  const [showCode, setShowCode] = useState(false)
  /**
   * The device whose launcher is open, and what it answered when asked what it has.
   * Both come from over there: this machine's projects root and this machine's
   * installed CLIs say nothing about what is checked out or usable on the other one.
   */
  const [opening, setOpening] = useState<string | null>(null)
  // Hand off is two presses on purpose: the first arms it, the second moves every
  // pane on this machine. A mis-click costs a re-read, never a desk.
  const [handing, setHanding] = useState<string | null>(null)
  const [handBusy, setHandBusy] = useState(false)
  useEffect(() => {
    if (!handing) return
    const t = setTimeout(() => setHanding(null), 6000)
    return () => clearTimeout(t)
  }, [handing])

  async function handOff(id: string, name: string): Promise<void> {
    if (handing !== id) {
      setHanding(id)
      return
    }
    setHanding(null)
    setHandBusy(true)
    try {
      const items = await api.handoffToDevice(id)
      flash(handoffReport(items, name))
    } catch (err) {
      flash((err as Error).message)
    } finally {
      setHandBusy(false)
    }
  }
  const [far, setFar] = useState<{ projects: Project[]; agents: AgentInfo[] } | null>(null)
  const [farCwd, setFarCwd] = useState('')
  const [farAgent, setFarAgent] = useState('')
  const [farModel, setFarModel] = useState('')
  const [farPrompt, setFarPrompt] = useState('')

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
      // A remote pane is normally an interactive coding task. Prefer Claude when it is
      // available, then Codex, then the first usable runner instead of making a phone
      // user choose an implementation detail before they can start work on the PC.
      setFarAgent(usable.find((a) => a.id === 'claude')?.id ?? usable.find((a) => a.id === 'codex')?.id ?? usable[0]?.id ?? '')
      setFarModel('')
      setFarPrompt('')
    } catch (e) {
      setError((e as Error).message)
      setOpening(null)
    }
  }

  const launchFar = async (device: string, deviceName: string): Promise<void> => {
    if (!farCwd || !farAgent) return
    try {
      await api.startRemote(device, {
        cwd: farCwd,
        agent: farAgent,
        model: farModel || undefined,
        prompt: farPrompt.trim() || undefined
      })
      setOpening(null)
      onClose()
      flash(`Started on ${deviceName}. The pane is in your list and stays live on that device.`)
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

  // If the invite was copied on the other machine a moment ago it is already here, and
  // asking the person to paste something they can see they have copied is a step for the
  // sake of one. Re-checked on a timer because this dialog is usually opened BEFORE
  // walking over to press Copy on the other device.
  useEffect(() => {
    const look = (): void => void api.clipboardInvite().then(setWaiting)
    look()
    const t = window.setInterval(look, 2000)
    return () => window.clearInterval(t)
  }, [])

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

  /**
   * Pair from one pasted line. This is the path meant to be used: the invite carries the
   * address, the port and the code together, so there is nothing to read off one screen
   * and retype on another.
   */
  const pasteInvite = async (text: string): Promise<void> => {
    if (pairing || !text.trim()) return
    setPairing(true)
    setError('')
    try {
      const res = await api.pairRemoteText(text)
      onState(res.state)
      if (res.ok) {
        setCode('')
        setAddress('')
        flash(`Paired with ${res.name || 'that device'}. Its panes are in your list.`)
        onClose()
        return
      }
      // A bare code is not a failure, it is half of what is needed: fill it in and open
      // the fields that ask for the rest, rather than making them start again.
      if (res.code) {
        setCode(res.code)
        setManual(true)
        setError('That is a pairing code on its own. It needs an address too - or press “Copy invite” on the other device and paste that instead.')
        return
      }
      setError(res.error ?? 'Could not pair from that.')
    } finally {
      setPairing(false)
    }
  }

  /**
   * Pair with the invite already on this machine's clipboard.
   *
   * The text never comes into the renderer: the main process reads the clipboard, pairs,
   * and answers with the same shape a paste would have produced. A pairing code is a key,
   * and there is no reason for the window to hold one.
   */
  const pairClipboard = async (): Promise<void> => {
    if (pairing) return
    setPairing(true)
    setError('')
    try {
      const res = await api.pairFromClipboard()
      onState(res.state)
      if (res.ok) {
        flash(`Paired with ${res.name || 'that device'}. Its panes are in your list.`)
        onClose()
        return
      }
      setError(res.error ?? 'Could not pair from that invite.')
    } finally {
      setPairing(false)
    }
  }

  /**
   * Pair with something the LAN broadcast already told us the address of.
   *
   * Tapping it ASKS rather than demanding a code: the other device raises a card with six
   * digits, this one shows the same six, and somebody over there presses Approve. Typing a
   * code still works and still wins when one has been typed - a device that has the code on
   * screen in front of it should not be made to walk to the other machine.
   */
  const pairFound = (f: RemoteFound): void => {
    if (code.trim()) {
      void pair({ address: f.address, port: f.port, code, name: f.name })
      return
    }
    setError('')
    setPairing(true)
    void api
      .askToPair({ address: f.address, port: f.port, name: f.name })
      .then((res) => {
        onState(res.state)
        if (!res.ok) setError(res.error ?? 'That device did not let this one in.')
        else flash(`Paired with ${f.name}.`)
      })
      .finally(() => setPairing(false))
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide devices" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Devices</strong>
          <span className="hint">connect a phone or another computer to this desk</span>
        </div>
        <Blurb id="devices" />

        {/* Two columns, and the reason is arithmetic rather than taste: measured in a real
            window at 1500x912 with NOTHING paired, this panel was 1057px of content in an
            812px box - so it scrolled on an empty desk, and every section below the fold
            was found by dragging. Stacked, it can only get worse: a paired machine adds a
            row per pane it has.

            It is also the ONE growing child this dialog never had. Without one the whole
            dialog scrolls and the footer is pinned over it with `position: sticky`, which
            is why the Close button had content sliding under its top edge. With the
            columns as the scroll body, the head and the footer are outside it and nothing
            can reach them.

            Left is the phone, which is the one thing here that finishes in a single action
            and is the tallest section by far - measured at 801px against the other three
            put together at 145. Right is this machine, what it is already paired with, and
            how to add another. One column again under 1000px. */}
        <div className="dev-cols">
          <div className="dev-col">
        {/* ------------------------------------------------------------------- phone
            First, above the desktop card, because it is the one people arrive here for
            and because it is the one that finishes in a single action - point a camera at
            the picture. A phone is a device too, so it lives here rather than in Settings,
            but it is not a peer: there is no app at the far end to pair with, only a
            browser, and what it loads is this window's own UI. See main/phone.ts. */}
        <PhonePanel flash={flash} />
          </div>

          <div className="dev-col computer-setup">
        <div className="device-section-head">
          <strong>Connect another computer</strong>
          <span className="hint">Its panes stay there. You choose which ones to view here.</span>
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

          {/* Under the hosting switch because it is only ever about an open listener: what
              it grants is the right to put a card on THIS screen, and the card is a refusal
              until somebody compares two numbers and presses Approve. */}
          {self.hosting && (
            <Switch
              checked={self.pairByAsking}
              onChange={(on) => void api.setPairByAsking(on).then(onState)}
              label="Let a device on this network ask to pair"
              hint="It puts a card on this screen with six digits. Approve it only when the same six are on the other device. That match is what proves nothing is relaying the connection. Off, and pairing needs the code typed."
            />
          )}

          {self.error && <div className="dev-error">{self.error}</div>}

          {/* What this desk is running with no pane on it - behind a fold, because it is
              a question somebody comes here to ASK and not one this screen should open
              by answering. Nine times in ten the answer is "Nothing running outside its
              panes", and a sentence saying nothing is happening, with a Refresh button
              beside it, was the second thing in the first card of a dialog whose actual
              job is pairing. Opening it still costs one process-table read and nothing
              polls; a closed <details> never mounts its body, so the read now happens
              when it is wanted rather than on every open. */}
          <Fold label="What else this machine is running">
            <PeerJobs id={null} name={self.name} />
          </Fold>

          {self.hosting && (
            <div className="dev-self">
              {/* The one action on this card. Everything under it is what an invite is
                  made of, kept for the case where the two machines cannot share a
                  clipboard - it is not the way in any more. */}
              <div className="dev-invite">
                <button
                  className="primary"
                  disabled={!self.addresses.length}
                  title={
                    self.addresses.length
                      ? 'Copy one line. Paste it into Devices on the other machine and it pairs itself.'
                      : 'This device is not on a network, so there is no address to invite anyone to.'
                  }
                  onClick={() => {
                    void api.remoteInvite().then((text) => {
                      api.copyText(text)
                      flash('Invite copied. Paste it into Devices on the other machine.')
                    })
                  }}
                >
                  Copy invite
                </button>
                <span className="hint">
                  {self.addresses.length
                    ? 'One line: this device’s address, port and code. Good for 15 minutes.'
                    : 'No network - nothing to invite anyone to yet.'}
                </span>
              </div>
              <Fold label="Pair by hand">
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
              </Fold>
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
            {state.peers.map((p) => {
              const gap = p.status === 'online' ? versionGap(p.version, state.self.version) : null
              return (
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
                          {p.sessions ? `mirroring ${p.sessions} of ${p.panes.length}` : `${p.panes.length} panes there`}
                        </span>
                      )}
                      {p.status !== 'online' && p.seen && <span className="chip">on this network</span>}
                      {p.status === 'connecting' && <span className="chip">connecting</span>}
                      {gap && (
                        <span
                          className="chip"
                          title="Updates land one machine at a time; a fix may be on only one of them until both restart."
                        >
                          {gap}
                        </span>
                      )}
                    </div>
                    {/* An IP and a port identify this machine to somebody debugging a
                        link and to nobody else - and they were the only sub-line a
                        paired device had, so every row said `192.168.1.14:7311` under a
                        name. The row now says what the row is FOR (whether it is
                        reachable, in words), and the address stays on the hover for the
                        case it is really being asked. An error still wins the line: it
                        is the one thing here somebody has to act on. */}
                    <div className="dev-sub" title={`${p.address}:${p.port}`}>
                      <span className={'dot ' + p.status} />
                      {p.error
                        ? p.error
                        : p.status === 'online'
                          ? 'Connected'
                          : p.status === 'connecting'
                            ? 'Connecting…'
                            : 'Not connected'}
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
                    {p.status === 'online' && (
                      <button
                        className="ghost small"
                        title={`Open supported panes on ${p.name}. Claude and Codex resume their saved conversations and keep their originals here. Shells start fresh there. Other agents stay here with an explanation. Both computers need an updated PaneForge. This does not transfer a running process.`}
                        disabled={handBusy}
                        onClick={() => void handOff(p.id, p.name)}
                      >
                        {handBusy ? 'Opening…' : handing === p.id ? 'Open supported panes?' : 'Open panes there'}
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
                {/* What this window mirrors from that device.
                    Connecting used to mean mirroring all of it, immediately - so the
                    sidebar filled with panes nobody asked for, each streaming its output
                    across the network, and the same work appeared twice whenever both
                    machines had it open. A link is permission to watch; this is the
                    watching, and it is a tick per pane. */}
                {p.status === 'online' && p.panes.length > 0 && (
                  <div className="dev-panes">
                    <div className="dev-panes-head">
                      <span className="hint">
                        {p.sessions === 0
                          ? `Nothing from ${p.name} is on screen here. Tick what to watch.`
                          : `Watching ${p.sessions} of ${p.panes.length} on ${p.name}.`}
                      </span>
                      <button
                        className={'ghost small' + (p.mirrorAll ? ' active' : '')}
                        title={`Mirror every pane ${p.name} has, including ones it opens later`}
                        onClick={() => void api.watchRemote(p.id, [], true).then(onState)}
                      >
                        All
                      </button>
                      <button
                        className="ghost small"
                        disabled={p.sessions === 0}
                        title={`Stop mirroring ${p.name}'s panes. The link stays up.`}
                        onClick={() => void api.watchRemote(p.id, []).then(onState)}
                      >
                        None
                      </button>
                    </div>
                    {p.panes.map((pane) => (
                      <label key={pane.id} className={'dev-pane' + (pane.watched ? ' on' : '')} title={pane.cwd}>
                        <Checkbox
                          checked={pane.watched}
                          onChange={() =>
                            void api
                              .watchRemote(
                                p.id,
                                p.panes.filter((x) => (x.id === pane.id ? !x.watched : x.watched)).map((x) => x.id)
                              )
                              .then(onState)
                          }
                        />
                        <AgentLogo id={pane.agent} size={13} />
                        <span className="dev-pane-nm">{pane.title}</span>
                        <span className="dev-pane-cwd">{pane.cwd}</span>
                        <span className={'dot ' + (pane.status === 'exited' ? 'off' : 'online')} />
                      </label>
                    ))}
                  </div>
                )}
                {p.status === 'online' && <PeerJobs id={p.id} name={p.name} />}
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
                        <AgentPicker
                          small
                          agents={far.agents}
                          agent={farAgent}
                          model={farModel}
                          onChange={(agent, model) => {
                            setFarAgent(agent)
                            setFarModel(agent === farAgent ? model : '')
                          }}
                        />
                        <input
                          className="search prompt dev-task"
                          value={farPrompt}
                          onChange={(e) => setFarPrompt(e.target.value)}
                          placeholder="Describe the work. PaneForge sends it when the pane is ready."
                        />
                        <button className="primary" disabled={!farCwd || !farAgent} onClick={() => void launchFar(p.id, p.name)}>
                          {farPrompt.trim() ? 'Start task there' : 'Start there'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              )
            })}
          </div>
        </div>

        {/* --------------------------------------------------------------- pair a new */}
        <div className="setting">
          <div className="setting-row">
            <label>Pair another device</label>
            <span className="hint">tap it below, no code to type</span>
          </div>

          {waiting && (
            <button
              className="dev-waiting"
              disabled={pairing}
              title={`Pair with ${waiting.name} using the invite already on this machine's clipboard`}
              onClick={() => void pairClipboard()}
            >
              <span className="dot on" />
              <strong>{waiting.name || 'A device'}</strong>
              <span className="hint">invite is on your clipboard - click to pair</span>
            </button>
          )}

          {/* A request this device sent, while somebody walks to the other machine. The
              six digits are here so they can be compared with the card over there - that
              comparison IS the pairing, so they are the biggest thing in the panel. */}
          {state.waiting && (
            <div className="pair-wait">
              <div>
                Waiting for <strong>{state.waiting.name}</strong> to approve
              </div>
              <div className="pair-ask-sas">
                {state.waiting.sas.slice(0, 3)} <span>{state.waiting.sas.slice(3)}</span>
              </div>
              <p className="hint">
                Approve it over there, and only if that screen shows this same number.
              </p>
              <button className="ghost small" onClick={() => void api.cancelAsk().then(onState)}>
                Stop waiting
              </button>
            </div>
          )}

          {state.found.length > 0 && (
            <div className="dev-found">
              <span className="dev-key">On this network</span>
              {state.found.map((f) => (
                <button
                  key={f.id}
                  className="dev-chip"
                  disabled={pairing || !!state.waiting}
                  title={
                    code.trim()
                      ? `Pair with ${f.name} at ${f.address} using the code you typed`
                      : `Ask ${f.name} to let this device in - approve it over there, no code to type`
                  }
                  onClick={() => pairFound(f)}
                >
                  <span className="dot connecting" />
                  <span className="dev-chip-nm">{f.name}</span>
                  <span className="hint">{f.address}</span>
                </button>
              ))}
              <p className="hint dev-found-say">
                Tap one and it asks to be let in: six digits appear here and on that screen,
                and somebody presses Approve over there. Nothing to type.
              </p>
            </div>
          )}

          {/* What is left is what you reach for when the network did not find the other
              machine: an invite pasted from a clipboard the two do share, and the address
              typed by hand. Both used to be on screen at all times, ABOVE the list of
              devices this one can already see, which is the wrong way round - the
              ordinary path is tapping a name. Closed until it is asked for. */}
          <Fold label="Other ways to pair">
            <div className="dev-paste">
              <input
                className="dev-invite-in"
                placeholder="Paste the invite from your other device"
                aria-label="Paste an invite"
                value=""
                // The paste IS the action: there is nothing to check before pairing, and a
                // separate button here would be one click that never means anything else.
                onChange={(e) => void pasteInvite(e.target.value)}
                onPaste={(e) => {
                  e.preventDefault()
                  void pasteInvite(e.clipboardData.getData('text'))
                }}
              />
              {pairing && <span className="hint">Pairing...</span>}
            </div>

          {!manual && (
            <button className="ghost small dev-manual" onClick={() => setManual(true)}>
              Type an address and code instead
            </button>
          )}

          <div className="dev-add" hidden={!manual}>
            <input
              placeholder="Pairing code"
              aria-label="Pairing code"
              className="dev-code-in"
              value={code}
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
          </Fold>
          {error && <div className="dev-error">{error}</div>}
        </div>
          </div>
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
