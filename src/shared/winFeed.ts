/**
 * Which release a Windows install may point its feed at.
 *
 * Split out of `main/updater.ts` for the same reason `pickRelease.ts` was: the choice is
 * arithmetic and the plumbing around it is `gh`, `https` and electron. The rule is one
 * sentence - newest first, take the first that carries a Windows feed file - and the two
 * cases worth pinning are the ones that make it a fix rather than a rewrite: the newest
 * release being skipped, and NOTHING being installable leaving the feed alone instead of
 * pointing it at a release that would 404 for ever.
 *
 * `npm run test:winfeed`.
 */

/** Newest first. `has` answers "does this tag carry a latest.yml". */
export async function pickWinTag(tags: string[], has: (tag: string) => Promise<boolean>): Promise<string> {
  for (const tag of tags) {
    if (await has(tag)) return tag
  }
  // Empty, not "the newest anyway": a feed pointed at a release with no latest.yml is the
  // wedge this exists to stop, and leaving the feed alone is a strictly better failure.
  return ''
}
