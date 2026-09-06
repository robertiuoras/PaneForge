import { useEffect, useRef } from 'react'

/** Keep keyboard navigation inside a modal and return it to its opener. */
export default function useDialogFocus(): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = opener.current?.isConnected ? opener.current : document.activeElement as HTMLElement | null
    const controls = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]'
    )].filter(element => element.getClientRects().length > 0)
    if (!dialog.contains(document.activeElement)) controls()[0]?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = controls(), first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    dialog.addEventListener('keydown', key)
    return () => { dialog.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus() }
  }, [])
  return ref
}
