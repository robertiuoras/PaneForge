# Successor review decisions, 13 September 2026

These are product requirements and research conclusions, not implemented backend guarantees.

## Latest workspace prototype

`../design/paneforge-directions/workspace.html` now includes Agent, Code and Chat
views; one search entry; consistent owned SVG navigation icons; existing local
PaneForge, Codex and Claude marks; and an original SVG live-companion study with
idle/listening/speaking controls. Speech, microphone, agents and terminal execution
are simulated. Motion stops offscreen or when hidden and respects reduced motion.

Headless Chromium checks passed: three view switches, speaking state, loaded brand
images, search, 390px horizontal overflow, reduced motion and no page errors. The
updated workspace.png is a desktop preview. This does not test Tauri or fix the
installed app's terminal renderer.

## Session naming acceptance requirements

- Use the actual outcome and project context, not a generic role, first greeting,
  CLI command or transcript fragment. Example: “Repair session title persistence”.
- Preserve explicit manual names. Keep a stable session ID independently of title.
- Start with a useful provisional title; refine after task intent becomes clear.
  Do not continuously rename while someone is trying to locate a session.
- Distinguish similar tasks without arbitrary agent numbers; preserve name/history
  across provider changes, restart, reconnect and device handoff.
- Ignore untrusted instructions inside retrieved content when generating names;
  do not put secrets into titles. Fall back locally if the naming route fails.
- Use task metadata first. Any model naming request must be bounded, measured and
  routed through the authorised subscription pool, without silent paid fallback.

## Reliability requirement

No user-operated “Fix display” button should be part of normal operation. Prove
resize, split changes, hidden/visible panes, sleep/wake, monitor scaling, reconnect,
heavy ANSI output and crash/resume paths against captured terminal content. Test
input latency and memory pressure with active and saved sessions counted separately.
A new shell alone is not evidence of reliability.

## Product boundary

Taskdriver owns client briefs, business tasks, schedules, approvals, deliverables
and mobile status/steering. PaneForge owns the desktop execution and inspection
experience, provider sessions, code/files, terminal/computer use and recovery.
Use one task identity and approval history across both; do not create competing
queues or two disconnected versions of a business agent. Persistent teammates
are reusable responsibilities, not always-generating model processes.

## Harness priorities

First: durable tasks and resumption; small relevant context packages with source
links; shared prompt/goal/skill contracts; bounded subscription workers; tool
loading on demand within permitted scope; isolated worktrees and honest test/proof
receipts; explicit review and stop controls. Track accepted outputs, correction
minutes, quota per accepted task and recovery success. Add parallelism only when
independent work improves those measurements. Keep voice as an optional interface.

The 100-repository catalogue is a documentation/source survey, not a runtime
benchmark. Existing systems should be evaluated on our own client-delivery and
coding tasks before importing dependencies or making scale claims.

## BridgeMind evidence

BridgeSpace's official [3.1.7 notes](https://www.bridgemind.ai/changelog/bridgespace/v3-1-7)
confirm Tauri channels, Rust and xterm, and describe fixes for output freezes and
stale channels. Its [3.0.81 notes](https://www.bridgemind.ai/changelog/bridgespace/v3-0-81)
describe canvas paint recovery. This is direct evidence that Tauri does not remove
terminal-rendering failure modes on its own.

The newer [BridgeMind One guide](https://docs.bridgemind.ai/docs) documents the
combined product. The public product page shows project names including
`bridgemind-one-swift` and `bridgespace-tauri`, but names in a demo are not sufficient
to establish One's exact platform stack. No complete One source checkout was
inspected; React or SwiftUI must not be asserted as verified implementation facts.
