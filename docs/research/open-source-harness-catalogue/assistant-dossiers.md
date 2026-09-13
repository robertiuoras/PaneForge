# Assistant, coding and computer-use dossiers

Checked 2026-09-13 from each repository's GitHub README and license file. The companion [`assistants.json`](./assistants.json) contains exactly 35 canonical repositories. `source-available` below means visible source with observed license restrictions, not reusable open-source code.

## What PaneForge should borrow

| Project | Observed license | Source-level evidence | Pattern to borrow | Do not import |
| --- | --- | --- | --- | --- |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | MIT | At [`2846462`](https://github.com/All-Hands-AI/OpenHands/tree/28464621d879e3e9b3ceeae9d70a71d96da6212d), its [agent-server conversation client](https://github.com/All-Hands-AI/OpenHands/blob/28464621d879e3e9b3ceeae9d70a71d96da6212d/src/api/conversation-service/agent-server-conversation-service.api.ts#L81-L90) defines a five-minute create timeout and validates malformed runtime responses. Its [condense tests](https://github.com/All-Hands-AI/OpenHands/blob/28464621d879e3e9b3ceeae9d70a71d96da6212d/__tests__/api/agent-server-conversation-service-condense.test.ts#L50-L105) cover cloud proxying, missing runtime URLs and local fallback. | An explicit run record, event stream, workspace link and resumable context compaction boundary. | Its broad full-stack agent server and its conversation data model. PaneForge should remain the local session and resource host. |
| [Goose](https://github.com/aaif-goose/goose) | Apache-2.0 | At [`50666ae`](https://github.com/aaif-goose/goose/tree/50666ae0b9a51e260b52b7efbab2e4e020346e94), [permission judgement](https://github.com/aaif-goose/goose/blob/50666ae0b9a51e260b52b7efbab2e4e020346e94/crates/goose/src/permission/permission_judge.rs#L145-L183) fails closed to an empty decision if configuration/model output is invalid; the prompt test includes an instruction-injection attempt. [Persistence tests](https://github.com/aaif-goose/goose/blob/50666ae0b9a51e260b52b7efbab2e4e020346e94/crates/goose/tests/permission_persistence.rs#L5-L98) cover revocation, atomic replacement and symlink preservation. | Per-tool policy, durable revocation, and a permission decision separate from the model. | Goose's desktop/agent runtime as another long-lived control plane. |
| [AIRI](https://github.com/moeru-ai/airi) | MIT | At [`00c6867`](https://github.com/moeru-ai/airi/tree/00c6867b7fd8064938de1805814578db8273dafe), [voice lifecycle code](https://github.com/moeru-ai/airi/blob/00c6867b7fd8064938de1805814578db8273dafe/apps/stage-tamagotchi/src/renderer/utils/voice-input-lifecycle.ts#L25-L84) serializes starts/stops and preserves failures. Its [tests](https://github.com/moeru-ai/airi/blob/00c6867b7fd8064938de1805814578db8273dafe/apps/stage-tamagotchi/src/renderer/utils/voice-input-lifecycle.test.ts#L9-L84) cover a start during a stop and unavailable microphone rejection. [AIRI docs](https://airi.moeru.ai/docs/) are the live product/demo entrypoint. | Voice state machine: transcript segment, listen, interrupt, pending action, speak, error, retry. | Character/companion product architecture and Electron-specific shell assumptions. |

## Edge cases to make first-class

| Condition | Required PaneForge behavior | Evidence informing it |
| --- | --- | --- |
| Runtime endpoint is absent or returns an invalid conversation shape | Mark the run unavailable, retain the local record and offer explicit reconnect/retry. Never silently create a different task. | OpenHands' runtime URL and response validation tests. |
| User revokes a tool while another process has stale permission state | The revoked decision must win after reload; atomically persist policy and audit it. | Goose persistence tests. |
| A tool asks the model to classify a write as read-only | Model advice cannot grant permission. The policy engine independently classifies and asks/denies. | Goose permission-judge injection test. |
| Barge-in, mic unplug, or start/stop race | Serialize lifecycle transitions; show transcript/action state separately; surface the original microphone error. | AIRI lifecycle implementation/tests. |
| Voice conversation interrupts an executing backend task | Stop speech immediately, but show the backend task as still running until it is explicitly cancelled or finishes. | Required for GPT-Live delegation semantics; AIRI provides the UI state-machine pattern only. |

## Product boundary for roles and workers

A **role template** is durable configuration: a purpose, instruction set, approved tool scopes, information sources, model preference, budget and escalation rules. Examples are Marketing, CEO, Research, and a Grok/X research role. It does not execute or own a session.

A **worker run** is an observable execution: provider/model, workspace or device target, selected tools, resource lease, approvals, event log, artifacts, cost and terminal status. Chat, Work and Code are interaction modes that launch or attach to runs; they should share one run ledger rather than each building its own queue, memory and approval system.

PaneForge can host the personal desktop assistant and dedicated Chat/Work/Code surfaces if it stays the single local control plane for PTYs, browser/native-computer leases, MCP connections, session records and approvals. Taskdriver should consume status and user-approved outputs for business role templates and scheduled work. Neither product should recreate the other's worker lifecycle or permission store.

## Evaluation before adoption

1. Run the same seven role templates through one shared worker ledger and prove that a stopped/restarted PaneForge process resumes exactly one run with its prior approvals intact.
2. Give an injected tool result that requests a policy override, revoke the tool during execution, and prove the action is denied with an audit receipt.
3. Simulate microphone start failure, barge-in and backend cancellation separately; verify the UI never reports a completed action merely because speech stopped.
4. Run a browser task, a PTY coding task and a native desktop task concurrently. Confirm exclusive resource leases, scoped observation artifacts and no duplicate control plane state.

The catalogue includes source-available references such as Claude Code, Dify, LobeHub, n8n, Open WebUI and restricted Flowise areas for product research only. Their observed license terms require a separate legal review before any source reuse.
