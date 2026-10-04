import { useState, type ReactNode } from 'react'

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

/**
 * The long explanation, one press away.
 *
 * A settings row says what it does in a dozen words; this holds the paragraph it used to
 * print underneath. The wording is kept rather than deleted because it is the only
 * documentation a setting has - it is just no longer what you read past to find the switch.
 */
export function Why({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="why-btn"
        aria-expanded={open}
        aria-label={open ? 'Hide the explanation' : 'What this does'}
        title={open ? 'Hide the explanation' : 'What this does'}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && <p className="hint why-text">{children}</p>}
    </>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  /** second line under the label: what it does, in a dozen words at most */
  hint?: string
  /** the longer explanation, behind a `?` beside the switch */
  why?: string
  disabled?: boolean
}

/** Used for settings that take effect immediately, where a toggle reads truer than a tick. */
export function Switch({ checked, onChange, label, hint, why, disabled }: SwitchProps): JSX.Element {
  const row = (
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
  if (!why) return row
  // The `?` sits OUTSIDE the label: a button inside a label toggles the checkbox it
  // labels, so asking what a switch does would flip it.
  return (
    <div className="sw-why">
      {row}
      <Why>{why}</Why>
    </div>
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
