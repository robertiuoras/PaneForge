import { useCallback, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { installCommand, modelHint, modelLabel, modelValue, supportsModel } from '@shared/agents'
import AgentLogo from './AgentLogo'
import InstallConsole from './InstallConsole'
import Select, { type SelectOption } from './Select'

const api = window.api

interface Props {
  agents: AgentInfo[]
  agent: string
  model: string
  onChange: (agent: string, model: string) => void
  /** compact styling for the pane header */
  small?: boolean
}

const CUSTOM = '__custom__'

/**
 * The "which AI runs here" control: one dropdown for the CLI, one for its model.
 * Missing CLIs stay visible but disabled with their install command as the hint, so
 * the list doubles as a menu of what is worth installing. The model list is
 * suggestions only - "Other..." accepts any string.
 */
export default function AgentPicker({ agents, agent, model, onChange, small }: Props): JSX.Element {
  const spec = agents.find((a) => a.id === agent)
  const models = spec?.models ?? []

  const agentOptions: SelectOption[] = agents.map((a) => ({
    value: a.id,
    label: a.label,
    hint: a.available ? a.note : installCommand(a) ? 'not installed - Install it below' : 'not on PATH',
    disabled: !a.available,
    // Free CLIs get their own group: the point of the group is to make "I have no
    // subscription today" a one-glance answer rather than a research project.
    group: a.custom ? 'Custom' : a.available ? (a.free ? 'Free' : 'Installed') : 'Not installed',
    icon: <AgentLogo id={a.id} spec={a} size={small ? 13 : 15} muted={!a.available} />
  }))

  const known = models.map(modelValue)
  const modelOptions: SelectOption[] = [
    { value: '', label: 'Default model', hint: spec?.label },
    // A model carried over from another agent (or typed by hand) must still show.
    ...(model && !known.includes(model) ? [{ value: model, label: model, hint: 'typed in' }] : []),
    ...models.map((m) => ({ value: modelValue(m), label: modelLabel(m), hint: modelHint(m) })),
    { value: CUSTOM, label: 'Other...' }
  ]

  const pickModel = (value: string): void => {
    if (value !== CUSTOM) return onChange(agent, value)
    const typed = window.prompt(`Model for ${spec?.label ?? agent}`, model)
    if (typed !== null) onChange(agent, typed.trim())
  }

  return (
    <span className={'agent-pick' + (small ? ' small' : '')}>
      <Select
        size={small ? 'sm' : 'md'}
        value={agent}
        options={agentOptions}
        onChange={(v) => onChange(v, '')}
        title="Which AI runs in this pane"
        menuWidth={300}
      />
      {supportsModel(spec) && (
        <Select
          size={small ? 'sm' : 'md'}
          value={model}
          options={modelOptions}
          onChange={pickModel}
          title="Model passed to the CLI"
          placeholder="Default model"
          menuWidth={260}
        />
      )}
    </span>
  )
}

interface BarProps {
  agents: AgentInfo[]
  /**
   * Re-probe the agent list. The owning dialog holds the copy this bar and the picker
   * both read, so the freshly installed CLI becomes selectable without a reopen.
   */
  onInstalled?: () => void
}

/**
 * A row of "Install" pills for the CLIs this machine is missing, so a missing agent
 * can be fixed from the dialog that just told you it was missing instead of sending
 * you to Settings. Only agents PaneForge knows how to install get a pill: a button
 * that cannot work is worse than no button, and the picker still shows the rest.
 */
export function AgentInstallBar({ agents, onInstalled }: BarProps): JSX.Element | null {
  // Which log is on screen, and whether that install is still running. They are
  // separate because a failed install must leave its output up to be read.
  const [log, setLog] = useState('')
  const [running, setRunning] = useState('')
  const [error, setError] = useState('')
  // Bumped per click so retrying the SAME agent remounts the console and actually
  // runs the install again, instead of re-showing the dead log.
  const [attempt, setAttempt] = useState(0)

  const missing = agents.filter((a) => !a.available && installCommand(a))

  const done = useCallback(
    (ok: boolean) => {
      setRunning('')
      if (!ok) return setError('That install did not finish - the log above says why.')
      setLog('')
      setError('')
      onInstalled?.()
    },
    [onInstalled]
  )

  if (!missing.length && !log) return null

  return (
    <div className="install-bar">
      {missing.length > 0 && (
        <>
          <span className="hint">Not installed:</span>
          {missing.map((a) => (
            <button
              key={a.id}
              className="pill"
              // One install at a time: two npm installs racing each other on the same
              // prefix is how you end up with neither.
              disabled={running !== ''}
              title={installCommand(a)}
              onClick={() => {
                setError('')
                setLog(a.id)
                setRunning(a.id)
                setAttempt((n) => n + 1)
              }}
            >
              <AgentLogo id={a.id} spec={a} size={12} muted={running !== a.id} />
              {running === a.id ? 'Installing...' : `Install ${a.label}`}
            </button>
          ))}
        </>
      )}
      {log && (
        <InstallConsole
          key={log + attempt}
          agentId={log}
          onDone={done}
          start={(id) => void api.installAgent(id)}
        />
      )}
      {error && <span className="install-err">{error}</span>}
    </div>
  )
}
