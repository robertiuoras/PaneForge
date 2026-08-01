import type { AgentInfo } from '@shared/agents'
import { BRAND_MARKS } from './brandPaths'

interface Props {
  /** agent id, e.g. 'claude' or 'codex' */
  id: string
  /** the probed spec, used for the brand colour and the monogram fallback */
  spec?: Pick<AgentInfo, 'label' | 'color'>
  size?: number
  /** draw the mark on its own rounded tile instead of bare */
  tile?: boolean
  /** dim it, for CLIs that are not installed */
  muted?: boolean
}

/** Custom agent ids can still hit a real brand mark by naming their binary. */
const ALIASES: Record<string, string> = {
  'claude-code': 'claude',
  anthropic: 'claude',
  gpt: 'codex',
  'codex-cli': 'codex',
  openai: 'openai',
  'gemini-cli': 'gemini',
  google: 'gemini',
  'github-copilot': 'copilot',
  'cursor-agent': 'cursor'
}

function markFor(id: string): string | undefined {
  const key = ALIASES[id] ?? id
  return BRAND_MARKS[key] ? key : undefined
}

/**
 * The agent's real logo wherever one exists, tinted with its brand colour so a pane
 * is identifiable at a glance. Agents without a mark (Shell, Aider, anything custom)
 * fall back to a monogram tile rather than an empty gap, so every row lines up.
 */
export default function AgentLogo({ id, spec, size = 16, tile, muted }: Props): JSX.Element {
  const key = markFor(id)
  const color = spec?.color ?? '#8b8b99'
  const style = { width: size, height: size, color, opacity: muted ? 0.45 : 1 }

  if (!key) {
    const initial = (spec?.label ?? id).replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase() || '?'
    return (
      <span
        className={'agent-logo mono' + (tile ? ' tile' : '')}
        style={{ ...style, background: tile ? `${color}22` : 'transparent', fontSize: Math.round(size * 0.6) }}
        aria-hidden="true"
      >
        {initial}
      </span>
    )
  }

  const mark = BRAND_MARKS[key]
  return (
    <span
      className={'agent-logo' + (tile ? ' tile' : '')}
      style={{ ...style, background: tile ? `${color}1f` : 'transparent' }}
      aria-hidden="true"
    >
      <svg viewBox={mark.viewBox} width="100%" height="100%" fill="currentColor" fillRule="evenodd" clipRule="evenodd">
        <path d={mark.d} />
      </svg>
    </span>
  )
}

/**
 * PaneForge's own mark: stacked panes, drawn rather than shipped as an asset.
 *
 * These are the icon's proportions, not an approximation of them. `scripts/make-icon.mjs`
 * draws the taskbar icon from `split: 0.415` (the left pane's share of the width), a gap
 * of 0.043 of the canvas and a pane radius of 0.032, inset 0.235 all round; take the inset
 * away - there is no squircle plate at 18px, it would just be mud - and rescale the rest
 * to fill the box, and those ratios land on the numbers below. The two marks were drawn
 * independently before and did not match: the app's had a 9/9 split where the icon has
 * roughly 9/13, so the thing in the sidebar was a different logo from the thing on the
 * taskbar.
 *
 * The gradient is the icon's ember, top-lit, expressed in `currentColor` so it follows
 * the theme - the sidebar sets `color: var(--accent)`. That is the whole of the rebrand:
 * the default accent is the icon's own top ember pulled back off full orange, so the mark
 * and the window it opens are recognisably one object without the window being orange.
 */
export function AppLogo({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg className="app-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="pf-mark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="9.15" height="24" rx="1.45" fill="url(#pf-mark)" />
      <rect x="11.1" y="0" width="12.9" height="11.02" rx="1.45" fill="url(#pf-mark)" />
      <rect x="11.1" y="12.98" width="12.9" height="11.02" rx="1.45" fill="url(#pf-mark)" />
    </svg>
  )
}
