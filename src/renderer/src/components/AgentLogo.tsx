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

/** PaneForge's own mark: stacked panes, drawn rather than shipped as an asset. */
export function AppLogo({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg className="app-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="3" width="9" height="18" rx="2.5" fill="currentColor" opacity="0.95" />
      <rect x="13" y="3" width="9" height="8" rx="2.5" fill="currentColor" opacity="0.6" />
      <rect x="13" y="13" width="9" height="8" rx="2.5" fill="currentColor" opacity="0.35" />
    </svg>
  )
}
