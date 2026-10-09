// The first-run welcome: what a profile that has never opened a pane shows instead of the
// empty desk - in the middle of the window, or at the top of the list on a narrow screen
// where the list is the home screen. Never again once a pane has opened. It does the
// setting up itself - finds Claude and Codex and the account each is signed in with,
// installs or signs in the one picked through the same console the Welcome checklist
// uses, picks a folder, opens the first chat - so a person who has never used a terminal
// gets to a working chat by pressing one button, at most three times.
//
// Same card recipe as the rest of Welcome (design-vault/linear.app.md, "Card (feature)"):
// a hairline border on a surface one step up, no shadow, no gradient, tokens only.

import { useCallback, useEffect, useState } from 'react'
import type { SetupRow, SetupRowId } from '@shared/setupCheck'
import type { StartSessionRequest } from '@shared/types'
import { BUILTIN_AGENTS, findAgent } from '@shared/agents'
import {
  agentStates,
  chatAgent,
  firstChatFolder,
  nextStep,
  recommendedInstall,
  showFirstRun,
  signInAgent,
  signInRow,
  FIRST_FOLDER,
  type AgentState,
  type FirstAgent
} from '@shared/firstRun'
import AgentLogo, { AppLogo } from './AgentLogo'
import InstallConsole from './InstallConsole'

const api = window.api

/** What each assistant IS, for someone who has never heard of either. */
const WORDS: Record<FirstAgent, { name: string; maker: string; account: string }> = {
  claude: { name: 'Claude', maker: 'Anthropic', account: 'Claude account' },
  codex: { name: 'Codex', maker: 'OpenAI', account: 'ChatGPT account' }
}

/**
 * Whether this profile still gets the welcome. null while the first read is out, so
 * neither the welcome nor the empty desk flashes up and gets swapped.
 */
export function useFirstRun(): [boolean | null, (show: boolean) => void] {
  const [firstRun, setFirstRun] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    api
      .getConfig()
      .then(async (config) => {
        // The flag alone settles it; past sessions are only read for a profile without it.
        const past = config.firstChatStarted ? 0 : (await api.listHistory()).length
        const show = showFirstRun(config.firstChatStarted, past)
        // Somebody who has used this profile before gets the flag now, so the past-session
        // list is read once per profile rather than every time the desk empties.
        if (!show && !config.firstChatStarted) api.setConfig({ firstChatStarted: true }).catch(() => undefined)
        return show
      })
      .catch(() => false)
      .then((show) => live && setFirstRun(show))
    return () => {
      live = false
    }
  }, [])
  return [firstRun, setFirstRun]
}

interface Props {
  /** Opens a pane the way New session does. Resolves null when nothing opened. */
  onLaunch: (req: StartSessionRequest) => Promise<'local' | 'remote' | null>
  /** The first chat is open: the welcome retires for good. */
  onStarted: () => void
}

/**
 * Drawn in one of two places (`App.tsx`: the middle of the window, or the list on a narrow
 * screen), so resizing across 720px mounts a fresh copy and drops a console mid-sign-in.
 * Nothing is lost that matters: the sign-in itself carries on in the main process, the
 * remount re-reads whether it finished, and pressing the button again starts it over.
 */
