# The PC's screen, inside PaneForge

Robert, 2026-09-23 (from Discord, verbatim): "i think coudl be useful in paneforge if we had
option to jsut view the pc scren? maybe a icon like under review? acts just like windows.app
or osmething maybe even better if paneforge itself can handle it? just makes it easier to see
anything i want to in full screen/ can change window size around and also can zoom in or out
easily with button or trackpad or keybinds etc."

The planning question round could not run (the ask came from a phone, no card to tap), so the
decisions below are stated assumptions. Each one is reversible.

## What is already on the desk (measured 2026-09-23, over ssh and on this Mac)

| Fact | Value |
| --- | --- |
| PC | Windows 11 Pro, RTX 3080 Ti, desktop 2560 wide, `Gamer@100.78.1.77` on Tailscale |
| RDP host | enabled (`fDenyTSConnections=0`), `TermService` running, 3389 listening |
| Sunshine | `SunshineService` running, 47984/47989 listening, `C:\Program Files\Sunshine` |
| Parsec | `parsecd` running |
| PaneForge on the PC | running, 0.8.220 (this tree is 0.8.221) |
| Console session | `gamer`, id 1, **Disc** (detached after an RDP session; the physical screen shows the lock screen) |
| Mac | `Windows App.app` and `Moonlight.app` installed; Moonlight paired with host `Robert1` at `100.78.1.77`, apps `Desktop`, `FiveM`, `Steam Big Picture` |
| Peer link | `src/main/remote/` already carries an encrypted PaneForge-to-PaneForge channel (`PROTOCOL 1`) with the PC's address |

So: no remote-desktop server needs installing, no port needs opening, no credential needs
saving. Everything Robert reserved for himself is already in place from earlier work.

## The four ways, compared

| | Windows App deep link (RDP) | Moonlight deep link (Sunshine) | Parsec web client in a webview | PaneForge-native stream (WebRTC) |
| --- | --- | --- | --- | --- |
| Inside PaneForge | no, own window | no, own window | yes | yes |
| Zoom / pinch / keybinds ours | no | no | partly (`setZoomFactor` on the page) | yes |
| Mouse + keyboard | yes | yes | yes | v2 (needs input injection on the PC) |
| Picture | RDP, no GPU, 30 fps-ish | NVENC, 60 fps, lowest latency | H.264/H.265 via WebCodecs, good | VP9/H.264 from Chromium, good |
| Locked console | RDP reattaches the session itself | shows the lock screen; you type the password in Moonlight (Sunshine runs as a service) | shows lock screen, Parsec unlocks | black or lock screen; PaneForge on the PC runs in the user session and cannot see the secure desktop |
| Side effect | an RDP disconnect leaves the console detached, which is the **current** state and what breaks every capture-based viewer until `tscon` | none | none | none |
| Depends on | Microsoft's app | Moonlight + Sunshine, both here | Parsec cloud + a Parsec login typed into the app | nothing new |
| Build | 1 hour | 1 hour | half a day | 2-3 days view-only, +1-2 days for control |

In-app RDP was dropped without a row: there is no usable browser RDP client without a gateway
server (Guacamole, a Java service), which is more infrastructure than the feature.

## Decision

**v0, shipped in this change:** a quick button beside Review that starts Moonlight at the
paired machine. It is the "acts just like windows.app" half of the ask, with a better picture
than RDP, and it costs nothing Robert reserved. Moonlight over Windows App because Sunshine
is the viewer that does not leave the console detached, which is what the native stream will
need too.

**v1, designed below, built next:** the PaneForge-native stream. PaneForge on the PC captures
its desktop with Electron's `desktopCapturer` and streams it over WebRTC to PaneForge on the
Mac, which draws it in a pane. View-only first. Zoom, pinch, keybinds and fullscreen are ours.

Assumptions made in place of the question round:

