# Workflow plan: make the agent workflow understandable and measurable

Owner: this session (Mac pane `s33-mtzkru45`, conversation `4bc145da-4875-4634-8d3c-163f9cf97ba2`, checkout `PaneForge-a`, branch `lane-a`). Planning only. Nothing below was executed, installed, scheduled or spent. Sibling session owns product/layout planning.

Inputs read: `START-HERE.md`, `workflow-session.md`, `prompt-audit.md`, `second-brain-audit.md` (all in `PaneForge-b/docs/research/workflow-foundations/`), and the live sources named per row below under `/Users/robertiuoras/Projects/claude-memory/` (abbreviated `CM/`). The instruction-debt F01-F18 record in `assistant-g/docs/operations/instruction-debt-2026-09-13/` was not re-audited.

---

## 1. Canonical workflow map

One row per stage. "Verification" is what proves the stage ran, today. **None** means nothing on disk proves it for a given fire.

| # | Stage | Trigger | Input | Output | Verification today | Source |
|---|---|---|---|---|---|---|
| 1 | Session start (Claude) | `SessionStart` -> `session-start-runner.mjs` | project dir, previous handoff, MEMORY.md (native load) | injected handoff (once, then rotated to `.prev`), promptlab model-age warning, hook-failure report, self-improve pending, ask-ledger unanswered | `hook-timing.log`; handoff rotation file | `CM/claude-config/handoff-inject.sh`, `promptlab-freshness.mjs`, `hook-failures-report.mjs` |
| 2 | Session start (Codex) | `SessionStart` in `~/.codex/hooks.json` | `codex/MEMORY.md` lines 1-220, project index pointer, shared handoff | injected index + pointer + handoff text | none for the cap (silent truncation, second-brain audit P2) | `CM/codex/hooks/memory-inject.sh:35,45,59`, `codex/hooks/handoff.mjs:259` |
| 3 | Ask arrives (Claude) | `UserPromptSubmit` -> `prompt-runner.mjs` | prompt text, `machine-prompt.mjs` says human or headless | promptlib template checklist + missing anchor/evidence/done/fence; promptlab cost probability + rewrite hint; prompt-dejavu repeat flag; workflow-route graph suggestion; playbook-route vault titles | fires logged to `self-improve/promptlib-nudge.log`, `promptlab-nudge` log; **failures log nowhere** (prompt-audit item 3) | `CM/claude-config/promptlib-nudge.mjs`, `promptlab-nudge.mjs`, `prompt-dejavu.mjs`, `workflow-route.mjs`, `playbook-route.mjs` |
| 4 | Ask arrives (Codex) | `UserPromptSubmit` in `hooks.json` | prompt text | prompt-dejavu repeat flag only. No promptlib/promptlab parity. | dejavu log | `CM/codex/hooks/prompt-dejavu.mjs` |
| 5 | Prompt crafted by machine | `promptlab craft` / `improve` (manual or `pf open --prompt` paths); `promptForge.ts` in PaneForge for split/resume/task briefs | rough intent, promptlib exemplars (`CM/claude-config/promptlib/examples`, 3 files) | prompt with `Done means:` block, craft log row keyed `kind:intent` | `craft.test.py`, `outcome-join.test.mjs`; **no per-run id**, proxy can regress unflagged (prompt-audit items 1-2) | `CM/claude-config/promptlab/craft.py:513-626`, `craft-outcome.mjs:68-103`, `PaneForge/src/shared/promptForge.ts` |
| 6 | Retrieval (second brain) | manual: `recall` skill routing, `vaultindex.py` CLI, `rg` over project indexes; automatic only for department playbooks (`playbook-route`) | query, `--project` scope | cited bounded package + local receipt (timestamp, mode, count, refs) | receipt lacks provider/session/task id and `used_refs` (second-brain audit gap 2) | `CM/claude-config/vault-index/vaultindex.py:595,767`, `skills/recall/SKILL.md`, `playbook-route.mjs` |
| 7 | During work | `PreToolUse`/`PostToolUse` runners (registry `tool-hooks.mac.json`) | tool call / result | command-lessons deny/warn, error-lessons fix injection, measure-first, context-budget, run-guard, lane guard, fable-guard | `hook-timing.log`, `hook-failures.jsonl` (rc != 0 only) | `CM/claude-config/tool-runner-lib.mjs`, `command-lessons.tsv`, `error-lessons.tsv` |
| 8 | Turn end | `Stop` -> `stop-runner.mjs` (Claude); `handoff.mjs checkpoint` (Codex) | transcript tail, edited files | verify-gate / next-steps-gate / lesson-gate blocks; autoclear ask; workflow-route stop block | gate logs under `self-improve/` | `CM/claude-config/verify-gate.mjs`, `next-steps-gate.mjs`, `lesson-gate.mjs`, `autoclear.mjs` |
| 9 | Context rollover | `PreCompact` -> `handoff-on-compact.sh`; autoclear past context line -> handoff -> `/clear` -> `queuePrompt` resume brief | context size, `## Next steps` | `session-handoff.md`, fresh session re-prompted (`resumeBrief` via promptForge) | `npm run test:autoclear`, `test:handoffsteps` in PaneForge; `autoclear-app.log` `UNSENT` | `CM/claude-config/autoclear.mjs`, `PaneForge/src/shared/autoclear.ts` |
| 10 | Outcome and learning | nightly `self-improve.mjs` (03:20), `promptlab outcome`, `craft-outcome.mjs`, `promptlib harvest.mjs`, `promptlab research` (daily, runs on Codex) | fire logs joined to transcripts | pending proposals, outcome table, harvested exemplars (0 of 215 qualify), research proposals | research run **failed** on Codex usage limit and stayed failed (`promptlab/research/pending.md`) | `CM/claude-config/promptlab/outcome.mjs`, `promptlib/harvest.mjs`, `promptlab/research/pending.md` |
| 11 | Usage and cost | `codex-usage.mjs` (freshest rollout `rate_limits`), `usage-notify.py` (Claude 5h + weekly + per-model, launchd 10 min), `model-spend.mjs`, `session-efficiency.mjs`, `token-audit.mjs` | rollouts, Claude usage endpoint, transcripts | percent used, $/session estimates, context curve, batch ratio | `codex-usage.mjs` marks STALE by age; no burn-rate history mode | `CM/claude-config/codex-usage.mjs`, `usage-notify.py`, `session-efficiency.mjs` |

