// A build folder's leftover app, opened by hand, took the desk for a whole day's work.
//
// updater.log, this Mac, 2026-09-18: 0.8.217 installed at 01:37Z and came up fine. At
// 01:38Z the last window was closed, which quits the app. At 01:39Z the next launch read
// `launch v0.8.183 pid 14045 start=normal` - from
// `~/Projects/PaneForge/dist/mac-arm64/PaneForge.app`, an electron-builder output left
// behind on 1 September. Spotlight and Finder know every bundle on the disk, and four
// were called PaneForge that morning (the installed one, the staged one, two `dist/`
// folders in two checkouts), so "open PaneForge" is a coin toss. The stale copy then
// wrote ITS lane hooks into ~/.claude/settings.json, pointing at scripts a 17-day-old
// build did not ship, and every chat on the machine was refused its lane.
//
// The rule: a packaged app running out of a build folder, with no profile named, is
// never the daily driver. When an installed copy exists and is not older, this process
// opens that one and leaves. Every other answer leaves the app exactly as it was - a
// `npm run try` copy carries a profile, a test copy is headless, and a checkout with no
// installed app at all is somebody's only PaneForge.

export type StrayVerdict =
  | 'go'
  | 'not a build folder'
  | 'a named profile'
  | 'headless'
  | 'not packaged'
  | 'no installed copy'
  | 'this is the installed copy'
  | 'the installed copy is older'

export interface StrayState {
  /** `process.execPath` of this process. */
  execPath: string
  /** This build's version. */
  version: string
  /** `profileName()`: '' for the daily driver, `dev` and friends for a copy under test. */
  profile: string
  headless: boolean
  packaged: boolean
  /** The installed app, when one was found, and the version its bundle declares. */
  installed: { path: string; version: string } | null
}

/** A path segment electron-builder writes its output under: `dist/mac-arm64/...`, `dist/win-unpacked/...`. */
export function inBuildFolder(execPath: string): boolean {
  const parts = execPath.replace(/\\/g, '/').split('/')
  const i = parts.indexOf('dist')
  if (i < 0) return false
  const next = parts[i + 1] ?? ''
  return /^(mac(-arm64|-x64|-universal)?|win(-unpacked|-arm64-unpacked|-ia32-unpacked)?|linux(-unpacked|-arm64-unpacked)?)$/.test(next)
}

function num(v: string): number[] {
  return v
    .trim()
    .replace(/^v/, '')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0)
}

/** Negative when a < b, 0 when equal, positive when a > b; numeric, dotted, `v` stripped. */
export function compareVersions(a: string, b: string): number {
  const x = num(a)
  const y = num(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function sameApp(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const x = norm(a)
  const y = norm(b)
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

export function strayLaunch(s: StrayState): StrayVerdict {
  if (!s.packaged) return 'not packaged'
  if (!inBuildFolder(s.execPath)) return 'not a build folder'
  if (s.profile) return 'a named profile'
  if (s.headless) return 'headless'
  if (!s.installed) return 'no installed copy'
  if (sameApp(s.execPath, s.installed.path)) return 'this is the installed copy'
  if (compareVersions(s.installed.version, s.version) < 0) return 'the installed copy is older'
  return 'go'
}

/** Pulls `CFBundleShortVersionString` out of a Mac bundle's Info.plist text, '' when absent. */
export function plistVersion(plist: string): string {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
  return m ? m[1].trim() : ''
}
