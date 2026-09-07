// The empty desk's first screen: a plain question, not a mascot or an AI-catalogue card.
//
// Follows linear.app's dark-dashboard read (claude-memory/toolstash/design-vault/linear.app.md):
// hairline white-alpha borders instead of shadows, a surface one step up from the page, tight
// display type at line-height 1 with negative tracking, two short motion durations. No gradient
// fill, no glow, no rounded-card-on-a-grid — the thing every generic AI landing page reaches for.

interface WelcomeProps {
  /** Opens the New session dialog - the one place a folder is picked and a session starts. */
  onStart: () => void
  /** Ctrl K - search past sessions and actions. */
  onSearch: () => void
  /** Attention, project board, swarm, shortcuts. */
  onTools: () => void
}

export default function Welcome({ onStart, onSearch, onTools }: WelcomeProps): JSX.Element {
  return (
    <div className="welcome">
      <h2 className="welcome-h">What are we building today?</h2>
      <p className="welcome-sub">Open a project and it starts here, on this screen.</p>
      <button className="primary welcome-start" onClick={onStart}>
        <span className="plus">+</span> Open a project
      </button>
      <div className="welcome-row">
        <button className="welcome-chip" onClick={onSearch}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Find a past session
        </button>
        <button className="welcome-chip" onClick={onTools}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="4.5" height="4.5" rx="1" />
            <rect x="9.5" y="2" width="4.5" height="4.5" rx="1" />
            <rect x="2" y="9.5" width="4.5" height="4.5" rx="1" />
            <path d="M9.5 11.75H14M11.75 9.5V14" />
          </svg>
          See what needs you
        </button>
      </div>
    </div>
  )
}
