# Remote login pane — sign in to the PC's automation Chrome from inside PaneForge

Date: 2026-09-03. Owner: Robert (approved: "build this out fully for me set a goal and just build it
please for next paneforge version ... test in dev window first ... make it as smooth as possible
even under lag").

## Goal

Any script on any machine that hits a login wall can say `pf needs-login <site> --url <url>
[--host user@ip] [--port 9333]`. PaneForge shows a "<site> needs login on <machine>" card; one
click splits the current pane — chat on the left, a LIVE view of that machine's automation Chrome
on the right — and Robert types the login there as if it were local. When he presses Done the
view closes, the PC's Chrome keeps the session, and the script that asked can proceed.

Ships in the next dev build. No RDP, no VNC: the view is a CDP `Page.startScreencast` stream
with `Input.dispatch*` forwarding, over an SSH tunnel PaneForge opens itself.

## Verified facts (do not re-derive)

- PC: `ssh -o BatchMode=yes Gamer@100.78.1.77` works with key auth from this Mac. Chrome is at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`, node v24.14.1. NOTHING listens on
  PC :9333 yet — the PC automation Chrome launcher (`claude-config/browser/chrome-automation.ps1`,
  headless=new, `--remote-debugging-port=9333 --remote-debugging-address=127.0.0.1`,
  profile `C:\Users\Gamer\.chrome-automation`) is being written by the Car session in parallel;
  do not write it. If it is not there when you test, launch Chrome on the PC over ssh with those
  exact flags (see `claude-config/browser/chrome-automation.sh` for the Mac flag set).
- Mac automation Chrome: `127.0.0.1:9333`, same flags, launched by `chrome-automation.sh`.
  `--host` omitted = local Chrome, no tunnel — this also replaces the AppleScript window-raising
  in `chrome-login.sh` / `chrome-show.sh` for the Mac case.
- Chrome's CDP endpoint refuses non-localhost Host headers unless the Host is an IP; going through
  `ssh -N -L <free-local-port>:127.0.0.1:9333 <host>` keeps everything on 127.0.0.1 and needs no
  firewall or Chrome flag change on the PC. Pick the local port with a `net.createServer` probe.
- `pf` = `scripts/pf-ctl.mjs` → the phone server in `src/main/phone.ts`. Read how `open` and
  `call <channel>` are wired there and add `needs-login` the same way. `pf list` must show the
  login pane (state, title, machine).
- Related, NOT this feature: `docs/remote-first-2026-09-03.md` shares the MAC's Chrome with PC
  panes through `PF_CHROME_CDP`. That serves interactive panes; this feature exists so the PC can
  own a logged-in Chrome for SCHEDULED jobs that run while the Mac is asleep. Do not merge them.
- Screencast works in `--headless=new`; the PaneForge pane IS the window, so the PC never shows a
  console or browser window (standing rule: no background job shows a window on the PC desktop).
- Electron's bundled Node has a global `WebSocket`; if the main process cannot use it, `ws` is
  already a dependency of several scripts — check `package.json` before adding anything.

## Build

### 1. `src/main/remoteLogin.ts` — session manager (main process only, no CDP in the renderer)
- `openRemoteLogin({ site, url, host?, port = 9333 })`:
  1. if `host`: spawn `ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L <local>:127.0.0.1:<port> <host>`;
     wait until `http://127.0.0.1:<local>/json/version` answers (poll 250 ms, 15 s cap, then fail loudly
     with the ssh stderr in the card).
  2. `/json/list` → reuse a `page` target whose URL host matches `url`, else `Target.createTarget {url}`
     (background: false is fine — headless has no focus to steal).
  3. Attach; `Page.enable`; `Emulation.setDeviceMetricsOverride` to the pane's CSS size (send on
     resize, debounced 150 ms); `Page.startScreencast { format: 'jpeg', quality: 60, maxWidth, maxHeight,
     everyNthFrame: 1 }`.
  4. Each `Page.screencastFrame` → IPC `remoteLogin:frame { id, data, metadata, sessionId }` to the
     renderer; the renderer sends `remoteLogin:ack` AFTER it has painted the frame; only then
     `Page.screencastFrameAck`. This is the whole backpressure model — one frame in flight, never a
     queue. Track `rtt` = ack time − frame time.
  5. Adaptive under lag: rolling median rtt > 250 ms → restart the screencast at quality 40 /
     maxWidth 960; > 600 ms → quality 30 / 720; recover one step up after 20 frames under 150 ms.
     Log every step change to `remote-login.log` (same dir as the other main-process logs).
  6. Input: `Input.dispatchMouseEvent` (mousePressed/Released/Moved/Wheel, coordinates scaled
     by frame metadata → CSS px; mouseMoved coalesced to the latest per animation frame), `Input.dispatchKeyEvent`
     (keyDown with `key`, `code`, `windowsVirtualKeyCode`, `text` for printable; keyUp), paste → `Input.insertText`.
     Modifiers mapped (Cmd → Ctrl on the PC target, since Windows Chrome does not know Meta).
  7. `close()`: `Page.stopScreencast`, detach, kill the ssh child. Chrome and the tab stay up on the
     remote — the session is the point.
