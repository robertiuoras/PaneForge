// The label on a pane's card: "PC 3", "Mac 3", or a bare "3".
//
// A card's number used to be its PLACE in this desk's list, and a paired desk counted the
// other machine's panes into the same sequence - so one chat was "3" on the Mac and "7" on
// the PC, and closing or dragging a pane renumbered the rest. Agents name chats by that
// number, so a mention from the other machine, or from a minute ago, named the wrong pane.
// Now the number belongs to the machine the pane RUNS on and never changes while it lives;
// every desk shows the owner's number, with the owner's name in front whenever another
// computer's panes are on the desk. Rules copied from PaneForge Next
// (`server/pane-numbers.mjs`, e094627). `node scripts/pane-numbers-test.mjs`.
//
// Pure: no electron or node imports, so the renderer draws with the same rules main stamps.

import type { RemotePeerState, Session } from './types'

export type Machine = 'mac' | 'pc'

/** A closed pane's number is not given to another pane for this long. */
export const HOLD_MS = 15 * 60 * 1000

export const MACHINE_NAME: Record<Machine, string> = { mac: 'Mac', pc: 'PC' }

/** The machine a `process.platform` string is. Same rule as `thisMachine()` in main. */
export function machineOf(platform: string): Machine {
  return platform === 'win32' ? 'pc' : 'mac'
}

const isNumber = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0

/** "PC 3" / "Mac 3"; null without a known machine and a positive whole number. */
export function labelFor(machine: Machine | null | undefined, n: number | null | undefined): string | null {
  return machine && MACHINE_NAME[machine] && isNumber(n) ? `${MACHINE_NAME[machine]} ${n}` : null
}

/** "PC 3", "pc3", "PC-3", " mac  12 " or a bare "3" -> its machine (null when bare) and number. */
export function parseLabel(ref: unknown): { machine: Machine | null; number: number } | null {
  const match = /^\s*(?:(mac|pc)[\s-]*)?(\d+)\s*$/i.exec(String(ref ?? ''))
  const number = match ? Number(match[2]) : 0
  return match && number > 0 ? { machine: match[1] ? (match[1].toLowerCase() as Machine) : null, number } : null
}

/**
 * Whether another computer's panes are on this desk: a mirrored pane, or a pane of an
 * online device that is listed and not mirrored. Read off the whole desk, never the
 * device filter, which is visual only.
 */
export function othersOnDesk(
  sessions: ReadonlyArray<Pick<Session, 'remote'>>,
  peers: ReadonlyArray<{ status: RemotePeerState['status']; panes: ReadonlyArray<{ watched: boolean }> }>
): boolean {
  return (
    sessions.some((s) => s.remote) ||
    peers.some((p) => p.status === 'online' && p.panes.some((pane) => !pane.watched))
  )
}

/** The fields a card's label is read from. A listed pane passes its `machine` as `remote.machine`. */
export interface LabelRow {
  number?: number
  remote?: { machine?: Machine }
}

/**
 * The words on a card. Another machine's pane always wears its owner's label ("Mac 3"), or
 * the machine name alone when the owner is an older PaneForge that sends no number. This
 * desk's own pane wears "PC 1" when another computer's panes are here, else a bare "1".
 */
export function cardLabel(row: LabelRow, desk: { machine: Machine; others: boolean }): string | null {
  if (row.remote) {
    const m = row.remote.machine
    if (!m || !MACHINE_NAME[m]) return null
    return labelFor(m, row.number) ?? MACHINE_NAME[m]
  }
  if (!isNumber(row.number)) return null
  return desk.others ? labelFor(desk.machine, row.number) : String(row.number)
}

/** The Ctrl/Cmd digit that switches to this pane: this desk's own panes numbered 1-9 only. */
export function switchKey(row: { number?: number; remote?: unknown }): number | null {
  return !row.remote && isNumber(row.number) && row.number <= 9 ? row.number : null
}

/** "runs on the Mac", for the tooltip of a card that has no switch key here. */
export function runsOnWords(machine: Machine | undefined): string {
  return machine && MACHINE_NAME[machine] ? `runs on the ${MACHINE_NAME[machine]}` : 'runs on another computer'
}

/**
 * Hands out card numbers on one machine. The lowest positive number no live pane holds
 * and no closed pane is resting on; a freed number rests `HOLD_MS` so a message about
 * "chat 3" cannot land in a new pane that just inherited 3. A pane coming back as itself
 * (desk restore after a restart) asks for its old number with `want` and gets it unless
 * a live pane holds it.
 */
export class PaneNumbers {
  private held = new Map<string, number>()
  /** number -> when it may be given to another pane */
  private resting = new Map<number, number>()

  constructor(private readonly now: () => number = Date.now) {}

  take(id: string, want?: number): number {
    const had = this.held.get(id)
    if (had !== undefined) return had
    const at = this.now()
    for (const [n, until] of this.resting) if (until <= at) this.resting.delete(n)
    const live = new Set(this.held.values())
    let n = 1
    if (isNumber(want) && !live.has(want)) n = want
    else while (live.has(n) || this.resting.has(n)) n++
    this.held.set(id, n)
    this.resting.delete(n)
    return n
  }

  release(id: string): void {
    const n = this.held.get(id)
    if (n === undefined) return
    this.held.delete(id)
    this.resting.set(n, this.now() + HOLD_MS)
  }

  /** Release every held id not in `live` - the net under a removal path that forgot to. */
  prune(live: Iterable<string>): void {
    const keep = new Set(live)
    for (const id of [...this.held.keys()]) if (!keep.has(id)) this.release(id)
  }

  /**
   * Hold `n` back from NEW panes for `HOLD_MS` - a saved desk's numbers, read before anybody
   * answers the restore offer. A restored pane asking for `n` still gets it.
   */
  reserve(n: number): void {
    if (isNumber(n)) this.resting.set(n, this.now() + HOLD_MS)
  }

  numberOf(id: string): number | undefined {
    return this.held.get(id)
  }
}
