// The sweep that wakes queued/pressure-slept panes when the machine has room, and the
// gate that turns a pane created past capacity into a `queued` sleeper instead of a
// spawned CLI. See `shared/wakePlan.ts` for the arithmetic.
export interface WakeQueueDeps {
  /** Panes on this desk, live reading. */
  list: () => Array<{ id: string; asleep?: number; asleepReason?: string; createdAt: number }>
  wake: (id: string) => void
  pressure: () => 'normal' | 'warn' | 'critical'
}
export function startWakeQueue(_deps: WakeQueueDeps): { stop(): void } {
  return { stop() {} }
}
