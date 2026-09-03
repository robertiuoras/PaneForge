# Brief: the dev window walks you through what changed

Robert, 2026-09-04: "when i open dev window it should go through everything needed to show
me the updated changes, e.g. new session window format (show like a testing interface that
guides me fully through it i just press next/previous and it automatically does things and
goes through each change)".

## What exists already

`scripts/try-diff.mjs` (`report()` / `diffLines()`) answers "what does this build have that
the installed app does not": `feat:`/`fix:`/`perf:` subjects between `v<installed version>`
and HEAD, newest first, prefix stripped. It is printed at the end of every `npm run try`.
That list is the step list - do not invent a second source of truth.

## What to build

A tour that only ever appears in a DEV COPY (`profileName()` is not the default profile -
same reading `faultNotify.ts` uses to keep a test copy from paging anybody).

1. `src/shared/tour.ts` - the arithmetic, tested with no window: turn a list of change
   sentences into steps, hold `index`, answer `next`/`previous`/`done`, refuse an empty
   list (no card at all), and carry an optional `open` action per step naming a surface the
   step is about (`newSession`, `settings`, `sidebarHidden`, `workspaces`, `none`).
   Matching a sentence to a surface is a small keyword table IN THIS FILE, and a sentence
   matching nothing is a step with `open: 'none'` - never a guess that opens the wrong thing.
2. `src/main/tour.ts` - reads the change list by importing `diffLines` from
   `../../scripts/try-diff.mjs` (or move that arithmetic into `src/shared/` if the import
   is awkward - keep ONE copy either way), only in a dev profile, and hands it to the
   renderer on an existing channel. Add the channel to `src/shared/surface.ts` (a channel
   missing from that list does not compile for the phone client).
3. `src/renderer/src/components/TourCard.tsx` - a card in `.corner-stack` (read the "Every
   card the app puts in the corner is in ONE column" section of CLAUDE.md first: it is a
   static child of that column, never its own `position: fixed`). Shows `3 of 7`, the
   sentence, `Previous` / `Next` / `Done`, and pressing Next OPENS the surface that step
   names (set the same state the button for it sets - e.g. `setPicking(true)` for New
   session) before drawing the sentence. No animation, never takes focus, never a dialog.
4. Plain words on screen: no `commit`, `HEAD`, `tag`, `feat:`. The reader has never used git.

## Rules

- `npm run typecheck` must pass. Add `npm run test:tour` (`scripts/tour-test.mjs`) wired
  into `scripts/test-all.mjs` TESTS and package.json, covering: empty list draws nothing,
  index clamps at both ends, a sentence with no known surface gets `none`, and the tour is
  refused outside a dev profile.
- Do NOT touch `src/shared/devList.ts` or `src/main/devList.ts` - another agent holds those.
- Commit on master, subject a sentence about behaviour, ending with:
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017v5QbYLvT75ydjv1NJuWxb
- Autosync may hold .git/index.lock - retry `git add`, never delete the lock.
- Budget about 90 tool calls, one verification pass at the end.
