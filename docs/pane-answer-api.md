# Conversation-bound answers

`pf call pane:answer '{"paneId":"s…","expectedConversationId":"<native UUID>","requestId":"<stable answer ID>","text":"<answer>"}'`

`pf call pane:answerStatus '{"paneId":"s…","expectedConversationId":"<native UUID>","requestId":"<same ID>"}'`

These invoke channels use the existing authenticated PaneForge surface. They address one
exact **local** Codex pane. Remote callers must use the receiver's local surface. No
separate session-list check is needed for delivery authorization. An absent endpoint
is an unsupported installed version, never permission to fall back to `tell` or `type`.
The public session's `resumeId` may be absent for a newly started chat. The endpoint
verifies the internal native transcript identity, including unique submitted-message
evidence for new chats. Missing or ambiguous native evidence fails closed; the caller's
`expectedConversationId` never establishes identity by itself. Answers retain the
existing passkey typing gate; status is a read of receipt metadata only.

Both return a receipt containing `paneId`, `expectedConversationId`, `requestId`,
`state`, `acceptedAt`, and optional `submittedAt`, `confirmedAt`, `transcriptAt`, `reason`. Status
returns null for an unknown request. Validation/identity conflicts throw an IPC error.

- `waiting`: durable request, no answer typed yet. An occupied or uncertain human
  composer is preserved. Live question metadata, question/approval footers and a
  connecting composer also hold delivery. Busy model work alone does not hold the answer.
- `submitted`: write intent saved before paste. This is **not delivery proof**.
- `confirmed`: the same native conversation contains the exact answer in a fresh
  native user-message row. No terminal/UI heuristic can produce this state.
- `rejected`: no answer was typed, for example a changed identity or occupied composer
  timeout (two minutes). The request ID remains consumed.
- `uncertain`: delivery may have started, but proof is absent. Do not automatically
  retry under a new ID. Human typing between paste and Enter withholds Enter without
  deleting the draft. Receipt timeout is thirty seconds. Application restart never
  replays a request into a restored process.

Question and composer guards are checked again against fresh terminal output before
Enter. A dialog appearing after paste withholds Enter and makes the receipt uncertain.

Repeat the same request to retrieve its receipt without typing twice. Changing its
text or conversation under the same ID is an error. The private durable ledger stores
identity and a text digest, not answer text. Disk failure before acceptance refuses
delivery. Confirmation is scoped to the original process and conversation.

Text is limited to 64,000 characters, permits tabs/newlines, rejects terminal control
characters and leading slash/shell commands. This endpoint is for prose answers,
not CLI commands. It uses bracketed paste followed by a separate Enter. Codex 0.157's
`chatwidget/input_flow.rs` submits Enter while a turn runs; Tab is the queue path.
Reasoning-level automation is bypassed for this submission so it cannot schedule an
unbound delayed Enter. Native receipt is still required if Codex itself defers input.

Regression coverage: `test:paneanswer`, `test:nativetranscript`, `test:promptsubmit`.
Installed availability and an actual active-turn native receipt require a built
runtime; source changes alone do not establish either.

A rejected request ID cannot be reset or retried. After an explicit no-write rejection,
a caller may create a new request ID once the reported condition is resolved. Never
silently change IDs to bypass an uncertain or submitted receipt.

Legacy `pane:tell` requests are separate. An existing `owedPrompt` refuses this
endpoint to prevent duplicate delivery. The old durable queue does not record a
pre-paste phase, and removing a disk row cannot reliably stop its in-memory Enter
callbacks. There is no verified automatic migration from a running old installed
process. Preserve the original pending request and seek its exact native receipt;
do not replay it through this endpoint. Updating a dev copy does not update that
installed process or authorize a restart of a client session.
