import { createContext, useContext } from 'react'
import { blurbFor, blurbShown } from '@shared/blurbs'

/**
 * The one-line "what this is" under a feature's title.
 *
 * The text itself lives in `shared/blurbs.ts`; this is only the drawing of it, plus the
 * × that retires one. Dismissals come through a context rather than a prop because the
 * alternative is threading `config` and `onChange` into eight dialogs that have no other
 * reason to know the config exists - Board takes a `cwd`, Lane takes a `cwd`, and neither
 * should grow a settings dependency to show a sentence.
 */
export interface BlurbState {
  hidden: string[]
  hide: (id: string) => void
}

export const BlurbContext = createContext<BlurbState>({ hidden: [], hide: () => {} })

export default function Blurb({ id }: { id: string }): JSX.Element | null {
  const { hidden, hide } = useContext(BlurbContext)
  const b = blurbFor(id)
  // An unknown id draws nothing rather than throwing: a dialog is allowed to ask for a
  // note that has not been written yet, and a missing sentence must never cost a feature.
  if (!b || !blurbShown(id, hidden)) return null
  return (
    <div className="blurb">
      <span className="blurb-text">{b.text}</span>
      <button
        className="blurb-x"
        title="Hide this note. Settings → General brings them all back."
        aria-label="Hide this note"
        onClick={() => hide(id)}
      >
        ×
      </button>
    </div>
  )
}
