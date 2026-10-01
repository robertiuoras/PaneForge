// The bookkeeping for the two `caffeinate` children (`-i` keeps the system up, `-d` the
// screen). No electron import and an injectable spawn, so a test can drive a stop + start
// with a LATE 'exit' from the old child - the sequence that leaked 21 live `caffeinate -i`
// processes under one PaneForge on 2026-10-01 (measured 5:23pm, all `-w <main pid>`,
// started 15-50 min apart): `kill()` cleared the slot, a new child took it, then the OLD
// child's async 'exit' handler cleared the slot again - wiping the NEW reference, so the
// next tick spawned a third and the untracked one was never killed.

export type HoldKind = 'system' | 'display'

/** The part of a ChildProcess this needs. */
export interface HoldProc {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean | void
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'exit', cb: (code: number | null) => void): unknown
}

export class CaffeinateHolds {
  private slots: Record<HoldKind, HoldProc | null> = { system: null, display: null }

  constructor(
    private readonly spawnProc: (flag: string, watchPid: number) => HoldProc,
    private readonly watchPid: number,
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** How many are tracked right now (0-2). */
  tracked(): number {
    return (this.slots.system ? 1 : 0) + (this.slots.display ? 1 : 0)
  }

  has(which: HoldKind): boolean {
    return this.slots[which] !== null
  }

  start(which: HoldKind): void {
    if (this.slots[which] !== null) return
    const flag = which === 'system' ? '-i' : '-d'
    try {
      const proc = this.spawnProc(flag, this.watchPid)
      this.slots[which] = proc
      this.log(`caffeinate ${which} started PID ${proc.pid}`)
      // Only the child that is STILL the tracked one may empty the slot. An older child
      // exiting late has no say over a newer one.
      proc.on('error', (err) => {
        this.log(`caffeinate ${which} PID ${proc.pid} error: ${err.message}`)
        if (this.slots[which] === proc) this.slots[which] = null
      })
      proc.on('exit', (code) => {
        this.log(`caffeinate ${which} PID ${proc.pid} exited with code ${code}`)
        if (this.slots[which] === proc) this.slots[which] = null
      })
    } catch (e) {
      this.log(`caffeinate ${which} spawn failed: ${e}`)
    }
  }

  stop(which: HoldKind): void {
    const proc = this.slots[which]
    if (!proc) return
    try {
      this.log(`caffeinate ${which} PID ${proc.pid} stopping`)
      proc.kill('SIGTERM')
    } catch {
      // ignore
    }
    this.slots[which] = null
  }

  stopAll(): void {
    this.stop('system')
    this.stop('display')
  }
}
