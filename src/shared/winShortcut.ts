/**
 * Whether this launch should put the Desktop shortcut back.
 *
 * The shortcut disappearing is not cosmetic: it is the only thing on this desk that opens
 * PaneForge, so losing it reads as "the app uninstalled itself". Measured on the PC
 * 2026-08-18: `Desktop\PaneForge.lnk` was gone while the Start Menu one was still stamped
 * with the original install date (26 Jul) - so nothing had recreated EITHER of them across
 * eleven updates, and something had deleted the Desktop one. Our own installer is at least
 * part of that: `build/installer.nsh` deleted `$DESKTOP\PaneForge.lnk` on every run,
 * outside the `IfFileExists` guard that was supposed to limit it to the portable layout.
 *
 * That guard is fixed too, but a guard in the installer can only ever cover the installer.
 * The app itself runs on every launch, knows its own exe, and is the one place that also
 * covers the old uninstaller, a half-finished update, and Windows' own maintenance task
 * (which deletes desktop shortcuts it decides are broken). So the rule is simply: if the
 * link is missing, make it.
 *
 * Pure so it can be checked with no registry and no Desktop: `npm run test:winshortcut`.
 */

export interface ShortcutFacts {
  platform: string
  /** A real install, not `electron .` and not a `npm run try` copy out of `dist`. */
  packaged: boolean
  /** `process.execPath`. */
  exePath: string
  /** The .lnk is already on the Desktop. */
  linkExists: boolean
  /** The user turned it off. */
  wanted: boolean
}

export interface ShortcutVerdict {
  make: boolean
  /** Why, either way - "why is there no shortcut" is the question actually asked. */
  reason: string
}

/**
 * The installed layout, from package.json's `name`: `...\Programs\claude-orchestrator\
 * PaneForge.exe`. A `npm run try` copy runs out of `dist\win-unpacked`, and pointing a
 * Desktop shortcut at a folder the next build deletes is worse than having none.
 */
const INSTALLED = /[\\/]programs[\\/]claude-orchestrator[\\/]/i

export function desktopShortcutVerdict(f: ShortcutFacts): ShortcutVerdict {
  if (f.platform !== 'win32') return { make: false, reason: 'not Windows' }
  if (!f.wanted) return { make: false, reason: 'turned off in Settings' }
  if (!f.packaged) return { make: false, reason: 'running from source' }
  if (!INSTALLED.test(f.exePath)) return { make: false, reason: 'not the installed copy' }
  if (f.linkExists) return { make: false, reason: 'already there' }
  return { make: true, reason: 'missing - putting it back' }
}
