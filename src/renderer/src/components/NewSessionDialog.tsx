import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import type { AgentInfo } from '@shared/agents'
import type { Agent, Project, RouteMatch, StartSessionRequest } from '@shared/types'
import AgentPicker, { AgentInstallBar } from './AgentPicker'
import AgentLogo from './AgentLogo'
import Blurb from './Blurb'
import { Checkbox } from './Controls'

const api = window.api

interface Props {
  projects: Project[]
  defaultAgent: Agent
  /** last model used per agent, so the pick sticks between launches */
  defaultModels: Record<string, string>
  /** persist the last runner/model picked here for the next New session */
  onDefaultsChange: (agent: Agent, model: string) => void
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
  onDefaultsChange,
  agents: probed,
  onStart,
  onSaveWorkspace,
  onCancel
}: Props): JSX.Element {
  // The app re-probes agents when this dialog opens, which is too early for a CLI
  // installed from inside it. Re-probing locally lets the fresh install show up in
  // the picker straight away, without closing and reopening.
  const [live, setLive] = useState<AgentInfo[] | null>(null)
  const agents = live ?? probed
  const reprobe = useCallback(() => void api.listAgents().then(setLive), [])

  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [ticked, setTicked] = useState<string[]>([])
  const [resume, setResume] = useState(false)
  const [agent, setAgent] = useState<Agent>(defaultAgent)
  const [model, setModel] = useState(defaultModels[defaultAgent] ?? '')
  const [prompt, setPrompt] = useState('')
  const [promptCopied, setPromptCopied] = useState(false)
  // What the first message says it is about. `routed` is the project this dialog ticked
  // on the message's behalf, kept apart from the user's own ticks so it can be swapped
  // when the message changes and dropped the moment the user disagrees with it.
  const [route, setRoute] = useState<RouteMatch[]>([])
  const [routed, setRouted] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  // The ref shadows `routed` because the debounced reply lands in a closure that was
  // built before the previous match was stored, and ticking off the wrong path there
  // would leave two projects ticked from one message.
  const routedRef = useRef<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // Only ever shown when the list is empty, to say WHICH folder came up empty.
  const [root, setRoot] = useState('')

  useEffect(() => input.current?.focus(), [])
  useEffect(() => void api.getConfig().then((c) => setRoot(c.root)), [])

  /** Repointing the root re-lists projects through the config event, so no reload here. */
  const chooseRoot = async (): Promise<void> => {
    const picked = await api.pickRoot()
    if (!picked) return
    await api.setConfig({ root: picked })
    setRoot(picked)
  }

  /*
   * Lane worktrees are folded away.
   *
   * A projects root that has been worked in holds one folder per repository and one MORE
   * per lane - `taskdriver.ai`, `taskdriver.ai-a`, `taskdriver.ai-b`, `taskdriver-sessionA` -
   * so this list was half copies, sorted by recency, which puts the copies ABOVE the project
   * they belong to. Nobody launches into a lane by hand either: opening the project is what
   * makes the lane hook hand this chat one. So the answer to "which project" is the list, and
   * the copies live behind a fold that says how many there are.
   */
  const [copiesOpen, setCopiesOpen] = useState(false)
  const { shown, copies } = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects
    const own = list.filter((p) => !p.checkoutOf)
    const rest = list.filter((p) => p.checkoutOf)
    return { shown: (copiesOpen ? [...own, ...rest] : own).slice(0, 60), copies: rest }
  }, [projects, q, copiesOpen])

  useEffect(() => setSel(0), [q])

  const canResume = !!agents.find((a) => a.id === agent)?.resumeArgs
  const routedMatch = route.find((m) => m.path === routed) ?? null

  /**
   * A tick the user made themselves. From here on the message stops choosing the project:
   * having typed a message and then picked a folder, they have already answered the
   * question this feature exists to ask.
   */
  const toggle = (path: string): void => {
    setManual(true)
    setTicked((t) => (t.includes(path) ? t.filter((p) => p !== path) : [...t, path]))
  }

  /*
   * Both of these read the previous route into a local BEFORE touching state, and the
   * updater closes over that local rather than over the ref.
   *
   * Reading `routedRef.current` inside the updater looks equivalent and is not: React
   * runs the updater at render time, by which point the line below has already moved the
   * ref on, so the filter removes the project it is about to add instead of the one it
   * replaced. Measured in a real window - retyping the message left Toolstash AND
   * PaneForge ticked, and the x removed neither.
   */

  /** Tick what the message named, replacing whatever it named a keystroke ago. */
  const applyRoute = useCallback((path: string): void => {
    const previous = routedRef.current
    routedRef.current = path
    setTicked((t) => {
      const kept = t.filter((p) => p !== previous)
      return kept.includes(path) ? kept : [...kept, path]
    })
    setRouted(path)
  }, [])

  /** Untick what the message chose, without the user having said anything about it. */
  const dropRouteQuietly = useCallback((): void => {
    const previous = routedRef.current
    routedRef.current = null
    setTicked((t) => t.filter((p) => p !== previous))
    setRouted(null)
  }, [])

  /** The user rejecting the suggestion, which also stops it coming back as they type. */
  const dropRoute = (): void => {
    dropRouteQuietly()
    setManual(true)
  }

  /*
   * Routing runs on the message, debounced, and never while the user is choosing folders
   * by hand. The 200ms is not for the main process - the match is a string comparison
   * against a cached alias list - it is so a half-typed word does not tick a project for
   * one frame on the way to naming a different one.
   */
  useEffect(() => {
    const text = prompt.trim()
    if (text.length < 3) {
      setRoute([])
      return
    }
    const timer = setTimeout(() => {
      void api.routeProjects(text).then((r) => {
        setRoute(r.matches)
        if (manual) return
        if (r.confident && r.matches[0]) applyRoute(r.matches[0].path)
        else if (routedRef.current) dropRouteQuietly()
      })
    }, 200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, manual, applyRoute])

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
        <Blurb id="newSession" />

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
              <span className="tick" data-tick="1" onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={ticked.includes(p.path)} onChange={() => toggle(p.path)} />
              </span>
              <span className="proj-name">{p.name}</span>
              {p.checkoutOf && <span className="tag">copy of {p.checkoutOf}</span>}
              {!p.isGit && !p.checkoutOf && <span className="tag">no git</span>}
              <span className="proj-age">{ago(p.lastUsed)}</span>
            </div>
          ))}
          {copies.length > 0 && (
            <button
              className="proj-copies"
              aria-expanded={copiesOpen}
              title="Lane worktrees: second checkouts the lane engine made of these projects. Opening the project itself is what gets this chat a lane."
              onClick={() => setCopiesOpen((v) => !v)}
            >
              <span className={'proj-copies-mark' + (copiesOpen ? ' on' : '')}>›</span>
              {copiesOpen ? 'Hide' : 'Show'} {copies.length} lane {copies.length === 1 ? 'checkout' : 'checkouts'}
            </button>
          )}
          {shown.length === 0 &&
            copies.length === 0 &&
            (q.trim() ? (
              <div className="empty">No match</div>
            ) : (
              /*
               * First run on a machine whose code is not where the default guessed. This
               * used to say "No match", which is true and useless: there is no filter to
               * clear, and nothing on screen said the app was looking in a folder you had
               * never chosen. Say which folder, and offer to change it right here.
               */
              <div className="empty first-run">
                <div>
                  Nothing to open in <code>{root || '...'}</code>.
                </div>
                <div>Point PaneForge at the folder your projects live in.</div>
                <button className="primary small" onClick={chooseRoot}>
                  Choose projects folder
                </button>
              </div>
            ))}
        </div>

        <div className="prompt-row">
          <input
            className="search prompt"
            // Routing decides which folder a session opens in from state nothing else can
            // see. These two say what it decided, so route-view-test.mjs can measure it in
            // a real window instead of inferring it from which row looks ticked.
            data-routed={routed ?? ''}
            data-manual={manual ? '1' : '0'}
            placeholder="Optional first message, sent to every session started here"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value)
              setPromptCopied(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <button
            className="ghost small"
            disabled={!prompt}
            title="Copy this first prompt"
            onClick={() => {
              api.copyText(prompt)
              setPromptCopied(true)
            }}
          >
            {promptCopied ? 'Copied' : 'Copy'}
          </button>
        </div>

        {/*
         * What the message is about. A session opened in the wrong project is silent and
         * expensive - the agent reads the wrong instructions, searches the wrong indexes
         * and can write into the wrong checkout - and the only moment it is cheap to fix
         * is this one, before the session exists. So a message that clearly names a
         * project ticks it, visibly, with the reason and a way to say no.
         */}
        {route.length > 0 && (
          <div className="route">
            {routedMatch ? (
              <>
                <span className="route-on">Opening in {routedMatch.name}</span>
                <span className="route-why">{routedMatch.why}</span>
                <button className="route-x" onClick={dropRoute} title="Do not use this project">
                  ×
                </button>
              </>
            ) : (
              <span className="route-why">Message may mean:</span>
            )}
            {route
              .filter((m) => m.path !== routed)
              .slice(0, 3)
              .map((m) => (
                <button
                  key={m.path}
                  className="route-alt"
                  onClick={() => {
                    setManual(true)
                    setTicked((t) => (t.includes(m.path) ? t : [...t, m.path]))
                  }}
                  title={m.why}
                >
                  {m.name}
                </button>
              ))}
          </div>
        )}

        {/* The chips and the actions are pinned to the bottom together. Pinning only the
            button row let it ride up over the chips as soon as the dialog scrolled - the
            install chips ended at 620px and the pinned row started at 616. */}
        <div className="dialog-foot">
          <AgentInstallBar agents={agents} onInstalled={reprobe} />

          <div className="dialog-row">
            <Checkbox
              checked={resume && canResume}
              disabled={!canResume}
              onChange={setResume}
              label="Resume last session"
              title={canResume ? '' : `${agents.find((a) => a.id === agent)?.label ?? agent} has no resume flag`}
            />
            <AgentPicker
              agents={agents}
              agent={agent}
              model={model}
              onInstalled={reprobe}
              onChange={(a, m) => {
                // Switching CLI carries its own remembered model, not the previous one's -
                // UNLESS the change came from picking a model, which is how a borrowed
                // OpenRouter model arrives. The runner dropdown always sends an empty
                // model, so a non-empty one means somebody chose it and it must survive.
                const nextModel = a === agent || m ? m : defaultModels[a] ?? ''
                setAgent(a)
                setModel(nextModel)
                onDefaultsChange(a, nextModel)
              }}
            />
            <button className="ghost" onClick={save} disabled={!ticked.length}>
              Save as workspace
            </button>
            <button className="primary" onClick={() => go()}>
              <AgentLogo id={agent} spec={agents.find((a) => a.id === agent)} size={14} />
              Start {ticked.length > 1 ? `${ticked.length} sessions` : ''}
            </button>
          </div>
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
