import { useEffect, useRef, useState } from 'react'

/**
 * The app's own yes/no box. window.confirm() draws Chromium's system dialog: a grey
 * strip with the app's file path in it, no keyboard rhythm of its own, and it freezes
 * the renderer while it is up. This matches the rest of the app, takes Enter and Esc,
 * and can carry a text field for the one place that used window.prompt().
 */
interface Props {
  title: string
  /** the sentence under the title - what is about to happen and what it costs */
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** red confirm button for anything that ends a running process */
  danger?: boolean
  /** turns this into a prompt; the value comes back through onConfirm */
  input?: { label?: string; placeholder?: string; defaultValue?: string }
  /**
   * One tick box under the body, for a question whose answer may be worth keeping.
   * Its state comes back through BOTH buttons: "remember this" applies to a no as much
   * as to a yes, and a box that only survives the primary button teaches the opposite.
   */
  check?: { label: string; defaultChecked?: boolean }
  onConfirm: (value: string, checked: boolean) => void
  onCancel: (checked: boolean) => void
}

export default function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  input,
  check,
  onConfirm,
  onCancel
}: Props): JSX.Element {
  const [value, setValue] = useState(input?.defaultValue ?? '')
  const [checked, setChecked] = useState(Boolean(check?.defaultChecked))
  const field = useRef<HTMLInputElement>(null)
  const ok = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus lands where the next keystroke should go: the field when there is one,
    // otherwise the confirm button, so Enter and Space both answer the question.
    ;(input ? field.current : ok.current)?.focus()
    field.current?.select()
  }, [input])

  const confirm = (): void => {
    if (input && !value.trim()) return
    onConfirm(value.trim(), checked)
  }
  const cancel = (): void => onCancel(checked)

  return (
    <div
      className="overlay confirm-overlay"
      onMouseDown={cancel}
      // Captured here so the app's global Escape does not also close the dialog
      // underneath this one.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          cancel()
        }
        if (e.key === 'Enter') {
          e.stopPropagation()
          confirm()
        }
      }}
    >
      <div className="dialog confirm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>{title}</strong>
        </div>
        {body && <div className="confirm-body">{body}</div>}
        {input && (
          <input
            ref={field}
            className="search"
            placeholder={input.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {check && (
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>{check.label}</span>
          </label>
        )}
        <div className="dialog-row">
          <button className="ghost" onClick={cancel}>
            {cancelLabel}
          </button>
          <button
            ref={ok}
            className={'primary' + (danger ? ' danger' : '')}
            disabled={Boolean(input) && !value.trim()}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
