# Brief: PC sessions in the Mac's sessions list open straight away, carry a number, and close

Robert, 2026-09-23, verbatim: "i dont think we need watch button on remote sessison its just
extra step and takes longer to view right? and says closes now but its not closing? and also
they dont even have a number on them which is bad u need to fix them and close as well."

Context: a PC session in the Mac's list is a "listed" row (`listedRow` in
`src/renderer/src/App.tsx`, `openListed` just above it). Pressing it asks the PC to start
mirroring (`api.watchRemote`), waits for the mirror, and only then shows it. That wait is the
extra step. The hover word "watch" was already removed in 36d23570. Listed rows have no
number and no close button by design (PaneForge `CLAUDE.md` "The sessions list is the whole
desk"). Robert has now reversed that design. The Mac's saved peer has `mirrorAll: false` and
`watch: ['s4-mudnoloy']` (`~/Library/Application Support/claude-orchestrator/config.json`).
`mirrorAll` lives in `src/main/remote/client.ts` ~163-178 and `src/main/remote/index.ts` ~729.

## Task

1. **No extra step:** a PC session shows its screen as soon as it is pressed. The likely route
   is mirroring every PC pane by default (`mirrorAll` on for a paired peer, including peers
   saved before this change), so each one is already a normal card. Measure what that costs
   first (bytes/sec over the link, renderer memory per mirrored pane, with 3+ PC panes). If it
   is too expensive, pre-warm the mirror on hover/listing instead, and put the numbers in the
   commit message either way.
2. **A number on every row:** PC sessions get pane numbers like local ones (Ctrl+N works).
   Update `gridRoom`/`gridPick` and CLAUDE.md's sessions-list section.
3. **Close works:** a PC row gets the same close button as a local card. It closes the pane
   ON THE PC (`Remote.closeOn`, `CLOSE_ACK_MS`), and the row leaves both lists.
4. **"closes now" that never closes:** a PC row shows the PC's forwarded idle-close countdown
   (`CloseClock` with `row.closingAt`, `src/main/remote/index.ts` ~445) that reaches "now" and
   the pane stays. Reproduce with a red-capable test first (`superpowers:systematic-debugging`):
   find whether the PC's close is refused (a mirror watching it may count as "on screen" or
   "watched" and block the close), or whether the forwarded `closingAt` is simply stale. Fix
   the cause. A countdown must never read "now" for a close that is not going to happen.

## Constraints

- Follow PaneForge `CLAUDE.md`: work only in your lane, never close the installed app, prove
  in a copy (`npm run try -- --headless --remote-debugging-port=9444` + `scripts/ui-lab.mjs`),
  `npm run typecheck` + `npm test` before a commit, NO release without Robert's word.
- The Mac is short on memory: run heavy commands through
  `node ~/.claude/rbuild.mjs --session <id> --repo <dir> -- <cmd>`, one command per call.
- Screen words for a non-coder: no "mirror", "listed", "peer" on screen.

## Done means

- Pressing a PC session shows its screen with no wait for a mirror (measured: time from press
  to first painted frame, before vs after).
- Every PC row has a number and a working close that ends the pane on the PC.
- A countdown on a PC row either closes the pane when it reaches zero, or is not drawn.
- `npm run typecheck`, `npm test` and the touched `test:*` suites pass. Merged via
  `node scripts/lane.mjs ready`, no release.
