// An update that cannot leave somebody stuck on the old version (`src/shared/installWedge.ts`,
// `build/installer.nsh` freeInstallDir, `scripts/win-free-install-dir.ps1`).
//
// 2026-09-24: a friend on v0.8.179 pressed Restart now, came back on v0.8.179, and the card
// asked for the same restart again. Pinned here:
// - a relaunch older than the version it tried to install is named as a failed install;
// - the installer link is that exact version's, for the right computer;
// - the wait for the panes' processes ends when they do, and gives up at its budget;
// - the installer really runs the folder-freeing script before anything else;
// - on Windows, the script stops a program running out of the install folder (a path with a
//   space and an apostrophe) and leaves one running from anywhere else alone.
import { spawn, execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'install-wedge.mjs')
buildSync({ entryPoints: [join(ROOT, 'src/shared/installWedge.ts')], outfile, bundle: true, format: 'esm', platform: 'node' })
const W = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function ok(cond, what, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${what}`)
  } else {
    fail++
    console.log(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
  }
}

// ---- a relaunch on the old version is a failed install ------------------------------------
ok(W.failedInstall({ version: '0.8.225', tries: 1 }, '0.8.179') === '0.8.225', 'came back older than the attempt: failed')
ok(W.failedInstall({ version: '0.8.225', tries: 1 }, '0.8.225') === null, 'came back as the attempt: installed')
ok(W.failedInstall({ version: '0.8.225', tries: 1 }, '0.8.226') === null, 'came back newer: installed')
ok(W.failedInstall(null, '0.8.179') === null, 'no attempt on record: nothing to say')
ok(W.failedInstall({ version: '0.8.10', tries: 1 }, '0.8.9') === '0.8.10', 'versions compare as numbers, not text')

// ---- the way out is that version's installer ----------------------------------------------
ok(
  W.installerUrl('0.8.225', 'win32') === 'https://github.com/robertiuoras/PaneForge/releases/download/v0.8.225/PaneForge-Setup.exe',
  'Windows gets the setup program of that exact version'
)
ok(
  W.installerUrl('v0.8.225', 'darwin') === 'https://github.com/robertiuoras/PaneForge/releases/download/v0.8.225/PaneForge-arm64.dmg',
  'a Mac gets the disk image, and a leading v is not doubled'
)
const words = W.installFailedWords('0.8.179', '0.8.225', 'win32')
ok(/0\.8\.225/.test(words) && /0\.8\.179/.test(words) && /Try again/.test(words) && /installer/.test(words), 'the card names both versions and both ways out', words)
ok(!/\b(lane|checkout|worktree|NSIS|pty|process|exe|ConPTY)\b/i.test(words), 'in words somebody who never used a terminal reads', words)
ok(/drag it over/.test(W.installFailedWords('0.8.179', '0.8.225', 'darwin')), 'a Mac is told to drag the app over the old one')

// ---- waiting for the panes' processes -----------------------------------------------------
{
  let t = 0
  const clock = { now: () => t, sleep: async (ms) => void (t += ms) }
  const gone = new Set()
  const r = await W.waitForExit([11, 12], {
    alive: (p) => !gone.has(p),
    budgetMs: 5000,
    pollMs: 100,
    ...clock,
    sleep: async (ms) => {
      t += ms
      if (t >= 300) gone.add(11)
      if (t >= 700) gone.add(12)
    }
  })
  ok(r.left.length === 0 && r.ms === 700, 'returns as soon as the last one exits', JSON.stringify(r))
  t = 0
  const stuck = await W.waitForExit([21, 22], { alive: (p) => p === 22, budgetMs: 1000, pollMs: 100, ...clock })
  ok(stuck.left.length === 1 && stuck.left[0] === 22 && stuck.ms >= 1000 && stuck.ms < 1200, 'gives up at its budget and names what is left', JSON.stringify(stuck))
  t = 0
  const none = await W.waitForExit([], { alive: () => true, budgetMs: 1000, ...clock })
  ok(none.left.length === 0 && none.ms === 0, 'nothing to wait for costs nothing')
}
const err = (code) => () => {
  const e = new Error(code)
  e.code = code
  throw e
}
ok(W.pidAlive(1, () => true) === true, 'a pid that answers is alive')
ok(W.pidAlive(1, err('ESRCH')) === false, 'ESRCH: gone')
ok(W.pidAlive(1, err('EPERM')) === true, "EPERM: somebody else's, still running")
ok(W.pidAlive(process.pid) === true && W.pidAlive(2 ** 22 + 7) === false, 'the real check: this process alive, an unused pid not')

// ---- the installer runs the script, before anything else ----------------------------------
// `build/` may be missing from a copy of the tree shipped elsewhere (see winshortcut-test).
const nshPath = join(ROOT, 'build', 'installer.nsh')
const ps1 = join(ROOT, 'scripts', 'win-free-install-dir.ps1')
ok(existsSync(ps1), 'the folder-freeing script is in the tree')
if (!existsSync(nshPath)) {
  console.log('  skip build/installer.nsh is not in this copy of the tree - installer wiring unchecked')
} else {
  const nsh = readFileSync(nshPath, 'utf8')
  const init = /!macro customInit\r?\n([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? ''
  const steps = [...init.matchAll(/!insertmacro (\w+)/g)].map((m) => m[1])
  ok(steps[0] === 'killRunning' && steps[1] === 'freeInstallDir', 'customInit stops PaneForge, then frees the folder, before anything else', steps.join(','))
  const body = /!macro freeInstallDir\r?\n([\s\S]*?)!macroend/.exec(nsh)?.[1] ?? ''
  const code = body.replace(/^\s*;.*$/gm, '')
  ok(/File "\/oname=\$PLUGINSDIR\\pf-free-install-dir\.ps1" "\$\{PROJECT_DIR\}\\scripts\\win-free-install-dir\.ps1"/.test(code), 'the installer carries the script from scripts/')
  ok(/-File "\$PLUGINSDIR\\pf-free-install-dir\.ps1" -Dir "\$INSTDIR"/.test(code), 'and runs it on the install folder', code.trim())
  ok(/InitPluginsDir/.test(code) && /Pop \$0/.test(code), 'with its temp folder made first and the exit code taken off the stack')
}

// ---- Windows: the script stops what runs from the folder, and nothing else ----------------
if (process.platform !== 'win32') {
  console.log('  skip the script run itself needs Windows (runs on the PC)')
} else {
  const work = mkdtempSync(join(tmpdir(), 'pf-wedge-'))
  const inst = join(work, "Paul's Programs", 'claude-orchestrator')
  mkdirSync(join(inst, 'resources'), { recursive: true })
  const held = join(inst, 'resources', 'pf-hold.exe')
  copyFileSync(process.execPath, held)
  const idle = ['-e', 'setTimeout(() => {}, 120000)']
  const inside = spawn(held, idle, { stdio: 'ignore', windowsHide: true })
  const outside = spawn(process.execPath, idle, { stdio: 'ignore', windowsHide: true })
  await new Promise((r) => setTimeout(r, 1500))
  ok(W.pidAlive(inside.pid) && W.pidAlive(outside.pid), 'both programs are running before the script')
  const started = Date.now()
  const run = await new Promise((res) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Dir', inst, '-Also', join(work, 'no-such-folder'), '-Seconds', '10'],
      { windowsHide: true, timeout: 60_000 },
      (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, out: `${stdout}${stderr}` })
    )
  )
  const took = Date.now() - started
  ok(run.code === 0, 'the script reports the folder free', `exit ${run.code}: ${run.out.trim().slice(0, 300)}`)
  ok(!W.pidAlive(inside.pid), 'the program running out of the install folder is stopped')
  ok(W.pidAlive(outside.pid), 'a program running from anywhere else is left alone')
  ok(took < 15_000, `and it finished inside its budget (${took}ms)`)
  outside.kill()
  inside.kill()
  await new Promise((r) => setTimeout(r, 500))
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* a temp folder Windows is still letting go of */
  }
}

console.log(fail ? `\ninstall-wedge-test: ${fail} of ${pass + fail} failed` : `\ninstall-wedge-test: ${pass} checks passed`)
process.exit(fail ? 1 : 0)
