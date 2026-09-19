# Lanes and pull requests

Use the existing lane queue for authorised local work. Commit and verify in the assigned
lane, then mark it ready. The queue tests the combined changes, merges and pushes them.
PaneForge currently uses `"release": "merge"`: merging does not publish an app update.
Do not open an additional PR for the same lane work.

Use a PR when work comes from an unattended self-heal job, an external contributor,
or a change deliberately awaiting review. A PR is a proposal, not a delivery receipt.
Keep one concrete problem per PR; include the reproduced failure, changed behaviour,
verification and remaining limits. Use a draft while work is incomplete.

## Finish the review

The agent handling a requested PR review owns its disposition during that task:

1. Read the current diff and failure evidence. Check whether the failure still exists
   on current master, and whether another change has already fixed it.
2. Keep useful work. Resolve conflicts against current master and exercise the behaviour.
   No checks is missing evidence, not a pass. Unknown mergeability is not permission to merge.
3. For authorised integration, merge the PR branch into the assigned lane without squashing,
   then use the lane queue. Keeping ancestry lets GitHub recognise the PR as merged when
   the queue pushes master, and avoids a second competing merge path.
4. Verify the remote master contains the PR head and GitHub reports it merged. Only then
   delete its merged remote branch. Never delete an active lane or unmerged work.
5. If the proposal is obsolete and has no useful change, close it with the reason and
   replacement evidence within the authorised PR-management task. Age alone is not grounds
   for discarding work. If blocked, name the missing decision or failing check.

Unattended self-heal remains propose-only. Its scheduled run creates a branch and PR;
it does not review or merge its own output. Review outstanding proposals in Tools →
Waiting on GitHub when handling the morning self-heal digest or a requested health check.
The person/agent taking that review must carry it through integration, a specific blocker,
or a justified closure. Do not equate an automated repair report with verified completion.

## Checks and releases

`Check pull request` runs typechecking, the repository suite and a build on PR changes.
It has read-only repository permission and does not publish artifacts or cut releases.
A conflicting PR may need conflict resolution before GitHub can run the PR workflow.
The lane queue remains the final check of the combined local batch. Review approval,
passing checks, merging, publishing and installing are separate states.

Release authority is still required to cut a version. This workflow does not change
branch protection, enable automatic approval, or turn on unattended merging.

## Incident: PR #1

The 16 August self-heal PR targeted a transient GitHub asset-upload 504. Master already
contained upload retries; the PR added regression coverage only. It stayed open because
the job ended at PR creation, the repository had only release-triggered CI, and no later
review completed its integration. Subsequent test additions conflicted in the two test
registries. Its original commit is integrated through the lane with both registries
preserved; the retry coverage is exercised against the shipping upload commands.

## References

- [GitHub: merging pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request)
- [GitHub: pull request workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
- [PaneForge lane workflow](lanes.md)
