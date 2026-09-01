// Antigravity asks `Yes, I trust this folder` the first time it starts in a folder it has
// not seen, and a pane this app opened has already been trusted by the person who opened
// it - so the question is a keystroke somebody has to find before the agent will read
// anything.
//
// There is no flag and no trust-everything switch. The CLI keeps the answer in
// `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` and asks about
// anything absent from it (`CliSetting.IsTrustedWorkspace`, read off the v1.1.x binary;
// `--trust`, `--yolo` and a trust-all setting do not exist in it). `toolPermission` and
// `defaultMode` are about what the agent may DO once it is in - they do not answer this.
//
// So the folder goes in the list before the process starts. Pure here so the rules can be
// asserted without a settings file; `main/agyTrust.ts` is the half that touches disk.

/** The settings key the CLI reads. Any other key in the file is left alone. */
export const TRUST_KEY = 'trustedWorkspaces'

/**
 * How many folders are kept. The list is a record of every folder a pane has ever opened,
 * which grows for ever on a desk that makes worktrees; the oldest end is dropped rather
 * than letting one settings file collect a thousand dead paths.
 */
export const MAX_TRUSTED = 200

/**
 * The trusted list this folder needs, or null when the file already answers for it.
 *
 * Null is the common answer and it is the point: nothing is written on a launch into a
 * folder that has been used before, so the file is touched once per new folder rather
 * than once per pane.
 *
 * Matching is EXACT. A parent being trusted would be a guess about how the CLI resolves
 * a workspace, and guessing wrong here costs nothing but the prompt this exists to
 * remove - while a wrongly-skipped write leaves the prompt in place for ever.
 */
export function withTrusted(current: unknown, cwd: string): string[] | null {
  if (!cwd || !cwd.trim()) return null
  const folder = cwd.replace(/[\\/]+$/, '')
  // A relative path is not a workspace the CLI could match; it would sit in the list
  // for ever answering for nothing.
  if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(folder)) return null
  const list = Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string') : []
  if (list.some((v) => v.replace(/[\\/]+$/, '') === folder)) return null
  const next = [...list, folder]
  return next.length > MAX_TRUSTED ? next.slice(next.length - MAX_TRUSTED) : next
}
