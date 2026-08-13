// Putting a theme on the window.
//
// The derivation is in shared/theme.ts and is pure; this is the ten lines that are not,
// kept apart so the Settings preview, the live window and the test all call the same
// `paletteFor` and cannot disagree about what a theme looks like.

import { DEFAULT_THEME, paletteFor, type ThemeConfig } from '@shared/theme'

/**
 * Write a theme's variables onto `:root`.
 *
 * Set on the element rather than swapped as a stylesheet because that is what makes it
 * instant: every rule in styles.css already reads `var(--surface-2)`, so assigning the
 * variable repaints without a reflow of anything's layout, and a slider can be dragged
 * with the whole window following it.
 */
export function applyTheme(theme: ThemeConfig | undefined): void {
  const style = document.documentElement.style
  for (const [name, value] of Object.entries(paletteFor(theme ?? DEFAULT_THEME))) {
    style.setProperty(name, value)
  }
}

/**
 * The same palette, in the shape xterm wants.
 *
 * The terminal is a canvas (WebGL, in this app), so it cannot read a CSS variable - the
 * colours have to be handed over as strings and the renderer told to redraw. Only the
 * chrome is themed: the sixteen ANSI colours are what the AGENT is drawing with, and
 * recolouring those means a CLI's own red no longer looks like its red.
 */
export function terminalTheme(theme: ThemeConfig | undefined): {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
  selectionInactiveBackground: string
} {
  const v = paletteFor(theme ?? DEFAULT_THEME)
  return {
    background: v['--term-bg'],
    foreground: v['--term-fg'],
    cursor: v['--term-cursor'],
    cursorAccent: v['--bg'],
    // See --term-sel in shared/theme.ts: a solid block plus a forced foreground is what
    // makes a highlight read over a CLI's own colours and box rules.
    selectionBackground: v['--term-sel'],
    selectionForeground: v['--term-sel-fg'],
    selectionInactiveBackground: v['--term-sel-dim']
  }
}
