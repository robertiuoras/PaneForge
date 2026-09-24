/**
 * Puts `pf` where every pane can run it, and says where. Rules and why: `shared/pfAccess.ts`.
 */
import { app } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasOwnCodexInstructions, pfShimFiles, primerArgs, withPfOnPath } from '../shared/pfAccess'
import { which } from './which'

let binDir: string | null = null

/**
 * Write the shims into `<userData>/bin`. Rewritten only when the content differs (a moved
 * app, a Node installed since), so an ordinary start touches nothing. Never throws: a pane
 * without `pf` is worse than one with it, not a reason to fail the launch.
 */
export function installPf(): string | null {
  try {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    const script = join(base, 'scripts', 'pf-ctl.mjs')
    if (!existsSync(script)) {
      console.warn(`pf: ${script} is missing - panes get no pf command`)
      return null
    }
    const dir = join(app.getPath('userData'), 'bin')
    mkdirSync(dir, { recursive: true })
    const node = which('node')
    for (const f of pfShimFiles(process.platform, node !== 'node' ? node : null, process.execPath, script, dir)) {
      const file = join(dir, f.name)
      let had = ''
      try {
        had = readFileSync(file, 'utf8')
      } catch {
        /* first start */
      }
      if (had !== f.body) writeFileSync(file, f.body)
      if (f.exec && process.platform !== 'win32') chmodSync(file, 0o755)
    }
    binDir = dir
    return dir
  } catch (e) {
    console.warn(`pf: shims not written - ${(e as Error).message}`)
    return null
  }
}

/** The pane's env with `pf` reachable and pointed at THIS app's settings (a try copy's own). */
export function pfEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!binDir) return env
  return { ...withPfOnPath(env, binDir, process.platform), PF_USER_DATA: app.getPath('userData') }
}

/** The primer argv for this agent, honouring a Codex user's own developer_instructions. */
export function pfPrimerArgs(agentId: string): string[] {
  if (!binDir) return []
  let own = false
  if (agentId === 'codex') {
    try {
      own = hasOwnCodexInstructions(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8'))
    } catch {
      /* no config.toml: nothing of theirs to replace */
    }
  }
  return primerArgs(agentId, own)
}
