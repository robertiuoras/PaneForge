# Result review runtime contract

Agents record a result only after writing an explicit completion, decision, or blocked report. The report includes the original prompt, stable native session ID, lane, claimed or measured proof, evidence, safe links, and ISO timestamps. `reviews:record` writes the escaped HTML at `userData/reviews/<id>.html` before committing `<id>.json`; an identical immutable retry is idempotent and repairs a missing HTML file, while a conflicting retry is rejected. Native title, provider, folder, and session identity come from the PaneForge session or retained history, never from an untrusted payload.

`closeSession: true` applies only to a measured result with non-empty evidence, `workPreserved: true`, `noRemainingWork: true`, and a captured timestamp. It is attempted only after the report is durable and only while the pane is idle with no draft, question, queued prompt, handoff, continuation, background job, or newer user input. A refused close leaves the transcript and report intact with its refusal. Closed history without a report appears as `kind: "closed"` and `proof: "unverified"`; it is closure evidence, never a claimed completion. `reviews:open(id, -1)` opens the generated report and non-negative indexes open validated evidence links.

GuardDeck notices are emitted only for explicit `notify: true` records by the packaged Darwin production profile. A notice is one durable `~/.claude/guarddeck/notices/paneforge-review-<id>.json` file. Its `result` object carries `id`, `lane`, `kind`, `reportPath` (unchanged) and, since 2026-09-26, `sessionId` (the pane id when the result was recorded), `resumeId` (the native conversation id; absent for a shell pane, which has no conversation), `cwd`, `agent` (`claude`, `codex`, ...) and `machine` (`"mac"` or `"pc"`, the computer that holds the conversation). A reader must accept notices without the new fields; those cannot be continued by id. Informational result acknowledgement uses `~/.claude/guarddeck/result-receipts/<id>.json` with ISO `reviewedAt`; clearing acknowledgement removes that receipt and restores attention.

The app also closes finished panes on its own (`src/main/doneClose.ts`): an agent pane whose turn is over, that nobody is looking at, that has been quiet three minutes, with no question, draft, job, background job or running subagent, and whose last reply lists no step an agent could take, is recorded as a `result` with `proof: "unverified"` and `notify: true` (id `done_<pane>_<turn>`, report = the reply as the CLI's own transcript has it) and closed through the same `closeAfterResult` gate, so every chat that closes itself leaves a GuardDeck result card whose next prompt can reach it through `pf continue`. Each step only a person can take becomes `~/.claude/guarddeck/notices/paneforge-step-<review>-<n>.json` with `kind: "step"`, `machine: "pc" | "mac"` and a `reopen` block (`cwd`, `agent`, `resumeId`, `title`, `prompt`) for GuardDeck to bring the conversation back once the step is done; same production gate as result notices.

## Continuing a result's conversation

GuardDeck's next-prompt box writes the typed prompt to a file and runs, on the notice's `machine`:

```sh
pf continue <resumeId> --prompt-file /absolute/path/prompt.txt --json
```

- A local pane holding that conversation is open: the prompt is queued for the gap between its turns (the `pf tell` path). A sleeping pane is woken first.
- No pane holds it: the newest History row with that `resumeId` is reopened on this computer with `resume: true` and `resumeId` (the CLI's `--resume <id>`, so its earlier messages are back), and the prompt is then sent to that pane. A Claude conversation reopened in a copy of its folder has its transcript copied there and the pane restarted before the prompt goes.
- Exit 0 prints `{"paneId": "...", "number": <card number>, "reopened": true|false}` on stdout.
- Exit 1 prints one plain-words line on stderr and sends nothing: an id that is neither open nor in History (never a guess at the newest chat), a conversation open on the other computer, a pane whose agent has stopped, a conversation file that is gone (the pane the app opened for it is closed again), a missing/empty/over-64000-character prompt file, or a malformed id. Exit 2 means PaneForge is not answering on this computer.
- Without `--json` it prints `sent to pane <n> (<id>)`, with ` - reopened from History` or ` - woken first` when that happened.

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
