# GuardDeck result inbox

Research and proposed behavior, 2026-09-20. This is not an installed feature.

## Product direction

GuardDeck should surface requested results, decisions and genuine blockers on the Mac. PaneForge remains available for investigation, continuation and terminal access. Robert should not have to inspect every session to determine whether its work is complete.

Only interrupt for:

- A deliverable Robert explicitly requested or is waiting for.
- A decision requiring his authority, with the concrete reviewed action attached.
- A blocker the agent cannot resolve within its existing authority.
- A material failure or change that affects the requested outcome.

Routine progress, sleeping, closing, retries and internal handoffs stay silent. Agents make ordinary reversible decisions themselves. Group by objective, not by process or turn; multiple sessions working on one outcome should produce one updated result.

## Example card

Research library updated                         Done · Lane F

117 notes indexed. Changes merged to main.
No decision needed.

[Open report]  [Open library]  [Dismiss]

The task title leads; lane and machine are secondary identifiers. Show one or two sentences with the actual result, any material limitation, and direct artifact links. Keep technical evidence and the native conversation available through Details. A result must distinguish locally tested, merged, released and installed states.

This example reflects Session 5's saved final report. Its commit `c4195d9` was found in the recorded origin/main ancestry, merge `97f6ee8` exists, and the lane worktree was clean. No fresh remote fetch or independent note recount was performed in this check.

## Interaction and session lifecycle

- An informational card can leave the attention list when its report/link is opened or it is dismissed. Do not infer that the user read a document merely because the OS accepted an open request. Retain the result in searchable history with an undo/reopen path.
- Opening an approval or blocker card does not resolve the decision. Only its explicit action or independently verified resolution clears it. A failed action leaves it actionable.
- Completion is an evidence-based agent decision, not a quiet terminal, process exit or timer. Persist the result and continuation identity before closing a completed pane. Ensure no active task, queued prompt, pending decision or unpreserved work is abandoned.
- Sleep and close are quiet housekeeping. No user-facing cooldowns or arbitrary inactivity countdowns decide completion. Preserve native history and owned work; removing a pane is separate from deleting data.
- Bind events and actions to stable native/session/objective identifiers. Sidebar numbers change when panes close. Validate current action state before accepting an approval or closing a pane.
- Keep notification state durable across GuardDeck restarts. Showing a card is not an acknowledgement. Deduplicate repeated delivery of the same result without suppressing a genuinely revised outcome.

## Existing foundations and gaps

PaneForge's `src/main/index.ts` raises native ask, stalled and attention notifications. Their click handlers largely focus PaneForge rather than open the deliverable. These hooks are useful signals, but idle/attention does not establish task completion.

GuardDeck already has Swift UI, notices and review infrastructure. `ReviewPanel.swift` is a disk-cleanup workflow with cleanup commands and expiry behavior, so it is not the appropriate result-card contract. Reuse the app's presentation foundations without inheriting cleanup actions or timers. Installed behavior was not exercised in this research pass.

PaneForge Next Stage 1 is complete as a fixture preview at `cc092ee8`, present in recorded origin/master ancestry. Its saved evidence covers 34 headless checks and a current-PaneForge startup smoke. Real provider dispatch, speech, restart durability, migration and installed-host validation remain outside that milestone. The result inbox does not require completing all of Next first.

## Primary-source comparison

- [Apple actionable notifications](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions): supports handling responses and actions from notifications. Native delivery can point into a richer GuardDeck result surface. Retrieved 2026-09-20; publication date unknown.
- [Linear Inbox](https://linear.app/docs/inbox): separates priority notifications and read/unread state, and supports snoozing and removing notifications. Its documentation explicitly says it does not currently support notification archiving. Borrow the attention triage distinction; searchable result history and evidence-based session closure are our proposed behavior, not claimed Linear features. Retrieved 2026-09-20; publication date unknown.

The design recommendation is an inference from these patterns and Robert's stated workflow. Reduced interruptions and safe autonomous closure still need observed product tests.

## Implementation acceptance cases

1. A requested deliverable produces one card containing its real report and direct link without opening PaneForge.
2. Merely idle, sleeping and closed sessions produce no result card.
3. A clicked informational result leaves the attention list and remains recoverable after restart; a failed link launch remains visible.
4. Viewing an approval does not approve it; stale or repeated actions cannot execute twice.
5. A verified completed session can close quietly after its report is durably saved; pending work or unsaved ownership prevents closure.
6. A remote result identifies its source machine and remains actionable on the Mac even if the remote device later disconnects.
7. Existing guards remain authoritative; the new UI does not silently grant publishing, spending, deletion or credential authority.
