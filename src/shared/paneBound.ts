// Work that only runs on THIS machine.
//
// `shared/autoHandoff.ts` moves a pane by killing its pty and starting a fresh agent on
// the other device against the same repo. That is only ever safe because the WORK is in
// the repo and the conversation is in a transcript - both of which travel. A pane driving
// a browser on this desk has neither: the automation is a live process attached to this
// machine's window server, its profile, its logged-in Chrome, and nothing about it is in
// a commit. Moving it kills the browser mid-flow and the far end starts an agent with no
// idea a browser was ever open. Robert named it directly (2026-08-28): "for automated
// chrome stuff we need to probably keep it on the macbook".
//
// So this is a REFUSAL, read off the same process sample `shared/paneBackJobs.ts` uses,
// and it is narrow for the same reason that one is: the expensive failure is a FALSE
// reading, which pins a pane to this desk for ever and quietly switches the whole ladder
// off for it.
//
// What it may NOT key on is a browser NAME. Measured on this machine 2026-08-24, every
// `claude` pane holds, permanently and from launch, `safaridriver --mcp` and
// `chrome-devtools-mcp` (plus a node child) - MCP servers that are part of the pane's
// prelude and are running whether or not anybody has ever opened a page. A rule that saw
// "chrome" or "safaridriver" in the tree would refuse every single pane on the desk.
//
// What separates a live automation from the prelude is that a driver has actually
// LAUNCHED a browser, and an automated browser is started with flags no human's browser
// carries:
//
//   --remote-debugging-port / --remote-debugging-pipe   the port a driver drives through
//   --headless                                          nobody is looking at it
//   --user-data-dir=<tmp>                               a throwaway profile
//
// Those are on the BROWSER process, not on the MCP server, so the prelude does not match
// and a page actually being driven does. An MCP server is excluded by name as well
// (`--mcp`), because a server whose own argv happens to mention a port must not count.

/** One process, reduced to what the rule below asks about. Same shape as `JobRow`. */
export interface BoundRow {
  pid: number
  ppid: number
  /** the whole command line - a flag is the whole reading, so the executable is not enough */
  cmd?: string
}

/**
 * The flags an automated browser carries and a person's browser does not.
 *
 * `--remote-debugging-pipe` as well as the port: Playwright and Puppeteer both drive over
 * a pipe by default, and a rule that only knew about the port would miss every one of
 * them while matching this repo's own `npm run probe`.
 */
const AUTOMATION = /(?:^|\s)--(?:remote-debugging-port|remote-debugging-pipe|headless)(?:[=\s]|$)/

/**
 * A driver binary: the thing a test suite talks to, which owns a browser for its lifetime.
 *
 * Matched on the executable name so a path containing the word does not count, and only
 * when it is NOT an MCP server - `safaridriver --mcp` is in every pane's prelude here.
 */
const DRIVERS = /(?:^|[/\\])(chromedriver|geckodriver|msedgedriver|safaridriver)(?:\s|$)/i

/** An MCP stdio server. Part of a pane's prelude, running or not, and never a reason. */
const MCP = /(?:^|\s)--?mcp(?:[=\s]|$)|(?:^|[/\\])[a-z0-9-]*-mcp[a-z0-9-]*(?:\s|$)/i

/**
 * What to call this pane's binding, off the process that caused it.
 *
 * Exported so `scripts/panebound-test.mjs` reads the live process table through the same
 * three signals rather than a copy of them: a mirror of the regexes drifts silently, and
 * a copy that dropped the MCP exclusion would call every pane on this desk bound.
 */
export function boundReason(cmd: string): string | undefined {
  if (MCP.test(cmd)) return undefined
  if (AUTOMATION.test(cmd)) return 'a browser it is driving'
  if (DRIVERS.test(cmd)) return 'a browser driver'
  return undefined
}

/**
 * Why this pane's work cannot follow it to another machine, or undefined.
 *
 * @param rows the pane's own process tree, as `treeOf` in `main/usage.ts` already cuts it
 * @param ptyPid the pane's pty, which is never itself a reason
 *
 * Walks the whole tree rather than the direct children: a driver is routinely three
 * processes down (an agent's shell, the tool, the driver), and a browser is a child of
 * the driver. There is no age floor - unlike a background job, a browser that opened one
 * second ago is exactly the thing that must not be killed - and no shell-subtree rule,
 * because a driver an MCP server launched is not under a shell at all.
 */
export function machineBound(rows: BoundRow[], ptyPid: number): string | undefined {
  const byParent = new Map<number, BoundRow[]>()
  for (const r of rows) {
    const kids = byParent.get(r.ppid)
    if (kids) kids.push(r)
    else byParent.set(r.ppid, [r])
  }
  const seen = new Set<number>([ptyPid])
  const queue = [ptyPid]
  while (queue.length) {
    const pid = queue.shift() as number
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue
      seen.add(kid.pid)
      queue.push(kid.pid)
      const why = boundReason(kid.cmd ?? '')
      if (why) return why
    }
  }
  return undefined
}
