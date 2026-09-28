# Local plan usage and Codex launch routing, 28 September 2026

## Scope and method

Seven-day window: 21 September about 06:52 UTC through 28 September about 06:52 UTC, with 28 September partial. Read-only Mac and PC collection reused `taskdriver.ai/scripts/cli-usage-push.py` against local Claude and Codex JSONL. It yielded 80,255 Mac and 12,790 PC usage events. The collector avoids symlinked Claude project directories and reports uncached input, cache reads, cache writes, output and Codex reasoning separately. Reasoning is a **subset** of output, not another additive category. Claude thinking is not reliably separable by effort. Daily figures are UTC and approximate because collector cutoff and live writes vary. No paid API bill is inferred from these token counts.

| Provider and machine | Uncached input | Cache read | Cache write | Output | Reasoning subset |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude, Mac | 0.92M | 10.34B | 165.0M | 45.82M | 17.85M |
| Claude, PC | 0.04M | 1.19B | 73.18M | 8.63M | 2.05M |
| Codex, Mac | 50.69M | 1.03B | 0 | 5.54M | 1.53M |
| Codex, PC | 3.06M | 53.23M | 0 | 0.31M | 0.09M |

Mac Claude Opus 5.5 accounts for 43.56M of 45.82M Mac Claude output in the window. PC usage differs: Opus 5.5 output is 3.76M and Sonnet 5 output is 3.97M. Mac Codex had 3,021 Astra/high events (0.90M output), 926 Astra/xhigh events (0.45M output), 3,299 Astra/medium events (1.05M output), and 5,599 GPT-5.6 Sol/medium events (1.77M output). These are event and token totals, not counts of user tasks or proven waste.

Selected daily output (both machines, millions of tokens):

| UTC day | Claude | Codex |
| --- | ---: | ---: |
| 24 Sep | 15.14 | 1.03 |
| 25 Sep | 5.87 | 0.05 |
| 26 Sep | 5.36 | 0.09 |
| 27 Sep | 13.49 | 0.32 |
| 28 Sep, partial | 0.62 | 1.03 |

The Mac Claude login's backed-up 26 September 09:52 UTC plan row showed 5% weekly use with reset at 1 October 05:00 UTC. A fresh 28 September 06:58 UTC row shows 80% in the same reset window. This is a measured 75 percentage-point rise. Mac Claude output on 27 September was 11.33M, mostly Opus 5.5 by the seven-day model mix. The collector does not bind each event to a Claude login, so the output cannot be assigned precisely to that plan row. The other Claude login was already at 100% in a 27 September reading and that row is stale now. The primary Codex Pro weekly reading was 27% at 28 September 06:53 UTC, but its latest refresh timed out; its reset window differs from the 26 September backup, so those percentages are not comparable. A second Codex account has a fresh 0% row, but was not used for this task. Antigravity Gemini weekly was 16.66% at 06:58 UTC.

The current visible native Codex pane is `01a0e6b7-8fee-7a10-a88c-c99aeb97101a`, `gpt-6-sol/high`, despite the lower-model handoff. Its first 77 collected usage events had 0.386M uncached input, 4.918M cache read, 0.031M output and 0.009M reasoning output. Four actual user messages appeared in the sampled native rollout, the largest 24,959 characters, with no exact duplicates. A large Mac Codex client session sampled over 9h 39m had 1,338 usage events, 31 actual user messages, 89.65M cache reads, 0.318M output and no exact repeated user text. Two high-volume Mac Claude session samples had respectively 2 and 5 actual text prompts plus 40 and 261 tool-result entries; neither repeated the actual text prompts exactly. Tool-result entries are not user retries. No error event was seen in the sampled current or client Codex rollouts. The available telemetry does not attribute cache volume to a specific fork, resume, repeated instruction, or failed retry, so none of those is established as a leading cause.

## What changed and what it proves

