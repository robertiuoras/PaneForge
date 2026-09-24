# Successor product plan: one assistant, one task model, three layouts to test

Planning session 2026-09-13, requested by Robert (brief: `workflow-foundations/product-session.md`). Decision-ready plan plus comparable prototypes. Nothing here migrates the app, cuts a release, spends API money, contacts anyone or starts a worker. Prototype evidence: `../design/successor-layouts/validation.json`.

## 1. Robert's main tasks across Taskdriver and PaneForge

One shared concept: a **task** is a business commitment with a goal, an owner (a teammate identity), a state, evidence and at most one pending decision. Taskdriver holds the record; PaneForge is where the task is worked and inspected. A task started on the phone is the same task on the desk. No second queue, no second approval record (`taskdriver-paneforge-product-boundary.md`).

| Robert's task | Enters in | Worked in | Decision surfaces in | Shared object |
| --- | --- | --- | --- | --- |
| Qualify an enquiry, draft a proposal | Taskdriver enquiry | PaneForge Chat (Astra + Sales support) | Taskdriver (phone) and PaneForge Work | task `scope` |
| Deliver a client project (brief → assets → proof pack) | Taskdriver project | PaneForge Chat/Work, Code when inspecting | Taskdriver approval before anything leaves | task per deliverable |
| Research a question with sources | Chat or Taskdriver | PaneForge Chat (Research teammate) | Work: accepted brief | task with evidence |
| Weekly business review | Chat | PaneForge Chat over Taskdriver records | Chat, decisions written back to Taskdriver | saved chat linked to tasks |
| Engineering change on a repo | PaneForge Code | PaneForge Code (terminal, diff, tests) | Work: ready to review | task linked to a checkout |
| Sign in to a site for a job on the other machine | `pf needs-login` | PaneForge "needs you" card (live picture removed 2026-09-25) | none | task step, not a task |

Team concept: **Astra** (placeholder name) is the one point of contact. **Persistent teammates** (Research, Sales support, Marketing, Delivery, Engineering) own a responsibility, scoped memory and a results history. **Workers** are execution sessions (a Claude or Codex CLI in a pane, or a headless run) and end when the task step ends. A teammate never equals a running model session; ten identities do not mean ten CLIs.

## 2. Electron improvement versus Tauri + existing React

Both keep React, xterm and the `surface.ts` transport boundary. Neither is a promised fix for the frame/resize defects; those are diagnosed at source first (CLAUDE.md "A pane's two ends open at the same width", `renderWatch.ts`, `main-thread-freeze-sync-write` memory).