Where the chain breaks, in order of cost: stage 3/4 fire silently on failure; stage 5 cannot attribute an outcome to one craft; stage 6 has no provider/session receipt so "retrieved" never becomes "used"; stage 10's research loop spends the Codex weekly window and dies at the limit.

---

## 2. Prompt versus goal

**A prompt** is one turn's instruction. Its complete shape is already defined and enforced: task, anchor (which thing), evidence (what was seen), done (acceptance), fence (scope), plus exemplars, with `Done means:` last (`promptForge.ts`, promptlib `patterns/description.md`). It ends when the turn ends.

**A goal** is a durable outcome that outlives turns, sessions and providers. It carries what a prompt cannot: who may authorise it, when to stop, what evidence proves it, and what to do when a step fails. Claude Code has a native `/goal`: it installs a Stop-hook condition that re-injects `goal_status {met:false}` every turn end and blocks stopping; verified 2026-09-12 that an unmeetable condition burns 9 blocked turn ends (~74 s) then pauses, resumes on the next message, and is only cleared with `/goal clear` (typed from outside via `pane-type.mjs`). So a native goal is an **execution loop**, safe only when the condition is machine-checkable and within the session's own authority. The three files named "goal" in `claude-memory` (`shared/applied-ai-systems-specialist-goal.md`, `toolstash/user-automation-goal.md`, `assistant/goal-hook-never-closes-on-authorization.md`) are identity memories and a lesson, not executable goals. There is no goal library today.

