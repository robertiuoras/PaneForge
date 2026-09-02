# What is worth building next on the agentic side

2026-09-02. Mined from `claude-memory/PaneForge/project_autonomous_task_loop_milestone_2026-08-30.md`
(A1-A7 and what has since been built), `claude-config/backlog.mjs list --class NOW`, and
this repo's own code. The four findings under **PaneForge weekly log review 2026-09-02**
in `machine-todo/MAC.md` are NOT here: lane b fixed all four earlier today
(8a5cc506, 185b6ce7, 9cd9e61f, 4966ec77).

The target the milestone sets is one bounded feature finished with **0-2 human
interventions**. Ranked by compounding effect - observability, persistent task state and
evaluation before local niceties - here is what stands between the app and that.

## Where the ladder actually is

| | | |
|---|---|---|
| A1 persistent task state | **built** | `claude-config/backlog.mjs`, append-only, 52 assertions |
| A2 next-action controller | **built** | `claude-config/next-action.mjs`, arithmetic not a judge |
| A3 generated instructions | **missing** | nothing compiles a brief from a task |
| A4 independent evaluation | **built** | `backlog.mjs done` runs the gates itself |
| A5 repair loop | **built** | a red gate files its own NOW row |
| A6 escalation rules | **missing** | only a QUESTION reaches Robert; a stuck pane never does |
| A7 benchmark | **missing** | interventions per feature has never been measured |

The milestone's own note - "A2 and A3 are worthless before A1 exists" - no longer holds
anything back: A1, A2, A4 and A5 all landed on 2026-08-30. A3 is unblocked, and it is the
named bottleneck: *Robert still writes most prompts by hand.*

---

## NOW

### 1. A pane opened on a task is briefed from the task, not by hand

**Task.** `pf open <cwd> --task <backlog-id>` compiles the pane's prompt out of the
backlog row - what the item is, the gate commands that will judge it, how many attempts
have failed and what the last one said - through `shared/promptForge.ts`, and opens the
pane already carrying it.

**Why.** This is A3, and A3 is the named bottleneck. Everything around it exists:
`next-action.mjs` already answers *which* item, `backlog.mjs done --gate` already answers
*whether it worked*, `queuePrompt` already types a prompt into a pane and confirms the
turn. The only hand-written step left in that loop is the prompt itself, and today it is
`pf open --prompt "<whatever Robert types>"`.

**Success criteria.** `pf open <repo> --task <id>` opens a pane whose first prompt names
the item, carries the gate command as its `Done means:` block, and - on an item with
attempts behind it - carries what the last failure said. An unknown id refuses by name and
opens nothing. No backlog on this machine is a plain refusal, never an empty prompt.

**Scope.** `src/shared/taskBrief.ts` (pure), `src/main/backlogStore.ts` (disk),
`scripts/pf-ctl.mjs` (the flag). No new UI. Nothing writes to the backlog from here -
reading is enough, and a writer would be a second source of truth for A1.

**Business impact.** Removes the last hand-typed step from the one loop that is meant to
run without Robert. Every autonomous pane inherits the definition of done that judges it,
which is also what stops a pane calling itself finished.

### 2. The app counts how often a person had to step in

**Task.** Count, per pane and per session, the times a human unblocked it - answered a
question the app would not answer, typed into a pane mid-turn, or restarted a turn after
it stalled - and put the number where it can be read: the session's info card, and
`interventions.log` for arithmetic afterwards.

**Why.** A7. The milestone's target is a NUMBER (0-2 interventions per feature) and
nothing has ever measured it. Every reading it needs is already taken: `Session.ask`,
`autoAnswer`'s presses, `lastKeyboard`, `runSince`. Without it, "more agentic" is a
feeling; with it, every item on this list can be judged by whether the number moved.

**Success criteria.** A pane that ran a whole turn with no keystrokes and no question
counts 0. A question the app auto-answered counts 0; the same question answered by a
person counts 1. A person typing into a pane mid-turn counts 1. The count survives a
restart, and History carries it beside the session it belongs to.

**Scope.** `src/shared/interventions.ts` (the judgement), `src/main/interventions.ts`
(the tally and the log), one line on `SessionInfo.tsx`. No graph, no dashboard - a number
and a log file. The dashboard is the harness rabbit hole; the number is the measurement.

**Business impact.** The only way to tell whether any of A3/A6 worked. Compounding by
definition: it makes every later claim about autonomy falsifiable.

---

## NEXT

### 3. A6 - a stuck pane reaches Robert, not just a question

`main/askNotify.ts` posts when a pane asks a question. Nothing posts when a pane is
STUCK: three `shared/recover.ts` continuations in a row, a gate red twice on the same
item, a pane whose turn has ended four times with the same error on screen. The decision
belongs in `shared/escalate.ts` beside `autoAnswer.ts` (which already decides the
opposite question), and the transport already exists. Held to NEXT only because it should
be tuned against the A7 number rather than guessed at.

### 4. A pane's turn is graded by the repo, not by the agent

`backlog.mjs done` runs gates for a backlog ITEM. A pane finishing a turn in a repo runs
nothing. A `turnGate` that runs the repo's own `typecheck`/`test` after a turn ends and
draws the answer on the card would make "it says it is done" and "the repo agrees" two
different readings. NEXT rather than NOW because it costs real CPU on every turn end and
wants the A7 number to justify it.

### 5. `pf open --task` reports back

Once (1) exists, the loop is still open at the end: nothing tells the backlog that the
pane finished. A `--report-to` style callback into `backlog.mjs done` closes it. Held
because closing that loop without (2) in place means nobody can tell whether it helped.

---

## LATER

### 6. A task graph, not one split at the start

`splitPlan.ts` plans ONCE. A real decomposition would re-plan when a part turns out to be
two. This is the most tempting item on the list and the one most likely to be
**multi-agent theatre**: four panes that look busy and produce one feature's worth of
work. It stays LATER until a measured A7 number says the one-shot split is what costs the
interventions.

### 7. A dashboard for any of the above

Named here so it can be refused by name. Every number in this document is one log file and
one `awk` away. **Harness rabbit hole.**

---

## Traps named

- **Multi-agent theatre** - item 6, refused above. More panes is not more work.
- **Harness rabbit hole** - item 7, and any version of (2) that becomes a chart.
- **False autonomy** - the failure this whole list exists to avoid: an agent that only
  says "continue". Item 1 is the difference between a brief and a nudge.
- **Activity is not leverage** - (2) is the guard: it counts what a person had to DO, not
  what the app did on its own.
- **Premature infrastructure** - items 3, 4 and 5 are all real, and all held until the
  number from (2) says which one is costing the interventions. YAGNI applies to each.

## Built in this lane

1 and 2, end to end. The rest is written down, not started.
