/**
 * Everything the pane's header offers, at finger size, on a phone.
 *
 * Measured at 414px before this existed: the header wanted 486px of the 404 it had, so the
 * restart, Fix and Close buttons were drawn from x=417 to x=491 - off the right-hand edge,
 * with nothing to scroll them back - and the pane's own NAME had been squeezed to 0px to
 * make room for them. That is "can't drag menu where the clear button is and can't see on
 * the right side all options".
 *
 * The header was made to FIT once before, by hiding what a phone cannot use (the path, the
 * folder and the editor buttons). That was not enough and could not be: the agent picker
 * alone is ~150px, and five 36px targets plus a git badge do not go into 404px however
 * they are trimmed. So on a touch-sized screen the row keeps only what says WHICH pane
 * this is - the status dot, the agent's mark, the name, the branch - and every ACTION
 * moves behind one ⋯ button into this sheet, where each one gets a full-width row with a
 * word next to it rather than a 27x23 glyph.
 *
 * The shape is the ordinary phone action sheet (iOS UIKit's, which is what a hand expects
 * here): rows at least 44px, the destructive ones last and coloured, a backdrop that
 * dismisses, and Escape for the narrow-desktop-window case where there is a keyboard.
 */

import { useEffect } from 'react'

export interface PaneAction {
  key: string
  label: string
  /** the glyph the header used to draw, kept so the two surfaces read as the same control */
  icon: React.ReactNode
  hint?: string
  danger?: boolean
  run(): void
}

export function PaneMenu({
  title,
  actions,
  extra,
  onClose
}: {
  title: string
  actions: PaneAction[]
  /** the agent/model picker, which is a control rather than an action */
  extra?: React.ReactNode
  onClose(): void
}): JSX.Element {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  return (
    <div className="pane-menu-back" onClick={onClose} role="presentation">
      <div
        className="pane-menu"
        role="dialog"
        aria-label={`Actions for ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pane-menu-head">{title}</div>
        {extra && <div className="pane-menu-extra">{extra}</div>}
        {actions.map((a) => (
          <button
            key={a.key}
            className={'pane-menu-row' + (a.danger ? ' danger' : '')}
            onClick={() => {
              onClose()
              a.run()
            }}
          >
            <span className="pmr-icon" aria-hidden="true">
              {a.icon}
            </span>
            <span className="pmr-label">
              {a.label}
              {a.hint && <span className="pmr-hint">{a.hint}</span>}
            </span>
          </button>
        ))}
        <button className="pane-menu-row cancel" onClick={onClose}>
          <span className="pmr-label">Cancel</span>
        </button>
      </div>
    </div>
  )
}