Reusable goal brief fields: **outcome** (state of the world), **scope** (files/stores touched), **authority** (what is pre-approved, what stays Robert's), **acceptance** (machine-checkable), **evidence** (artifact paths a fresh agent can open), **recovery** (what to do on a failed step), **stop** (when to end without success). Rule: a goal whose acceptance needs Robert's action is a saved brief, never an active `/goal`.

### Grounded examples

**G1. Every prompt hook leaves a receipt, success or failure.**
- Outcome: `promptlib-nudge.mjs` and `promptlab-nudge.mjs` append one redacted line per fire and per internal failure to a machine-local JSONL, carrying hook, stage, error class, config digest, session id.
- Scope: those two files, one shared helper, their tests. No settings.json change.
- Authority: reversible config code; pre-approved as "safe prompt/config repair" once Robert says go. Not this session.
- Acceptance: four simulated failures (missing `model.json`, import error, malformed stdin, unwritable log) each yield exactly one receipt and zero injected context; success fires carry `digest`; repeat failure within 10 min yields no second line.
- Evidence: test output; receipt file with the 4 rows; `git log -1` of the commit.
- Recovery: `git revert` the commit; hooks already fail open.
- Stop: if a receipt write itself throws, swallow once and exit 0 (never block a prompt).

**G2. A craft is attributable to exactly one pane.**
- Outcome: each `promptlab craft` run has a random `craft_run_id` written to base record and `opened` event; `--open` persists pane/session id; manual paste reports `unattributed text match`.
- Scope: `craft.py`, `craft-outcome.mjs`, `outcome-join.test.mjs`.
- Authority: same as G1.
- Acceptance: fixture with two identical drafts, one opened, leaves the unopened craft unverified; existing 25 promptlib checks and outcome-join stay green.
- Evidence: test run; one real craft `--open` row showing the pane id.
- Recovery: revert; old rows keep the old key and the join reads both shapes.
- Stop: if `pf list` cannot name the pane at `--open`, record `pane: unknown`, never guess.

**G3. Second-brain retrieval is proved across providers, not assumed.**
- Outcome: one synthetic canary note yields measured configured -> injected -> retrieved -> used rates for Claude and Codex (section 3).
- Scope: one new non-client note under `claude-memory/shared/`, one receipt schema file, one results table. No hook edits.
- Authority: needs Robert's word to start fresh sessions (the brief forbids new workers here). Uses included plans only; 8 short one-shot runs.
- Acceptance: a results table with 8 rows, each naming provider, condition, retrieved (y/n), cited (y/n), applied (y/n).
- Evidence: the table plus the eight transcript/rollout paths.
- Recovery: a run that opens no session is re-run once; a canary that leaks into a client index aborts the goal.
- Stop: after 8 runs or the first leak.

**G4. The Codex weekly window has a burn-rate reading.**
- Outcome: `codex-usage.mjs --history` prints (time, used_percent) across rollouts, percent per active hour, and the top-of-hour sessions consuming it.
- Scope: `codex-usage.mjs` and its test.
- Authority: read-only over `~/.codex/sessions`; reversible.
- Acceptance: run over 2026-09-13 reproduces 0% at 01:09Z -> 38% at 08:00Z.
- Evidence: `workflow-usage-evidence.md` beside this plan (already extracted by hand).
- Recovery/stop: none needed; read-only.

---

## 3. Memory use: five states and a bounded cross-provider test

| State | Meaning | Where it stands (from second-brain audit, sources re-checked) |
|---|---|---|
| Configured | a hook or instruction points at the store | Claude and Codex both: yes (`memory-inject.sh`, `AGENTS.md`, `recall` skill) |
| Injected | text reaches the session | handoff yes both providers; Codex index yes but capped at 220 lines with no marker |
| Retrieved | a query returns cited refs | only when the vault CLI or `rg` is invoked by the agent; automatic only for playbooks |
| Applied (used) | the answer cites and acts on a ref | no receipt field exists; unmeasured |
| Verified | a controlled current run proves it | never run |

**Bounded test (do not run in this session).**
1. Write `claude-memory/shared/canary-2026-09-13.md`, frontmatter `sensitivity: public`, body: one invented fact with a stable handle (e.g. "the canary ratio for project X is 417") and a dated correction paragraph below the first 600 characters ("superseded: 418") to also exercise audit gap 4.
2. Rebuild the vault index (existing `vaultindex.py build`), confirm the note is reachable without `--project` and the restricted-note test still passes.
3. Matrix: provider {Claude, Codex} x condition {normal startup, "retrieve from the second brain and cite"} x repeat {1,2} = 8 one-shot runs in a scratch folder, prompt: "What is the canary ratio for project X? Cite the note path you used."
4. Receipt schema (append-only JSONL, outside note bodies): `provider, session_or_rollout_id, task_id, condition, retrieval_mode, policy_version, source_refs[], used_refs[], answered_value, cited_correction (y/n)`.
5. Score: retrieved = the note path appears in a tool call; used = answer says 418 and cites the path; correction-visible = the superseded value was not returned.
6. Delete the canary and rebuild the index afterwards.

Success threshold is not preset; the first run establishes the baseline. Any leak of the canary into a client-scoped index stops the test.

---

## 4. What Robert's "60% Codex" is, and what to measure

**Established from the rollouts (`workflow-usage-evidence.md`):** Codex reports one limit for this account: `plan_type: pro`, `primary.window_minutes: 10080` (7 days), `secondary: null` in every 2026-09 reading. So the percentage Codex shows in `/status`, and the one Robert reports, is the **weekly** window. Readings today: 0% at 01:09Z, 3% at 02:00Z, 20% at 04:00Z, 38% at 08:00Z, 41% at 08:48Z. That is ~5.4 points per hour while active, so "60% after about a day" is consistent with roughly 11 active hours in the weekly window that opened 2026-09-12T08:26Z and resets 2026-09-19T08:26Z. The `promptlab research` job hit the hard limit in a previous window ("try again at Sep 15th, 2026 1:24 PM") and the run stayed failed.

**Not established:** which sessions consumed the points. The hourly table is one reading per hour picked from a continuous stream (rollouts write `rate_limits` on every server reply); no rollout starts on the hour and no launchd job names codex, so there is no evidence of a scheduled hourly Codex job. Attribution needs G4. There is no 5-hour reading for this plan, so a "5h block" interpretation is ruled out by the data, not assumed.

**Measurements to add (each read-only over existing files):**
- Repeated context: per turn, `cache_read_input_tokens / (input + cache_read + cache_creation)` from Claude transcripts (`session-efficiency.mjs` already parses these); report median and the sum re-read per session.
- Output: `output_tokens` per turn and the share in messages carrying no tool call (already a `session-efficiency` number; surface it per project per day).
- Cache: `cache_creation` spikes after a model switch or `/clear`; count them and their token size.
- Retries: `PostToolUseFailure` fires, `error-lessons` matches, Codex `turn.failed` rows per day.
- Worker overhead: tokens on `isSidechain` rows per session divided by main-thread tokens; count of Agent/Task calls.
- Codex burn: G4's `--history`, attributing each hourly delta to the rollouts active in that hour.
No token saving is claimed anywhere in this plan; none was measured.

---

## 5. Defects, prioritised by evidence and value

| P | Id | Defect | Evidence | Repair task (small) | Test |
|---|---|---|---|---|---|
| 1 | D1 | Prompt hooks fail silently | `promptlib-nudge.mjs:165-233`, `promptlab-nudge.mjs:76-160`; sparse outcome data indistinguishable from broken hook | G1 | 4 simulated failures -> 4 receipts, 0 injections |
| 1 | D2 | Craft receipts not unique | `craft.py:567-616`, `craft-outcome.mjs:68-103` | G2 | two identical drafts fixture |
| 1 | D3 | Research loop spends the Codex weekly window and dies at the limit, then the library is unverified | `promptlab/research/pending.md`; hourly top-of-hour rollouts | Gate the job on `codex-usage.mjs --quiet` under a threshold, or move it to the Claude included plan. Scheduler change: **Robert's call**, proposal only | dry run with a forced 95% reading exits without calling Codex |
| 2 | D4 | Clean craft can raise cost proxy | `craft.py:513-548` | keep both scores, status `improved/unchanged/regressed-proxy`, return lower-risk draft | mocked two-round craft, three cases |
| 2 | D5 | Codex index cut at line 220 with no marker | `memory-inject.sh:35` | emit `[index truncated at 220 of N lines; search codex/MEMORY.md for the rest]` | canary below line 220 |
| 2 | D6 | Context package drops a later correction | `vaultindex.py:767` | append a `correction below excerpt` flag when the body matches `superseded|correction|update 20` past the cut | fixture in `test_vaultindex.py` |
| 2 | D7 | Promptlib has 3 example files and harvest qualifies 0 of 215 | `promptlib/examples`, `harvest.mjs` | after D2, auto-append an example from every craft row that `craft-outcome` marks verified | harvest fixture with one verified row |
| 3 | D8 | Codex usage has no history | `codex-usage.mjs` | G4 | replays 2026-09-13 series |
| 3 | D9 | Codex has no promptlib/promptlab parity at prompt time | `~/.codex/hooks.json` UserPromptSubmit runs dejavu only | port `promptlib-nudge` decide() behind Codex's hook shape; measure fire rate first | replay over 250 rollouts, same 25% ceiling |

Not listed on purpose: F01-F18 and provider-handoff metadata (already evidenced), promptlab freshness (already a SessionStart warning), and anything needing a new runtime, scheduler, credential or spend.

---

## 6. First implementation goal, fresh-agent ready

**Goal:** D1 / G1. Prompt hooks leave a receipt on failure and a digest on success.

**Preconditions (assert, do not hope):**
- `git -C /Users/robertiuoras/Projects/claude-memory pull --ff-only` succeeds and `git status --porcelain` shows nothing under `claude-config/promptlib-nudge.mjs`, `claude-config/promptlab-nudge.mjs`.
- `node claude-config/promptlib/promptlib.test.mjs` and `node claude-config/promptlab-nudge.test.mjs` are green before any edit (record the counts).
- Robert has said "go" for this repair in the session that runs it; this plan is not that authority.

**File ownership:** `claude-config/promptlib-nudge.mjs`, `claude-config/promptlab-nudge.mjs`, new `claude-config/hook-receipt.mjs` (+ `hook-receipt.test.mjs`), additions to the two existing tests. Nothing else. No `settings.json`, no `tool-hooks.*.json`, no skills, so no `surfaces/build.mjs` run.

**Design constraints:** receipt file `~/.claude/nudge-receipts.jsonl` (machine-local, never git-synced, same convention as `hook-failures.jsonl`); fields `ts, hook, stage, ok, errorClass, digest, sessionId`; redact with the same `SECRET_PATTERNS` as `prompt-dejavu.mjs`; one failure line per hook per 10 min; write failure of the receipt itself is swallowed; exit code stays 0.

**Acceptance:** the four simulated failures each produce exactly one line and no `additionalContext`; a fifth identical failure inside 10 min produces none; a success fire carries a digest that changes when a template file changes; all pre-existing checks still pass.

**Evidence to leave:** test output pasted in the commit body, `tail -5 ~/.claude/nudge-receipts.jsonl` after one real prompt, commit sha.

**Recovery:** `git revert <sha>`; both hooks are already fail-open, so a broken receipt path cannot block a prompt.

Estimated size: one session, two files plus a helper, under 200 lines.

---

## Saved goal brief (not an active /goal)

Native `/goal` exists but was not registered for this session: the planning acceptance is satisfied by this session's own writes, and the 2026-09-12 lesson shows a native goal is a Stop-hook loop with a pause cap, not a record. This section is the saved brief.

- Outcome: `workflow-plan.md`, `workflow-usage-evidence.md`, `workflow-session-receipt.json` exist in `PaneForge-a/docs/research/workflow-foundations/` and are committed to `lane-a`.
- Scope: those three files. No edits under `claude-memory`, no new sessions, no scheduler or auth change, no spend.
- Authority: Robert's explicit request for this planning session.
- Acceptance: the six numbered sections above, each with a source path; receipt `status: complete`.
- Evidence: this file; the evidence extract; `git log -1 lane-a`.
- Recovery: none needed. Stop: on commit.

## Unresolved decisions (Robert's)

1. D3: gate the daily `promptlab research` Codex job on remaining weekly quota, move it to the Claude plan, or leave it. Until decided the technique library stays unverified.
2. Whether G3's eight fresh one-shot sessions may run (the brief forbids new workers here).
3. Whether D9 (Codex prompt-time parity) is wanted at all, given Codex is used for background builds where the nudges have no reader.