export default function FirstRunCard({ onLaunch, onStarted }: Props): JSX.Element | null {
  const [rows, setRows] = useState<SetupRow[] | null>(null)
  const [unchecked, setUnchecked] = useState(false)
  const [accounts, setAccounts] = useState({ claude: '', codex: '' })
  const [root, setRoot] = useState('')
  const [rootExists, setRootExists] = useState(false)
  const [preferred, setPreferred] = useState('')
  const [pick, setPick] = useState<FirstAgent | null>(null)
  const [log, setLog] = useState<SetupRowId | ''>('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Same moments as the Welcome checklist: on show, after an install or sign-in, and when
  // the window comes back to the front (somebody may have installed or signed in elsewhere).
  const refresh = useCallback(() => {
    // A failed check keeps what was known. An empty list would read as "everything is
    // installed and signed in" and offer a Start button on a machine with nothing on it.
    api
      .checkSetup()
      .then((r) => {
        setRows(r)
        setUnchecked(false)
      })
      .catch(() => setUnchecked(true))
    api
      .setupAccounts()
      .then(setAccounts)
      .catch(() => undefined)
    Promise.all([api.getConfig(), api.listSessionFolders()])
      .then(([config, folders]) => {
        // The "All projects" row is only there when the folder is, and it is the folder
        // `createProject` would use - a saved one that vanished has already been swapped.
        const projects = folders.find((f) => f.scope === 'projects')
        setRoot(projects?.path ?? config.root)
        setRootExists(Boolean(projects))
        setPreferred(config.defaultAgent)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const finished = useCallback(
    (ok: boolean) => {
      setBusy(false)
      if (!ok) {
        setError('That did not finish. The box above shows what happened.')
        return
      }
      setLog('')
      setError('')
      refresh()
    },
    [refresh]
  )

  if (!rows) {
    if (!unchecked) return null
    return (
      <div className="fr-card">
        <span className="install-err">Could not check what is installed on this computer.</span>
        <button className="pill fr-go" onClick={refresh}>
          Try again
        </button>
      </div>
    )
  }

  /** Shows `id`'s console; it starts the install or sign-in itself once it is listening. */
  const run = (id: SetupRowId): void => {
    setError('')
    // A sign-in waits on the web browser and may never come back (a closed tab), so it
    // does not lock the card: pressing its button again starts it over.
    setBusy(!signInAgent(id))
    setLog(id)
    // Bumped per click so a retry remounts the console instead of showing the dead log.
    setAttempt((n) => n + 1)
  }

  const change = async (): Promise<void> => {
    const picked = await api.pickRoot()
    if (!picked) return
    await api.setConfig({ root: picked })
    refresh()
  }

  const start = async (agent: FirstAgent): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const plan = firstChatFolder(root, rootExists)
      const cwd = 'cwd' in plan ? plan.cwd : (await api.createProject(plan.create))?.path
      if (!cwd) {
        setError(`Could not make a folder in ${root}. Press Change and pick another one.`)
        return
      }
      const opened = await onLaunch({ cwd, agent })
      if (!opened) {
        setError('The chat did not open. The message PaneForge just showed says why.')
        return
      }
      // Pins the folder that was guessed and the assistant that was picked (Ctrl T opens
      // on it next time), and retires the welcome for good.
      const folder = 'cwd' in plan ? root : cwd.replace(/[\\/][^\\/]+[\\/]?$/, '')
      await api.setConfig({ firstChatStarted: true, root: folder, defaultAgent: agent })
      onStarted()
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FirstRunView
      rows={rows}
      accounts={accounts}
      pick={pick}
      root={root}
      rootExists={rootExists}
      preferred={preferred}
      log={log}
      attempt={attempt}
      busy={busy}
      error={error}
      onPick={(agent) => {
        setPick(agent)
        setError('')
        // A sign-in left behind (failed, or the browser tab closed) must not hold the other
        // assistant's chip shut. It only ever shows on its own row, and its own button
        // starts it over.
        if (signInAgent(log) && signInAgent(log) !== agent) setLog('')
      }}
      onRun={run}
      onFinished={finished}
      onChange={() => void change()}
      onStart={(agent) => void start(agent)}
    />
  )
}

export interface FirstRunViewProps {
  /** `setup:check`, unfiltered - the Codex rows are this card's. */
  rows: SetupRow[]
  /** The email each assistant is signed in with, '' when unknown. */
  accounts: { claude: string; codex: string }
  /** The assistant the person clicked, null until they click one. */
  pick: FirstAgent | null
  /** The projects folder: the one that exists, or the guess that will be made. */
  root: string
  rootExists: boolean
  /** The saved default assistant, the tie-break for which one is picked to begin with. */
  preferred: string
  /** The install or sign-in being shown in the console, '' for none. */
  log: SetupRowId | ''
  attempt: number
  /** An install or the first chat is on its way: every button waits. */
  busy: boolean
  error: string
  onPick: (agent: FirstAgent) => void
  onRun: (id: SetupRowId) => void
  onFinished: (ok: boolean) => void
  onChange: () => void
  onStart: (agent: FirstAgent) => void
}

/** The assistant picked to begin with: a ready one, then the saved default, then Claude. */
export function pickedAgent(states: AgentState[], pick: FirstAgent | null, preferred: string): FirstAgent {
  return pick ?? chatAgent(states, preferred) ?? recommendedInstall(states) ?? 'claude'
}

/** Everything the card draws, from plain values - so a test can render each machine state. */
export function FirstRunView(p: FirstRunViewProps): JSX.Element {
  const states = agentStates(p.rows)
  const chosen = pickedAgent(states, p.pick, p.preferred)
  const state = states.find((s) => s.id === chosen) ?? { id: chosen, installed: false, signedIn: false }
  const step = nextStep(state)
  const w = WORDS[chosen]
  const gitRow = p.rows.find((r) => r.id === 'git')
  const signingIn = p.log === signInRow(chosen)
  const folderName = p.root.split(/[\\/]/).filter(Boolean).pop() ?? p.root

  const go = (): void => {
    if (step === 'install') p.onRun(chosen)
    else if (step === 'signin') p.onRun(signInRow(chosen))
    else p.onStart(chosen)
  }
  const label =
    step === 'install'
      ? p.busy && p.log === chosen
        ? `Installing ${w.name}...`
        : `Install ${w.name}`
      : step === 'signin'
        ? signingIn
          ? 'Start the sign-in again'
          : `Sign in to ${w.name}`
        : p.busy
          ? 'Opening...'
          : `Start chatting with ${w.name}`
  const note =
    step === 'install'
      ? `Downloads ${w.name} from ${w.maker}. Takes a minute or two.`
      : step === 'signin'
        ? `Opens your web browser so you can sign in with your ${w.account}.`
        : `Opens ${w.name} in ${p.rootExists ? folderName : `a new folder, ${FIRST_FOLDER}`}.` +
          (chosen === 'claude'
            ? ' If Claude asks something the first time, like whether it may work in this folder, press Enter to say yes.'
            : '')

  return (
    <div className="fr-card">
      <div className="fr-top">
        <span className="fr-logo">
          <AppLogo size={30} />
        </span>
        <h1 className="fr-h">Welcome to PaneForge</h1>
      </div>
      <p className="fr-sub">
        Tell an AI coding assistant what you want in plain words, and it does the work: it reads your files, changes
        them and runs them, right here on this computer. Open as many as you like, side by side.
      </p>
      <ol className="fr-steps">
        <li className="fr-step">
          <span className="fr-num">1</span>
          <div className="fr-body">
            <span className="fr-label">Choose your assistant</span>
            <div className="fr-chips" role="group" aria-label="Assistant">
              {states.map((s) => (
                <AgentChip
                  key={s.id}
                  state={s}
                  email={p.accounts[s.id]}
                  on={s.id === chosen}
                  disabled={p.busy}
                  onPress={() => p.onPick(s.id)}
                />
              ))}
            </div>
            {gitRow && chosen === 'claude' && (
              <div className="fr-line">
                <span className="fr-note">Claude needs Git for Windows to run commands on this PC.</span>
                <button className="pill" disabled={p.busy || signingIn} onClick={() => p.onRun('git')}>
                  Install Git
                </button>
              </div>
            )}
          </div>
        </li>
        <li className="fr-step">
          <span className="fr-num">2</span>
          <div className="fr-body">
            <span className="fr-label">Your projects folder</span>
            <div className="fr-line">
              <span className="fr-path" title={p.root}>
                {p.root}
              </span>
              <button className="pill" disabled={p.busy} onClick={p.onChange}>
                Change
              </button>
            </div>
            <span className="fr-note">
              {p.rootExists ? 'Every chat works inside a folder here.' : 'Made for you when you start.'}
            </span>
          </div>
        </li>
        <li className="fr-step">
          <span className="fr-num">3</span>
          <div className="fr-body">
            <button className="primary fr-go" disabled={p.busy} onClick={go}>
              {label}
            </button>
            <span className="fr-note">{note}</span>
          </div>
        </li>
      </ol>
      {p.log && (
        <InstallConsole
          key={p.log + p.attempt}
          agentId={p.log}
          onDone={p.onFinished}
          start={(id) => {
            const signing = signInAgent(id)
            void (id === 'git' ? api.installGit() : signing ? api.signIn(signing) : api.installAgent(id))
          }}
        />
      )}
      {p.error && <span className="install-err">{p.error}</span>}
    </div>
  )
}

function AgentChip({
  state,
  email,
  on,
  disabled,
  onPress
}: {
  state: AgentState
  email: string
  on: boolean
  disabled: boolean
  onPress: () => void
}): JSX.Element {
  const w = WORDS[state.id]
  const ready = state.installed && state.signedIn
  const status = !state.installed
    ? 'Not installed yet'
    : !state.signedIn
      ? 'Not signed in yet'
      : email
        ? `Signed in as ${email}`
        : 'Ready'
  return (
    <button className={'fr-chip' + (on ? ' on' : '')} aria-pressed={on} disabled={disabled} onClick={onPress}>
      <AgentLogo id={state.id} spec={findAgent(BUILTIN_AGENTS, state.id)} size={22} muted={!state.installed} />
      <span className="fr-chip-text">
        <span className="fr-chip-name">
          {w.name}
          <span className="fr-what"> by {w.maker}</span>
        </span>
        <span className={'fr-chip-status' + (ready ? ' ok' : '')}>{status}</span>
      </span>
    </button>
  )
}
