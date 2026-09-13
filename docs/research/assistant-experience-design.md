# PaneForge experience design

## Product direction

One workspace should make it easy to ask for an outcome, understand what is happening, intervene, and inspect the result. The assistant should feel capable and calm. Its intelligence should show through good decisions and reliable recovery rather than an animated graph or a permanently moving waveform.

This is a proposed interaction specification accompanying [the research and architecture plan](assistant-platform-plan.md). It defines the surfaces and states to design before implementation. It is not a final visual design, an approved mockup, or evidence of a working feature.

The delivery order is Mac first, Windows follows. The primary end-to-end journey starts with an accepted client job or email brief, researches the existing client context, requests missing login/access, executes authorised deliverables, and produces a private completion document with screenshot evidence. Use included agent subscriptions first and show paid voice/API usage separately.

## Navigation and layout

Use two primary views, **Assistant** and **Workbench**, sharing the same tasks. Assistant is the conversational and outcome view; Workbench exposes terminals, files, diffs, lanes, and detailed execution. Voice is an optional input method in either view, not a third task universe.

Keep Devices, Activity, and Settings available through secondary navigation. Put improvement experiments inside Activity with an explicit entry rather than making every user learn a separate laboratory. A command palette supports task search, view switching, and common actions.

```text
┌ PaneForge   Assistant | Workbench       Voice off   Devices   Stop ┐
│ Tasks             │ Selected task                                │
│ Search / New      │ Goal, location, current state                 │
│                   │                                              │
│ Needs your input  │ Conversation / plan / artifact / terminal      │
│ Active            │                                              │
│ Queued            │                                              │
│ Recent            │ Result and evidence                          │
│                   │                                              │
│                   │ Ask or steer this task…                Submit │
└ Activity / Settings───────────────────────────────────────────────┘
```

The task list groups by meaningful state rather than forcing a wide board. Selecting a task preserves draft input and scroll position. Workbench opens the same selected task, not a duplicate conversation. Related terminal sessions are children of the task and retain their actual provider session identities.

Default task rows show title, one state, and device. Model/provider, lane, elapsed time, and process details appear in an expanded row or inspector. A task needing input shows the question directly. Keep bulk selection and pins available without permanently placing a checkbox, timer, model badge, branch, and action menu on every compact row.

## Core journeys

| Journey | Happy path | Failure/recovery design |
| --- | --- | --- |
| First launch | Select workspace, connect an agent provider, run a small text task | Missing CLI/auth is shown separately; no false connected state |
| Enable personal assistant | Choose device capabilities and test them | Permission denied stays denied; explain the affected task |
| Start Live | Explicit start, visible mic state, connection confirmation, captions | Unavailable mic, network loss and account limits have distinct states; text remains usable |
| Ask for computer help | Show target device/app, obtain a scoped task, operate, verify | Yield to manual input; show blocked step and safe continuation |
| Build on PC | Select compatible host, show queue/receipt, receive artifact | Disconnection preserves unknown remote status until reconciliation |
| Steer ongoing work | Attach correction to the existing task | Cancel or supersede affected work; ignore stale results |
| Review a change | Show before/after, diff, checks and release state | Failed checks remain visible; no “ready” badge from exit code alone |
| Recover after restart | Restore task list and reconcile workers | Mark uncertain work explicitly; never silently start it twice |
| Improve a workflow | Explain observed failure, candidate change, comparison and rollback | Failed experiment stays separate from the stable runtime |
| Deliver a client project | Select accepted job, inspect brief/folder, execute deliverables, prepare proof pack | Missing access, conflicting scope and partial completion are visible per deliverable |

Onboarding must prove distinct capabilities separately: authenticated provider, accessible workspace, working terminal, paired remote host, desktop observation, desktop action, and voice conversation. A green connection indicator must not stand in for all seven.

## Client project and login handoff

The project overview places the client/job identity and source brief above a short deliverable list. Each deliverable carries a plain state, its result and evidence link. A context drawer shows the folder, source messages and approved prior decisions used. Let the owner correct a mistaken client match before any client-specific action.

Missing authentication produces one clear card: “Sign in to [site] as [account].” The assistant prepares the scoped Chrome automation page and yields input. The card offers “Open sign-in,” “I've signed in,” and “Cancel task,” with no password field in PaneForge. Actual completion requires account readback, not simply clicking “I've signed in.” A sound/visible waiting indicator should be bounded so repeated polling cannot generate repeated alerts.

