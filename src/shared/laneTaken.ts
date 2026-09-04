/**
 * Which folders already have a pane in them, for the purpose of putting a NEW pane
 * somewhere else. Read by `laneFor` in `main/index.ts` before a lane is picked.
 *
 * A pane that exited is a run that ended: its folder is free. A pane that is ASLEEP
 * also wears `status: 'exited'` (see `Session.asleep`), and it is not free at all - it
 * is one press from being an agent in that folder again. Two client chats restored
 * asleep into `clients` and a third opened from History landed beside them because
 * neither counted (2026-09-04); all three woke into one checkout.
 */
export function takenFolders(
  sessions: ReadonlyArray<{ id?: string; cwd: string; status: string; asleep?: number }>,
  except?: string
): string[] {
  return sessions
    .filter((s) => s.status !== 'exited' || Boolean(s.asleep))
    .filter((s) => !except || s.id !== except)
    .map((s) => s.cwd)
}

/**
 * Whether a pane about to WAKE has to be moved first.
 *
 * A sleeping pane holds its folder (above), but only against panes opened later. Two
 * client panes restored asleep into `clients` on the same restore both held it, and the
 * second one to wake spawned its agent beside the first (2026-09-04, sessions 1 and 3
 * both "clients main"). So a wake asks the same question a new pane does - is anyone
 * else in this folder - and the pane itself is left out of the answer, or it would
 * always clash with its own sleeping self.
 */
export function wakeClashes(
  sessions: ReadonlyArray<{ id?: string; cwd: string; status: string; asleep?: number }>,
  id: string,
  cwd: string,
  same: (a: string, b: string) => boolean = (a, b) => a === b
): boolean {
  return takenFolders(sessions, id).some((t) => same(t, cwd))
}