1. **View-only is enough for v1.** Robert wrote "view the pc screen" three ways and "control"
   none. A `Take control` button on the pane hands off to Moonlight (v0's command) until v2.
2. **It is a pane, not a dialog.** The grid already gives free resize, a number, fullscreen
   (Focus) and a place in the sessions list on both machines.
3. **A detached console is reattached only on a press.** `tscon 1 /dest:console` over ssh
   unlocks the physical screen at home, so the pane shows the lock screen and a `Wake the
   desktop` button rather than doing it on arrival.
4. **Transport is native, not Parsec.** Parsec would be faster to build and gives control
   today, but it means typing a Parsec login into PaneForge and leaning on Parsec's cloud for
   a picture that never needs to leave the tailnet.

## v0: the button (`src/shared/screenView.ts`, `src/main/screenView.ts`)

- `screenPlan(viewer, peers)` picks the online peer, else the first paired one, and answers
  `['stream', <address>, 'Desktop']` - the exact shape `Moonlight stream --help` prints.
  Refusals: `no-viewer` (Moonlight not installed here), `no-peer` (nothing paired).
- `screenCan` decides whether the button is drawn at all; the sidebar re-asks when the peer
  list changes. No viewer or no peer = no button. A pressed control that opens an install page
  is a control that does nothing in a hurry.
- `openScreen` spawns Moonlight detached and unreferenced (the window is the person's now);
  one at a time (a second `stream` makes Sunshine refuse with its own dialog); every start,
  refusal and exit goes to `userData/screen-view.log`; a refusal toasts through `app:error`.
- `screen:open`/`screen:can` are `DESK_ONLY`: a phone must not start a window on the desk.
- Title names the machine (`See Gamer's screen (opens Moonlight)`), never the protocol.
- `scripts/screen-view-test.mjs` (`npm run test:screenview`) pins the command shape, the peer
  pick, both refusals and the per-platform search paths.

Not verified in this change: an actual Moonlight launch. Starting it opens a window on
Robert's Mac, which this session had no authority to do; the command was checked against
Moonlight's own `--help` and its paired-host list.

## v1: the native stream

### Architecture

```
PC PaneForge (source)                         Mac PaneForge (sink)
 desktopCapturer.getSources({screen})          <ScreenPane> in the grid
   -> getUserMedia(chromeMediaSourceId)          <video autoplay muted>
   -> RTCPeerConnection.addTrack                 RTCPeerConnection.ontrack
        |  offer/answer + ICE candidates over the existing peer Conn (wire.ts)  |
        |  media: WebRTC over Tailscale, host candidates only, no STUN/TURN     |
```

- **Signalling** rides the encrypted peer channel that already exists: three new `Msg` kinds
  (`screen:offer`, `screen:answer`, `screen:ice`) and one `screen:stop`. Nothing new listens
  on the network.
- **Media** is a direct WebRTC connection between the two tailnet addresses. Both sides are
  reachable, so ICE with host candidates only is enough; if it is not on a given network the
  pane says `Could not connect to <machine>` and offers Moonlight.
- **Capture** runs in a hidden renderer on the PC (a `BrowserWindow` with `show: false`), since
  `getUserMedia` is a renderer API. It starts on request and stops when the last viewer
  leaves. Frame rate 30, resolution the source's own; the sink scales.
- **Locked or detached console**: capture fails or shows black. The source reports
  `consoleDetached` (from `query session` output) and the sink draws the `Wake the desktop`
  button, which runs `tscon <id> /dest:console` over the same ssh `remoteLogin.ts` already
  uses for tunnels. Nothing runs without the press.

### The pane

- A `ScreenPane` is a session of kind `screen` in the grid: numbered, resizable, in the
  sessions list on both machines, closable. Its header clock is time connected.
- **Zoom**: buttons (`-`, `100%`, `+`, `Fit`), Cmd/Ctrl `+`/`-`/`0`, trackpad pinch (a `wheel`
  event with `ctrlKey` in Chromium) and Cmd/Ctrl+wheel. Zoom is a CSS transform on the
  `<video>` inside an overflow-scrolling box; the pinch point stays under the fingers. Steps
  `0.25 .. 4`, `Fit` = contain.
- **Fullscreen**: the existing Focus view (one pane fills the window) plus the app's
  fullscreen toggle; `Escape` leaves. A `Take control` button runs v0's Moonlight command.
- **Quality line** in the footer, from `RTCPeerConnection.getStats()`: fps, kbps, rtt. A read,
  nothing pressable.
- Mirror rules: the pane shows on the sessions list of both machines; only the sink draws
  video. The source machine sees `Gamer's screen, being watched from <Mac>`.

### Error handling

| Case | Behaviour |
| --- | --- |
| Peer offline | button disabled with the peer's status in its title; pane never opens |
| Peer PaneForge older than this protocol | `Update PaneForge on <machine> first`; Moonlight offered |
| ICE fails within 10 s | `Could not connect to <machine>`; retry once; then Moonlight offered |
| Capture denied / black | `The PC's screen is locked` + `Wake the desktop` |
| Link drops | frozen last frame with `Reconnecting…` for 20 s, then the failure card |
| Source machine closes the pane | sink pane ends, History row says `closed by <machine>` |

### Testing

- Pure: `shared/screenStream.ts` state machine (`idle → offering → connected → reconnecting →
  failed`), zoom arithmetic (pinch anchor, clamps, fit), the console-detached parser on real
  `query session` output. `scripts/screen-stream-test.mjs`.
- Wire: `screen:*` messages round-trip through `Conn` in `scripts/remote-test.mjs` alongside
  the existing kinds; an older `PROTOCOL` refuses them by name.
- Window: `npm run try -- --headless --remote-debugging-port=9444`, a fake source injecting a
  canvas `MediaStream`; `ui-lab.mjs` reads the pane's zoom factor and the footer line.
- Live: Mac sink + PC source over the tailnet, numbers in the commit: fps, kbps, rtt at 2560
  wide, and a measured 30 s of CPU on both machines (`getAppMetrics`).

### Out of scope for v1

Mouse and keyboard forwarding (needs input injection on the PC: `SendInput` via a small
helper or nut.js; coordinate mapping through the zoom transform), audio, clipboard, more than
one display, streaming the Mac to the PC (the source side is platform-neutral, so this is a
switch later, not a design change).

## What the research lanes settled (2026-09-23, 15 agents, sources in the run journal)

- The link is **WAN, not LAN**: Mac and PC sit in different buildings; Tailscale is a direct
  path, RTT measured 60/87/150 ms min/avg/max (memory, 2026-09-06). That is also why Windows
  App was dropped for gaming on 2026-09-06: RDP lagged and lost the mouse. Moonlight was the
  fix then; it is v0 now.
- **Tailscale MTU is 1280.** Larger UDP packets vanish silently (`ping -s 1400` lost every
  packet in the cited report). Chromium's RTP packets default to ~1200 bytes, so the stream
  fits; the live test must confirm no loss at 2560 wide.
- **Chromium hides host candidates** behind `<uuid>.local` mDNS names, which do not resolve
  across a tailnet. The source and sink exchange their tailnet addresses over the peer
  channel and the sink adds them as explicit candidates, or the capture window is launched
  with `WebRtcHideLocalIpsWithMdns` disabled. Design choice: explicit addresses, no flag.
- **Desktop capture is capped near 30 fps** in Chromium (electron/electron#24808). Good
  enough for a desk view; a game goes through Moonlight.
- **Hardware encode is unconfirmed** for screen tracks on Windows (Media Foundation H.264
  exists; NVENC use unverified). The live test reads `chrome://webrtc-internals` on the PC.
  Mac decode is VideoToolbox on Apple Silicon.
- **RDP disconnect tears down the display stack**; DXGI and GDI capture fail until
  `tscon <id> /dest:console` (LanternOps/breeze#2160, third-party). Sunshine hit the same
  (LizardByte/Sunshine#964). Confirms assumption 3 and the `Wake the desktop` button.
- **Codec**: AV1 has screen-content tools on by default for capture streams in Chromium;
  H.264 is the safe compromise. Start with H.264 (hardware decode on the Mac), measure, try
  AV1 second.
- **Parsec web inside Electron**: nobody has reported it working; moonlight-web means a new
  server on the PC. Both stay out.
- Unverified by any source: what `getUserMedia` returns on a locked screen (black or error).
  The live test decides; the pane handles both as `screen is locked`.

## What stays Robert's

Nothing in v0 or v1 installs a server, opens a port or stores a credential. If the live test
shows host-only ICE cannot cross his tailnet, adding a STUN/TURN hop is his call.
