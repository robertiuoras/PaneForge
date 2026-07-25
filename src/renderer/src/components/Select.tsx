import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption {
  value: string
  label: string
  /** right-aligned secondary text: a path, an install hint, a model family */
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  /** options sharing a group render under one heading, in first-seen order */
  group?: string
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  size?: 'sm' | 'md'
  title?: string
  /** filter box; defaults to on once the list is long enough to need one */
  searchable?: boolean
  disabled?: boolean
  className?: string
  /** minimum popup width in px; it never renders narrower than the trigger */
  menuWidth?: number
}

/**
 * Replaces the native <select>, which on Windows draws an OS menu that ignores the
 * app's dark theme and cannot show an icon per option. This is a listbox: a trigger
 * button plus a portalled popup, so it escapes dialog overflow and can be styled.
 *
 * Keyboard parity with the native control is deliberate - arrows move, Enter picks,
 * Escape closes without changing the value, and typing filters once the list is long.
 */
export default function Select({
  value,
  options,
  onChange,
  placeholder = 'Select',
  size = 'md',
  title,
  searchable,
  disabled,
  className,
  menuWidth
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [natural, setNatural] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const showSearch = searchable ?? options.length > 8
  const selected = options.find((o) => o.value === value)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return options
    return options.filter((o) => (o.label + ' ' + (o.hint ?? '')).toLowerCase().includes(needle))
  }, [options, q])

  // Opening lands the highlight on the current value so Enter is a no-op, not a jump.
  useEffect(() => {
    if (!open) return
    setQ('')
    const i = shown.findIndex((o) => o.value === value)
    setHi(i >= 0 ? i : shown.findIndex((o) => !o.disabled))
  }, [open])

  useEffect(() => setHi(shown.findIndex((o) => !o.disabled)), [q])

  // Fixed positioning against the live trigger rect, flipped up when the popup would
  // fall off the bottom of the window.
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => setRect(trigger.current?.getBoundingClientRect() ?? null)
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    ;(showSearch ? search.current : menu.current)?.focus()
    const away = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false)
    }
    // Escape is handled on the document as well as on the menu: if focus ends up
    // outside the popup (a stray click, a window re-focus) the key would otherwise
    // hit the app's global handler, which deliberately ignores it while a menu is up,
    // and nothing would close.
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open, showSearch])

  // How tall the popup WANTS to be, measured rather than guessed: groups, hints and
  // the filter box all change the height, and the flip decision below is only right
  // if it knows whether the whole list would actually fit underneath the trigger.
  useLayoutEffect(() => {
    if (!open || !menu.current) {
      setNatural(0)
      return
    }
    const scroll = menu.current.querySelector<HTMLElement>('.select-scroll')
    const box = menu.current.querySelector<HTMLElement>('.select-search')
    // 10px = the popup's own 5px padding, top and bottom; 4px = the search margin.
    setNatural((scroll?.scrollHeight ?? 0) + (box ? box.offsetHeight + 4 : 0) + 10)
  }, [open, rect !== null, shown.length, showSearch])

  // Keep the highlighted row in view during arrow navigation.
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('.opt.hi')?.scrollIntoView({ block: 'nearest' })
  }, [hi, open])

  const commit = (o: SelectOption): void => {
    if (o.disabled) return
    setOpen(false)
    trigger.current?.focus()
    if (o.value !== value) onChange(o.value)
  }

  const step = (dir: 1 | -1): void =>
    setHi((cur) => {
      for (let n = 1; n <= shown.length; n++) {
        const i = (cur + dir * n + shown.length * 2) % shown.length
        if (!shown[i]?.disabled) return i
      }
      return cur
    })

  const onKey = (e: React.KeyboardEvent): void => {
    // Stopped at the popup so the app's global Escape does not also close the dialog
    // underneath, and so xterm never sees these keys.
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHi(shown.findIndex((o) => !o.disabled))
    } else if (e.key === 'End') {
      e.preventDefault()
      for (let i = shown.length - 1; i >= 0; i--)
        if (!shown[i].disabled) {
          setHi(i)
          break
        }
    } else if (e.key === 'Enter' || (e.key === 'Tab' && shown[hi])) {
      e.preventDefault()
      if (shown[hi]) commit(shown[hi])
    }
  }

  const openMenu = (): void => {
    if (!disabled) setOpen((o) => !o)
  }

  const width = Math.max(menuWidth ?? 0, rect?.width ?? 0, 190)

  // Room left on each side of the trigger once the 6px gap and an 8px margin off the
  // window edge are taken out. Recomputed on every render, and the resize/scroll
  // listeners above re-render by replacing rect, so a shrinking window re-fits the
  // popup instead of letting it run off the bottom with its last rows unreachable.
  const roomBelow = rect ? Math.max(0, window.innerHeight - rect.bottom - 14) : 0
  const roomAbove = rect ? Math.max(0, rect.top - 14) : 0
  // Flip only when it genuinely helps: there is more room above AND the list does not
  // already fit below. natural is 0 on the very first pass (nothing measured yet),
  // which reads as "it fits" and opens downwards, the common case.
  const flip = rect !== null && roomBelow < roomAbove && roomBelow < natural
  // A floor of 140px keeps a few rows plus a scrollbar on a very short window rather
  // than a useless sliver; below that the popup is allowed to reach past the margin.
  const maxHeight = Math.max(140, flip ? roomAbove : roomBelow)
  let last: string | undefined

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={'select' + (size === 'sm' ? ' sm' : '') + (open ? ' open' : '') + (className ? ' ' + className : '')}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={openMenu}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {selected?.icon}
        <span className="select-label">{selected?.label ?? placeholder}</span>
        <svg className="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={menu}
            className="select-menu"
            role="listbox"
            tabIndex={-1}
            onKeyDown={onKey}
            style={{
              left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
              width,
              maxHeight,
              ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 })
            }}
          >
            {showSearch && (
              <input
                ref={search}
                className="select-search"
                placeholder="Filter"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            )}
            <div className="select-scroll">
              {shown.map((o, i) => {
                const head = o.group && o.group !== last ? o.group : null
                last = o.group
                return (
                  <div key={o.value + i}>
                    {head && <div className="opt-group">{head}</div>}
                    <div
                      role="option"
                      aria-selected={o.value === value}
                      className={
                        'opt' +
                        (i === hi ? ' hi' : '') +
                        (o.value === value ? ' on' : '') +
                        (o.disabled ? ' off' : '')
                      }
                      onMouseEnter={() => !o.disabled && setHi(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(o)}
                    >
                      <span className="opt-check">
                        {o.value === value && (
                          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                            <path
                              d="M3.5 8.5 6.5 11.5 12.5 5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      {o.icon}
                      <span className="opt-label">{o.label}</span>
                      {o.hint && <span className="opt-hint">{o.hint}</span>}
                    </div>
                  </div>
                )
              })}
              {shown.length === 0 && <div className="opt off">No match</div>}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
