// Opening a link, or a folder, in a way that leaves evidence and tells somebody.
//
// See shared/openUrl.ts for the four silent failures this exists for. Two rules:
// the WHAT is logged (a failure with no target in it cannot be diagnosed a week later),
// and the person who pressed the thing is told, because a button that does nothing and
// says nothing is indistinguishable from a broken app.

import { clipboard, shell } from 'electron'
import { logProblem } from './crash'
import { linkFailedWords, pathFailedWords } from '../shared/openUrl'

let notify: ((message: string) => void) | null = null

/** Where a failure goes on screen. Registered once, in index.ts, next to the crash one. */
export function onOpenProblem(fn: (message: string) => void): void {
  notify = fn
}

function say(message: string): void {
  try {
    notify?.(message)
  } catch {
    /* the window went away between the check and the send - the log line still stands */
  }
}

/**
 * Open a web link. `from` names the press, so the log line says which button.
 *
 * The clipboard is the recovery: the OS would not hand the link over, and there is
 * nothing this app can do about that, but it can make the link one paste away.
 */
export function openLink(url: string, from: string): void {
  void shell.openExternal(url).catch((err: unknown) => {
    const why = err instanceof Error ? err.message : String(err)
    // The URL is the whole point of this line. Without it the four in the log are four
    // occurrences of nothing.
    logProblem('open url', `${from}: ${url} - ${why}`)
    try {
      clipboard.writeText(url)
    } catch {
      /* a clipboard that refuses is not worth a second failure; the toast is still true
         about the link, and the log line carries it either way */
    }
    say(linkFailedWords(url))
  })
}

/**
 * Open a folder or a file in the OS file manager.
 *
 * `openPath` does not reject: it RESOLVES with an error string, or with '' when it
 * worked. So every one of these was silent by construction - the failure and the success
 * were the same value shape, which is exactly the thing that renders as success.
 */
export function openLocal(path: string, from: string): void {
  void shell
    .openPath(path)
    .then((why) => {
      if (!why) return
      logProblem('open path', `${from}: ${path} - ${why}`)
      say(pathFailedWords(path, why))
    })
    .catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err)
      logProblem('open path', `${from}: ${path} - ${why}`)
      say(pathFailedWords(path, why))
    })
}
