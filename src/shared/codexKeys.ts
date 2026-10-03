/**
 * The bytes Codex needs for Alt+Left / Alt+Right, or undefined when xterm's own are right.
 *
 * Codex switches the view between a chat's subagents on Alt+Left / Alt+Right, read as
 * ESC[1;3D / ESC[1;3C (ESC b also works). xterm.js rewrites Alt+Left to Ctrl+Left
 * (ESC[1;5D) on every platform but a Mac, and Codex ignores that, so on the PC the switch
 * never arrived (codex-cli 0.160.0, research 2026-10-03). Codex panes only: a shell keeps
 * xterm's word jump.
 */
export function codexAltArrow(
  agent: string | undefined,
  e: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  mac: boolean
): string | undefined {
  if (mac || agent !== 'codex' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return undefined
  return e.key === 'ArrowLeft' ? '\x1b[1;3D' : e.key === 'ArrowRight' ? '\x1b[1;3C' : undefined
}
