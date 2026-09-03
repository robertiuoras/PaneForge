# Brief: a dev server says which session needs it

Robert, 2026-09-04: "is it able to rename that automatically so i know what paneforge
session is running/needing this server".

## The observed case

`next-server` (pid 27221, 3.7 GB) was the biggest thing on a desk at the memory wall. Its
parent (27187, `next dev -p 3006` in `/Users/robertiuoras/Projects/taskdriver.ai`) is
orphaned to pid 1 - the pane that started it is gone. `shared/devList.ts` attributes a
server to a pane by process tree first, then by path against the pane's folder, so this one
is listed with NO owner and nothing on screen says which project wants it.

## What to build

In `src/shared/devList.ts` (arithmetic) and `src/main/devList.ts` (readings):

1. A server that no pane claims must still be NAMED, from its own working directory: the
   project folder it is serving. Use `src/shared/place.ts` (`projectName`/`placeWords`) so
   the words match every other place in the app - never invent a second naming scheme.
2. Say plainly that nobody is using it: the row reads like `taskdriver.ai - no pane here is
   using this` (plain words, the reader has never used git; see CLAUDE.md "Every word on
   screen"). Never the word "orphan".
3. If a pane on this desk has that project OPEN (same repo folder, even if it did not start
   the server), name that pane instead: `taskdriver.ai - pane 4 has this project open`.
   That is the answer to Robert's actual question.
4. `cwd` for a pid: reuse whatever `main/devList.ts` already does; on macOS `lsof -a -p <pid>
   -d cwd -Fn`. A failed reading must leave the row exactly as it is today, never guess.

## Rules

- Read `docs/design-notes.md` section "...and it knows what is serving, and can stop one"
  BEFORE changing anything, and CLAUDE.md's section of the same name.
- An empty/failed reading is a FAILED reading and must not read as "nobody owns it".
- Extend `npm run test:devlist` (`scripts/devlist-test.mjs`): a server with no pane, a
  server whose project another pane has open, and an unreadable cwd.
- `npm run typecheck` and `npm run test:devlist` must pass. Commit on master with a subject
  in the repo's style (a sentence about behaviour, not a change list).
- Do NOT touch `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`, or anything under
  `scripts/try*` - another chat is editing those right now.
- Step budget: about 60 tool calls. One verification at the end.
