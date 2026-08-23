// Which copy of PaneForge a script means, and where that copy keeps its state.
//
// THERE IS ONE DEV COPY PER MACHINE, not one per checkout. Robert's words, 2026-08-23:
// "whats the point of 2 dev windows can you use just 1 at all times?" - and he is right,
// because the thing being looked at is one window on one screen. Two of them is two
// taskbar buttons, two sets of panes, two remote links to the same PC, and no way to tell
// from the screen which checkout you are looking at.
//
// It used to be one profile per checkout (`PaneForge-a` -> `dev-a`), so two lanes could
// each hold their own copy. The cost that bought - a second lane's launch raising the
// first lane's window and exiting on the single-instance lock, which reads exactly like
// "my change did not apply" - is paid instead by `closeTestApps`, which now closes the
// dev copy whatever checkout started it, so a launch always ends with THIS checkout's
// build in the one window. Last launcher wins, out loud.
//
// One definition, imported by try.mjs, dev.mjs and the activation probe, so the probes
// that have to FIND this copy's settings folder cannot drift from the script that
// launches it.

import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** The profile every checkout launches as. One dev window per machine. */
export function devProfile(_root) {
  return 'dev'
}

/**
 * Every sibling checkout of this one - `PaneForge`, `PaneForge-a`, `PaneForge-b`... - as a
 * folder prefix. `closeTestApps` matches Electron under any of them, because the copy
 * holding the shared `dev` lock is regularly one another lane started.
 *
 * The family name is the checkout's own, minus the lane suffix, and it keeps the folder's
 * real case: the repo is renamed by scripts/rename-repo.mjs and this must follow it.
 */
export function checkoutFamily(root) {
  const name = basename(root)
  const m = name.match(/^(claude-orchestrator|paneforge)/i)
  return join(dirname(root), m ? m[1] : name)
}

/**
 * Where Electron puts that profile's userData - the same path src/main/profile.ts builds,
 * which is `<the installed app's folder>-<profile>`. The base name is package.json `name`,
 * NOT the product name, and it stays `claude-orchestrator` on purpose (see CLAUDE.md).
 */
export function profileData(profile) {
  const dir = profile ? `claude-orchestrator-${profile}` : 'claude-orchestrator'
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', dir)
  if (process.platform === 'win32')
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), dir)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), dir)
}

/** That profile's config.json. */
export function profileConfig(profile) {
  return join(profileData(profile), 'config.json')
}
