# Codex footer damaged after automatic history replay

Display repair commit: `31671a1ae8cfa8b1d3bb1184b4eaf6bffb683fb4`.
Installed host inspected: 0.8.232, PID 20879. It was never restarted or reset.

The current report includes missing footer characters and composer shading. Guarded observation of pane 7 showed advancing output and a moving working indicator, so this observation does not establish a frozen native agent. Pane 9 showed a completed reply with an intact footer. A reopened pane 11 also showed missing footer characters while output advanced.

## Concrete recovery gap

Capacity regrowth calls `paneRedraw` to restore scrollback. That invokes ordered `sessions:replay` / `pane:reset`. In the installed renderer, noninitial resets parse the snapshot without requesting a native complete frame afterward. The existing initial-restore recovery does request one. Incremental TUI tails cannot reconstruct unchanged cells when their base frame is absent.

The installed `fix.log` records standalone history redraws for the affected pane at 09:14:27.685Z, 09:57:41.061Z, 10:08:48.051Z, 10:21:13.994Z, 10:27:20.516Z, 10:33:05.414Z, and 10:47:59.675Z on September 30. These have `restoreFixes: 0` and no paired native repair. Other panes have redraws at the same times, consistent with the shared capacity path. Manual repair/redraw pairs at 10:18:18Z and 10:41:35Z are distinguishable. The `why: pressed` default alone does not identify a manual action.

Saved history also stops accepting bytes once its 8 MiB ceiling is exceeded. Its old prefix was preferred over the advancing 400 KB live buffer. The inspected affected log was 8,393,494 bytes. A complete replay at the recorded 134-column width retained its old footer; the clipped live tail contained no complete clear/home frame or footer labels. Joining disjoint streams can still miss cursor state. Tail replay alone cannot establish a renderer/texture failure or prove the original live terminal's cells.

## Repair and checks

The commit joins exact overlapping saved/live bytes once, preserves both disjoint streams, and cancels an unfinished escape before a disjoint tail. It does not delete or rewrite stored history. A completed noninitial reset now schedules the existing settled native redraw, including its visibility, sleep, reader-intent, auto-fix and five-second deadline rules. No periodic watchdog was added.

PC typecheck and freshreplay, remotereset, mirrorrepair, restorereader, restorestream, shrinkfirst and trimloss passed. The initial broad run passed 288/289 suites; trimloss's old source-routing assertion was then corrected and passed independently. Final display build job `0fae4e27-eecc-4482-966e-072446de61bb` passed. Its display source hashes matched the commit and all 18 downloaded runtime files matched the PC output hashes.

An isolated, minimized, non-headless Mac test copy ran this exact display build, profile `display-recovery-20260930`, port 9477, PID 97570. Its synthetic PTY paints a complete footer on SIGWINCH. Calling the same history-redraw handle used by capacity recovery produced footer `19`, pending recovery and zero repairs. At 11:03:19.491Z, the existing automatic repair ran after 1,280 ms quiet. The footer became `CURRENT STATUS | working | complete footer`, the composer band returned to RGB 40,60,80, pending cleared, and the repair count became one. No manual Fix was called.

Runtime receipt: `/tmp/pf-display-runtime-receipt-20260930.json`.
Build hash receipt: `/tmp/pf-display-candidate-build-receipt-20260930.json`.
Observed recovered pixels: `/tmp/pf-display-candidate-recovered-20260930.png`.

## Limits

The runtime harness's later history-preservation assertion failed because its synthetic replacement of a live test log raced queued history writes. This is not an app preservation finding. The scoped automatic-reset repaint was observed, but an actual 8 MiB cap end-to-end run was not verified. Unit checks cover overlap, disjoint streams, mode preservation, and recovery routing.

The installed user's panes were not repaired by this worker. Installation and acceptance in those panes remain the release owner's gate. Later receipt-scan commit `91855c72` was not in this display runtime artifact; the combined release build needs its own proof. The test's synthetic shell and owned copy were closed, and its GuardDeck batch released. No headless mode, agent account request, peer copy restart, or installed host restart was used.
