# PaneForge personal assistant: execution and motion plan

13 September 2026. Proposed implementation specification, not a working assistant.
This extends the existing orchestration, memory and product-boundary research.
Keep PaneForge as the product name. Orange is the default accent. Appearance
settings change the app accent, PaneForge mark and companion tint together;
provider logos retain their own brand colours. Mac first, Windows follows.

## What GPT-Live supplies

GPT-Live 1 supplies full-duplex speech: listening, speaking, interruptions,
transcripts and delegation to a backend. The backend performs reasoning, tool
selection and actions. It can be an application-owned agent using client delegation.
Images and screen content go to a vision-capable backend, not directly to Live.
The app owns durable task state, permissions, transcripts and verified results.

Voice is billed at US$0.05 per connected minute, per second, rather than an audio
token tariff. It still has a token-based context window, so “doesn't use tokens” is
not literally correct. Backend API models/tools cost extra; subscribed Codex/Claude
workers consume their respective quota. ChatGPT/Codex subscription authentication
does not pay the Live API bill. Realtime is a different product and tariff.

Voice-only examples: 10 minutes = US$0.50; 30 = US$1.50; 60 = US$3.00.
Thirty minutes per weekday over 22 weekdays = US$33, excluding backend usage,
subscriptions, taxes and currency conversion. No spending is enabled by this plan.

Use client delegation for the subscription-first design. This gives PaneForge
context and execution control, but the bridge is engineering work, not a built-in
Live-to-Codex subscription connector. Verify authentication, response latency,
steering, cancellation and resume with a bounded real pilot before adopting it.

## Product layout

- One left sidebar: New conversation, Overview, Needs you, Deliverables, Second
  brain, Skills & prompts, Routines, Appearance, projects and saved conversations.
- A 36–42px companion centred above Agent / Code / Chat. One Start voice / End
  voice button plus an optional configurable shortcut. No mode-testing buttons.
- A compact factual activity chip appears only when useful. Clicking it opens the
  relevant task, result or details. Nothing automatically steals focus.
- Agent shows work and exceptions; Code shows files/changes/terminal/tests; Chat
  shows the assistant conversation with clearly labelled project and attached context.
- Taskdriver owns client/business records and mobile steering. PaneForge owns the
  desktop execution. One task identity and approval record across both surfaces.

## Motion language

Use a custom layered glass/energy mark. A coherent material and restrained movement
should make it distinctive, rather than unrelated special effects for every tool.
Timings below are initial design targets, not performance measurements.

| Trigger | Animation | Visible meaning and completion condition |
| --- | --- | --- |
| Enable voice | Inner light gathers in 180–260ms; rim resolves; a small connection arc appears | “Connecting” until session.started AND usable media state. Permission denial goes to an explicit error, never fake listening. |
| Ready/listening | Low-amplitude deformation follows locally measured microphone level | Show mic state separately from backend work. No microphone animation while muted or disconnected. |
| Speaking | Two flowing ribbons and a refractive core follow actual played output audio, with a short release envelope | Transcript receipt alone must not drive “speaking”. Audio interruption settles the mark immediately. |
| Search files | One scanning sweep around the rim, then a small folder chip below it | “Searching project files”; replace with verified result count or “No matches”. Never simulated percentages. |
| Search second brain | Short linked-point trace; compact source chips enter once | Show source title/date and scope; open exact passages. Stale/conflicting results remain visibly qualified. |
| Start five Codex workers | Five small marks gather into one group, then resolve independently | “3 running · 2 queued” comes from actual lifecycle acknowledgements. Starting is not running. |
| Worker completes | One concise settling animation on the task row and proof chip | “Ready for review” only after required artifact/test evidence exists. |
| Close unused apps | Target app icons appear in a small activity detail, then settle individually | Show “Quit requested” until process exit; a save dialog becomes “Needs you”. No disappearing icons as false proof. |
| Needs input | One amber emphasis and stable action chip | Explicit cause and action. Never a perpetual pulse or ambiguous colour-only warning. |
| Error/disconnection | Motion stops; broken rim becomes a static error icon | Show retry/reconnect state and preserve active tasks. Never animate ongoing progress from stale events. |
| End voice | 120–180ms release into a static mark | Stop mic capture/playback promptly; show “Ending” until close is confirmed. Background tasks continue. |

Only voice activity may sustain animation while audio is actually active. Tool
animations are brief transitions, not loops for the entire search/build. Reduced
motion uses static states and text. Pause decorative rendering while hidden or
occluded. Batch progress changes; do not render one animation per token or log line.
Use transform/opacity and a small clipped surface first. Adopt WebGL only if a
measured visual benefit survives GPU, battery, memory and multi-terminal tests.
No paid model calls generate animation. Local state drives it.

## Executor contract

Keep voice session, delegation ID, task ID/revision, operation ID, worker session ID
and OS process identity separate. Every operation records owner, scope, target,
requested action, current state, evidence and error. Persist before an external
side effect; retries first check whether it already occurred. Late results from an
old task revision cannot overwrite current decisions.

