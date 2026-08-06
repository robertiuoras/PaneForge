# Making PaneForge agentic

Written 2026-08-07, from the question "how can I eventually make PaneForge an agentic app
that can handle my development". This is the plan and the reasoning behind it. `TODO.md`
section I is the same work as checkable items; this file is why each one is shaped the way
it is. Nothing here is built yet — the day a phase lands, its section moves into
`docs/design-notes.md` with the measurements it produced.

## What the word has to mean here

Not "a nicer window around agent sessions" — that is what the app already is, and it is
good at it. Agentic means the app can be given a goal and drive the work itself: plan it,
split it, run several agents in parallel checkouts, verify what they produced, and come
back with something reviewable. The person stays the one who says what counts as correct
and the one who presses merge.

That last sentence is not modesty, it is the finding. Of eleven products surveyed
(Devin, OpenHands, Jules, Cursor background agents, Copilot Agent HQ, Codex cloud, Factory
Droids, Sculptor, Orca, Conductor, Terragon), **every single one stops at a pull request**.
None merges unattended, and the reason shows up in the numbers: top agents score 80–95% on
SWE-bench Verified while real-world PR acceptance by human reviewers on production
codebases is estimated at 35–50% (arXiv 2607.05775, Presenc.ai, 2026). Benchmarks do not
carry a codebase's implicit conventions. Design against the 35–50%.

So the goal is not "no human". It is **no human in the middle** — a person at the start
(the goal) and at the end (the merge), and nothing in between that needs typing.

## What this repo already has

More than half of it, which is why this is worth doing here rather than starting over.

| Piece | Where | State |
|---|---|---|
| Isolation per agent | `scripts/lane.mjs`, `src/main/laneWork.ts:207` | **Done.** Real worktrees, ownership ledger, conflict tracking, auto-merge, release |
| Splitting a mission | `src/main/split.ts:167` `parsePlan`, `:248` `laneBrief` | **Done as a planner.** Produces lane briefs with file ownership; overlapping claims are refused, not repaired |
| Launching N agents | `SwarmDialog.tsx:138` → `sessions:swarm`, `sessions:split` | **Done as a launcher.** Fire and forget: it spawns panes and never looks again |
| Monitoring | `src/shared/fleet.ts:79`, `FleetDialog.tsx` | **Done as a view.** Pure projection over sessions — it can tell you who needs you, and it cannot act |
| Turn detection | `src/shared/busy.ts:81` `readsBusy` | **Works, wrong layer.** Scrapes the CLI's own footer out of the pty buffer |
| Typing into a pane | `sessions.ts:527` `write`, `:975` `queuePrompt` | **Done.** `queuePrompt` is one-shot at launch |
| An unattended agent run with guardrails | `src/main/researchRun.ts:158`, `src/shared/research.ts:74` | **Done, for research.** Wall-clock budget, source caps, injection filtering, dedupe before spending — the shape everything below wants, applied to Q&A rather than code |
| Release once work is verified | `lane.mjs ready` | **Done.** Batching, cooldown, typecheck gate, conflict reporting |

## The five gaps

1. **No await-turn-end.** Nothing bundles "send this prompt, resolve when the turn
   settles". There is `write()` going in and a pty exit coming out, and between them a
   text-scrape.
2. **No main-process-initiated run.** Every `sessions:*` IPC is renderer→main. A loop
   living in main cannot start work.
3. **No result channel.** `promptArchive` stores hashes; `outcome` is null for everything
   this app records. A driver has no way to learn whether a lane's work built, passed, or
   did nothing at all.
4. **Split and Swarm are one-shot.** Nobody polls the lanes they created, retries a failed
   one, or gates the merge on anything.
5. **Guardrails exist only in the research pipeline.** No budget, no kill switch, no
   hotspot-file lock for a loop that edits code.

## Seven decisions

