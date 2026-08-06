// Which copy of PaneForge a script means, and where that copy keeps its state.
//
// Every checkout launches under its own profile so two agents in two worktrees never land
// on the same one - see the comment in try.mjs for why sharing looks exactly like "my
// change did not apply". That naming lived in three files (try.mjs, dev.mjs, and the
// activation probe), and the probe's copy was the stale one: it hardcoded `dev`, so run
// from the lane checkout `PaneForge-a` it wrote its settings into the `dev` profile's
// folder and launched `dev-a`, which then had no saved position and cornered itself on
// top of the LIVE app's Stash. The probe refuses to post at a point inside the live
// overlay, so every run aborted before it measured anything, blaming a missing
// Accessibility grant that was only half the story.
//
// One definition, imported by all three.

import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** The profile a checkout launches as. `PaneForge` -> `dev`, `PaneForge-a` -> `dev-a`. */
export function devProfile(root) {
  const suffix = basename(root).replace(/^(claude-orchestrator|paneforge)-?/i, '')
  return suffix ? `dev-${suffix}` : 'dev'
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
