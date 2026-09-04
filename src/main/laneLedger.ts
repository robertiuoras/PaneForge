// The lane LEDGER (`scripts/lane.mjs`, `<repo>/.git/paneforge-lanes.json`) seen from the
// app, for the two moments a pane's agent is not running but the pane is not gone:
// sleeping and waking.
//
// Contract (lane-split 2026-09-04, workstream "sleep keeps its lane"):
//   ledgerSleep(cwd, paneId)  - before the CLI is killed for a sleep: the hold this pane's
//                               chat has in the repo owning `cwd` is marked `asleep`, so
//                               the CLI's own SessionEnd hook parks it instead of releasing
//                               it, and the idle sweep leaves it alone.
//   ledgerWake(cwd, paneId)   - after the CLI is spawned again: the mark comes off.
//   ledgerTakenFolders(paneId) - folders the ledger says ANOTHER chat holds right now,
//                               handed to `laneFor` as extra taken folders on wake, so a
//                               pane never wakes into a checkout somebody else took.
// All three are best-effort, synchronous-safe from main, and never throw.
export function ledgerSleep(_cwd: string, _paneId: string): void {}
export function ledgerWake(_cwd: string, _paneId: string): void {}
export function ledgerTakenFolders(_paneId: string): string[] {
  return []
}
