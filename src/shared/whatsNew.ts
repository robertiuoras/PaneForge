// What changed, said once, the first time you are on the new build.
//
// A dev release lands silently: the app restarts, the panes come back, and nothing on
// screen says what moved. Robert, 2026-08-28: "for dev releases remember to put a popup
// when i restart paneforge for the update to show what was fixed etc in summary bullet
// points just simple concepts enough for me to understand".
//
// This file is the arithmetic - which build to speak about, and how to turn a release
// body into short sentences. `main/whatsNew.ts` is the fetch and the remembering,
// `components/WhatsNewCard.tsx` the card. Nothing here touches the network or the disk,
// which is why it can be tested.

/** As many as fit before a card stops being a summary and becomes a changelog. */
export const MAX_BULLETS = 6

/** Longer than this and it is a paragraph somebody has to read twice. */
export const MAX_CHARS = 120

/**
 * Whether this launch is the first one on a build worth saying something about.
 *
 * Three refusals, and each is a way of promising less rather than more:
 *
 * - No `seen` at all is a FRESH INSTALL. Nothing was fixed for this person; there is no
 *   previous build they were on. The version is remembered silently and the first card
 *   they ever see is a real one.
 * - The same version is a launch they have already been told about. This is the common
 *   case - the app restarts for all sorts of reasons - and it must be free.
 * - Going BACKWARDS is a rollback (`lane.mjs promote` to an older stable, a hand
 *   install). "What's new" over a downgrade is a lie, so it says nothing and remembers
 *   where it now is.
 */
export function shouldSpeak(installed: string, seen: string | undefined | null): boolean {
  if (!installed.trim()) return false
  if (!seen || !seen.trim()) return false
  if (seen === installed) return false
  return compareVersions(installed, seen) > 0
}

/** -1, 0, 1 over dotted numeric versions. A non-numeric part sorts as 0, never NaN. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.replace(/^v/, '').split(/[.\-+]/).map((n) => Number(n) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * The release body, as sentences somebody can read in one glance.
 *
 * `scripts/release-notes.mjs` writes that body out of Conventional Commit subjects, so
 * what arrives is markdown bullets that still wear their machine prefix - `fix(panes):`,
 * `**feat:**`, a scope, sometimes a trailing PR link. Every one of those is noise to the
 * person the card is for, and the sentence underneath is already plain English because
 * this repo writes its subjects that way.
 *
 * An empty answer is a REFUSAL, not an empty card: a body with no bullets in it (a
 * hand-written release, a fallback to the commit-history link) has nothing to summarise,
 * and a card saying "what's new: nothing" is worse than no card. `main` draws nothing
 * when this comes back empty.
 */
export function bulletsFrom(body: string | null | undefined): string[] {
  if (!body) return []
  const out: string[] = []
  for (const raw of String(body).split('\n')) {
    const line = raw.trim()
    // Only real list items. A heading, a link line and the commit-history fallback are
    // all prose about the release rather than a thing that changed in it.
    if (!/^[-*]\s+/.test(line)) continue
    let t = line.replace(/^[-*]\s+/, '')
    // Markdown emphasis around the prefix, which is how the generated notes bold it.
    t = t.replace(/\*\*/g, '').replace(/`/g, '')
    // `fix(panes):` / `feat!:` / `perf:` - the machine half of the subject.
    t = t.replace(/^(feat|fix|perf|refactor|docs|test|chore|build|ci|style)(\([^)]*\))?!?:\s*/i, '')
    // A trailing PR link or bare sha the generator appends.
    t = t.replace(/\s*\(?\[?[0-9a-f]{7,40}\]?\)?\s*$/i, '')
    t = t.replace(/\s*\(#\d+\)\s*$/, '')
    t = t.replace(/\s*https?:\/\/\S+$/, '')
    t = t.trim()
    if (!t) continue
    // One sentence. The subjects in this repo are already one, but a body written by hand
    // is not promised to be, and the card has room for a line rather than a paragraph.
    if (t.length > MAX_CHARS) t = t.slice(0, MAX_CHARS - 1).replace(/\s+\S*$/, '') + '…'
    t = t.charAt(0).toUpperCase() + t.slice(1)
    if (!out.includes(t)) out.push(t)
    if (out.length >= MAX_BULLETS) break
  }
  return out
}

/** What the card is told to draw, or null for "say nothing". */
export interface WhatsNew {
  version: string
  bullets: string[]
  /** More changed than the card shows, so the link to the full notes earns its place. */
  more: number
  url: string
}
