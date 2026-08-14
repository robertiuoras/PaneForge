/**
 * Which release an install may take, out of a GitHub releases API answer.
 *
 * Lives here, taking the wanted asset name as an argument, so it can be tested without
 * electron: `updater.ts` passes `assetFor` from `macUpdate.ts` and nothing else changes.
 *
 * The rule it exists for: a release cut from the Windows machine alone publishes no mac
 * asset at all (v0.8.61 is one - `latest.yml` and the exe, nothing else). Taking the
 * newest tag on faith then downloads a 404 for ever: the poll retries, the retry picks
 * the same tag, and the Mac sits on an old build behind an error card that no restart
 * clears, because nothing in the loop ever considers the release BELOW it. `assets` is
 * already in the list response, so skipping costs no extra request.
 */

export type ApiRelease = { draft?: boolean; tag_name?: string; assets?: { name?: string }[] }

function installable(rel: ApiRelease, assetFor: (version: string) => string): boolean {
  const version = String(rel?.tag_name ?? '').replace(/^v/, '')
  if (!version) return false
  const want = assetFor(version)
  return (rel.assets ?? []).some((a) => a?.name === want)
}

export function pickRelease(json: unknown, assetFor: (version: string) => string): string {
  // `/releases/latest` answers a single object and is GitHub's own promoted release;
  // there is no list to walk, so it is taken as given.
  if (!Array.isArray(json)) return String((json as ApiRelease)?.tag_name ?? '')
  const list = (json as ApiRelease[]).filter((r) => r && !r.draft)
  // Only judge on assets when the response actually carries them. A stub, or an older
  // API shape, lists none at all - and refusing every release there would be the same
  // wedge wearing the other face.
  const known = list.some((r) => Array.isArray(r.assets))
  const rel = known ? list.find((r) => installable(r, assetFor)) : list[0]
  return String(rel?.tag_name ?? '')
}
