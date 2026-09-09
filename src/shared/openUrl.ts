// A link that would not open, and said so to nobody.
//
// paneforge-errors.log, four times with no recovery line after any of them: 2026-08-11
// 03:08:02, 03:57:13, 06:10:51 and 2026-08-19 10:33:42, each `unhandledRejection: Error:
// Failed to open URL`. That is macOS refusing to hand a link to a browser - a default
// browser mid-update, a scheme nothing claims, a Chrome being replaced on disk.
//
// Three things were wrong with it and only one has been fixed. The rejection was made
// into a caught log line on 2026-08-30, so the app no longer records it as a fault. It
// still does not say WHICH link, so the four in the log are undiagnosable; and it still
// says nothing at all to the person who pressed the link, who sees a button that did
// nothing.
//
// The words live here, away from electron, so they can be held to the rule that every
// word on screen is read by somebody who has never used git.

/**
 * Is there a link here at all?
 *
 * 2026-09-09 log review, this Mac: five `open url: a link in a pane: about:blank - Failed
 * to open URL` lines across two days, three of them inside eight seconds. `about:blank` is
 * what `window.open()` resolves to when it is called with no URL - a page in a pane doing
 * `window.open()` to get a handle, or an anchor with an empty `href` and `target=_blank`.
 * It reaches `setWindowOpenHandler`, which hands every url straight to the OS, and the OS
 * has nothing to open it with. It cannot succeed and it names nothing, so the log line is
 * five occurrences of nothing - the same shape as the four this file was written for.
 *
 * `about:` and `javascript:` are here for the same reason and one more: handing either to
 * the OS opener is asking a browser to run something on a target the app never chose.
 */
export function worthOpening(url: string): boolean {
  const u = (url ?? '').trim()
  if (!u) return false
  return !/^(about:|javascript:|data:)/i.test(u)
}

/** Longest URL worth putting in a toast. Past this the middle is dropped, not the end. */
const MAX_SHOWN = 90

/** The link, short enough to read, with its end kept - that is the part that identifies it. */
export function shortUrl(url: string): string {
  if (url.length <= MAX_SHOWN) return url
  const head = Math.ceil((MAX_SHOWN - 1) / 2)
  return `${url.slice(0, head)}…${url.slice(url.length - (MAX_SHOWN - 1 - head))}`
}

/**
 * What the person who pressed the link is told.
 *
 * It names the recovery, because there is one: the link is put on the clipboard, so the
 * answer is "paste it" rather than "try again and watch it do nothing".
 */
export function linkFailedWords(url: string): string {
  return `your browser would not open ${shortUrl(url)} - it is on your clipboard instead, ready to paste`
}

/** The same failure for a folder or a file, where there is nothing to paste. */
export function pathFailedWords(path: string, why: string): string {
  return `could not open ${shortUrl(path)}${why ? ` - ${why}` : ''}`
}
