// Never kill the copy this session is running inside.
//
// `scripts/boot-timing.mjs` clears the way for its measurement with
// `pkill -f 'PaneForge[^/]*/node_modules/electron'`. That pattern is careful about the
// INSTALLED app - it cannot match `/Applications/PaneForge.app` - but it says nothing
// about which checkout's copy it hits, and a session hosted in a `npm run try` copy is
// hosted by a process the pattern matches exactly. It killed the hosting session three
// times, mid-turn, with no message.
//
// The reading that separates the two cases is not the pattern, it is ANCESTRY: a pane's
// agent is a descendant of the app that opened it, so if any process above this one on
// the parent chain matches, the kill would take this session down with it.
//
// Pure half (`hostAncestor`) and disk half (`chainOf`) are split so the refusal can be
// proved against a written-out chain rather than by killing a real app to see what
// happens.
import { spawnSync } from 'node:child_process'

/** The pattern boot-timing hands to `pkill -f`. One place, so the guard cannot drift from it. */
export const ELECTRON_PATTERN = 'PaneForge[^/]*/node_modules/electron'

/**
 * This process's ancestors, nearest first, as `{ pid, command }`.
 *
 * pid 1 and pid 0 end the walk; so does a `ps` that answers nothing, which is what a
 * process that exited between two reads looks like. A partial chain is returned rather
 * than thrown on: half an answer still refuses correctly, and the alternative is a
 * measurement script that dies because a parent was reaped.
 */
export function chainOf(pid = process.pid, read = readOne) {
  const chain = []
  let at = Number(pid)
  for (let i = 0; i < 32; i++) {
    if (!Number.isFinite(at) || at <= 1) break
    const row = read(at)
    if (!row) break
    chain.push({ pid: at, command: row.command })
    at = row.ppid
  }
  return chain
}

function readOne(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' })
  const line = (r.stdout ?? '').trim()
  if (!line) return null
  const m = line.match(/^\s*(\d+)\s+([\s\S]*)$/)
  if (!m) return null
  return { ppid: Number(m[1]), command: m[2].trim() }
}

/**
 * The ancestor a kill on `pattern` would take with it, or null when the chain is clear.
 *
 * The process itself is included on purpose: a script run FROM the app's own pane is a
 * descendant, but a script that somehow IS the matching process must not shoot itself
 * either. `null` means "nothing above this one matches" - the only answer that lets a
 * kill go ahead.
 */
export function hostAncestor(chain, pattern = ELECTRON_PATTERN) {
  const re = new RegExp(pattern)
  for (const p of chain ?? []) if (re.test(p.command ?? '')) return p
  return null
}

/**
 * The sentence a refusing script prints. Kept beside the reading so both scripts and the
 * test say the same words - "the copy that pattern would kill" is the whole explanation,
 * and a reader who has never used a terminal still learns not to run it from in there.
 */
export function refusalWords(host) {
  return `refusing: this session runs inside a copy that pattern would kill (process ${host.pid})`
}

/**
 * Refuse, out loud and with exit code 2, when this process is running inside a copy the
 * kill would take down. Returns when there is nothing above us to protect.
 */
export function refuseSelfKill(pattern = ELECTRON_PATTERN, chain = chainOf()) {
  const host = hostAncestor(chain, pattern)
  if (!host) return
  console.error(refusalWords(host))
  process.exit(2)
}
