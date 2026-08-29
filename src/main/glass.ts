/**
 * Real Liquid Glass, and the two reasons it is not the thing this app already refused.
 *
 * `scripts/overlay-filter-test.mjs` refuses `backdrop-filter`, and the reason is the
 * INPUT: a CSS backdrop filter over a grid of xterm WebGL canvases makes a live GPU
 * surface the input to a full-window filter, and the window strobes for as long as it is
 * up. `NSGlassEffectView` is a native NSView placed BEHIND the web contents, so its input
 * is the desktop behind the window and never a canvas this app is painting. Different
 * construct, and the stylesheet rule stays exactly as it was - nothing here adds a
 * `backdrop-filter`.
 *
 * The second refusal in the chrome commit was `vibrancy`, and that one still stands:
 * vibrancy is the OLD material, it is per-window, and it has no sidebar variant. This is
 * `electron-liquid-glass` (MIT, Meridius-Labs), which binds the real macOS 26 API and
 * ships prebuilt N-API binaries for darwin-arm64 and darwin-x64 - N-API is ABI-stable, so
 * one binary works across Electron majors and there is no node-gyp step in the build.
 *
 * **Everything here is optional and every failure is silent.** macOS 25, a Mac the addon
 * will not load on, Windows, Linux, a future Electron that changes the handle: each falls
 * through to `false`, and `false` means the window is created exactly as it was before any
 * of this - opaque, with the optical CSS glass that has always been the fallback. A visual
 * flourish may never be the reason the app does not open.
 */

import type { BrowserWindow } from 'electron'

/** What the sidebar is made of. `sidebar` is Apple's own material for this exact shape. */
const SIDEBAR_VARIANT = 16

let cached: boolean | null = null

interface GlassAddon {
  isMacOS(): boolean
  isGlassSupported(): boolean
  addView(handle: Buffer, options?: { cornerRadius?: number; tintColor?: string }): number
  unstable_setVariant?(id: number, variant: number): void
}

function addon(): GlassAddon | null {
  try {
    // Loaded lazily and by require: it is a native module, and a top-level import would
    // make a machine that cannot load it fail at startup rather than fall through here.
    const m = require('electron-liquid-glass') as { default?: GlassAddon } & GlassAddon
    return m.default ?? m
  } catch {
    return null
  }
}

/**
 * Whether this machine can draw real glass. Asked before the window is created, because
 * the answer decides `transparent`, which is a constructor option and cannot be changed
 * afterwards.
 */
export function glassSupported(): boolean {
  if (cached !== null) return cached
  let ok = false
  try {
    const g = addon()
    ok = !!g && g.isMacOS() && g.isGlassSupported()
  } catch {
    ok = false
  }
  cached = ok
  return ok
}

/**
 * Put the glass behind the window. Called from `did-finish-load`, which is the addon's
 * own requirement: before that the native window has no content view to sit under.
 *
 * Returns whether it took, so the caller can tell the renderer the truth rather than
 * assuming - a window created transparent whose glass then failed to attach would draw
 * the sidebar over nothing at all, which is the one outcome worse than no glass.
 */
export function attachGlass(win: BrowserWindow): boolean {
  if (!glassSupported()) return false
  try {
    const g = addon()
    if (!g) return false
    const id = g.addView(win.getNativeWindowHandle())
    if (typeof id !== 'number' || id < 0) return false
    // The variant setter is marked unstable by its author because it reaches a private
    // selector, so it is asked for and never depended on: the default material is already
    // correct and this only makes it the sidebar one.
    try {
      g.unstable_setVariant?.(id, SIDEBAR_VARIANT)
    } catch {
      /* the default material is fine */
    }
    return true
  } catch {
    return false
  }
}
