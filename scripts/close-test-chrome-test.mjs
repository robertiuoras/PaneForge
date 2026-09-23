import { EventEmitter } from 'node:events'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestChrome } from './close-test-chrome.mjs'

// A real child can exit between `alive()` and `once('exit')`. The event has already
// happened, so the helper must notice the changed ChildProcess fields without waiting.
class ExitsWhileSubscribing extends EventEmitter {
  pid = 12345
  exitCode = null
  signalCode = null
  killSignal = null

  kill(signal) {
    this.killSignal = signal
  }

  once(event, listener) {
    const result = super.once(event, listener)
    if (event === 'exit') this.signalCode = 'SIGTERM'
    return result
  }
}

const profile = mkdtempSync(join(tmpdir(), 'pf-close-test-'))
const chrome = new ExitsWhileSubscribing()
const started = performance.now()

await closeTestChrome(chrome, profile)

const elapsed = performance.now() - started
if (chrome.killSignal !== 'SIGKILL') throw new Error(`cleanup used ${chrome.killSignal ?? 'no signal'}, not SIGKILL`)
if (elapsed > 1_000) throw new Error(`cleanup waited ${elapsed.toFixed(0)}ms after Chrome had exited`)
if (existsSync(profile)) throw new Error('cleanup left its owned Chrome profile behind')
console.log('close-test-chrome: catches an exit that happens while subscribing')

// A killed Chrome on the PC leaves the process table 34-58s after taskkill says SUCCESS
// (measured 2026-09-23). A 5s wait there failed every passing fit suite at teardown.
const { exitWaitMs } = await import('./close-test-chrome.mjs')
if (exitWaitMs('win32') < 60_000) throw new Error(`Windows waits ${exitWaitMs('win32')}ms, under the measured 58s exit`)
if (exitWaitMs('darwin') !== 5_000) throw new Error(`macOS wait changed to ${exitWaitMs('darwin')}ms`)
console.log('close-test-chrome: Windows waits past the measured 58s exit, macOS keeps 5s')