The live `~/.codex/config.toml` had `model=gpt-6-astra` and `model_reasoning_effort=high`; choosing Sol for the current pane did not lower its inherited effort. A backed-up local edit changed the global default **effort** to medium for future raw Codex processes, leaving the strong default model and per-task overrides available. A native `codex exec -m gpt-6-sol -c model_reasoning_effort=medium` smoke returned `ROUTE_SMOKE_OK`; its native `turn_context` recorded Sol/medium and its final answer file contained that response. This verifies the CLI override for a new process. The installed app's `sessions:setEffort` control also returned `ok` for this pane and `effort.log` recorded manual medium at 07:24:57 UTC. That choice is for a future turn boundary; the current turn remains Sol/high until native observation proves otherwise.

PaneForge's existing launch path now classifies an unpinned new Codex prompt before applying saved defaults. Explicit model, manual effort and resume choices retain their route. Unclear short prompts and hard diagnosis/security/architecture signals keep Astra; clear routine prompts start on Sol/medium; explicit small edits/lookups start on Sol/low. The rule uses the existing `classifyEffort`, and `SessionManager.spawn` passes the chosen level as a per-process `-c model_reasoning_effort=...` before the first inference. This is launch-time enforcement in the changed app, whereas existing turn-level model advice remains advisory. The installed PaneForge app has not been replaced by this local lane build, so live installed-app behavior is not claimed. No before/after matched-task quota saving has been measured.

Antigravity CLI authentication used the included Google AI Pro login, Gemini 3.8 Flash low, and returned a real conversation ID. A subsequent bounded public FlutterFlow research call used the same pool, timed out after 75 seconds, returned an empty answer, and reported 130,742 input plus 187,203 cache-read tokens. It produced no source claims to accept. Official FlutterFlow research was independently checked and filed in the research-lab lane. No API overage was enabled or paid fallback used.

## Evidence and limits

- Local inputs: `/tmp/flutterflow-usage-mac-20260928.json`, `/tmp/flutterflow-usage-pc-20260928.json`, `/tmp/flutterflow-codex-native-smoke-20260928.jsonl`, `/tmp/flutterflow-agy-research-20260928.json` (not committed because they contain session identifiers and operational telemetry).
- Native Codex smoke conversation `01a0e6cc-f010-7542-bc63-68d2434e8ed8`, final answer file `/tmp/flutterflow-codex-native-smoke-20260928.txt`.
- Antigravity auth conversation `0d3aeecb-56b2-4da1-b950-7b9bfadaf649`; empty timed-out research conversation `3adf157a-fffa-4fcc-b254-dd75d1fb528b`.
- Subscription percentages are provider windows, not a linear function of local tokens. Local transcripts also omit some hosted/app usage. Savings require matched tasks on the same pool and plan window; none was run.

## Daily rollup and context concentration

The full UTC daily rollup below combines Mac and PC. Inputs and outputs are millions of tokens; reasoning is a subset of output. The seven-day cutoff fell during 21 September, and 28 September was partial.

| Day | Provider | Events | Uncached input | Cache read | Cache write | Output | Reasoning |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 21 Sep | Codex | 4,008 | 11.492 | 259.633 | 0 | 1.432 | 0.405 |
| 22 Sep | Claude | 5,699 | 0.022 | 827.305 | 18.304 | 4.144 | 1.396 |
| 22 Sep | Codex | 6,133 | 14.513 | 399.852 | 0 | 1.876 | 0.512 |
| 23 Sep | Claude | 14,241 | 0.099 | 2,064.129 | 38.802 | 9.823 | 2.876 |
| 23 Sep | Codex | 107 | 0.326 | 5.581 | 0 | 0.026 | 0.012 |
| 24 Sep | Claude | 19,023 | 0.337 | 3,254.920 | 55.430 | 15.142 | 5.970 |
| 24 Sep | Codex | 2,960 | 9.374 | 180.073 | 0 | 1.033 | 0.390 |
| 25 Sep | Claude | 8,810 | 0.106 | 1,335.808 | 37.124 | 5.871 | 2.107 |
| 25 Sep | Codex | 141 | 0.558 | 8.319 | 0 | 0.048 | 0.015 |
| 26 Sep | Claude | 8,553 | 0.322 | 1,061.000 | 36.229 | 5.359 | 1.746 |
| 26 Sep | Codex | 183 | 0.929 | 9.726 | 0 | 0.085 | 0.021 |
| 27 Sep | Claude | 18,690 | 0.060 | 2,852.393 | 49.733 | 13.493 | 5.550 |
| 27 Sep | Codex | 805 | 5.622 | 43.192 | 0 | 0.317 | 0.063 |
| 28 Sep | Claude | 890 | 0.015 | 133.119 | 2.554 | 0.619 | 0.250 |
| 28 Sep | Codex | 2,802 | 10.931 | 173.176 | 0 | 1.026 | 0.202 |

