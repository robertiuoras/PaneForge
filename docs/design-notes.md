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

Chats get started from other projects ("add X to PaneForge" from one, "fix Y" from
another) and would otherwise share this checkout: two builds writing one `out/`, two
version bumps, two releases minutes apart.

A hook assigns each session a lane automatically - `main` (this folder, master) or a
worktree `claude-orchestrator-a` / `-b` on `lane-a` / `lane-b`. Work only in the lane you
were given; writing into another chat's checkout is refused by a PreToolUse hook, not by
convention. `node scripts/lane.mjs status` shows who holds what.

None of that is about PaneForge, and since 2026-07-31 it is not only for PaneForge. Two
chats in one checkout of ANY repository overwrite each other's edits and race the same
index, so `lane.mjs` takes `--repo <dir>` and the hook passes whichever repository the
chat is actually sitting in. There is ONE engine - this file - driving every project on
the machine; a copy per repo would drift, and the only symptom of the drift would be two
chats quietly sharing one checkout, which is the thing lanes exist to prevent.

What a repository gets is decided by `.lanes.json` in its root, every field optional:

```json
{ "lanes": false, "branch": "main", "release": "merge", "pool": ["main", "a"] }
```

`release` is the whole difference between here and everywhere else, and it is a
declaration rather than a guess on purpose. `"version"` bumps package.json, tags, pushes
and publishes - which in a repo that deploys on push IS a production release, and no
project should start doing that because a script recognised an npm script name. So any
repo that is not this one defaults to `"merge"`: finished lanes are merged into its branch
and pushed, batched behind the same lock and the same cooldown, and no version is ever
cut. This repo's own `.lanes.json` says `"version"`, which is what it always did.

The branch is the repo's own - whatever the main checkout has checked out, so a project on
`main` rather than `master` needs no configuration at all. A repo with no remote, and
`claude-memory` (edited from every chat on the machine, by hooks as well as agents), never
get lanes. A chat alone in a repo is told nothing: it gets `main`, which is the folder it
was already in, and silence is the point - a line about lanes on every prompt in every
project is how a useful line stops being read.

**A visitor never squats `main`.** Twice (2026-08-07, 2026-08-09) a chat whose own
project was a different repository - its shell had merely cd'd here - claimed `main`,
finished in minutes, and then held the checkout for as long as its window stayed open;
every real chat in the repo was sent to a letter lane by a chat that had left. The idle
sweep could not help for an hour, because an hour of silence is the least a LIVE holder
deserves. Two rules close it. A claim now says whether its chat is a visitor - the hook
reads the session's home project off its transcript path, because `cwd` follows the
shell and is exactly how the squatter got in - and a visitor is handed a letter lane
while one is free, keeping `main` only when the folder holds uncommitted work to
protect. And a `Stop` hook runs `park` when any chat's turn ends: holds on clean lanes
are marked, the mark clears the moment that chat claims again, and a claim that needs a
parked `main` takes it after ten minutes (`PARK_STEAL_MS`) - at once when the parked
holder is a visitor. Nothing can be lost: one uncommitted character and `park` records
nothing and no steal touches the lane. `visitor-park-test.mjs` is the proof, and 8 of
its 14 checks fail on the engine as it was.

`npm run test:lanes` ends with `lane-anyrepo-test.mjs`, which drives the real script
against real throwaway repos on `main` with real remotes. It pins the two answers that are
easy to get wrong once a second repo exists: a repo that never asked for releases must
NEVER cut a version, and one that asked must cut exactly the version this repo would.
Finding it needed writing: a repository that has just turned releases on has a version in
package.json and no tag matching it, and `v0.1.0..HEAD` is a fatal "ambiguous argument"
that surfaced as `No release yet: Command failed` - a repo that could never cut its first
release and never said why.

### A conflict is cheapest at the first edit

2026-09-02: lane c (offload-first) and lane d (task brief) both inserted at `laneFor`, line
1371 of `src/main/index.ts`, the same afternoon. Neither chat knew about the other. d shipped
first; c sat conflicted on master and a pane spent its turn on the merge. CLAUDE.md's
peer-announce rule ("message the other chat naming the files before the first edit") had been
there for a week and nobody did it, because nothing told them there was anything to announce.

The engine cannot stop two chats editing one region, and it should not try: index.ts is
4,072 lines and 88 of the last 923 commits touch it, so refusing overlap would refuse most
work. What it can do is say so at the first edit, the one moment it is cheap. `lane.mjs
guard` now exits 0 WITH TEXT when the file being edited has hunks in another lane's working
tree that master does not carry - lane letter, folder, whether a chat is in it, line ranges -
and the hook folds it into the edit's context. Once per session, file and ten minutes; a file
nobody else changed is re-read at most once a minute.

The reading is `git diff <merge-base with master> -- <file>` per lane: a COMMIT against the
WORKING TREE. `git diff master... -- <file>` reads the same and is not: with one side omitted
it diffs to HEAD, so the uncommitted edit a live chat is making right now never showed. The
test fixture also has to `realpathSync(tmpdir())` - macOS's `/var` is a symlink to
`/private/var`, and the engine answers in resolved paths, so nothing prefix-matched and every
guard call, refusals included, passed. `scripts/lane-overlap-test.mjs`.

The structural fix is splitting index.ts into per-feature IPC modules, and it is a job for a
quiet moment with every lane merged: done while four lanes are live it conflicts with all of
them.

## Releasing happens by itself

There is one command, and it is not a release:

```
node scripts/lane.mjs ready --session <id>   # this lane's work is done and verified
```

`ready` marks the lane and then tries the release. It goes out when no chat is mid-work
any more - clean lanes, nothing uncommitted, nothing finished-but-unmarked - so whoever
finishes last releases for everyone, in ONE version bump. While another chat is still
editing it says so and does nothing; that chat's own `ready` (or the end of its session,
which marks committed work done on the way out) cuts the release instead. Wait for it
rather than shipping again.

Two things stop an automatic release, both reported by name: master not typechecking, and
a lane that conflicts with master. A conflicting lane is left out and keeps its mark - the
rest still goes out.

You will normally meet that conflict long before the release does. `ready` merges master
into your lane first and refuses to mark anything shippable until that merge is clean, so
the files are listed to you while you still have the context: resolve them, `git add`,
`git commit`, run `ready` again. `rerere` is on, so the resolution you do once is replayed
when the release merges your lane back the other way. A conflict left recorded is retried
by the running app every minute (`lane.mjs retry`), so the ones that stop being conflicts
clear and ship without anyone acting; the ones that need real editing are typed into a
pane that is not mid-turn. A paragraph about lane X appearing in your pane came from
there - it is yours to do. Once you `resolve` a lane it is yours for 45 minutes and
nothing will touch the merge you have open in it. Claiming a lane also heals it (an
unfinished merge left by a dead chat is aborted, a branch whose work master already has is
reset to master) and every lane merges master again after each release. Never leave a lane
sitting in a conflicted merge: it is the one state no other chat is allowed to touch.

`npm version`, `git tag vX`, and pushing a version tag by hand are blocked. `npm run ship`
still exists for a release you want right now, but nothing should need it.

Every automatic release used to be a **patch** bump, and the reasoning was sound as far as
it went: `ready` cannot express "this one is a minor", and a release batches several chats'
work, so no single chat is entitled to decide for the others. The conclusion drawn from
that - default to patch, ask for anything else by name - was the part that did not hold.
It made the version a build counter. Fifty-nine patches into 0.4 nobody could tell from
`v0.4.60` whether it carried a feature or a typo, and the `ship minor` that would have said
so was never typed, because typing it is a thing a person has to remember and no chat is
in a position to remember it.

The information was already in the repo. The subjects are Conventional Commits - it is what
the release notes above are built from - so the release can read its own bump off the range
it is about to ship (`bumpFor`, in scripts/release-notes.mjs): a `feat:` anywhere in it
makes the release a minor, everything else leaves it a patch. That decides per RELEASE
rather than per chat, which is exactly the objection that forced the patch default, and it
needs nobody to remember anything.

Two limits, both deliberate. A `!` (or a BREAKING CHANGE trailer) asks for a major and gets
a **minor** while the version still starts with 0 - the usual 0.x reading, and 1.0.0 is a
claim about the product that no commit subject is allowed to make on its own. And a bump
named on the command line is obeyed as given: `ship major` still cuts 1.0.0, `ship patch`
still forces a patch over a range full of features. `auto` is what the unattended paths
(`ready`, the session-end mark, the retry timer) pass.

**And then the rule above was too loud, so below 1.0 it now stops at the patch**
(`nextVersion`, same file, 2026-08-07). Read the argument two paragraphs up again with the
0.x part in mind: it is right that `v0.4.60` does not say whether it carried a feature, and
wrong that `feat:` is the thing that would say so, because below 1.0 nearly every commit
adds something. What the fix produced was not a meaningful minor, it was a faster build
counter with a shorter tail. In one day - 2026-08-06 into 08-07 - **v0.4.62 became v0.8.0
over six releases carrying seven commits between them, two of them `feat:`**, and four of
those six carried nothing at all (that half was the tag-drift bug, fixed separately in
v0.8.0). Robert's complaint is the measurement: he could no longer tell a week of work from
a one-line fix by looking at the number, and 0.4.x had been fine.

So below 1.0 the ladder is one rung shorter and every rung above the patch has to be typed:
a plain `feat:` or `fix:` moves the patch, `feat!:` is the only bump a commit may still ask
for and it gets a minor, and `ship minor` / `ship major` do exactly what they say because a
person said so. At 1.0 and above nothing is demoted and ordinary semver resumes - the
demotion asks the current version, not a flag, so there is nothing to switch off later.
`bumpFor` was left alone: it still reads the subjects honestly, and what a release may DO
with that reading is one function with the version in front of it. `npm run test:notes`
pins both halves.

`ship minor` by hand keeps its old caveat: the release page will say only what changed
since the last tag, so a feature list from further back needs putting on by hand
(`gh release edit`), AFTER the workflow's `notes` job has run, since that job rewrites the
body from its own range.

Automatic releases batch: one every **two hours** at most (`COOLDOWN_MS` in
`scripts/lane.mjs`). Inside that window `ready` says so and leaves the work on master,
where the next `ready` or session end takes it out. Do not "fix" that by running
`npm run ship` - a version per finished chunk is what produced fifteen releases in one
day. Reach for `ship` only when a specific build has to be in Robert's hands now, and say
why.

It was two hours originally, dropped to thirty minutes on the argument that a release
interrupted with a prompt and updates now install on exit, so one is cheap to ignore.
Measured 2026-08-20, that argument was half true and the half it missed is the one that
costs: **130 releases in the 14 days after v0.8.0 - 9 to 13 a day, peak 18, at 3.8 commits
each.** The prompt is gone, but a dev build is still a download, a restart to take it, and
a version number somebody has to read to know what is in it. Half an hour is shorter than
one build-and-verify cycle, so the window batched almost nothing: a release carried
whatever one chat had just finished, which is what no batching looks like. Two hours is
still same-day for every fix and roughly quarters the number of builds anybody installs.

The version NUMBER is a separate question and the answer is to leave it alone. "0.8.130"
reads like churn, and the demotion rule above (below 1.0, a `feat:` is a patch) is what
concentrates every release into the patch. Restoring `feat:` to a minor does not fix it -
it moves the same count onto the minor, since at this cadence most releases carry a
feature - and a 0.x shipping ten times a day genuinely has had 130 builds. Chrome is on
its 140th major for the same reason. Cut the rate, not the number.

### An automatic release runs the suite (2026-08-20)

Until this, `typecheckFailure` was the ONLY thing between a commit and a tag - and a
typecheck proves the types agree, never that the app works. All 130 of those dev builds
went out on that gate, several carrying bugs `npm test` already knew about, and the cost
lands entirely on whoever is running the dev channel: the app updates itself, restarts,
and is still wrong. That is Robert's complaint verbatim - "it keeps making versions which
are broken and not properly tested ... have to restart PaneForge a lot of times even if
it's dev and still have bugs."

`suiteFailure` in `scripts/lane.mjs` is the second gate, after the typecheck because it is
ten times the cost and a tree that does not compile cannot pass it anyway. `npm test` is
81 checks in ~145s and needs no window, no network and no agent CLI, which is exactly why
it is the right thing to hold a release to - it was already the gate the app applies to a
lane it drove itself (`src/main/agentGate.ts`), and the release path simply never used it.

Three decisions inside it:

- **Cached on the commit**, in the ledger every worktree shares. The app's retry timer
  calls `autoship` once a minute; uncached, a red master burns the whole suite every
  minute for as long as it stays red, and a green one re-proves itself for every attempt
  that then loses on some other check. A new commit is the only thing that invalidates the
  answer, which is the only thing that should - the suite is a fact about a tree.
- **A suite that could not START is not a suite that failed.** It reports as this
  checkout's tooling and is deliberately not cached: a missing `node_modules` is fixed
  outside this file and the next attempt should find out. Same distinction
  `typecheckFailure` draws, for the same reason - the sentence decides where the next
  person looks.
- **`npm run ship` still skips it**, along with the typecheck. It exists for a build that
  has to be in somebody's hands now and it is typed by a person who is watching.

`npm run test:gate` covers it against a real repo whose suite really runs: a red suite
stops the release and the failing check is quoted, a second attempt refuses without
re-running it, and a new commit re-runs and releases. The cache half is the one worth
having a test for - it is invisible when it works and expensive when it does not.

A lane is only ready while it still looks the way it did when it said so: edit or commit
again and the mark is dropped and the release waits for you, by name. Nothing to do about
it except mark ready again - but it means a release never stalls silently on a chat that
said done and kept typing (`scripts/release-gate-test.mjs` is that failure, pinned).

### Every automatic release is a dev release (2026-08-09)

Robert's ask, verbatim in intent: stop broken builds reaching the app he is sitting in.
Until now every `ready` fed the same feed his live copy polls, so a session's mistake
was on his desk within the half hour and the fix cost more releases - the version
number had become a mistake counter. The missing piece was a channel between "the lane
engine released it" and "everybody runs it".

The mechanism is GitHub's own, which is why it is small. A release cut with the
prerelease flag is invisible to `/releases/latest`, and `/releases/latest` is exactly
what a stable electron-updater resolves (`GitHubProvider.getLatestTagName`; the token
path's `PrivateGitHubProvider` appends `/latest` the same way - both were read, not
assumed, in `node_modules/electron-updater@6.8.9`). Flip `allowPrerelease` and the same
provider reads the newest atom-feed entry instead - every build, the moment it is cut.
So: `releaseType: "prerelease"` in `package.json` and `--prerelease --latest=false` in
the workflow's `gh release create` make every automatic release a dev one, and
`config.devUpdates` → `setDevChannel()` → `allowPrerelease` makes any single install
the copy that takes them. The flag is re-asserted on every check, not trusted from
wiring time, because a setting that changes at runtime must not need a restart to mean
anything. The Mac's fallback path (`macFallback`, which answers from the releases API
when a release carries no mac feed) had `/releases/latest` hardcoded and would have
quietly pinned a dev-channel Mac to stable - it now asks per channel.

Tags stay plain (`v0.8.29`, never `v0.8.29-dev.1`): the GitHub prerelease FLAG is the
channel, so promotion is one metadata edit and stable installs update to exactly the
bytes the dev channel proved. A `-dev` suffix would have meant retagging or rebuilding
on promote - a second artifact that is precisely NOT the one that was tested.

`lane.mjs promote [version]` is the only door to stable, and it re-checks the two
failures this repo has already shipped before flipping the flag: a one-legged release
(v0.7.2 Windows-only, v0.8.0 Mac-only - either platform's feed missing) and a feed
whose declared size disagrees with the asset actually served (v0.4.27, the hash-check
death with no reporter). It then verifies `/releases/latest` really answers the
promoted tag, because the claim is what stable installs will see, not that an edit
exited 0. `doctor` lists what sits unpromoted so a quiet dev channel is visible;
`status` deliberately does not - it must stay offline.

Promotion is normally not typed at all (2026-08-10). The channels follow the shape
every big vendor converged on - Chrome Canary→Stable, VS Code Insiders→Stable: the
fast channel churns per release, stable takes batched, proven jumps. The promotion
signal is a QUIET PERIOD: `autoPromote` (on the `retry` minute timer, throttled to one
releases lookup per `PF_PROMOTE_POLL_MS`, default an hour) promotes the newest dev
build once it has sat `PF_PROMOTE_SOAK_MS` (default 3 days) with nothing shipped on
top of it. Age-of-newest is the whole test on purpose: a newer build landing resets
the clock, so "3 days with no fix needed" and "3 days of dev installs running it" are
the same fact - the dev channel (Robert's own machines) is the canary population. The
flip itself goes through `promote('')`, so an auto-promotion is refused by exactly the
checks a typed one gets, and a refusal is printed and re-tried next poll rather than
escalated - `doctor` says what waits and when. Hand `promote [version]` remains for
the one case batching is wrong: a bad build already on stable, where the fix must not
wait out a soak. The known cost: daily churn defers stable indefinitely, which is
read as "not settled yet", and doctor keeps it visible.

Older installs (≤ v0.8.28, `allowPrerelease` never set) already resolve
`/releases/latest`, so they wait for promotions correctly without knowing the channel
exists. `install.sh` / `install.ps1` and the README's fixed-name links all go through
`releases/latest/download/`, so a first-time install is always the promoted build.

`npm run test:promote` drives the command against a stubbed `gh`; `test:updater` pins
the channel flag's default, its flip, and its re-assertion per check.

The checkouts on disk are `PaneForge`, `-a`, `-b`, `-c`. They used to be
`claude-orchestrator*`, and `scripts/rename-repo.mjs` moved them: `git worktree move` for
each lane, then the main checkout, then `worktree repair`, then the lane state's stored
paths. `scripts/rename-repo-test.mjs` (`npm run test:rename`) still proves it on a
throwaway repo, including that the worktrees answer git from their new paths. Both names
still resolve everywhere - `laneBoard.ts`, the lane hook in claude-memory, `try.mjs`'s
profile naming - so a Mac that has not been renamed keeps working.

What held it up for two days is worth keeping: the script's guard tests "in use" by
renaming the folder and putting it straight back, and that kept failing with EBUSY while
NO process had the folder as its working directory. The holder was an orphan headless
`conhost.exe` from a pane whose chat had died, plus `git rev-parse --git-common-dir`
processes hung there for 23 hours. `handle64 -u <dir>` is what names such a holder;
nothing in Node or PowerShell will. The hung git is fixed at the source - every `git()`
in `scripts/lane.mjs` now has a 20s deadline, so a stuck git can no longer outlive the
chat that spawned it and squat on the checkout.

The scheduled task (`PaneForgeRename`) that was going to do this unattended has been
deleted; `Projects/.autosync/paneforge-rename.mjs` is its harmless leftover copy.

`package.json`'s `name` stays `claude-orchestrator` on purpose - Electron builds
`%APPDATA%\<name>` from it, so changing it moves the installed app's config, workspaces
and single-instance lock. That is a migration, not a rename, and it buys nothing anyone
can see.

## An update may never need a person

The promise is the one every installed app makes: install once, update from the app, for
ever. Measured against it, this app has failed three times, and every failure was the same
shape wearing a different coat.

**2026-08-06.** The Mac sat on 0.4.45 from Aug 3 with the badge frozen at 33%. Cause was
`fetchTo` in `macUpdate.ts` never settling when the v0.4.62 body stopped arriving at exactly
30 MiB of 95.8 MB - no `'error'` handler, no `'aborted'` handler, a truncated body reaching
`'finish'` and resolving. v0.6.0 settled every path in that file, added a watchdog on BYTES
rather than on the socket, and raced staging against a 30-minute deadline.

**2026-08-07, the next morning.** Same Mac, same 33%, still 0.4.45. Nothing had regressed:
**v0.6.0 fixed the updater in the release, and the updater is what delivers releases.** A
machine whose updater is the wedged component never receives its own fix. Quitting installed
nothing either, because the quit swap asked `phase === 'ready'` and the phase said
`downloading`. The only way back was replacing `/Applications/PaneForge.app` by hand.

Three lessons, and only the third is structural.

1. **A fix to the update path needs an out-of-band install for the machines already stuck,
   and that is part of shipping it, not a follow-up.** Here that is a detached watcher
   holding the app's own `swap.sh` open, waiting on the running pid.
2. **A phase is a live flag; a staged bundle is a fact on disk.** When the two disagree the
   fact wins. `stagedInstallable()` reads memory only (set at launch by `adoptStaged()`),
   because it is called on the way out and must not scan or delete anything. Installing a
   build older than the one that failed to download is right: it is still newer than what is
   running, and the next launch looks again.
3. **The recovery may not live inside the thing that can hang.** This is the whole of it.
   Settling our own downloads fixes one promise and leaves the shape intact, and
   `electron-updater`'s check and download are not ours to settle at all. So:
   - `set()` stamps `phaseAt` on a phase CHANGE (a percent tick must not restamp it, or a
     download that stalls at 33% looks fresh for ever). `busy()` drops a transient phase
     past its budget and logs `wedged`. Budgets are generous - hotel wifi must never trip
     one - and every one is env-overridable so the test takes 150ms instead of 45 minutes.
   - `probing` is the same flag one size down: `supersede()` sets it, discards every update
     event while it is set, and unwinds it in a `finally` a hung check never reaches. Same
     treatment, `PROBE_BUDGET_MS`.
   - **The poll is armed before the await as well as after it.** `arm()` lived only in
     `pollOnce`'s `finally`, and `finally` is not reached while an await hangs - so one
     unsettled promise did not merely wedge the phase, it ended the background poll for the
     life of the process, leaving nothing to notice the wedge or undo it. A healthy turn's
     `finally` re-arms at the ordinary cadence and replaces the watchdog, so nothing polls
     faster than before; only a turn that never returns is affected.

`update-health.json` is the fourth piece and the cheapest: `lastGood`, a count of recovered
wedges, and the last one's name. A recovered wedge otherwise leaves no trace once the phase
resets, and the thing worth knowing is never any single one - it is "this machine has not
had a good look at the feed in four days". Silence is what made the last one cost a day: an
empty log reads exactly like nothing to do. Three days logs `health STALE`.

`npm run test:wedge` (also the second half of `npm run test:updater`) hangs the stub on
purpose - a promise with no ending at all, not a slow one - and asserts each of the four
recovers unattended, including the reported symptom itself: `download-progress` at 33%,
which is the exact number this Mac sat on. The staged-bundle half runs for real on macOS and
skips out loud elsewhere. Writing it caught one thing worth keeping: the first attempt never
reached the hang, because the phase was still `checking` from the previous case and `busy()`
correctly refused - a test of a recovery path has to reach the failure first.

## Never take the screen

The app hosts the chat and runs all day beside real work, so nothing it does on its own
may take focus, raise a window, or pop a dialog. Only a click or a hotkey earns the
foreground.

- Show a window the user did not ask for with `showInactive()`, never `show()`.
  `focusWindow()` is for user-initiated paths only.
- A launch nobody asked to see (`npm run try`, i.e. `--minimized`) shows nothing at all on
  macOS. `revealPlan()` in `src/main/profile.ts` decides that per platform: Windows still
  has to `showInactive()` then `minimize()`, because a window that was never shown cannot
  be restored from its taskbar button - but doing the same on a Mac is a window appearing
  over your work and genie-animating into the Dock on every launch, which is what
  developing PaneForge felt like all day. The Dock icon of a running app is the way back
  in: `activate` (and `did-become-active`, for Cmd-Tab) reveals it, ignoring the
  activation macOS emits for the launch itself. `npm run test:quiet` pins both halves.
- A restart the app decided on (update, admin relaunch) calls `markQuietRelaunch()` in
  `src/main/profile.ts` before exiting. The new process consumes that marker, starts
  `inactive` and flashes the taskbar button once instead of stealing the keyboard.
- No `dialog.showMessageBox` for anything the app decided by itself - in-renderer cards
  (`UpdateToast.tsx`) instead. No `setAlwaysOnTop`, no `moveTop`, no `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true`; a console flashing is a focus
  steal too.
- `second-instance` must not raise the window while `installStarted` is set: mid-update
  the installer's launch of the new exe arrives on that event.

Holding the screen back is allowed to delay the window. It is not allowed to lose it, and
for a while it did. `gameMode.ts` has an escape hatch for "a game that is RUNNING is not a
game that is ON SCREEN" - `setFocusProbe`, which answers whether our own window is visible
and focused. At the launch reveal that window is the one which has deliberately never been
shown, so the probe is false by construction: a game merely left running held the reveal
back, and the reveal was the only thing that could ever have made the probe true. With
cs2.exe up for hours at a time on this machine, "until the game exits" was not a wait, it
was a stop - a live app with no window and no taskbar button, which looks exactly like an
update that failed to restart, and got reported as one twice.

So the foreground window's process is now asked about directly, in the two places where
the answer decides whether the app gets to exist on screen: the launch reveal, and work
already sitting in the deferred queue. Alt-tabbing out of a game is enough; it no longer
has to close. The query is a P/Invoke through PowerShell and costs ~600ms, which is why
the 15s poller still uses `tasklist` and this is asked ONLY while something is being held.
Every failure mode answers "not a game" on purpose.

Two numbers to keep, both measured rather than assumed: main reaches `whenReady` in ~307ms,
so a launch that appears slow is never boot - every boot line carries `+<ms>` since process
start now, precisely so the next report of "it came back too slow" has a figure instead of
a silence. And that ~600ms is why `test:quiet` waits for the reveal decision to appear in
the log rather than sleeping a fixed 2.5s past it; with a game genuinely on screen it SKIPS
out loud, because a file that cries wolf every time there is a game up is how a real
regression here gets waved through.

## Two machines, one desk

`src/main/remote/` lets a second device drive this one's panes. Both ends are peers -
each can host and each can connect out - so there is no setting deciding which machine
you have to be sitting at.

The pty never moves. A mirrored pane's agent, checkout, transcript and worktree all stay
on the device it was opened on; the other window watches and types. Moving a run would
mean moving the folder it is editing, which is the one thing that cannot be done over a
socket. "Continue where I left off" is therefore *remote control*, not migration.

Handoff (v0.8.37) is the third answer, between those two: not moving the pty, and not
merely watching it, but moving the three things a pane is FOR and starting a new pty on
top of them over there. The insight that makes it small is that each of the three
already has a transport: the code's is the git remote (the sender commits dirty work as
an `auto-sync:` subject — which the deploy guard ignores — and pushes; the receiver
clones or fast-forwards), the conversation's is the CLI's own `--resume` (the transcript
jsonl is the only payload that has to cross the link, chunked because the wire caps a
frame at 8 MB and transcripts run to tens of MB), and the screen's is the pane history
file the scrollback-restore path already reads (`scrollbackId` pointing at a seeded
log). `main/handoff.ts` takes every dependency as an argument and imports nothing from
Electron, so `test:handoff` drives BOTH ends against real repositories and a real
loopback link with only the pty captured.

Two refusals are the safety of it. The receiver never touches a checkout that has
uncommitted or unpushed work — that is another machine's live state, and the lesson list
is full of sessions that clobbered one — and the sender kills its pane only after the
far end has answered that the replacement is running, so a refused or failed handoff
costs nothing. Paths cross machines by grafting the pane's position relative to the
sender's projects root onto the receiver's (`mapCwd`, case-insensitive because one end
is Windows, realpath-tolerant because macOS tmp and linked roots lie about themselves).
The far pane goes through `laneFor` like any local launch — and the transcript is
written AFTER placement, because a lane split moves the cwd and the CLI reads
transcripts from a folder named after the cwd it actually starts in.

Session ids are the seam. A mirrored pane is `@<device>/<id>`, and `remote.owns(id)` in
`main/index.ts` routes every pane message to the link instead of the pty manager - so
the sidebar, the palette, the grid and every shortcut treat it as an ordinary pane.

Three decisions worth not re-litigating:

- **The host owns the terminal's size.** A mirror is drawn at the far end's cols/rows
  (carried on `Session.cols/rows`) and shrinks its own font to hold them. Two windows
  both fitting one pty trade SIGWINCHes forever, with a full-screen CLI repainting its
  whole frame every round.
- **A mirror never reports the busy footer.** The device the agent runs on is reading
  the same frame in its own window, a few frames ahead; a second opinion arriving late
  can only contradict it, and a false "finished" is the chime firing mid-turn.
- **Frames are decoded where they are consumed, not where they arrive.** The last
  handshake frame and the first encrypted one routinely land in one TCP segment.
  Decoding eagerly read ciphertext as JSON and killed the link a moment after it came
  up - and whether it happened depended on how the kernel split the packets, so it
  looked like a flaky network. `scripts/remote-test.mjs` pins it.

The pairing code is the whole secret: never sent, only proved, and the traffic keys are
derived from it (scrypt, then AES-256-GCM per direction). That is why rotating it cuts
every paired device off rather than just changing what to type next time. Hosting is off
until switched on, and discovery is a UDP broadcast that carries no secret.

### Pairing two desktops with no code typed, and what actually authorises it

A phone can scan. A desktop cannot, and the invite blob only replaces typing when the two
machines share a clipboard — a Mac and a Windows PC do not. So the seamless path for two
desktops is the other shape: **tap the device you found, it asks, somebody approves over
there.**

The thing to be careful about is what that button proves, which on its own is *nothing*.
The pairing code proved the person had been at the other screen. A card saying "Gamer-PC
wants to pair" proves only that something on the network sent a name it chose. So the
authentication is moved into a number:

- The two ends agree a secret over X25519. That defeats an eavesdropper and does **not**
  defeat a machine in the middle, which simply agrees one secret with each side.
- Six digits are derived from the shared secret **and both public keys**. A relay
  necessarily holds two different secrets, so the number it can show the joiner is not the
  number the host computes. The human comparing two screens is the check; this is Bluetooth
  numeric comparison, and it is why the card leads with the digits rather than the name, and
  why the same block is drawn on the waiting side too.
- Six rather than four: an attacker gets one guess at a mismatch passing unnoticed, and six
  makes that one in a million.

`scripts/pair-ask-test.mjs` stands up a **real relay** — a server that faces the joiner as a
host and asks the real desk at the same time — and asserts the two numbers disagree. That
case is the reason the file exists; everything else in the flow could have been checked by
using it.

Two decisions that keep the blast radius small:

- **Approval hands over the ordinary pairing code**, sealed to the agreed secret
  (AES-256-GCM), and the joiner then reconnects through the existing code path. Stored
  peers, reconnects, and `New code` cutting everyone off all keep working unchanged, and the
  new crypto exists only for the length of one pairing.
- **The ask socket is never armed and never becomes a guest.** It carries no session, which
  is why `host.list()` stays empty across the whole exchange.

`PROTOCOL` stays 1. `askpair` is a third message type in the second slot of the same
handshake, and a build that predates it fails to recognise it and refuses — which is the
right answer, because it has no way to show anybody a card. Bumping would have broken every
already-paired device to announce a path neither end would ever take with the other.

The wait is a person, so it gets its own budget (`APPROVE_MS`, two minutes) rather than the
handshake's ten seconds. That budget exposed a real gap the tests caught: `server.close()`
does not touch a socket that is already open, so switching hosting off left the far end
watching "waiting for approval" until its own timeout, with nothing left here that could
ever answer. `RemoteHost` now tracks sockets that are connected but not yet guests and drops
them in `stop()`.

The Approve card is rendered from `App`, not from the Devices dialog: the request arrives
while somebody is standing at the *other* machine, so a card only that dialog could show is
a request nobody would ever answer. It obeys "never take the screen" — corner, not modal, no
focus stolen, no window raised; the focus it does take is within the window, so Enter is
Deny.

## The phone is this window, served

There is no second app and there will not be one. Every runner in the category shipped a
phone client in the last nine months and they all shipped the same one - the desktop keeps
the agent, the phone watches it and answers it - and T3 Code, Orca and the rest each
maintain iOS + Android + web + Electron to do it. We maintain one renderer, because the
renderer imports nothing from Electron and nothing from Node: it is pure UI over
`window.api`. Supplying that object over HTTP is the whole client (`src/main/phone.ts`,
`src/renderer/src/browserApi.ts`).

What actually stopped it before was not the UI and not the transport. It was that the
mapping from method name to IPC channel existed only as 141 hand-written closures inside
the preload, so a second transport meant re-typing every one and drifting the first time
anybody added a channel - the `promptKey.ts` failure mode, a lookup that quietly stops
finding things. So the mapping is data now, in `src/shared/surface.ts`, typed as
`{ [K in keyof Api]: SurfaceEntry }`: a method added to `Api` without a channel does not
compile, and both transports are built from the one list. The preload is 38 lines.

- **Calls land in the app's own handler, not a copy of one.** Electron has no public way
  to call your own `ipcMain.handle` body (`_invokeHandlers` is private and a rename from
  breaking in silence), so `src/main/ipcTap.ts` records the registrations as they happen -
  which is why `tapIpc()` runs at the top of `index.ts`, above them. 134 of the 135
  handlers ignore the event object; the one that does not is `recents:drag`, handing a file
  to the OS drag layer, and it gets a sender that says it is gone rather than a fake window.
- **Events down one stream, calls up as POSTs.** SSE, not a WebSocket: the repo has three
  runtime dependencies and a socket here would mean a fourth or hand-rolled RFC 6455
  framing. SSE also reconnects by itself, which is what a phone locking its screen needs.
  `send` is fire-and-forget AND ordered - a keystroke then a resize must arrive that way
  round - so the client queues sends, keeps one request in flight, and a burst of typing
  collapses into one POST. `broadcast` sits *ahead* of the window check in `send()`: a
  phone must keep receiving output while the window is minimized or being rebuilt.
- **Off until switched on, and the code is the door.** Anything that can type into a pane
  can run commands on this machine. An unpaired browser gets one 40-byte page and nothing
  else - not the UI, not one asset - and five wrong codes buys that address a minute of
  silence, including for the right code, because guessing is what is being stopped.
- **The cookie is derived, never stored**: `hmac(deviceId, code)`. A restart does not sign
  every phone out and rotating the code signs all of them out at once, with no token file
  to keep in step. The code is six characters from an alphabet with no vowels and no
  lookalikes: it is typed once, on a phone, off the screen in front of you.
- **What stops `/../../secret` is normalizing an absolute path**, which folds away every
  `..` that would leave the root - not the `startsWith('..')` line, which is a backstop for
  the day the input stops being absolute. Proved by mutation: removing that line fails
  nothing, removing the auth check fails eight assertions.
- **Bytes travel as base64** (`shared/wireJson.ts`). Two calls on this surface carry a
  `Uint8Array` and plain JSON turns those into `{"0":12,...}` - four times the size, and on
  the way back an object the caller reads NaN out of.
- **A phone is not a small desktop.** The window is a 282px sidebar beside the panes; at
  414px that leaves a pane 132px wide, which is a 16-column terminal - not a small version
  of this app, a broken one. Under 720px the two take turns (`handheld.ts`, one `@media`
  block in `styles.css`): the list is the home screen - it already says which project,
  which agent and who wants you, and it already holds Fleet, Swarm, search and Settings -
  and a tapped pane gets the whole display with one 34px chip back. The tap has to hand
  over the screen even when that pane was already active, which is the normal case coming
  back from the list, so the row's click says so rather than something watching `activeId`.
  One of the two halves is `display: none` rather than translated away: an xterm laid out
  at 0px reflows its buffer to one column and does not come back.
- **The pty never moves**, exactly as in the section above. A pane's agent, checkout and
  transcript stay on the machine the pane was opened on.

`npm run test:phone` is the server with no browser and no Electron: what it refuses, what
it routes, and the parity - every method on the surface has a handler in `src/main`, the
preload names no channel of its own, and every event `send()` pushes is one the surface can
subscribe to. `npm run test:phoneview` is the half that test cannot reach: system Chrome,
headless, at 414x896, against a running copy. It types the code into the pairing page the
way a person does (the cookie is HttpOnly - there is no shortcut), opens a pane *from the
browser*, types into it and reads the echo out of the terminal's own buffer, then measures
the handheld layout. Reading that echo out of `document.body.innerText` finds nothing, ever:
xterm draws to a canvas, so the text is in `window.__pf[id].term.buffer`, and a test looking
in the DOM fails against a perfectly live pane.

Not built, and the UI does not pretend otherwise: there is no headless host (the app has to
be running - TODO B1) and no phone-first diff view (H2). Reaching it from outside the
network is a tailnet address, which is why `phoneUrls` sorts 100.64/10 first.

### Scanning asks; a press on the desk answers

The QR carried the code for a while, in the fragment, and that solved the typing. It did not
solve the thing underneath it, which only became visible when Robert asked to see "the
connected devices" and there was nothing honest to show: **the cookie was
`hmac(deviceId, code)`, so every browser that ever used the code held the identical one.**
There was no list of who was in, no way to remove one of them, and `New code` - which signs
out all of them at once - was the only revoke that could exist. A per-row `Disconnect`
button would have been a lie: the stream returns immediately, because the cookie is still
good.

So the picture is now the bare address and the secret is minted at the other end. The phone
opens the link, `POST /pf/ask` raises a card on this desk with four digits that are on both
screens, and Approve mints **that browser** a 32-byte token. What follows from that one
change:

- there is no secret on screen at all, so a photograph of the Devices panel is worth
  nothing, and nothing has to be read across a room;
- a device can be signed out **by name**, and it means it - `who()` looks the token up in
  the list on every single request, so the stream ends and the next request gets the pairing
  page (verified against a running copy, not only in tests);
- an approved phone survives restarts and the app's own updates, because the list is in the
  config like everything else that has to outlive the process;
- the four digits are not a password and are never sent by the browser. They are generated
  here and shown in both places, so Approve is a statement that *the phone in your hand is
  the one that asked*.

Nothing is granted by asking - the card is a refusal until it is answered. Anything that can
reach the port can raise one, which is what an open port means, so: one request stands at a
time, five per address per ten minutes, two minutes to answer, and the card says where the
request came from. An `internet` origin (which is what a tunnel makes every phone) is drawn
in the warning colour rather than like the phone in your pocket, because those two are
answered differently. The whole thing is a switch; off, the QR goes back to carrying the code
in the fragment and the old zero-tap path is exactly as it was.

The code is still there, still typed on a phone with no camera, and `New code` still signs
out everything that used one. What it no longer has to be is the only way in.

### The code in a fragment, and why not an account

Six characters is small, and it was still the only typing left in the product, done in the
worst place there is to type: an on-screen keyboard, phone in one hand, copying off a screen
a metre away. So Settings drew the address and the code together as a QR, the camera app
opens it, and pairing is one tap. That is the fallback path now, not the main one.

**OAuth and email were asked for and refused, and the reason is not effort.** Both are
identity services, and identity is not the question this link asks. What is behind the code
is a pane, which is a shell on this machine, on this network - and every part of that
sentence is local. An OAuth flow would need a provider, an internet round trip and a public
HTTPS redirect target, which `http://192.168.1.23:7312` categorically is not (Google, Apple
and GitHub all refuse a private-IP redirect URI); that means a cloud service PaneForge does
not have and should not want, and it means the desk cannot be paired to on a network with no
way out. Email is worse in the way that matters: a magic link is a bearer token for a shell,
sent through a third party, sitting in a mailbox for ever, and it is *slower* than typing six
characters. Both trade a secret that never leaves the room for a secret that leaves it, to
save six keystrokes.

The QR keeps the secret in the room, and the shape of the link is the careful part:

- **The code rides in the fragment**, `<address>/#<code>`, not the path and not a query. A
  browser never sends a fragment to the server, so the code is in no access log, no proxy in
  front of this, and no `Referer` of anything the app loads afterwards. The pairing page
  reads it and POSTs it exactly as a person would - same endpoint, same lockout counting it -
  and then drops it out of the address bar with `location.replace`.
- **A wrong or stale scan falls through to the form.** The page is the same page; scanning
  only fills it in.
- `src/shared/qr.ts` is the encoder, no dependency and nothing downloaded. Byte mode, error
  level M, versions 1 to 6 - the longest address this app can produce is
  `http://255.255.255.255:65535/#ZZZZZZ` at 36 bytes and version 5 holds 84. Stopping below
  version 7 is what keeps it under 300 lines: 7 is where a symbol starts carrying a second
  version block with its own table and BCH code. It **throws rather than truncates**, because
  a QR that encodes half an address still scans, and sends the phone somewhere wrong.

**The test decodes; it does not compare.** The first version of that file built the generator
polynomial in reverse - `next[j] ^= mul(poly[j], EXP[i])` where it needed `next[j] ^= poly[j]`
- so every error-correction codeword was wrong. The symbols had the right version, the right
size, the right finders, timing patterns and alignment patterns, and the right data modules;
they differed from a reference encoder's output no more than a different mask choice would;
and not one of them could be read by any scanner. `npm run test:qr` therefore reads the drawn
symbol back the way a scanner does - format bits for the mask, the zig-zag walk,
de-interleave, every Reed-Solomon syndrome must be zero, then the payload out - for every
version at every mask, plus one fixture of error-correction codewords taken off a symbol an
independent encoder produced. Nothing weaker catches this class of bug. (Encoders differ
harmlessly on how much zero padding follows the terminator, which is why that fixture pins
the arithmetic directly instead of comparing finished symbols.)

`test:phoneview` covers the other half: a real headless Chrome opening the scanned link and
landing in the app with nothing typed. Each case gets its own target, because a URL that
differs only in its fragment is a same-document navigation - assigning `location.href` does
not reload the page, the inline script never re-runs, and the result reads exactly like a
broken feature.

### The desk owns a pane's shape; a phone borrows it

The remote link settled this question for two machines - "the host owns the terminal's
size", above - and the phone was never asked it, because the phone is not a mirror. It is
this renderer, drawing the same pane over HTTP, and it fits the pty to its own screen
exactly as the window does. So both of them did, and whoever spoke last won.

Measured on 2026-08-11, reproduced against a running copy: the desk fitted its pane to
157x57; a phone opened that pane and the pty became 50x49; the phone was then closed, and
minutes later the desk terminal was still 157 columns wide with the pty at 50, so the CLI's
output filled the left third of a full-width pane and stopped. The report was "the pane is
broken, half split in terminal" and the guess attached to it was low power mode. Nothing in
the app had ever undone a phone's resize - there was no code path that could.

The rule is one sentence: the desk owns the size, a phone borrows it. `resize` carries a
`borrowed` flag, a borrowed resize leaves `deskCols/deskRows` alone, and `returnSizes` puts
every borrowed pty back and asks the CLI to repaint. It is called from the two places a
phone stops looking: `pty:return`, sent when the handheld list comes back, and `onIdle`,
when the last phone stream closes - the second because a browser that is closed, locked or
carried out of range never gets to send a parting message. A desk resize takes ownership
back on the spot, which is the case that would otherwise rot in silence: a phone that
borrowed hours ago must not snap a window the user has since resized by hand.

The same handover explains the other half of that report - "when I open a pane it is all
messed up and I have to clear it, then it is fine". Everything on the phone's screen was
drawn at the desk's width, and the CLI hard-wrapped those lines itself: its box drawing, its
input frame and its paragraphs are all 157 characters wide, so re-wrapping them at 50 is not
history, it is soup, and `/clear` was the only thing that got rid of it. A phone now clears
the buffer itself when the COLUMNS change and asks for a repaint. `clear`, never `reset`:
clear keeps the line the cursor is on, so a plain shell is left holding its prompt rather
than a blank pane - a shell has no frame to repaint and the redraw poke would print nothing
back. Deliberately outside the `autoFixUi` switch and the mount grace that guard the ordinary
post-resize repaint: those are about not poking a CLI mid-paint, this is about a frame that
is already unreadable, and a phone's first tap usually lands inside that grace. Columns only,
because the keyboard opening takes rows away and nothing re-wraps - a reset there would wipe
the screen while somebody was typing into it.

`npm run test:panesize` pins the bookkeeping without a window or a pty: borrow, return,
return twice, and the desk overruling a borrow. Proved red by making a borrowed resize
overwrite the desk size, which is what the code did before - four of its thirteen checks
fail, the first being that returning gives back 50x49.

### A phone's pane header is made to fit, and a tap lands on the first press

Measured at a real 414px viewport before either fix: the pane's own header wanted 458px of
the 404 it had, so the folder button, the editor button and Close were off the right-hand
edge with nothing to scroll them back, and the two that were reachable - Clear and Fix -
were 27x23 and 30x19 against a 44px finger. "I cannot see the header, it is not easy to
swipe and see the rubbish bin and the fix buttons" is that, exactly.

Making it scroll would have been answering the complaint with the thing being complained
about, so it fits instead. The path goes, because it is the line under the pane's name in
the list you came from. The folder and the editor go (`desk-only`) for the same reason a
mirrored pane never shows them: they open a window on a machine you are not holding. What
is left gets 36px, and the row now measures 404 against 404 with every button on screen.

The tap needed no layout at all. A finger is never still, and a mobile browser throws the
`click` away the moment it decides the gesture was a scroll - so the first tap on a card was
spent proving it was a tap, and the second one opened the pane. A touch that did not become
a drag now opens the row from `pointerup`, which no scroll heuristic gets to veto. A
`pointercancel` is the browser taking the gesture away to scroll with it and opens nothing,
and neither does a finger that travelled more than `TAP_SLOP`. Mouse presses are untouched:
a click is reliable there, and `onClick` is also what catches keyboard activation.

## Every colour is derived, and every pane says which project it is in

Two rules that touch nearly every file in the renderer, both added 2026-08-01.

**There is no palette.** `src/shared/theme.ts` computes one from a single accent, and the
window reads it as CSS variables written onto `:root` by `applyTheme`. The literals still
at the top of `styles.css` are the ~40ms fallback before a config loads, not the source -
change them and you change the flash, nothing else. Adding a colour means adding it to
`paletteFor`, never to a component.

The maths is Oklab, hue and chroma held while lightness sweeps, because per-channel RGB
clamping does not desaturate - it HUE-SHIFTS, so a violet surface quietly becomes a blue
one at the dark end of the ramp and nothing says why. `inGamut` binary-searches the chroma
that fits instead.

Nothing about the ladder was chosen; it was fitted. The palette that shipped measures
L 0.1462 / 0.1749 / 0.2035 / 0.2391, so the steps are 0.0287, 0.0287, 0.0356 - which is
where the `0, 1, 2, 3.24` multipliers come from, and where `depth ^ 1.93` comes from: that
exponent is the one putting the shipped `depth: 0.3` exactly on 0.1462. Linear it landed
at L 0.32, a mid grey, because a slider whose ends are black and white spends most of its
travel in a range no dark UI uses. The consequence to remember is that **light themes live
above ~0.9 on that slider**, which is why Paper is 0.98 - at 0.72 it rendered #6d6b68 and
at 0.95 #d2d0cd, both measured in the real window and both dingy.

`npm run test:theme` is 358 assertions and its load-bearing half is contrast: every preset,
and every hue on the wheel at full tint, must clear 4.5:1 for body text and 3:1 for the
grey second lines. That is the only failure this feature has and it is invisible to whoever
picked the colour - they know what the text says. It also pins that a config nobody has
touched still draws the app that shipped.

The default accent `#f0a868` is the icon's own top ember pulled off full orange. The
sidebar mark is the icon's geometry (`split: 0.415`, gap 0.043, radius 0.032 from
`make-icon.mjs`, inset removed) in `currentColor`, so it follows the accent. Before this
the two marks were drawn independently and had different splits - the sidebar was a
different logo from the taskbar.

