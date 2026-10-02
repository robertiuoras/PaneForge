// An update that cannot leave somebody stuck on an old version.
//
// 2026-09-24: a friend on v0.8.179 (Windows) saw 0.8.225 "ready", pressed Restart now,
// and came back on 0.8.179 - every time, and after quitting too. Nothing on screen said
// the install had failed: the relaunch found the same download and showed the same card
// asking for the same restart, so the only way out was knowing to fetch the installer by
// hand. Three halves close it, and this file is the part of them that can be tested:
//
// - the installer (`build/installer.nsh` + `scripts/win-free-install-dir.ps1`) stops
//   everything still running out of the install folder before it copies, because the
//   stock check answers its own "cannot close PaneForge" box with Cancel when silent and
//   quits without installing;
// - the app waits for its panes' processes to be gone before it starts the installer
//   (`waitForExit`), instead of firing the kill and leaving at once;
// - a relaunch that is still on the old version says so in plain words and offers the
//   installer for exactly that version (`failedInstall`, `installerUrl`,
//   `installFailedWords`), rather than the same card again.

import { compareVersions } from './whatsNew'

/**
 * The version the last run tried to install, when this run is not it - the install did
 * not happen. `attempt` is `install-attempt.json`, written just before the installer ran.
 */
export function failedInstall(attempt: { version: string } | null, running: string): string | null {
  if (!attempt?.version) return null
  return compareVersions(attempt.version, running) > 0 ? attempt.version : null
}

/**
 * The installer for exactly the version that did not go in. Every release carries these
 * two fixed names (`PaneForge-Setup.exe`, `PaneForge-arm64.dmg`) beside the versioned ones.
 */
export function installerUrl(version: string, platform: string): string {
  const file = platform === 'darwin' ? 'PaneForge-arm64.dmg' : 'PaneForge-Setup.exe'
  return `https://github.com/robertiuoras/PaneForge/releases/download/v${version.replace(/^v/, '')}/${file}`
}

/** What the card says when the last update did not install. */
export function installFailedWords(current: string, version: string, platform: string): string {
  const byHand =
    platform === 'darwin'
      ? 'download it and drag it over the old PaneForge in Applications'
      : 'download the installer and run it'
  return `PaneForge tried to update to ${version} and came back as ${current}, so the update did not go in. Press Try again, or ${byHand}. Your chats and settings stay as they are.`
}

/**
 * Wait until none of `pids` is running, or `budgetMs` has passed. Returns the ones still
 * running (empty when all exited) and how long it waited. `alive` is the only part that
 * touches the system, so the clock and the sleep are injectable for the test.
 */
export async function waitForExit(
  pids: number[],
  opts: {
    alive: (pid: number) => boolean
    budgetMs: number
    pollMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<{ left: number[]; ms: number }> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const poll = opts.pollMs ?? 100
  const start = now()
  let left = pids.filter(opts.alive)
  while (left.length && now() - start < opts.budgetMs) {
    await sleep(poll)
    left = left.filter(opts.alive)
  }
  return { left, ms: now() - start }
}

/** `process.kill(pid, 0)` as a yes/no: it throws when the pid is gone (ESRCH). */
export function pidAlive(pid: number, kill: (pid: number, signal: 0) => unknown = (p, sig) => process.kill(p, sig)): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means it exists and belongs to somebody else - still running.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}
