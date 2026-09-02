# Settings: only what is necessary

Read `docs/rework/README.md` first. Surface: `src/renderer/src/components/SettingsDialog.tsx`
(1,901 lines, 8 tabs, 82 rows) and `scripts/settings-index.mjs` (`npm run gen:settings`
regenerates `src/shared/settingsIndex.ts`; `npm run test:settingsearch` fails on drift).
CLAUDE.md "Finding a setting" holds the search rules.

## What is wrong today (his words)

"way too much clutter in settings ... dont need so much description for everything not so
many buttons? more minimalist only keep whats necessary".

## What it becomes - build straight, no mock (a content pass, not a new surface)

1. **Count first.** Print, per tab: rows, words of hint text, controls. That table is the
   before; the same table after is the result.
2. **Hints are one line, twelve words or fewer, outcome not mechanism.** A hint that names
   a file, a millisecond constant, a vendor, or a git word is rewritten. The long
   explanations move to a `?` on the row that opens the existing paragraph (keep the text,
   it is the documentation) - or are deleted when `docs/design-notes.md` already carries it.
3. **Prerequisite-gated rows.** A row whose feature needs a fact this machine lacks
   (README table) is not drawn: no paired device -> no handoff/offload rows; no Discord ->
   no Discord tab; no clients tree -> no client-naming row; no Telegram env -> no Telegram
   row. Gate on the fact read in main, never on a "show advanced" switch.
4. **Tabs: eight to five.** `General`, `Look` (Appearance), `Alerts` (Sounds + notify +
   Discord presence folded in), `Agents` (CLIs, models, Voice, Stash), `System` (updates,
   startup, admin, restore, copies-of-a-project). A tab with zero rows after gating is not
   in the rail. Keep `settingsIndex` correct - regenerate and run `test:settingsearch`.
5. **Buttons.** A button whose action is also reachable from where the thing is (e.g.
   `Open Devices` inside Settings) goes; a destructive one keeps its confirm.

## Rules

- Never delete a SETTING (the config key and its effect stay); only its row's placement,
  hint length and gating change. Hidden rows still honour saved values.
- Plain words: `npm run test:laneplain`. Both themes: `npm run test:contrast` (needs the
  try copy with `--remote-debugging-port=9333`).
- `npm run typecheck`, `npm test`, `npm run test:settingsearch`.
- Commit on your lane, `node scripts/lane.mjs ready --repo <your dir> --session <id>`.
  No release. Report the before/after table.
