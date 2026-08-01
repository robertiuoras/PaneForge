import { useMemo } from 'react'
import {
  DEFAULT_THEME,
  PRESETS,
  applyPreset,
  auditTheme,
  paletteFor,
  type ThemeConfig
} from '@shared/theme'
import { Segmented } from './Controls'

interface Props {
  theme: ThemeConfig
  onChange: (theme: ThemeConfig) => void
}

/**
 * Colours.
 *
 * The shape is the one every app that does this well converged on - a preset list, ONE
 * colour, and a couple of "feel" sliders - rather than a panel of eleven colour wells.
 * Discord's custom themes are five gradient stops plus an intensity slider; Raycast is a
 * background plus primary colours; Obsidian's core appearance tab is light/dark plus a
 * single accent, with per-channel HSL living in a community plugin. Nobody ships the
 * eleven wells, because the person who wants them is rarer than the person who opens the
 * tab once and closes it having made the window worse.
 *
 * So: everything except the accent is derived (shared/theme.ts), and the two things a
 * derivation cannot guess - how far the greys should lean, and how dark the window is -
 * are the sliders. Each control writes the whole ThemeConfig back, and touching any of
 * them flips `preset` to 'custom', so the swatch list stops claiming a preset is selected
 * the moment it no longer describes what is on screen.
 */
export default function AppearanceTab({ theme, onChange }: Props): JSX.Element {
  const audit = useMemo(() => auditTheme(theme), [theme])
  const vars = useMemo(() => paletteFor(theme), [theme])
  const set = (patch: Partial<ThemeConfig>): void =>
    onChange({ ...theme, ...patch, preset: 'custom' })

  return (
    <>
      <div className="setting">
        <label>Theme</label>
        <div className="swatches">
          {PRESETS.map((p) => {
            // Each card is a real palette, not a picture of one: the same function that
            // paints the window paints these three bars, so a swatch cannot be out of
            // date with what clicking it does.
            const v = paletteFor({ ...applyPreset(p.id, theme), density: theme.density })
            return (
              <button
                key={p.id}
                className={'swatch' + (theme.preset === p.id ? ' on' : '')}
                title={p.note}
                onClick={() => onChange(applyPreset(p.id, theme))}
              >
                <span className="swatch-art" style={{ background: v['--bg'] }}>
                  <span className="swatch-bar" style={{ background: v['--surface-3'] }} />
                  <span className="swatch-bar" style={{ background: v['--accent'], width: '58%' }} />
                  <span className="swatch-bar" style={{ background: v['--muted'], width: '38%' }} />
                </span>
                <span className="swatch-name">{p.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="setting">
        <label>Your colour</label>
        <div className="setting-row">
          {/* The OS picker, and a field for the hex somebody already has in a clipboard.
              Both write the same value; neither is the source of truth. */}
          <input
            type="color"
            className="color-well"
            value={/^#[0-9a-fA-F]{6}$/.test(theme.accent) ? theme.accent : DEFAULT_THEME.accent}
            onChange={(e) => set({ accent: e.target.value })}
            title="Pick a colour"
          />
          <input
            className="search mono"
            value={theme.accent}
            spellCheck={false}
            onChange={(e) => set({ accent: e.target.value })}
            placeholder={DEFAULT_THEME.accent}
          />
          <button
            className="ghost"
            onClick={() => onChange({ ...DEFAULT_THEME, density: theme.density })}
            title="Back to the colours PaneForge ships with"
          >
            Reset
          </button>
        </div>
        <div className="hint">
          Everything else on screen is worked out from this one colour - the greys lean
          towards it, and the app checks that what it derived is still readable.
        </div>
      </div>

      <div className="setting">
        <label>Colour in the greys ({Math.round(theme.tint * 100)}%)</label>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(theme.tint * 100)}
          onChange={(e) => set({ tint: Number(e.target.value) / 100 })}
        />
        <div className="hint">
          0% is neutral slate. Higher tints the window, the sidebar and every card towards
          your colour - a few percent is what makes a theme look designed rather than
          recoloured.
        </div>
      </div>

      <div className="setting">
        <label>How dark ({Math.round(theme.depth * 100)}%)</label>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(theme.depth * 100)}
          onChange={(e) => set({ depth: Number(e.target.value) / 100 })}
        />
        <div className="hint">
          Most of this slider is the dark end, because that is where dark themes live. Past
          about 75% the window goes light and the text turns over with it.
        </div>
      </div>

      <div className="setting">
        <label>Corners ({Math.round(theme.round * 100)}%)</label>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(theme.round * 100)}
          onChange={(e) => set({ round: Number(e.target.value) / 100 })}
        />
      </div>

      <div className="setting">
        <label>Density</label>
        <Segmented
          value={theme.density}
          onChange={(v) => onChange({ ...theme, density: v as ThemeConfig['density'] })}
          options={[
            { value: 'cozy', label: 'Cozy', title: 'The spacing PaneForge ships with' },
            { value: 'compact', label: 'Compact', title: 'Tighter rows - more panes in the sidebar without scrolling' }
          ]}
        />
      </div>

      <div className="setting">
        <label>Preview</label>
        {/* A real sidebar row, drawn with the theme being edited rather than the one that
            is live - so the effect of a slider is visible without applying it to the
            window you are reading the slider in. The variables are scoped to this box. */}
        <div className="theme-preview" style={vars as React.CSSProperties}>
          <div className="tp-side">
            <div className="tp-brand">
              <span className="tp-logo" />
              PaneForge
            </div>
            <div className="tp-row on">
              <span className="tp-num">1</span>
              <span className="tp-text">
                <span className="tp-title">PaneForge</span>
                <span className="tp-sub">claude · main checkout</span>
              </span>
            </div>
            <div className="tp-row">
              <span className="tp-num">2</span>
              <span className="tp-text">
                <span className="tp-title">taskdriver</span>
                <span className="tp-sub">codex · #2</span>
              </span>
            </div>
          </div>
          <div className="tp-main">
            <div className="tp-line" style={{ width: '72%' }} />
            <div className="tp-line accent" style={{ width: '46%' }} />
            <div className="tp-line" style={{ width: '61%' }} />
            <div className="tp-buttons">
              <span className="tp-btn primary">Run</span>
              <span className="tp-btn">Cancel</span>
            </div>
          </div>
        </div>
        <div className={'contrast-note' + (audit.ok ? '' : ' bad')}>
          {audit.ok
            ? `Readable: body text ${audit.textOnBg.toFixed(1)}:1, second lines ${audit.mutedOnBg.toFixed(1)}:1.`
            : audit.warning}
        </div>
      </div>
    </>
  )
}
