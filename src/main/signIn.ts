/**
 * The sign-in requests waiting on this desk - see `shared/signIn.ts`.
 *
 * A list in memory and nothing else. A request is a card and a mark on the pane that
 * asked; it opens nothing, connects to nothing and outlives nothing but the app run.
 */

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { appendLog } from './logWrite'
import { machineWord, signedInWords, type LoginRequest } from '../shared/signIn'

const MAX_BYTES = 256 * 1024

function logPath(): string {
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'sign-in.log')
}

// The log must never be what breaks the request it is recording: see logWrite.ts.
function log(line: string): void {
  appendLog(logPath(), `[${new Date().toISOString()}] ${line}\n`, { rotateAt: MAX_BYTES })
}

export interface SignInDeps {
  /** The request list changed; the desk redraws its card and the asking pane's row. */
  publish(reqs: LoginRequest[]): void
  /** What a pane is called, so the card can say who is stuck rather than "a job". */
  paneName?(id: string): string | undefined
  /** Say the wall is down to the pane that asked. False when that pane is gone. */
  tell?(paneId: string, text: string): boolean
}

const waiting = new Map<string, LoginRequest>()
let deps: SignInDeps | null = null
let seq = 0

export function initSignIn(d: SignInDeps): void {
  deps = d
}

function publish(): void {
  deps?.publish(listLogins())
}

export function listLogins(): LoginRequest[] {
  return [...waiting.values()].map((r) => ({ ...r })).sort((a, b) => b.at - a.at)
}

/** A job says it cannot get past a sign-in. The card goes up; nothing is opened. */
export function requestLogin(input: {
  site?: string
  url?: string
  machine?: string
  from?: string
  /** What the pane will do once it is signed in, in its own words. */
  why?: string
}): LoginRequest {
  const site = String(input.site ?? '').trim()
  const url = String(input.url ?? '').trim()
  if (!site) throw new Error('Say which website needs a sign-in, like: pf needs-login keap --url https://keap.com/login')
  if (!/^https?:\/\//i.test(url)) throw new Error(`A sign-in page starts with http:// or https:// - got "${url}"`)
  const machine = input.machine?.trim() || machineWord(process.platform)
  const from = input.from?.trim() || undefined
  const why = input.why?.trim() || undefined
  // The same site on the same computer asked twice BY THE SAME ASKER is one card, not a
  // pile of them: a sweep that runs every ten minutes would otherwise paper the desk over a
  // weekend. A second pane asking for the same site is its own request, because Signed in
  // tells one pane and each of them is waiting.
  const already = [...waiting.values()].find((r) => r.site === site && r.machine === machine && r.from === from)
  if (already) {
    already.url = url
    // A second ask carries a fresher reason, and - when the first came from a script with
    // nothing to say - the first reason at all.
    if (why) already.why = why
    publish()
    return { ...already }
  }
  const req: LoginRequest = {
    id: `login-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    site,
    url,
    machine,
    at: Date.now(),
    from,
    fromName: (from ? deps?.paneName?.(from) : undefined) || undefined,
    why
  }
  waiting.set(req.id, req)
  log(`asked ${req.id} site=${site} machine=${machine} from=${from ?? '-'} url=${url}`)
  publish()
  return { ...req }
}

/**
 * Signed in: the person says they are past the wall, so the pane that asked is told and
 * the card goes. The line goes out BEFORE the request is deleted, because the request is
 * what names who to tell.
 */
export function doneLogin(id: string): void {
  const r = waiting.get(id)
  if (!r) return
  if (r.from) {
    try {
      const told = deps?.tell?.(r.from, signedInWords(r.site, r.machine)) ?? false
      log(told ? `done ${r.id} told ${r.from}` : `done ${r.id} could not tell ${r.from}: that pane is gone`)
    } catch (e) {
      log(`done ${r.id} could not tell ${r.from}: ${String(e)}`)
    }
  }
  waiting.delete(id)
  publish()
}

/** Not now: the card goes, the job that asked is not told anything new. */
export function dismissLogin(id: string): void {
  const r = waiting.get(id)
  if (!r) return
  log(`dismissed ${r.id}`)
  waiting.delete(id)
  publish()
}
