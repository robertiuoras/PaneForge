# Brief: build v1 of the PC screen view (in-app stream, no Moonlight)

Robert, 2026-09-23, verbatim: "i meant when i clicked on desktop icon to view it in paneforge
it opens a smaller window wihtin this screen and i can go back to this cli if i want to, but
its all within paneforge not moonlight if possible, custom app we have more opportunities for
custom things"

## Task

Build v1 exactly as designed in `docs/superpowers/specs/2026-09-23-pc-screen-design.md`
(section "v1: the native stream"). Read that whole file first; its research section settles
the transport questions (Tailscale MTU 1280, mDNS host candidates, 30 fps cap, H.264 first,
`tscon` for a detached console). Do not re-research them.

What Robert's message changes or fixes in that design:

1. The existing desktop quick button (v0, `src/main/screenView.ts`,
   `src/shared/screenView.ts`, `screenCan` in `src/renderer/src/App.tsx` ~line 1202) must
   open the IN-APP view, not Moonlight. Moonlight stays only behind a `Take control` button
   inside the view (v0's command, unchanged).
2. The view is a smaller window INSIDE the PaneForge window, beside the panes: a pane in the
   grid (the design's assumption 2) is right. It must never take over the whole window
   unasked; the person can click back to any CLI pane at once. Focus view / fullscreen only
   on a press.
3. View-only is v1. Mouse/keyboard stays out of scope (design "Out of scope for v1").

## Scope

- In: signalling `Msg` kinds on the existing peer channel (`src/main/remote/`), hidden
  capture renderer on the source, `ScreenPane` sink with zoom (buttons, Cmd/Ctrl +/-/0,
  pinch, Cmd/Ctrl+wheel), quality footer from `getStats()`, locked/detached console card with
  `Wake the desktop`, the error table, `scripts/screen-stream-test.mjs` + `test:screenstream`,
  the `remote-test.mjs` wire round-trip, and the CLAUDE.md section "The other machine's
  screen is one click away" updated to say the button opens the in-app view.
- Out: input forwarding, audio, clipboard, multi-display, any new server, port, STUN/TURN or
  stored credential (those are Robert's call).

## Constraints

- Follow PaneForge `CLAUDE.md`: never close the installed app, work only in your lane, prove
  in a copy (`npm run try -- --headless --remote-debugging-port=9444`, `scripts/ui-lab.mjs`),
  `npm run typecheck` + `npm test` gate a commit, NO release (`npm run ship`) without Robert's
  word in that chat.
- Heavy commands go through the GuardDeck queue: `node ~/.claude/rbuild.mjs --session <id>
  --repo <dir> -- <cmd>`.
- The PC side (source) needs this build running there to prove the live stream: use
  `npm run try -- --pull --show` on the PC per CLAUDE.md "Dev-window test on both machines
  first"; never touch the PC's installed PaneForge.
- Screen words for a non-coder: title names the machine ("Gamer's screen"), never WebRTC,
  stream, ICE, codec.

## Done means

- Pressing the desktop quick button opens a PaneForge pane showing the PC's screen, sized
  like any other pane, with the CLI panes still one click away; no Moonlight window opens.
- Zoom in/out/fit and pinch work; the footer shows fps/kbps/rtt.
- Locked/detached PC shows the `Wake the desktop` card instead of black.
- `npm run typecheck`, `npm test`, `test:screenstream`, `test:screenview` pass; live Mac-sink /
  PC-source numbers (fps, kbps, rtt at 2560 wide, 30 s CPU both machines) in the commit
  message; merged to master via `node scripts/lane.mjs ready`, no release cut.
- If the live cross-machine proof cannot run (PC offline, pool exhausted), say "changed but
  unverified" and name exactly what would prove it.
