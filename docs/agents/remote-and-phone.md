# Two machines, sign-in requests, offload, the phone surface

Verbatim sections moved out of the repo's always-loaded instructions (`AGENTS.md`),
same headings as `docs/design-notes.md` (the why). Paths: `shared/` = `src/shared/`, `main/` =
`src/main/`. `test:x` = `npm run test:x`.

## Two machines, one desk

`src/main/remote/`, peers. No self-pair (`Remote.probe`, `start()`). Link pane gets
`PF_CHROME_CDP=http://<fromAddress>:9333` (`shared/peerChrome.ts`); Mac `tailscale serve --bg
--tcp 9333`; claude-config `browser/chrome-devtools-mcp.mjs`, `cdp-bg-tab.mjs`,
`chrome-automation.sh` probe it; `wrong-machine.mjs` queues via `remote:handoff`
(`test:peerchrome`). Pty never moves; id `@<device>/<id>`, `remote.owns(id)`.

- Borrow carries `Borrow.person` (`shared/paneSize.ts`); `watched` counts only those; absent =
  yes; `person` = at that desk NOW and that screen DRAWS the pane (`Remote.visibleOn`,
  `Remote.presenceChanged` on `away`). OWNER publishes `closingAt`.
- Mirror borrows size (`resize(borrowed)`, `returnSize(id)` never `returnSizes()`); smallest
  grid per axis; lease by 30s `pty:visible`, `BORROW_TTL_MS` 90s (`test:panesize`). Mirror
  font = `bestFont` over the cell the renderer REALLY draws (WebGL rounds to device px), cached
  per renderer + dpr; ask = that room at the user's font; `.xterm-screen` observed (renderer
  swap); `placeGrid` centres in the fit addon's box (`test:mirrorview`, `test:mirrorfit`).
- `Remote.closeOn` hides a closed row, `CLOSE_ACK_MS` 3s; `proveAlive` uses an unanswered press
  over `DEAD_MS` 45s. Mirror never reports busy footer.
- Pairing code proved never sent (scrypt, AES-256-GCM); hosting off; UDP discovery; or six
  X25519 digits. `PROTOCOL` 1 (`askpair` refused by older). `test:remote`, `test:pairask`.
- Peer jobs (`shared/backJobs.ts`, `main/backJobs.ts`, `jobs`/`jobslist`, `PeerJobs`): `agent`,
  `dev`, `loop` (`LOOP_MIN_SECONDS`); own tree excluded; `Remote.jobsOn` rejects when
  disconnected (`test:backjobs`).
- PC: plain `pf` on PATH (`~\.local\bin\pf.cmd`) is PaneForge Next's; PaneForge's own is
  `%APPDATA%\claude-orchestrator\bin\pf.cmd` (panes get it via env). Over ssh use that one.
- Handoff moves WORK not pty (`HandoffDialog.tsx`, `shared/handoff.ts`): repo as `auto-sync:`
  commit, conversation, screen, dev servers; mid-turn queued; sender closes on ack, becomes
  mirror; dirty/unpushed refused by name; paths grafted (`test:handoff`, `test:handofffit`).

## A job that cannot sign in: no card (switched off 2026-09-28)

