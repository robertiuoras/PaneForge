import type { AgentInfo } from '@shared/agents'
import { modelHint, modelLabel, modelValue, supportsModel } from '@shared/agents'
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

  const agentOptions: SelectOption[] = agents.map((a) => ({
    value: a.id,
    label: a.label,
    hint: a.available ? a.note : a.install || a.installWin || a.installMac ? 'not installed - one click in Settings' : 'not on PATH',
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
