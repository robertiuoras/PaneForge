// Which panes are SERVING something: a process that closing the pane would stop is holding
// a listening TCP socket.
//
// Robert, 2026-09-29: "why guarddeck showing chat 11 closes dev:dev isnt that our dev server
// on remote pc session that shouldn't close please". A dev server is the one thing on the
// desk whose whole job is to sit quiet: it prints its banner, answers a request now and
// then, and otherwise says nothing for hours - which is exactly what the idle clock reads
// as a finished pane. `job` catches it only while the shell's foreground reading is right,
// and `backJob` only while the usage sampler is running (it stops with a hidden window,
// which is how the PC's window spends its day). Neither is about what the pane is DOING.
//
// A listening socket is. It is the same reading a person takes by hand (`lsof -iTCP
// -sTCP:LISTEN`, `netstat -ano`), it names the process that bound it, and it is true of
// every server whatever started it - `npm run dev` typed into a shell, a `next dev` an
// agent left running in the background, a `node serve.mjs` with no dev script at all.
// Measured on both machines 2026-09-29 with 16 panes open: not one process inside a pane's
// tree was listening, agent CLIs and their MCP servers included, so the reading does not
// fire on panes that are merely alive.
//
// "Closing the pane would stop it" is `main/strays.ts`'s ledger: every process the pane has
// had under it, written down while its parent links were still true, and killed from that
// list when the pane closes. So a `next dev` whose npm parent exited - ppid 1 on a Mac, a
// dead number on Windows - still counts, because closing the pane still takes it.
//
// Pure: `npm run test:reclaim`.

import { programName } from './paneJob'

/** One row of the strays sampler's table (`main/strays.ts` `ProcRecord`). */
export interface ServingProc {
  pid: number
  ppid: number
  /** opaque creation time - a pid whose `started` moved is a different process */
  started: string
  name: string
}

export interface ServingPane {
  id: string
  /** the pty's own pid, which is the shell or the agent CLI itself */
  pid: number
  /** everything the ledger has seen under this pane, alive or not */
  recorded: Array<{ pid: number; started: string }>
}

/**
 * pane id -> the program holding the socket, for every pane that is serving.
 *
 * The pty's own process is never the answer: it is the agent CLI or the shell, and if one
 * of those ever listens it is doing so as plumbing, which would pin every pane of that kind
 * open for ever. A recorded pid only counts while the table still carries it with the same
 * creation time - a reused number is somebody else's server.
 */
export function servingPanes(
  procs: ServingProc[],
  listening: ReadonlySet<number>,
  panes: ServingPane[]
): Map<string, string> {
  const out = new Map<string, string>()
  if (!procs.length || !listening.size) return out
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const kids = new Map<number, ServingProc[]>()
  for (const p of procs) {
    const list = kids.get(p.ppid)
    if (list) list.push(p)
    else kids.set(p.ppid, [p])
  }
  for (const pane of panes) {
    if (!Number.isInteger(pane.pid) || pane.pid <= 0) continue
    const mine = new Map<number, ServingProc>()
    // The live tree, for anything started since the ledger last sampled...
    const seen = new Set<number>([pane.pid])
    const queue = [pane.pid]
    while (queue.length) {
      for (const kid of kids.get(queue.shift() as number) ?? []) {
        if (seen.has(kid.pid)) continue
        seen.add(kid.pid)
        mine.set(kid.pid, kid)
        queue.push(kid.pid)
      }
    }
    // ...and what the ledger wrote down, for anything that has since left it.
    for (const r of pane.recorded) {
      const live = byPid.get(r.pid)
      if (live && live.started === r.started && r.pid !== pane.pid) mine.set(r.pid, live)
    }
    for (const p of mine.values()) {
      if (!listening.has(p.pid)) continue
      out.set(pane.id, programName(p.name) || 'a server')
      break
    }
  }
  return out
}
