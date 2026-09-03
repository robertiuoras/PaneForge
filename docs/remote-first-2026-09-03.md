# Remote-first: where a pane runs, decided by capability, never by asking

Robert, 2026-09-03: "every session should we ask user if they want to keep here or start
on the remote PC? but we only know after the first prompt whether the PC can do it, and
browser automation on local Chrome can't run on the PC in NZ."

## The standard

1. **Remote the capability, not the work.** The one hard Mac-bound capability is Chrome.
   Expose the Mac's CDP port on the tailnet (`tailscale serve --bg --tcp 9333
   tcp://127.0.0.1:9333`, verify syntax; fallback ssh forward). Chrome accepts an IP Host
   header (DNS-rebinding guard allows IPs). Every PC pane is spawned with
   `PF_CHROME_CDP=http://<mac tailscale ip>:9333`; `chrome-devtools-mcp --browserUrl` and
   `claude-config/browser/cdp-bg-tab.mjs` read it. Dev servers run on the PC, viewed via
   the funnel. After this, "browser" stops being a reason to pin local.
2. **Classify continuously.** `src/shared/offloadFirst.ts` reads the first prompt
   (`pinnedByPrompt`) - keep it as the cheap early signal. Add the runtime half: a
   PreToolUse hook in PC panes that sees a Mac-only path (`/Users/robertiuoras`,
   `~/Desktop`, `~/Downloads`), a Safari-login page, or a local-Chrome call with no
   `PF_CHROME_CDP` -> queues a handoff BACK to the Mac through the existing
   `main/handoffQueue.ts` (`auto-sync:` commit, mid-turn queued, never killed). A wrong
   guess costs one move, not a popup.
3. **Default stays**: shareable repo -> PC; bare `+` / no prompt -> Mac. `offloadAsk` is
   deleted: a card nobody presses is a decision nobody made.
4. **Say where it landed and why** - the toast already reads `offload.log`.

## Build order

- A. `PF_CHROME_CDP` in PC pane env (`main/index.ts` spawn env for offloaded panes) +
  tailnet exposure on the Mac, proved by a PC pane taking a screenshot of Mac Chrome.
- B. Wrong-machine PreToolUse hook (claude-config, PC settings.json) -> `pf` handoff
  request -> `handoffQueue`. Test: `npm run test:handoff` grows a queued-return case.
- C. Remove `offloadAsk` + its dialog; `npm run test:offloadfirst` pins "never asks".