While authentication is pending, show which independent preparation continues. Do not capture credentials. After sign-in, resume the same task with the verified account. If the browser opened the wrong account, stop the dependent step and explain the mismatch without changing credentials or logging out unrelated user sessions.

Use the explicit `waiting_for_user_sign_in` state. Release input ownership and suspend automated focusing, typing and capture in that scope until the user returns control. Timeout leaves the dependent step blocked. Account verification follows acknowledgement; sign-in does not expand task authority.

Show the billing route and configured budget before paid voice/API work. Paid features stay disabled until a budget is set. Exhausted subscription capacity offers an authorised alternative subscription or queueing, never silent paid fallback. Client context shows which provider/device may receive it; credential values never appear in task history or evidence.

The proof-pack preview is an actual deliverable review, with readable screenshots, links, verification results and remaining blockers. Distinguish “prepared for review” from “sent to client.” Keep a draft communication beside the evidence pack when useful, and require the existing explicit send approval.

The requested visual reference is the [video at 4:00](https://www.youtube.com/watch?v=kP31sQPAJm0&t=240s). Metadata retrieval succeeded, but segment retrieval returned HTTP 403. Its exact layout and motion remain unverified and must be assessed before a faithful visual proposal. The plan does not equate a talking-agent animation with autonomous project completion.

## Task and voice states

Tasks need explicit states: draft, queued, starting, running, needs input, waiting for user sign-in, paused, verifying, completed, failed, cancelled, and connection lost. The device receipt determines execution state. “Completed” requires the task-specific outcome check. When only source tests passed, say that; installation and release are separate labels.

Voice states are off, connecting, listening, speaking, reconnecting, and unavailable. Full-duplex listening/speaking can overlap. Captions and backend progress are separate. Muting the mic changes recording, not task authority. Stopping speech does not cancel a build.

Use precise commands: **Mute microphone**, **End voice**, **Pause task**, and **Stop all actions**. The last one revokes new actions and requests cancellation of running work. Show cancellation confirmation per device; never promise reversal of an already completed external operation. A keyboard shortcut and persistent button must work even if the conversational agent is unresponsive.

If a voice session reconnects, restore concise task context and correlate it with existing work. Do not replay a command merely because it appears in a reconstructed transcript. Task intent and effect receipts remain durable independently of audio history.

## Permissions and personal mode

Public mode initially exposes coding/workbench capabilities within their configured scope. Personal computer operation is disabled until explicitly enabled. Its off state means no background capture, no auto-started desktop controller, and no accepting computer-control requests on local or remote endpoints.

Use a compact task approval card when a real decision remains. It should state the action, device/app/account, affected data, and reversibility. Let an existing scoped authorisation cover routine steps instead of repeatedly asking about every click. Never infer permission to send, purchase, delete, alter credentials, or release from general computer access.

A granted capability is not an instruction to use it. The policy layer checks both task scope and capability. A web page, document, terminal output, or plugin description cannot enlarge either. The UI should show blocked attempts in the task's activity without overwhelming normal use with hypothetical warnings.

Screen context defaults to the selected app/window for the active task, where supported. Clearly show the source and capture state. If a driver requires whole-screen capture, explain that difference before enabling it. Continuous historical recording is a separate later product decision, not a side effect of turning on voice.

## Device and resource view

Present the Mac and PC as named devices with connectivity, capability, workload, and freshness. Distinguish “can run builds,” “can control desktop,” and “can host this provider.” Last-seen telemetry must not look live.

Show a simple headline such as “PC running this build” or “Queued to keep this Mac responsive.” The detail view contains memory pressure, process ownership and capacity evidence. Prefer a useful explanation to an unexplained red percentage.

A task running remotely still has local display cost. Avoid “100% offloaded.” Let the user pin a device when a workflow requires local credentials or platform-specific software. An offline preferred device should produce an explicit queue or alternative, not a silent switch that changes workspace/account context.

## Workbench and terminal design

Retain genuine interactive terminal behaviour, including search, selection, copy/paste, keyboard shortcuts, Unicode, IME, resize, and scrollback. Keep session pins, question previews, queued prompts, and lane identity. Switching views must not recreate PTYs.

Command blocks can improve navigation where shell integration supplies trustworthy boundaries. Do not pretend arbitrary full-screen CLI output has reliable OSC 133 command semantics. Support plain terminal output and gracefully fall back when markers are unavailable.

Diffs, artifacts and terminal output should open in a resizable inspector. Keep the main task's purpose visible. Large transcripts and long task lists should render incrementally or virtually as needed; output throughput must not make typing lag.

## Visual direction

Retain PaneForge's identity while reducing competing highlights in Antigravity's concept. Use restrained dark and light themes, thin separators, quiet surfaces, consistent typography, and one interaction accent. Amber denotes attention; red denotes failure/destructive actions. Device identity and state require text or icons as well as colour.

Use the platform system UI font and a configurable monospace terminal font as the starting point. Keep body text readable at ordinary laptop scale and expose density/font preferences. Proposed spacing follows a 4/8-pixel rhythm; exact sizes should be validated in the mockups rather than imposed on every component.

Avoid permanent glow, blur on large scrolling surfaces, ambient particles, and animated telemetry. Motion should explain a transition or acknowledge an action; honour reduced motion. A waveform appears only during an active voice session and is not used as the sole microphone indicator.

The design-system search returned marketing-page structures, which are unsuitable for this desktop workspace. This specification instead uses its applicable accessibility and minimal-interface guidance plus the task-specific layout above. No hero, landing-page CTA, or marketing animation belongs in the workbench.

## Accessibility and responsive behaviour

All primary journeys must work with keyboard navigation. Preserve visible focus, logical tab order, named controls, and focus restoration after dialogs. Status announcements should not read every terminal token through a screen reader. Do not make approval, Stop, or task selection depend on hover.

Validate text contrast at 4.5:1 for normal text, distinguish controls independently of colour, and keep controls usable under text enlargement. Native titlebar and window controls must remain understandable on each OS. Verify multi-monitor scaling and high-DPI coordinate mapping during device-control tests.

At narrow widths, collapse the task list into a drawer and use one content pane. Offer an explicit switch between task output and inspector. Never compress a multi-column desktop dashboard until labels collide. The existing phone/browser client should remain useful for status, review, and steering; it need not imitate a full desktop terminal grid.

## Improvement and release experience

An improvement card should explain: the observed problem, candidate change, which tasks improved, regressions, cost/latency differences, review state, and rollback version. Distinguish proposed, tested, merged, released, installed, and observed. A passing CI run is one piece of evidence, not a design review.

Stable and experimental runtimes must remain distinguishable. An experiment uses isolated work and test data. It cannot change its own scoring rules or approve expanded permissions. Public delivery waits for the agreed release policy; the personal assistant does not grant itself that policy.

Scheduled work must appear in an existing agent/activity surface with its scope, budget, last result and next run. Avoid duplicate hidden schedulers. Continuous improvement should become quieter and more useful over time, not a feed of constant speculative changes.

## Design deliverables before the successor build

| Deliverable | Required contents | Review criterion |
| --- | --- | --- |
| Navigation prototype | Assistant, Workbench, Devices, Activity, Settings | Same task remains recognisable in every view |
| Task state sheet | Every lifecycle and missing-proof state | No ambiguity between busy, disconnected and completed |
| Live interaction prototype | Captions, mute/end, steering, failure and Stop | Voice remains understandable during backend work |
| Personal-mode setup | Capability selection, denial, revocation and off state | Control scope is understandable and enforceable |
| Workbench prototype | Realistic long titles, terminal, diff, questions and pins | Useful at ordinary laptop width without crowded rows |
| Resource/recovery prototype | Busy host, offline PC, task reconciliation | No false stopped/completed/remote guarantees |
| Improvement review | Baseline/candidate evidence and release states | A reviewer can make a concrete decision |
| Visual state coverage | Light/dark, narrow/wide, keyboard, reduced motion | Usable beyond the attractive default screen |

Build these as inexpensive static or clickable design artifacts before wiring a new runtime. Use realistic fixtures, including failures and long text. Final high-fidelity colours, icons, animation, and branding remain reviewable design work; this planning baseline does not pretend to settle taste or integration unknowns through prose alone.
