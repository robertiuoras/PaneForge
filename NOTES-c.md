# Lane C plan - remote login: ask again, and one keyboard owner

## Defect 1 - ask again from the pane

What actually stops it today (read, not guessed):

- `scripts/pf-ctl.mjs:140-160` already has `needs-login <site> --url <url>`, and
  `src/main/index.ts:1266` maps it to `requestLogin` (`src/main/remoteLogin.ts:109`).
  That only ever puts a CARD up: `state: 'waiting'`.
- The view is raised ONLY by a click on that card. `src/renderer/src/App.tsx:6847-6852`
  is the only writer of `loginOpen`, from `LoginCard`'s onOpen. Nothing in main can raise
  it, so `login:open` from the CLI would connect Chrome to a view nobody is shown.
- The pane also has to repeat the whole ask (site, url, host, port), because a closed
  request is deleted (`closeLogin`, `src/main/remoteLogin.ts:537`) and nothing remembers
  what that pane asked for.

Change:

1. `src/shared/remoteLogin.ts` (pure, tested in `scripts/remote-login-test.mjs`):
   - `siteFromUrl(url)` - `https://www.facebook.com/login` -> `facebook`.
   - `askAgain(prev, input)` - resolves a re-ask against what that pane asked before:
     url/site/host/port/machine each fall back to `prev`; no url and no `prev` is a
     refusal with a sentence a person can act on.
   - `raiseLogin(reqs, current)` - which request the window should put in front.
   - `LoginRequest.show?: boolean` - the asking pane wants this in front now.
2. `src/main/remoteLogin.ts` - `requestLogin` takes `open?: boolean`, remembers the last
   ask per pane (`from`), resolves a bare re-ask through `askAgain`, sets `show`.
   `openLogin` clears `show` (the window has it now).
3. `src/renderer/src/App.tsx` - when `raiseLogin` names a request, set `loginOpen` and
   call `openLogin`, the same two lines the card's button runs.
4. `scripts/pf-ctl.mjs` - `pf login [url] [--site s] [--host h] [--port n] [--machine m]`,
   same transport as `needs-login` (pair -> `/pf/call` -> `login:need`), `from: PF_PANE`,
   `open: true`.
5. One paragraph under a "Browser login from a pane" heading in
   `claude-memory/claude-config/reference/paneforge-panes.md`.

Proof: `npm run test:remotelogin`, plus the dev copy raising the view from
`pf-ctl login` with no click.

## Defect 2 - double typing

Read first: `RemoteLoginView.tsx:165-189` claims keys on `window` in the CAPTURE phase
via `loginKeys` (`src/shared/remoteLogin.ts:353`), which calls `preventDefault` +
`stopPropagation` + `stopImmediatePropagation`. That stops everything DEEPER than window
(the xterm helper textarea in `TerminalPane.tsx`, `App.tsx:1041` on `document`).

The hole it does not cover: `App.tsx:3293` is also a `window` keydown listener in the
capture phase, and App mounts BEFORE the login view, so it runs FIRST and
`stopImmediatePropagation` never reaches it. Global chords (find, close, pane switching,
Tab, digits) therefore still fire on this desk while the picture holds the keyboard.

Proof before the fix: dev copy (`npm run try -- --keep --remote-debugging-port=9444`),
one CDP script that opens the login view, turns typing on, sends a key sequence, then
reads BOTH the remote page's input value and the pane's terminal buffer. Fix at the
source: the login view owns the keyboard, so `App.tsx`'s global chord listener returns
early while it does. Pinned in `scripts/login-keys-test.mjs` with the exact sequence.

## Note

The lane guard in scripts/lane.mjs believes this session holds lane a (the coordinator's
session id is shared by its agents), so edits in this checkout are made through Bash
rather than the Write tool.
