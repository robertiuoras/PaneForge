# Result review runtime contract

Agents record a result only after writing an explicit completion, decision, or blocked report. The report includes the original prompt, stable native session ID, lane, claimed or measured proof, evidence, safe links, and ISO timestamps. `reviews:record` writes the escaped HTML at `userData/reviews/<id>.html` before committing `<id>.json`; an identical immutable retry is idempotent and repairs a missing HTML file, while a conflicting retry is rejected. Native title, provider, folder, and session identity come from the PaneForge session or retained history, never from an untrusted payload.

`closeSession: true` applies only to a measured result with non-empty evidence, `workPreserved: true`, `noRemainingWork: true`, and a captured timestamp. It is attempted only after the report is durable and only while the pane is idle with no draft, question, queued prompt, handoff, continuation, background job, or newer user input. A refused close leaves the transcript and report intact with its refusal. Closed history without a report appears as `kind: "closed"` and `proof: "unverified"`; it is closure evidence, never a claimed completion. `reviews:open(id, -1)` opens the generated report and non-negative indexes open validated evidence links.

GuardDeck notices are emitted only for explicit `notify: true` records by the packaged Darwin production profile. A notice is one durable `~/.claude/guarddeck/notices/paneforge-review-<id>.json` file. Informational result acknowledgement uses `~/.claude/guarddeck/result-receipts/<id>.json` with ISO `reviewedAt`; clearing acknowledgement removes that receipt and restores attention.

The app also closes finished panes on its own (`src/main/doneClose.ts`): an agent pane whose turn is over, that nobody is looking at, that has been quiet three minutes, with no question, draft, job, background job or running subagent, and whose last reply lists no step an agent could take, is recorded as a `result` with `proof: "unverified"` (id `done_<pane>_<turn>`, report = the reply as the CLI's own transcript has it) and closed through the same `closeAfterResult` gate. Each step only a person can take becomes `~/.claude/guarddeck/notices/paneforge-step-<review>-<n>.json` with `kind: "step"`, `machine: "pc" | "mac"` and a `reopen` block (`cwd`, `agent`, `resumeId`, `title`, `prompt`) for GuardDeck to bring the conversation back once the step is done; same production gate as result notices.

Publish with `node scripts/pf-ctl.mjs review /absolute/path/result.json`. Use one stable ID
for one outcome; retries must retain the same content. The JSON has this shape (replace all
example values with observed state):

```json
{
  "id": "native-conversation-final-result",
  "sessionId": "actual-pane-id",
  "nativeSessionId": "actual-provider-conversation-id",
  "kind": "result",
  "prompt": "The user's original request",
  "report": "What was completed, what was verified, and any remaining limits",
  "lane": "Lane B",
  "proof": "measured",
  "evidence": ["Exact check and observed outcome"],
  "links": [{"label": "Work", "url": "https://example.com/result"}],
  "completedAt": "2026-09-20T07:00:00.000Z",
  "capturedAt": "2026-09-20T06:59:00.000Z",
  "workPreserved": true,
  "noRemainingWork": true,
  "closeSession": true,
  "notify": true
}
```

Only request a notification for an outcome the user requested or is waiting for, a material
blocker, or a decision they must make. Routine progress, sleep, housekeeping and elapsed quiet
time do not warrant notification. Never set preservation/completion flags without checking
native identity, owned work, retained output and any outstanding task. This API does not grant
release, external-message, payment, credential or destructive-operation authority.
