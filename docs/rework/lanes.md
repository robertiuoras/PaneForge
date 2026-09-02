# Copies of a project: works for anyone, seen only when needed

Read `docs/rework/README.md` first. Engine `scripts/lane.mjs` (`DEFAULT_POOL` line ~291 is
`main,a..h` - eight copies), screen `src/renderer/src/components/LaneHelp.tsx` (the dialog
in Robert's screenshot), `LaneStrip.tsx`, `LaneDialog.tsx`, words `src/shared/place.ts`
(`copyNumber`: a=2, b=3 ... h=9). CLAUDE.md "Lanes", "Two desks, one repository", "Every
word on screen is read by somebody who has never used git" hold the rules.

## What is wrong today (his words + the screenshot)

- "copy 6, 7, etc still i think so complicated for any user". The Mac has PaneForge-a..h
  on disk: eight full checkouts of one repo, because the default pool is eight.
- "PaneForge right now: 4 lanes in use - copy 4 ... quiet 9h" - four copies held by chats
  that went quiet nine hours ago read as "in use". The 12h `STALE_MS` sweep is the only
  thing that frees them.
- The help text explains lanes to someone who has already met one. A person running one
  chat per project must never meet one, and the first time they do the app should say
  where the folder is and why.

## What it becomes - build straight

1. **Default pool is `main, a, b`** (three chats per repo). A repo wanting more says so in
   its `.lanes.json` `pool`. Write `"pool": ["main","a","b","c","d","e","f","g","h"]` into
   THIS repo's `.lanes.json` so Robert's own setup keeps its eight. `npm run test:lanes`
   pins the new default; existing worktrees beyond the pool are left alone (never delete
   a checkout).
2. **A hold expires on the fact.** A chat quiet past `HOLD_QUIET_MS` (2h, env-overridable,
   named) whose checkout is clean and not ahead is released by `status`/the sweep; a dirty
   or ahead checkout keeps its hold until 12h as today (lesson 2026-08-24: a ghost with
   commits must keep its hold). Test it in `scripts/lane-test.mjs`.
3. **The first copy explains itself once.** The moment the app makes copy 2 for a project
   (second chat on the same repo), one corner card (`.corner-stack`, with its X): "You now
   have two chats on <project>, so the second one works in its own copy of the folder:
   <path>. Finished work comes back into the main copy by itself." Shown once per machine
   (`config.seenCopyCard`). Never shown when no copy was made.
4. **Help dialog rewritten** for a first reader: three sentences, then the rows. Rows say
   the FOLDER path on the second line, `quiet 9h` becomes `nobody has typed here for 9h`
   and, past `HOLD_QUIET_MS`, `probably finished - will be reused`.
5. **Settings row (System tab):** `Give each chat its own copy of a project` with the one
   outcome sentence; off = a second chat on the same folder just shares it (today's
   behaviour when lanes are off). Confirm what a fresh install with NO claude-memory hook
   does when two panes open on one repo - `laneFor` in `src/main/index.ts` - and make the
   app-side path the one that works for a public user; the hook is Robert's extra.

## Rules

- `npm run test:laneplain`, `test:lanes`, `test:laneoverlap`, `test:lanepeers`,
  `test:place`, `npm run typecheck`, `npm test`.
- Never delete a worktree or a lane branch. Never touch another lane's dirty checkout.
- Commit on your lane, `node scripts/lane.mjs ready --repo <your dir> --session <id>`.
  No release. Report: pool before/after, holds released by the new rule in the current
  ledger (should be 0 today - the Mac ledger is clean), and the card's copy.
