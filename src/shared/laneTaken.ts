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
  sessions: ReadonlyArray<{ cwd: string; status: string; asleep?: number }>
): string[] {
  return sessions.filter((s) => s.status !== 'exited' || Boolean(s.asleep)).map((s) => s.cwd)
}
