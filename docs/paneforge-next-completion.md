# PaneForge Next completion

Robert authorized full implementation and a release on 2026-09-21 in native session
`01a0bdba-42cf-7293-a856-a908482746ea`. This supersedes the Stage 1 scope limit in the
historical implementation checkpoint. Existing session data and native identities must
remain recoverable. Claude is unavailable for this work; no paid fallback is authorized.

## Ordered acceptance plan

1. Release the merged Review and quiet notification work. Verify both platform assets,
   update-feed hashes and GuardDeck's installed revision. This release does not claim the
   full Next replacement is finished.
2. Reconcile the existing standalone Next supervisor with the new workspace renderer.
   Reuse real provider/session transport, persistence and terminal ownership.
3. Prove chat creation, watched output, follow-up to the same native conversation, and
   direct CLI input in an isolated profile. Preserve drafts on rejected requests.
4. Resolve model and effort from observed capabilities and available included usage.
   Test unavailable/exhausted providers, unknown usage, requested versus confirmed values,
   and no silent paid fallback. Reuse researched prompt composition and explicit success
   criteria rather than inventing a second prompt system.
5. Integrate durable recent-work review, original request, output/evidence, links and reply.
   Opening an informational result acknowledges it; decisions remain pending. Reconnect
   and restart must preserve results and prevent duplicate submission.
6. Retire completed live sessions only after a saved report and validated safe boundary.
   Busy work, new input, unresolved decisions and uncertain completion must be preserved.
   Quiet background lifecycle transitions require no countdown or routine notification.
7. Complete the existing migration, packaging and platform acceptance gates in the
   voice-first contract, with actual installed and workload evidence distinguished from
   fixture tests. Preserve current PaneForge as the recovery path.

App code and native dependencies still require delivery of an update. Runtime workflow
and prompt changes can avoid a native rebuild only where the existing architecture
supports loading and validating them independently. Verify that boundary before promising
update-free workflow management.

## Current evidence

Review feature commit `ae684d17` and daily-review work are merged. Release publication,
the complete live Next integration and installed platform gates remain pending. The
Stage 1 evidence documents its fixture scope; it is not replacement acceptance.