The prior weekly Opus audit used cache-read weight 0.1× in normalized units. The current Taskdriver price table and [Anthropic's Opus 5.5 caching rate](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) use 0.05×. Recomputing the current-window Mac interactive Opus sample gives 2,818 turns and 1,020.7M input-equivalent units. The 356 turns with 41–100 requests carry 380.6M units (37.3%); 88 turns with 101+ requests carry 225.5M (22.1%). Together, 444 long turns account for 59.4%. The 239 turns that started below 150k and ended above 200k context account for 432.9M (42.4%). Median start/end context was about 68k/197k in the 41–100 group and 65k/278k in the 101+ group. These are concentration measures, not subscription percentages or proof that a given request was unnecessary. [Anthropic's cost guidance](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence) describes how agent loops repeatedly send growing histories.

Earlier local research measured about 63k tokens on a first interactive Claude call and about 52k on a headless startup before a prior flag fix reduced one component to 0.5k. MCP tool names measured about 4.5–5k per session. The current Sol/high pane sampled 167 tool outputs and 1.33M serialized characters; 50 outputs over 10k characters held 1.11M. Some outputs were needed. Bounded native samples showed no exact repeated user prompts in the largest sampled sessions, and did not establish retry loops, polling or copied forks as leading causes.

## Bounded route comparison and proof limits

Eight included-plan CLI runs paired Astra/high against Sol/low on four identical synthetic tasks. Native `turn_context` confirmed each actual model and effort. Both routes passed all four task checks, including `node test.mjs` for the edit and diagnosis. Lookup and summary final answers were correct on both routes. For both code tasks, the final post-turn `-o` artifact was a sandbox-denied knowledge-checkpoint message rather than the requested task report; complete-output acceptance was 2/4 for each route. This failure was shared across routes and must not be counted as model quality equivalence. It also shows why final artifacts need checking after hooks and bookkeeping.

| Task | Astra/high seconds; input/cache/output | Sol/low seconds; input/cache/output | Result |
| --- | --- | --- | --- |
| Lookup | 14.13; 32,253/0/43 | 13.12; 31,797/0/31 | Both correct |
| Summary | 17.51; 32,243/7,040/134 | 12.63; 31,787/7,040/87 | Both correct |
| Edit | 42.88; 204,105/167,936/619 | 45.12; 226,212/199,040/533 | Both code tests pass; both final reports displaced |
| Diagnosis | 49.77; 208,151/171,136/782 | 45.84; 203,745/167,424/784 | Both code tests pass; both final reports displaced |

The exploratory Sol/low candidate is not the launch rule's Sol/medium for ordinary work. On the edit it used more input and time than Astra/high. Cache states varied, sample size was four pairs, and the final output failure was common. No price or quota saving is claimed. Raw benchmark rollouts and scratch workspaces remain private under `/tmp`.

The shared knowledge-cycle Stop message in JS and Python was corrected after the benchmark exposed answer displacement. Six relevant JS and eleven Python tests passed; a fresh native Sol/low edit replay passed `node test.mjs` and its final `-o` artifact gave the complete task answer with one short checkpoint limitation. The replay used 347,782 input tokens (315,392 cached), 1,179 output tokens and 51.52 seconds, so it proves answer preservation, not a saving. The hook can still add a turn when a checkpoint is required.

The local PaneForge guard passed targeted positive and negative cases and the 283-test full suite. A final queued typecheck is tracked separately. Mac global config is backed up and future raw Codex processes now inherit medium effort; a fresh native CLI smoke verified Sol/medium and its final artifact. The installed PaneForge app was not replaced, and the PC launch guard was not executed. PC Codex config was read-only verified as Sol/medium. These are separate coverage states.
