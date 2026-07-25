import type { AgentInfo } from '@shared/agents'
import AgentLogo from './AgentLogo'
import Select, { type SelectOption } from './Select'

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
  // A model carried over from another agent (or typed by hand) must still show.
  const options = model && !models.includes(model) ? [model, ...models] : models

  const agentOptions: SelectOption[] = agents.map((a) => ({
    value: a.id,
    label: a.label,
    hint: a.available ? undefined : a.install ? `install: ${a.install}` : 'not on PATH',
    disabled: !a.available,
    group: a.custom ? 'Custom' : 'Installed',
    icon: <AgentLogo id={a.id} spec={a} size={small ? 13 : 15} muted={!a.available} />
  }))

  const modelOptions: SelectOption[] = [
    { value: '', label: 'Default model', hint: spec?.label },
    ...options.map((m) => ({ value: m, label: m })),
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
        menuWidth={280}
      />
      {spec?.modelFlag && (
        <Select
          size={small ? 'sm' : 'md'}
          value={model}
          options={modelOptions}
          onChange={pickModel}
          title="Model passed to the CLI"
          placeholder="Default model"
          menuWidth={220}
        />
      )}
    </span>
  )
}
