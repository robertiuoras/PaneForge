/**
 * Starting the viewer that shows the other machine's screen. Decision in
 * src/shared/screenView.ts; this file is the part that touches the disk and a process.
 *
 * One viewer at a time: a second `moonlight stream` while the first is up asks Sunshine
 * for a second session, which it refuses with its own dialog. So a press while the child
 * we started is still alive is logged and does nothing more - the window it opened is
 * the answer to the press.
 */

import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLog } from './logWrite'
import { moonlightCandidates, screenPlan, screenTitle, type ScreenPeer, type ScreenPlan } from '../shared/screenView'

const MAX_BYTES = 512 * 1024

export function screenLogPath(): string {
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'screen-view.log')
}

function log(line: string): void {
  appendLog(screenLogPath(), `[${new Date().toISOString()}] ${line}\n`, { rotateAt: MAX_BYTES })
}

/** The first Moonlight that exists on this machine, or null: the button is not drawn then. */
export function viewerPath(): string | null {
  return moonlightCandidates(process.platform, process.env).find((p) => existsSync(p)) ?? null
}

let child: ChildProcess | null = null

/** What the sidebar asks before drawing the button. */
export function screenCan(peers: ScreenPeer[]): { ok: boolean; title: string } {
  const plan = screenPlan(viewerPath(), peers)
  return { ok: plan.ok, title: plan.ok ? screenTitle(peers) : plan.message }
}

/** Start the viewer. Returns the plan so the caller can toast a refusal in its words. */
export function openScreen(peers: ScreenPeer[]): ScreenPlan {
  const viewer = viewerPath()
  const plan = screenPlan(viewer, peers)
  if (!plan.ok) {
    log(`refused: ${plan.reason} - ${plan.message}`)
    return plan
  }
  if (child && child.exitCode === null && !child.killed) {
    log(`already open: pid ${child.pid} for ${plan.peer.name}`)
    return plan
  }
  try {
    // Detached and unreferenced: the viewer is the person's window now, and closing
    // PaneForge must not take it with it. `windowsHide` keeps the console PaneForge would
    // otherwise flash on the PC.
    const proc = spawn(viewer as string, plan.args, { detached: true, stdio: 'ignore', windowsHide: true })
    proc.on('exit', (code) => {
      log(`viewer exited ${code ?? 'by signal'} (${plan.peer.name})`)
      if (child === proc) child = null
    })
    proc.on('error', (err) => {
      log(`viewer failed to start: ${err.message}`)
      if (child === proc) child = null
    })
    proc.unref()
    child = proc
    log(`started ${viewer} ${plan.args.join(' ')} -> ${plan.peer.name} pid ${proc.pid}`)
  } catch (err) {
    log(`spawn threw: ${(err as Error).message}`)
    return { ok: false, reason: 'no-viewer', message: 'Moonlight could not be started.' }
  }
  return plan
}
