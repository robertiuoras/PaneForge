// What a pane was RUNNING, so a handoff can start it again on the other machine.
//
// A handoff moves the agent's conversation, the code and the screen. It does not move the
// dev server the agent started, and it cannot: `kill()` takes the pty's whole descendant
// tree, so `npm run dev` dies here and nothing over there brings it back. The pane arrives
// pointing at a project whose server is not running, which reads as the handoff having
// half worked.
//
// Two things make this harder than reading a command line off `ps`.
//
//   1. **The server is routinely not a descendant of the pane.** Measured on this desk
//      2026-08-17: `node <repo>/node_modules/next/dist/bin/next dev -p 3009` was sitting on
//      ppid 1 - its npm parent had already exited and the kernel reparented it. A walk down
//      the pty's tree finds nothing. So a process is attributed to a pane by its tree OR by
//      its command line naming a path inside that pane's repo, and the second is the one
//      that catches the case that matters.
//   2. **What is running is not what would be typed.** Nobody types
//      `node .../next/dist/bin/next dev -p 3009`; they type `npm run dev`, and the port came
//      out of the script. Re-issuing the observed argv would hard-code a port that is
//      already taken on the other machine, and would run a binary out of a `node_modules`
//      the receiver may not have installed yet. So an observed process is turned back into
//      a package.json SCRIPT, and the script is what travels.
//
// The receiver never runs bytes it was handed. It re-derives the command from its own
// package.json, from a script name it has validated itself - so the worst a malicious
// payload can name is a script that repo's own author wrote. Nothing here is shell: the
// script name is matched against `SCRIPT_NAME` and the command is built as argv.
//
// Pure - no fs, no child_process, no Electron. `npm run test:devservers`.

/** A script name we are willing to say out loud. No spaces, no punctuation that a shell reads. */
export const SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,39}$/

/** Package managers whose `run` we recognise, and whose lockfile the receiver may find. */
export const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const
export type Manager = (typeof MANAGERS)[number]

/**
 * Script names that mean "this serves something and keeps running".
 *
 * Deliberately narrow. A pane's tree during a handoff also holds `npm run build`, `npm
 * test` and whatever the agent last tried; re-issuing those on the far end would repeat
 * work at best and overwrite a build at worst. A long-running server is the only thing
 * whose absence is a bug, so it is the only thing that travels.
 */
export const DEV_SCRIPT = /^(dev|start|serve|watch|preview)(:[a-zA-Z0-9._-]+)?$/

/**
 * Tools that ARE a dev server when they are running, whatever the script that started them
 * was called. Used only to find which script to re-run - never to build a command.
 */
export const DEV_TOOLS = [
  'next',
  'vite',
  'nuxt',
  'astro',
  'remix',
  'webpack-dev-server',
  'ng',
  'react-scripts',
  'parcel',
  'rollup',
  'tsup',
  'nodemon',
  'electron-vite',
  'expo',
  'svelte-kit',
  'gatsby',
  'docusaurus'
] as const

/** What one observed process looked like, once it has been recognised. */
export type DevSignal =
  /** the process was the package manager itself, so the script name is right there */
  | { kind: 'script'; script: string }
  /** a tool running out of node_modules - the script has to be found in package.json */
  | { kind: 'tool'; tool: string }

