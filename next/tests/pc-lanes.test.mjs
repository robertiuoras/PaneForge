import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { startPcCodeTurn } from '../server/pc-lanes.mjs'

function capturedTurn () {
  let script
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = value => { script = Buffer.from(value, 'base64').toString('utf8') }
  const turn = startPcCodeTurn({ checkout: 'C:\\fixture', provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', text: 'Test fixture', spawnFn: () => child })
  return { child, turn, script }
}

test('a reset cannot be reported as completed PC work', async () => {
  const { child, turn } = capturedTurn()
  const rejected = assert.rejects(turn.done, error => error.uncertain === true && /Connection reset/.test(error.message))
  child.stderr.emit('data', 'Connection reset by peer')
  child.emit('close', 255)
  await rejected
})

// Execute the actual generated wrapper on Windows, with only Task Scheduler
// replaced by fixtures. No real tasks or provider processes are launched.
for (const outcome of ['completed', 'interrupted']) {
  test(`Windows wrapper retains ${outcome} worker evidence`, { skip: process.platform !== 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'next-worker-evidence-'))
    const { child, turn, script } = capturedTurn()
    const rejected = assert.rejects(turn.done)
    child.emit('close', 255); await rejected
    try {
      const fixture = [
        'function New-ScheduledTaskAction {}',
        'function New-ScheduledTaskPrincipal {}',
        'function New-ScheduledTaskSettingsSet {}',
        'function Register-ScheduledTask {}',
        "function Unregister-ScheduledTask { Set-Content -LiteralPath (Join-Path $job 'unregistered.txt') -Value 'yes' }",
        `function Start-ScheduledTask { Set-Content -LiteralPath (Join-Path $job 'stdout.log') -Value 'retained output'; Set-Content -LiteralPath (Join-Path $job 'stderr.log') -Value 'retained diagnostic'; ${outcome === 'completed' ? "Set-Content -LiteralPath (Join-Path $job 'exit.txt') -Value 0" : "throw 'fixture transport interruption'"} }`,
        script
      ].join('\n')
      const path = join(dir, 'fixture.ps1'); writeFileSync(path, fixture)
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path], { env: { ...process.env, LOCALAPPDATA: dir }, encoding: 'utf8', timeout: 15000 })
      assert.equal(result.error, undefined)
      assert.equal(result.status, outcome === 'completed' ? 0 : 1, result.stderr)
      const jobs = join(dir, 'PaneForgeNext', 'code-turns')
      const entries = readdirSync(jobs); assert.equal(entries.length, 1)
      const job = join(jobs, entries[0])
      assert.match(readFileSync(join(job, 'stdout.log'), 'utf8'), /retained output/)
      assert.match(readFileSync(join(job, 'stderr.log'), 'utf8'), /retained diagnostic/)
      assert.ok(existsSync(join(job, 'run.ps1')))
      assert.equal(existsSync(join(job, 'unregistered.txt')), outcome === 'completed')
      assert.equal(existsSync(join(job, 'exit.txt')), outcome === 'completed')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
