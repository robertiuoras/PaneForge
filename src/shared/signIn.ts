/**
 * A job that cannot sign in says so, and the desk says it needs you.
 *
 * `pf needs-login <site> --url <url>` is how a script or an agent stuck on a password,
 * a 2FA code or any other wall only a person can get past raises its hand. The window
 * puts one card up naming the site, the address and the pane that asked, and marks that
 * pane's row. That is ALL it does: nothing is opened, no browser is connected to, and
 * no other computer is reached. The person signs in themselves, then presses the card.
 *
 * Until 2026-09-25 the card could also open a live picture of the automation Chrome
 * beside the chat (a CDP screencast over an ssh tunnel). It was removed - see
 * `docs/specs/remote-login-pane.md` for why, and for the commit that still has it.
 */

/** A request from a job that cannot sign in by itself. */
export interface LoginRequest {
  id: string
  /** What the person will recognise: `facebook`, `keap`. */
  site: string
  /** The sign-in page, shown on the card so the person knows where to go. */
  url: string
  /** Words for the computer the sign-in has to happen on. */
  machine: string
  at: number
  /** Which pane asked, when a pane did. Its row is marked until the card goes. */
  from?: string
  /** What that pane is called, so the card can name who is stuck rather than "a job". */
  fromName?: string
  /** The asking pane's own words for what it will do once somebody has signed in. */
  why?: string
}

/** The computer the window is on, in the words Robert uses for it. */
export function machineWord(platform: string): string {
  return platform === 'darwin' ? 'this Mac' : 'this PC'
}

export function siteWord(site: string): string {
  const s = site.trim()
  if (!s) return 'A website'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * How long the job has been stuck, in the words a person would use.
 *
 * Under a minute is "just now": a card that appears saying "waiting 0 min" reads as
 * broken. Past an hour the minutes stop mattering.
 */
export function waitedWords(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `waiting ${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `waiting ${h}h ${rest}m` : `waiting ${h}h`
}

/**
 * Who is stuck, in one line.
 *
 * A card that says "a job is waiting" tells the person nothing they can act on: with
 * four panes and two machines, WHICH job matters. The pane's own name is the handle they
 * already use for it in the sessions list, so it leads.
 */
export function stuckWords(
  req: Pick<LoginRequest, 'machine' | 'fromName' | 'at'>,
  now: number = Date.now()
): string {
  const who = req.fromName?.trim() || 'A job'
  return `${who} on ${req.machine} - ${waitedWords(now - req.at)}`
}

/**
 * The card, for somebody who has never used a terminal: which website, where to go, and
 * which computer to do it on. No "CDP", no "host", no "port".
 */
export function loginCardText(
  req: Pick<LoginRequest, 'site' | 'url' | 'machine' | 'fromName' | 'why' | 'at'>,
  now: number = Date.now()
): {
  title: string
  body: string
  who: string
  why: string
  done: string
} {
  const at = typeof req.at === 'number' ? req.at : now
  return {
    title: `${siteWord(req.site)} needs you to sign in`,
    who: stuckWords({ machine: req.machine, fromName: req.fromName, at }, now),
    why: (req.why ?? '').trim(),
    body: `The job cannot get past the sign-in by itself. Sign in on ${req.machine} at ${req.url}, then press Signed in.`,
    done: 'Signed in'
  }
}

/** The chip on the asking pane's row, and what hovering it says. */
export function paneChipTitle(req: Pick<LoginRequest, 'site' | 'url' | 'machine'>): string {
  return `${siteWord(req.site)} needs you to sign in on ${req.machine}:\n${req.url}`
}

/**
 * What the pane that asked is told once somebody has signed in.
 *
 * It is a sentence an agent can act on rather than a status word: it says the wall is
 * down and that the work it stopped on is the work to carry on with.
 */
export function signedInWords(site: string, machine: string): string {
  return `Signed in to ${siteWord(site)} on ${machine} - the browser is past the sign-in now, so carry on with what you were doing.`
}
