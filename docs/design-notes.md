# PaneForge — design notes

Why every rule in `CLAUDE.md` exists: the measurements behind each number, the traps that
cost hours, and the decisions not worth re-litigating. Headings match `CLAUDE.md`.

Read the matching section here before CHANGING one of those things. The rule in
`CLAUDE.md` is enough to work beside it.

---

# PaneForge

Electron app that hosts coding agents in panes. It hosts the chat you are reading this
in, which shapes every rule below.

## A dev server nothing can reach is closed, after a countdown

Measured 2026-09-01. `pf list` showed six panes and `devList.ts` showed two dev servers for
taskdriver.ai: pid 23918/23921, the launchd job `com.robert.taskdriver-dev-main`, holding
:3006 — and pid 58208 on ppid 1, up nineteen minutes, holding a Next compiler, a file
watcher and its memory while nothing could reach it. It had lost the port race at startup
and never bound anything. Nothing in the app could tell the two apart, because "what is
running" was the only question `devList.ts` was ever asked. Robert: "dev server uses
resources and i said its important to manage properly".

Three readings were considered and two were thrown away.

**"Does a pane own it"** is wrong: the supervised one has no pane either, and the whole
point of a launchd job is that nobody is sitting in front of it. **"Has it been quiet"** is
wrong for the same reason a healthy dev server is quiet all day — it is waiting for a
request. **ppid 1** is wrong because both of them were on ppid 1.

What separates them is whether anything can connect. A dev server holding no listening
socket is not serving anybody, whoever started it and however long ago, and that is
checkable in two seconds by hand (`lsof -nP -iTCP -sTCP:LISTEN`) — which is what makes it
safe to act on automatically. The card says the port, so the person reading it can check
the same thing in a browser while the count runs.

Two traps, both found by measuring rather than by reasoning:

- The socket is held by the CHILD. `devList.ts` deliberately folds `next dev` into the
  `npm run dev` a person typed, because killing the ancestor takes the tree — so the pid it
  reports routinely holds no socket at all. Judging that pid alone marks every npm-started
  dev server on the desk as dead. `servingDevs()` walks descendants; proved on the live
  table, where pid 23918 reads SERVING because 23921 below it listens.
- An empty socket table is a FAILED reading, not "nothing is listening". `lsof` can be
  missing, sandboxed or slow, and this app already has the rule elsewhere (an empty model
  list may never overwrite a good one). Here the failure mode is killing every dev server
  on the machine at once, so an empty reading stops the sweep.

The 90-second grace is the third measurement: `next dev` compiles before it listens, and a
cold start on this Mac took 11s. Anything shorter turns every start into a countdown.

A supervised job is refused outright — it comes straight back, so the kill wins nothing
and loses the log line saying why it went. macOS reads that from `launchctl list`; Windows
claims none rather than guessing, because Task Scheduler does not publish the pid of what
it started.


## Never close the app you are running inside

`PaneForge.exe` under `AppData\Local\Programs\claude-orchestrator` is the live app and
killing it ends this session mid-turn. To see a change, open a **second** copy:

```
npm run try                     # builds, opens as its own profile, minimized, no focus
npm run try -- --show           # same, but put the window on screen (still no focus)
```

Profiles (`src/main/profile.ts`) give that copy its own userData, single-instance lock,
config and taskbar button, so the live app is untouched. The profile name comes from the
folder name, so each checkout opens its own window.

## Lanes: more than one chat works on this repo

**The trunk is declared, never read off the main folder (2026-09-23).** taskdriver.ai's main folder was left on `feat/github-actions-usage-card`; lane.mjs took the root's checkout as the trunk, so every `ready` for 35 hours merged there (171 commits ahead of origin/main). Now `.lanes.json` `branch`, else origin/HEAD, else main/master. A root found off it is moved back by two ref writes when that changes no file AND the side branch already carries `merge lane` merges (the proof it was parked, not worked on - a pre-ship review showed a plain feature branch would otherwise be taken over and its next commit pushed). Anything else refuses the release and keeps the lanes ready. `lane-trunk-test.mjs`.

**Unused checkout folders are swept, work first (2026-09-23).** 18 taskdriver folders, ~36 GB, disk 94% full; nothing deleted a folder and non-`<repo>-<letter>` worktrees were invisible. `lane.mjs sweep`, started detached by `retry` every 6h (the app timer on the Mac, lane-cron on the PC; nothing scheduled runs on the Mac). Kept: ledger hold or cwd, ready/conflicted, locked, nested checkout, ANY `pf list` row (an asleep pane lists as `exited`), a process cwd (lsof; Windows uses a rename probe at the end), recent change (6h lane / 3d other). Zero-loss order from the reference script that ran for real: push named branch (never the trunk), temp-index snapshot to `wip/<folder>-<date>`, NUL-separated tar of untracked+ignored minus regenerable dirs, `fetch --prune` + origin-only containment proof, then a last look (fresh processes, no file written since start, same HEAD and work tree) before `worktree remove --force`. No pane answer = nothing removed. `lane-sweep-folders-test.mjs`.

**Copies are invisible, and a finished one goes at once (2026-09-23, later).** Robert: "see other copies 6 ... too confusing ... why other copies is just showing done". `done` meant "finished, waiting for the other chats so the batch merges once" - nothing for him to do. The sidebar now draws no copy list, no copy chip on cards, no copy dialog; `copiesNotice` gives at most one line per project, only for a clash no chat has taken (button hands it to a chat) or finished work held back 6h+ (reason, no button: saving can be a release elsewhere). The sweep's rule changed with it: a copy with ANY work (commits not on `origin/<trunk>`, any `status --porcelain` line) is never removed, however old - a `wip/` branch is lost work to a non-coder - and a finished lane folder is removed as soon as nothing uses it, no idle clock. The app's own sweep (laneWork `sweepLanes`, ~9 git per copy per project every 5 min, kept anything with an ignored file i.e. everything) is gone; main only starts `lane.mjs sweep` for the ended pane's project (`sweepCopies`). Measured with 3 idle shell panes, headless copy, 120s: v0.8.221 510 git spawns, session-start lane-b 31, after (see commit). Hook install: a dev/try copy resolved `getAppPath()` to its lane checkout and repointed every hook on the Mac there (seen live twice on 2026-09-23); only `app.isPackaged && !profileName()` installs now.