**1. The control channel for driven work is headless, not the pty.**
`claude -p --output-format stream-json` (and the Agent SDK's `query()`) give turn
boundaries, tool calls, token counts and exit reasons as structured events. `readsBusy()`
infers one of those from terminal glyphs and has to be re-taught every time a CLI changes
its footer. Panes keep the pty — that is the product — but a lane the app is driving is a
headless process whose output the app parses. This is the single decision the rest depends
on.

**2. A driven lane produces a branch and a diff, never a merge.**
`lane.mjs ready` stays the human's word. What autonomy buys is that by the time it is
pressed, the work is written, built, tested and reviewed.

**3. The planner is a phase, not a prompt.**
Split already does this and is the right shape: decide the workstreams and who owns which
files BEFORE anything spawns. Parallel fire-and-forget with no coordinator is the failure
every survey names first — agents duplicating each other's decisions because they never
shared one.

**4. Verification is a gate between phases, not a check at the end.**
Factory's validation workers and the self-healing-CI literature agree: a milestone that has
not verified does not unlock the next one. Concretely per lane: typecheck → the repo's own
suite → a reviewer agent with the diff → only then `ready`. A lane that fails a gate goes
back to its own agent with the failure, twice, then stops and says so.

**5. Budget is a scheduler input, not a warning.**
A Max plan has no concurrency cap — it has a 5-hour token window, and 3–5 sustained Sonnet
agents is what Max 5x actually carries. So lanes queue against a token budget the way they
already queue against worktree availability. The research pipeline's `SCHEDULED_BUDGET`
is the precedent.

**6. A silent no-op is a failure, and is detected.**
The dangerous outcome is not a crash, it is a lane that returns cleanly having changed
nothing, or having changed only a comment. Every driven run ends with a diffstat, and an
empty or trivial one is an outcome the supervisor reports, never a pass.

**7. Nothing about this may take the screen, and nothing may block the main process.**
The same two rules the rest of the app lives by. A supervisor loop that pops a dialog when
a lane fails at 3am is a worse product than no supervisor.

## The phases

Each one is usable on its own — no phase is scaffolding for the next.

**I1 — `agentRun.ts`: one headless turn, awaited.** Spawn a CLI headless in a given cwd
with a prompt, parse `stream-json`, resolve with `{ text, toolCalls, tokens, exit, diffstat }`.
Hard wall-clock budget and a kill. Sizes as an M, and it is the whole foundation: gaps 1,
2 and 3 close together. Test: a real run against a throwaway repo, plus a hung stub that
must be killed by its budget — the `test:wedge` pattern, which this repo already trusts.

**I2 — the supervisor: Split's plan, actually driven.** Take the plan `split.ts` already
produces, claim a lane per brief, run I1 in each, poll, and put the result on the Fleet
view. Fleet gains one column: what the lane did. Still no gate — this is "the app finished
the thing it used to only start". M.

**I3 — the gate.** Per lane, after its agent stops: typecheck, the repo's suite, then a
reviewer agent over the diff. Pass → mark ready. Fail → hand the failure back to the same
lane, at most twice. Fail again → the lane says so on the board and stops. S–M on top of
I1, and this is the phase that makes unattended running defensible.

**I4 — the goal queue.** A goal outlives a session: it is written down, it survives a
restart, and it carries its lanes, its attempts and its outcomes. This is also where
`promptArchive`'s null `outcome` finally gets a value, because the app now knows what an
ask turned into. M.

**I5 — the budget scheduler.** Lanes start when there is worktree AND token headroom.
Reads the 5-hour window, spends the cheap model on the cheap phases (planning and review
are not the same job as writing the code), and refuses rather than degrading silently. S.

**I6 — hotspot ownership.** Worktrees stop two agents editing one file at once; they do
not stop two agents both deciding to edit the router. The split plan already claims files
— extend it to a lock across live lanes for the handful of files everything touches, and
order the merges of those deliberately. S, and it pays the first time it fires.

**I7 — unattended mode.** All of the above, plus a hard stop: total token budget, maximum
retries, maximum wall clock, and one switch that stops everything. Overnight, the app takes
a goal off the queue and the morning has branches with diffs, gate results and a plain note
saying what it could not do. S once I1–I6 are in; dangerous before them.

Order: I1 → I2 → I3, then I5 beside I4, then I6, then I7. I3 before I4 deliberately —
a queue of goals that lands unverified work is worse than no queue.

## What this will not become

- **Not a container per agent.** Sculptor and container-use pay a real cost for isolation
  we already get from worktrees; the argument to revisit is if per-worktree dependency
  installs become the bottleneck, which on this machine they are not.
- **Not cloud.** The pitch is the machine on the desk, the checkouts already on it, and the
  agent subscriptions already paid for. The remote link (`src/main/remote/`) is how the
  phone watches it, not where the work moves.
- **Not chat instead of a terminal.** Same reason T3 Code's shape was rejected: driven
  lanes are headless, but a person's pane stays a real pty.
- **Not auto-merge.** See the first section.

## Failure modes to design against, from the survey

- Agents fighting over shared files and dev-server ports — worktrees fix the files, I6
  fixes the hotspots, ports need a per-lane offset.
- Merge-conflict storms — the retry timer and `rerere` already handle the ordinary case;
  what is missing is merging in a deliberate order rather than whoever finishes first.
- Runaway loops from an instruction mismatch — hard budgets, not prompt wording.
- Silent no-ops — decision 6.
- Duplicated implementations across parallel branches — decision 3.
