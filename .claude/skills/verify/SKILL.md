---
name: verify
description: Prove a PaneForge change works in the installed PaneForge app Robert actually uses (/Applications/PaneForge.app), not just tests or typecheck. Use before saying fixed, done, working or live.
---

# Verify a PaneForge change

## 1. What Robert runs
The installed app `/Applications/PaneForge.app` (dev releases arrive via the in-app updater). Your own chat is hosted inside it.

Which build is running (each command was run and works):
```
plutil -p /Applications/PaneForge.app/Contents/Info.plist | grep CFBundleShortVersionString
git -C <repo> describe --tags --always          # e.g. v0.8.230-19-gca6c0a7a = 19 commits past the tag
git -C <repo> merge-base --is-ancestor <fix-sha> v<installed-version> && echo IN_BUILD || echo NOT_IN_BUILD
npm run unreleased                              # what the installed build lacks, in plain words (read only)
```
The installed version has no commit hash. A fix is live only if its commit is an ancestor of the installed version's tag. Otherwise the verdict is "not live" (fixed on master or in a lane, not in the app). Never PASS on a dev copy, `npm test` or typecheck alone.

## 2. Attach or start
Never start, quit or reinstall the installed app. Reach it with the CLI:
```
pf list          # number, id, state, name, folder; states: starting, working, idle, exited
pf help <cmd>    # confirm a flag before using it; exit code 2 = PaneForge not running
```
Ready = `pf list` prints rows. For a layout check on a NEW build use a separate copy (AGENTS.md "Checking a layout change without screenshots"):
```
npm run build
npm run try -- --headless --remote-debugging-port=9444     # not 9333
node scripts/ui-lab.mjs eval "<js>"
node scripts/ui-lab.mjs shot --out /tmp/x.png --selector .dialog --width 1280 --height 560
npm run try -- --close
```
That proves the copy, not what Robert runs. Say so, and compare with section 1.

## 3. Drive it, by change type
- UI or visual: `ui-lab.mjs shot` plus an `eval` that reads sizes or colours from the DOM; state the numbers. Same answer before and after = nothing rebuilt. Installed app: `pf reload` redraws only, panes keep running.
- Stateful or timing (session closing, naming, presence): trigger the event on a pane you opened, wait the time it takes (read the wait in the code, for example the done-close wait), then read `pf list` again and quote the row.
- Data or API: read only, `pf call <channel> <json>` (see `pf help call`); read the body, not just the exit code.
- Background job or watcher: read its own output file or log and compare to what `pf list` shows now.

## 4. Regression sweep
Run the rows that touch the area you changed.

| Behaviour that broke before | Proof |
|---|---|
| Session cards too big or text wraps (2026-09-23) | `ui-lab.mjs shot` of the card, state its height and width in px |
| Finished sessions close themselves (2026-09-23, 09-28) | `pf list`: a done chat leaves the list (or goes to Review) after the done-close wait; `pf tidy --dry-run` lists nothing finished |
| Session naming reflects the work (2026-09-19) | `pf list` name column reads as the task, not broken words |
| Copying multi-line text or a link keeps lines joined (2026-09-17, 09-19) | `npm run test:copymode`, then copy from the installed app into a scratch file and read it back |
| Discord presence counts every running session (2026-09-27) | Presence shows the same count as `pf list` rows in working or idle (both machines) |
| Remote session view of a PC pane works after a restart (2026-09-23) | `pf devices` shows the PC online, `pf list` shows its `@...` rows |
| Version behind (2026-09-18, 09-22) | Section 1 commands; the installed tag must contain your fix |

## 5. Safety
- This app hosts your chat. Never quit, restart, kill or reinstall PaneForge; no `npm run setup`, installer or `pkill`.
- Never `pf close`, `pf tell` or `pf type` a pane you did not open. Reads only (`list`, `composer`, `devices`, `tidy --dry-run`).
- No `npm run ship`, `release` or dev release unless Robert asked for one in this chat (AGENTS.md).
- Headless copies only; never take the screen. Use a separate `PF_PORT` for a second copy.

## 6. Verdict
Per claim write PASS or FAIL with the output line or screenshot path that proves it. Not in the installed build = FAIL "not live", naming the fix sha and the installed tag. Cannot drive it here = "changed but unverified" plus the command that would prove it.
