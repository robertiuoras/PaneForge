# Devices: connect step by step

Read `docs/rework/README.md` first. Surface: `src/renderer/src/components/RemoteDialog.tsx`
(the page in Robert's screenshot), `PairQr.tsx`, `PairAsk.tsx`, `PhoneAsk.tsx`; wiring in
`src/main/remote/`, `src/main/phone.ts`, `src/main/funnel.ts`, `src/main/tunnel.ts`.
CLAUDE.md sections "Two machines, one desk" and "The phone is this window, served" hold the
rules the flow must keep (pairing code never sent, only proved; six digits on both screens;
no self-pair; `New code` the only revoke). Do not change the protocol (`PROTOCOL` stays 1).

## What is wrong today (his words + what the screenshot shows)

- Two columns, six toggles, a QR, an address, an invite button, "Pair by hand", "Other ways
  in", "What else this machine is running", a 32-row script list. A person who wants to
  see their panes on a phone cannot tell which of those is the first step.
- Copy explains the mechanism (Tailscale Funnel vs Cloudflare quick tunnel, cf-connecting-ip)
  instead of the outcome.

## What it becomes

One page, three numbered steps, each step drawn only when the one before is done:

1. **What do you want to connect?** two big choices: `A phone or tablet` / `Another
   computer running PaneForge`. Nothing else on the page until one is pressed.
2. Phone: **one QR** and one sentence ("Point your phone's camera at this"). The reach
   decision (same Wi-Fi / anywhere) is a single switch UNDER the QR with a one-line
   outcome: "Works from anywhere" or "Works on this Wi-Fi only". No vendor names on screen.
   Computer: **one six-digit code** shown big, and "Type this on the other computer" - or,
   if a device on the network is already asking, its card with `Approve`. `Copy invite`
   and `Pair by hand` live behind one `Other ways` disclosure.
3. **Connected.** The paired device row: name, online dot, panes there, `Open a pane
   there`, `Disconnect`. The "what else it is running" list moves behind a disclosure and
   collapses identical rows (`hook-guard.mjs x 32`, not 32 rows).

Advanced (Let my other devices connect / ask-to-pair / signed-in phones / New code) stays,
under one `Advanced` disclosure at the bottom, closed by default. Every existing behaviour
stays reachable; nothing is deleted, only ordered and hidden until its step.

## Rules

- FULL REDESIGN, so: **mock first.** Write ONE static HTML mock (both themes, phone width
  and desk width) to `docs/rework/mock/devices.html`, publish it as an artifact if the
  Artifact tool exists in your session (else say the path), post the link, and STOP. Build
  only after Robert answers in this pane. Follow `claude-memory/toolstash/design-vault/
  linear.app.md` for surfaces, hairlines and the two motion durations; no generic cards.
- Plain words: `npm run test:laneplain` and its `PLAIN` list; no "funnel", "tunnel", "TLS",
  "passkey" on screen - say what happens ("your phone signs in once and stays in").
- `npm run test:remote`, `test:pairask`, `test:phone`, `test:phoneview`, `test:devicesfit`,
  `test:contrast` (needs a window: `npm run try -- --keep --remote-debugging-port=9333`).
- Commit on your lane, `node scripts/lane.mjs ready --repo <your dir> --session <id>`.
  No release. Report the before/after count of controls on the page.