| Criterion | Electron 33 (improve in place) | Tauri 2 + React + Node sidecar | Evidence |
| --- | --- | --- | --- |
| Migration cost | Low: separate a durable task engine from the window, keep everything else | High: replace IPC (`ipcTap.ts`), updater, installers, file drops, notifications, window and permission behaviour; keep pty logic in a sidecar | source inspection in `assistant-platform-plan.md` |
| Terminal compatibility | Proven on both OSes today (`@lydell/node-pty`, xterm, Windows console fixes in the repo) | node-pty via sidecar is possible; `portable-pty` unproven for IME, resize, process trees, Windows console | same |
| Rendering engine | Bundled Chromium, same on both OSes | WKWebView on macOS, WebView2 on Windows: two engines to test, no vendor numbers for memory | [Tauri process model](https://v2.tauri.app/concept/process-model/) states "significantly smaller" install, gives no memory figures |
| Resource baseline (today) | Installed app RSS 546 MB over 9 processes at 08:52 (`ps -axo rss`), largest renderer 236 MB, main 126 MB; the session-start pressure hook reported 3.3 GB over 6 processes with a different accounting. Pane count at each reading not recorded. | unmeasured | measure both under the same pane/transcript workload before any decision (gate B1) |
| Failure recovery | `renderWatch` rebuilds a wedged renderer; utility-process watchdog relaunches main; panes return via desk.json | must be rebuilt: crashed webview vs core process, sidecar supervision, session identity across relaunch | CLAUDE.md sections |
| Sleep/wake, remote pairing, phone client | working and pinned by suites | to re-prove | `npm test` suites |

Recommendation: **improve Electron first, keep Tauri as a measured spike, not a plan**. Concretely: (a) move task/session ownership out of the window lifecycle (the engine survives a renderer crash and a window close); (b) run the whole-process baseline with 1/4/8 panes and a 4 MB transcript, idle and busy, on both machines; (c) only then build the Tauri shell spike with one real terminal and the same workload. The spike passes only if it beats Electron on measured memory or responsiveness with no terminal regression. A smaller installer is not a reason to migrate.

## 3. Assistant, teammates, workers, voice

| Thing | Is | Is not | Costs when idle |
| --- | --- | --- | --- |
| Personal assistant (Astra) | one conversation partner, routes to teammates, holds project context | a model, a brand, a department | nothing |
| Persistent teammate | identity + responsibility + scoped memory + routines + results | a running process | disk only |
| Execution worker | a CLI session or headless run on a device, in a checkout | a person you talk to | RAM/CPU while running; ~190 MB per Claude CLI pane today |
| Live voice | an optional full-duplex session that starts, steers or asks about a task | a required control, an always-on listener | US$0.05 per connected minute (GPT-Live 1, `voice-economics-and-opportunities.md`); off by default, needs a budget before enabling |

Rule: manual controls (copy, clear, open folder, stop) stay on screen whatever voice can do. Clear never deletes the saved conversation or evidence.

## 4. Staged MVP, deferrals and evidence gates

| Stage | Build | Evidence gate before the next stage |
| --- | --- | --- |
| 0. Baseline (2 weeks) | Measure current app: memory per pane, resize/tear reproductions, recovery. Choose layout hypothesis from the evaluation in §7. | numbers on both machines; layout pick with task-completion data from 5 sessions |
| 1. One task, end to end | Task record (goal, owner, state, decision, evidence) shared with Taskdriver; Work view lists it; approval from phone shows on desk | one real enquiry → proposal approved from the phone, same record both ends, no duplicate |
| 2. Teammates as identities | Astra + 3 persistent teammates as saved identity/memory/routine, executed by existing panes | a teammate's result history survives closing every pane; zero always-on sessions |
| 3. Code stays a tab of the task | Code view bound to the task's checkout; Copy/Clear/Open folder kept | return-to-code from a chat in ≤2 actions measured in the app, not the prototype |
| 4. Voice pilot (budgeted) | GPT-Live client delegation for start/steer/ask; explicit end action | two-week pilot: connected minutes, cost, corrections, time returned; hard budget set first |
| 5. Shell decision | Tauri spike with one real terminal under the stage-0 workload | beats Electron on a measured number with no terminal regression, else stay |

Deferred with an explicit trigger: 100+ workers (only after a measured week where more than 8 concurrent workers were actually wanted), public release (no target date), hosted compute, plugin marketplace, Windows parity (after Mac stages 1-3), Grok Bot integration (no control API found), local small models and RAG (after structured retrieval is shown insufficient).

## 5. Competitors' navigation and chat/code/agent transitions

Primary sources fetched 2026-09-13. "Observed" = stated or shown on the vendor's own page; "tested" = the vendor describes user testing; "inference" = mine.

| Product | Observed | Published testing | Inference |
| --- | --- | --- | --- |
| [Claude Code desktop](https://code.claude.com/docs/en/desktop) | Sessions in a left sidebar, filter/group by project; Code tab with draggable panes chat/diff/browser/terminal/plan/tasks/subagent; ⌘⇧D diff, ⌃` terminal, ⌘; side chat, ⌃Tab sessions; Dispatch from phone shows as a badged session | none stated | session-first, mode-inside-session; the closest published model to layout C |
| [Cursor](https://cursor.com/docs/agent) | agent "in sidepane with Cmd+I"; no other layout detail on the page | none stated | editor-first with agent as a pane; the opposite of chat-first |
| [Superset](https://superset.sh/) | left sidebar of workspaces grouped "In Progress" / "Ready for Review", agent picked per task from a dropdown, side-by-side/inline diff, ⌘O | none stated | state-grouped task list (matches our Work grouping) |
| [cmux](https://cmux.com/) | sidebar of vertical tabs with branch/dir/ports/notification text, split panes, notification rings and badges, iOS companion | none stated | terminal-first; attention cues worth copying, not the layout |
| [Conductor](https://www.conductor.build/) | marketing copy only ("see at a glance… then review and merge") | none stated | no layout evidence; excluded from the comparison |
| [Grok Bot](https://x.ai/news/designing-grok-bot) | Bots, not conversations, are the main objects; a Bot's computer at three levels: status icon, pinned preview panel, full-screen takeover; group chats | "User research showed us" about visibility, no method described | identity-first roster is the closest match to persistent teammates; layout C's task list could be teammate-grouped instead |

Published usability evidence on left vs top: [NN/g on vertical navigation](https://www.nngroup.com/articles/vertical-nav/) argues vertical lists scan faster and scale better and cost horizontal space, citing eyetracking in general terms rather than a named study; it is expert guidance, not a controlled result for this app. Nobody in the set publishes a test of their own layout. So: nothing observed in a competitor is a tested answer to Robert's question; the answer comes from §7.

Working hypothesis (to be tested, not adopted): **B for the mode control, with C's ⌘K and task list ideas folded in**. Three modes are a small fixed set, which suits a horizontal segmented control, and it leaves the sidebar for the long, growing list (projects, tasks, chats) where the vertical-scan advantage applies. A is the fallback if people miss the top control; C wins if the evaluation shows people think in tasks, not modes.

## 6. Prototypes

`../design/successor-layouts/` (A left navigation, B top mode control, C task-first). Same sample task, same content, ember identity and provider marks preserved, keyboard complete, light and dark, reduced motion, 390px phone with a drawer and 44px controls, "Open in Taskdriver" on every task. Headless proof in `validation.json`: task completes by click and by keyboard in all three with zero wrong turns on the intended path; muted text 7.1:1 dark / 7.0:1 light; no page errors. What that proves: the layouts are complete and comparable. What it does not prove: which one people prefer or where they get lost.

## 7. User evaluation

Five to eight sessions, Robert plus people who have never used git (the reader every screen is written for). Each person does the five-step task in all three layouts, order rotated (ABC, BCA, CAB). No coaching; the strip at the bottom is hidden for participants and read from `__pfProto.tally()` afterwards.

| Measure | How it is read | Pass idea |
| --- | --- | --- |
| Task completion | `done` per layout | all five steps without help |
| Wrong turns | `wrongTurns` (a navigation action the step does not accept) | fewer is better; report per step |
| Recoverability | `recoveries` and `recoverMs` (time from first wrong turn to the accepting action) | every wrong turn recovered under 20 s without help |
| Time per step | `stepMs` | compare steps 3 and 5 across layouts |
| Preference | one question after all three: "which would you use daily, and why" | a majority with a reason that names a mechanism |

Also record the first thing each person looks at (ask them to think aloud), whether they notice the provider mark, and whether anything on screen reads as jargon. No conversion score, no invented weighting.

## Unresolved decisions (Robert's)

1. Layout: A, B or C, after the §7 evaluation; the hypothesis is B with C's search and list.
2. The first real task fixture for stage 1 (one enquiry → proposal is proposed).
3. A hard voice/API budget before stage 4, and what happens at the limit.
4. Whether teammates are grouped by project (as in C) or by identity roster (as Grok Bot does).
5. When to spend the Tauri spike's two weeks, given stage 0 numbers may remove the reason.
