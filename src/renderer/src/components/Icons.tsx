// The line icons the sidebar's quick actions use.
//
// They replaced word buttons ("Swarm", "Board", "History"). Three words on one row
// wrapped as soon as the sidebar got narrow, and the row grew every time an action
// was added - the fourth one would not have fitted at all. Icons are a fixed width
// whatever the label says, so the row stays one line and has room to grow.
//
// Drawn rather than pulled from an icon set: this is a few hundred bytes against a
// dependency, and every one of them is on the same 16-unit grid with the same 1.5
// stroke, which is what makes a row of them look like one set instead of five.

interface IconProps {
  size?: number
}

function Svg({ size = 15, children }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Several agents on one mission: one node briefing three. */
export function SwarmIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="3" r="1.8" />
      <circle cx="3" cy="12.5" r="1.8" />
      <circle cx="13" cy="12.5" r="1.8" />
      <path d="M6.7 4.5 4.2 10.8M9.3 4.5l2.5 6.3M4.8 12.5h6.4" />
    </Svg>
  )
}

/**
 * Every pane at once: a stack of rows with the top one lit.
 *
 * The lit row is the point of the icon, not decoration - the screen it opens is sorted so
 * the row that needs a person is the first one.
 */
export function FleetIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
      <circle cx="2.5" cy="4" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Tasks and shared memory: a checklist. */
export function BoardIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2 3.5h3M2 8h3M2 12.5h3" />
      <path d="M7.5 3.5H14M7.5 8H14M7.5 12.5H14" opacity="0.55" />
    </Svg>
  )
}

/** Past sessions: a clock wound backwards. */
export function HistoryIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.4 8a5.6 5.6 0 1 0 1.7-4" />
      <path d="M2 2.2v2.6h2.6" />
      <path d="M8 5.2V8l2 1.4" />
    </Svg>
  )
}

/** Another machine's panes: two screens with a link between them. */
export function RemoteIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="1.2" y="3" width="6" height="5" rx="1" />
      <rect x="8.8" y="8" width="6" height="5" rx="1" />
      <path d="M4.2 8v2.5h4.6" opacity="0.55" />
    </Svg>
  )
}

/** Settings. */
export function GearIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.4v1.7M8 12.9v1.7M14.6 8h-1.7M3.1 8H1.4M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2M12.7 12.7l-1.2-1.2M4.5 4.5 3.3 3.3" />
    </Svg>
  )
}

/** Every shortcut. */
export function HelpIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.2 6.1a1.9 1.9 0 1 1 2.4 2.2c-.4.2-.6.6-.6 1v.4" />
      <path d="M8 12.1h.01" />
    </Svg>
  )
}

/** Wipe something out: a bin. Used for "clear this pane" and "close every pane". */
export function TrashIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.6 4.2h10.8" />
      <path d="M6.2 4.2V2.9h3.6v1.3" />
      <path d="M3.9 4.2 4.5 13a.9.9 0 0 0 .9.8h5.2a.9.9 0 0 0 .9-.8l.6-8.8" />
      <path d="M6.7 6.8v4.4M9.3 6.8v4.4" opacity="0.55" />
    </Svg>
  )
}

/** Live link, drawn as a signal. Used on the pane badge of a mirrored session. */
export function LinkIcon(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6.6 9.4 9.4 6.6" />
      <path d="M8.6 4.6 10 3.2a2.6 2.6 0 0 1 3.7 3.7l-1.4 1.4" />
      <path d="M7.4 11.4 6 12.8a2.6 2.6 0 0 1-3.7-3.7l1.4-1.4" />
    </Svg>
  )
}