The operation path is requested → validated → queued → starting → running →
completed / failed / waiting / cancelled / outcome unknown. Backend receipts drive
both UI and spoken summaries. Animation completion cannot advance task status.
Do not infer completion from model prose, an exited CLI or a closed terminal.

The voice context contains selected project/task, relevant recent dialogue and
concise verified results. Maintain ordered input/output transcript fragments and
corrections separately. Delegation metadata does not contain the full task text.
Wait for sufficiently clear intent before consequential actions; an early fragment
such as “close…” is not authority to quit an app. Preserve app-owned tasks when
voice ends. Speech interruption is distinct from cancelling work.

## Capabilities and their concrete workflows

### Find a file or retrieve second-brain knowledge

1. Resolve scope from selected project and the request. Use the existing shared
   vault/index and file tooling. Do not create another copy of the second brain.
2. Search exact filenames, metadata and full text first. Return bounded candidates
   with canonical path, source date and excerpt; read the selected sources next.
3. If intent is ambiguous, show a few labelled choices. If memory conflicts, expose
   the competing dates/decisions. A no-match is not evidence that a fact never existed.
4. Answer with linked sources, attach relevant passages to the task and expose
   “Sources used”. Keep full documents outside voice context. Expand retrieval if
   the first pass is insufficient; add embeddings only after a measured recall gap.
5. Write memory only under the applicable authorisation. Retrieved text is data,
   never a source of permission to run commands or disclose other clients' files.

### Launch and manage five Codex sessions

1. Capture five independent outcomes, ownership and completion checks. If the work
   is dependent, explain and queue the dependent parts rather than forcing parallelism.
2. Inspect existing sessions, provider pool health and machine pressure. Prefer
   reuse/resume when appropriate; never duplicate work on a reconnect.
3. Use the existing session dispatcher and isolated worktrees for conflicting code.
   Authenticate via the included plan. No silent paid API fallback.
4. Record each native conversation ID, working directory and real acknowledgement.
   Name sessions from outcomes; preserve manual titles. “Requested five” may produce
   fewer active workers because of resource or quota limits, shown explicitly.
5. Steer/stop the exact owned sessions. Keep full outputs and reports. Test stale
   ownership, exhausted quota, worker crash, app restart and a partially started batch.

### Improve resource usage or close apps

1. Measure memory pressure, CPU/GPU, active builds and actual session ownership first.
   Low focus time alone does not make an application unused.
2. Prefer reducing our background rendering and queueing new heavy work before
   touching unrelated apps. Protect this assistant, active jobs, unsaved documents,
   another session's browser and OS services.
3. For a user-requested cleanup, identify specific candidates and use graceful quit
   where safe. A save dialog or unknown unsaved state remains a user decision; never
   force-quit or dismiss a save dialog under generic “optimise my Mac” authority.
4. Verify target process exit and remeasure. Report observed before/after pressure,
   not invented savings. Persistent system changes require their own explicit scope.

### Browser, shell and project delivery

Prefer service APIs or semantic browser state where adequate. Use visual observation
for canvas/native UI, unclear state and final appearance checks. Acquire existing
computer-use ownership before desktop batches. Pause for required authentication
and verify the account afterwards. Run shell work through owned supervised sessions.
External sending, publishing and destructive operations retain their established
approval boundaries. Return a project-linked proof pack and unresolved items.

## Cost and context controls

- Default reasoning, planning, research, coding, review, session naming and task
  summaries to subscription-authenticated Codex/Claude CLI workers wherever the
  supported CLI can complete the task. Reuse existing sessions and the dispatcher;
  do not start a fresh agent for each UI event. Simple operations stay deterministic.
- CLI is a transport, not proof of included billing. Verify subscription login on
  the actual worker and isolate inherited backend API credentials. Record provider,
  authentication route and native session ID without recording credentials.
- When a subscription pool is exhausted, route a suitable discrete task to the
  other available subscribed CLI or queue it with a visible explanation. Never
  silently use an API key, purchase credits or change the selected model family.
- Use paid APIs only for a required capability the subscribed CLI cannot supply,
  such as embedded GPT-Live voice, within an explicitly approved extras budget.
  The app-owned Live client-delegation bridge should dispatch to CLI workers;
  built-in paid Responses delegation is not the default backend route.
- Prefer brief voice planning/check-ins, disconnect while background work runs,
  and reconnect when Robert chooses. Ending voice must preserve the task and its
  output. Measure CLI latency before promising seamless live tool responses.
- End the Live session to end connected-duration billing; muting is not disconnecting.
  Show elapsed connected time and estimated voice cost in details, not a giant HUD.
- Record cumulative usage.seconds as a snapshot, not an increment. Reconcile final
  session.closed usage. Network failure means final cost may remain provisional.
- Keep voice minutes, paid backend cost and subscription usage separate. Never claim
  exact remaining CLI quota if the provider only exposes estimates.
