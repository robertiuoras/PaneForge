import type { ReactNode } from 'react'

// The small form primitives, kept together because each is a few lines and they are
// always imported as a set. All three replace native controls that Windows draws with
// its own light-theme chrome, which looked pasted-in against a dark app.

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  title?: string
  className?: string
}

/** Tick box with a drawn checkmark, so it can animate and match the accent colour. */
export function Checkbox({ checked, onChange, label, disabled, title, className }: CheckboxProps): JSX.Element {
  return (
    <label className={'cb' + (disabled ? ' off' : '') + (className ? ' ' + className : '')} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={'cb-box' + (checked ? ' on' : '')} aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path
            d="M3.5 8.5 6.5 11.5 12.5 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {label && <span className="cb-label">{label}</span>}
    </label>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  /** second line under the label, for the "what this actually does" sentence */
  hint?: string
  disabled?: boolean
}

/** Used for settings that take effect immediately, where a toggle reads truer than a tick. */
export function Switch({ checked, onChange, label, hint, disabled }: SwitchProps): JSX.Element {
  return (
    <label className={'sw-row' + (disabled ? ' off' : '')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={'sw' + (checked ? ' on' : '')} aria-hidden="true">
        <span className="sw-knob" />
      </span>
      <span className="sw-text">
        {label && <span className="sw-label">{label}</span>}
        {hint && <span className="sw-hint">{hint}</span>}
      </span>
    </label>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string; icon?: ReactNode; title?: string }[]
  onChange: (value: T) => void
}

/** Two or three mutually exclusive views: clearer as one control than as a checkbox. */
export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>): JSX.Element {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={'seg-btn' + (o.value === value ? ' on' : '')}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
