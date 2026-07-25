import type { AgentInfo } from '@shared/agents'

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
 * The "which AI runs here" control: one select for the CLI, one for its model.
 * Missing CLIs stay visible but disabled so it is obvious what is installable,
 * and the model list is suggestions only - "Other..." accepts any string.
 */
export default function AgentPicker({ agents, agent, model, onChange, small }: Props): JSX.Element {
  const spec = agents.find((a) => a.id === agent)
  const models = spec?.models ?? []
  // A model carried over from another agent (or typed by hand) must still show.
  const options = model && !models.includes(model) ? [model, ...models] : models

  const pickModel = (value: string): void => {
    if (value !== CUSTOM) return onChange(agent, value)
    const typed = window.prompt(`Model for ${spec?.label ?? agent}`, model)
    if (typed !== null) onChange(agent, typed.trim())
  }

  return (
    <span className={'agent-pick' + (small ? ' small' : '')}>
      <span className="agent-dot" style={{ background: spec?.color ?? '#8b8b99' }} />
      <select value={agent} onChange={(e) => onChange(e.target.value, '')} title="Which AI runs in this pane">
        {agents.map((a) => (
          <option key={a.id} value={a.id} disabled={!a.available}>
            {a.label}
            {a.available ? '' : ' (not installed)'}
          </option>
        ))}
      </select>
      {spec?.modelFlag && (
        <select value={model} onChange={(e) => pickModel(e.target.value)} title="Model passed to the CLI">
          <option value="">default model</option>
          {options.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={CUSTOM}>Other...</option>
        </select>
      )}
    </span>
  )
}