The "<Site> needs you to sign in" card (`LoginCard.tsx`, `main/signIn.ts`, `shared/signIn.ts`,
`login:*` channels, the row's `sign in` chip, `test:signin`) was REMOVED 2026-09-28 in ONE
commit (`git log --grep "switch off the sign-in card"`), so `git revert <sha>` brings it back
when it is tuned. `pf needs-login` stays a word: `SWITCHED_OFF` in `pf-ctl.mjs` prints one line
naming the replacement (Claude in Chrome on the Mac, the person signs in in that tab, the agent
carries on there) and exits 0 without reaching the app; `pf login` exits 1 with the same line
(`test:pfhelp`). The live-picture version was REMOVED 2026-09-25:
`docs/specs/remote-login-pane.md`.

## A new pane starts where the work can run

`shared/offloadFirst.ts` decides BEFORE a pty in `startOrSend` above `laneFor`
(`main/index.ts`); `offload.log`; fallback toasts. `StartSessionRequest.where`: `local` final,
`remote` beats PERSON refusals. App-decided move: `OffloadSoon.tsx`, `OFFLOAD_ASK_MS` 8s, `Keep
it here` (`offload:answer`); `offloadAsk` = pressure dialog. Refusals above `always`: `never`,
`keepHere`, `machineBound`, NO PROMPT, `resumes`, `pinnedByPrompt` (outside path,
localhost/port/dev server, screenshot/browser, "on my mac"/"locally"/"here"), dev server
here, unmeasured/unshareable, no peer, `PEER_FULL_PANES` 8. Then `auto` under MEASURED
pressure only (`worstPressure`); never pane count/battery. `test:offloadfirst`.
A failed open, any caller: `reportOpenFailed` (`main/index.ts`) writes `{"event":"failed"}` to
offload.log and toasts (`openFailure`), except when the window asked (it shows the row's `why`);
`pf open` exits 1 with the reason. A device's project list is `projectsFor`: a list under 10 min
old that names the project answers without asking (the PC takes 10-15 s); a failed ask is
`deviceUnanswered` ("did not say which projects it has"), never "does not have". A client row
that went to its open chat flashes `reusedLine`. `test:openfailed`.

## The phone is this window, served

Renderer = pure UI over `window.api`; `src/main/phone.ts` serves, `renderer/src/browserApi.ts`
supplies, `src/shared/surface.ts` `SURFACE` is the one channel list. `tapIpc()` top of
`index.ts`; one SSE, `phone.broadcast` before the window check in `send()`. Off until Devices
opened; unpaired = pairing page; wrong codes lock; cookie `hmac(deviceId, code)`.

- `src/main/passkey.ts`: `phone.typeGate` one touch/15 min on `/pf/send`/`/pf/call`, never
  `pty:write`, TLS only, 423; `DESK_ONLY` refuses `phone:typeGate`/`phone:forgetKey`.
- `POST /pf/ask` -> card, digits both screens, 32-byte token; asking off = code in fragment.
  `addressOf` trusts `cf-connecting-ip`/`x-forwarded-for` from loopback only; one row/device;
  `New code` only revoke. Ten-year cookie never revoked on suspicion (`shared/deviceWatch.ts`,
  `phone:clearMark` `DESK_ONLY`). `SameSite=Lax`; `Secure` w/ TLS.
- Reach `main/funnel.ts` (Tailscale) then `main/tunnel.ts` (cloudflared).
- Copy = phone clipboard (`copyText`/`readClipboard`); TEXT via `TextSheet.tsx` (<=8 MB);
  `user-select: none`; `HandheldType` 44px keys.
- Desk owns shape; phone borrows; `clear` never `reset`. `shared/linkState.ts`, `LinkBanner`,
  `LINK_QUIET_MS` 20s (`test:linkstate`). `handheld.ts` + `@media` <720px or coarse <520px;
  `100dvh`; `PaneMenu.tsx`; `isPhoneClient()` gates authority only.
- Automation `scripts/pf-ctl.mjs`, never `open --args`: `pf open <cwd> --prompt "..." [--agent
  A] [--model M]`, `pf list` verifies; `--close-when-done` (`--report-to` default `PF_PANE`;
  `shared/closeWhenDone.ts`, `CLOSE_DONE_QUIET_MS` 8s, `test:closedone`).
- Quiet result delivery: `pf-ctl review <review.json>` for a completed result/update/
  decision/blocker (`docs/reviews-runtime-contract.md`); save request+evidence+identity
  before an evidence-gated close; quiet time/sleep/exit never means done; reports persist
  after closing; reading one never approves it.
- Peer Review replication (`main/reviews.ts`, `main/remote/`): the owner sends only its
  durable records over the authenticated link, 20 at a time with a cursor after reconnect.
  The receiver validates and saves an idempotent local replica under `remote_<device>_<id>`;
  replicas never echo and their file paths never leave the owner. `origin` is display-only,
  so reopening remains an operation on the owning PC. `test:remote` includes multi-page
  catch-up.
- Phone push (TaskDriver app): a row whose notice goes out (`reviews.ts` `spoolNotice`,
  BEFORE its Mac-only gate, so the PC pushes its own rows) and that leaves a person step,
  decision or blocker posts ONCE via `limitWaves.ts` `postPush` (`shared/reviewPush.ts`):
  `dedupe_key` `paneforge-review-<mac|pc>-<id>`, `pushSentAt` only after a 2xx, retries
  +30s/+120s, none when looked at / reviewed / a replica / packaged-off / opened by a pane
  that collects its steps (`openerOf`, the opener pushes). `phone-push.log`, `test:reviewpush`.
- Robert's phone on Tailscale signs in with no code: `shared/tailnetIdentity.ts` rule (serve's
  `X-Forwarded-For` + `tailscale whois`, same Tailscale user as the desk, iOS/android, never Funnel or
  cloudflared, never with phone access off), `POST /pf/native/v1/auth/tailnet`, trusted `/pf/ask` and
  control unlock; grants slide 30 days while in use; `phone-trust.log`; `test:tailnettrust`.
- Robert's iPhone WITHOUT Tailscale signs in with no code by a Taskdriver desk ticket:
  taskdriver.ai signs `v1.<payload>.<sig>` (HMAC keyed from the ingest token, `limitWaves.ts`
  `ingestToken()`) for its owner only; `POST /pf/native/v1/auth/taskdriver` (`shared/deskTicket.ts`)
  checks sig, exp, life <=300 s, aud = Host, deviceId, jti once, email = the desk's own Tailscale
  login (`selfLogin()`); never with phone access off. Row `td-<sha256(deviceId)>`, same read+control
  grant as tailnet; a lapsed control window is 423 and the app signs in again; `test:deskticket`.
- The phone server never starts on a port something already answers on at 127.0.0.1
  (`answersOnLoopback` in `PhoneServer.start`, `test:pfaccess`): a copy would otherwise shadow
  the installed app's loopback for `pf`, the tunnel and `tailscale serve`.
- `test:phone`, `test:phoneview`; `window.__pf[id].term.buffer`. Not built: B1, H2.

## The other machine's screen is one click away

Quick button beside Review opens the peer's screen as a PANE beside the terminals (grid on,
never fills the window unasked): `shared/screenStream.ts`, `main/screenStream.ts`,
`ScreenPane.tsx`; `test:screenstream`, `test:screenview`, `screen-stream-window-test.mjs`.
`screen:*` on `wire.ts`, gated by `screenView`; panes outside SessionManager. `Take
control` = Moonlight. View-only. Detail: design-notes.

## An iPhone is not a Mac, and a phone control is 44px

`test:phonetouch`. `navigator.userAgent.includes('Mac')` is TRUE on iPhone/iPad: `isMac`
refuses iOS and coarse-only; hints hidden. Handset home = sessions list, controls 44px (row
close 40x40). Reads BUILT css, FIRST `@media (pointer: coarse)` block; `html.handheld .pt-more`
loses to later `.pane-title .icon`; `.icon.help` own `min-width`.