**Every pane says which project it is in.** `src/shared/place.ts` is the only thing allowed
to turn a folder, a branch, a worktree suffix and a lane id into words. It exists because
the strip printed `lanes main master`, where `main` is a lane id and `master` is a branch
and neither names anything you could go and look at - and once lanes worked in any repo,
several rows said `master` at once for different repositories.

The rules, and where each came from:

- The project name is never omitted and never abbreviated. Everything else is added only
  when it is not implied, so one pane in one repo on its trunk reads `PaneForge` and
  nothing else - the common case, which is what you read past to reach the unusual one.
- A trunk branch is dropped rather than printed. No editor does better (VS Code prints
  `main` in the status bar like any other branch); the one shipped product that improves on
  it is Vercel, which labels default-branch deploys "Production" - a ROLE where the name
  would be. So `master` is answered ("main checkout"), not hidden.
- A branch some tool generated to hold a copy is dropped too: `pf/w2`, `lane-a` and Claude
  Code's `worktree-<slug>` all repeat the copy's own number.
- There are TWO numbers and they are worded apart on purpose. `copy 2` is the second
  checkout of that project; `pane 3` is the third card in the sidebar and Ctrl+3 reaches
  it. They are independent - the second copy of a repo is very often not the second pane
  on screen - so a bare `#2` beside a `3` key was one number too many with no way to tell
  which was which. Only the pane number is a keystroke, and only chats are named by it
  ("pane 3 has it", against eight characters of a session id only when there is no pane).
  Claude Code names worktrees `bright-running-fox` and Conductor uses city names; neither
  can be typed, which is why numbers are worth keeping despite needing the disambiguation.
- `-a` is stripped only when the caller already knows the folder is that lane, never
  guessed: `service-a` is a real project name. Only `-w<digits>` comes off unasked.

`npm run test:place` is 56 assertions on the strings themselves. One of them is a refusal
that the real window found: the sidebar has no `git status` of its own on purpose (one per
card, to print a word), so its tooltip claimed "not a git checkout" about a checkout with
19 uncommitted files. An absent fact and a known-negative fact are not the same thing and
only one is safe to assert.

`laneWords.ts` is built by esbuild in `lane-holder-test.mjs` now, not `tsc` on the one
file: `tsc --rootDir src` emits `from '../../shared/place'` with no extension, which Node's
ESM loader refuses, so the moment that file gained a runtime import the test died on a
module-not-found naming a temp directory.

## What a pane leaves running

Quitting kills each pty with `taskkill /F /T <pid>`, and that is a tree walk over live
`ParentProcessId` links performed at the moment of the kill. Two ordinary things sit outside
it, and `src/main/strays.ts` is both of them.

The first was measured rather than assumed, and it is not the obvious one. Windows keeps the
parent field after the parent dies - it is a number, not a link - so an orphan is still
listed as its dead parent's child. What breaks is the WALK: with the middle process gone from
the table there is no row joining the pty to the leaf, so `npm run dev` (npm exits, vite keeps
going) leaves a dev server the pane's own kill can never reach. The second is the app dying
without running `shutdown()` at all - a crash, the installer, a power cut. There the tree is
intact but its root is gone, and `taskkill` refuses a pid that no longer exists, so there is
nothing to walk from. Both are pinned as real processes in `npm run test:strays`.

Neither link can be recovered afterwards, so the app writes it down while it is still true: a
sampler walks each live pty's descendants every 30s and merges what it finds into
`strays.json` under userData, keyed by the app run that owns it. Closing a pane, quitting and
the next launch all kill from that ledger rather than from the process table.

Three rules it must keep, all of them load-bearing:

- **A pid is never enough.** Every record carries the process's creation time, and the check
  is re-made by whatever does the killing rather than trusted from the file. A ledger written
  before a reboot names pids that now belong to a browser.
- **A run whose app is still alive is somebody else's.** That is another copy of PaneForge -
  usually the `npm run try` one - and sweeping it would kill panes a person is typing in.
- **Nothing here may block the main process.** Every process-table read is `execFile`, and
  the two paths that cannot wait for a callback (a pane closing, the app exiting) do not read
  the table at all - they hand the pids to a detached script that verifies them once we are
  gone. A `spawnSync` here is the busy cursor the pane badges' `git status` is banned for.

It never asks what the pane is RUNNING, which is the point: claude, codex, gemini, aider or a
bare shell all leave descendants the same way, and a per-CLI hook would be written once per
agent, out of date the day a new one ships, and silent in exactly the crash case above.

POSIX needs almost none of it. node-pty's child is a session leader, so a pane's descendants
share a process GROUP - inherited, not linked, so it survives an intermediate parent dying -
and one `kill(-pid)` reaps the lot. The ledger stays there only for a run that died without
killing anything.

The test's own lesson is worth keeping: it stubbed `spawnDetachedNoWindow` with a plain
`spawn(..., { detached: true })` and every kill silently did nothing, because that is the
exact shape `consoles.ts` exists to avoid on this Windows build. It loads the real module now.
A stub of the one line that is hard on this platform is a test that passes while the app leaks.

## What a pane costs, measured

`capacity.ts` already answered "can this desk hold another pane", from a model: 190 MB an
agent, 7.2 MB a full scrollback, measured once and frozen. That model is right about the
average and cannot answer the question a person actually asks when the fans come on, which
is *which one of these four is eating my machine* - it reports all four at 190 MB while one
of them holds a 1442 MB `next build`. So each pane title carries a measured chip, and the
sidebar's Sessions row carries the desk's total. Four decisions worth keeping:

- **The pane is its process TREE, not its pty.** The shell is a rounding error; the agent
  and whatever the agent started are the cost. Same walk the stray sweeper does, one
  difference: `treeOf` includes the root, because here the pty is part of the bill rather
  than something to kill. Counting the pty alone loses the build entirely, which is the
  single failure this feature exists to avoid - `usage-test.mjs` fails six ways if the walk
  stops.
- **CPU is a DIFFERENCE of cumulative counters, never a platform percentage.** macOS
  `ps %cpu` is a decaying average over the process's whole life, so a pane that thrashed an
  hour ago still reads hot, and Windows has no per-process percentage without a perf
  counter that costs a second to read. `ps -o time=` and `UserModeTime + KernelModeTime`
  are monotonic and mean the same thing everywhere. Two consequences: the first sample has
  **no** CPU figure (null, not zero - a zero reads as a measurement), and a process first
  seen mid-flight is capped at the interval, or a build that ran 30s before the sampler
  noticed it reports as 3000% of a core for one tick and the readout is never trusted again.
- **Nothing is measured while nobody is looking.** A full process table is ~380ms on this
  M4 (665 processes) and more through PowerShell CIM. The sampler asks `BrowserWindow` for a
  visible, un-minimised window before each tick and drops a tick that arrives while the
  previous read is still out. A minimised app polling `ps` for ever is how an app gets blamed
  for a warm laptop, and here it would be blaming itself.
- **The app's own cost comes from `app.getAppMetrics()`**, not from the table: Electron
  already knows its renderers, GPU and utility processes, and picking ours out of the
  machine's other Electron processes is a guess. `percentCPUUsage` is already a share of one
  core, the same unit the panes report, so the two add up honestly.

Colour only when there is something to say (2 GB heavy, a full core hot); tabular figures,
because a number rewritten every four seconds shifts the title beside it on every sample
otherwise. `npm run test:usage`.

## A reopened pane comes back with what was on its screen

Built 2026-08-07, and the reason it is written down is that it looked expensive and was not.

The complaint is ordinary: the app updates itself, every pane reopens, and every one of them
is blank. `scrollback: 20000` in `TerminalPane.tsx` is xterm's own buffer and it lives in the
renderer's memory, so it dies with the window. The pane is not empty in any interesting
sense - the agent is right where it was, mid-conversation, because `resumeId` put it back
there - it just has nothing to show for it, which is worse than empty: the one thing on
screen is a fresh prompt under a title claiming a conversation you cannot read.

`test:restore` is the test that sounds like this one and is not. It pins which conversation
a reopened pane goes back into, which is the agent's memory. Nothing there is about pixels.

The obvious build is a new store: tee each pane to a capped ring under userData, prune it,
cap it, test it. That work is already done and has been for months - `history.ts` appends
every pane's RAW output to `userData/history/<id>.log` for the transcript search, capped at
8 MB per pane and pruned by `test:history`'s age and size rules. So the feature is a read.
`tail(id, bytes)` gives back the end of that file and `start()` writes it into the new
pane's `OutBuffer`, which is the same buffer a re-mounted pane already redraws from - the
renderer needed no change at all.

What was genuinely missing is one field. A restored pane is a NEW session with a new id, so
nothing joins it to the log the old one wrote; `snapshot()` now writes `scrollbackId` (the
LIVE id, the one the log is named after) into the desk, and `start()` reads it. Save the
wrong id there and the feature does nothing, for ever, without an error - which is why the
test asserts the saved id is the live session's, not just that the field is a string.

Three details that are each a visible bug when got wrong:

- **The tail is raw.** `read()` strips ANSI because it answers "what was said" for search;
  this answers "what was on screen", and the colour, the box drawing and the cursor moves
  ARE what was on screen. A stripped replay looks like a log file, not a terminal.
- **The cut is on a line boundary.** Slicing raw terminal bytes at an arbitrary offset lands
  inside an escape sequence often enough to matter, and the terminal then prints the tail of
  that sequence as literal text across the first line - `31mred text...`. Dropping up to the
  first newline costs one partial line and removes the whole class.
- **The mark resets first.** The caption that says where the old output ends is written
  straight after a tail cut mid-run, so whatever attribute was in force at the cut would
  bleed into the caption and then into everything the new process writes.

The cap is the buffer's 400 KB, not the log's 8 MB: what comes back is what a pane already
keeps in memory, not the whole day. That is deliberate - the promise is "the screen you
left", and a pane that replays twenty times its own scrollback on every launch is a
different, slower feature nobody asked for. `npm run test:scrollback` drives the real
`SessionManager` with the pty stubbed, and pins both halves plus the 2 MB case.

## The app remembers what has been asked

The expensive part of a repeated ask is never the typing. It is the agent re-reading the
repo, re-searching GitHub and re-deriving an answer that already exists, at full token price,
because nothing in the loop remembers the question was settled in March. Robert asked for a
safeguard that stops that early, across every CLI he uses.

**Why it is not a CLI hook, which is the obvious build.** Claude Code has
`UserPromptSubmit`, and Robert's `claude-memory/claude-config/prompt-dejavu.mjs` already uses
it — that hook is where this idea comes from and it works well. It also covers exactly one
agent. Codex has no equivalent, and `shared/agents.ts` lists thirteen. A hook-based version
is therefore a feature that silently does nothing for twelve of them and needs rewriting
whenever a fourteenth ships.

PaneForge hosts the pty, and `shared/draft.ts` already reconstructs what is being typed from
the raw bytes — that is how the Improve chip knows there is a draft at all. Reading the
archive from there means the agent's identity stops mattering: it sees what a person typed,
not what any particular CLI does with it. That is the whole argument for building it here.

**What it deliberately does not do.** It never blocks, never types into the pane, never
cancels a run. A repeat is frequently intentional — the same deploy check every morning, a
retry of something that failed — so an interruption that has to be dismissed would be wrong
more often than a chip that can be ignored. Being wrong costs a glance, which is the right
budget for a heuristic running on somebody's half-typed sentence.

**The quiet window is the load-bearing part, not the score.** `QUIET_MS` is six hours, and
without it the feature fires hardest exactly when it is least wanted: a prompt reworded and
re-sent two minutes after the first attempt failed is the same piece of work, and being told
"you have asked this before" at that moment is both true and useless. Every threshold in
`promptKey.ts` could be tuned and the feature would survive; drop the quiet window and it
gets switched off in a day.

**Only submitted lines are recorded**, never drafts. An archive of half-written sentences
would match badly, and it would also be a record of things somebody decided not to say. What
is stored is the token set plus a 300-character preview — enough to match on and to show,
never the full text.

**`src/shared/promptKey.ts` is a fourth copy, on purpose, and that is a real hazard.** The
same algorithm lives in Robert's `claude-memory` hook, the TaskDriver archive server and the
Discord bot, and those three share one archive keyed by a hash of the sorted token set. Any
drift between copies splits that archive into archives that never see each other's entries —
with no error and no symptom, just a lookup that quietly stops finding things. It is a copy
rather than an import because the app ships to people who have none of that and the feature
has to work on its own local history alone. `npm run test:recall` recomputes the canonical
file's answers over a shared corpus and asserts ours agree; when that file is absent it
**skips out loud**, because a silent skip is precisely how the copies would drift unobserved.

**What is honestly missing.** Nothing yet watches a pane's repo for the commit an ask turned
into, so `outcome` is null for every row this app records, and the tooltip says so in those
words rather than implying a lookup happened and found nothing. The outcomes that do appear
come from an external archive that already stamps them — which is how Robert's own history,
including prompts posted in Discord, reaches the chip: `promptRecall.extraArchives` merges
other JSONL files read-only. Writing into a file another tool owns would mean agreeing with
it about a format forever, and the two already disagree.

## Dictation needs nothing installed

The mic on every pane, and Ctrl/Cmd Shift Space into the focused one. It used to
require `pip install whisper-ctranslate2`, which is the version of a feature that
exists in Settings and is never switched on. `src/shared/voicePick.ts` picks between
three transcribers and `useVoice.ts` falls down them when one fails at run time.

- **`system`** - a whisper CLI on PATH, run by the main process. Fastest, fully
  offline, and now *preferred when it happens to be there* rather than demanded.
- **`inapp`** - Whisper in a worker in this window (`voiceWorker.ts`), ONNX Runtime's
  wasm build. Nothing to install. This is the default and the reason the feature works
  on a machine with no Python.
- **`browser`** - the browser's own recogniser. It streams words as you say them and
  costs no download, which is why it wins on a phone, and it is the one that sends
  audio off the device, so it is never chosen while a local engine exists.

Four things here are measurements, not opinions, and each one is a line somebody will
otherwise "simplify":

- **Feature-detecting `webkitSpeechRecognition` is not enough.** Inside Electron the
  constructor is present and every session ends `error: "network"` - Chromium's speech
  endpoint wants a Google key Electron does not ship. So `browser` is gated on *not*
  being Electron, judged by the user agent.
- **Every 8-bit build of these Whisper repos downloads and then refuses to run**:
  `qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits / Missing required scale:
  model.decoder.embed_tokens.weight_merged_0_scale`. `q8`, `int8` and `uint8` all fail;
  `fp32` works at 151 MB for `tiny`; `bnb4` works and is the smallest that does, so it
  ships. The sizes in `shared/voiceModels.ts` move with that choice.
- **The wasm is ours, not a CDN's.** transformers.js defaults `wasmPaths` to jsdelivr;
  an engine that needs the network on every launch is not the offline promise the
  feature is sold on. `electron.vite.config.ts` copies the pair into `out/renderer/ort/`
  - and DELETES the 23.5 MB asyncify binary vite emits from onnxruntime's own
  `new URL(..., import.meta.url)`, which the worker never asks for. Without that the
  build carries 36 MB for a 12.9 MB job.
- **Nothing on the page may import the worker's module.** `MODEL_MB` used to live
  beside it; importing that one constant took the main renderer chunk from 1.01 MB to
  2.23 MB, because it dragged transformers.js and onnxruntime in with it. The constants
  live in `shared/voiceModels.ts`, which imports nothing.

The model is downloaded once from Hugging Face and cached, which is the only network
this feature does and why `index.html`'s CSP names `huggingface.co` (plus
`wasm-unsafe-eval`, without which WebAssembly cannot compile at all).

**A phone is not a small desktop.** On a touch screen or a window under 720px the act
of dictating takes the whole screen (`VoiceOverlay.tsx`) - the one overlay in this app
allowed to, because a finger asked for it. A 32px target beside a terminal is right on
a monitor and unusable at arm's length. The ring around the mic *is* the input level
off the analyser, so a mic that is not being heard shows it by not moving, which is
worth more than a label saying "listening". The overlay also appears on a desktop while
the model downloads: a once-ever wait belongs somewhere it cannot be read as a hang.

`npm run test:voice` is both halves - the ladder as arithmetic, and a sentence spoken
by the OS voice pushed through the shipped worker (2.6s of audio, ~1.8s to transcribe
with `tiny`), plus the overlay measured at 390x844 and asserted absent at 1400x900.
It skips out loud without a window or without macOS `say`.

## Checks

`npm run typecheck` before committing, and `npm test`.

`npm test` is `scripts/test-all.mjs`: the 34 checks that need no window, no network, no
real agent CLI and no minute of wall clock, run cheapest-first, 30.1s for the lot on the
Mac. It is not a new set of tests - every one of them was already in `package.json` under
its own `test:*` name and had been for weeks. What was missing was a script called
exactly `test`, and that name is load-bearing: `gateCommands` in `src/main/agentGate.ts`
resolves its suite step with `pick(cfg.gate?.suite, 'test', 'no test script in this
repo')`, so on the repo with sixty tests on it the gate that judges a lane **the app
drove itself** ran diffstat, typecheck, *skipped*, reviewer. The gate reported that
honestly - `skipped` is printed by name and never reads as a pass - and nobody read it.
That is the part worth remembering: a pipeline can be scrupulous about naming a step it
did not run and still be a pipeline nobody is running that step in. Check what the steps
resolved to against the real repo, not that the reporting is correct.

Which tests belong in it is a cost question, not a taste one. A driven lane waits on this
before a reviewer ever sees the diff, so the entry price is that a test catches its
regression by ARITHMETIC rather than by somebody looking at a pane. The slow ones
(`test:strays` spawns real orphans, `test:lanes`,
`test:remote`), the ones that need a real window (`test:view`, `test:stashdrag`,
`test:activate`) and the ones that need the network
(`test:discordbrand`, `mac-update-test --live`) stay out, and the header of
`test-all.mjs` names each with where to run it instead. A failure prints that test's
whole output rather than a summary, because the reader is as often the agent being told
its lane failed as it is a person.