- Login-done hint (best effort, never blocks): poll `Runtime.evaluate location.href` every 2 s; when
  the URL leaves a `/login`-ish path or its host changes away from the login host, show "looks signed
  in" in the header; Done stays a human click.

### 2. Phone channel + CLI
- `src/main/phone.ts`: channel `needs-login` payload `{ site, url, host?, port?, from? }` → creates or
  focuses a login request in the pane list (title `Login: <site> on <pc|mac>`), returns the request id.
- `scripts/pf-ctl.mjs`: `pf needs-login <site> --url <url> [--host user@ip] [--port N]`; exit 0 with the
  id, 2 if the app is not running (existing convention).
- A request shows as a card at the top of the pane list until opened or dismissed. Toast on arrival.
  Copy for a reader who has never coded: "Facebook needs you to sign in on the PC. Open and sign in."

### 3. Renderer — `src/renderer/RemoteLoginView.tsx`
- Opening a request splits the ACTIVE pane 50/50 (reuse the existing split primitive; if there is none,
  the login view takes the right half of the pane's own area). Left keeps the chat; right = header
  (site, machine, rtt badge, quality badge, Done, Close) + `<canvas>` painting frames via
  `createImageBitmap` (not `<img src=data:>` — it double-decodes and stutters).
- Local cursor drawn on the canvas immediately on mousemove so the pointer never lags the stream.
- Keyboard focus: clicking the canvas captures keys; Esc + Esc (double) releases focus; Cmd+W is NOT
  forwarded (it would close the remote tab).
- Under lag the header badge turns amber (> 250 ms) / red (> 600 ms) and shows the number; the
  view never freezes because frames are ack-gated.

### 4. Tests (`npm run test:remotelogin`, one script under `scripts/`, plain node like the others)
- coordinate mapping (pane px → CSS px at each quality step);
- key translation table (Enter, Backspace, Tab, arrows, printable + shift, Cmd→Ctrl);
- ack gating: a fake CDP that emits 50 frames while the renderer acks slowly → at most 1 unacked
  frame at any time, and the adaptive step-down fires at the right rtt;
- `pf needs-login` argument parsing + the phone channel returning an id;
- `pf list` row for a login request.
- Grow `npm run test:laneplain` (or whichever pins user-visible wording) with the card copy.

### 5. Dev-window proof (required before commit)
`npm run dev`, then from a terminal:
`pf needs-login facebook --url https://www.facebook.com/login --host Gamer@100.78.1.77`
(fallback if the PC Chrome is not up yet: `pf needs-login facebook --url https://www.facebook.com/login`
against the Mac's :9333). Prove with numbers: frames painted per second, median rtt, quality step
taken, one mouse click landing at the right CSS coordinates (evaluate `document.activeElement` on the
remote after clicking the email field). Then simulate lag: `ssh` with `-o ServerAliveInterval=1`
plus a `tc`/`dummynet` is overkill — instead stub 500 ms into the ack path in dev
(env `PF_REMOTE_LOGIN_FAKE_LAG_MS=500`) and show the step-down to quality 40 in the log.

### 6. Ship
- Commit on your lane, `lane.mjs ready`, typecheck + suite green. Robert asked for this in the NEXT
  version: cut the dev build with the `paneforge-release` skill after the proof, and say what to open
  (the card in the pane list) and what he should see.
- Write the pane memory entry: what the channel is called, the tunnel port rule, the adaptive steps.

## Out of scope
RDP/VNC, a general remote desktop, storing any credential, moving the Car sweep itself (the Car
session owns that), sharing the Mac Chrome with PC panes (remote-first doc).
