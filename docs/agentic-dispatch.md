# Dispatch: the app picks the agent, and the fix happens without me

**Status: plan. Nothing here is built.** `docs/agentic.md` is the sibling document — that
one is about PaneForge *driving a lane* (I1–I4, built: headless run, gate, supervisor,
goal queue). This one is about the step before it: **deciding that a small ask should be
done at all, by which CLI, on which model, at what effort — and reporting back where the
ask came from.**

The ask that produced it: *"PaneForge needs a really lightweight, free but good agent to
fix this for me. Maybe Sonnet automatically gets assigned. Maybe it needs a decision-maker
algo to decide model and effort. Easiest is PaneForge inputs the prompt and starts a
session so I can watch it, then it removes itself and posts to the Discord channel where
the prompt was — for a day — what it did and whether it worked."*

Read `docs/agentic.md` first. Every rule there still holds, in particular: **it produces a
branch and a diff and merges nothing**, and a run that changed nothing is a failure.

---

## D0. What already exists, so this is smaller than it sounds

| Piece | Where | What it already does |
|---|---|---|
| Headless runs | `shared/agentic.ts`, `main/agentRun.ts` | starts a CLI with permissions off, parses `stream-json`, budget timer, kills on overrun |
| The gate | `main/agentGate.ts` | diffstat → typecheck → suite → reviewer, cheapest first, fails **closed** |
| Supervisor | `main/supervisor.ts` | three lanes at a time, two retries, one throw cannot take the run with it |
| Goal queue | `main/goals.ts` | outlives the window, one at a time, `interrupted` on a restart, never re-run by itself |
| Prompt archive | `main/promptArchive.ts` | every submitted prompt, keyed by `shared/promptKey.ts`, with an `outcome` column already stamped by the queue |
| Discord archive | outside this repo — the bot, `prompt_log` in Supabase | holds `discord_channel_id` for every prompt that arrived from a channel |

So the missing parts are: **the router**, **the watchable run**, and **the report**.

---

## D1. The router is arithmetic, not a model call

A model call to decide which model to call is the wrong shape: it costs the thing it is
trying to save, it is slower than the decision it makes, and it cannot be tested. The
router is a pure function in `shared/dispatch.ts`, and it is unit-tested like
`shared/place.ts` is — a table of asks in, a table of decisions out.

```ts
route(ask: {
  text: string
  files: string[]        // paths the ask names, resolved against the repo
  repo: { hasTests: boolean; hasTypecheck: boolean; sizeLines: number }
  history: { sameAskBefore: boolean; lastAttemptFailed: boolean }
}): Plan

interface Plan {
  agent: 'claude' | 'codex' | 'gemini' | 'qwen'
  model: string
  effort: 'low' | 'medium' | 'high'
  budgetMs: number
  gate: ('diff' | 'typecheck' | 'suite' | 'review')[]
  watch: boolean          // open a pane, or run it out of sight
}
```

The signals, in the order they decide anything:

1. **How many files the ask names.** Zero named files is the strongest signal of a *big*
   ask, not a small one — it means nobody has located the work yet. One named file with a
   quoted symbol or error string is the small one.
2. **Whether the repo can check itself.** A repo with no typecheck and no `test` script
   cannot prove a cheap model's work, so the cheap tier is not available there — the money
   saved is spent on a person reading the diff. (`agentGate` already reports a missing step
   as *skipped*; a plan that counts on a step which will be skipped is a plan that has no
   gate at all.)
3. **Whether this ask has been tried before.** `promptKey` already answers it. A second
   attempt never gets the tier the first one failed on.