const shellish = /[;&|<>$`(){}\n\r'"\\]/

/** argv from a `ps`-style command line. Null when it holds anything a shell would read. */
export function tokenize(cmdline: string): string[] | null {
  const line = cmdline.trim()
  if (!line || shellish.test(line)) return null
  return line.split(/\s+/)
}

const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.(exe|cmd|bat)$/i, '')

/**
 * What this command line says about a dev server, or null.
 *
 * The two shapes measured on this desk, both real:
 *
 *   npm run dev:restart                                        -> script
 *   node /Users/.../node_modules/next/dist/bin/next dev -p 3009 -> tool
 *
 * npm sets its own process title to what was typed, which is why the first shape survives
 * at all. Everything else arrives as the second and has to be looked up.
 */
export function devSignalOf(cmdline: string): DevSignal | null {
  const argv = tokenize(cmdline)
  if (!argv || !argv.length) return null

  const head = base(argv[0]) as Manager
  if ((MANAGERS as readonly string[]).includes(head)) {
    // `npm run dev`, `pnpm run dev`
    if (argv[1] === 'run' && argv[2] && SCRIPT_NAME.test(argv[2]) && DEV_SCRIPT.test(argv[2])) {
      return { kind: 'script', script: argv[2] }
    }
    // `pnpm dev`, `yarn dev`, `bun dev` - the shorthand every manager but npm accepts.
    if (argv[1] && SCRIPT_NAME.test(argv[1]) && DEV_SCRIPT.test(argv[1])) {
      return { kind: 'script', script: argv[1] }
    }
    return null
  }

  // A tool out of node_modules, however it was reached: `node <path>/node_modules/next/...`,
  // `<path>/node_modules/.bin/vite`, or the bare binary on PATH.
  for (const arg of argv) {
    const m = /node_modules[\\/](?:\.bin[\\/])?(@[^\\/]+[\\/])?([^\\/]+)/.exec(arg)
    const name = m ? m[2] : (DEV_TOOLS as readonly string[]).includes(base(arg)) ? base(arg) : ''
    if (name && (DEV_TOOLS as readonly string[]).includes(name)) return { kind: 'tool', tool: name }
  }
  return null
}

/**
 * Whether this command line belongs to a pane whose repo is `root`.
 *
 * Path containment rather than a tree walk, because the process this is written for had
 * already been reparented onto pid 1. Compared case-insensitively with both separators
 * normalised: one side of every pairing here is Windows.
 */
export function inRepo(cmdline: string, root: string): boolean {
  if (!root) return false
  const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  return norm(cmdline).includes(norm(root) + '/')
}

/**
 * The scripts in a package.json that would start `tool`, best first.
 *
 * A repo routinely has several (`dev`, `dev:https`, `dev:mock`), and starting the wrong one
 * is worse than starting none - so an ambiguous answer is reported rather than guessed at,
 * by the caller, off the length of this list. `dev` sorts first because it is the one a
 * person means when they say "the dev server".
 */
export function scriptsForTool(scripts: Record<string, string>, tool: string): string[] {
  const hits = Object.entries(scripts)
    .filter(([name, body]) => SCRIPT_NAME.test(name) && DEV_SCRIPT.test(name) && typeof body === 'string')
    .filter(([, body]) => new RegExp(`(^|[\\s/\\\\"'])${tool}([\\s"']|$)`).test(body))
    .map(([name]) => name)
  return hits.sort((a, b) => (a === 'dev' ? -1 : b === 'dev' ? 1 : a.length - b.length || a.localeCompare(b)))
}

/** One dev server, as the far end will be asked to start it. */
export interface DevServer {
  /** a package.json script name, validated on both ends */
  script: string
  /** what was seen running, for the line the pane's report prints */
  seen: string
}

/**
 * The scripts to restart over there, from what was observed here.
 *
 * `scripts` is the pane repo's own package.json. A tool with no matching script, or with
 * more than one, is dropped and named in `notes` - a handoff that quietly started the
 * wrong server is the failure this whole file is trying not to be.
 */
export function devPlan(
  cmdlines: string[],
  scripts: Record<string, string>
): { servers: DevServer[]; notes: string[] } {
  const servers: DevServer[] = []
  const notes: string[] = []
  const taken = new Set<string>()
  const missed = new Set<string>()

  for (const line of cmdlines) {
    const sig = devSignalOf(line)
    if (!sig) continue
    let script = ''
    if (sig.kind === 'script') {
      // Trust it only if the receiving repo really has it: the sender's title is a claim
      // about a script, and the far end is the only place that knows whether it exists.
      script = typeof scripts[sig.script] === 'string' ? sig.script : ''
      if (!script) missed.add(`${sig.script} (no such script in package.json)`)
    } else {
      const hits = scriptsForTool(scripts, sig.tool)
      if (hits.length === 1 || (hits.length > 1 && hits[0] === 'dev')) script = hits[0]
      else if (!hits.length) missed.add(`${sig.tool} (no script runs it)`)
      else missed.add(`${sig.tool} (${hits.length} scripts could be it: ${hits.join(', ')})`)
    }
    if (!script || taken.has(script)) continue
    taken.add(script)
    servers.push({ script, seen: line.length > 120 ? line.slice(0, 117) + '...' : line })
  }
  for (const m of missed) notes.push(`Dev server not restarted - ${m}`)
  return { servers, notes }
}

/** The manager to run a script with, from whichever lockfile the receiving repo has. */
export function managerFor(lockfiles: string[]): Manager {
  const has = (f: string): boolean => lockfiles.some((l) => l.toLowerCase() === f)
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('bun.lockb') || has('bun.lock')) return 'bun'
  if (has('yarn.lock')) return 'yarn'
  return 'npm'
}

/**
 * The command, as argv - never a string, and never through a shell.
 *
 * Refuses a script name that does not match `SCRIPT_NAME` even though the sender checked:
 * the sender is the other machine, and a check made there is a claim rather than a fact.
 */
export function devCommand(manager: Manager, script: string): string[] | null {
  if (!SCRIPT_NAME.test(script)) return null
  return [manager, 'run', script]
}
