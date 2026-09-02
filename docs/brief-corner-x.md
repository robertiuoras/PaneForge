# Brief: an X on every corner card

Every card in `.corner-stack` (`src/renderer/src/App.tsx` ~line 6773) gets a small X in its
TOP-RIGHT corner that dismisses that card. Robert 2026-09-03: "add x button any popup
(bottom right popups for autoclear workflow, closing session etc) top right in popup".

Cards (all in `src/renderer/src/components/`): `AutoClearToast.tsx` (`.autoclear-card`,
one per pane), `MoveSoon.tsx` (`.move-soon`), `StopServer.tsx` (`.move-soon.stop-server`),
`ClientToast.tsx` (`.client-toast`), `UpdateToast.tsx` (`.update-toast`), `WhatsNewCard.tsx`
(`.update-toast.whatsnew`), `Tips.tsx` (`.tip-toast`).

Rules:
- ONE shared component `CardX` in `src/renderer/src/components/CardX.tsx`:
  `<button type="button" className="card-x" aria-label="Dismiss" onClick={...}>×</button>`.
  Every card renders it as its first child; the card root gets `position: relative`.
- CSS in `src/renderer/src/styles.css`, one rule block `.card-x { position:absolute; top:6px;
  right:6px; width:24px; height:24px; ... }` using only `var()` colours (`--muted` at rest,
  `--text` on hover, no background at rest, hairline `var(--line)` border on hover). Handheld
  (`html.handheld .card-x`) 44px. No animation. Follow the vault entry
  `claude-memory/toolstash/design-vault/linear.app.md` for the dismiss-button spec.
- What X MEANS per card (the safe reading, never the destructive one):
  - AutoClearToast per-pane card: same as `Keep this session` (`onKeep(id)`) - dismissing
    the countdown must NOT clear the pane.
  - MoveSoon / StopServer: same as `Keep it open` (`onKeep`). Never `onNow`.
  - ClientToast: hide the card only (local `gone` state); the rename stands.
  - UpdateToast: same as its existing dismiss (`setDismissed(state.version)`).
  - WhatsNewCard: `setGone(true)`. Tips: `setTip(null)` (same as its close button).
- Padding: give each card enough right padding (or the header row `padding-right: 28px`) so
  the X never overlaps the card's first line of text.
- `scripts/activity-test.mjs` reads the SOURCE of these cards; keep it green and add an
  assertion there: every card file listed above imports `CardX` and renders `<CardX`.

Verify: `npm run typecheck && npm run test:activity && npm run build`. Do NOT run `npm test`
(the whole suite) and do NOT launch the app. Budget: ~40 tool calls. Commit on the current
branch with subject `feat(corner): an X in the top-right of every corner card`, body naming
what each X does. Do not push. Write a one-paragraph result to
`docs/brief-corner-x.result.md` and return it.
