// The first-run card: shown on the Welcome screen of a profile that has never opened a
// pane, above "Open a project", and never again once one has opened. It does the setting
// up itself - installs an assistant through the same console the Welcome checklist uses,
// picks a folder, opens the first chat - so a person who has never used a terminal gets
// to a working chat without reading anything or typing a command.
//
// Same card recipe as the rest of Welcome (design-vault/linear.app.md, "Card (feature)"):
// a hairline border on a surface one step up, no shadow, no gradient, tokens only.

import { useCallback, useEffect, useState } from 'react'
import type { SetupRow, SetupRowId } from '@shared/setupCheck'
import type { StartSessionRequest } from '@shared/types'
import {
  agentStates,
  chatAgent,
  firstChatFolder,
  recommendedInstall,
  FIRST_FOLDER,
  type AgentState,
  type FirstAgent
} from '@shared/firstRun'
import InstallConsole from './InstallConsole'

const api = window.api

/** What each assistant IS, for someone who has never heard of either. */
const WORDS: Record<FirstAgent, { name: string; what: string; account: string }> = {
  claude: { name: 'Claude', what: 'the coding assistant from Anthropic', account: 'Uses your Claude account' },
  codex: { name: 'Codex', what: 'the coding assistant from OpenAI', account: 'Uses your ChatGPT account' }
}

interface Props {
  /** Opens a pane the way New session does. Resolves null when nothing opened. */
  onLaunch: (req: StartSessionRequest) => Promise<'local' | 'remote' | null>
}

export default function FirstRunCard({ onLaunch }: Props): JSX.Element | null {
  const [rows, setRows] = useState<SetupRow[] | null>(null)
  const [unchecked, setUnchecked] = useState(false)
  const [root, setRoot] = useState('')
  const [rootExists, setRootExists] = useState(false)
  const [preferred, setPreferred] = useState('')
  const [log, setLog] = useState<SetupRowId | ''>('')
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Same moments as the Welcome checklist: on show, after an install, and when the
  // window comes back to the front (somebody may have installed or signed in elsewhere).
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

  const installed = useCallback(
    (ok: boolean) => {
      setBusy(false)
      if (!ok) {
        setError('That did not finish. The box above shows what went wrong.')
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

  const install = (id: SetupRowId): void => {
    setError('')
    setBusy(true)
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
      // Pins the folder that was guessed, and retires this card for good.
      const folder = 'cwd' in plan ? root : cwd.replace(/[\\/][^\\/]+[\\/]?$/, '')
      await api.setConfig({ firstChatStarted: true, root: folder })
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error:\s*/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FirstRunView
      rows={rows}
      root={root}
      rootExists={rootExists}
      preferred={preferred}
      log={log}
      attempt={attempt}
      busy={busy}
      error={error}
      onInstall={install}
      onInstalled={installed}
      onChange={() => void change()}
      onStart={(agent) => void start(agent)}
    />
  )
}

export interface FirstRunViewProps {
  /** `setup:check`, unfiltered - the Codex rows are this card's. */
  rows: SetupRow[]
  /** The projects folder: the one that exists, or the guess that will be made. */
  root: string
  rootExists: boolean
  /** The saved default assistant, the tie-break for which one Start opens. */
  preferred: string
  /** The install being shown in the console, '' for none. */
  log: SetupRowId | ''
  attempt: number
  busy: boolean
  error: string
  onInstall: (id: SetupRowId) => void
  onInstalled: (ok: boolean) => void
  onChange: () => void
  onStart: (agent: FirstAgent) => void
}

/** Everything the card draws, from plain values - so a test can render each machine state. */
export function FirstRunView(p: FirstRunViewProps): JSX.Element {
  const states = agentStates(p.rows)
  const agent = chatAgent(states, p.preferred)
  const recommended = recommendedInstall(states)
  const gitRow = p.rows.find((r) => r.id === 'git')
  const chosen = agent ? states.find((s) => s.id === agent) : undefined
  const folderName = p.root.split(/[\\/]/).filter(Boolean).pop() ?? p.root

  return (
    <div className="fr-card">
      <div className="fr-h">Set up your first chat</div>
      <p className="fr-sub">
        PaneForge runs a coding assistant that reads and writes the files in a folder for you. Pick one,
        then start.
      </p>
      {gitRow && (
        <Row
          done={false}
          name="Git for Windows"
          what="a tool Claude uses to run commands on this PC"
          note="Install this first"
          button="Install"
          disabled={p.busy}
          onPress={() => p.onInstall('git')}
        />
      )}
      {states.map((s) => (
        <AgentRow
          key={s.id}
          state={s}
          recommended={recommended === s.id}
          disabled={p.busy}
          onInstall={() => p.onInstall(s.id)}
        />
      ))}
      <Row
        done={p.rootExists}
        name="Projects folder"
        note={p.rootExists ? p.root : `${p.root} - made for you when you start`}
        button="Change"
        disabled={p.busy}
        onPress={p.onChange}
      />
      {p.log && (
        <InstallConsole
          key={p.log + p.attempt}
          agentId={p.log}
          onDone={p.onInstalled}
          start={(id) => void (id === 'git' ? api.installGit() : api.installAgent(id))}
        />
      )}
      {p.error && <span className="install-err">{p.error}</span>}
      <button className="primary fr-go" disabled={!agent || p.busy} onClick={() => agent && p.onStart(agent)}>
        {p.busy && !p.log ? 'Opening...' : 'Start your first chat'}
      </button>
      <span className="fr-note">
        {!chosen
          ? 'Install one of the assistants above first.'
          : `Opens ${WORDS[chosen.id].name} in ${p.rootExists ? folderName : `a new folder, ${FIRST_FOLDER}`}.` +
            (chosen.signedIn ? '' : ` ${WORDS[chosen.id].name} asks you to sign in first, in your web browser.`)}
      </span>
    </div>
  )
}

function AgentRow({
  state,
  recommended,
  disabled,
  onInstall
}: {
  state: AgentState
  recommended: boolean
  disabled: boolean
  onInstall: () => void
}): JSX.Element {
  const w = WORDS[state.id]
  const note = !state.installed
    ? w.account + (recommended ? ' - recommended' : '')
    : state.signedIn
      ? 'Ready'
      : 'Installed - signs in when its first chat opens'
  return (
    <Row
      done={state.installed && state.signedIn}
      name={w.name}
      what={w.what}
      note={note}
      button={state.installed ? undefined : 'Install'}
      disabled={disabled}
      onPress={onInstall}
    />
  )
}

function Row({
  done,
  name,
  what,
  note,
  button,
  disabled,
  onPress
}: {
  done: boolean
  name: string
  what?: string
  note: string
  button?: string
  disabled: boolean
  onPress: () => void
}): JSX.Element {
  return (
    <div className={'fr-row' + (done ? ' done' : '')}>
      <span className="fr-mark" aria-label={done ? 'Ready' : 'Not ready yet'}>
        {done && (
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="fr-text">
        <span className="fr-name">
          {name}
          {what && <span className="fr-what">, {what}</span>}
        </span>
        <span className="fr-note">{note}</span>
      </span>
      {button && (
        <button className="pill" disabled={disabled} onClick={onPress}>
          {button}
        </button>
      )}
    </div>
  )
}