4. **Words that name a whole-repo change** (rename, migrate, upgrade, "everywhere", "all
   the") — never the cheap tier, whatever the file count says.

Tiers, cheapest first. The names are what `HEADLESS` already knows how to start:

| Tier | When | Agent / model | Effort | Budget | Gate |
|---|---|---|---|---|---|
| **A** | one named file, ≤ 40 lines expected, repo has typecheck **and** suite | `claude` / Sonnet | low | 6 min | diff, typecheck, suite |
| **B** | 2–4 files, or no suite, or tier A failed | `claude` / Sonnet | high | 15 min | + review |
| **C** | no named file, cross-cutting words, or tier B failed | `claude` / Opus | high | 40 min | all four |

**Escalation is the whole point and it is what makes the cheap tier honest.** Tier A is not
a bet that Sonnet is good enough — it is a bet that the gate can tell. A failed tier A costs
six minutes and a wasted worktree, both free; a tier A that *passed* is a fix that
typechecks and passes the suite, whoever wrote it. Anything the gate cannot check does not
go to tier A at all.

Free-tier CLIs (`gemini`, `qwen`) sit outside this table on purpose. They are in `HEADLESS`
and they work, but they have no reviewer worth failing closed on. Route to them only when
`dispatch.freeFirst` is set in config, and then only for tier A — the gate is what makes
that safe, and it is exactly the tier where the gate is complete.

## D2. The run is a pane, because being watchable is the ask

`docs/agentic.md` decided that a driven lane is a headless CLI whose `stream-json` is
parsed, never a pty scraped by `readsBusy()`. That decision stands for the *gate*. It does
not have to be the only surface.

A dispatched run opens a **real pane** on the lane worktree and types the prompt into it
through `shared/draft.ts` — the same door a person's typing goes through, which means
`promptArchive` records the ask for free, exactly as it does today. What the supervisor
watches is not the pane's text: it watches `diffSince` and the pty exiting, and then runs
the same `agentGate`. So:

- the pane is the window onto the run, not the mechanism, and nothing depends on parsing it;
- Robert can take the pane over mid-run by typing in it — a dispatched run that a person
  interrupts becomes an ordinary pane and is **dropped from the queue**, never fought over;
- there is one code path for what a run *did*: the diff.

**The pane closes itself on success and stays on failure.** A pane that vanished after a
failed run takes the only readable account of the failure with it.

## D3. The report goes back where the ask came from, and expires

The desk does not hold the Discord bot token and must not: it is a laptop that travels, and
the token is in the Render worker with the rest of that wiring. So the report is a POST to
TaskDriver, which already owns both the token and the `prompt_log` row that knows which
channel the ask arrived in:

```
POST /api/dispatch/report
{ promptKey, repo, branch, sha, verdict, filesChanged, insertions, deletions,
  gate: { diff: 'pass', typecheck: 'pass', suite: 'pass', review: 'skipped' },
  minutes, tier }
```

TaskDriver posts one message to that channel and **deletes it after 24 hours**, the same
lifetime the archive already applies to a used prompt. The message says what changed, which
branch to look at, and which gate steps actually ran — a report that says "verified" while
its suite step was skipped is the failure mode `agentGate` was built to avoid, so the
per-step verdicts travel with it rather than being summarised away.

No channel for an ask typed at the desk: the report is then the pane's own line and the
`outcome` already stamped on the archive row.

## D4. What TaskDriver gets later, and what it does not get

A read-only Agents-tab feed: what ran, on which tier, what it cost, what the gate said,
which branch. **Not** a place to start runs — a button on a website that spawns an agent on
this desk needs an inbound path into a laptop, and this repo has spent two features
explaining why that is not free. Starting stays local: the goal dialog and this dispatcher.

## D5. Order of work

1. `shared/dispatch.ts` + `npm run test:dispatch` — the router alone, no runner. A table of
   real asks (Robert's own, from the archive) against expected tiers.
2. Wire it to the existing goal queue: `goal:add` gets a `plan` from `route()` instead of
   the hardcoded agent, and the board shows the tier.
3. The watchable pane (D2) and the self-close.
4. The report endpoint (D3), TaskDriver side first, then the POST.
5. Free-tier routing behind `dispatch.freeFirst`, once 1–4 have run for a week.

## D6. Failure modes this must not have

- **A router that cannot be wrong cheaply.** If tier A is chosen where the gate is
  incomplete, a bad diff reaches a branch with a passing report on it. Hence D1.2.
- **Reporting "it works" from a gate that skipped its suite.** The per-step verdicts are in
  the message, not summarised.
- **A queue that re-runs an interrupted goal.** Already decided in `docs/agentic.md`;
  dispatch inherits it and must not add an automatic retry on top of the two the supervisor
  already does.
- **A pane that closes on failure.** See D2.
- **Escalation without a ceiling.** Three tiers, then it stops and says so. An ask that
  tier C cannot do is an ask for a person, and saying that quickly is the useful answer.
