// The empty desk's first screen: a plain question, not a mascot or an AI-catalogue card.
//
// Follows linear.app's dark-dashboard read (claude-memory/toolstash/design-vault/linear.app.md):
// hairline white-alpha borders instead of shadows, a surface one step up from the page, tight
// display type at line-height 1 with negative tracking, two short motion durations. No gradient
// fill, no glow, no rounded-card-on-a-grid — the thing every generic AI landing page reaches for.

import { useCallback, useEffect, useState } from 'react'
import type { SetupRow, SetupRowId } from '@shared/setupCheck'
import type { StartSessionRequest } from '@shared/types'
import { showFirstRun } from '@shared/firstRun'
import InstallConsole from './InstallConsole'
import FirstRunCard from './FirstRunCard'

const api = window.api

interface WelcomeProps {
  /** Opens the New session dialog - the one place a folder is picked and a session starts. */
  onStart: () => void
  /** Ctrl K - search past sessions and actions. */
  onSearch: () => void
  /** Attention, project board, swarm, shortcuts. */
  onTools: () => void
  /** Opens one pane straight away, the way New session does - the first-run card's button. */
  onLaunch: (req: StartSessionRequest) => Promise<'local' | 'remote' | null>
}

export default function Welcome({ onStart, onSearch, onTools, onLaunch }: WelcomeProps): JSX.Element {
  // null while the first read is out, so neither card flashes up and gets swapped.
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

  return (
    <div className="welcome">
      <h2 className="welcome-h">What are we building today?</h2>
      <p className="welcome-sub">Open a project and it starts here, on this screen.</p>
      {firstRun && <FirstRunCard onLaunch={onLaunch} />}
      <button className={firstRun ? 'welcome-chip' : 'primary welcome-start'} onClick={onStart}>
        <span className="plus">+</span> Open a project
      </button>
      <div className="welcome-row">
        <button className="welcome-chip" onClick={onSearch}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Find a past session
        </button>
        <button className="welcome-chip" onClick={onTools}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="4.5" height="4.5" rx="1" />
            <rect x="9.5" y="2" width="4.5" height="4.5" rx="1" />
            <rect x="2" y="9.5" width="4.5" height="4.5" rx="1" />
            <path d="M9.5 11.75H14M11.75 9.5V14" />
          </svg>
          See what needs you
        </button>
      </div>
      {firstRun === false && <SetupCard onSignIn={onStart} />}
    </div>
  )
}

/**
 * "Get set up": shown only while something is missing (Claude Code, Windows Git, sign-in),
 * gone the moment `checkSetup` comes back empty. Re-checks when an install finishes and
 * when the window regains focus - no polling timer, because nothing changes here on its
 * own between those two moments.
 */
function SetupCard({ onSignIn }: { onSignIn: () => void }): JSX.Element | null {
  const [rows, setRows] = useState<SetupRow[] | null>(null)
  const [log, setLog] = useState<SetupRowId | ''>('')
  const [running, setRunning] = useState<SetupRowId | ''>('')
  const [error, setError] = useState('')
  // Bumped per click so retrying the same row remounts the console instead of
  // re-showing a dead log from the last attempt.
  const [attempt, setAttempt] = useState(0)

  const refresh = useCallback(() => {
    // Codex rows are the first-run card's; here they would nag a Claude-only person forever.
    api
      .checkSetup()
      .then((all) => setRows(all.filter((r) => !r.optional)))
      .catch(() => setRows([]))
  }, [])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const done = useCallback(
    (ok: boolean) => {
      setRunning('')
      if (!ok) {
        setError('That did not finish - the log above says why.')
        return
      }
      setLog('')
      setError('')
      refresh()
    },
    [refresh]
  )

  if (!rows || rows.length === 0) return null

  const start = (id: string): void => {
    void (id === 'git' ? api.installGit() : api.installAgent(id))
  }

  const press = (row: SetupRow): void => {
    setError('')
    if (row.id === 'signin') {
      onSignIn()
      return
    }
    setLog(row.id)
    setRunning(row.id)
    setAttempt((n) => n + 1)
  }

  return (
    <div className="setup-card">
      <div className="setup-h">Get set up</div>
      {rows.map((row) => (
        <div className="setup-row" key={row.id}>
          <span>{row.text}</span>
          <button
            className="pill"
            disabled={running !== '' && running !== row.id}
            onClick={() => press(row)}
          >
            {running === row.id ? 'Working...' : row.button}
          </button>
        </div>
      ))}
      {log && <InstallConsole key={log + attempt} agentId={log} onDone={done} start={start} />}
      {error && <span className="install-err">{error}</span>}
    </div>
  )
}
