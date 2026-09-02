import React from 'react'

/**
 * The one dismiss button every corner card draws, top-right, first child of the card root.
 * What dismissing MEANS is the card's own choice - CardX only draws the button and reports
 * the click. Never destructive: each caller wires it to the safe reading (Keep, not Now).
 */
export default function CardX({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  return (
    <button type="button" className="card-x" aria-label="Dismiss" onClick={onDismiss}>
      ×
    </button>
  )
}