`npm run smoke` exercises the pty layer.
`npm run test:restore` covers what a reopened desk is made of: which conversation each
pane goes back into (never another pane's, never one older than the pane) and what the
dialog says it was doing. `npm run test:consoles` pins the sweep that kills console hosts
left behind - including the guard that stops it touching a console whose parent is alive.
`npm run test:strays` is the same question one level out, for what a PANE left running, and
it is the one test here that spawns real orphans: a child whose parent has exited, killed
from what the sampler wrote down, and a bystander whose pid is in the ledger with the wrong
creation time left untouched beside it. It takes ~25s for that reason.
`npm run test:gitpoll` drives a fake clock over the badge's `git status` cache, so the
thirty-second idle window is checked in milliseconds rather than by waiting.
`npm run test:install` starts a real install pty that sits there and proves quitting
takes its whole process tree - nothing is installed and nothing is written.
`npm run test:dock` keeps the macOS Dock icon: no window may ask to float over
fullscreen apps without `skipTransformProcessType`, because Electron implements that by
turning the whole process into an accessory and never turning it back - which is
`app.dock.hide()` for the app, from a line about one overlay window. On a Mac it also
runs a real Electron to check that Electron itself still behaves that way.
`npm run test:macupdate` is about the one thing that can leave a Mac with no PaneForge at
all: the app replacing its own bundle. It builds a real fake install, a real ditto zip and
runs the real swap script, and checks that the app is NOT moved while its process is alive,
that a failed swap puts the old bundle back, and that the relaunch is `open -g` (never the
foreground) - or absent entirely when the swap happens because the user quit. The download
half is proved against the live release with `node scripts/mac-update-test.mjs --live
<version>`, which is left out of the suite because it pulls ~120 MB.

`npm run test:macsign` is why the Mac stops asking for permission to read your Documents
folder every single release. macOS stores a TCC grant against the app's *designated
requirement*, and an ad-hoc signature has no certificate to name the app by, so that
requirement is the binary's own hash - `cdhash H"ec87a5..."`. This repo cuts a patch
whenever a chat finishes, the app auto-updates, and every one of those releases threw away
Documents, Desktop, Downloads, iCloud Drive, local network and Apple Events and asked for
all of it again. Nothing in the app can fix that: not an entitlement, not the
`NS*UsageDescription` strings, not `xattr -d com.apple.quarantine`, because none of them
is what TCC decided to key the grant on.

Signing with any certificate at all changes the requirement to `identifier
"com.robert.paneforge" and certificate root = H"..."`, which has no cdhash in it and
therefore survives every rebuild. `scripts/mac-cert.mjs create` makes that certificate -
self-signed, twenty years, `codeSigning` EKU - and prints the two repository secrets
(`PF_CERT_P12`, `PF_CERT_PASSWORD`) that let CI sign with the SAME one, since a second
certificate is a second root hash and one more reset. It buys nothing from Gatekeeper: a
self-signed build is still refused on first launch, so `install.sh` and `macUpdate.ts` go
on clearing quarantine exactly as before. The test pins the ad-hoc case as well as the
signed one - without it, it could not tell "the certificate fixed this" from "this was
never broken" - and its last assertion is the only one TCC actually depends on: change the
app, sign again, the requirement is byte-identical.

Four things it cost an hour each to learn, none of them visible from the code:

- `set-keychain-settings -t 0 -u`, which every guide to CI signing includes, asks the
  Security agent for authorisation. With no GUI session there is nobody to answer, so it
  fails as "User canceled the operation" - and it leaves the keychain in a state where the
  next call, the import itself, fails the same way. On a desktop it does worse: it puts a
  password dialog on Robert's screen for a keychain whose password is empty. It is gone;
  `mac-sign.mjs` unlocks the keychain a second before signing instead, which the 300-second
  auto-lock cannot outrun.
- The identity does not need to be TRUSTED. `security find-identity -v` hides it -
  `CSSMERR_TP_NOT_TRUSTED` - while codesign signs with it perfectly happily, and the kernel
  runs the result, quarantined or not. Trusting a root is another dialog nobody can click.
- The key lives in its own keychain, never `login`, because `set-key-partition-list` needs
  that keychain's password and the login one is Robert's. Without that call every signature
  dies as `errSecInternalComponent`, an error that mentions nothing about keychains.
- OpenSSL 3 writes a p12 macOS cannot read. `security import` reports "MAC verification
  failed during PKCS12 import (wrong password?)" about a password that is correct;
  `-certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1` is the fix.

The test's own fixture had never run on a Mac newer than Big Sur: it built its framework
out of `/usr/lib/libSystem.B.dylib`, which has not been a file on disk since the dyld
shared cache swallowed it, and the framework it built had no `Versions/A/Resources/
Info.plist`, which codesign rejects as "bundle format unrecognized, invalid, or unsuitable"
- while signing the MAIN executable, because signing anything inside a bundle walks the
whole bundle. Both are fixed and worth not reintroducing.

`npm run test:stashtheme` is about a different question, and the one a person actually
asked: *why does the Stash look different in the app than it does outside it?* Because
until 2026-08-07 it was two features. The in-window one (`RecentsFlyout.tsx`, rules in
`styles.css`) and the floating one (`shelf.tsx`, `shelf.css`) share not a single selector,
and only one of them was ever wired to the theme. Measured on a default install with a
probe against both live windows:

| | main window | Stash overlay |
|---|---|---|
| `--accent` | `#f0a868` | `128, 192, 255` |
| body text | `#efecea` | `#ecedf2` |
| surface | `#0d0907` (derived) | `rgba(38, 38, 48, .9)` (fixed) |
| inline `:root` variables | 33 | **0** |

Zero is the whole finding: `applyTheme` had never been called in that window, so the
literals in `shelf.css` were not the ~40ms fallback CLAUDE.md describes — they were the
palette. And light-or-dark came from `@media (prefers-color-scheme: light)`, which asks
macOS. macOS does not know which preset is loaded, so PaneForge on Paper with the OS in
dark mode drew a light window with a dark Stash floating over it and nothing in Settings
could reach it.

Three things that only turned up by reading the live window rather than the diff:

- The overlay's accent was called `--accent`, the same name the palette writes as a hex.
  `rgba(var(--accent), 0.2)` of a hex is not an error, it is a dropped declaration — eight
  rules would have gone transparent the moment the fix landed, silently. It is `--acc-rgb`.
- `parseHex` answers in 0..1, because everything downstream of it in `theme.ts` is Oklab
  maths. The first build wrote `--acc-rgb: 0.941, 0.659, 0.408`, which `rgba()` reads as
  ~1/255 and paints black. The probe read it back before anyone saw the window.
- Deriving the third text step as muted mixed 74% toward the background matched the old
  hand-picked `#74748a` on a dark card almost exactly, and measured **3.54:1** on Paper
  where the old hard-coded light value had been 4.81:1 — Paper's muted is already close to
  its paper. The faintest step is now `--muted` itself, which `test:theme` holds at 3:1 for
  every preset and hue. Read back in a real window: 13.08 / 5.77 / 9.22 on Paper and
  15.34 / 6.29 / 10.63 dark, body / secondary / buttons.

The test that came out of it is structural, not a contrast run, and deliberately: the three
text steps are now `--text`, `--muted` and a mix of the two, and a mix of two colours that
each clear a ratio against the same background clears it too. The only way back to a
failure is a colour of its own, so that is what it looks for — no hex and no chromatic
`rgb()` in `shelf.css` outside a `var()` fallback slot, no `prefers-color-scheme`, no
`rgba(var(--accent)`, no unscaled `parseHex`, and `theme` absent from `STASH_CONFIG_KEYS`
(a window floating over every other app may read the theme and must never write it). Each
of those five was re-broken and the test watched to go red before it was believed.

`npm run test:stash` is what the Stash is allowed to cost, and it is model-free and
window-free because the two things it pins are invisible while they are broken - the
feature keeps working perfectly and only gets slow. A full 200-entry history was 414KB, of
which 383KB was `text` that nothing on screen draws (the rows draw `preview`, the first 140
characters) and ~207KB more was the same clip stored a second time inside `key`, and all of
it was stringified, written and structured-cloned to two windows on every copy made
anywhere on the machine. So: no list leaving the main process may carry a body, `recentText`
returns that body byte-exact for the one click that types it into a pane, and a key must not
contain the clip it stands for. It also pins the two ways the history could come back empty
- the save goes through a `.tmp` and a rename, and the sweep that deletes orphaned files has
to name that `.tmp` as a keeper rather than happen to miss it - and that `flushRecents` on
`will-quit` gets a copy made in the app's last second onto disk, which a debounced async
write otherwise loses.

`npm run test:stashdrag` needs a test copy up (`npm run try -- --keep --show
--remote-debugging-port=9333`) and drags the Stash overlay with real CDP input, because
`setPointerCapture` - which the drag is built on - refuses a pointer id no physical
pointer owns. What it measures is the gap between the pointer and the thing it grabbed
MID-gesture, not after: the overlay is moved by hand from screen coordinates, and on macOS
the arithmetic was 105px out horizontally and 100px vertically because AppKit had quietly
clamped the window it was computed from. It also pins the size of the grip's hit box,
since a press that misses the handle opens the list instead of moving the window.

`npm run test:activate` is the other half of that press, and it is about the app the Stash
is NOT. `focusable: false` stops the overlay's window becoming key; on macOS it does not
stop the click activating the APP, and PaneForge answers activation by revealing its main
window - which is the only way back into a copy that launched hidden. So clicking a row to
copy, or grabbing the grip to move the overlay, pulled the whole app over the thing being
pasted into and took the focus the Cmd-V needed. The overlay is an NSPanel on darwin now
(`type: 'panel'`, i.e. `NSWindowStyleMaskNonactivatingPanel`) so the activation never
happens, and `shared/activation.ts` refuses any activation a press on the Stash explains.

Its load-bearing assertion is an ordering one, and it is the one a guard written the way it
reads gets backwards: the press and the activation are ONE gesture arriving by two routes -
AppKit's notification and the browser routing the input - and on a real click the press is
timestamped AFTER the activation. So the handler waits `ACTIVATION_SETTLE_MS` for the other
half rather than answering on arrival, and the window is checked in both directions. The
press itself is recorded from `webContents.on('input-event')` in main, never from an IPC
message the page sends, which is a round trip later than the decision. The Electron half
spawns a real Electron and pins that `input-event` still carries mouse events to a
`focusable: false` transparent window - the one assumption an upgrade could take away
silently, and it would take away silently: every click would simply raise the app again.

`npm run test:view` is the grid and the find bar in a real window, and it needs one up
(`npm run build && npm run try -- --keep --show --remote-debugging-port=9333`). The
arithmetic behind the five layouts is pinned without a window by `npm run test:grid`; what
that cannot answer is whether the panes land where it says, since the cells are CSS grid
lines and the dividers are absolutely positioned over the gaps. Nor can the DOM answer
anything about the find bar: with the WebGL renderer there is no text in it and the
highlights are decorations over a canvas, so the addon's own count - the number the bar
prints - is the only honest source. Two things it pins that cost an hour each to see: a
pane RESIZED after text was written into it loses that text, because the shell repaints
the screen it owns (so a search that "found nothing" was a test writing into a pane it
then zoomed), and a window that is not being drawn can find every match and count none -
which is why the bar says "found" rather than "no matches" when the search landed but
nothing was counted, and why the test wants `--show`.

`npm run test:pipe` is the live tee of a pane's output, and the half of it worth pinning
is not the file being written - it is the chunk boundary. The pty hands over whatever
pieces it feels like, and an escape sequence does not respect them: `\x1b[3` in one chunk
and `1mb` in the next is one colour change, and stripping the halves separately leaves
`1mb` sitting in the file as text. `AnsiStream` in `shared/ansi.ts` holds an unfinished
sequence - and a trailing `\r`, which is either a line ending or a cursor return
depending on a byte that has not arrived - until the rest of it comes. The test asserts
the streamed result is byte-identical to stripping the whole input at once, that raw
mode changes nothing at all, that stopping flushes what was being held, and that a tee
pointed at a file that cannot be opened costs the pane nothing: the stream's `error` is
handled, or an unhandled one takes the whole main process down with it. That stripper is
the transcript's too - one implementation, since a transcript and its tee disagreeing
about the same run is a bug nobody would ever look for.

`npm run test:copymode` is keyboard copy mode's arithmetic, away from xterm because it
is the half that is wrong in ways a screenshot cannot show. Three of its rules were
written by things that were already broken: `V` had to become a SHAPE rather than a pair
of columns (as columns, `V` then `j` selected one whole line plus a single stray
character of the next, and that is what a yank put on the clipboard); a horizontal key
that moves nothing must not move the wanted column either, or `l` at the end of a short
line silently shifts where the next `j` lands; and `G` means the last line with anything
ON it, not the last line the buffer has - measured in a real window, a pane two lines
into its life reported a buffer 70 rows long, so "the end" was 68 rows below the last
thing printed, where `$` selects nothing and a yank comes back empty. The window half is
in `test:view`, and it exists because of a measurement too: the shortcut acts on the
ACTIVE pane, so a probe that starts a pane without focusing it drives one pane while
measuring another and reports a feature that does nothing.

`npm run test:silence` is the alert that says a running turn has gone quiet, and it
exists because a rule about MINUTES cannot be checked by hand - nobody re-tests a five
minute timer, so every mistake it can make ships, and every mistake it can make is the
app crying wolf. The decision is a pure function in `shared/alerts.ts` for that reason:
the sweep it runs inside owns a pty, and a test that has to spawn `claude` to find out
whether a number is compared correctly is a test nobody runs. Its load-bearing assertion
is a refusal: a pane with no turn running is NOT stalled however long it has been quiet.
That is tmux's `monitor-silence` rule deliberately not copied - an idle pane is silent
all day, and eight of them would raise eight alerts about nothing every N minutes, which
is how an alert gets switched off for good.

`npm run test:discord` is the Discord Rich Presence ("3/6 sessions running" on the
profile), without Discord: the whole client run against a fake Discord served over a
real named pipe. The two things it pins are invisible in a unit test and both have
bitten this repo before: a frame split across data events must not be decoded early
(the device link's launch bug, relearned here), and a socket error nobody handles
takes the main process down (the tee's lesson). It also pins the budget rules - a
burst of session events collapses to one trailing SET_ACTIVITY, an unchanged desk
sends nothing, an empty desk sends a clear rather than "0/0" - and that a Discord
that is not running costs nothing, silently, forever. The header line of the presence is
the Discord APPLICATION's name, and that application is `DISCORD_APP_ID` in
`shared/discordRpc.ts` - **a constant, not a setting**. It was a text field for a few
releases and that was wrong in three directions at once: a user who cleared it or
mistyped a digit got a presence Discord had no application to resolve, with the app
reporting nothing amiss; anyone still on the earlier BORROWED id - "Manic's Auction
House", the author's Discord bot, used because creating an application needs a portal
login and a captcha a script cannot pass - kept a stranger's brand on their profile,
which is invisible from inside the app because 19 digits do not say whose name Discord
is about to print; and a field for it read as "you have to make your own application",
which was never true. So the saved key is not migrated, it is DELETED on load
(`dropSavedDiscordId`) and left out of the next write. What a user may still do is turn
the presence off, or reword it.

Owning the application is not the same as being ON it. An application's icon names the
HEADER and is never the artwork: a presence that sends no `assets` is drawn as text with
no image at all. So the mark stayed missing from every profile long after the name was
right and the icon was uploaded, with nothing anywhere reporting it - the frame is valid,
Discord accepts it, and the only tell is a card that looks a bit empty. `buildActivity`
names the art asset (`PRESENCE_IMAGE`, the name it was uploaded under in the portal, not
a URL and not the icon hash). Discord drops an image key it cannot resolve in silence,
which is why the brand test checks the asset exists rather than trusting the send.

The third thing that can be wrong is the one the app used to be silent about: **whether
Discord accepted any of it**. Discord acknowledges every `SET_ACTIVITY` by echoing back
the activity it STORED - the application name it resolved, the asset id the image name
became, the lines it kept - or by answering `evt: 'ERROR'` with a reason. Every one of
those frames was read only for `READY` and otherwise dropped, so a refused presence and
an accepted one looked identical from inside the app, and the settings tab could only
describe what was INTENDED. It now reports that ack (`PresenceStatus`, pushed on
`discord:status`), which is the only honest answer to "is this actually on my profile":
connected as whom, headed by what, accepted at when, or refused in Discord's own words.

What the ack still cannot say is whether anyone ELSE can see the card, because Discord
does not tell an application that and the switches that hide it are Discord's own:
Activity Privacy ("Display current activity as a status message", "Share your detected
activities with others") and Activity Status per server. A presence can be correct all
the way to the ack and invisible to every friend, which is why the tab says so in
words next to the status rather than leaving the app looking broken. Presence is
desktop-only either way - the phone and browser clients never draw one.

That warning only reaches somebody who opens the tab, so `npm run test:discordbrand`
says it to the repository instead: it reads the `DISCORD_APP_ID` literal out of
`src/shared/discordRpc.ts` - the value that actually ships, never a copy - asks Discord what
that application is called, and FAILS while the answer is not PaneForge. Then it asks the
same id for its art assets and FAILS while none is named `PRESENCE_IMAGE`. Both halves
are checked because they broke in that order and a correct name with no asset is a card
with no logo on it; both are fixed now, so the test passes. Neither could be fixed by a
script - New Application and Add Image are both a portal login and a captcha - but no
bot, no scopes, no OAuth and nothing to "connect": rich presence talks to the local
Discord client over a named pipe and the id is all it needs. Offline it SKIPS and prints
the skip, because a check that quietly passes when it could not run is worse than no
check when the thing it catches is a wrong answer that looks like no answer. Out of the
default suite for needing the network.

Everything BELOW that header is ours, and Settings → Discord owns it: two templates
(`{running}`, `{total}`, `{idle}`, `{sessions}`, `{projects}`, `{project}`) plus
switches for the project line, the elapsed clock, and whether an idle desk says
anything at all. It lives in `discordStyle`, and every template defaults to the EMPTY
STRING rather than to its wording - the built-in text lives in `discordRpc.ts` as
`DEFAULT_DETAILS`/`DEFAULT_STATE`/`DEFAULT_IDLE_DETAILS`, shown as the field's
placeholder. That is what lets a config nobody has touched keep sending the exact
bytes it sent before the tab existed (the test asserts it byte for byte) and lets a
later reword reach people who never opened the tab. `buildActivity` takes the style
as a second argument with a default, so the pure function stays callable from the
preview in Settings - the panel is the real activity, not a mock of one. Two rules
it enforces that a template can otherwise break: a line still gives up trailing
project names for a "+2 more" before Discord's 128-char cut, and templates that
render to nothing send a CLEAR rather than a blank badge on the profile. Restyling
does not drop the pipe (that would be a reconnect per keystroke) but does clear the
last-sent memo, or an edit landing on the same numbers would be read as "no change"
and never leave the machine.

`npm run test:notes` is about the release page saying what changed.
`scripts/release-notes.mjs` reads the Conventional Commit subjects between the previous
version tag and this one and sorts them into New / Fixed / Faster / Other changes.

Three things publish that body and all three call the same function, so they cannot
print different pages: the workflow's `notes` job, `publishFallback` in `lane.mjs` for
the releases Actions never built, and `reconcileNotes` on the retry timer. The template
is `.github/release-notes.md` and the changes go where `{{CHANGES}}` is.

`reconcileNotes` is the backstop, and worth keeping even though CI now writes the
changes itself: on the retry timer that already runs every minute, it looks at the
newest release for an hour after it is cut and fills in any body with no
`## What changed` in it. Check-then-write rather than one-shot, so a body overwritten by
anything - an older checkout cutting a release, a re-run of an older workflow - is
noticed on the next tick and put back. It costs nothing when no release is that new.

The workflow's `notes` job checks out with `fetch-depth: 0`. Without it there are no
tags and no history to diff against, and the job would quietly publish the "nothing to
list" fallback on every release while going green.

That job could not be edited from this machine until 2026-07-31: pushing any commit
touching `.github/workflows/` was rejected because the `gh` token had `repo` but not
`workflow` scope. `gh auth refresh -h github.com -s workflow` is the fix, and the
`-h` is not optional when it is not a person typing it.

The test builds a real repo with real tags and pins the ways the range goes wrong
silently: v0.3.9 must not sort above v0.3.10, a version with no tag yet means "since the
newest tag", the `release:` bump and lane merges are not changes, a subject with no
prefix is still reported, and a release with nothing new keeps the commit link instead
of printing an empty heading. It pins both template shapes - the `{{CHANGES}}` one in
the repo now, and the older "New in this build" line - because a release cut from a
checkout older than the switch-over reads its own template, not this one.

`scripts/lane-fixture.mjs` is why the four lane tests no longer carry a hand-written
`['lane.mjs', 'test-app.mjs']` copy list: giving lane.mjs one more import broke all four
at once, with an ERR_MODULE_NOT_FOUND naming a temp directory rather than the cause. The
list is derived from lane.mjs's own relative imports now.
`npm run test:remote` runs the device link end to end over a real loopback socket -
pairing, refusal, mirroring, keystrokes back, and that nothing on the wire is readable.
`npm run test:lanes` ends with `lane-sweep-test.mjs`, the one test about DELETING
things: it builds real repositories with real worktrees and checks every case the sweep
must refuse (uncommitted, untracked, unmerged, squashed from several commits, a pane
open in it or in a subfolder of it, a branch that is not `pf/wN`). Add a case there
before relaxing a rule - it is how the "somebody else's worktree at `myapp-w2`" hole
was found. `lane-owner-test.mjs` in the same suite is about who HOLDS a lane: a hold
records the chat, not the folder, because every chat records the main checkout it started
in - so matching by folder let one new pane silently "own" two dead chats' lanes and wipe
them off the strip while they were still held. It also pins the reclaim: a hold no
running copy of the app is hosting, quiet for fifteen minutes, is given back by
`lane.mjs release`. Liveness is judged across copies, never per window: every copy
publishes the chats it hosts to `.git/paneforge-panes.json`, and a chat counts as gone
only when it is in nobody's list. Without that, the test copy `npm run try` opens - which
hosts no chats at all - would decide every chat in the real window had died and hand out
checkouts people are typing in.

## Gotchas that look like mistakes

`package.json` `description` is the bare word "PaneForge" on purpose. electron-builder
writes it into the exe's FileDescription, which is the name Windows Task Manager shows,
and a tagline there read as a second app called "run every coding agent you own in one
window". The tagline lives in the README instead.

The icon is generated, not stored. `node scripts/make-icon.mjs` draws it from about a
hundred lines of arithmetic and writes `icon.png` + `icon.svg` at the root and
`build/icon.png`, which is electron-builder's default buildResources directory - so the
Windows `.ico` and the Mac `.icns` come from that one file with no configuration at all.
Do not replace it with a checked-in blob: there is no ImageMagick on this machine (the
`convert` on PATH is Windows' filesystem tool) and no sharp, so a blob is a file nobody
can resize when Discord wants a 512 or a store wants a 1024. `--size N --out path` renders
any single size. The gap between panes is 0.043 of the canvas because that is what still
reads as three panes after a downsample to 24px - 2px of background survives on both
splits, which is the whole reason the mark is legible in a taskbar.

`git status` for the pane badges must stay async (`execFile`, not `spawnSync`). Sync
spawns block the main process, which owns the window message loop, and Windows answers a
stalled message loop by swapping the pointer for the busy cursor.

## Checking a layout change without screenshots

Screenshots cannot answer "is the last row reachable", and a session that takes ten of
them costs more than the fix. Ask the real window instead:

```
npm run build                    # --keep below SKIPS the build; without this you measure the last one
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const d=document.querySelector('.dialog'); const r=d.getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

A probe answering exactly what it answered before your edit is the tell: nothing was
rebuilt. The port is per checkout - another lane's test copy holds 9333 and says so -
so a second lane probes with `PF_PORT=9334` and launches with the matching flag.

`--height`/`--width` drive Chromium's device metrics override, so a short-window check
needs no window manager and puts the size back afterwards. The expression is evaluated
in the renderer with `awaitPromise`, so an async arrow that clicks through a dialog and
then measures works as one argument. `window.__pf[sessionId]` gives a pane's live
`term` and `fit`, which is how pane behaviour is checked without a screenshot.

---

## The phone is this window, served (full rules, moved out of CLAUDE.md 2026-08-21)


There is no second app. The renderer imports nothing from Electron and nothing from Node -
it is pure UI over `window.api` - so a phone client is that object over HTTP:
`src/main/phone.ts` serves the built renderer, `renderer/src/browserApi.ts` supplies the
object, and **`src/shared/surface.ts` is the ONE list** both transports are built from,
typed `{ [K in keyof Api]: SurfaceEntry }` so a method with no channel does not compile.
Never add a channel to a transport; add it there. The preload is 38 lines and names no
channel of its own.

- Calls land in the app's own `ipcMain` body via `src/main/ipcTap.ts`, so `tapIpc()` MUST
  stay at the top of `index.ts`, above every registration.
- Events go down one SSE stream; `phone.broadcast` sits **ahead** of the window check in
  `send()` so a minimized window does not starve a phone. `send`s are queued client-side
  because they are ordered.
- **Off until the Devices panel is opened — and opening it is the switch.** Serving
  grants a browser a pane, which is commands on this machine, so the app never listens
  on its own; but opening Devices IS the intent to pair, so the panel starts serving on
  mount and the QR is on screen the moment the panel is. There is no separate toggle any
  more (v0.8.36: the toggle was where the QR hid, and the QR is the whole setup). `Stop
  serving` lives in the fold and holds until the panel is next opened. Unpaired gets the
  pairing page and not one asset; five wrong codes locks that address for a minute. The
  cookie is `hmac(deviceId, code)` - derived, never stored - so rotating the code signs
  every phone out.
- **Watching a pane and typing into one are different permissions** (`src/main/passkey.ts`).
  With `phone.typeGate` on, a browser may watch freely but the first keystroke of each
  15-minute window costs a passkey touch — Face ID, Windows Hello — so a stolen cookie is a
  viewer rather than a shell. Three things about it are load-bearing and easy to undo by
  accident:
  - **The gate is on `/pf/send` and `/pf/call`, NEVER on `pty:write`.** The app types into
    panes itself — `recover`'s queued "continue", the prompt `sessions:start` hands a new
    pane — and those are raised in the main process, so a gate at the HTTP boundary exempts
    them by construction. Move it nearer the pty and both break, silently. If it ever has to
    move, the seam is one `from: 'user' | 'app'` parameter on `SessionManager.write`.
  - **It arms only over TLS** (`x-forwarded-proto: https`, same loopback-only trust rule as
    `addressOf`). WebAuthn does not exist outside a secure context, so arming on the
    plain-http LAN path would lock out the phones that cannot satisfy it. `test:passkey`
    pins this in both directions because it is the check most likely to silently invert.
  - **A 423 refuses the whole batch before anything runs**, and the client re-queues it at
    the front. Keystrokes are ordered: running the ungated half of a batch delivers a word
    with letters missing.
  `DESK_ONLY` in phone.ts refuses `phone:typeGate` and `phone:forgetKey` over HTTP with the
  same answer as a channel that does not exist — a lock whose switch is reachable from the
  thing it locks is not a lock. Note that **every other invoke channel in `surface.ts` is
  phone-reachable**; desk-only is a property of the transport, not of the surface.
- **The QR leads with an address a plain phone can reach.** `phoneUrls()` puts the LAN
  address first and the tailnet one after it: 100.64/10 answers only for a phone running
  Tailscale, and leading with it made the QR a dead link on every ordinary phone the
  moment this desk had a tailscale interface up. `reachWords` says "needs Tailscale on
  the phone" for it, never "works anywhere" — only the tunnel earns that. Pinned by
  `test:phone`, which feeds `phoneUrls` a mixed interface set.
- **The tunnel never asks the system resolver for a name public DNS does not carry yet.**
  `waitUntilServing` gates the probe on a DNS-over-HTTPS answer (cloudflare-dns.com,
  which bypasses the local cache) and only then touches the hostname — probing straight
  after `Registered` was the cached-NXDOMAIN trap in slow motion, 40s of ENOTFOUND
  against a serving tunnel. The gate falls through after `PF_TUNNEL_RESOLVE_MS` (30s) so
  a blocked DoH endpoint delays the probe, never defeats it. And the 20 MB binary is
  prefetched when serving starts, so the switch costs seconds, not a download.
- **Scanning asks; a press on the desk answers.** The QR carries the bare address, not the
  code: the phone opens it, `POST /pf/ask` raises a card here with four digits that are on
  both screens, and Approve mints THAT browser a 32-byte token of its own. So there is no
  secret on screen to photograph, and — the part the code could never do — a device can be
  signed out **by name**, because `who()` looks its token up on every request. `New code`
  still exists and still signs out everything that typed one. One request at a time, five
  per address per ten minutes, two minutes to answer, and the whole thing is a switch
  (`phone.ask`) that falls back to the fragment-code QR. Nothing is granted by the asking.
  `npm run test:phone` covers approve, the cookie arriving on the POLL (the only door back
  to that browser), and that a signed-out cookie stops working on the next request.
- **"One request at a time, five per address" needs the address to be real, and behind the
  tunnel it is not.** cloudflared holds the phone's TLS connection and re-issues the request
  locally, so every device on earth arrives as 127.0.0.1. That string is the ask slot, the
  lockout key and the words the card prints, so believing the socket meant a second phone was
  handed the first one's request and its four digits, five scans from anywhere shut the door
  for ten minutes, and a phone on a train was labelled "this machine", which is exactly the
  label that turns the card's internet warning off. `addressOf` believes `cf-connecting-ip`
  (then `x-forwarded-for`) and does so ONLY from loopback, which is the one hop we put there
  ourselves; a local process could spoof it and gains nothing, being already able to read the
  pairing code out of config.json. Shape-checked before it is printed.
- **The approve card belongs to the desk, and this UI also runs on the phone.** Drawn there
  it is a full-screen veil over whatever that phone was doing, thrown up by any device
  asking to get in, offering Approve to the one screen that cannot compare the digits with
  the desk. `isPhoneClient()` (`renderer/src/client.ts`, set by `browserApi.ts`) is the only
  thing that may gate on which copy is running, and it is for authority, never for layout:
  a narrow window is `handheld.ts`'s question.
- **Pairing is a camera, not a keyboard.** With asking off, Settings draws `<address>/#<code>` as a QR
  (`shared/qr.ts`, no dependency, byte mode / level M / versions 1-6) and the pairing page
  posts a code it finds in the fragment. A **fragment** because a browser never sends one
  to the server: the code stays out of the access log and out of every `Referer`. The
  typed field is still there for a phone with no camera. OAuth and email were considered
  and refused - both move the secret through a third party and off this network to save
  six keystrokes on a link that is otherwise entirely local.
- **So the picture is the panel, and everything it is made of is folded.** Devices leads
  with the phone, above the desktop card, and the phone panel shows a 168px QR and one
  line of words; the address list, the code, the port and `New code` live under
  `Other ways in`, and the desktop card's own code, addresses and port under
  `Pair by hand`. Measured with both folds closed: **zero** codes, addresses and New code
  buttons on screen, against 2 codes / 4 addresses / 2 New code buttons before. None of
  that is wrong — it is what you reach for when the camera did not work — but all of it
  at once, twice over, is what buried the one step that finishes the job.
- **The panel says who is watching, never who is paired.** The cookie is derived, so every
  phone that ever typed the code holds the same one and there is no per-device identity to
  keep — which means there can be no per-device sign-out, and a `Disconnect` button beside
  a row would be a lie (the stream returns at once, the cookie is still good). `New code`
  is the only revoke and it takes all of them. Each row leads with **where the browser came
  from** (`originOf` in `shared/net.ts`), because "somebody is watching" reads one way for
  a phone in this room and another for an address off the internet. The same function
  labels each offered address with what it reaches, so the panel can never promise
  "works anywhere" for an address the server would then mark "this network".
- **A phone signs in ONCE, and what makes that true is the address, not the auth.** The
  cookie is ten years, HttpOnly and revocable by name — and every one of those was already
  true while phones were being re-approved on the desk every launch, because a cloudflared
  quick tunnel mints a NEW hostname per run and a cookie belongs to an origin. So
  `main/funnel.ts` is tried before cloudflared whenever the machine can: Tailscale Funnel
  serves public HTTPS on `<machine>.<tailnet>.ts.net`, which is this machine's own name and
  is the same string after a reboot, an update and a network change. Nothing is installed
  on the phone (Funnel is the public internet, not the tailnet) and nothing is downloaded
  on the desk. Measured: up in under a second against cloudflared's ~20s. Every refusal —
  no Tailscale, `tailscaled` stopped, a tailnet without the funnel attribute, no HTTPS
  certs — falls silently through to cloudflared, because the person flipping the switch
  asked for a way in and not for a provider. `TunnelState.stable` is the one word the panel
  needs; `funnel --bg` is a setting tailscaled keeps, not a child process, so `stop()` has
  to say so or a public address outlives the app. `npm run test:funnel`.
- **`SameSite=Lax`, never `Strict`.** Strict withholds the cookie on a cross-site
  navigation, and every real way this address is opened is one: a QR scanned in the Camera
  app, a link tapped in Messages, a bookmark from another app's browser. The desk then sees
  no cookie, calls a signed-in phone a stranger and serves the pairing page. `Secure` is
  added only when the request really arrived over TLS (`x-forwarded-proto`), since on plain
  http over the LAN it is a cookie the browser stores and never sends back.
- **The cookie lasts ten years, so a copy of it has to be VISIBLE.** Expiring it is the
  wrong answer twice over: a phone that loses its cookie needs somebody standing at the
  desk to approve it again, which is the manual step this whole path exists to delete. So
  `shared/deviceWatch.ts` watches instead, and it never refuses a request — a watcher that
  revokes on suspicion locks Robert out from a train, which is the failure that makes the
  feature not worth having. It marks the row; `Sign out` is still a press.
  - **A signal that fires on ordinary life is not a signal.** A phone leaving the house
    changes its address and its origin every day, so a changed PLACE is recorded and never
    alarmed on. What is left is the two things a phone does not do by itself: turn into a
    different browser (compared on a version-stripped `uaShape`, because an iOS upgrade
    rewrites the numbers and marking every device the morning after a release is how a
    warning stops being read), and hold a live stream from two origins at once — one
    sign-in is one browser, so that is a copied cookie even when the user-agent matches.
  - **An existing mark is never overwritten and never cleared by an ordinary arrival.**
    The browser holding the stolen cookie is making requests too, so a later innocent one
    wiping the mark means nobody ever sees it. `phone:clearMark` is the only eraser and it
    is in `DESK_ONLY`: a warning a stolen cookie can dismiss about ITSELF is not a warning.
  - `npm run test:devicewatch`, whose load-bearing half is the negative cases.
- **One row per device, not one per approval.** A phone re-asks whenever its cookie is
  gone, and appending each time is what made this desk's list nine rows for three phones —
  at which point `Sign out`, which is per row, stops meaning anything. Approval replaces the
  row with the same user-agent (the only thing about a browser that survives losing the
  cookie) and keeps its original "signed in since"; a list written before that is collapsed
  once on the way up, conservatively, by kind and place.
- **A way in from anywhere is `cloudflared`, and the URL is not the claim.** `main/tunnel.ts`
  runs a Cloudflare quick tunnel so a phone on any network reaches this desk with no
  account, no VPN and nothing installed on the phone. Tailscale is the wrong answer to
  ship: it needs an account, an app on the phone and an install on the desk.
  - **Never look the hostname up before the tunnel has registered.** `*.trycloudflare.com`
    is not a wildcard, so an early query gets NXDOMAIN and the resolver **caches it** —
    measured 40 unbroken seconds of `getaddrinfo ENOTFOUND` while 1.1.1.1 had been
    answering since t=8s, against an instant resolve on the next run that waited. The
    tunnel was healthy both times. Hence the `Registered tunnel connection` gate.
  - `up` is set by a real HTTPS request coming back with this desk's own bytes, never by
    the URL line appearing. Measured: hostname 3–6s, public DNS 8–13s, first 200 ~1s later.
  - Everything cloudflared says is on **stderr**; its stdout was 0 bytes on every run.
  - Turning it on **lengthens the pairing code to 14** and signs every phone out. Six
    characters is a LAN number: 387M combinations, and on a public address the per-address
    lockout stops mattering because attempts come from as many addresses as the attacker
    likes. Nobody types it — the QR carries it — so the longer one costs nothing.
  - The binary is downloaded once (19–54 MB), never bundled, through a `.part` name and a
    rename. Quitting kills it — it is not a pty, so `strays.ts` has never heard of it.
  - `npm run test:tunnel` drives all of it against a stub that prints what the real program
    prints, with every budget overridable by env.
- **A copy made on the phone is the PHONE's clipboard.** `copyText` is an ordinary channel,
  so over HTTP it ran `clipboard.writeText` in the main process - on the desk. Every copy
  from a phone (a pane's "Copy output", a selection, a prompt) landed on the Mac and the
  phone's clipboard never moved, which reads as "I can't copy text from the output on
  mobile": the button worked, the bytes went to the wrong machine. `buildApi` now lets a
  transport answer a method ITSELF, and `browserApi.ts` answers this one and
  `readClipboard` locally - `navigator.clipboard`, falling back to the `execCommand`
  textarea on the plain-http LAN path, where there is no secure context. Still one list:
  the channel is still declared in `surface.ts` and the desk still uses it.
- **A finger cannot select a canvas, so the output is also served as TEXT.** xterm draws to
  a canvas and implements selection on MOUSE events; a finger dragged across it is a
  scroll, so no gesture on a phone could pick out a line of an answer. `TextSheet.tsx` is
  the pane's output as a `<pre>` - native selection, native loupe, one Copy all - and it is
  where the DEPTH problem is answered too: the live replay is capped at 400 KB
  (`BUFFER_LIMIT`), which for an agent whose "thinking" line repaints many times a second
  is minutes rather than turns, so a phone could not reach what the desk still had in its
  terminal. `paneLog` (`sessions:log`) reads the transcript off disk instead, up to 8 MB.
  **Rendered, never stripped**: `strip()` would put every repaint frame on its own line -
  the "it spams the thinking info" complaint written down as a document - so the bytes go
  through a real xterm off-screen at the pane's own width and its BUFFER is what is shown.
  Measured at 414x896: 400,000 bytes live against 529,160 characters / 20,008 lines in the
  sheet, all of it selectable.
- **A text field is the one place selection must survive `body { user-select: none }`.**
  That rule inherits, and WebKit takes it literally: on iOS a field under an inherited
  `-webkit-user-select: none` still types but will not raise the caret loupe, place the
  caret mid-word, or select a word on a double tap. That is "let me select in the prompt
  and change it - I can't even edit it on mobile". Both spellings, on every input and
  textarea.
- **...and the keys a phone keyboard does not have are drawn.** Once words are in the CLI's
  own input box they belong to the pty, and every way of changing them - caret left, rub
  out, escape - is a key that keyboard has no room for, so the bar could add to a prompt
  and never edit one. `HandheldType` draws ⌫ ← → ↑ ↓ esc at 44px, as bytes (`DEL` 0x7f for
  backspace, which is what a terminal sends). Tapping the terminal already moves the CLI's
  cursor; these are the rest.
- **A desk resize may not snap the pty out from under a phone.** The desk OWNS the size and
  a phone BORROWS it - but "the desk takes it back on the spot" was written for a borrow
  that had outlived the phone, and the desk does not only resize when a window is dragged:
  showing a pane, toggling the grid and the window's own layout all refit and land in
  `resize`. Each one pulled the pty back to 157 columns underneath a phone drawing 50, and
  a CLI repaints by counting rows in the width it believes it has - so every "thinking"
  frame landed under the last one instead of over it. That is "the output is very buggy on
  mobile, it spams the Claude thinking info". A desk resize during a borrow is now
  REMEMBERED (`deskCols/deskRows`) and applied when the phone lets go; the desk draws the
  borrowed grid meanwhile (`grid` on `TerminalPane`, the same fit a mirror uses, without a
  mirror's other refusals). `npm run test:panesize`.
- **A phone's `100vh` is not its screen.** It is the LARGE viewport - the one you get with
  the toolbars scrolled away - so `.app` at `100vh` laid the app out taller than the glass
  and its last ~60px sat under Safari's bottom bar, taking the typing bar with it. That is
  "it shows type to this pane, it needs to be moved up so you can tap on it".
  `html.handheld .app` is `100dvh`, and the bar clears the home indicator by 8px on top of
  the inset. Measured at 414x896: the input is 44px tall, ends 12px above the viewport,
  and `elementFromPoint` at its centre returns the input.
- **A phone re-wrapping a pane SCROLLS the old frame away; it may never clear it.**
  `t.clear()` was in that path and it is why a pane opened on a phone was blank: the
  buffer it dropped was the one `getBuffer` had replayed into that browser a beat earlier,
  so every pane seeded its history and then deleted it 400ms later. A screenful of
  newlines puts the mis-wrapped frame into the scrollback instead - where it can be read -
  and the redraw paints the live frame under it. `test:phoneview` proves the history
  survives AND that the re-wrap really happened (`__pf[id].rewraps()`): without the second
  half the check passes by never having run.
- **The desk owns a pane's shape; a phone borrows it.** One pty cannot be 50 columns and
  157 at once, and both windows fit their own screen and say so - so whoever spoke last
  won, and a phone that looked at a pane left the DESK drawing a full-width pane whose
  every line wrapped a third of the way across, for as long as it took somebody to resize
  the window by hand. Measured minutes after the phone was closed: desk terminal 157x57,
  pty 50x50. `resize` takes a `borrowed` flag; `returnSizes` puts every borrowed pty back
  and runs when the phone leaves the pane (`pty:return`, from `showList`) and when the
  last phone stream closes (`onIdle`). A desk resize takes ownership back on the spot, so
  a phone that borrowed hours ago can never snap a window the user has since resized.
  `npm run test:panesize`.
- **What was on screen was drawn at the other width, so the phone drops it.** The CLI
  hard-wrapped those lines itself; re-wrapping 157-column box drawing at 50 is not history,
  it is soup - which is what "I open a pane and it is all messed up, I have to clear it"
  was. On a phone, a COLUMN change clears the buffer and asks for a repaint. `clear`, never
  `reset`: it keeps the line the cursor is on, so a plain shell is left holding its prompt
  rather than a blank pane. Only columns, because the keyboard opening takes rows and
  nothing re-wraps.
- **A phone is not a small desktop.** Under 720px the list and the panes take turns
  (`handheld.ts` + one `@media` block); the list is the home screen and a tapped pane gets
  the display. `display: none`, never a 0px xterm. The pane's own header is made to FIT
  rather than to scroll: measured at 414px it wanted 458px of the 404 it had, so Close was
  off the edge entirely and Clear and Fix were 27x23 and 30x19 against a 44px finger. The
  path goes (the list said it), the folder and editor buttons go (`desk-only` - they open a
  window on the machine you are not holding), and what is left is 36px.
- **...and that was not enough, so the header stopped carrying actions at all.** With those
  hidden it still measured 486px of content in a 404px box: restart, Fix and Close drawn from
  x=417 to x=491, past the right edge with nothing to scroll them back, and `.pt-name` squeezed
  to **0px** paying for them - "can't drag menu where the clear button is and can't see on the
  right side all options". Five 36px targets, a ~150px agent picker and an 86px branch badge do
  not go into 404 however they are trimmed. The row now keeps only what says WHICH pane this is
  and every action moves behind one ⋯ into `PaneMenu.tsx`, the ordinary phone action sheet:
  full-width rows with a WORD on them, >=52px, destructive ones last. After: scrollWidth 404
  against clientWidth 404, and the name is back. `probe.mjs --touch` is what makes any of this
  checkable - half of what this app does on a phone is decided by `pointer: coarse`, which a
  device-metrics override does not supply.
- **A phone turned sideways is still a phone.** The handheld rule was width-only, so an iPhone
  in landscape (932x430) got the 282px sidebar beside a pane - a layout holding neither the Back
  chip nor the swipe, which is why "swipe left doesn't always work" was true in one orientation
  and not the other. `HANDHELD_QUERY` also matches a coarse pointer under 520px tall: a handset
  in landscape and nothing else, since a tablet held sideways is 820px tall. Same string in
  `styles.css`, and a copy that drifts is a layout with no rules.
- **The phone's own Back goes back to the list**, not out of the page: opening a pane pushes one
  history entry, `popstate` returns, and the chip unwinds that same entry so the stack cannot
  grow a step per pane opened.
- **The swipe back arms anywhere in the pane, never at the left edge.** That edge is the one
  strip a phone browser has already taken for its OWN back gesture, so the app was listening for
  the swipe it was least likely to be handed. It fires on clearly sideways and clearly more
  sideways than up (`dx > 60, dy < 70, dx > dy * 1.6`); a terminal's own scrolling is vertical,
  so there is nothing to take from it.
- **One composer, not two.** xterm's helper textarea is a text field to a phone, so tapping the
  terminal raised the keyboard with its own caret beside the app's typing bar. On a coarse
  pointer that textarea keeps its keydown handling (a paired hardware keyboard still types) and
  gives up being a field: `readOnly`, `inputMode: none`, out of the tab order. Gated on
  `pointer: coarse` and NOT on the handheld width - a narrow desktop window's terminal must stay
  typeable.
- **The typing bar autocorrects.** It was written as a stand-in for that textarea and inherited
  its `autoCorrect="off"`, which is right for bytes going straight to a pty and wrong here:
  nothing leaves the bar until Send, so the substitution has already happened before any byte
  moves, and what is typed there is a sentence to an agent, not a shell command.
- **A tap opens a pane on the first press.** A finger is never still, and a mobile browser
  throws the `click` away the moment it decides the gesture was a scroll - so the first tap
  was spent proving it was a tap. A touch that did not become a drag opens the row from
  `pointerup` instead, which no scroll heuristic gets to veto; a `pointercancel` and a
  finger that travelled more than `TAP_SLOP` still open nothing.
- **Automation opens a pane through `scripts/pf-ctl.mjs`, never through `open --args`.**
  On a Mac `open -na PaneForge --args --open <dir> --prompt <text>` drops the WHOLE
  argument list when any argument holds an em dash, exits 0 with empty stderr, and the
  app quits having found no request - five #momin bundles reported "session spawned" with
  no pane. pf-ctl posts JSON to the phone server and `sessions:start` answers with the
  pane's id, so the caller checks `sessions:list` instead of trusting a launcher.
  `--open` on the command line is for a person typing it.
- The pty never moves, same as Devices.
- `npm run test:phone` (server + surface parity, no browser). `npm run test:phoneview`
  needs a running copy: `npm run build && npm run try -- --keep --show`, then
  `node scripts/phone-view-test.mjs --port <port> --code <code>`. A pane's text is in
  `window.__pf[id].term.buffer`, never in the DOM - xterm draws to a canvas.
- Not built: headless host (B1 - the app must be running), phone-first diff (H2).

---

## Checks (full rules, moved out of CLAUDE.md 2026-08-21)


`npm run typecheck` before committing, and `npm test` — 81 checks in ~145s, everything
below that needs no window, no network and no real agent CLI (`scripts/test-all.mjs`).
It is also the gate's third step: `agentGate.ts` looks for a script called exactly
`test`, and while there wasn't one every lane the app drove reported its suite step as
*skipped*. A new cheap test goes in that list or it never runs by itself.

| Command | Covers |
|---|---|
| `npm run smoke` | the pty layer |
| `npm run test:restore` | which conversation a reopened pane goes back into |
| `npm run test:scrollback` | and what is on its screen when it gets there |
| `npm run test:consoles` | sweeping console hosts left behind |
| `npm run test:strays` | what a PANE left running (real orphans, ~25s) |
| `npm run test:gitpoll` | the badge's `git status` cache, over a fake clock |
| `npm run test:install` | quitting takes the install pty's whole process tree |
| `npm run test:lanes` | lane engine, worktree sweep, ownership, any-repo release contract |
| `npm run test:laneargs` | what `runSafe` hands a program, through a real cmd.exe |
| `npm run test:laneforeign` | a folder at a lane's path that is a checkout of a DIFFERENT repository: it is named and refused rather than adopted, and its commits are left alone. The load-bearing half is the control that the clone really does pass the old `--is-inside-work-tree` test, without which the case is never reproduced |
| `npm run test:lanepeers` | the arithmetic of a claim on the other desk: what a ref name may carry, and the negatives that decide whether the check is worth having — a desk never blocks itself, a claim nobody refreshed stops counting, and a letter lane is never anybody else's business |
| `npm run test:lanedevice` | the same thing with the plumbing attached: a real bare repo, two real clones, one told it is another machine. The second desk is sent to a letter rather than onto the shared branch, the trunk comes back the instant a chat ends, and the release lock is refused at the SERVER — with the two mechanisms that looked right and were not (the shared branch tip, and `--force-with-lease`) kept as controls |
| `npm run test:gate` | what stops an automatic release: a chat that said "done" and kept typing, and a red `npm test` — including the half that is invisible when it works, that a refusal is CACHED on the commit rather than re-running the whole suite every minute the retry timer asks |
| `npm run test:notes` | release-note ranges and both template shapes |
| `npm run test:pickrelease` | which release an install may take: the newest one carrying an asset THIS platform can install, so a win-only release is skipped rather than 404'd at for ever |
| `npm run test:remote` | the device link end to end over a real loopback socket |
| `npm run test:pairask` | pairing with no code typed: the six digits agree between the two ends, and — the case the whole design exists for — a real relay in the middle makes them DISAGREE |
| `npm run test:handoff` | a pane handed to the other machine whole, over a real link and real git: WIP pushed as `auto-sync:`, a 5 MB transcript chunked and reassembled byte-for-byte, `--resume` on the far end — and the refusals: a dirty far checkout, unpushed far commits, a folder outside the root |
| `npm run test:theme` | palette derivation + contrast (358 assertions) |
| `npm run test:stashtheme` | that the floating Stash picks no colour of its own, and asks the theme rather than the OS which way round it is |
| `npm run test:sounds` | the alert catalogue: nothing silent, nothing clipping, uploads |
| `npm run test:blurbs` | the "what this is" note on each feature, and that each is rendered |
| `npm run test:place` | the words a pane's strip prints (56 assertions) |
| `npm run test:agentenv` | the environment a pane's agent is started with — a provider is a catalogue entry with two variables set, not a branch in the spawn path, and a key placeholder with no key behind it is DROPPED rather than passed through: a CLI handed the literal `${OPENROUTER_KEY}` fails as a 401 several seconds into a pane that looks perfectly healthy. Also that every placeholder a built-in asks for is one Settings can actually fill, that one provider's key cannot fill another's variable, and that a placeholder nobody answers is dropped rather than handed over as a credential |
| `npm run test:devicewatch` | noticing that a ten-year cookie has been copied — and, the half that decides whether anybody ever reads a mark, that a phone leaving the house, an iOS version bump, a reloaded tab and a row with no stored user-agent all say NOTHING |
| `npm run test:projects` | which folders under the root are projects and which are copies of one: a lane worktree folds under its project (by git's own `gitdir:` pointer, and by a pruned lane's leftovers), while a repository called `service-a` next to a `service` stays a project — hiding somebody's repo is the worse bug |
| `npm run test:handofffit` | that the hand-off box can still be ANSWERED once real machine names are in it: the shipped stylesheet in a real headless Chrome at three window sizes, asserting the box fits, both answers are hittable and sit together (the 99px hole `test:confirmfit` caught once), and every device name is whole — measured with a Range over the text, because these spans stretch to the row and `scrollWidth` answers about the box |
| `npm run test:cardfit` | that a session card can still be READ once a lane loads it up: the shipped stylesheet in a real headless Chrome at the real 190px sub-line, asserting the agent's name, the clock, the pane's name and the place chip are all whole. Skips out loud with no Chrome |
| `npm run test:confirmfit` | that the app's yes/no box can still be answered once a real question is in it — measured on the offload one ("Start this pane on `<device>`?"), whose three faults all came from the dialog SHELL rather than the confirm rules: a `position: sticky` footer pinning to the scrollport's bottom EDGE and so sitting 2px ON the tick box of a dialog that was not scrolling, `.dialog-row .primary { margin-left: auto }` silently beating the confirm's own `flex-end` for a 99px hole between the two answers, and `.ghost`/`.primary` padding making them 34.8px and 38.8px tall. The load-bearing case is the LONG body: making the row static fixes all three and quietly removes the pinning the sticky was added for |
| `npm run test:diff` | reading a repo's changes: `-z` records, renames, patch numbering |
| `npm run test:railplace` | where a prompt tag is drawn: never off the rail, never far from the thumb it points at (no window) |
| `npm run test:grid` | layout arithmetic, no window needed |
| `npm run test:replytext` | what a reply looks like on the clipboard: the CLI's composer box, rules, footers and spinner rows dropped, `⏺`/`⎿` text kept, fixtures replayed from real history logs (replaced `test:turncopy` 2026-09-02 when the floating per-turn pair went) |
| `npm run test:cursorclick` | clicking where the CLI's cursor should go: the keys it sends, the clicks it refuses, and — the load-bearing half — that a BARE click can emit no vertical arrow at any input, plus deleting a highlight by walking to it and backspacing over it |
| `npm run test:stickyselect` | that a highlight stops moving when the mouse is let go — a real xterm in a real Chrome, with the control that the unconditional capture-phase `stopPropagation` this app used to do leaves the selection growing from 18 characters to 58 after the button is up, because xterm's own mouseup (a bubble listener on the document) never runs and its mousemove listener is never taken off |
| `npm run test:anim` | what a looping decoration may cost: an `infinite` keyframe may animate `transform` and `opacity` and nothing else. The idle dot's ring animated a `box-shadow` spread and measured **136% of a GPU core** against the same ring drawn as a scaling layer at **36%** (floor 20%), on IDLE panes — which is most of a working day |
| `npm run test:attach` | putting a picture in front of the agent: the bytes land on the machine that owns the pty, the extension comes off the magic bytes rather than off a name that lied, a batch too big for the device link is refused with a sentence and writes nothing on the way, and a file called `../../.ssh/authorized_keys` cannot leave the folder |
| `npm run test:asknotify` | a pane's question on its way to a phone: the message names the pane and keeps the CLI's own numbering, a machine with no bot credentials sends nothing and says so rather than throwing inside a pty read, and the post never asks for updates - which would steal `pf-telegram.mjs`'s poller |
| `npm run test:askclick` | that a click on a pane holding a live question types nothing into the pty - real mouse input through CDP against a real CLI chooser, with the control that decides whether the test means anything (the same click with no question must still send its arrows) and a red case that types six right arrows without the guard. Needs a window |
| `npm run test:settingsearch` | that a setting can be FOUND by typing what it does: the index is generated from the dialog's own source, so a setting added without regenerating turns this red rather than being quietly unfindable, and every entry is findable by its own name. The negatives are the rest - a nonsense query marks nothing, a second word narrows, and a reading in brackets ("Terminal font size (13px)") is not part of the name |
| `npm run test:choices` | reading a live question off a pane's frame and the keys that answer it: two real captured chooser shapes, and the negatives that decide whether it is safe to draw buttons at all - a numbered list in an answer, one somebody quoted back at the agent, a gap in the numbering, and no selection arrow. Plus the byte-level check that the arrows really are escape sequences, because the first version of this file lost its escape in the same edit the source did and passed |
| `npm run test:promptbox` | telling a CLI's drawn input box from everything that only looks like one — a zsh prompt, a diff, a markdown table — because a false positive there lets a bare click recall a command |
| `npm run test:promptsubmit` | that a pane opened WITH a prompt actually sends it: nothing typed while the CLI is still booting, the return sent as its own keystroke rather than the last byte of the paste, sent again while the pane stays idle, and never once it is working |
| `npm run test:onestash` | that there is one Stash: the overlay is a pill while the window is showing the list |
| `npm run test:stashsummon` | that the Stash is not on screen until it is asked for: closing HIDES the window rather than parking a pill, and a summon opens at the pointer, on the pointer's own display, clamped on |
| `npm run test:phone` | the phone client's server: nothing served before the code, calls landing in the app's own handlers, bytes surviving JSON — and PARITY, that one list feeds both transports and every line of it has a handler |
| `npm run test:panesize` | who owns a pane's shape when the desk and a phone are both drawing it: a phone BORROWS the pty's size, gives it back when it looks away, and can never undo a size the desk chose afterwards |
| `npm run test:tunnel` | the way in from anywhere: a URL that never resolves is never called up, a cloudflared that says nothing or hangs settles anyway, and the per-platform asset names a wrong guess would 404 on |
| `npm run test:funnel` | the provider whose address never changes: which machine can be funnelled, which refusals mean "quietly use cloudflared" rather than "tell somebody something broke", that what tailscaled really published beats what was asked for, and that stopping SAYS so — nothing else ever will |
| `npm run test:gist` | the one line History puts under a closed session: a pasted stack trace picks the sentence rather than the first frame, and nothing typed is nothing said rather than a guess |
| `npm run test:qr` | the pairing QR, by DECODING it: format bits, zig-zag, de-interleave, every Reed-Solomon syndrome zero, payload back out — every version at every mask. Nothing less catches a symbol that is drawn perfectly and reads nowhere |
| `npm run test:stash` | what the Stash may cost — no list leaving main carries a body; and what follows from that: search runs in main (a word past the preview is still found) and an edit keeps its row's place, its pin, and no second row saying the same thing |
| `npm run test:conceal` | what the Stash may not remember: the copying app's concealed marker, and the user's own deny rules. Markers only — never a built-in guess at secret SHAPES, because copying an API key to paste it at an agent is an everyday move here |
| `npm run test:pipe` | the live tee; ANSI stripping across chunk boundaries |
| `npm run test:copymode` | keyboard copy mode arithmetic |
| `npm run test:silence` | the quiet-turn alert; an idle pane is NOT stalled |
| `npm run test:discord` | Rich Presence against a fake Discord over a real named pipe |
| `npm run test:voice` | dictation: which transcriber, and a spoken clip through it |
| `npm run test:recall` | "you have asked this before" — and PARITY with the canonical fingerprint |
| `npm run test:rename` | the folder rename, on a throwaway repo |
| `npm run test:dock` | the macOS Dock icon (no `visibleOnFullScreen` without the skip) |
| `npm run test:macupdate` | the app replacing its own bundle |
| `npm run test:macdownload` | every way a mac download can end — none of them a hang |
| `npm run test:wedge` | that no hung promise can leave the updater needing a person |
| `npm run test:history` | what transcripts may cost: the age cutoff and the size cap |
| `npm run test:scrollclear` | that an agent's `/clear` stops destroying the pane's scrollback — all three shapes it has had (`CSI 2 J`, the erase-per-row, and the bare `ESC[6A` overdraw v2.1.233 sends, which erases nothing at all), a sequence torn across two chunks, that an unarmed repaint is left alone, and the result in a real headless xterm with a control per shape proving a plain terminal loses it |
| `npm run test:markanchor` | that a prompt tag survives the CLI erasing the row it sits on — with the control that a bare xterm marker does NOT, which is why Codex panes had no tags to jump to |
| `npm run test:restoreturn` | what a reopened pane inherits, and the turn a restart cut in half: the clock and the engaged flag that a restored row draws as a number and a green dot, plus the refusals around continuing - a pane that was not mid-turn, a pane launched with its own prompt, and the switch being off. The source assertions are half of it, because a green pure test over a function nothing calls is exactly the false confidence this repo keeps hitting |
| `npm run test:quitwords` | telling a Cmd-Q from something that asked from outside, when nothing in the app asked. The load-bearing case is the false positive: a blur a beat before the quit still reads as the keyboard |
| `npm run test:recover` | finishing a turn the transport cut in half: every real error string this desk has logged, and the refusals - a rate limit or an auth failure is never continued, and an error somebody QUOTED at an agent (which the CLI echoes back with no box around it) is a question about the bug, not the bug |
| `npm run test:reclaim` | closing idle panes to give a full machine its memory back: pressure is the trigger and never a clock, a pane WAITING FOR A PERSON is never closed however quiet it looks, and the window is never emptied |
| `npm run test:mascot` | what the mascot may do to somebody's panes: a number naming no pane closes nothing, a name contained in a longer one is dropped (`service` inside `service-a`), a count is not a pane number, and every suggestion is drawn from `reclaim.ts`'s own refusal set. The weight is in the four silences - it says nothing when the app's own clock is on, when one pane is stale, when the panes are cheap, or when they are minutes rather than hours old |
| `npm run test:autohandoff` | moving a finished pane to the other machine instead of closing it — and the refusals that decide whether that is safe: a pane mid-turn is QUEUED rather than killed, a pane holding a live question is not moved at all, and a queue that runs out of patience expires rather than interrupting anything |
| `npm run test:devlist` | what is serving right now, and which one a sentence names: a server and the child it spawned counted as ONE, a heap-size flag that is not a port, and the refusal that carries the feature - "close the dev" with three running picks none and prints the list |
| `npm run test:devservers` | turning a running dev server back into the package.json script that started it, so it can be started again over there: the two real command shapes measured on this desk, and the drops — an ambiguous tool, a script the receiving repo does not have, and anything a shell would read |
| `npm run test:macsign` | the signing that stops TCC resetting permissions every release |
| `npm run test:winshortcut` | whether a launch puts the Desktop shortcut back — and the three refusals, of which the load-bearing one is a `npm run try` copy out of `dist\win-unpacked`: a Desktop shortcut pointing at a folder the next build deletes looks fine until it is pressed |
| `npm run test:winfeed` | which release the Windows dev channel may point its feed at: the mac-only build skipped, the walk stopping at the first hit, and NOTHING installable resolving to nothing rather than to the newest anyway |
| `npm run test:promptecho` | reading a submitted prompt back out of a restored pane's own output, so a reopened pane gets its rail tags back — with the negatives that keep the rail readable: a `>` quote in an answer, a diff, a shell prompt, and the live composer drawing the same marker inside its box |

Needing a real window up (`npm run build && npm run try -- --keep --show
--remote-debugging-port=9333`): `test:view` (grid + find bar), `test:stashdrag`,
`test:activate`, (turncopyview removed 2026-09-02) (which is happy minimized),
`test:restorefix` (two launches of the dev copy - one to leave a desk, one to take it
back), `test:askclick`, `test:askrender` (the countdown on a real question, and what
arrowing through it costs every OTHER pane), and `test:phoneview` (a real headless Chrome at
414x896 against that copy — it skips out loud with no Chrome and no server).

Out of the default suite on purpose because they need the network: `test:discordbrand`,
which asks Discord what the shipped `DISCORD_APP_ID` is called AND whether it still has
the art asset `PRESENCE_IMAGE` names — it passes now, and the two halves fail separately,
because a correct name with no asset is a card with no logo on it; and
`node scripts/mac-update-test.mjs --live <version>` (~120 MB).

The other agent-runners are
watched by `npm run competitors` (`npm run test:competitors`), which diffs the
repos in `competitors.json` against the checked-in `docs/competitors.state.json` and prints
only what moved. It is deliberately quiet: sub-5% star drift says nothing, and a changed
README is the one line that means go re-read a feature list into `TODO.md`.

---

## A reopened pane comes back with what was on its screen (full rules, moved out of CLAUDE.md 2026-08-21)


The terminal's own scrollback is renderer memory, so before this every pane reopened blank —
most often right after the app updated itself, which is the restart nobody asked for.
`test:restore` is a different promise: it hands the agent its `--resume`, which brings back
the conversation and not one line of the screen.

- **Nothing new is stored.** `history.ts` has appended every pane's raw output to
  `userData/history/<id>.log` all along; `tail()` reads the last `BUFFER_LIMIT` of it, and
  the cap and the pruning are that file's, already pinned by `test:history`.
- The missing part was the **id**. A restored pane is a new session, so the desk carries
  `scrollbackId` (`snapshot()` in `sessions.ts`) and `start()` seeds the pane's buffer from
  it. Save the new id there and it restores nothing, silently, forever.
- `tail` must not strip ANSI (`read` does, for search) and must cut on a line boundary — a
  cut inside an escape sequence prints its tail as literal text across the first line.
- One dim line says where the old output ends, and it resets attributes first: the tail is
  cut mid-run, so whatever was in force at the cut would otherwise bleed into everything
  after it. `npm run test:scrollback`.

**And it comes back with its own clock, and finishes the turn it was cut off in.**
`snapshot()` wrote the pane's folder, agent and transcript ids and nothing the PERSON
knows about the pane, so a restored pane inherited none of it. Measured 2026-08-21, right
after the app installed an update and reopened nine panes: every restored row read
`engaged: false`, `runSince: null`, `lastRunMs: undefined`, which the sidebar draws as **no
clock at all** (the row renders `runSince`, then `lastRunMs`, then nothing) and the grey
`.dot.idle.ready` "ready - type to start" instead of the green `.dot.idle` "waiting for
you". Both are false about a live conversation. `shared/restoreTurn.ts` is the decision.

- The display clock is `openedAt`, a field of its own, and deliberately **not** `createdAt`.
  Three timers read `createdAt` as the age of THIS PROCESS - the `starting`->`idle` flip,
  the attention rule and the stall rule - so back-dating it would report a pane that is
  genuinely still booting as idle. Only the display reads `openedAt`.
- **A pane the restart caught mid-turn is continued.** `--resume` brings the conversation
  back and not the answer that was being written, so the CLI returns to an empty composer -
  idle, green, and indistinguishable from a pane that finished. `wasWorking` is read off
  `runSince`, the turn clock, which is set exactly while an agent is producing an answer.
  Same machinery and the SAME SWITCH as a turn the transport cut in half: with "finish a
  turn that was cut off" off, the app types nothing here either. It goes through
  `queuePrompt`, so a CLI still replaying its transcript is never typed over, and the flag
  is cleared afterwards so a manual restart hours later does not continue a dead turn.
- The refusals are the feature: a pane that was not mid-turn is left alone (typing at it
  starts a turn nobody asked for), and a pane launched WITH a prompt is left alone (two
  things queued into one composer is one of them landing inside the other).
- `npm run test:restoreturn`.

**And which restarts ask is one rule with one switch.** An update restart hands the desk
straight back and every other restart asks, which is deterministic and still reads as
random from the outside: the app updates itself several times a day, so the branch you get
depends on something you were never told about. `askAfterUpdate` (Settings -> Updates,
under "Reopen my panes after an update restart") makes the update restart obey the same
offer as a quit or a crash. **Off by default and deliberately so** - asking several times a
day costs more than the inconsistency it removes - and it does nothing while
`restoreAfterUpdate` is off, since there is then nothing to offer. Verified in a real
window against a desk written with `reason: 'update'`: on, the panes are OFFERED and none
opens until the question is answered; off, one pane comes back with no question, which is
exactly the behaviour every desk has today.

**And it presses Fix for itself.** The tail was hard-wrapped by the CLI at the width the
old pty had, and it is replayed into a terminal xterm opens at 80x24 and fits a frame or
two later - so the frame that lands is regularly drawn at the wrong width, the resuming
agent paints its own over it, and the pane reads as broken. That is "after the update
restart it looks broken, luckily Fix fixes it", and the app restarts itself for every
update, so it is the launch most panes on a desk get. A pane that came back with history
on it now runs `repair()` once - the same refit, agent redraw and repaint the Fix button
does - `RESTORE_FIX_MS` (1.2s) after its output stops, so a CLI still printing its resume
banner is not poked mid-paint. It is `autoFixUi`'s, since it is a poke; a mirror is
refused, because that machine is repairing its own pane; and a pane still hidden is left
FLAGGED rather than repaired against a 0x0 host, with the visibility effect asking again
once it has a real grid. `npm run test:restorefix`, whose control half is a brand new pane
recording ZERO repairs - without it "it repaired itself" cannot be told from "it repairs
everything".

**And the prompt tags come back with it.** The rail is built from KEYSTROKES on their way
to the pty, which is what makes it work for every agent - and it is why a reopened pane had
none: a restore replays bytes, nobody typed anything, `feedDraft` never fires. The app
restarts itself for every update, so most panes on a desk carried no tags at all, and "the
tag to scroll to my prompt does nothing" is usually "there is no tag". What can be recovered
is the CLI's own echo: measured in a live Claude Code pane, a submitted prompt is drawn on
its own line as `❯ <text>`, on the same buffer line the marker had anchored to (26 and 26).
`seedMarks` scans the replayed buffer for those and registers a marker on each, once, and
only while the rail is empty. **`❯` only, deliberately not `>`** - that starts a quoted line,
a diff line, a shell prompt and a markdown blockquote in an ANSWER, and burying six real
tags under thirty quoted ones is how a rail stops being read; an agent whose echo this does
not recognise is left exactly as it was. A rebuilt tag carries no time (`at: 0`), so
`markLabel` prints the text alone rather than inventing a clock reading.
`npm run test:promptecho`.

**And `/clear` no longer takes the previous turn with it.** A CLI clearing its screen sends
`CSI 2 J` *and* `CSI 3 J`, and the second deletes this window's scrollback — measured across
the 128 pane logs on this machine: 73 of each, always paired, and no other erase-in-display
in the set. So `shared/keepScrollback.ts` sits in front of every write: the wipe is dropped,
and the erase becomes a scroll (cursor to the bottom row, one newline per row, saved and
restored around it) — a newline at the bottom row scrolls, and a scroll puts a line into the
scrollback instead of deleting it. The alternate screen is left alone; vim clears constantly
and has no scrollback to protect. It is stateful because a four-byte sequence is routinely
torn across two chunks from the pty, so there is one per pane and every write site uses it.
`npm run test:scrollclear` drives a real headless xterm and its control case proves a plain
terminal loses the lines.

- **Then Claude Code stopped sending either of them, twice, and the answer stopped being a
  rewrite at all.** Measured 2026-08-13: v2.1.229 emits ZERO `2J` and ZERO `3J` in 4 MB and
  erases a row at a time instead (`ESC[H ESC[2K` then `(ESC[1B ESC[2K)` per row), which
  blanks the screen in place — a blanked line is never pushed into the scrollback the way a
  scrolled one is. Measured 2026-08-15 at the banner v2.1.233 draws for `/clear`, the whole
  clear is `ESC[53D ESC[4B \r ESC[6A` and then the banner: **a cursor-up and an overdraw,
  with no erase of any kind to catch** (the nearest erase-per-row was 12,590 bytes earlier
  and belonged to an ordinary repaint). That is "the claude avatar hides the previous
  output" — the last turn is painted over where it sat and nothing reaches the scrollback.
- **So the pane keeps the screen itself, before the CLI has emitted a byte.** `keep.arm()`
  is called when a submitted line matches `mayClearScreen` (`/clear`, `/compact`, `/new`,
  `/reset`) and RETURNS the scroll — the screen pushed into the scrollback and the cursor
  homed — which the pane writes on the spot. Whatever the CLI does next it does to a blank
  screen, so this needs to know nothing about any CLI and cannot go dead the next release;
  homing the cursor is what puts the banner back at the top rather than under forty blank
  rows. The intent still comes from keystrokes the app is relaying anyway, never from
  guessing which repaint is a clear — that guess is what the erase-per-row detection was,
  and it was silently a no-op the release after it shipped.
- **What was TYPED is not what was SENT, and reading the line literally missed half the
  clears.** Typing `/cle` opens the CLI's own command menu with `/clear` highlighted and
  Enter runs the highlighted row, so the pane saw four characters matching nothing, never
  armed, and the banner was drawn over the last turn exactly as before. Measured in a real
  pane: `/clear` typed whole keeps the previous answer (2 marker rows before, 2 after), the
  same clear picked from the menu after `/cle` destroys it (2 before, 0 after). So
  `mayClearScreen` arms on a bare slash TOKEN that is a prefix of one of those commands as
  well - the two mistakes are not the same size, since a miss destroys the turn somebody is
  reading and a false arm only scrolls a screen the CLI is about to repaint. `/co` arms as
  `/compact`'s prefix even when the menu was showing `/code-review`; a command typed whole
  (`/doctor`) and one carrying an argument (`/model opus`) are read literally and do not.
  What makes a false arm cheap is that only the rows holding something are filed: the pane
  passes `used()` and the scroll is that many newlines, not a screenful.
- **What is filed is the history, and the composer is not history.** At the moment a clear
  is submitted the CLI's composer is still drawing the line that was submitted, so filing
  the whole written screen kept `❯ /clear` twice - once as the box that held it, and once
  as the CLI's own echo of it on the fresh screen. Measured in a live pane: six `❯ /clear`
  rows in the scrollback for three clears, which is "it shows duplicated /clear message".
  `keptRows` stops at the composer's top edge, and the composer is only believed when the
  CARET is between its two rules - without that a markdown separator in an answer reads as
  an input box and swallows every row under it. Pinned by `test:scrollclear`, whose live
  shape is the one Claude Code 2.1.234 really draws (a rule, the line, a rule, the hints).
- **Then 2.1.235 wiped a third way, and the answer stopped being a list of shapes.**
  Measured 2026-08-19 off a live `claude` in a real pty: a submitted `/clear` sends `ESC[H`,
  then `ESC[2K ESC[1B` **29 times**, then `ESC[H` and the banner - an erase-per-row wipe
  with no `2J`, no `3J` and no `ESC[J` anywhere. Three releases, three byte patterns. What
  they share is a SHAPE: the cursor sent to the top of the screen with an **erase** as the
  first thing that happens there. `keepScrollback` reads that shape and REPORTS it; it does
  not act on it, because the same shape is also an ordinary repaint - one 8.4 MB pane log
  holds **152** of them. The pane snapshots the screen on the report, and `shared/screenLoss.ts`
  decides once the redraw has settled: `lostRows` is what the redraw did not put back, and
  a screen is filed only when **80%+ of it is gone**. Measured on that log, a CLI
  re-rendering a scrolling diff loses **13, 17 and 15 rows of 39, 39 and 36** (35-44%) and
  is left alone; a clear loses all of it. Filing the middle case is refused on purpose -
  mid-render frames are torn, and a scrollback full of those is this bug from the other side.
- **`arm()` is fed by keystrokes, and a keystroke is one of several ways a clear arrives.**
  The app's own **Clear** button writes `/clear` straight at the pty, and so does the
  session menu, a phone typing into a desk pane, and every path in main that types for you -
  none of which the pane's own `onData` ever sees. Measured in the running app 2026-08-19: a
  pane cleared by typing kept its screen, the same pane cleared through `api.write` lost it.
  `paneArmClear` (TerminalPane) is that seam and `clearPane` calls it before a byte goes
  out. An armed clear files the screen whole, colours and all; an unarmed one is still
  caught by the wipe check, one step later and in plain text.

- The `2J`/`3J` rewrite stays for
  a CLI that clears unasked, and stands down for 10s after an armed scroll so a `2J` that
  follows one cannot file a screenful of blanks in front of the turn being kept.

**And a prompt tag survives the CLI repainting over it.** The rail's tags are xterm markers,
and xterm disposes every marker on a row that `CSI J` blanks (`eraseInDisplay` →
`_resetBufferLine` → `Buffer.clearMarkers`, read off a stack trace taken from inside the
disposal). Claude Code repaints with erase-in-LINE, which touches no marker; Codex repaints
with erase-in-DISPLAY. Measured by replaying this machine's own pane logs into a real xterm
and registering a marker every 20 KB: **Claude Code lost 0 of 278, Codex lost 25%, 33% and
50% across three panes** — which is the "Codex shows no prompt tags so I cannot jump to my
prompts" report, and the prompt had not scrolled anywhere. `shared/markAnchor.ts` reads a
disposal for what it is: the line still being in the buffer means another marker goes on it
(on a deferred callback — the disposal fires from inside xterm's own walk over its marker
list), and only a line the buffer has genuinely forgotten ends the tag. Line 0 is the one
that goes: a trimmed marker was on line 0 an instant earlier, and that is indistinguishable
from a tag still sitting on the oldest line. `npm run test:markanchor`, whose control proves
a bare marker really does die.

---

## The resource ladder has a face (full rules, moved out of CLAUDE.md 2026-08-21)


`capacity.ts`, `autoHandoff.ts` and `reclaim.ts` trim, move and close panes on their own,
and until now the entire output of all three was a `console.info` in a devtools window
nobody has open - so the app's only automatic answer to a full machine was invisible, and
"where is the thing that manages resources" had no answer because there is no agent, only
three timers with no mouth. `shared/mascot.ts` is the mouth and `components/Mascot.tsx`
draws it. `npm run test:mascot`.

- **It is not a model.** Every sentence is arithmetic over readings the app already holds
  (`usage.ts` memory, `fleet.ts` state, `place.ts` words, the sidebar's own numbering), and
  every typed command is a small parser over that same list. No request leaves the machine,
  so it costs nothing to leave on - and a mascot that needed a token to say "pane 4 has
  been quiet two hours" would be switched off inside a day.
- **A guess is never an action.** "close pane 9" with five panes open closes nothing and
  says how many there are; a name is matched longest-first with a contained name dropped,
  so `close service-a` cannot also take `service`; and every destructive intent is OFFERED
  as a press, never run. `closeable()` is `reclaim.ts`'s own refusal set, so it can never
  suggest something the sweep itself would refuse - never a working pane, never one holding
  a question, never another machine's pty.
- **A finished turn is the pane this whole ladder exists for, and for weeks nothing could
  see one.** `fleetState` says `needsYou` both for an agent holding a live question and for
  an agent that finished and is sitting at its composer, so `closeable()` and `reclaim.ts`'s
  `CLOSEABLE` - both written as `ready | exited` - refused every pane anybody would ever
  want closed. On this desk that is every pane: "close the idle ones" answered *nothing
  quiet enough to close* with eleven finished agents on screen, and the idle-close clock had
  never closed anything in its life. The refusal that was meant is the pane's own live
  question (`asking`, off `Session.ask`), never the word for its state.
- **Nothing decides and then reports any more: it counts down first.** Both sweeps hand
  their plan to `armCloseRef` instead of calling `killSession`, and the mascot draws
  `CLOSE_COUNTDOWN_MS` (15s) of seconds with the pane named, `Keep it open` and `Close now`
  beside it. Doing nothing still closes the pane - it is a sentence with a clock in it, not
  a dialog, because nothing this app decides by itself may take the screen. `Keep it open`
  holds those panes for `KEEP_MINUTES` (10), since the sweeps run every minute and without
  that "keep it" is the same question a minute later for ever. With the mascot hidden there
  is nowhere to draw a count, so the old behaviour stands and it closes on the spot.
- **The sprite is a ROBOT and it does not float.** The fox bobbed on a 4.2s `translateY`
  loop, wandered between panes on a timer and ran along the bottom of the window every 2.5
  minutes, and all three were scenery. They are gone: movement is now a sentence (it walks
  to the card of the pane it is talking about) and the drawing holds still while a beacon
  pulses, a visor scans, the treads tick and the arms settle - four opacity clocks on
  periods that never line up. `src/shared/pets.ts`; `test:mascot` fails on a
  `translateY` anywhere in the sprite's stylesheet, because a float coming back is a
  regression rather than a taste change.
- **It speaks unasked exactly once per situation**, and only where the app is otherwise
  silent: two or more finished panes, quiet over an hour, holding more than 1.2 GB, with
  the idle-close clock OFF. With that clock on it says nothing, because the app is already
  handling it. The one thing it always says is what the ladder DID - a sweep that closed a
  pane now gets a sentence instead of a console line.
- **It can be picked up and put somewhere.** The sprite is dragged with pointer events (one
  path for a mouse, a pen and a finger), captured so a fast drag over a terminal does not
  leave it behind, and what is stored is the GRAB offset rather than the pointer - writing
  the raw pointer into `left/top` teleports it under the cursor on the first millimetre.
  A drop writes `mascot.spot` as a fraction of the window, which **beats every automatic
  move**: the walk and the wander both stand down while it is pinned, since a walk that
  takes it straight back off the corner it was moved out of reads as the drag not having
  worked at all. `📍` on the bubble gives it back to the walk. Under `DRAG_SLOP` the
  gesture is still the press that opens the bubble, and the click that follows a real drag
  is refused from a REF - `dragging` state is already cleared by the time it arrives.
- **The walk is how it says WHICH pane** - it moves to the card (`[data-id]`, always on
  screen, unlike a pane in a grid) rather than printing an id. One composited `transform`
  transition; the blink is `opacity`. `npm run test:anim` refuses anything else.
- **The layer never takes a click.** `.mascot-layer` covers the window at `z-index: 40` -
  over the panes, UNDER every dialog - and is `pointer-events: none` everywhere except the
  sprite and its bubble. It never focuses, never raises a window and never opens a dialog.
- **Mute by default**, and the speaker on the bubble is the only thing that turns a voice
  on: nothing the app decided by itself may make a noise into somebody's room.
- **It never picks which machine.** `hand off pane 2` opens the hand-off box with the panes
  already chosen; choosing the device is the one question that box exists to ask.
- **The bubble is placed in the LAYER, not beside the sprite.** It used to be a flex child
  of the fox's own box, and that box is centred on the spot - so saying anything widened it
  by ~310px, shoved the fox ~155px sideways to keep the new box centred, and hung the left
  half of the words off the window at the fox's own default corner (`x = 0.06`). That is
  "the chatbox is bugged, it is off screen, and now the fox is". `bubbleSpot`
  (`shared/mascot.ts`) puts it in pixels instead: clamped inside the window on both axes,
  above the fox when there is room and below when there is not, and above ANYWAY when there
  is room for neither - a bubble clamped to the top edge is readable, one clamped over the
  sprite is not. Unmeasured (the first paint) counts as full width, because centring a box
  whose size is not known yet on its own guess is what puts it off the edge for one frame.
  Pinned by `npm run test:mascot` with no window, and measured in a real one.
- **The sprite is PIXEL ART, and that is a correctness decision rather than a style one.**
  It was eight bezier paths, and at the 46px it is actually drawn at, a curve is resolved
  by the rasteriser rather than by us: the ears rounded off, the muzzle and the head merged,
  and what was left read as a blob with two triangles on it - "it doesn't even look like
  what you showed me". `src/shared/foxSprite.ts` is a 24x24 grid of characters, one per
  colour, drawn as one `<rect>` per horizontal RUN (169 rects for the whole fox, against 576
  cells) under `shape-rendering: crispEdges` at 48 CSS pixels, so a cell is exactly two
  device pixels and nothing is ever resampled. Four fills, still mixed in oklab from the one
  accent, because a surface-derived fill inverts between a dark theme and Paper.
- **Standing still is not ONE frame.** A fox drawn once and bobbed is a sticker with a
  wobble, which is why the first pixel version still read as flat. Four things move on four
  different clocks, and the periods are deliberately not multiples of each other (tail
  4.8s, weight 7s, ear 9s, eye 6.5s) so they never line up into a loop anybody can count:
  the tail sways over THREE heights of one drawing, the weight shifts between two standing
  leg poses, an ear flicks for 6% of its cycle - a beat, never a state, since a pose held
  half the time reads as a broken ear - and the eye darts forward and back. A pointer on
  the sprite speeds the sway and holds the ears up, which is the one thing that says the
  fox is a control rather than a picture. Ears go BACK while it runs; that is what makes a
  gallop read as effort rather than as legs.
- **It is LAYERS, not frames, and the motion is which drawing is showing.** A running fox
  differs from a standing one in its legs and its tail and in nothing else, so the body is
  drawn once and only the moving parts have variants - which is what makes seven poses a
  page of art rather than seven. Nothing rotates: a rotated pixel grid resamples and stops
  being pixels, which is exactly the blur this replaced. So a pose swap is an OPACITY step
  (`steps(1, end)` keyframes, two frames for the standing tail, four for the gallop at ~8
  frames a second), and opacity is the one thing besides a transform that `npm run test:anim`
  lets loop. Dust off the back paws is a transform and an opacity too.
- **A pose defined and never drawn is dead art nobody notices for a year**, so
  `npm run test:mascot` reads `Mascot.tsx` for every entry in every slot every pet can carry and the
  stylesheet for every layer class, and checks the grid is square - a row one cell short
  does not draw a wonky fox, it shifts every colour after it on that row.
- **It runs along the bottom of the window every so often** (`DASH_MS` / `DASH_EVERY_MS`,
  nine minutes, chasing a ball), and that run is the one thing here that is not a reading - so it stands down
  the moment it would be in the way: a bubble up, the ask box open, a spot somebody dragged
  it to, or `roam` off. It is placed at the starting edge with the transition OFF for one
  frame (`dash-port`) and then given a single `left` transition across the window; without
  that frame the browser coalesces both writes and it slides to the start line instead. The
  legs only move while it is running and the sprite flips rather than moon-walking.
- **A press closes whatever is up**, whichever half of it is up. Toggling `open` alone left
  a notice bubble on screen with no way to dismiss it from the sprite, which reads as the
  press not working.

---

## Releasing happens by itself (full rules, moved out of CLAUDE.md 2026-08-21)


One command, and it is not a release:

```
node scripts/lane.mjs ready --repo <dir> --session <id>   # this lane is done and verified
```

`ready` merges master into your lane first, refuses to mark anything while that merge is
dirty, then releases once **no chat is mid-work** — one version bump for everyone, whoever
finishes last. If another chat is still editing it says so and does nothing; wait rather
than shipping again. Edit or commit after marking and the mark is dropped, by name.

- **Below 1.0 an automatic release only ever moves the patch.** It still reads its own bump
  off the commit subjects since the last tag (`bumpFor` in `scripts/release-notes.mjs`, the
  same source the notes come from), but `nextVersion` in that file demotes it: a `feat:` is
  a patch like everything else, `feat!:` is the one bump a commit may still ask for and it
  gets a minor, and a minor or a major otherwise has to be typed — `node scripts/lane.mjs
  ship minor` / `ship major`. Reading `feat:` as a minor is right for a released product and
  wrong here: below 1.0 nearly every commit adds something, so the minor stopped meaning "a
  batch of work landed" and started meaning "a session happened" (v0.4.62 → v0.8.0 in one
  day over six releases carrying seven commits). At 1.0 the ordinary semver reading comes
  back on its own. A bump named on the command line is always obeyed as given.
- Releases batch: one per **2 hours** (`COOLDOWN_MS`). Inside that window the work sits on
  master for the next `ready`. Do not "fix" that with `npm run ship`. It was half an hour
  until 2026-08-20, which batched nothing: 130 releases in the 14 days after v0.8.0, 9-13
  a day at 3.8 commits each, because half an hour is shorter than one build-and-verify
  cycle. "A release costs nothing to ignore" is true of the update PROMPT and of nothing
  else — on the dev channel each one is a build to install and a restart to take it. And
  the number is not the problem it looks like: 130 patches on a 0.x shipping ten times a
  day is honest, so the fix is the rate, never a renumbering.
- `npm version`, `git tag vX` and pushing a version tag by hand are **blocked**.
  `npm run ship` exists for a build Robert needs in his hands now — say why. It is also
  the one path that skips the two checks below, deliberately: a person is watching it.
- **Three things stop an automatic release, all reported by name**: master not
  typechecking, master failing **its own `npm test`**, and a lane conflicting with master.
  A conflicting lane is left out; the rest still goes out. `rerere` is on, and the retry
  timer re-tries recorded conflicts every minute.
  - The suite gate is `suiteFailure` in `scripts/lane.mjs`, and it exists because a
    typecheck proves the types agree and never that the app works. Every one of those 130
    dev builds went out on a typecheck alone, and a broken one costs whoever runs the dev
    channel a download, a restart, and an app that is still wrong.
  - **The answer is cached on the COMMIT**, in the shared ledger. The app's retry timer
    asks once a minute: uncached, a red master burns the whole suite every minute for as
    long as it stays red. A new commit is the only thing that invalidates it, because the
    suite is a fact about a tree.
  - A suite that could not START is named as this checkout's tooling, never as a failing
    test, and is deliberately not cached — same distinction `typecheckFailure` draws, and
    the sentence is what decides where the next person looks.
  - `npm run test:gate` covers the release gate, red suite and cache included.
- Release notes come from Conventional Commit subjects between version tags
  (`scripts/release-notes.mjs`, template `.github/release-notes.md`). `npm run test:notes`.
  **Only `feat:`, `fix:` and `perf:` reach the page** — the release body is public and is
  read by somebody deciding whether to take the update, while a `docs:` subject here is
  written for the next session in this repo. Everything else, and every subject with no
  conventional prefix, is dropped; a release carrying only those falls back to the
  commit-history link rather than heading an empty section. There is no catch-all
  heading, and adding one back is what made the pages read like a diary.
  **The drop used to be silent, and that is how a real fix vanished**: v0.8.92 carried
  `Fix browser image drags by fetching URIs instead of pasting URL strings`, a change to
  `src/` worded as a sentence, so the page said "see the commit history" and nothing
  anywhere said otherwise. `unpublished` in that file names a commit that touched `src/`
  and carries NO conventional prefix, and `doctor` prints it while the subject can still
  be reworded. It reports and never rewrites - a heading inferred from a sentence is a
  guess on a public page. A `docs:`/`test:` subject over `src/` is dropped ON PURPOSE and
  is never named; the first version of the report flagged one and that is the shape that
  makes a warning unread.
- Actions and this machine can BOTH publish a release. The duplicate installers are
  harmless; `latest.yml` is not, because the loser's feed names the winner's file.
  `reconcileFeed` on the retry timer compares the feed to the asset it names and puts ours
  back. Never hand-fix a feed without checking the asset's real size — v0.4.27 shipped
  33 bytes out and looked perfect. Until v0.4.32 it happened on EVERY release and the
  stated cause — "the 45s poll missed a run that was merely slow" — was wrong: the poll
  never worked at all. Its `?event=push&per_page=10` went through `shell: true`, where cmd
  reads the `&` as a command separator, so it ran as two commands and reported the second
  one's failure. `runSafe` quotes its arguments now (`cmdQuote`); `npm run test:laneargs`
  round-trips them through a real cmd.exe. Assume nothing about an argument.

- **Every automatic release is a DEV release.** It is cut as a GitHub prerelease:
  installs opted into the dev channel (Settings → Updates → "Dev channel", config
  `devUpdates`) take it within the half hour, while every stable install resolves
  `/releases/latest`, which GitHub keeps pointed at the newest PROMOTED release.
  Nothing reaches a stable app until a build is promoted — and promotion happens **by
  itself**, on the big-company channel shape (Chrome, VS Code): the newest dev build
  that has been on the channel `PF_PROMOTE_SOAK_MS` (3 days) auto-promotes, from the
  same minute timer as everything else (`autoPromote` in `lane.mjs retry`). The soak IS
  the proof: dev-channel installs ran that build three days and nothing needed a fix,
  and it carries every skipped version with it in one update. **The soak is that
  build's own age, not a quiet period across the channel.** Requiring the NEWEST build
  to sit untouched sounds stricter and really promises that stable never moves: this
  repo ships most days, every release reset the clock, and on 2026-08-14 that had
  produced 20 unpromoted dev builds with stable still on v0.8.32 — a Mac on stable
  could not update out of a broken build no matter how often it restarted, because
  there was never a newer stable one to find. `npm run test:promote` covers a soaked
  build promoting with a younger one sitting on top of it. `node scripts/lane.mjs promote
  [version]` by hand is for "stable needs this now" (a bad build already reached
  stable) — never promote a build by hand on a green diff alone. Both paths refuse
  a one-legged release (either platform's feed missing) and a feed whose declared size
  disagrees with the asset being served, then verify `/releases/latest` really moved.
  `lane.mjs doctor` lists what waits and when it auto-promotes. Tags stay plain
  (`v0.8.29`) — the prerelease FLAG is the channel, so stable gets exactly the tested
  bytes. `npm run test:promote`.

**A release claims the thing is finished.** Never cut one while any next step for that
issue is still open — and **promotion claims it is proved**: the dev channel buys the
room to iterate, and the soak is what turns iteration into proof.

---

## An agent's question is a row of buttons (full rules, moved out of CLAUDE.md 2026-08-21)


A CLI that asks "which of these?" stops until somebody arrows to a row and presses
return. At the desk that is two seconds; away from it, it is the rest of the run - the
pane goes idle and green and looks exactly like one that finished. `shared/choices.ts`
reads the chooser off the pane's own frame, so it covers every CLI here rather than
whichever one has a hook.

- **The reading is narrow because the expensive failure is a FALSE question**, not a
  missed one: buttons drawn over a numbered list in an answer would type arrow keys into
  a composer holding somebody's draft. Three things must all be true - the CLI's own
  `Enter to select` / `Enter to confirm` footer, options numbered 1..N with no gaps, and
  exactly one row carrying the arrow. Both positive fixtures in `npm run test:choices`
  are real frames off this machine's pane logs, because the AskUserQuestion widget puts a
  paragraph under each option and the built-in resume prompt does not - a parser written
  against either alone reads the other as no question at all.
- **Arrows and a return, never the digit.** A chooser that only reads the arrows ignores
  a digit silently, and the two are indistinguishable from the frame. Spaced
  `CHOOSE_GAP_MS` apart for the same reason `queuePrompt` sends its return separately: a
  burst in one write reaches a widget that has not redrawn between the keys.
- **It counts from where the arrow is NOW**, so the frame is re-reported when the
  selection moves (`askSignature` includes it). Without that, somebody arrowing at the
  desk leaves a phone's button picking a row the distance they moved it away. A press
  against a question the pane has left is REFUSED, never walked from a stale position.
- **The reading is on the SESSION, not in the pane**, because the surfaces that are not
  the desk are the point: the phone client draws the same buttons and `pty:choose` is
  reachable over the phone server. A mirrored pane is answered by writes over the link,
  keyed off the frame that came with the session list.
- `scripts/pf-telegram.mjs` posts a question to Telegram with one button per option.
  **It is post-only by default and that is load-bearing**: a bot token has exactly one
  long-poller, and a second does not share the updates, it STEALS them and breaks the
  first with `409 Conflict` - measured against the live bot on the first run. Taps arrive
  by being handed to a loopback endpoint; `--poll` is opt-in and only correct for a token
  nothing else reads.
- **A question is also RED, and it also leaves the machine.** Every idle reading in the app
  says yes about a pane that is only quiet because it is owed an answer, so the card
  glows red down its left edge while `Session.ask` is set (`.row.asking`; there is no ring
  on the pane itself any more - drawing the same fact a second time over the agent's live
  output read as something the agent had printed, and the sidebar is where a person looks
  to find WHICH pane is owed an answer) and
  the card's title line carries the word `asks you` with the question on its hover - the blue
  lane glow that was removed from that card was removed for being a colour with nothing to
  read, not for being a colour. The same moment posts the question to Telegram
  (`main/askNotify.ts`, from the new `ask` event on SessionManager, Settings → "Send a pane's
  question to Telegram"): `scripts/pf-telegram.mjs` is the half that turns a TAP into
  `pty:choose` and nothing on this machine ever started it, so the message had never once
  arrived. It posts and stops - no `getUpdates`, because a bot token has exactly one
  long-poller and a second one steals the updates rather than sharing them. Silent with no
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (environment or `~/.claude/usage-notify.env`), one
  message per question (`sameAsk`, so arrowing through the options sends nothing), and never
  for a mirror - that pane's own machine is raising it too. `npm run test:asknotify`.
- **A click on a pane holding a question types NOTHING into it.** Clicking a pane is not
  passive here - a bare click becomes left and right arrows, an Alt-click up and down, a
  selection delete a run of backspaces - and a chooser is the one moment when every one of
  those is an ACTION. Measured against a real `claude` in a pty on 2026-08-19: 15 right
  arrows sent at its `/model` chooser moved it from Medium to `max effort` (the widget
  says the arrows adjust it, and means it), and 2 down arrows moved the selection and left
  a torn partial repaint - which is "I click on the question and it disappears and breaks
  my whole terminal". The same run showed Claude Code turns mouse reporting OFF (no
  `?1000h` in its whole boot), so `mouseGrabbed()` is false, nothing is swallowed, and the
  pane's own handlers were the only thing typing. `askRef` in `TerminalPane.tsx` refuses
  all three while `Session.ask` is set; the answer is the buttons, which say what they do.
  `npm run test:askclick` is a real mouse through CDP with the control that decides
  whether it means anything - the same click with no question up must still send the
  arrows. Its red case (guard removed) types six right arrows into a live question.
  **`window.api` is frozen by the context bridge**, so a test cannot wrap `write` to see
  what a click did: the assignment is dropped in silence and every click then reports
  "typed nothing". The pane keeps its own list (`window.__pf[id].clickKeys()`).
- **A question is RED and it makes a NOISE of its own.** The card and the pane glow
  (`.row.asking` / `.xterm-wrap.asking`) and `sounds.ask` (default `knock`) plays on the
  new `sessions:ask` event - `done` is deliberately NOT played over it, because a finished
  turn and a stopped one are the two most different outcomes there are and one chime for
  both is why a question sits for an hour. The glow was there before this and was 7% over
  a dark card, which is a tint you find once you know it exists; it is 15% with a 3px
  pulsing bar down the card's left edge now.
- **A RULE in the list is not prose, and reading it as prose made every question
  invisible.** Claude Code 2.1.235 draws a full-width rule between the answers it was given
  and the two it always appends (`Type something.`, `Chat about this`), wrapped onto a
  second row in a wide pane. The walk up from the footer treated it as prose, stopped one
  option in, and the 1..N check failed - so on 2026-08-19 a live 159-column taskdriver.ai
  pane with a question plainly on screen read as NO question: no buttons, no red card, no
  Telegram message and nothing for `autoAnswer` to press. A rule is read exactly like a
  blank line now. It cannot admit a false question, because the FOOTER is still the
  load-bearing signal and only a chooser widget draws one. The box gutter a CLI leaves down
  the left of its question is stripped as well - it was reaching the buttons and the
  Telegram message as a literal bar.
- `npm run test:choices`. The load-bearing assertion is on the BYTE
  (`charCodeAt(0) === 27`): the first version of that test lost its escape in the same
  edit the source did, so `'[B' === '[B'` passed while the app would have typed the
  letters into a chooser.

### The screen that ENDS a multi-question ask prints no footer (2026-08-23)

Reported as "when it asks questions it doesn't finish and submit answers". Every question
in the set WAS answered - the tab strip shows each one ticked, several of them by
`autoAnswer` itself off a `(Recommended)` marker - and then the widget draws a review:
the answers listed back, and `1. Submit answers / 2. Cancel`. Nothing is sent until that
list is answered, and the app could not see it.

Two separate faults, and the first one hides the second:

- **`readAsk` returned the WRONG question, not none.** The review screen prints no `Enter
  to select` footer at all, measured off two real frames in this machine's own pane logs
  (`history/s10-mt5pfcld.log`, `history/s11-mt2ptrhm.log`). The footer is the load-bearing
  signal in `choices.ts` and `readAsk` takes the LAST one in the tail - which on that
  frame belongs to the question asked immediately before the review. So the pane drew
  buttons for a question the CLI had already moved past, `askKey` never changed, and
  `dueForAuto` correctly refused to press a question it had already answered. A missing
  footer read as a stale question rather than as no question, which is why nothing in the
  app said anything was wrong.

  `REVIEW` is a second anchor, and it sits ABOVE its list rather than below it, so
  `readReview` walks DOWN. It wins only when it is NEWER than the last footer. The two
  refusals that keep it as narrow as the footer: the list must still be 1..N with exactly
  one `❯` (a numbered list quoted in an answer never carries one), and **nothing but
  blank rows and rules may follow it** - once the answers are sent the CLI prints
  `⏺ User answered Claude's questions:` and the whole echo under those same rows, and they
  stay in the painted tail. A return pressed at that would land in a composer somebody may
  be holding a draft in.

- **`GOES` did not read `Submit` as a go-ahead.** With the review readable, `pickAnswer`
  still returned null: `Submit answers` leads with none of the yes-shaped words, and
  `Cancel` is refused by `STOPS`, so a question with exactly one usable option had no
  answer. `submit|done|finish` are the narrowest sense of "go on with what you were
  doing" there is - every decision was made on the screens before this one, and the only
  alternative discards them all. A `Submit answers and don't ask again` is still refused
  by `WIDENS`, and the arrow sitting on `Cancel` still does not make Cancel takeable.

### ...and the countdown it draws was red on red

`--surface-1` is defined **nowhere** - the palette is `--bg`, `--surface`, `--surface-2`,
`--surface-3` - and `.pane-ask-auto-left` asked for `color: var(--surface-1)` over
`background: var(--danger)`. An invalid `var()` in a `color` falls back to `unset`, which
for an inherited property means inherit, and the parent `.pane-ask-auto` is `var(--danger)`
itself. Measured in a real window: **1.00:1**. The red box was there, with the seconds
invisible inside it - which is exactly the report, "in the small card it should show the
number counting down inside the red box".

Seven sites had it, all silent, and the same edit had just added an eighth. Backgrounds
became `var(--surface)` and the two text-on-danger cases `var(--bg)`; measured after,
**7.47:1**. The same sweep found `var(--acc)` (three sites - the palette is `--accent`),
`var(--fg)` (six - it is `--text`), and the whole `.autoclear-card` block written against
`--panel` / `--border` / `--text-secondary` / `--text-muted` / `--hover`, none of which
exist: that card shipped the same day with a transparent background and no border.

The tell for the next one: an invalid `var()` never errors, never logs, and in a `color`
it inherits something plausible. Only two things catch it - reading the computed value in
a real window, and checking every `var(--x)` in the stylesheets against the keys
`paletteFor` actually returns (`--agent`, `--level` and `--mono` are the legitimate
exceptions: the first two are set inline per element, and every `--mono` use carries a
font-family fallback).

### The seconds are inside the red box, not beside it

The sidebar card drew two chips - `asks you` in tinted red, then a separate solid-red
`12s`. Two red boxes on a 190px title line read as two readings about two things, and the
half that is actually moving looked like the unrelated one. They are one fact a step
apart, so the clock is now a child of the chip. `min-width: 30px`, because measured at 22
the pill was 22 / 27 / 28.6px for `9s` / `12s` / `now` and the row jogged sideways on
every tick and again on the last one.

---

## ...and a question with an obvious answer is answered (full rules, moved out of CLAUDE.md 2026-08-21)


Buttons fixed "nobody was at the desk". The next cost is at the desk: most of those
questions are the CLI asking whether it may do the thing it was just told to do, and the
person presses return. `shared/autoAnswer.ts` presses it instead — **on by default**
(Settings → "Answer an agent's question for me when the answer is obvious"), with the wait
adjustable beside it and a **thirty second** default (1.2s, then 5s, then this).

**The wait is spent away from the window, and that is what fixed the number.** Robert,
2026-08-24: "timer keeps going down when I go to that tab or have focus on PaneForge ...
I want it to stop so I can actually read the question ... and it doesn't give me time to
reply in Telegram with the button". Both halves are the same defect: the wait was sold as
"the window in which somebody who disagrees can reach the pane", and it was being spent by
the person who had already reached it — switching to the pane to read the question was
exactly when it ran out, and the seconds it burned there were the seconds a phone needed.

So `holdWhileWatching` (on, and a switch under the enable) stamps `askHold` for as long as
this window has the keyboard, and `startOf` starts the clock at the later of `askHold` and
`askSince`. Consequences, each deliberate:

- **Looking away starts the WHOLE wait again**, never a part-spent one. The question is only
  readable while somebody is here, so time here is not grace.
- **Held draws no countdown**, only a `hold` row naming the option it would press
  (`autoAnswerHeld` on the session; `AskCountdown` returns early and subscribes to
  `Infinity`, so it does not wake the app once a second either). A deadline that resets the
  moment the window is left is not a countdown, and drawing one promises a second that never
  arrives.
- **30s rather than 5s** falls out of it: the wait is no longer "long enough to notice", it
  is "long enough to answer from somewhere else", and the question does leave the machine —
  `main/askNotify.ts` posts it to Telegram with the options as buttons. Five seconds is not
  a notification, an unlock and a press.
- **One focus probe**, `gameMode.deskFocused()`, which main already hands the window to.
  A second one is how two answers to "is this window focused" end up disagreeing.
- **`migrateAutoAnswer`'s `defaultsV3`** moves an existing desk once, off the SAVED config,
  and only where `waitMs` is still 1200 or 5000 — a number typed in Settings is somebody's
  own. The hold is applied unconditionally because no config in existence carries an answer
  to a switch that did not exist.
- `test:askrender` sets `holdWhileWatching: false`: it is about the countdown being DRAWN,
  and left on it would pass or fail on whether the probe's window happened to be focused.

**And both clocks now tick against the deadline.** `AskCountdown` and `AskClock` called
`useNow()`, whose buckets turn over on the wall second while `at` is an arbitrary
millisecond — so the last step before a press was however much of a second was left, which
is what "looks a bit buggy when the timer counts down" was. `useNow(1000, at)` aligns every
tick to the real remainder. The two have to agree: they are two readings of one press.

It was off for exactly one reason — "arriving switched on with an update would answer a
permission prompt on a desk that never asked for that" — and the answer to that is the
countdown, not silence: the pane names the option about to be pressed and counts the
seconds down, and a press or an arrow at the desk cancels it. 1.2s was long enough while
whoever got it had gone looking for the setting; on by default the wait has to be long
enough to READ, which is why the number is now a control. Every refusal is unchanged.

**The countdown is a banded row, and the option it will press is marked on the row.** It
was an 11px line of text under the question and was reported as not being on screen at all;
it is now a pill with the seconds in it (tabular, so the row does not jog as 10 becomes 9)
beside `Answering for you with <option>`, and that option's button carries `.auto` - dashed
rather than solid, because `.on` is a different fact (where the CLI's own arrow is) and the
two are often different rows. `npm run test:askrender` measures the row's real size in a
live window, because "it renders" and "it is on screen" are not the same claim.

**A changed default cannot reach an existing desk on its own**, and this is the trap:
`defaults()` is WRITTEN to config.json at first launch, so every install carries
`enabled: false` explicitly and a flip in `DEFAULT_AUTO_ANSWER` reads as somebody's own
choice. `defaultsV2` is the marker that separates the two and `migrateAutoAnswer` in
`main/config.ts` applies the new defaults once — after which off stays off through every
later update. The marker is read off the **saved** config and never off the merge: the
default carries it, so asking the merged object answers yes for every config in existence,
which is how the first version of this ran on nothing and left this desk exactly as it was.

- **The refusals are the feature.** Exactly ONE option leading with a yes-shaped word is
  answered. Two are a choice between them; none is a decision somebody is being asked to
  make. An option that WIDENS permission (`don't ask again`, the bare word `always`) is
  never reachable in either mode — it is the one press that cannot be undone by noticing a
  second later — and neither is one that stops or answers with a question of its own
  (`No, tell Claude what to do differently` leaves the CLI holding an empty composer, so a
  pane that was merely waiting is now waiting AND has lost its question).
- `anyQuestion` is the wider setting and it takes **the CLI's own default**, the row its
  arrow is already on, rather than inventing a preference. The two refusals above still
  hold over it.
- **The timing is `dueForAuto`, and it takes TWO signatures of the same question on
  purpose.** A press waits until the frame has sat unchanged for `waitMs` (1.2s — the
  window in which somebody who disagrees can reach the pane) and that signature includes
  where the arrow is, so moving it at the desk restarts the wait. But "have I already
  pressed this one" may NOT be asked of that signature: our own keys move the arrow, so a
  press restarts its own settle clock and a second sequence interleaves with the first,
  arrows landing between each other and the wrong row committed. `askKeyOf` is the
  question's identity with the arrow left out, one press per identity, plus a
  `PRESS_COOLDOWN_MS` floor of 4s so nothing can be pressed while its own keys are still
  landing.
- **`maxRun` is given back by the pane going BUSY, and by nothing else.** A chooser
  mid-repaint reads as no question for one frame, so returning the budget on "no question
  on screen" hands it back several times during a single question and the cap bounds
  nothing. A busy pane is the only evidence that an answer went in and work resumed.
- The keys go through `choose`, which re-checks the question before every one of them.
- **It says when, and what, before it does it.** `autoAnswerAt` puts the press's own clock
  on the session (`Session.autoAnswerAt` / `autoAnswerN`) and the pane counts down against
  it (`AskCountdown`). Same guards the presser runs under, so a question this will never
  answer shows no clock at all rather than one that never fires. Refreshed from the TIMER
  as well as from a frame: a frame only arrives when the screen changes, so computing it
  only there meant switching the setting on over a question already up showed nothing and
  then pressed out of nowhere.
- `npm run test:autoanswer` — 25 checks, weight in the negatives: every wording of "and
  stop asking me" (not the two strings this desk has captured), the timing behaviourally
  over a fake clock, and source assertions on the STATE the guards read, because a test
  that only matches the comparison lets the assignment making it true be deleted.

## A pane says how long it has been open

Reported 2026-08-24: "i wanted a running counter on any session open in the top header, it
just shows full time this session has been open, it still runs up even after a /clear ... i
just dont want it to lag me that much so think of a good method to keep track then in
history could show like sesssion open for 12h etc."

The reading itself was already on the session - `openedAt`, with `createdAt` behind it - and
already drawn, in `SessionInfo`'s "Open for" row. What was missing was the header, and the
cost of putting it there. The turn clock is one per pane and short-lived; this one is one per
pane and lives for DAYS, so the naive version is a React render per pane per second, for the
whole life of the desk, redrawing a string that was already correct.

Hence the step. `Elapsed` asks the shared timer for the unit it draws rather than for the
second: `stepFor` returns 1000 under an hour and 60_000 past it, straight off the shape of
`formatElapsed`, and a clock with `until` set asks for `Infinity` and subscribes to nothing -
a History list of eighty closed sessions was eighty subscribers being woken every second to
recompute numbers that cannot change. Measured in the test: 3600 wakeups an hour becomes 60.

The trap is the offset, and it is invisible in a wakeup count. Bucketing on the wall minute
(`Math.floor(now / step)`) ticks exactly as rarely as bucketing on the pane's start, so any
test that asserts "once a minute" passes either way - and a pane opened at 09:00:30 turns its
displayed minute over at :30 past, so the wall-aligned version leaves the header reading
`1h 04m` for up to 59 seconds after it became `1h 05m`. A clock that is SLOW is a design
choice; a clock that is WRONG is a bug. `bucketOf(now, step, since)` is the fix and the
offset-free version is kept as the control assertion.

The arithmetic moved to `src/shared/elapsed.ts` for one reason: `Elapsed.tsx` is TSX, node
cannot load JSX through type stripping, and so `formatElapsed` - read a hundred times a
second and never tested - had no test at all. `Elapsed.tsx` re-exports it so the dozen
existing importers did not move.

`formatElapsed` grew days on the way (`7d 03h`): this clock is routinely overnight and
occasionally a week, and `171h 20m` is a number somebody has to do arithmetic on to read.

One trap hit while building it, and it is the one CLAUDE.md already warns about: `.pt-open`
was first written `color: var(--text-dim)`, which is not a key `paletteFor` returns. A
`var()` naming a token that does not exist does not error - in a `color` it inherits
something plausible. It is `var(--muted)`, the token `.hint` uses.

Verified in a live window on :9334: one chip per pane, `1s` with the full title,
`rgb(160,151,143)` at 10px, ticking 2s -> 5s across three seconds.

## The sessions list is the whole desk, both machines

Two changes, and the second is only possible because of what the first one found.

**Why the Fleet dialog is gone.** It was a modal listing every pane sorted by who needs a
person, with a preview line and a diff bar. Everything about it was right except that it
was a SCREEN: the sidebar is what somebody is already looking at when they want to know
which pane to go to, and asking them to press Ctrl+Shift+F to get that answer means the
answer is not there the rest of the time. Robert's own words when asked which half was
confusing: "it's a separate screen at all". So the arithmetic stayed (`shared/fleet.ts`,
unchanged apart from being typed over a shape rather than over `Session`) and only the
surface moved. The dialog, its 61 CSS rules and its blurb are deleted rather than left
behind - a stylesheet keeping rules for a component that no longer exists is debt nothing
reports.

Ctrl+Shift+F did not become dead: it toggles the grouping. The setting lives in
`localStorage` rather than `config.json` because it is a VIEW, and the phone, the PC and
this laptop have no reason to agree about which way one person's sidebar is sorted.

The one interaction the move breaks is dragging. `order` is what a drag writes and `order`
decides nothing while the list is grouped, so a dragged row would follow the pointer and
then snap back to wherever its state puts it - which reads as a list that is broken rather
than as a mode that does not support dragging. Grouped, `onPointerDown` only selects.

**Why the other machine's panes were invisible, and what it cost to fix.** The link has
always mirrored a pane only once it was picked in Devices. That is right for MIRRORING and
was quietly wrong for KNOWING: a laptop whose agents all run on the PC showed an empty
sidebar and a `0` on the Fleet badge while nine agents worked over there.

The fix turned out to be a deletion rather than a protocol change. `RemoteClient.available`
has always held every pane the far end has, as whole `Session` objects, pushed on every
change - and `remote/index.ts` mapped them down to six fields on the way to the renderer,
because its only reader was the Devices pick list, where a name and a folder is all you
need to choose what to watch. So the data crossed the wire the whole time and was thrown
away one function before the screen. `RemotePaneInfo` now carries every field `FleetPane`
reads. No new message, no new round trip, no version bump on the wire.

**Listing is not mirroring.** This is the sentence to keep. A LISTED pane costs a few
fields on `remote:changed`, which is sent whenever anything over there moves anyway. A
MIRRORED pane costs a live byte stream and an xterm buffer on this machine, per pane -
which is exactly the bill a laptop acting as the screen for another machine's work cannot
pay at scale, and the one thing left unmeasured by the handoff work before it (100+
mirrored panes on this laptop). So the list is free, the stream is bought one press at a
time, and the pane's own agent is not in the trade at all: it runs on the PC either way,
at the speed it always ran.

Four refusals, each of which fails silently in a way that reads as a different bug:

- **A mirrored pane is not listed twice.** For a beat while a mirror attaches, the pane is
  both a `Session` here and a `watched` entry over there. Drawn twice - once live, once as
  an invitation to open it - it reads as a duplicate rather than as a race.
- **An offline device lists nothing.** `peer.panes` after a disconnect is the list from
  before it went. Nine rows saying `working` about a machine that is asleep is worse than
  no rows at all, because it is a confident answer to the question this screen exists for.
- **A listed row has no pane number.** There is nothing on this machine for Ctrl+N to
  reach. And a REAL row's number still comes off the full ordered list rather than off this
  screen's order: the device filter is visual, and a number that moved with the filter
  would move the Ctrl key under somebody's finger.
- **A question over there is ranked but not answerable.** The buttons need the frame the
  chooser was read off (`shared/choices.ts`), which needs a mirror. But it is the loudest
  reason to open a pane, so `asking` ranks the row exactly as a local question does and the
  press is what gets you the buttons.

Two things had to widen with it. `fleetWaiting` now counts the whole list - the badge read
zero all day on a desk whose work was all remote, which is the number being wrong in the
one situation it exists for. And the device filter offers a machine that is merely
CONNECTED: built from mirrored sessions alone, its dropdown could not name the one machine
somebody opens the list to look at.

**Measured in a real window** over the shipped stylesheet, because a dimmed row is a
contrast question and a screenshot cannot answer one. At the 0.68 opacity this was first
drawn at, `.row-agent` (11px, and the line carrying WHICH MACHINE the pane is on)
composited to **3.71:1** against the sidebar - a fail. The sweep: 0.74 → 4.20, 0.78 → 4.56,
0.82 → 4.93, 1.0 → 6.91. Shipped at **0.82**, which passes AA with room and still reads as
plainly dimmer than a live row. The name measures 11.33:1 and the hover word 5.73:1.

**`shared/desk.ts` is the arithmetic**, out of the component for the same reason `fleet.ts`
and `place.ts` are. `npm run test:desk` is 43 checks whose weight is in the negatives above,
and whose last block is a SOURCE assertion rather than a behaviour one: a field added to
`FleetPane` and not forwarded through the peer map typechecks (every added field is
optional), renders, and sorts every remote pane wrong for ever. Red-proofed by deleting
`stalledSince` from the map - the test names the field and the consequence.

**Not built:** the panes on that machine that PaneForge did not open. A `claude -p` started
by Task Scheduler is not a pane and nothing here can see it; that is a process-table read on
the far end (`shared/devList.ts` is the shape, and it only ever runs locally), and it is the
next thing worth doing for a machine meant to run automated work.


## A session that clears itself asks first

2026-08-23. The instant version shipped the same morning and Robert saw it as a session that
vanished: "it shouldnt be auto clearing instantly or at least put popup for a countdown when
its about to auto clear just so i can stop it if needed". The same day, a test for the tool
that typed it had itself typed `/clear` plus the literal string `--not-a-flag` into his live
pane - so the feature's whole failure mode was already on the record before this was built.

Three decisions worth keeping:

- **The countdown lives in the app, not in the hook.** Its refusals - the pane started
  another turn, somebody typed into it, the pane went away - can only be seen from inside
  PaneForge, and the card is the thing being added. The hook only asks.
- **A refusal is re-read every tick**, never trusted from when the ask arrived. Same rule as
  `handoffQueue`, and it is what makes "he asked it something during the countdown" safe.
- **An older build refuses rather than falling back.** The fallback would be the exact
  behaviour this replaced, and it would fire on the machine that had not been updated - i.e.
  silently, where nobody was looking.

Verified in the dev copy over CDP, not by reading the diff: the card renders with its steps
(`Clearing clearprobe in 25s`, both buttons, contrast 14.1 title / 5.78 hint and steps at
12px on `rgb(37,29,23)`), the countdown really counts (25s -> 23s), **Keep this session**
leaves the pane's buffer with no `/clear` in it, and a 5s countdown left alone put `/clear`
and then the resume prompt into a real bash pane.

## The screen stays on while a pane works

2026-08-23, Robert: "dont sleep if sessions running in paneforge because right now its
sleep/screen off to quickly". Measured on the Mac first: `pmset -g custom` had
`displaysleep 1` on battery and 10 on AC, and the screensaver was at 300s - so the machine
was behaving exactly as configured, and an agent turn longer than a minute always ran behind
a black screen. The OS side was fixed too (battery `displaysleep 10`, screensaver 900s).

The app half exists because settings are global and this is not: the screen should stay on
while THIS app has work running, not always. `powerSaveBlocker('prevent-display-sleep')`
also prevents system sleep, which is what a long turn needs.

The cap is on the busy STRETCH rather than the hold, and that is the part a naive
implementation gets wrong: `runSince` survives an agent that wedged, so "hold while busy"
with no cap means a laptop lit until somebody notices. `nextBusySince` only moves on the
0 -> n edge, so a capped stretch cannot re-arm itself by ticking; a real quiet moment does
re-arm it. Verified live against `pmset -g assertions`: nothing before,
`NoDisplaySleepAssertion named: "Electron"` while a pane was busy, nothing after.


## Two autoclears, and why master's is the one that shipped

2026-08-23, resolving lane-a's merge with master. Both sides built the countdown in front
of an automatic `/clear` on the same day - master as `cf163df`, lane-a as its own
`ClearCountdown` in `src/main/autoclear.ts` - so the merge produced two complete
implementations wired into one app. Git marked five files conflicted and left the worse
damage in files it merged cleanly:

- `src/main/index.ts` registered `ipcMain.handle('autoclear:ask')` TWICE. Electron throws
  on a second handler for one channel, so the merged app would not have started. Nothing
  flagged this; typecheck passes on it.
- `App.tsx` imported `AutoClearToast` twice and rendered it twice, once with `panes`/
  `onKeep` and once with no props.
- `src/shared/surface.ts` and `scripts/surface-reach-test.mjs` each declared
  `askAutoClear` twice in one object literal. Only the first of those is a type error.

Master's implementation won because the already-merged consumers use it end to end:
`sessions.ts` owns `armAutoClear`/`cancelAutoClear` and sets `Session.autoClearAt`,
`index.ts` re-reads the payload through `readAsk` because the phone server reaches that
channel, and the card renders from the pane list with no subscription of its own. Lane-a's
path went with it: `src/main/autoclear.ts`, the `autoclear:answer` / `:pending` /
`:changed` channels, their `Surface` and `PaneApi` members, and the lane-a half of
`src/shared/autoclear.ts`.

The guard that caught the leftovers was `npm run test:surfacereach`, which failed with
three UNREACHABLE channels - the exact signature of a half-removed feature. Its rule (every
Surface method needs either a control in the window or a named non-window caller in
DESK_SIDE) is the reason a dead IPC channel cannot sit quietly in this repo.

The lesson for the next merge like this: when two lanes answer the same ask, resolving the
conflicted files is the small half. Grep the whole merged tree for duplicate registrations
- `ipcMain.handle`, object-literal keys, component renders - because a clean auto-merge of
two additions is exactly how you get two of something that must be one.

**Two things `verify-build` caught in the migration, both about a switch nobody could keep
off.** `merged.holdWhileWatching = DEFAULT` ran unconditionally on the argument that "no
config in existence carries an answer to a switch that did not exist" - true on the day it
shipped and false the moment somebody turns it off. `setConfig` merges a patch at the TOP
level, so anything sending `{ autoAnswer: { holdWhileWatching: false } }` replaces the whole
object and takes `defaultsV3` with it; the early return then stops firing and the next
launch turns the switch back on, for ever. Keyed on the FIELD being absent
(`raw?.holdWhileWatching === undefined`) it survives losing its own marker, which is the
general shape: a migration guarded only by its marker is guarded by nothing once a partial
write can drop the marker. Red-proofed by putting the unconditional line back.

And `waitMs === 5000` genuinely cannot be told apart - it was V2's own default AND it is an
option in the Settings menu, and after `defaultsV2` nothing in the file records which it
was. It is moved anyway and the comment now says so rather than claiming "a wait somebody
picked is theirs": the alternative is that the desk this was asked for never gets 30s.

The held row is the one branch no window test reaches (`test:askrender` turns the hold off,
or it would pass or fail on whether the probe's window happened to be focused), so its shape
is pinned by source assertions in `test:autoanswer` instead - early return, no seconds, no
tick subscription, and the option still named.

## Checks — what each suite pins

Moved out of `CLAUDE.md` on 2026-08-30: it was 136 lines of a file measured at
~44,000 est tokens, re-read on every request of every turn in this repo, and it
is reference rather than a rule. The rule (run `npm run typecheck` and `npm test`
before committing; a new cheap test goes in `scripts/test-all.mjs` or it never
runs) stays there.

| Command | Covers |
|---|---|
| `npm run smoke` | the pty layer |
| `npm run test:restore` | which conversation a reopened pane goes back into |
| `npm run test:scrollback` | and what is on its screen when it gets there |
| `npm run test:replaywidth` | ...drawn at the width it was drawn at, with the shipped behaviour kept as the control that must FAIL |
| `npm run test:panegrid` | that the pty and the terminal open on the SAME width (the old 80-column default is the control that must still tear), and that Fix re-renders from raw bytes |
| `npm run test:claim` | which conversation a pane may claim when three lanes share one project folder: somebody else's launch refused, the pane's own taken, and the pane following its own `/clear` kept as the control |
| `npm run test:restoreturn` | the display clock, the engaged flag, continuing a cut-off turn, plus source assertions so a green test over a function nothing calls cannot pass |
| `npm run test:promptecho` | rebuilding prompt tags from the `❯` echo, and the four things that must NOT become tags |
| `npm run test:consoles` | sweeping console hosts left behind |
| `npm run test:strays` | what a PANE left running (real orphans, ~25s) |
| `npm run test:gitpoll` | the badge's `git status` cache, over a fake clock |
| `npm run test:install` | quitting takes the install pty's whole process tree |
| `npm run test:lanes` | lane engine, worktree sweep, ownership, the any-repo release contract |
| `npm run test:laneproof` | that a ship names only lanes whose commits are really on origin, and that a lane passed over leaves a note - a `post-receive` hook takes the push and rewinds the branch, with the landing push kept as the control |
| `npm run test:laneargs` | what `runSafe` hands a program, through a real cmd.exe |
| `npm run test:laneforeign` | a foreign clone at a lane's path: named and refused, commits untouched (control: it passes the old `--is-inside-work-tree` test) |
| `npm run test:lanepeers` | the other desk's claim arithmetic and its negatives |
| `npm run test:lanedevice` | the same with real plumbing, and the two locks that looked right and were not |
| `npm run test:gate` | what stops an automatic release, and that the refusal is CACHED on the commit |
| `npm run test:notes` | release-note ranges and both template shapes |
| `npm run test:pickrelease` | the newest release carrying an asset THIS platform can install |
| `npm run test:promote` | a soaked dev build promoting with a younger one on top of it |
| `npm run test:remote` | the device link end to end over a real loopback socket, including the size BORROW and its refusals |
| `npm run test:pairask` | six digits that agree between two ends, and DISAGREE through a real relay |
| `npm run test:handoff` | a pane moved whole over a real link and real git, and the refusals |
| `npm run test:handofffit` | that the hand-off box can still be answered with real machine names in it |
| `npm run test:theme` | palette derivation + contrast (358 assertions) |
| `npm run test:contrast` | that every word DRAWN in the window reaches its ratio, in both themes - the backdrop sampled out of a screenshot rather than walked, so a gradient cannot report as the solid colour three ancestors up |
| `npm run test:autoclear` | the countdown in front of an automatic /clear, every refusal, and that Cancel types NOTHING |
| `npm run test:awake` | holding the display awake, letting go, and the CAP on one busy stretch |
| `npm run test:stashtheme` | that the Stash picks no colour of its own and asks the theme, not the OS |
| `npm run test:sounds` | the alert catalogue: nothing silent, nothing clipping, uploads |
| `npm run test:blurbs` | the "what this is" note on each feature, and that each is rendered |
| `npm run test:place` | the words a pane's strip prints (56 assertions) |
| `npm run test:elapsed` | what a clock prints, and how rarely it may wake the app to print it - with the wall-clock bucket kept as the control that must FAIL |
| `npm run test:surfacereach` | that every method the window exposes has a call site under `src/renderer/src`; four are desk-side on purpose and each names who calls it |
| `npm run test:mirrorfit` | how a mirrored pane draws somebody else's grid, with all three failed walks kept as controls, and growth past the user's font up to `MAX_FILL_FONT` (28) |
| `npm run test:panebackjobs` | what an AGENT pane left running: real trees off this machine as fixtures, every permanent MCP server and `caffeinate` refused, the naive descendant count kept as the control, and a last block over this machine's own live table |
| `npm run test:panebound` | work that may not leave this machine: the permanent MCP prelude kept as the control that must bind NOTHING, a driven browser four processes down, somebody else's browser, and both refusals it feeds |
| `npm run test:quietstate` | that a pane printing at full blast never dispatches a no-op update: the hook compares before React does, and the three states written from `onRender`/`onScroll` use it |
| `npm run test:panejob` | what a shell pane is running, its refusals, and a last block asking a REAL pty |
| `npm run test:desk` | the sessions list with both machines in it, plus a source assertion that every ranked field is forwarded from the peer |
| `npm run test:agentenv` | the environment a pane's agent starts with, and that one provider's key cannot fill another's variable |
| `npm run test:orcatalogue` | the live model list: no tool calling never reaches the menu, a broken answer changes nothing, nothing is capped, both prices, and the stealth warning |
| `npm run test:devicewatch` | noticing a copied cookie, and the negatives that decide whether the mark is read |
| `npm run test:projects` | which folders are projects and which are copies of one |
| `npm run test:cardfit` | that a session card can still be read at 190px |
| `npm run test:closedone` | when a pane automation opened may close itself - a turn, a question, a shell command and a background job each refusing it, and the source assertions that the opener is told BEFORE the kill |
| `npm run test:headerfit` | that a pane's header can still be USED at 198px - the close button on the pane, the ⋯ on the line, a name that is still a name - with the old header kept as the control that must NOT fit |
| `npm run test:confirmfit` | that the yes/no box can still be answered |
| `npm run test:diff` | reading a repo's changes: `-z` records, renames, patch numbering |
| `npm run test:railplace` | where a prompt tag is drawn (no window) |
| `npm run test:grid` | layout arithmetic, no window needed |
| `npm run test:replytext` | what a reply looks like on the clipboard, chrome stripped |
| `npm run test:cursorclick` | the keys a click sends, the clicks refused, and that a BARE click emits no vertical arrow |
| `npm run test:stickyselect` | that a highlight stops moving when the mouse is let go |
| `npm run test:promptbox` | telling a CLI's drawn input box from a zsh prompt, a diff and a markdown table |
| `npm run test:handoffsteps` | what a pane's handoff says is left, its two refusals, and PARITY with the hook that decides the same thing inside the session |
| `npm run test:promptsubmit` | that a pane opened WITH a prompt sends it, and never once working |
| `npm run test:staleframe` | when a pane may ask its CLI to repaint itself: a stranded working line recovered, with a real 20-minute ticking footer kept as the control that must be nudged ZERO times |
| `npm run test:choices` | reading a live question off a frame, two real shapes, the negatives, and that the arrows really are escape bytes |
| `npm run test:askclick` | that a click on a pane holding a question types NOTHING (needs a window) |
| `npm run test:askrender` | the countdown drawn in the pane, on the card, ticking — and what arrowing costs every OTHER pane (needs a window) |
| `npm run test:autoanswer` | which questions may be answered for you, the timing over a fake clock, and source assertions on the state the guards read |
| `npm run test:anim` | what a looping decoration may cost: `transform` and `opacity` only |
| `npm run test:attach` | bytes landing on the machine owning the pty, the extension off magic bytes, an oversized batch writing nothing, and no escape from the folder |
| `npm run test:asknotify` | a question on its way to Telegram, silent with no credentials, never asking for updates |
| `npm run test:faultnotify` | a fault that reaches a phone, and the readings, drills, repeats and test copies that must NOT - plus the real `crash.ts` seam, where the log line is written before the alarm |
| `npm run test:settingsearch` | that a setting is findable by what it DOES (the index is generated from the dialog's source) |
| `npm run test:onestash` | that there is one Stash |
| `npm run test:stashsummon` | that it is not on screen until asked for, and opens at the pointer's own display |
| `npm run test:panesize` | who owns a pane's shape when several screens borrow one pty, and that a borrow whose screen went quiet expires - with a mirror's leaseless borrow, and a desk resize under a LIVE borrow, kept as the controls |
| `npm run test:linkstate` | what a phone says when the desk stops answering, and the ordinary reconnects it must stay quiet through |
| `npm run test:tunnel` | a URL never called up before it resolves, a hanging cloudflared settling anyway, per-platform asset names |
| `npm run test:funnel` | which machine can be funnelled, which refusals mean "quietly use cloudflared", and that stopping SAYS so |
| `npm run test:splitplan` | reading a plan out of whatever a headless CLI printed, and the refusals that keep a bad answer from opening panes |
| `npm run test:gist` | the one line History puts under a closed session |
| `npm run test:qr` | the pairing QR, by DECODING it — every version at every mask |
| `npm run test:stash` | what the Stash may cost, search in main, an edit keeping its row |
| `npm run test:conceal` | what the Stash may not remember: markers only, never a guess at secret SHAPES |
| `npm run test:pipe` | the live tee; ANSI stripping across chunk boundaries |
| `npm run test:copymode` | keyboard copy mode arithmetic |
| `npm run test:silence` | the quiet-turn alert; an idle pane is NOT stalled |
| `npm run test:discord` | Rich Presence against a fake Discord over a real named pipe |
| `npm run test:voice` | dictation: which transcriber, and a spoken clip through it |
| `npm run test:recall` | "you have asked this before", and PARITY with the canonical fingerprint |
| `npm run test:rename` | the folder rename, on a throwaway repo |
| `npm run test:dock` | the macOS Dock icon |
| `npm run test:macupdate` / `test:macdownload` / `test:wedge` | replacing our own bundle, every way a download can end, and that no hung promise needs a person |
| `npm run test:history` | what transcripts may cost |
| `npm run test:scrollclear` | all three byte shapes of an agent's `/clear`, a sequence torn across chunks, and a control per shape |
| `npm run test:markanchor` | that a prompt tag survives the CLI erasing its row |
| `npm run test:quitwords` | telling a Cmd-Q from an outside kill; the load-bearing case is the false positive |
| `npm run test:recover` | finishing a turn the transport cut in half, and the refusals |
| `npm run test:reclaim` | closing idle panes: pressure is the trigger, a pane waiting for a person is never closed, the window is never emptied - and the rung above it, sleeping an unused pane, with all eleven refusals and the quiet pane that IS slept as the control |
| `npm run test:capacity` | how many panes a restore starts ticked, red-proofed against the warn branch |
| `npm run test:renderwatch` | getting a wedged renderer back: both events, the probe Chromium's own monitor cannot replace, and the four refusals that stop a watchdog reloading for ever |
| `npm run test:whatsnew` | what a restart onto a new build may say, and the five launches on which it must say nothing (fresh install, ordinary restart, rollback, unreadable notes, no network) |
| `npm run test:trimloss` | that lowering xterm's `scrollback` DELETES lines and raising it back restores none, which is why a trimmed pane is re-rendered from main's log |
| `npm run test:mascot` | what the mascot may do to somebody's panes, its four silences, and that every pose it defines is drawn |
| `npm run test:autohandoff` | moving a finished pane instead of closing it, and what the BUDGET rung may move at all (red-proofed) |
| `npm run test:devlist` | what is serving now and which one a sentence names |
| `npm run test:backjobs` | what a machine runs with no pane on it, plus a last block reading THIS machine's real process table |
| `npm run test:devservers` | turning a running server back into the package.json script that starts it, and the drops |
| `npm run test:macsign` | the signing that stops TCC resetting permissions every release |
| `npm run test:winshortcut` | whether a launch puts the Desktop shortcut back, and the three refusals |
| `npm run test:winfeed` | which release the Windows dev channel may pin its feed at |

## A full machine gets its panes back — the evidence

Moved verbatim out of `CLAUDE.md` on 2026-08-31; the rules stay there, this is the
measurement and the incident behind each one.

## A full machine gets its panes back

`capacity.ts` gives back scrollback, ~5% of the bill (twelve panes: ~74 MB of ~1.5 GB), because
the cost is the agent CLI inside the pane (~190 MB each, against 16-17 MB for Codex).
`shared/reclaim.ts` returns the agent, by closing the pane. `npm run test:reclaim`.

- **A trim is a DELETE, so the two things that made it fire repeatedly had to stop.** Lowering
  xterm's `scrollback` discards lines and raising it back restores none, so the recovery is a
  re-render from main's raw log (`paneRedraw` -> `redrawHistory`): `t.reset()`, a resize, and up
  to `REDRAW_BYTES` 4 MB of the pane's own LOG written back through xterm - **45-147 ms of parse alone** in a
  headless terminal, on the UI thread, before anything is drawn. It was fired by both of the
  readings that move: **a PANE SWITCH** (the focused pane is never trimmed, so arriving regrew it
  and leaving trimmed it again - and this desk sits at `over` for hours, load 2.70 per core
  against `LAG_HARD` 1.8, measured 2026-08-28), and **a verdict that flaps** (the level is
  re-read every 15s, `lagLevel` has bare thresholds, and a VISIBLE pane's target differs between
  `over` and `tight`). So `trimPlan` takes a clock: `TRIM_GRACE_MS` (5 min) keeps the lines of a
  pane the keyboard has only just left, and `TRIM_SETTLE_MS` (60s, longer than the 15s poll)
  makes a trim wait for its verdict to HOLD. **Growth is never delayed** - it is what hands a
  reader their history back, and a pane already at full depth is never listed twice. Both are
  optional: a caller with no clock gets the plan this always made, which is the control in
  `test:capacity`.
- **What makes that defensible here**: `kill()` calls `recordEnd`, so a closed pane keeps its
  History row, its `resumeId` and its `scrollbackId`. A closed pane in this app is a minimised
  pane in any other.
- **Pressure is the trigger, never a clock.** Idle time only breaks ties once the kernel is
  already objecting.
- **A pane waiting for a person is never closed.** `needsYou` is quiet BECAUSE it is owed an
  answer. Nor is the focused pane, one on screen, one working or starting or stalled, or a mirror.
- **The window is never emptied.**
- **The reading of the machine is a card that ARRIVES and LEAVES, never a strip.** The
  sidebar's `.capacity` line was on screen for as long as the reading held, which is most
  of a working day on a full desk, and a line that is always there is a line nobody reads.
  `.cap-pop` is armed by the verdict CHANGING into something worth saying (`level|why`,
  cleared when the desk goes back to ok) and takes itself away after `CAPACITY_NOTE_MS`
  (12s), carrying the exact figures with it. **Only `over` arms it** - the kernel itself
  objecting - never `tight`, which is the budget line the ladder already acts on with its
  own countdown; and never more than one card per `CAPACITY_QUIET_MS` (10 min), because
  this desk sits at `over` for hours with the lag reading crossing its band every few
  minutes, so the same fact popped a card again and again. The desk TOTAL beside the pane count went with
  it: it is drawn only while `capacity.level !== 'ok'`, because it is a pressure reading.
- **A press on a pane takes its countdown with it.** `touchPane` drops `closeSoon` when the
  countdown names that pane (and gives `handoffSweeping` back for a move). The "went back to
  work" effect keys on `stillCloseable`, which a click does not change - so before this,
  clicking the pane restarted its idle clock and published a new deadline on its card while
  the 15s count ran on underneath. Other panes in the same plan are re-decided by the next
  sweep: nobody arrived at those.
- **A HOLD is not a countdown, and the chip must not wear the same word.** The publish takes
  the later of the idle deadline and `keptUntil`, so a pane somebody had just pressed
  `Keep it open` on drew `closes 55m` under a sentence saying it had been quiet and was
  being closed - the opposite of what that press promised. `Session.closeKept` says which of
  the two numbers it is (set beside `closingAt` in `setClosingAt`, forwarded through
  `RemotePaneInfo` and `desk.ts` so a listed row agrees), and the card says `kept 10m` with
  the hold's own sentence and no red last-minute alert - nothing is about to happen to it.
  A countdown card naming the pane still wins: that is a live plan to close it.
- **A deadline in the past is a STATE, not a number.** `idleCloseAt` clamps an overdue pane
  to `now` so its chip cannot count up from zero, and the renderer publishes that number
  onto the session with `api.setClosing` from an effect that has `sessions` in its
  dependency array - so `now` moved, the number moved, `setClosingAt` emitted a session
  list because it had moved, and that list re-ran the publisher. Measured in a real window
  with three overdue panes: **3138 `setClosing` writes and 2061 whole-window React renders
  in five seconds**, each write a broadcast to this window and every paired phone, against
  **0 and 0** with `sameDeadline` (`shared/reclaim.ts`) comparing them - two deadlines both
  in the past are the same fact and are not republished. It is also why the chip could sit
  at `0:01`: `at` was being dragged forward to real `now` while `CloseClock`'s own `now` is
  the last one-second tick, so `ceil((at - now) / 1000)` never reached 0.
  `window.__pfClosePublish` counts the writes.
- **A pane can be taken off the clock for good.** `ReclaimPane.pinned` - "Keep this pane
  open" on the card's right-click, `kept open` where its countdown would have been - is
  refused by `onTheClock` AND by `reclaimPlan`'s filter: somebody who said keep this one did
  not mean unless memory is tight. `keptUntil` stays the answer for "not now" (an hour).
- **Looking at a pane is USING it, at BOTH ends of the visit.** `quietSince` is the latest of a keystroke, a printed byte and
  the moment the KEYBOARD LEFT (`ReclaimPane.lastFocus`, threaded in from the renderer, which is
  the only side that knows which pane is focused) - stamped when focus LEAVES and when it
  ARRIVES, plus `touchPane` on the press itself, or a pane picked up while its chip said
  `closes 1:12` kept that deadline for the whole visit and went straight back to it. Without it a pane read for ten minutes was
  already past a five-minute deadline the instant it was switched away from, and its card's first
  word about it was a red `closes 0:01` — a countdown nobody can act on. One reading, so the sweep
  and the card cannot disagree.
- **The clock counts time a person could have acted in, not wall time.** `shared/away.ts`
  freezes it at the moment the machine's last input happened while
  `powerMonitor.getSystemIdleTime()` says nobody is here (`AWAY_AFTER_MS`, 60s), and it
  carries on from there when they come back — ten minutes away costs a pane nothing.
  `main/away.ts` polls every 15s and pushes `system:away` on a CHANGE. The second desk is
  refused by `sawPerson`, not by a setting: a machine no person has ever touched has nobody
  to be away, so it behaves exactly as before. **Only the clock pauses** — `reclaimPlan`,
  which fires on real pressure, is untouched, so a laptop left open all night is still
  protected by the reading that was always the honest trigger.
- **A turn nobody has READ has no countdown in front of it.** `unread` - the pane printed
  something after the keyboard last left it - refuses `onTheClock`, so the clock starts only
  once the pane has been looked at since its last output (a pane being read now is `focused`
  and already exempt). It holds the CLOCK only: `reclaimPlan` fires on real memory pressure,
  where holding an unread pane open is the more expensive mistake. And it is gated on
  `Away.sawPerson` - on a desk no person has touched this run nothing is ever read, so the
  refusal would switch the feature off on the one machine it exists for.
- **The rung above closing is SLEEPING, and it is ON.** `idleSleepPlan`
  (`reclaim.idleSleepMinutes`, 30 min) stops the agent in a pane nobody has used and keeps
  the card, its place, its screen and its conversation - `shared/sleep.ts`'s machinery,
  fired by a clock instead of by a menu row, which is why "Sleep this pane" is gone from
  the card's right-click. It shares `onTheClock` with the close clock verbatim, and drops
  the two things that are about closing: it keeps no pane back (it empties no window) and
  it is not capped by `maxPerSweep` (nothing here depends on re-reading the machine). No
  countdown either - nothing a person would miss is lost, and the card says `asleep 3m`
  where its clock was. On by default because being wrong costs one press and the CLI's own
  1.4s boot.
- **There IS a clock, and it is off.** `reclaim.idleCloseMinutes` closes a pane nobody has typed
  into for that long whatever the memory says; 0 is the default. The switch sets
  `IDLE_CLOSE_MINUTES` = **5 minutes**. It exists for the second machine — a desk driven over the
  link, which fills with finished panes and has no person to close them. Every refusal above is
  shared verbatim except **visible**, which it cannot keep: on a machine nobody is at, every pane
  in the grid is "on screen". `idleClosePlan`, its own minute timer in `App.tsx`.

**And a restore is the one moment N agents start in a single tick.** `restorePlan` in
`shared/capacity.ts` decides how many start ticked: everything at normal pressure, **two** at
warn, **one** at critical, and never zero while there is a pane to offer. That is safe only
because nothing is lost — an unticked pane keeps its conversation and its screen. It is a
**preselect, never a cap**. The reading comes from `readPressure()` at the moment the offer is
built, not from `lastPressure`, which on a cold launch may not have sampled. The silent paths (an
update restart, `restoreAfterRestart: 'always'`) are deliberately untouched.
`npm run test:capacity`, red-proofed against the warn branch.

## Never close the app you are running inside (full rules, moved out of CLAUDE.md 2026-08-31)

The installed `PaneForge` is the live app; killing it ends this session mid-turn. To see a
change, open a **second** copy:

```
npm run try                     # builds, opens as its own profile, minimized, no focus
npm run try -- --show           # same, but on screen (still no focus)
npm run try -- --close          # shut that copy down
```

Profiles (`src/main/profile.ts`) give the copy its own userData, single-instance lock, config
and taskbar button. Never `npm run setup`, never `Stop-Process PaneForge`, never run the NSIS
installer — each kills every PaneForge including this session.

## Lanes: more than one chat works on this repo (full rules, moved out of CLAUDE.md 2026-08-31)

A hook assigns each session a lane — `main` (this folder, master) or a worktree
`PaneForge-a`/`-b`/`-c` on `lane-a`/`-b`/`-c`. **Work only in the lane you were given**; a
PreToolUse hook refuses writes into another chat's checkout. `node scripts/lane.mjs status
--repo <dir>` says who holds what.

- A visiting chat gets a letter lane, never `main`, unless `main` holds uncommitted work.
- One engine drives every repo: `lane.mjs --repo <dir>`. Per-repo `.lanes.json`, all fields
  optional: `{ "lanes": false, "branch": "main", "release": "merge", "pool": ["main","a"] }`.
- A repo with no remote, and `claude-memory`, never get lanes. Never leave a lane in a
  conflicted merge — the one state no other chat may touch.
- **A lane is reported shipped only once PROVED out.** `landedOnOrigin` checks the lane's
  commit is an ancestor of the branch on origin; a lane that fails is left out of
  `lastShip.lanes`, KEEPS its ready mark, and is named. `null` (no origin/network) is "nobody
  could check" and changes nothing — none of this may block a chat.
- **A lane passed over leaves a note** (`state.passed[id]`, printed by `doctor`): a silent drop
  and a successful merge look identical from outside.
- **A lane holding nothing is kept until quiet for a day** — `SWEEP_GRACE_MS` in
  `main/laneWork.ts` (24h, `PF_SWEEP_GRACE_MS` for tests, read at call time).
- The lane chip opens "what is all this", not just "merge?" — `LaneDialog` +
  `renderer/src/laneWords.ts`, built from BOTH the ledger and this window's panes.
- `npm run test:lanes` covers the engine, the sweep, ownership, and the any-repo contract (a
  repo that never asked for releases must never cut a version).

## Two desks, one repository (full rules, moved out of CLAUDE.md 2026-08-31)

The ledger is one machine's (`<repo>/.git/paneforge-lanes.json`, never pushed). Letter lanes
are local scratch and cannot collide; the trunk can, and so can a release cut twice.

- **A claim is carried by the ref NAME**, `refs/paneforge/claims/<device>/<slot>/<session>/<millis>`.
  Reading every device is one `ls-remote` (0.09-0.11s).
- **Only the trunk asks, and only a chat that does not already have it.** `PEER_STALE_MS` 45 min.
- **The heartbeat is a turn ending**, not a timer, and only past `REFRESH_MS` (10 min). A chat
  ending gives the trunk back at once.
- **The release lock is decided by the SERVER** — `refs/paneforge/lock/release` is a plain,
  non-forced push of an orphan commit, so the other desk's push is a non-fast-forward git
  refuses itself. Read-then-decide and `--force-with-lease` were both wrong and are kept as
  test cases. A lock with no timestamped claim beside it is cleared.
- **Nothing here may ever block a chat.** `peerRefs()` returns `null`, not `[]`, so `doctor` can
  say the check could not run.
- `PF_DEVICE` overrides the hostname. `npm run test:lanepeers`, `npm run test:lanedevice`.

## Releasing happens when Robert asks, and not before (full rules, moved out of CLAUDE.md 2026-08-31)

**`.lanes.json` says `"release": "merge"`, deliberately.** Finishing work merges into master and
pushes; it does NOT cut a version, publish a build, or move anybody's installed copy. The end of
a piece of work is: build it, prove it in a second copy he can open
(`npm run try -- --keep --remote-debugging-port=9333`, then `npm run probe`), report the numbers,
and stop. `npm run typecheck` and `npm test` still gate a commit.

```
node scripts/lane.mjs ready --repo <dir> --session <id>   # this lane is done and verified
npm run ship                                              # ONLY when Robert asks for a build
```

`ready` merges master into your lane first, refuses to mark while that merge is dirty, then
merges once no chat is mid-work. Edit or commit after marking and the mark is dropped, by name.

What a release does WHEN ASKED FOR (`"release": "version"` restores the automatic path):

- **Below 1.0 an automatic release only moves the patch.** `feat:` is a patch, `feat!:` a minor,
  anything larger is typed (`lane.mjs ship minor|major`).
- **Releases batch: one per 2 hours** (`COOLDOWN_MS`). `npm version`, `git tag vX` and pushing a
  version tag by hand are **blocked**; `npm run ship` is the one path that skips the gate.
- **Three things stop an automatic release, all reported by name**: master not typechecking,
  master failing its own `npm test` (`suiteFailure` — a typecheck never proves the app works), and
  a lane conflicting with master (left out; the rest still goes). The suite answer is cached on
  the COMMIT, and **a red answer is asked TWICE before it is written down**. A suite that could
  not START is named as tooling and is not cached. `npm run test:gate`.
- Release notes come from Conventional Commit subjects between tags (`scripts/release-notes.mjs`).
  **Only `feat:`, `fix:` and `perf:` reach the page**; `unpublished` names a `src/` commit with no
  prefix and `doctor` prints it. `npm run test:notes`.
- **Actions and this machine can both publish.** Duplicate installers are harmless; `latest.yml`
  is not — `reconcileFeed` puts ours back. Never hand-fix a feed without checking the asset's real
  size. `runSafe` quotes its arguments (`npm run test:laneargs`).
- **Every automatic release is a DEV release**, a GitHub prerelease. The newest dev build that has
  been on the channel `PF_PROMOTE_SOAK_MS` (3 days) auto-promotes — **that build's own age, not a
  quiet period**. Both paths refuse a one-legged release and a size-mismatched feed, then verify
  `/releases/latest` moved. Tags stay plain; the prerelease FLAG is the channel.
  `lane.mjs promote [version]`, `lane.mjs doctor`, `npm run test:promote`.

**A release claims the thing is finished.** Never cut one while any next step for that issue is
open — and **promotion claims it is proved**.

## An update may never need a person (full rules, moved out of CLAUDE.md 2026-08-31)

Install once, update from the app, for ever. **A user reinstalling by hand is a defect**, and one
shape causes it: a promise that never settles behind a flag saying "already working on it".

- **A release this platform cannot install is skipped, not retried** (`shared/pickRelease.ts`); a
  list where nothing is installable reports "no update", never an error. `npm run test:pickrelease`.
- **A restart nobody asked for waits for the DESK, not for the turn.** `deskBusy`
  (`shared/updateHold.ts`) holds an ENGAGED pane until quiet `DESK_QUIET_MS` (10 min); an engaged
  pane with no timestamps counts as warm. The CLICKED restart is unchanged. `npm run test:updatehold`.
- **The recovery may not live inside the thing that can hang.** A transient phase carries `phaseAt`
  and `busy()` drops one past its budget: `CHECK_BUDGET_MS` 2min, `DOWNLOAD_BUDGET_MS` 45min,
  `PROBE_BUDGET_MS` 5min, env-overridable. The poll is armed BEFORE the await as well as after
  (`POLL_WATCHDOG_MS` 6min).
- **On the way out, the disk beats the badge** — the quit swap is gated on `stagedInstallable()`,
  never `phase === 'ready'`.
- `update-health.json` holds the last good feed answer and every recovered wedge; three days
  without a good check logs `health STALE`. `npm run test:updater`, `npm run test:wedge`.

## ...and a pane that says it is working, on a frame nobody repainted (full rules, moved out of CLAUDE.md 2026-08-31)

The busy read comes off the bottom of the pane's own screen (`shared/busy.ts`), which is right
until a CLI torn mid-paint strands its working line on a row nothing overwrites.
`shared/staleFrame.ts`; `npm run test:staleframe`.

- **The pane's own SILENCE is not the tell** — `busyUntil` is renewed and `checkBusy` runs on a 4s
  tick, so a stale pane re-states `true` for ever without printing a byte. What separates stuck
  from slow is the evidence not CHANGING.
- **The signature is the EVIDENCE, never the read window** (`busyEvidence` + `staleSignature`);
  signing the whole window would be reset by other traffic in those rows. For the weakest rule,
  `counter`, the signature IS the number.
- **The recovery is the one Fix already runs**: `sessions.redraw`, a SIGWINCH nudge with no
  keystrokes in it.
- **The refusals are the feature** — the expensive mistake is a needless poke. `STALE_AFTER_MS`
  four minutes of a byte-identical line, `MAX_NUDGES` **2 per stretch**, `NUDGE_EVERY_MS` a minute,
  a mirror judges nothing, `autoFixUi` off means no. The load-bearing test is the CONTROL: a real
  20-minute turn with a ticking counter, nudged **zero** times. `window.__paneBusy[id].stale`.

## A window that stops answering comes back on its own (full rules, moved out of CLAUDE.md 2026-08-31)

`shared/renderWatch.ts` (arithmetic) + `main/renderWatch.ts` (plumbing). The main process, every
pty and the desk survive a wedged renderer, so the app stays healthy behind a window nobody can use.

- **`reload()` cannot preempt a spinning renderer** — it is a message to the busy thread. The
  process is killed first (`forcefullyCrashRenderer`) and the reload runs from `render-process-gone`:
  24.3s end to end, against `PROBE_DEAD_MS` 20s plus one 5s tick.
- **Chromium's `unresponsive` is an INPUT hang monitor**, so a renderer nobody is typing into can
  spin for a quarter of an hour without it firing. The second reading is `executeJavaScript('1')`
  every `PROBE_EVERY_MS` (5s), queued on the renderer's own task queue. `GRACE_MS` 10s.
- **The refusals are the feature**: `RELOAD_COOLDOWN_MS` 60s (a window is unresponsive BY
  CONSTRUCTION while it reloads) and `MAX_RELOADS` 3, past which it is LEFT as shipped.
- **A dead renderer is rebuilt, not reloaded**, and `app.on('activate')` asks `alive()` rather than
  `getAllWindows().length` — a window whose renderer died is still in that list.
- **Nothing is lost and nothing is taken**: panes come back from desk.json and `--resume`. No focus,
  no show, no always-on-top.
- **The evidence is `paneforge-errors.log`**, including the renderer's CUMULATIVE cpu out of `ps` —
  `getAppMetrics().cpu.percentCPUUsage` is a delta and reads `0.0%` for a renderer that burned 14 min.
- `npm run test:renderwatch`; `PF_PORT=9334 npm run test:renderwatchlive`.

## A fault the app survived is a fault nobody hears about (full rules, moved out of CLAUDE.md 2026-08-31)

`crash.ts` swallows faults so Electron cannot open a modal mid-sentence and `renderWatch.ts`
recovers silently, so the whole record is a log line. `shared/faultNotify.ts` decides,
`main/faultNotify.ts` is the one POST, on `askNotify.ts`'s channel. `npm run test:faultnotify`.

- **Every rule is a REFUSAL** — the expensive failure is a phone buzzing forty times. A **test copy
  pages nobody** (`profileName()`, which is why `startFaultNotify()` runs after `initProfile()`);
  the crash-guard **drill** is not a fault; an unregistered kind is not sent; `MAX_PER_RUN` (5) is
  the whole run's budget, with the last message saying it is the last.
- **Only an ACT is news, never the reading that led to it** — of the eight or nine lines around one
  recovery, only `reload`, `recreate` and `still wedged` leave the machine.
- **The signature blanks the digits**, or two reports of ONE wedge never match and `QUIET_MS`
  (30 min) never fires. That is the control in the test.
- **It is a LISTENER on `crash.ts`, not a call inside it** — that module loads before the profile,
  config and window, so it may not import any of them. `write()` appends the log line first and
  unconditionally, then tells listeners inside a `try`. Source assertion in the test.
- Silent with no `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, and never awaited.

## A restart onto a new build says what changed (full rules, moved out of CLAUDE.md 2026-08-31)

One card, bottom-right, z-index 59 — a step below the update prompt, because a newer downloaded
build outranks a summary of the one before. `shared/whatsNew.ts`, `main/whatsNew.ts`,
`WhatsNewCard.tsx`. `npm run test:whatsnew`.

- **The bullets are the release's own notes** from `scripts/release-notes.mjs`, machine half of each
  subject stripped, capped at 6 sentences of 120 characters.
- **The refusals are the feature**: a FRESH INSTALL, an ordinary restart, a ROLLBACK and a body with
  no readable bullets all say nothing.
- **No network says nothing AND does not remember the version**; the two silent paths that DO
  remember have nothing to come back for.
- Not a dialog, no focus, no animation.

## Never take the screen (full rules, moved out of CLAUDE.md 2026-08-31)

The app runs all day beside real work. Nothing it does on its own may take focus, raise a window, or
pop a dialog. Only a click or a hotkey earns the foreground.

- `showInactive()` for a window nobody asked for; `focusWindow()` is user-initiated only.
- `revealPlan()` in `src/main/profile.ts` decides the launch reveal per platform. A self-decided
  restart calls `markQuietRelaunch()` first; the new process consumes that marker, starts inactive
  and flashes the taskbar button.
- No `dialog.showMessageBox` for anything the app decided itself — in-renderer cards
  (`UpdateToast.tsx`). No `setAlwaysOnTop`, no `moveTop`, no `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true`. (On this PC that flag is ignored for
  detached console spawns — wrap in `run-hidden.vbs`.)
- `second-instance` must not raise the window while `installStarted` is set.
- Game mode may DELAY the window, never lose it (`gameMode.ts`).
- `npm run test:quiet` pins both halves, and SKIPS out loud when a real game is on screen.

## Two machines, one desk (full rules, moved out of CLAUDE.md 2026-08-31)

`src/main/remote/` lets a second device drive this one's panes. Both ends are peers.

- **Nothing is mirrored until it is picked, and a device may not pair with itself.** `Remote.probe`
  refuses an id equal to ours at the handshake; `start()` drops one already saved, because a config
  outlives the bug.
- **The pty never moves.** A mirrored pane's agent, checkout, transcript and worktree stay where it
  was opened. Session ids are the seam: `@<device>/<id>`, and `remote.owns(id)` routes every message.
- **A mirror BORROWS the terminal's size; it never owns it** (`resize(borrowed)` in
  `main/sessions.ts`); `returnSize(id)` gives it back per-pane, never `returnSizes()`.
  `shared/mirrorFit.ts` is the FALLBACK for a host that has not applied the borrow yet.
- **Several screens may borrow ONE pty, and the smallest grid wins** (`shared/paneSize.ts`, per axis).
  **The viewer name must be forwarded, never invented at the boundary** — the api object in
  `main/index.ts` is both the phone's surface and the remote host's backend, so hardcoding `'phone'`
  files every device under the phone's slot; a guest is keyed per CONNECTION (`GuestConn.key`).
  **A borrow is a LEASE, not a flag**: `at` renewed by the 30s `pty:visible` tick, expiring after
  `BORROW_TTL_MS` (90s), because a phone that locks never sends `pty:return`. A link viewer is filed
  `at: 0` and ends with the connection. A desk resize under a borrow sweeps first, or a stuck borrow
  is unrecoverable by construction. `npm run test:panesize`.
- **A close takes the row at once, and a link that could not carry it says so.** `Remote.closeOn`
  hides the row the moment the frame is on a live link and gives it back after `CLOSE_ACK_MS` (3s) —
  a refusal may not wear the shape of a close. `RemoteClient.send` answers whether it went
  (`app:error` rather than silence), and `proveAlive` turns the unanswered press into the liveness
  probe instead of waiting for `DEAD_MS` (45s). A link that HAS spoken since is left alone — the
  control in `test:remote`.
- **A mirror never reports the busy footer**, and **frames are decoded where they are consumed**,
  never where they arrive (handshake and first encrypted frame routinely share a TCP segment).

The pairing code is never sent, only proved; traffic keys derive from it (scrypt, then AES-256-GCM
per direction), so rotating it cuts every paired device off. Hosting is off until switched on;
discovery is a UDP broadcast carrying no secret. `npm run test:remote`.

**Pairing can also be a button**, and then six digits derived from an X25519 exchange binding BOTH
public keys are the authentication — a relaying machine cannot make the numbers agree. The card
leads with the number, not the device name. `PROTOCOL` stays 1: an older build does not recognise
`askpair` and refuses, which is correct. `npm run test:pairask`.

**A paired machine also says what it is running OUTSIDE its panes** — `shared/backJobs.ts` reading,
`main/backJobs.ts` process table, `jobs`/`jobslist` frame, `PeerJobs` in `RemoteDialog.tsx`.

- **Three narrow classes, and the narrowness is the feature**: an agent CLI outside a pane (`agent`),
  a dev server (`dev`), and a script under the projects root older than `LOOP_MIN_SECONDS` (`loop`).
- **Anything under a pane's own tree is left out** — that work already has a card.
- **The age floor belongs to the loop class alone**, or the list is mostly sub-second hooks.
- **The fold is kind-aware**: `npm run dev` and its `next dev` child are one server, but a dev server
  an AGENT started is two different facts.
- **A refusal may never share a shape with an empty answer** — `Remote.jobsOn` rejects when the device
  is not connected, because `[]` means "running nothing". On demand, never on a tick.
  `npm run test:backjobs`.

**A handoff moves the WORK, still never the pty.** `HandoffDialog.tsx` asks one question — which
machine — and says what travels (the repo as an `auto-sync:` commit, the conversation, the screen,
the dev servers) and that a mid-turn pane is **queued, never killed**. `Hand off all` in Devices is
the bulk path (two presses). The sender's pane closes only on the far end's ack and reappears as a
mirror. The receiver never destroys local state: a dirty or unpushed checkout refuses THAT pane by
name. Paths map by grafting the root-relative path onto the receiver's projects root
(`shared/handoff.ts`). `npm run test:handoff`, `npm run test:handofffit`.

## The phone is this window, served (full rules, moved out of CLAUDE.md 2026-08-31)

There is no second app. The renderer imports nothing from Electron or Node — pure UI over
`window.api` — so a phone client is that object over HTTP: `src/main/phone.ts` serves the built
renderer, `renderer/src/browserApi.ts` supplies the object, and **`src/shared/surface.ts` is the ONE
list** (`SURFACE`) both transports are built from, typed so a method with no channel does not
compile. Never add a channel to a transport; add it there.

- `tapIpc()` MUST stay at the top of `index.ts`, above every registration. Events go down one SSE
  stream, and `phone.broadcast` sits **ahead** of the window check in `send()` so a minimized window
  cannot starve a phone. Sends are queued client-side because they are ordered.
- **Off until Devices is opened, and opening it IS the switch.** Unpaired gets the pairing page and
  not one asset; five wrong codes locks that address for a minute. The cookie is
  `hmac(deviceId, code)` — derived, never stored — so rotating the code signs every phone out.
- **Watching and typing are different permissions** (`src/main/passkey.ts`). With `phone.typeGate`
  on, the first keystroke of each 15-minute window costs a passkey touch. The gate is on `/pf/send`
  and `/pf/call` and **never on `pty:write`**; it arms only over TLS; a 423 refuses the WHOLE batch
  before anything runs, re-queued at the front. `DESK_ONLY` refuses `phone:typeGate` and
  `phone:forgetKey` over HTTP.
- **Scanning asks; a press on the desk answers.** `POST /pf/ask` raises a card here with four digits
  on both screens, and Approve mints THAT browser a 32-byte token — nothing on screen can be
  photographed and a device can be signed out by name. One request at a time, five per address per
  ten minutes, two minutes to answer. With asking off the code rides in the URL **fragment**, which
  a browser never sends to a server.
- **Behind a tunnel every client is 127.0.0.1**, so `addressOf` believes `cf-connecting-ip` (then
  `x-forwarded-for`) and does so ONLY from loopback.
- **One row per device, not one per approval.** The panel says who is WATCHING, never who is paired;
  `New code` is the only revoke.
- **The ten-year cookie is watched, never revoked on suspicion** (`shared/deviceWatch.ts`): a changed
  place is recorded and never alarmed on; a changed browser shape and one live stream from two
  origins at once are the marks. A mark is never cleared by an ordinary arrival; `phone:clearMark` is
  `DESK_ONLY`.
- **`SameSite=Lax`, never `Strict`.** `Secure` only when the request really arrived over TLS.
- **A way in from anywhere**: `main/funnel.ts` (Tailscale Funnel — stable hostname, so a phone signs
  in ONCE) first, falling silently through to `main/tunnel.ts` (cloudflared quick tunnel). Never look
  the hostname up before `Registered tunnel connection` — an early query caches NXDOMAIN for 40s.
  `up` is set by a real HTTPS request returning our own bytes. Everything cloudflared says is on
  **stderr**. Turning it on lengthens the code to 14 and signs every phone out.
- **The QR leads with the LAN address**, tailnet after it; `reachWords` never promises "works
  anywhere" for an address marked "this network".
- **A copy made on the phone is the PHONE's clipboard** — `browserApi.ts` answers
  `copyText`/`readClipboard` locally.
- **The output is also served as TEXT** (`TextSheet.tsx`): a finger cannot select a canvas. Read off
  disk (`sessions:log`, up to 8 MB), RENDERED through an off-screen xterm, never stripped.
- **A text field must opt back IN to selection** — `body { user-select: none }` inherits and iOS then
  refuses the caret loupe. Both spellings, every input and textarea. Keys a phone keyboard lacks are
  drawn (`HandheldType`, 44px, as bytes).
- **The desk OWNS a pane's shape; a phone BORROWS it.** A desk resize during a borrow is REMEMBERED
  and applied when the phone lets go. A COLUMN change clears the buffer and asks for a repaint —
  `clear`, never `reset`.
- **A phone cannot read "the desk is asleep" off its own screen** — its rows carry no clock.
  `shared/linkState.ts` + `LinkBanner`: how long since the desk said ANYTHING, and that the rows below
  are a photograph. It never claims the machine is asleep, so "asleep?" keeps its question mark.
  `LINK_QUIET_MS` 20s. Three sources say so — the stream erroring, the stale timer, and a failed
  `/pf/call` (regularly the FIRST proof, since a suspended EventSource never fires an error). Coming
  back to the tab re-reads the desk on the spot. `npm run test:linkstate`.
- **A phone is not a small desktop.** `handheld.ts` + one `@media` block: under 720px, or a coarse
  pointer under 520px tall, list and panes take turns with `display: none`. `100dvh`, never `100vh`.
  Every pane action moves behind one ⋯ into `PaneMenu.tsx` (52px rows, words, destructive last).
  `isPhoneClient()` gates AUTHORITY only, never layout.
- **Automation opens a pane through `scripts/pf-ctl.mjs`**, never `open --args` (one em dash makes
  macOS drop the whole argument list and exit 0). On PATH as `pf`:
  `pf open <cwd> --prompt "..." [--agent A] [--model M]`, then `pf list` to verify.
- **...and that pane can close itself and say so.** `--close-when-done` (with `--report-to`,
  defaulting to `PF_PANE`). WHEN is the whole rule (`shared/closeWhenDone.ts`): printed at least once,
  out of its turn, no question, no shell command, no background job left — that last read comes off a
  4s process table, so the pane must stay finished `CLOSE_DONE_QUIET_MS` (8s) rather than closing on
  the turn's edge. The opener is told through `queuePrompt` and BEFORE the kill, because `kill()`
  deletes the request that names it. `npm run test:closedone`.
- `npm run test:phone` (server + surface parity); `npm run test:phoneview` needs a running copy. A
  pane's text is in `window.__pf[id].term.buffer`, never in the DOM.
- Not built: headless host (B1), phone-first diff (H2).

## One long ask is several panes (full rules, moved out of CLAUDE.md 2026-08-31)

`shared/splitPlan.ts` rules, `main/splitPrompt.ts` reading, `SplitDialog.tsx` screen.
`npm run test:splitplan`.

- **The reading is an agent CLI run ONCE, headlessly, and it is the only agent this app starts outside
  a pane.** `HEADLESS` holds only CLIs measured answering a one-shot prompt; one without is refused,
  never guessed at.
- **It runs in an EMPTY folder under userData**, with `--settings '{"hooks":{},"outputStyle":"default"}'`
  and `--strict-mcp-config`: a headless run loads the settings, hooks and CLAUDE.md of wherever it
  starts, and `--settings` cannot cover a project file.
- **An answer that is not a plan is `null`, never an empty plan** — an empty list shares a shape with
  "this is one job", which is a real answer. The refusal quotes the first 160 characters said.
- **Every `{` is tried when reading the object out of the answer**, not only the first.
- **`MAX_TASKS` is 4 — the lane pool**; everything over it is NAMED in `dropped`.
- **Nothing opens until the rows have been read**: title, folder and whole brief are editable, because
  that brief is the only thing its pane will ever be told.

## A pane can run on somebody else's model (full rules, moved out of CLAUDE.md 2026-08-31)

Most of `shared/agents.ts` is one binary pointed somewhere else: Claude Code reads
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` and nothing else. Separate ids rather than a switch on
`claude` — the two have different histories, costs and failure modes and a pane must say which it is
on its card. `npm run test:agentenv`.

- **A base URL carries NO `/v1`; the CLI appends `/v1/messages` itself.** OpenRouter is
  `https://openrouter.ai/api`. With `/api/v1` the CLI blames the MODEL in a pane whose model is fine.
- **A provider is an entry in `KEY_PROVIDERS` plus an agent whose `env` names `keyVar(id)`** — Settings
  draws its key field off that list.
- **"Anthropic-compatible" is probed, never read.** DeepSeek and Z.ai answer a junk-key POST with a 401
  in Anthropic's own error shape; **xAI does not**, so Grok is its own CLI entry (`~/.grok/bin`,
  hydrated by `which.ts`).
- **A key pasted in Settings reaches the menu somebody is looking at.** `siblingModels` borrows another
  runner's models into this dropdown under the PROVIDER's heading, each row carrying `agent` so the
  press switches runner and model together. Two refusals: only a SAVED key, and only a sibling on the
  same `bin`. `config:set` invalidates the 20s agent cache.
- **A blank key drops the token and KEEPS the base URL** — dropping both runs plain Claude Code in a
  pane whose card says GLM. The Settings card names the missing key (`missingKeyFor`).
- **`HEADLESS` is keyed by agent id.** Grok is deliberately absent — its headless flags are unverified,
  and `drivable()` refusing beats a guess.

**Gemini CLI is not in the catalogue** — Google cut consumer accounts off 2026-06-18 and AI Pro/Ultra
does not entitle it; removed 2026-08-26 as a second, worse way to reach Google's models.
`GEMINI_DEFAULT_AUTH_TYPE` went with it: it is a DEFAULT, and a machine whose `~/.gemini/settings.json`
says `oauth-personal` keeps going to the dead endpoint whatever the environment says.

**Antigravity CLI is where that login WENT** — `agy` (id `antigravity`), a Go binary from Google's own
installer, NOT npm where the name is squatted, landing in `~/.local/bin` or `%LOCALAPPDATA%\agy\bin`,
both hydrated by `which.ts`. Plain Google account signs in; AI Pro/Ultra raises limits rather than
being the price of entry. `--continue` / `--conversation <id>`. **It carries no model list on purpose**:
`agy models` refuses until signed in and Google publishes ids nowhere, so `/model` inside the TUI picks
one. No `uninstall` either — the installer appends a PATH line to five shell profiles.

## ...and the model list is not this build's opinion of what exists (full rules, moved out of CLAUDE.md 2026-08-31)

`main/orModels.ts` keeps OpenRouter's own public list on disk beside the hand-written
`OPENROUTER_MODELS` shortcuts; `shared/orCatalogue.ts` turns it into the menu.
`npm run test:orcatalogue`.

- **It may never be in anybody's way.** `listAgents` is synchronous, reads the catalogue from MEMORY
  and kicks the fetch with `void`. Missing, stale, empty, offline, a 502, an error page: each leaves
  the app as it was. **An empty answer is a FAILED answer** and is never written over a good one.
- **Only models that can call tools.** A row not declaring its parameters is dropped, never guessed at;
  everything left out is one "Other..." away.
- **Nothing is capped, and every row carries BOTH prices** — a cap inside a filter box is invisible.
  Free models lead under their own heading. `Select` searches the VALUE as well as the label, because
  `labelFor` strips the vendor and the vendor is what people type. Newest first, in both groups.
- **A stealth model says so in the hint**: an anonymous provider retains prompts and completions.
- **How a CLI addresses the model is read off its own `env`**, never off a list of ids.

## Every colour is derived, and every pane says which project it is in (full rules, moved out of CLAUDE.md 2026-08-31)

**There is no palette.** `src/shared/theme.ts` computes one from a single accent; `applyTheme` writes
it as CSS variables onto `:root`. Literals in `styles.css` are the ~40ms fallback before config loads.
Adding a colour means adding it to `paletteFor`, never to a component. The maths is Oklab — hue and
chroma held while lightness sweeps, `inGamut` binary-searching the chroma that fits — because
per-channel RGB clamping hue-shifts rather than desaturates. **Light themes live above ~0.9 on the
depth slider**; Paper is 0.98. Default accent `#f0a868`. `npm run test:theme` is 358 assertions whose
load-bearing half is contrast: 4.5:1 body, 3:1 secondary, every preset and hue at full tint.

**A token that passes is not a component that passes.** `npm run test:contrast` proves the RENDERED
window, both themes, desk plus Settings/Devices/History. What makes it a measurement:

- **The backdrop is SAMPLED, never walked** — every glyph made transparent at once
  (`-webkit-text-fill-color`), ONE screenshot is the backdrop. An ancestor walk reports
  white-on-gradient as white-on-white.
- **The rect is the TEXT NODE's own line boxes**, inset, worst pixel minus the worst 5%. An element
  rect is as wide as its row.
- **A rect inside the viewport is not a rect anybody can see** — five points per box are hit-tested.
  The pet is hidden for the sweep for the same reason.
- **A minimized window parks its animations on the first frame**, so animation and transition are
  killed for the sweep.
- **Secondary text is held to 3:1**, decided by the element's computed colour matching `--muted`; a
  LOGOTYPE is exempt.

`readableOn` sweeps each semantic lightness away from ALL FOUR surfaces **and from each surface tinted
16% with the colour itself**, because every one is drawn on a chip washed with its own colour.

**A `var()` naming a token that does not exist never errors** — in a `color` it inherits something
plausible. Resolve colours in a real window, and check every `var(--x)` against the keys `paletteFor`
returns. Only `--agent`, `--level` and `--mono` are legitimately absent.

**The floating Stash is a second window and obeys the same law** — its own `shelf.css`, colours from
`applyTheme`, plus two shapes the palette does not supply: `--acc-rgb` (the accent as a triplet;
`rgba()` of a hex is dropped in silence) and the `light` class on `:root`, off the luminance of the
derived `--bg`, because *light or dark is the depth slider's answer and never the OS's*.
`npm run test:stashtheme` refuses a colour literal in that file outside a `var()` fallback.

**Every pane says which project it is in.** `src/shared/place.ts` is the only thing allowed to turn a
folder, branch, worktree suffix and lane id into words. `npm run test:place` is 56 assertions.

- The project name is never omitted and never abbreviated; everything else is added only when not
  implied. One pane, one repo, trunk → `PaneForge`.
- A trunk branch is answered ("main checkout"), not hidden. A branch a tool generated to hold a copy
  (`pf/w2`, `lane-a`, `worktree-<slug>`) is dropped — it repeats the copy's own number.
- Two numbers, worded apart: `copy 2` is the second checkout, `pane 3` is the third card and Ctrl+3
  reaches it. Only the pane number is a keystroke, and only chats are named by it.
- `-a` is stripped only when the caller already knows the folder is that lane — `service-a` is a real
  project name. Only `-w<digits>` comes off unasked.
- The sidebar has no `git status` of its own, so it may not assert "not a git checkout".

## A pane says which client it is working for (full rules, moved out of CLAUDE.md 2026-08-31)

Every pane in a client tree was called `clients`. The identity is already on disk or
already typed, so the pane writes it down. `shared/clientName.ts` rules, `main/clients.ts`
disk, `ClientToast.tsx` the card. `npm run test:clientname`.

- **A roster is recognised by its SHAPE, never configured** - `clients/<who>/README.md`,
  found by walking UP from the pane's folder. The name is that README's first heading with
  the parenthetical expansion and a trailing `- Firstname X.` contact taken off.
- **The folder is evidence, the prompt is inference, and the refusals are the feature.** A
  slug is only a client when the roster says so (`clients/tools` is not a person); a name
  read out of a prompt must match EXACTLY ONE client, on a word boundary, with `MIN_ALIAS`
  characters. A word is an alias only when it is unique across the whole roster - computed,
  not stop-listed - and is not in the small `GENERIC` set of business furniture.
- **A pane in a client tree doing something else gets the SUBJECT of its first ask**
  (`topicTitle`). A client identified later may replace that guess; nothing replaces a
  client, and nothing at all replaces a title a person typed (`mayRename`).
- **The rename happens and THEN reports** - a card in a corner is not a question anybody
  answers. Three seconds, bottom-right, `Cancel` puts the folder name back AND sets
  `clientOff`, because undoing it says the reading was wrong.

## A pane says how long it has been open (full rules, moved out of CLAUDE.md 2026-08-31)

The header's clock is the TURN and resets when the agent finishes; `.pt-open` is `openedAt ??
createdAt`, beside it, off the header on a phone. History carries the same number frozen at `endedAt`.
`npm run test:elapsed`.

- **A clock is woken no faster than it is READ.** `stepFor` (`shared/elapsed.ts`) is the unit the
  string draws: 1s under an hour, **60s past it**, `Infinity` for a frozen clock. One interval serves
  the whole app.
- **The buckets are measured from the clock's OWN start, never from the wall clock** — a wall-minute
  bucket ticks as rarely and shows the wrong minute for up to 59 seconds of every one. That is the
  CONTROL assertion.
- **The arithmetic lives in `src/shared/elapsed.ts`, not in `Elapsed.tsx`** — a test cannot load JSX
  through node's type stripping. `formatElapsed` carries days.

## The sessions list is the whole desk, both machines (full rules, moved out of CLAUDE.md 2026-08-31)

There is no Fleet screen. The sidebar answers "which pane needs me first": grouped **Your move /
Running / Ready / Ended**, `shared/fleet.ts` deciding, Ctrl+Shift+F back to the dragged order (in
`localStorage`, not config — it is a view). `shared/desk.ts` is the arithmetic; `npm run test:desk`,
whose load-bearing half is the negatives and whose last block is a SOURCE assertion: a field added to
`FleetPane` and not forwarded through the peer map still typechecks and sorts every remote pane wrong.

- **Listing is not mirroring, and that split is the whole design.** Listing costs a few fields on the
  `remote:changed` message already sent; mirroring costs a live byte stream and an xterm buffer here,
  per pane. `openListed` turns one into the other.
- **The order inside a group is the sidebar's own numbering, and nothing else** — breaking the tie on
  time-in-state reads well and swaps eight printing panes under the pointer.
- **A listed row has no pane NUMBER**; a real row's number comes off the FULL ordered list.
- **A mirrored pane is never listed twice.** A device that is off, connecting or in error lists nothing.
- **The badge counts both machines.** The device filter offers a machine that is merely CONNECTED.
- **A group is only worth a heading while its name is TRUE.** `Running` is `runSince` — a turn started
  by the submit keystroke, the agent's busy footer, or a shell pane's live command, ended by `endRun` —
  **or a background job the turn left behind** (`FleetPane.backJob`); never `status === 'working'`,
  which any output at an `engaged` pane set. `Ready` is not `!engaged`, which no pane could get back to:
  `/clear` drops `engaged` (`clearsConversation` in `shared/slashTurn.ts`, partial forms included);
  `/compact` and `/resume` do not.
- **A return pressed at an EMPTY composer asked nothing**, so it neither engages a pane nor starts its
  clock. The reading cannot be `typed === ''`: `slashTurn.isBareReturn` reads the same keystrokes a
  second way (`SUBMIT_OPTIONS`: pastes decoded, arrows and Tab setting `certain` false).
  `npm run test:slash`.
- **A shell pane's turn ends with its COMMAND, with no quiet clock in front of it** — a shell echoes
  every keystroke. POSIX only.
- **Your move is STILL once you have arrived at it.** `doneGlow` runs ONCE (1.9s; `DONE_GLOW_MS` must
  stay in step) and the standing amber marks do not breathe. A red `asking` bar keeps its pulse.

## A prompt tag says how long ago it was asked (full rules, moved out of CLAUDE.md 2026-08-31)

The rail's hover tip is `echo rail  (5 min ago)`; the hover-HOLD under it is the exact moment. Same
`whenWords` as History's rows.

- **The clock is a minute, never a second.** A pane with no tags subscribes to nothing (`Infinity`).
  The offset is the NEWEST tag's own moment.
- **A tag is never measured against a clock older than itself** — `railNow` only moves on a bucket
  turnover, and `whenWords` answers a negative age with the full calendar date. `Math.max(railNow, m.at)`.
- A tag rebuilt from a restored pane's own output has no clock and says nothing about one.

## Finding something in a pane (full rules, moved out of CLAUDE.md 2026-08-31)

Ctrl/Cmd+F, the ⌕ in the pane header, or `Find in this pane` in the phone's ⋯ sheet — all three are
`paneFind`, the map `TerminalPane` registers itself in. Highlights every match, counts them (`3/10`),
steps with ↑ ↓ or Enter / Shift-Enter. It searches the live xterm buffer, so it reaches as far back as
that pane's scrollback and no further.

## Finding a setting (full rules, moved out of CLAUDE.md 2026-08-31)

The search box finds the SETTING, not the page: matching rows tinted, the best scrolled to and edged in
the accent, the rail following it to that tab. Nothing is hidden — a switch read out of the group that
explains it is a switch nobody can judge.

- **The index is GENERATED from the dialog's own source** (`scripts/settings-index.mjs` →
  `src/shared/settingsIndex.ts`, `npm run gen:settings`). `npm run test:settingsearch` regenerates it in
  memory and fails on disagreement.
- **A setting is found by its hint as well as its name**; a LABEL hit still outranks a hint-only one.
- **The marking is done to the DOM**, not by threading a `highlight` prop through nine tab bodies.
- `scrollIntoView` is `nearest`, never `center`. No animation (`test:anim`).

## A card answers a right-click, and can say what it is (full rules, moved out of CLAUDE.md 2026-08-31)

`SessionMenu.tsx` is the desktop context menu — at the pointer, clamped on screen after it is measured,
arrow keys and Escape. Deliberately NOT `PaneMenu.tsx`, the phone's bottom sheet with 52px rows.

`SessionInfo.tsx` is the "see info" the card has no room for. **Its clocks are live** — `Open for`
counts from `createdAt` through `useNow`; the header's clock stays the TURN. Everything else is a
reading the app already holds, so opening it polls nothing.

## Copying a prompt, or the answer it got (full rules, moved out of CLAUDE.md 2026-08-31)

Two copy icons beside every prompt on screen: the prompt, and the reply. Drawn for every VISIBLE turn,
never for the hovered one. Placement is `shared/turnCopy.ts` (`npm run test:turncopy`), fed by the rail's
prompt marks; two prompts closer than one pair is tall, the NEWER keeps the space.

- Icons rather than words; 22px pointer, 30px finger. `TURN_COPY_H` in `TerminalPane.tsx` is the height
  the crowding rule uses — change it with the CSS.
- **A mark keeps two copies of the prompt, and the button copies the one that is not the label.**
  `mark.text` is what the RAIL draws (one line, `.slice(0, 400)`); `mark.full` is what was typed, whole,
  and is what the clipboard gets.
- **Full strength as soon as the pointer is in the pane.**
- **The pair is placed from the frame that has just been DRAWN** — `syncGeom` from `onRender` and
  `onScroll`, never the rail's 250ms-coalesced `syncTotal`. Scroll-to-DOM 303/267/141ms → 4/1/2ms.
- **Keyed on the mark, never on the buffer row** — a marker's line moves when scrollback is trimmed, and
  a changed React key unmounts the pair mid-click.
- The reply is the rows after the prompt up to the row before the next one.
  `npm run test:turncopyview` reads the clipboard back through xterm's own input path.

**Every copy a person asked for says so** — Ctrl/Cmd+C, right-click copy, copy mode's `y` and the
selection chip all report in the toast with the line count as the receipt (`sayCopied`, one counter in
one place). Copy ON SELECT is the one silent path, deliberately.

## A click puts the cursor where you clicked (full rules, moved out of CLAUDE.md 2026-08-31)

A CLI's prompt is drawn text and a pty takes keystrokes, so a click can only become the arrows that
would have reached the same cell (`src/shared/cursorMove.ts`). The trap: an up-arrow in a plain shell is
the previous command, not a movement.

- **A bare click is allowed the half that cannot recall anything.** `keysAlongLine` emits left and right
  only, and only when the click landed on the cursor's own logical line — proved by walking xterm's
  `isWrapped` chain. On mouseup, and only when the pointer did not travel.
- **The composer a CLI draws is ONE text field, found by its rules, not by its frame.** `composerAt`
  (`shared/promptBox.ts`) walks to the rule above and a rule of the SAME width below and requires a
  prompt marker on the first row. **Crossing a row boundary costs exactly one character** — the space
  the wrapper ate, or a hard newline — and **nothing** when the row is drawn out to full width; a row
  within a column of the width counts as full on purpose. **The marker is followed by U+00A0, not a
  space** (`BLANKS`). `npm run test:promptbox`.
- **A drawn input box is the one place a bare click may go up and down.** A plain shell draws none, and
  an ASCII `|` is deliberately not a frame.
- **A selection can be deleted, and typed over** — `keysForDelete` sends one backspace per character,
  only on the cursor's own line and only across rows the input WRAPPED onto.
- **The click is swallowed only on its way to an AGENT.** These handlers are capture-phase, and an
  unconditional `stopPropagation` robs xterm of the mouseup it removes its own drag listeners from. The
  stop is kept only while the CLI has mouse reporting on. `npm run test:stickyselect`.
- Alt/Option-click reaches other lines, refuses more than `rowLimit` away, and is the only path that may
  emit an up or down OUTSIDE a box. The clicked column is clamped to what is written on that row.

## A shell pane says what it is running (full rules, moved out of CLAUDE.md 2026-08-31)

Every "is this pane working" reading is about an AGENT. `shared/paneJob.ts`; `npm run test:panejob`.

- **On POSIX it is the pty's own foreground process** (`tcgetpgrp`, behind `IPty.process`). One syscall,
  same 1s sweep.
- **Windows has no such reading, and the failure is a LIE rather than an absence**: `IPty.process` there
  returns `"xterm-256color"` idle AND busy. So the answer comes off the process table (`jobFromTable`,
  `TABLE_JOB_MS` 4s, only while a shell pane is open, never twice at once). **An empty table leaves every
  pane as it was.**
- **A BACKGROUND job is invisible to the foreground reading, and that read as idle** — `cmd &` leaves the
  SHELL in front of the tty, so `sweepTableJobs` answers on POSIX too, asked ONLY when the foreground
  reading came back empty.
- **`reclaim.ts` refuses on `job` as well as on `busy`** — different readings, and one of them was wrong.
  The load-bearing test case is `job` refusing ON ITS OWN, with `busy` false.
- **It feeds `busyOnScreen`, rather than being a state of its own.** The clock counts the COMMAND.
- **Narrow on purpose, because the expensive failure is a FALSE job**: only a pane whose RUNNER is a
  shell, and a foreground that is itself a shell is a subshell, not work.

## ...and an agent pane says what it left running (full rules, moved out of CLAUDE.md 2026-08-31)

`paneJob.ts` refuses to speak about an agent pane and that refusal is load-bearing. But an agent that
starts work in the BACKGROUND goes quiet the moment the turn ends. `shared/paneBackJobs.ts` is the
cosmetic half — a chip and a hover sentence — and feeds no BUSY reading. `npm run test:panebackjobs`.

**It does rank the row, and only that.** `Session.backJob`/`backJobSince` (from `backJobInfo` in
`main/usage.ts`) reach `fleetState`, where a pane holding one is `working` with its clock counting the
JOB. Out of `busyOnScreen`; a live question still outranks it, a stale bell does not.

- **A count of the pty's descendants is not the reading** — every `claude` pane here permanently holds
  `safaridriver --mcp`, `chrome-devtools-mcp`, `codegraph serve --mcp` and `caffeinate`: trees of 5-9
  with nothing running.
- **What separates them is HOW a process was started, never what it is.** Every command an agent CLI runs
  goes through a shell it spawns with `-c`; MCP servers and `caffeinate` are spawned directly. So a job
  is a SHELL SUBTREE under the pty — no vendor names anywhere in the rule.
- **The age floor is `backJobs.LOOP_MIN_SECONDS`' 30s and for its reason**: a foreground Bash call is a
  shell subtree too. A subtree is never walked INTO, so a `npm run dev` with its own sub-shell is one job.
- **Shell grammar is not a name.** A keyword that HEADS a control structure owns its line
  (`for i in $(seq 1 120)`); a marker between header and work (`do`, `then`) is stepped over like a
  PREFIX word. `ps` prints a newline as `\012`, so that is what a multi-line `eval` splits on.
- **The name comes off the `-c` string, first segment that is not housekeeping** — the LAST segment names
  a `sleep 400; true` job `true`. Oldest live descendant is the fallback; `workName` prefers the script
  over the interpreter.
- **It rides on the sampler that already runs** — `main/usage.ts` reads the table every 4s, so `ps` gained
  `etime=` and `command=` rather than the app gaining a second ~380ms read. `shared/usage.ts` imports the
  rule as a TYPE only, or node's type stripping cannot resolve the extensionless sibling.

## What a pane leaves running (full rules, moved out of CLAUDE.md 2026-08-31)

Quitting kills each pty with `taskkill /F /T <pid>`. Two things sit outside it and `src/main/strays.ts` is
both: an orphan whose middle process exited (so `npm run dev` leaves vite behind), and the app dying
without running `shutdown()`. A sampler walks each live pty's descendants every 30s into `strays.json`,
keyed by the app run that owns it; closing a pane, quitting and the next launch all kill from that ledger.

- **A pid is never enough** — every record carries the creation time, re-checked by whatever kills.
- **A run whose app is still alive is somebody else's** — usually the `npm run try` copy.
- **Nothing here may block the main process** — every table read is `execFile`; the two paths that cannot
  wait hand the pids to a detached script.
- It never asks what the pane is RUNNING — a per-CLI hook is out of date the day a new agent ships, and
  silent in the crash case. POSIX needs almost none of this.
- `npm run test:strays` spawns real orphans (~25s) and loads the real `spawnDetachedNoWindow`; stubbing it
  makes every kill silently do nothing.

## A pane opened with a prompt sends it (full rules, moved out of CLAUDE.md 2026-08-31)

`queuePrompt` in `src/main/sessions.ts`. A blind timer fails silently: the pane holds a fully typed prompt
nobody sent, idle and green. `npm run test:promptsubmit`.

- **The readiness signal is an idle COMPOSER, never a clock**: output stopped AND `readsBusy` false.
- **The busy read looks at the last thing PAINTED, not at a window of scrollback** — a boot's
  `esc to interrupt` never leaves the buffer, so a fixed tail calls a pane busy for ever.
- **The return is a separate write**, a beat after the text.
- **The submit is confirmed, not assumed** — the proof is a TURN (`runSince` newer than the write), never
  output, because a `/clear` restarts the CLI and its banner paints for seconds. A busy pane is WAITED OUT
  to the deadline rather than counted as a submit; an idle composer with no turn behind it gets another
  return. The old settle-on-busy branch is named as the bug in a source assertion.
- **A `/clear` is not a boot, so it does not get a boot's patience.** The hook chain paints in bursts with
  second-long gaps, so the idle read says ready and the return is eaten. `PROMPT_ENTER_TRIES` is **6** (a
  return at an empty composer is a no-op in every CLI here) and the resume prompt waits on
  `CLEAR_RESUME_BUDGET_MS` (**3 min**) against the launch prompt's 45s, with the handover curtain following
  the same number. All five exit paths write to `autoclear-app.log`, the one that matters saying `UNSENT`.
- **The clear itself is 27s and about a second of that is waste**: 2.4s for the turn to end, 11.4s of
  `ARM_QUIET_MS`, 15.0s of the countdown somebody is meant to be able to stop, 0.9s of arm lead against a
  nominal `ARM_CLEAR_LEAD_MS` of 120ms. Shortening either big number is a decision, not a fix.
- Model ids are part of this: a Codex pane on any `gpt-5.1-codex*` id answers `400 ... not supported when
  using Codex with a ChatGPT account` inside a healthy-looking pane, so `agents.ts` lists only ids measured
  answering on a subscription login.

## An agent's question is a row of buttons (full rules, moved out of CLAUDE.md 2026-08-31)

`shared/choices.ts` reads the chooser off the pane's own frame, so it covers every CLI rather than
whichever one has a hook. **The card is docked to the RIGHT of the question and does not repeat it**
(260px, full width on a coarse pointer); answers one per line, all the same width, so arrowing repaints
one border instead of reflowing a row of pills. `npm run test:askrender` pins the dock, the absent copy
and the equal widths.

- **The reading is narrow because the expensive failure is a FALSE question.** Three things must all be
  true: the CLI's own `Enter to select` footer, options numbered 1..N with no gaps, and exactly one row
  carrying the arrow. Both positive fixtures in `npm run test:choices` are real frames.
- **The screen that ENDS a multi-question ask prints no footer.** `REVIEW` is a second anchor sitting
  ABOVE its list so `readReview` walks DOWN, winning only when newer than the last footer. Two refusals
  keep it narrow: 1..N with exactly one `❯`, and **nothing but blanks and rules below it**.
  `submit`/`done`/`finish` join `GOES`; `Submit answers and don't ask again` is refused by `WIDENS`.
- **A RULE in the list is read exactly like a blank line**; the box gutter is stripped. The FOOTER is
  still the load-bearing guard.
- **Arrows and a return, never the digit** (a chooser that only reads arrows ignores a digit silently),
  `CHOOSE_GAP_MS` apart, counted from where the arrow is NOW; a press against a question the pane has
  left is REFUSED.
- **The reading is on the SESSION, not in the pane** — the phone draws the same buttons, `pty:choose` is
  reachable over the phone server, a mirror is answered over the link.
- **A question is RED, makes its own NOISE, and leaves the machine.** `.row.asking` glows down the card's
  left edge while `Session.ask` is set; no ring on the pane itself. `sounds.ask` (default `knock`) plays
  on `sessions:ask` and `done` is deliberately NOT played over it. `main/askNotify.ts` posts to Telegram:
  silent without `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, one message per question (`sameAsk`), never for
  a mirror, and it posts and stops — a bot token has exactly one long-poller. `scripts/pf-telegram.mjs`
  turns a TAP back into `pty:choose`. `npm run test:asknotify`.
- **A click on a pane holding a question types NOTHING into it** — `askRef` refuses the bare click, the
  Alt-click and the selection delete while `Session.ask` is set; the answer is the buttons.
  `npm run test:askclick` is a real mouse through CDP, controlled by the same click with no question still
  sending its arrows. **`window.api` is frozen by the context bridge**, so the pane keeps its own list
  (`window.__pf[id].clickKeys()`).
- `npm run test:choices`; its load-bearing assertion is on the BYTE (`charCodeAt(0) === 27`).

## Arrowing through a question may not cost the whole desk (full rules, moved out of CLAUDE.md 2026-08-31)

The sessions list is ONE array rebuilt whenever anything about any pane changes, and a pane's render
re-measures the turn-copy pairs and the rail against the live buffer. `TerminalPane` is `memo`'d with
`samePaneProps`, comparing `ask`, `termTheme`, `mirror` and `grid` BY VALUE because main sends a fresh
object each time. Five arrow moves: 34 renders of every pane → 5 on the question's pane, 0 elsewhere.

- **The load-bearing assertion is the bystander's count**, not the question pane's — a memo that also
  skipped the question pane would pass a "renders went down" check and break the feature.
  `npm run test:askrender`; `window.__pfRenders` is the per-pane counter.
- A prop added to `Props` without a line in `samePaneProps` is a pane that stops updating for it, which is
  why that function lists them out instead of looping over keys.

## ...and a pane that is only PRINTING may not talk to React at all (full rules, moved out of CLAUDE.md 2026-08-31)

A memo stops the re-render, not the dispatch. `setState` with the value the state already holds still
costs `requestUpdateLane`, an update object and the eager evaluation before React bails out — and a pane
writes three of those from `onRender`/`onScroll`. Measured over eight shells: the desk's React work was
37ms of a 3-second run over 17 renders while `requestUpdateLane` ALONE was **18-22%** of the profile.

- `useQuietState` (`renderer/src/quietState.ts`) mirrors the value in a ref and compares in FRONT of the
  dispatcher. `geom`, `selChip` and `scrolledUp` are quiet. The updater form is kept — it is how a caller
  says "the same object when nothing moved" — and is evaluated against the ref.
- Keystroke to frame median **297/49/423ms → 40/34/34ms**, p90 **420/420/819ms → 220/42/39ms**, GC
  **26-38% → 4-5%**.
- **The guard is a SOURCE test**, `npm run test:quietstate`, because the fault looks correct from every
  other angle. `npm run type-profile -- --blame yi` is the measurement and asserts nothing.
  `window.__pfDeskRenders` carries `ms` as well as `n`.

## ...and a question with an obvious answer is answered (full rules, moved out of CLAUDE.md 2026-08-31)

`shared/autoAnswer.ts` presses return instead — **on by default**, **thirty second** default wait.
`npm run test:autoanswer` (weight in the negatives) and `npm run test:askrender`.

- **It takes the BEST option, not the first one.** A CLI marking its own preference (`(recommended)`,
  `[default]`, `- suggested`) is the tool STATING the answer, so exactly one marked option outranks a
  yes-shaped word and the row the arrow is on. Two marked options are a choice again. The marker raises
  rank and can never lift an option past a refusal.
- **The refusals are the feature.** Exactly ONE option leading with a yes-shaped word is answered. The
  arrow sitting on a REFUSED option is not a licence to take a different one. An option that WIDENS
  permission (`don't ask again`, the bare `always`) is never reachable, nor one that stops or answers with
  a question of its own. `anyQuestion` is the wider setting; both refusals hold over it.
- **The whole wait is spent AWAY from this window.** `holdWhileWatching` (on) stamps `askHold` while the
  app has the keyboard and `startOf` runs the clock from the later of that and `askSince`, so looking away
  starts the full `waitMs` again. Held draws no countdown at all (`autoAnswerHeld`). That is also what
  makes the Telegram buttons reachable. One focus reading: `gameMode.deskFocused()`.
- **Both clocks tick against the DEADLINE, not the wall clock** (`useNow(1000, at)`).
- **The timing is `dueForAuto`, and it takes TWO signatures.** The wait's signature includes the arrow;
  "have I already pressed this one" may NOT (our own keys move it), so `askKeyOf` leaves the arrow out —
  one press per identity, plus a `PRESS_COOLDOWN_MS` floor of 4s.
- **`maxRun` is given back by the pane going BUSY, and by nothing else** — a chooser mid-repaint reads as
  no question for one frame.
- **A hold CLEARS the deadline, it does not move it** — `refreshAutoPlan` writes `autoAnswerAt = 0`,
  because the card's `AskClock` and the desk tick (`soonestAuto`) read the bare number.
- **The countdown is a banded row in the pane, a chip on the CARD, and a TICK.** The chosen option's button
  carries `.auto` — dashed, because `.on` is a different fact. `playTick` sounds once a second through the
  last minute of whichever countdown is soonest (one clock, not one per pane), its own catalogue entry and
  Settings row, a third of an alert's level, deliberately bypassing the 900ms alert throttle.
  `window.__pfTicks` makes it checkable.
- **A changed default cannot reach an existing desk on its own** — `defaults()` is WRITTEN to config.json
  at first launch, so `defaultsV2` + `migrateAutoAnswer` apply the new defaults once, read off the **saved**
  config, never off the merge.

## A pane says what its handoff has left (full rules, moved out of CLAUDE.md 2026-08-31)

A pane past the context line writes a handoff, and its `## Next steps` is the only place that answers "is
there work left in there". `shared/handoffSteps.ts` is the reading (a MIRROR of
`claude-memory/claude-config/autoclear.mjs`, as `promptKey.ts` mirrors the prompt fingerprint),
`main/handoffSteps.ts` the disk and the 30s cache. `npm run test:handoffsteps`, whose parity half SKIPS OUT
LOUD when the canonical file is absent.

- **`0` and `undefined` are different answers** — `0` wrote `None` and is finished, `undefined` never wrote
  a handoff. The chip is drawn for neither.
- **It decorates and it REFUSES; it reaches no busy reading** (same contract as `Session.backJob`).
- **The countdown re-reads it at the last moment** — everything in front of `armAutoClear` is a delay and
  the session works through all of it. The file is read again at the arm, and a handoff with nothing open
  refuses with `NOTHING_OPEN`, a string `pane-clear.mjs` carries in its non-overridable list. A
  `--no-resume` cost clear is exempt, and only a handoff that EXISTS may refuse.

## A pane that is still starting says so (full rules, moved out of CLAUDE.md 2026-08-31)

`sessions:start` returns in 16-46ms; the first byte arrives ~1.3s warm, ~4.2s cold. `blank` stopped being
the reading the day scrollback came back — a RESTORED pane opens wearing its old screen. `Session.printed`
is the epoch of the FIRST byte out of THIS process, cleared by restart and wake, because only main can tell
replayed bytes from the new process's own.

`PaneBooting` draws one dim line at the BOTTOM (`.pane-booting.over`) while `booting`: **it names the
RUNNER** (`Starting Claude Code…`, off the agent's `label`) and adds a seconds count past `COUNT_AFTER_MS`
(1.2s). No spinner — a looping decoration is what `test:anim` refuses — and its own component, so the shared
tick is subscribed to only while a pane is starting.

`npm run boot-timing --panes 7`: panes back on screen with old output 1.3-2.6s, first byte 2.6-8.8s, a
typable composer 4.1-14.3s, main under 0.5s CPU in the first 30s. The wait is the CLIs (one `claude` alone
reaches a composer in 1.4s). **Staggering the restore was measured and is WORSE** — 300ms apart put the last
composer at 26-29s against 4-16s for one tick — so they still all start in one tick.

## A picture goes in front of the agent (full rules, moved out of CLAUDE.md 2026-08-31)

Every agent reads an image off the DISK, so bytes are written as a real file **on the machine that owns the
pty** and that path is typed (`shared/attach.ts` naming, `main/attach.ts` disk). `npm run test:attach`.

- **A paste is the one place the ^V is right** — a clipboard image goes to an agent that reads the clipboard
  itself as a plain ^V; every other CLI and every MIRRORED pane gets the file and the path. Forwarding a raw
  ^V only ever worked with an agent that reads the OS clipboard AND is on the clipboard's own machine.
- **A path is only true on one machine** — `@device/id` and a browser send the bytes over the link, and
  `attachOn` answers with a path that exists over there.
- **The name is TEXT, never a path** — only the basename survives, both separators, control bytes and
  reserved punctuation gone. The extension comes off the MAGIC BYTES when recognised.
- 5 MB a batch (base64 over the 8 MB frame is 4/3). Nothing is submitted for you.
- **A dropped file arrives in TWO shapes** — a macOS screenshot dragged off its preview thumbnail carries
  `text/uri-list` with no File object, so nothing called `preventDefault` and Chromium typed the URL into
  xterm. `splitDropUris` turns a `file://` URI back into a path (percent-decoded, Windows' extra leading
  slash gone, a host kept as UNC); http(s)/data is fetched. `text/plain` is deliberately NOT claimed.
- Not covered: pasting an image on the phone client.

## What a pane costs is measured, not modelled (full rules, moved out of CLAUDE.md 2026-08-31)

`capacity.ts` models a pane at 190 MB and answers "is there room for another". The chips answer "which one
is eating the machine" — `src/shared/usage.ts` arithmetic, `src/main/usage.ts` commands and timer.
`npm run test:usage`.

- A pane is its pty's whole descendant TREE — counting the pty loses the build the agent started.
- CPU is a delta of cumulative counters, never `ps %cpu` or a Windows perf counter. The first sample has no
  CPU figure; a process first seen mid-flight is capped at the interval.
- The sampler does not read the table while the window is hidden or minimised, and never has two reads in
  flight.
- **The memory column is read five times more slowly than the rest of the sample.** `top -l 1` costs ~1.0s
  wall of which **0.82-1.04s is SYS**, against 0.03-0.05s for the whole `ps` table, and `-pid` is a display
  FILTER that makes it no cheaper — so at `SAMPLE_MS` the memory chip alone burned a quarter of one core
  inside the kernel. CPU is a delta and must be read every tick; memory is a level. `FOOTPRINT_MS` (20s) is
  the rate, `dueForFootprint` the rule, and a pane that opened since the cached table forces a fresh one
  because a pane's FIRST sample is what the capacity ladder acts on. **16 → 4** `top` launches a minute.

## A reopened pane comes back with what was on its screen (full rules, moved out of CLAUDE.md 2026-08-31)

The terminal's scrollback is renderer memory, so before this every pane reopened blank. `test:restore` is a
different promise — it hands the agent its `--resume`, which brings back the conversation and not one line
of the screen.

- **Most of them come back ASLEEP.** A pane can be BORN asleep (`Live.proc` is nullable, `start()` takes
  `asleep`), so the card, its place and its screen arrive with no process and a press wakes it in the
  conversation it was in. **A sleeping pane still has a SHAPE**: `sleep()` gives it `status: 'exited'` and
  `resize()` dropped every call for an exited session, so its grid froze at `START_COLS` and `wake()`
  spawned the CLI at the frozen number. Only a genuinely DEAD pane is dropped now. `restoreAsleep`
  (`shared/restoreTurn.ts`) is the rule and the refusals are the feature: the first pane, a pane launched
  with a prompt, and a pane the restart caught mid-turn all come back running. `npm run test:restoreturn`.
- **Nothing new is stored** — `history.ts` has appended raw output to `userData/history/<id>.log` all along
  and `tail()` reads the last `BUFFER_LIMIT`. The missing part was the **id**: a restored pane is a new
  session, so the desk carries `scrollbackId` and `start()` seeds from it. Save the new id there and it
  restores nothing, silently, for ever.
- `tail` must not strip ANSI (`read` does, for search) and must cut on a line boundary. One dim line says
  where the old output ends, and it resets attributes first. `test:scrollback`.
- **It comes back with its own clock, and finishes the turn it was cut off in.** The display clock is
  `openedAt`, deliberately NOT `createdAt`. A pane caught mid-turn is continued through `queuePrompt`, off
  `runSince`, under the SAME switch as a turn the transport cut in half.
- **Which restarts ask is one rule with one switch** — `askAfterUpdate` (Settings → Updates), off by
  default and inert while `restoreAfterUpdate` is off.
- **It is replayed at the width it was PAINTED at, and Fix cannot do this job.** Agent CLIs draw in absolute
  column moves and a terminal CLAMPS. `restoredTail` carries the old width out with the bytes (`colsOf`),
  `Session.replayCols` takes it to the pane, and the pane writes that part of the buffer at that width and
  hands the terminal back — **only the part before the restore mark**, and only while the mark is there. The
  resize goes in the write CALLBACK, never after the call. `shared/replayWidth.ts`, `npm run test:replaywidth`.
- **It presses Fix for itself** — `repair()` once, `RESTORE_FIX_MS` (1.2s) after output stops. It is
  `autoFixUi`'s; a mirror is refused; a hidden pane is FLAGGED rather than repaired against a 0x0 host.
  `test:restorefix`, whose control is a new pane recording ZERO repairs.
- **The prompt tags come back with it.** The rail is built from KEYSTROKES, so a replay registers none;
  `seedMarks` scans for the CLI's own `❯ <text>` echo, once, only while the rail is empty. **`❯` only** —
  `>` starts a quote, a diff line, a shell prompt and a blockquote. A rebuilt tag carries no time.
  **A row at a time is not enough**: a replayed screen holds every repaint, so `seedPrompts` refuses a row
  carrying a rule or followed by one, refuses one with a non-blank row above it, and keeps ONE tag per
  prompt, on the LAST copy. `test:promptecho`.

**And `/clear` no longer takes the previous turn with it.** Three releases of Claude Code wiped the screen
three different ways, so the answer is not a list of vendor bytes. `npm run test:scrollclear` drives a real
headless xterm with a control per shape.

- **The pane keeps the screen itself, before the CLI has emitted a byte.** `keep.arm()`
  (`shared/keepScrollback.ts`) fires when a submitted line matches `mayClearScreen` and RETURNS the scroll,
  which the pane writes on the spot.
- **What was TYPED is not what was SENT** — `/cle` picked from the completion menu runs `/clear`, so a bare
  slash TOKEN that is a PREFIX of one of those commands arms too. A miss destroys the turn somebody is
  reading; a false arm only scrolls a screen about to be repainted, and only rows holding something are filed.
- **The composer is not history** — `keptRows` stops at the composer's top edge, and the composer is only
  believed when the CARET is between its two rules.
- **`arm()` is fed by keystrokes, and a keystroke is one of several ways a clear arrives** — the Clear
  button, the session menu, a phone and every path in main that types for you go through `paneArmClear`.
- **The unarmed case is caught by SHAPE, then by OUTCOME.** The cursor sent to the top with an erase is
  REPORTED, not acted on; `shared/screenLoss.ts` files it only when **80%+ of the screen is gone** (a
  scrolling diff loses 35-44%). The `2J`/`3J` rewrite stays for a CLI that clears unasked, and stands down
  for 10s after an armed scroll.

**And a prompt tag survives the CLI repainting over it.** xterm disposes every marker on a row that `CSI J`
blanks (Claude Code lost 0 of 278, Codex 25-50%). `shared/markAnchor.ts` re-anchors on a deferred callback
while the line is still in the buffer, and ends the tag only when the buffer has genuinely forgotten it.
`npm run test:markanchor`, whose control proves a bare marker really does die.

## History says what each session was working on (full rules, moved out of CLAUDE.md 2026-08-31)

Every row carries one line: the first thing typed at the agent, plus how many asks followed.
`npm run test:gist`.

- **It costs nothing** — no model, no tokens, no request; the line comes from keystrokes the app already
  relays, the same feed `promptArchive` is built from, so it works identically for every CLI.
  `shared/gist.ts` is only the tidy-up.
- **A row says when, as a DISTANCE.** Newest closed at the top (`endedAt ?? startedAt`); inside a day the
  chip is `closed 5 min ago`, past a day the calendar takes over because `31h ago` identifies nothing. One
  minute clock for the whole list, exact moment on the hover.
- **A row says whether it is still OPEN** — green rail plus a green `open since` chip, red rail plus a red
  `closed …` chip, so the answer is never carried by hue alone.
- **`View all` prints every chapter on the row** (`summaryFull`), drawn only where there is more than the
  row already shows, and it costs nothing.
- **The FIRST ask, not the latest.**
- **Scraping the transcript was tried and abandoned on the evidence** — a boxed composer is redrawn
  character by character and interleaved with its own repaints. A session that closed before the app
  recorded a line gets a best-effort one from the prompt archive and otherwise **no line at all**.
- **A session is several jobs, and `/clear` is where one ends.** `noteAskInto` reads a clear exactly as
  `keepScrollback` does. Three shown, the rest counted; a clear is a boundary and never a chapter heading,
  every other slash command heads nothing, and `asks` counts only the ones that were WORK. Twelve chapters
  kept, anything past that counted rather than dropped in silence.
- **What was asked survives a restart** — `recordStart` runs again on the same id.
- **The transcript is RENDERED, not stripped.** A pane's log is a stream of REPAINTS: a seeded 4 KB log was
  205 lines of which 200 said `Thinking…`, against 3 through a terminal. `renderer/src/termRender.ts` is
  ONE copy, shared with the phone's `TextSheet`, replayed at the width it was WRITTEN at.
- It is written outside the prompt-recall gate.

## The app remembers what has been asked (full rules, moved out of CLAUDE.md 2026-08-31)

`src/main/promptArchive.ts` answers one question — has this ask been made before — fed from
`shared/draft.ts` on the way to the pty, **not** from any CLI's hook. That is why it works: reading the
bytes covers every agent, including ones that do not exist yet.

- **It never blocks, never types, never cancels** — all that happens is a chip in the pane's corner.
- The quiet window (`QUIET_MS`, 6h) is load-bearing, not the score: a reworded re-send two minutes later is
  the SAME work.
- Only submitted lines are archived, never drafts, and only a capped preview plus the token set.
- **`src/shared/promptKey.ts` is a MIRROR of an algorithm that lives in three places outside this repo**
  (the `claude-memory` hook, the TaskDriver archive server, the Discord bot), sharing one archive. Editing
  one copy splits it in silence. `npm run test:recall` recomputes the canonical file's answers and **skips
  out loud** when that file is not on the machine.
- Not built: nothing watches a pane's repo for the commit an ask turned into, so `outcome` is null.

## Dictation needs nothing installed (full rules, moved out of CLAUDE.md 2026-08-31)

The mic on every pane, and Ctrl/Cmd Shift Space into the focused one. `shared/voicePick.ts` picks and
`useVoice.ts` falls down three transcribers: a **whisper CLI on PATH**, otherwise **Whisper in a worker in
this window** (`voiceWorker.ts`, ONNX Runtime wasm), and on a phone **the browser's own recogniser** (the
only one that sends audio off the device). `npm run test:voice`.

- **Feature-detecting `webkitSpeechRecognition` is not enough** — in Electron the constructor is there and
  every session ends `error: "network"`, so `browser` is gated on not being Electron.
- **The 8-bit weights do not run** (`TransposeDQWeightsForMatMulNBits / Missing required scale`); `bnb4` is
  the smallest that works. `shared/voiceModels.ts` carries the sizes.
- **The wasm ships with us**, copied by `electron.vite.config.ts`, which also deletes the 23.5 MB asyncify
  binary the worker never asks for.
- **Nothing on the page may import the worker's module** — one constant took the main chunk from 1.01 MB to
  2.23 MB. Constants live in `shared/voiceModels.ts`.
- **A phone is not a small desktop** — touch, or under 720px, and dictating takes the whole screen
  (`VoiceOverlay.tsx`); the ring IS the input level. It also appears while the model downloads.

## ...and it knows what is serving, and can stop one (full rules, moved out of CLAUDE.md 2026-08-31)

`devServers.ts` answers a package.json SCRIPT, which is what the OTHER machine needs. `shared/devList.ts`
answers what a person asking has in their head — the PORT and the pane. `npm run test:devlist`.

- **One server, not one process** — a candidate whose ancestor chain reaches another candidate is folded
  into that ancestor (the thing a person typed, and the one whose kill takes the tree), and what the child
  knew is folded upward.
- **A number is not a port because it is a number** — only `-p`/`--port`/`--port=`/`PORT=` count; a wrong
  port is the one thing somebody acts on.
- **Attribution is two-legged**: tree first, then a path test against the pane's folder (a server reparented
  onto pid 1 defeats a tree walk). **A server no pane claims is still listed.**
- **An ambiguous stop prints the list and asks.** A generic label (`dev`, `start`, `serve`) never matches on
  its own.
- **The pid is re-validated in main before anything is signalled** — one whose command line is no longer a
  dev server is refused out loud. SIGTERM, then SIGKILL.
- The renderer supplies only the ORDER and the words; every fact is read in main off the pane's own record.
  Read on demand when the ask box opens, never on a timer.

## The resource ladder has a face (full rules, moved out of CLAUDE.md 2026-08-31)

`capacity.ts`, `autoHandoff.ts` and `reclaim.ts` trim, move and close panes on their own, and their entire
output used to be a `console.info`. `shared/mascot.ts` is the mouth, `components/Mascot.tsx` draws it.
`npm run test:mascot`.

- **It is not a model** — every sentence is arithmetic over readings the app already holds, and every typed
  command is a small parser. Nothing leaves the machine.
- **What it says names the pane, which COPY of the project it is, what that pane was in the middle of, and
  when.** `paneWord` is `(1) taskdriver` / `(3) PaneForge lane a`: the number leads in brackets because a
  sentence naming several panes buries them otherwise, and it is the Ctrl key. `(3)` is also a form
  `paneNumbers` reads, or the pet cannot answer a sentence it printed itself. A pane nobody has typed a real
  ask into says nothing about one.
- **A pet is decoration; the reading is not, and `pet: 'none'` is the difference.** `NO_PET`
  (`shared/pets.ts`) keeps every reading and drops the sprite: the card docks bottom-right, and a pill
  carrying the pane count and total is the press that opens the ask box.
- **It may stand over a pane, but never over a LINE.** `spriteReserve` turns the overlap into bottom
  padding. Three things make it safe: rounded up to a whole ROW, measured against the HOST's box and never
  the drawn screen's (whose height feeds its own input), and a sprite above `RESERVE_MAX_FRAC` (30%)
  reserves NOTHING. The padding goes on `.xterm`, not `.xterm-host` — the fit addon reads the host's
  computed border-box `height`. Measured: 54 rows → 46, screen bottom 748 against sprite top 761.
- **Everything it says is selectable and copyable** — `.mascot-say` opts back in with both spellings, and
  the `⧉` copies `saidText`, the SAME expression the card renders.
- **"What is open" is an answer.** A dev server named beside a pane NUMBER narrows the SERVERS rather than
  handing the sentence to the pane branch. A bare "pane" with no number still means the panes.
- **A bubble takes itself away** (`mascot.hideSeconds`, 60s, 0 = until pressed); the clock restarts on every
  keystroke in the ask box, and a COUNTDOWN is exempt.
- **A guess is never an action** — "close pane 9" with five panes closes nothing and says how many there
  are; names match longest-first with a contained name dropped; every destructive intent is OFFERED as a
  press. `closeable()` is `reclaim.ts`'s own refusal set.
- **A finished turn is the pane this ladder exists for** — `fleetState` says `needsYou` for both a live
  question and a finished turn, so the refusal that is meant is `asking`, off `Session.ask`.
- **The countdown is HEARD, not only drawn** — `sounds.move` (default `bowl`) plays once when a countdown
  arms and the last five seconds tick.
- **Nothing decides and then reports: it counts down first.** Both sweeps hand their plan to `armCloseRef`
  and the mascot draws `CLOSE_COUNTDOWN_MS` (15s) with the pane named, `Keep it open` and `Close now`. Doing
  nothing still closes it. `Keep it open` holds for `KEEP_MINUTES` (10). With the mascot hidden there is
  nowhere to draw a count, so it closes.
- **It speaks unasked once per situation**, and only where the app is otherwise silent.
- **There are TEN of them and they cost the same** (`src/shared/pets.ts`). The animation is keyed on the
  SLOT rather than the animal, so a new pet is ART and nothing else. Only the picked one is mounted, layers
  are cached by identity, and the rig is `animation-play-state: paused` behind a minimised window. Every pet
  is on the SAME 24x24 grid — at 48 CSS px exactly 2 device pixels a cell. Detail comes from layers and
  shades, never more cells. A pet may not float; `test:mascot` fails on a `translateY` in that stylesheet.
- **It arrives OFF.** It runs about rarely and every condition is a refusal (`dueDash`, `DASH_EVERY_MS`
  9 min). It can be picked up, and a drop writes `mascot.spot` as a fraction of the window, **beating every
  automatic move**; the pin gives it back. Under `DRAG_SLOP` the gesture is still the press that opens the
  bubble, and the click after a real drag is refused from a REF.
- **The bubble is placed in the LAYER, in pixels** (`bubbleSpot`), clamped on both axes.
- **The layer never takes a click**: `z-index: 40`, over the panes and under every dialog,
  `pointer-events: none` except the sprite and its bubble.
- **Mute by default. It never picks which machine** — `hand off pane 2` opens the box with the panes chosen.

## ...and one card says what this app can even do (full rules, moved out of CLAUDE.md 2026-08-31)

One quiet card bottom-right — `shared/tips.ts` catalogue and judgement, `components/Tips.tsx` the card.
`npm run test:tips`.

- **It costs nothing**: a fixed sentence chosen by arithmetic over what has been seen.
- **It never interrupts**: silent while any dialog is open, while an update card is up, while ANY pane holds
  a question, behind a minimised window, and for the first four minutes. `FIRST_MS` 4 min, `EVERY_MS`
  40 min; the load-bearing half of the test is those negatives.
- **It says how to stop it before anybody has to go looking** — the first card and every fourth after it
  carry the sentence and the button (`offersOff`). Settings is the way back on.
- **It cycles rather than repeating**: every tip shown once before any is shown twice, and `seen` resets
  rather than going quiet.

## A session that clears itself asks first (full rules, moved out of CLAUDE.md 2026-08-31)

`claude-config/autoclear.mjs` (a Stop hook) decides a session is past its context line AND that its handoff
lists work a fresh session could start, then asks this app to clear that pane over the phone server
(`pane-clear.mjs` → `autoclear:ask`). The desk draws a countdown card: what would be continued, how long is
left, **Keep this session** and **Clear now**. Nobody at the desk means it still happens by itself.
`npm run test:autoclear`.

**The clear is typed; everything after it is TALKED to.** `/clear` goes out after the arm lead and the
resume prompt goes through `queuePrompt` — which waits for an IDLE COMPOSER rather than a stopwatch. The
blind schedule it replaces typed at a fixed +2500ms and fired two unconditional CRs: a stray Enter into a
live CLI on every clear. `clearChunks` is unchanged, so parity with the hook's `paneChunks` holds;
`CLEAR_SETTLE_MS` and `SUBMIT_RETRIES_MS` stay exported for the hook's own fallback.

`shared/autoclear.ts` holds every refusal and `main/autoclear.ts` the clock; both are re-evaluated against a
FRESH pane reading each tick, so a pane that starts another turn, is typed into, exits or disappears drops
its countdown. An ask with no open steps is refused at both ends. A PaneForge older than the channel makes
the hook REFUSE rather than fall back to the instant clear.

- **Nothing open means no clear, and that promise is made to the session in writing.** `blockMessage` tells
  a session about to write its handoff that `## Next steps` with `None` is respected. A clear exists to
  CONTINUE work.
- **The keeper is fed by KEYSTROKES, and nothing this path sends is one.** The countdown writes straight to
  the pty, so `feedInput` never saw the `/clear` and `keepScrollback` never armed. Main emits `armclear` →
  `pane:armClear` → the pane's own `keep.arm()`, `ARM_CLEAR_LEAD_MS` (120ms) before the command lands.
  Measured: `baseY` 0 → 6 with the emit, 0 without it.

## The screen stays on while a pane works (full rules, moved out of CLAUDE.md 2026-08-31)

`shared/awake.ts` + `main/awake.ts` hold a `powerSaveBlocker` while any pane has an agent mid-turn or sits on
a question, and let go when the desk goes quiet. `npm run test:awake`.

The cap is the load-bearing part: it is on the BUSY STRETCH, not on the hold, so a wedged pane cannot keep a
laptop lit all night and cannot re-arm the hold by ticking. `config.keepDisplayAwake` turns it off.

**Holding the MACHINE awake never justified lighting the PANEL.** The lid guard's `pmset -a disablesleep 1`
makes the kernel ignore the lid OUTRIGHT, backlight included. `screenUnseen` drops the screen hold alone —
the system hold, the panes and the turn in flight are untouched. It is narrower than "the lid is shut" on
purpose: clamshell driving an external monitor reports the lid shut too, so Electron's own display list has
to say the builtin is the only screen. A reading that FAILED counts as false, and the control in
`test:awake` is the same desk with the lid up, still lit.

## A pane's two ends open at the same width (full rules, moved out of CLAUDE.md 2026-08-31)

Everything an agent CLI prints is absolute column moves, and a terminal CLAMPS a column it cannot reach. So a
pane has exactly one rule: the grid it is drawn into may never be narrower than the width its bytes were
painted for. `src/shared/paneGrid.ts` is that one number, read by BOTH ends. `npm run test:panegrid`, whose
load-bearing half is the CONTROL — one line painted into a narrower grid MUST still tear across several rows,
because a clamp wraps rather than deletes.

- The pty spawned at 120 while xterm opened at its library default of 80, and a `claude --resume` dumps the
  whole conversation at once, so every answer drawn to column 119 was torn apart permanently (xterm can unwrap
  a row it wrapped itself and can never undo a clamp). NOT `shared/replayWidth.ts`'s bug, which is a RESTORED
  pane's old bytes; this is the pane's own live output, on every launch.
- **Fix now repairs the scrollback, not only the live frame.** `redrawHistory` re-renders from the raw byte
  stream at `max(pane now, replayCols, START_COLS)`, then hands the width back. User-initiated only.
  `window.__pf[id].redraw()` is the same thing for a probe.

## Checks (full rules, moved out of CLAUDE.md 2026-08-31)

`npm run typecheck` before committing, and `npm test` — 81 checks in ~145s, everything needing no window, no
network and no real agent CLI (`scripts/test-all.mjs`). It is also the release gate's third step:
`agentGate.ts` looks for a script called exactly `test`. **A new cheap test goes in that list or it never runs
by itself.**

Each suite's one-line "what it pins" table lives in `docs/design-notes.md` under **Checks — what each suite
pins**; `npm run` lists the commands. Read that table before changing or deleting a suite, and add a row when
you add one.

Needing a real window (`npm run build && npm run try -- --keep --show --remote-debugging-port=9333`):
`test:view`, `test:stashdrag`, `test:activate`, (turncopyview removed 2026-09-02), `test:restorefix` (two launches),
`test:askclick`, `test:askrender`, `test:devicesfit`, `test:phoneview`, `test:contrast` (~90s, both themes),
`test:renderwatchlive` (spins the renderer on purpose, ~25s).

Out of the default suite because they need the network: `test:discordbrand` (asks Discord what
`DISCORD_APP_ID` is called AND whether `PRESENCE_IMAGE`'s asset still exists — the two halves fail
separately), and `node scripts/mac-update-test.mjs --live <version>` (~120 MB).

Other agent-runners are watched by `npm run competitors` (`npm run test:competitors`), which prints only what
moved.

## A turn the transport cut in half finishes itself (full rules, moved out of CLAUDE.md 2026-08-31)

An agent whose stream dies mid-answer prints an error and returns to its composer. `shared/recover.ts` is
that decision. `npm run test:recover`.

- **It keys on the SECOND sentence.** Five different first sentences have shipped and every one ends
  `The response above may be incomplete.` — the CLI stating the precise thing that makes resuming safe.
- **A rate limit, usage limit, credit balance, auth failure or overload is never continued**, even carrying
  that sentence.
- **An error somebody QUOTED is not an error** — once submitted the CLI echoes it back with the full string
  intact; what separates them is the marker a CLI draws in front of a person's words, so a line starting
  `> ` is somebody talking. A copy still being typed is caught by `promptBox`.
- Three in a row and it stops; only output since the last look is read; the send goes through `queuePrompt`.

## A full machine gets its panes back (full rules, moved out of CLAUDE.md 2026-08-31)

`capacity.ts` gives back scrollback (~5% of the bill); `shared/reclaim.ts` returns the agent by closing the
pane — the cost is the CLI inside it (~190 MB each, against 16-17 MB for Codex). `npm run test:reclaim`.

- **A trim is a DELETE.** Lowering xterm's `scrollback` discards lines and raising it back restores none, so
  the recovery is a re-render from main's raw log (`REDRAW_BYTES` 4 MB, 45-147 ms of parse on the UI thread).
  So `trimPlan` takes a clock: `TRIM_GRACE_MS` (5 min) keeps the lines of a pane the keyboard has only just
  left, `TRIM_SETTLE_MS` (60s, longer than the 15s poll) makes a trim wait for its verdict to HOLD. **Growth
  is never delayed.** Both optional — a caller with no clock gets the plan this always made, the control in
  `test:capacity`.
- **What makes closing defensible here**: `kill()` calls `recordEnd`, so a closed pane keeps its History row,
  its `resumeId` and its `scrollbackId`. A closed pane here is a minimised pane in any other app.
- **Pressure is the trigger, never a clock** — idle time only breaks ties once the kernel is already objecting.
- **Never closed**: a pane waiting for a person (`needsYou` is quiet BECAUSE it is owed an answer), the
  focused pane, one on screen, one working or starting or stalled, a mirror. **The window is never emptied.**
- **The reading of the machine is a card that ARRIVES and LEAVES, never a strip.** `.cap-pop` is armed by the
  verdict CHANGING into something worth saying and takes itself away after `CAPACITY_NOTE_MS` (12s). **Only
  `over` arms it**, never `tight`, and never more than one per `CAPACITY_QUIET_MS` (10 min). The desk total
  is drawn only while `capacity.level !== 'ok'`.
- **A press on a pane takes its countdown with it** — `touchPane` drops `closeSoon` when the countdown names
  that pane. Other panes in the same plan are re-decided by the next sweep.
- **A HOLD is not a countdown, and the chip must not wear the same word.** `Session.closeKept` says which of
  the two numbers it is; the card says `kept 10m` with no red last-minute alert. A countdown card naming the
  pane still wins.
- **A deadline in the past is a STATE, not a number.** `idleCloseAt` clamps an overdue pane to `now` and
  `sameDeadline` stops republishing it — without it three overdue panes cost **3138 `setClosing` writes and
  2061 whole-window renders in five seconds**, against **0 and 0**. `window.__pfClosePublish` counts them.
- **A pane can be taken off the clock for good** — `ReclaimPane.pinned` is refused by `onTheClock` AND by
  `reclaimPlan`'s filter. `keptUntil` (an hour) stays the answer for "not now".
- **Looking at a pane is USING it, at BOTH ends of the visit.** `quietSince` is the latest of a keystroke, a
  printed byte and the moment the KEYBOARD LEFT — stamped when focus leaves AND when it arrives, plus
  `touchPane` on the press. One reading, so the sweep and the card cannot disagree.
- **The clock counts time a person could have acted in, not wall time.** `shared/away.ts` freezes it while
  `powerMonitor.getSystemIdleTime()` says nobody is here (`AWAY_AFTER_MS` 60s); `main/away.ts` polls every 15s
  and pushes `system:away` on a CHANGE. A second desk is refused by `sawPerson`, not by a setting. **Only the
  clock pauses.**
- **A turn nobody has READ has no countdown in front of it** — `unread` refuses `onTheClock`, holds the CLOCK
  only, and is gated on `Away.sawPerson`.
- **The rung above closing is SLEEPING, and it is ON.** `idleSleepPlan` (`reclaim.idleSleepMinutes`, 30 min)
  stops the agent and keeps the card, its place, its screen and its conversation. It shares `onTheClock`
  verbatim and drops the two rules that are about closing: it keeps no pane back and is not capped by
  `maxPerSweep`. No countdown, and the card says `asleep 3m`.
- **There IS a close clock, and it is off.** `reclaim.idleCloseMinutes`, 0 by default; the switch sets 5 min.
  It exists for a desk driven over the link with no person to close its finished panes. Every refusal above is
  shared verbatim except **visible**. Its own minute timer in `App.tsx`.

**And a restore is the one moment N agents start in a single tick.** `restorePlan` (`shared/capacity.ts`):
everything at normal pressure, **two** at warn, **one** at critical, never zero while there is a pane to
offer. A **preselect, never a cap** — an unticked pane keeps its conversation and its screen. It reads
`readPressure()` when the offer is built, not `lastPressure`, which on a cold launch may not have sampled. The
silent paths (an update restart, `restoreAfterRestart: 'always'`) are deliberately untouched.
`npm run test:capacity`.

## ...and before it closes one, it tries to move it (full rules, moved out of CLAUDE.md 2026-08-31)

Four rungs, each firing only where the one above did not solve it: trim scrollback (~5%) → start the NEXT pane
over there → **move a finished pane over there** → close it. `shared/autoHandoff.ts` is rung three;
`npm run test:autohandoff`.

**And none of that fires until something has already gone wrong.** `Machine.keepLocal`
(`autoHandoff.keepLocal`, **2**) is a budget, `Verdict.over` is how many panes are past it, and `budgetPlan`
moves exactly that many.

- **Past the budget the question is what a pane COSTS, never how many there are.** `expensive()`: a live
  shell/dev-server job (`AutoPane.job`, outranking both numbers), or `budgetMinMb` (500), or `budgetMinCpu`
  (50% of one core). Dearest first, then quiet-and-off-screen. **An unmeasured pane is not expensive** — the
  sampler does not read the table behind a hidden window. A desk far over budget with nothing expensive on it
  moves NOTHING and stays over, which is the honest answer.
- **The budget is a policy, so it holds at `ok`.**
- **It is the only rule allowed to move a pane that is ON SCREEN or MID-TURN.** Those two gates only ever
  meant "there is no emergency", and with the grid on `visible` is every pane. A busy pane is picked LAST
  (`rank`) and goes through the same queue; `queueable` is the wider set `movable` cannot be. Everything that
  could lose work is refused unchanged: the focused pane, a live question, a mirror, one already moving, one
  on a failure cooldown, the last pane on the desk.
- **The number moved is the overshoot, not `maxPerSweep`** — that cap exists so a machine under pressure
  re-reads its own recovery between moves.
- **Lag is read as well as memory, and the worse of the two decides** (`lagLevel`, `worstPressure`). One
  runnable thread per core is `warn`, 1.8 is `critical` — NOT a CPU percentage. `os.loadavg()` is 0 on
  Windows, so 0 means "nobody measured" and never "idle".
- **Nothing moves without a countdown anybody can see.** The 15s count used to be the mascot's, and the mascot
  ARRIVES OFF, so `MoveSoon.tsx` draws the same `CloseSoon` as a plain corner card whenever there is no sprite,
  calling the same two actions. z-index 45, no animation.
- **Two things are asked BEFORE a pane is picked, not discovered by moving it.** `AutoPane.machineBound`
  (`shared/paneBound.ts`) is work that would not exist over there — a browser being driven on THIS desk. It may
  never key on a browser NAME: every `claude` pane holds `safaridriver --mcp` and `chrome-devtools-mcp` from
  launch, so the reading is the automation FLAGS a driven browser carries (`--remote-debugging-port`/`-pipe`,
  `--headless`) plus a driver binary that is not an MCP server. Measured: 3 of 11 bound, 8 movable.
  `AutoPane.shareable` is the other leg — a git repo under the projects root with an origin remote
  (`shareable()` in `main/handoff.ts`, cached 5 min). Only an explicit `false` refuses; `undefined` is "nobody
  asked" and must not switch the ladder off on a slow first read. `npm run test:panebound`.
- **Nothing asks any more** — `offloadAsk` defaults off with a one-time `offloadDefaultsV2` migration (the
  `migrateAutoAnswer` shape, read off the SAVED config).
- **The pressure card OFFERS the move.** `suggestMove` names the dearest movable pane and its destination, and
  `.cap-pop` carries `Move it` / `Keep it here`. `Keep it here` adds the PROJECT to `autoHandoff.keepHere`,
  which every rung refuses (a pane's id dies with the pane; "this project is Mac-only" survives a restart).
- **A pane is never handed back where it came from** — two desks each keeping two agents are each correct and
  would pass one pane between them for ever. `senderDevice` in the payload, `arrivedFrom` stamped on arrival,
  `hostFor` skips that device. A second machine that did not send it may still take it.
- Both hardened like `offloadMinutes` (`keepLocalOf`) — these come off config.json and `config:set`, so `true`
  is not a budget of one.
- **A pane mid-turn is queued, never killed** — a pty killed mid-answer loses that answer for good, since the
  far end resumes from the transcript. `main/handoffQueue.ts` moves it the instant the turn ends; a pane that
  never goes quiet **expires** after `waitMinutes` and stays, said out loud. **And the chip that reports the
  wait is the control that ends it** (`remote:handoffCancel`); a move already IN FLIGHT has left the queue and
  says so.
- **`undefined` means keep the stamp; only `null` clears it** — `handoffQueuedAt` is what makes the chip say
  `waiting 12m` instead of `moving`. `run()` is the one caller that passes `null`.
- **The turn ending is an EVENT, not something to poll for** — `handoffQueue.poke()` on every `sessions`
  change; the `TICK_MS` (5s) tick stays as the backstop for expiry.
- The local half of a move is ~100ms; the push is SKIPPED when nothing is unpushed.
- **A pane holding a question is never moved, queued or otherwise** — `AutoPane.asking` is separate from
  `needsYou` for exactly this. Every other refusal is `reclaim.ts`'s verbatim; a failed move gets a
  `cooldownMinutes` hold.
- **...and those last two refusals are why it could never fire.** `idleOffloadPlan` is the opt-in clock beside
  it (`autoHandoff.offloadIdleMinutes`, 0 = off, the switch sets 30): it drops `visible` and the pressure gate
  and **nothing else**. Its own minute timer. The load-bearing test is a PAIR — the pressure sweep still
  refuses a visible pane, the clock takes it.
- **`handingOff` is on the Session, and `reclaim.ts` refuses it**, or the closing sweep and the moving sweep
  race over the same pane and closing wins by being faster. Every exit from a move clears it, refusals included.
- The sweep runs in the renderer beside `reclaim` (it needs `visibleIds`) **and on a 60s clock**: a desk that
  is full and quiet emits no session events.

**And the dev server travels with it.** `kill()` takes the pty's whole tree. `shared/devServers.ts`,
`npm run test:devservers`.

- **The server is routinely not a descendant of the pane** (a `next dev` on ppid 1 with its npm parent exited),
  so a process is attributed by the tree OR by its command line naming a path inside the pane's repo.
- **What is running is not what would be typed** — re-issuing the observed argv hard-codes a port and runs a
  binary out of a `node_modules` the receiver may not have. An observed process is turned back into a
  package.json **script name** and the receiver rebuilds the command from its own package.json and lockfile.
- **The payload cannot name a command, only a script**, re-validated against `SCRIPT_NAME` on arrival. The
  worst a malicious payload reaches is a script that repo's own author wrote, in an ordinary `shell` pane
  already swept by `strays.ts`.
- **An ambiguous match is dropped and named.** `npm run build` and `npm test` never travel; only `DEV_SCRIPT`
  (`dev|start|serve|watch|preview`, with or without a `:suffix`) does.

## What Windows loses between restarts (full rules, moved out of CLAUDE.md 2026-08-31)

- **The Desktop shortcut.** `build/installer.nsh` deleted `$DESKTOP\PaneForge.lnk` on every run:
  `IfFileExists ... 0 +2` skips exactly ONE instruction, and the macro runs from `customInit` AND
  `customUnInstall`. The guard is fixed, but a guard in the installer only covers the installer, so **the app
  puts a missing shortcut back on launch** (`main/winShortcut.ts`, decision in `shared/winShortcut.ts`). It
  never rewrites one that is there, and never claims the Desktop from a `npm run try` copy.
- **The login entry.** `setLoginItemSettings` was only called when the SETTING changed, so the HKCU Run value
  was written once and never checked. Re-applied from config on every launch, and only when it disagrees.

Both logged to `updater.log` (`windows ...`). `npm run test:winshortcut`.

## The Windows dev channel picks its own release (full rules, moved out of CLAUDE.md 2026-08-31)

`GET /repos/robertiuoras/PaneForge/releases` answers **200 with an empty array** (anonymously AND with the gh
CLI token) while `gh release list` lists everything, so electron-updater's dev channel gets `undefined` and
throws. And when the list does answer, the newest release is often one this platform cannot install, and
nothing in its loop looks at the release BELOW the newest. `pickRelease` cannot be reused — it reads the same
broken list.

So the dev channel stops asking GitHub's API to choose: tags come from `gh release list`, each is asked
directly whether it carries a `latest.yml` (one public download request, no token, no API), and the feed is
pinned to the first that does with the **generic** provider. There is then no list to be empty and no
prerelease flag to interpret, so `allowPrerelease` is stood down under a live pin. Every failure leaves the
feed exactly as it was. `PF_NO_WIN_PIN` exists only so `test:blindlist` stays about the blind list.
`npm run test:winfeed`.

## Why the app quit (full rules, moved out of CLAUDE.md 2026-08-31)

Electron never says what triggered a quit. Every path that quits on purpose names itself — `quitting(...)` in
`main/index.ts`, from the single-instance loser, the unopened test copy, the handoff receiver, the idle clock,
an update install and the admin relaunch — and `before-quit` writes that name to `updater.log` with the pane
count. A quit that leaves it empty logs `nothing in the app asked`.

A signal cannot be caught (Chromium takes SIGTERM below the JS layer), but the unnamed cases are told apart by
**where the screen was**: a Cmd-Q or app-menu Quit can only be typed at a frontmost window, while `pkill`,
`osascript ... quit`, a launchd job and a logout all arrive while somebody is looking elsewhere.
`shared/quitWords.ts` turns the last focus into that sentence. It is evidence and never a verdict — the useful
half is the negative, "this did NOT come from this keyboard". `FROM_KEYBOARD_MS` is a generous 4s because
Cmd-Q blurs the window a beat before `before-quit` runs. `npm run test:quitwords`.

## Gotchas that look like mistakes (full rules, moved out of CLAUDE.md 2026-08-31)

- `package.json` `description` is the bare word "PaneForge" — electron-builder writes it into the exe's
  FileDescription, which is the name Windows Task Manager shows.
- `package.json` `name` stays `claude-orchestrator` — Electron builds `%APPDATA%\<name>` from it.
- The icon is **generated**: `node scripts/make-icon.mjs` writes `icon.png` / `icon.svg` and `build/icon.png`,
  so the `.ico` and `.icns` need no configuration. Do not check in a blob — there is no ImageMagick and no
  sharp on this machine. `--size N --out path` renders any single size.
- `git status` for the pane badges must stay async (`execFile`, never `spawnSync`) — a blocked main process is
  the Windows busy cursor.
- `.github/workflows/` edits need `workflow` scope on the gh token
  (`gh auth refresh -h github.com -s workflow`); without it the push is rejected after `lane.mjs` has already
  tagged the release.

## Checking a layout change without screenshots (full rules, moved out of CLAUDE.md 2026-08-31)

```
npm run build                    # --keep SKIPS the build; without this you measure the last one
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const r=document.querySelector('.dialog').getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

A probe answering exactly what it answered before your edit is the tell that nothing was rebuilt. The port is
per checkout — a second lane probes with `PF_PORT=9334` and launches with the matching flag.
`--height`/`--width` drive Chromium's device metrics override and put the size back afterwards. The expression
is evaluated in the renderer with `awaitPromise`, so an async arrow that clicks through a dialog and then
measures works as one argument. `window.__pf[sessionId]` gives a pane's live `term` and `fit`.

## An iPhone is not a Mac, and a phone control is 44px (full rules, moved out of CLAUDE.md 2026-08-31)

`npm run test:phonetouch`.

- **`navigator.userAgent.includes('Mac')` is TRUE on an iPhone** — iOS says `(iPhone; CPU iPhone OS 18_5 like
  Mac OS X)` and an iPad says `(Macintosh; ...)` outright, so every shortcut this app prints went out as `⌘ T`
  to a device with no ⌘ key. `isMac` refuses an iOS agent AND a touch device with no fine pointer; the hints
  are hidden on a handheld outright.
- **The coarse block had only ever been written for a PANE**, and on a handset the sessions list is the home
  screen: 31 controls under 44px there, plus all three of the pane screen's own. Now 1 and 0 — the survivor is
  a row's close at 40x40, chosen deliberately. Nothing a pointer sees changed.
- **Two specificity ties decided it, which is why the test reads the BUILT stylesheet.** `html.handheld
  .pt-more` (0,2,0) loses to the header's own later `.pane-title .icon` (0,2,0). And `.icon.help` carries its
  own `min-width` at equal specificity and later ON PURPOSE, to keep the two brand buttons the same size, so
  it has to be named separately.

## A countdown armed after its own deadline

The card publishes a deadline (`idleCloseAt`) and clamps an overdue pane to `now`, so it
reads `closes now` rather than counting up from zero. The sweep that closes it ran on a
sixty second timer and picked only panes ALREADY past that deadline, and arming set a
fresh fifteen seconds. On screen: `closes now` for up to a minute, then the number jumped
UP to 0:15 and counted down. Robert, 2026-08-31: "it was stuck on closes now then the
timer went back to 0:10 then did the countdown its weird".

So the countdown is now the last seconds of the clock it belongs to. `idleClosePlan` takes
a `lead` (the sweep passes `CLOSE_COUNTDOWN_MS`), the sweep runs every 5s so the lead is
actually landed in, each planned pane carries its own `dueAt`, and `countdownEnd` in
`shared/mascot.ts` ends the count there. Two exceptions, both about being readable: a
deadline already in the past (nothing had swept yet) gets the full count instead of none,
and one closer than `MIN_COUNTDOWN_MS` is pushed out to it.

`idleMs` is computed from the real `now`, never `now + lead`: a pane picked ten seconds
early has not been quiet ten seconds longer than it has, and that number is what
`reclaim.log` is read back for.

The second half of the same report was "popup doesnt show at 10 sec". The countdown had
two faces: `MoveSoon` (a card, bottom right) drawn only when the mascot was OFF, and the
mascot's own bubble otherwise. The mascot is on by default here and gets parked in a
corner, so the commonest desk got a small bubble beside an animal. `MoveSoon` is now
always drawn and the mascot no longer draws the count at all - it still walks to the pane
and wears `.alert` while one is running.

## A password gets typed on the machine that needs it

Robert's scheduled work runs on the PC so it keeps running while the Mac is asleep. That
was fine until a sweep hit a login wall: the job stops, nothing says so, and the only way
back was RDP into a machine nobody sits at.

The feature is one sentence - a script that cannot type asks for a person, and gets one -
and every decision below follows from wanting it to feel local rather than from wanting a
remote desktop.

**Why CDP and not VNC.** The thing that needs a password is a browser, not a desktop. A
screencast of the page is a fraction of a screen's pixels, it already knows its own size
so nothing is letterboxed, and the input side is `Input.dispatch*` - the same events the
page would have had from a real keyboard, with no OS focus involved. It also means the PC
never shows a window: headless Chrome has no window to show, and the standing rule that no
background job puts a window on that desktop is kept by construction.

**Why an ssh tunnel and not an open port.** Chrome's debugger refuses a request whose Host
header is not loopback or a bare IP, and it binds 127.0.0.1. `-L <free>:127.0.0.1:9333`
keeps both ends on loopback, so nothing on the PC is reconfigured, no firewall rule is
added, and the debugger never reaches an interface. `ExitOnForwardFailure=yes` is what
makes a forward that cannot be made fail loudly instead of sitting there; `BatchMode=yes`
is what stops ssh asking a question nobody will ever see.

**Why the ack is the flow control.** The obvious build - push every frame at the window -
is exactly how a remote desktop becomes a recording: the link goes slow, the frames queue,
and the picture people are looking at is ten seconds old while their typing lands
somewhere they cannot see. Chrome will not send the next screencast frame until the last
is acked, so the ack is a free backpressure valve if it is spent in the right place: after
the renderer has PAINTED, never on receipt. One frame in flight, and a frame that arrives
mid-paint replaces whatever was waiting rather than joining a line behind it. A slow link
therefore loses frame RATE, and the picture is always the present.

That is also why every path out of the paint ends in `loginPainted` - a frame that will
not decode, a canvas that has gone away, a torn JPEG. A view that forgets once goes black
and stays black, and the failure looks exactly like a dead connection.

**Why the ladder is asymmetric.** Stepping down is immediate, because the person is
already looking at a late picture. Stepping up costs twenty consecutive quick frames,
because each change restarts the screencast - a visible hitch - and a link that recovers
for one frame and then does not would spend two hitches buying nothing.

**Where the coordinates are converted.** In main, off the frame metadata, because the
metadata is the only thing that knows the page's real size: the JPEG is whatever the rung
allows and the canvas is whatever the pane is, and neither is the page. The renderer sends
the point on its own canvas and the canvas size. That also means a phone watching the same
view would get the same answer without the metadata being mirrored across the wire.

**The one dependency.** Electron 33's main process is Node 20, which has no global
`WebSocket` - it typechecked, built, and failed at runtime with `WebSocket is not defined`
on the first real connection, which is the whole reason the dev-window proof is a required
step and not a formality. `ws` was added for it.

**What stays behind.** Closing the view stops the screencast and kills the ssh child.
Chrome and the tab stay up on the far machine: the signed-in session is the entire
deliverable, and tidying it away would undo the work the person just did.

## ui-lab

**The trap the five suites shared.** `view-test.mjs`, `contrast-test.mjs`,
`ask-render-test.mjs`, `ask-click-test.mjs`, `renderwatch-live.mjs` and `probe.mjs` each
carried their own ~25-line raw-WebSocket CDP block - find the debuggable page on
`/json/list`, skip the `shelf` page, assert the URL is this checkout's own build, open the
socket, evaluate by id with a pending-request map. Six copies of the same plumbing, drifting
independently every time one of them fixed a bug the other five still had. `scripts/ui-lab.mjs`
is that block written once (`page`, `connect`, the `Link` class), plus the pieces that had
also been re-derived more than once: `contrast-test.mjs`'s hand-written PNG decoder (no
dependency, since a CDP screenshot is a PNG and node already carries `zlib.inflateSync`), and
the fire-twice-keep-second screenshot dance every suite needed for the same reason.

**Why headless, not minimized.** `--minimized` (`src/main/profile.ts` `revealPlan`) is
"do not put this on my screen" - on darwin that means the window is never shown at all, which
is exactly right for not stealing Robert's screen, and exactly wrong for a CDP screenshot:
Chromium only composites frames for a window it has actually painted, so `Page.
captureScreenshot` against a never-shown window is unreliable at best and a single flat
colour at worst (the trap `contrast-test.mjs`'s own comments already documented). `offscreen:
true` on the `BrowserWindow` (already wired into `src/main/index.ts` from the contract commit,
`webPreferences: { offscreen: headlessMode() }`) tells Chromium to keep compositing into a
bitmap regardless of whether the window is shown, so a `--headless` copy gets both: nothing on
any screen, AND real pixels back from CDP.

**The measurement that mattered.** The obvious way to prove "nothing is shown" from inside the
page is `document.visibilityState` / `document.hidden` - and it is wrong for an offscreen
window. Measured directly: `{ state: 'visible', hidden: false }` for a `--headless` copy that
never called `win.show()` and was constructed with `show: false`. Chromium's Page Visibility
API tracks whether the renderer is being shown to a user in the ordinary sense, not whether an
offscreen-composited window happens to also be mapped to a screen - the two are different
questions for this one build flag. The real answer already existed: `app:visibleNow`
(`win.isVisible()` in main, wired at `src/main/index.ts:3282` for the focus/idle logic, exposed
as `window.api.appVisibleNow()`). `ui-lab-test.mjs` asserts that one, not the DOM API, and says
why in its own comment so the next person doesn't rediscover this by hand.

**The control that didn't reproduce.** The obvious way to prove the pixel test is
red-capable is to run the identical screenshot assertion against a plain `--minimized` launch
and confirm it comes back blank - on darwin, `revealPlan('minimized')` is `'hidden'` too, the
same as headless, just without `offscreen: true`. Measured on this machine: it did NOT come
back blank (3922 distinct colours, same order of magnitude as the headless shot's 3565).
Rather than gate on a number that isn't reliably reproducing the bug it is meant to catch, the
control is logged as `info` with the reasoning in the comment, not asserted - a desk that has
already forced a paint on that window once (another app raising it, a previous `--show` launch,
anything that gave Chromium a reason to composite before the minimize) may simply not exhibit
the blank-frame trap today. Tightening this back into a hard assertion needs a fresh
measurement on a genuinely idle desk first, not a restored assumption.

**What the refactor found, not broke.** Running the refactored `contrast-test.mjs` for real
against a headless copy surfaced five genuine, pre-existing contrast failures (a "Save" label
and a `.wide-word` span at 2.80:1 and 2.33:1 against their panel in both themes, needing 3:1;
a tour-card sentence at 4.48:1 in the light theme, needing 4.5:1) - not a regression from
moving its CDP plumbing onto `ui-lab.mjs`, but the sweep actually running against real,
reliably-composited pixels for the first time rather than a `--minimized` capture whose
reliability was already in question. Those failures belong to whoever owns `paletteFor` and
the components in question, not to this workstream.