- Use deterministic code for lookup filtering, state transitions and arithmetic.
  Use a subscribed capable worker for ambiguous work. Small models must win a
  quality/latency/resource comparison before being inserted into every event path.
- Load relevant MCP definitions on demand, within allowed account/project scope.
  Return concise structured results and artifact links rather than raw terminal logs.
- Handle a hard extras budget with a deliberate session close and durable task
  checkpoint; do not switch billing routes or repeatedly reconnect around the limit.

## Delivery sequence and acceptance gates

0. Foundation checkpoint: reconcile the existing workflow repair receipt before
   building on it. The original CI import failure is resolved; see the updated
   [workflow receipt](workflow-foundations/implementation.md) for native Mac/PC
   checks and the additional Windows fixture correction. These offline fixtures
   do not establish real provider authentication or full Windows app parity.
   The first connected Mac slice is typed request → scoped second-brain retrieval
   → one subscription CLI worker → saved result with source and usage metadata.
   Preconditions: working Mac dispatcher, verified subscription authentication,
   scoped vault access, and an isolated dev profile. Acceptance: one bounded real
   task completes; resume preserves output; API credentials are not used; quota
   exhaustion queues or reports unavailable; cross-project access is rejected.
   Keep live voice simulated until this slice passes. Record actual latency and
   memory under terminal output before choosing a wider migration scope.
1. Motion prototype: replay recorded synthetic operation events in a separate design
   playground. Check activation, search, five-worker partial start, errors and end
   voice. Main UI keeps one toggle. No fake progress in a connected production UI.
2. Read-only assistant: file and second-brain search with citations. Test stale notes,
   forbidden decoys, correction phrases, ambiguous references and missing files.
3. Session control: real subscription-authenticated start/resume/steer/stop, useful
   naming and output preservation. Inject disconnects and partial failures.
4. Resource and computer actions: add measured diagnostics first, then scoped actions
   and verified results. Test unsaved documents and desktop ownership contention.
5. Paid voice pilot: after budget and credentials are available, validate Live client
   delegation with the working backend, interruption, transcripts, end-voice billing
   and independent task continuation. No current permission to spend is inferred.
6. Taskdriver/mobile integration, Windows parity and higher concurrency follow the
   same task/operation contract once Mac recovery is proven.

Measure p50/p95 time to first useful result and audible reply; wrong/duplicate
execution; retrieved-source accuracy; task acceptance and correction minutes;
voice/backend cost; quota per accepted task; UI frame times, memory and GPU/CPU
while terminals stream. Proposed release gates: no wrong-client access, no duplicate
side effects in fault fixtures, no lost output on tested recovery paths, and no
manual display repair in resize/sleep/reconnect/heavy-output fixtures. These are
required tests, not assurances that the new shell has already passed them.

## Sources checked for this extension

- [GPT-Live 1 model and pricing](https://developers.openai.com/api/docs/models/gpt-live-1)
- [GPT-Live overview](https://developers.openai.com/api/docs/guides/live)
- [Client delegation, transcripts and visual context](https://developers.openai.com/api/docs/guides/live-delegation)
- [Session lifecycle, context and usage](https://developers.openai.com/api/docs/guides/live-conversations)
- Existing local [orchestration/MCP plan](assistant-orchestration-and-mcp.md),
  [feature value matrix](open-source-harness-catalogue/feature-value-matrix.md) and
  [visual reuse dossiers](open-source-harness-catalogue/visual-reuse-dossiers.md).

## Usage reporting requirement

Show live connected time and estimated USD voice cost beside the voice control,
with session, project, daily and monthly totals in Usage. Store provider session ID,
project/task IDs, model, start/end timestamps, cumulative seconds, rate/version,
estimated cost and finalization status. Upsert cumulative snapshots per provider
session; reconnects create separate sessions without double-counting events.
Use the final session.closed duration when available; label missing final usage
unconfirmed rather than presenting it as an invoice. Reconcile against provider
billing when available. Usage metadata does not require retaining raw audio.

Keep subscription worker quota/telemetry separate from paid API costs, and mark
unavailable quota fields unknown. Do not imply an exact remaining allowance from
token counts alone. Provide configurable session and monthly voice budgets, a
warning before the limit, and an explicit disconnect at the chosen cap; allow for
reporting delay. Never silently switch an exhausted subscription worker to API.

## Reference-led companion preview, 13 September

The workspace HTML prototype now has a centred colour-aware orb above Agent /
Code / Chat. Its single toggle or Option-V expands a transcript and clickable
simulated task chip horizontally without moving the work area. The chip opens
explicit sample task details; no workers, microphone or model service are connected.
Headless checks cover toggle/shortcut, appearance persistence, task details, fixed
mode-bar position, narrow-screen overflow, image loading and reduced motion.

For implementation, use the shared React preview/desktop approach in the
[development pipeline](agentic-development-pipeline.md#shared-preview-and-desktop-ui-decision).
The current HTML prototype is a design reference, not yet shared React source.
