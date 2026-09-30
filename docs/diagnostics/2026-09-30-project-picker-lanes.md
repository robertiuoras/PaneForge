# Project picker and lane audit, 30 September 2026

Observed at 08:15:40 UTC (18:15:40 Brisbane), from the installed PaneForge `pf call projects:list`, `pf list`, and local Git metadata. This is a point-in-time inventory, not a claim that other sessions have finished.

`research-lab-d` is a standalone clone on `lane-d`, not a registered linked worktree. Its own `.git` directory made the installed classifier offer it as an independent project. Its origin is the canonical research-lab remote, its HEAD is `375fc2568263c6485b975f371f30a13ff19d3d78`, and that commit is contained in current canonical HEAD. It was clean and had no separate open PaneForge pane. This proves a classification exception, not unfinished research or an active conversation. The folder has been preserved.

The installed project list is freshly enumerated from filesystem folders; there is no authoritative stale picker-registry entry to remove. Existing `checkoutOf` rows already sit behind the default-collapsed copies control in `NewSessionDialog`. Source changes in this branch classify a standalone `<project>-<letter>` clone only when its branch is exactly `lane-<letter>` and its nonempty origin matches the existing canonical sibling. Origin comparison strips only a trailing slash and `.git`; it preserves protocol, host, user, and path identity. Independent clones on other branches, other remotes, or missing metadata remain visible. Explicit copy paths and client roster rows remain available.

## Scope and ownership

The audit measured **51 related folders**, across 13 canonical projects. Fifty already had `checkoutOf`; `research-lab-d` was the single independent-clone exception. The earlier rough count of 50 omitted the research UI routing worktree created during this task. The isolated picker-fix worktree is outside this snapshot.

A Git worktree, an open pane, unmerged commits, and dirty files are separate states. The table compares local lane HEAD against **current local canonical HEAD**, not origin or release state. Counts are folders; dirty counts are folders with changes, not changed-file totals. Open-pane absence cannot prove inactivity: the current research task's worker owns `research-lab-ui-routing-20260930` (native thread `01a0f15f-8b8c-7480-8c54-4e99f619f31b`), and this task is continuing the lean-agent work in `research-lab-b`. Both are preserved. Other work may run through native sessions or the lane coordinator without a distinct PaneForge pane.

| Canonical project | Related folders | Unmerged HEADs | Dirty folders | Folders with open panes |
| --- | ---: | ---: | ---: | ---: |
| claude-memory | 2 | 2 | 1 | 0 |
| taskdriver.ai | 6 | 6 | 4 | 3 |
| guarddeck | 4 | 2 | 1 | 0 |
| PaneForge | 9 | 3 | 8 | 0 |
| assistant | 5 | 2 | 3 | 0 |
| taskdriver-mobile | 2 | 0 | 0 | 0 |
| research-lab | 8 | 4 | 1 | 0 |
| toolstash | 4 | 0 | 2 | 0 |
| Car | 1 | 1 | 1 | 0 |
| paneforge-next | 4 | 2 | 1 | 1 |
| clients | 4 | 2 | 0 | 3 |
| ai-viral-content-intelligence | 1 | 1 | 1 | 0 |
| brandsmadeknown | 1 | 0 | 1 | 0 |

`research-lab-b` has three unmerged commits (`5a83da0`, `9be47d4`, `9deffc0`) and five dirty paths in the lean-agent experiment. The agency-caller, guarddeck-bug-workflow, and leads worktrees each have one unmerged commit. The clean/contained research copies are not evidence of disposable folders, especially the active UI routing worker. PaneForge has three unmerged branch HEADs and eight dirty folders. Taskdriver has six unmerged branches; active client panes are also present in clients-b/c/d. None was closed, reset, pruned, or deleted.

## Change and verification receipt

Owned branch: `fix/picker-lane-clones-20260930`, in `PaneForge-picker-20260930`, based on `bf5dca5e8c6be86677fd8ca30cfe77d73e017f31`.

Source checkpoint: `6dac9bb3`. Changed `src/shared/checkout.ts` (classification), `src/main/projects.ts` (HEAD/origin metadata parsing), and `scripts/projects-test.mjs` (five added classification/discovery assertions). Existing client-roster, ordinary clone, linked-copy, and explicit-path coverage remains. The diff was inspected, approved by the parent, and `git diff --check` passed.

Direct Mac typechecking was denied by the GuardDeck queue requirement, so it was not bypassed. One normal PC snapshot verification was submitted with `npm test -- projects projectroute projectfolder`; that path includes typechecking before the focused suites. Job: `1dcbd452-f764-4eab-a6c0-7cbad3863234`. Its final receipt was retrieved by the parent from the existing streaming observer: **succeeded**, two minutes running after eleven minutes queued, peak memory 1.0/8.0 GB. No duplicate check was submitted.

The receipt ran and passed both TypeScript configurations:

```sh
tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
```

Its suite output was:

```text
ok projectfolder 0.4s
ok projects 14.1s
2 tests passed in 14.2s
```

The count is two suites, not three. `scripts/test-all.mjs` selects registered suite names by substring and only errors when none match. There is no registered `projectroute` suite, so that extra selector matched nothing. `scripts/project-route-test.mjs` exists separately; it tests first-message scoring and alias extraction in unchanged `projectRoute.ts` and `projectAliases.ts`, using its own project fixtures. It does not exercise the changed checkout classifier or project discovery. Therefore this was an unnecessary unmatched selector, not missing coverage of a changed path: `projects` exercised classification, disk discovery, independent-clone preservation, client rows, and explicit paths; `projectfolder` checked canonical folder opening. No further check was submitted.

The source checks are verified; the branch remains unmerged. Coordinator readback showed `release: merge`: `ready` calls `autoship`, whose ship path takes a remote release lock and can push. This custom branch has no configured pool slot, lane i belongs to an active peer, and lane h is already ready. No coordinator operation was invoked under the parent's no-push/no-displacement scope. Other dirty lane work and the main checkout's unrelated `.lanes.json` edit remain preserved. No release or installation is authorized by this request.

The installed app still shows the observed classification defect. No runtime registry cleanup was applied. A later authorized release/install and picker readback are required to claim the user-facing fix is running. This report does not claim a new build, release, installation, or live UI verification.

## Per-folder snapshot

| Folder | Branch | HEAD vs canonical | Unique commits | Dirty paths | Open panes |
| --- | --- | --- | ---: | ---: | ---: |
| claude-memory-b | lane-b | unmerged | 18 | 1 | 0 |
| taskdriver.ai-f | lane-f | unmerged | 9 | 3 | 1 |
| guarddeck-a | lane-a | contained | 0 | 2 | 0 |
| taskdriver.ai-a | lane-a | unmerged | 5 | 0 | 0 |
| taskdriver.ai-c | lane-c | unmerged | 6 | 7 | 1 |
| PaneForge-a | lane-a | unmerged | 5 | 25 | 0 |
| PaneForge-b | lane-b | unmerged | 9 | 2 | 0 |
| PaneForge-c | lane-c | contained | 0 | 36 | 0 |
| PaneForge-d | lane-d | contained | 0 | 3 | 0 |
| PaneForge-f | lane-f | contained | 0 | 1 | 0 |
| PaneForge-g | lane-g | contained | 0 | 15 | 0 |
| PaneForge-h | lane-h | unmerged | 2 | 0 | 0 |
| taskdriver.ai-g | lane-g | unmerged | 4 | 6 | 0 |
| assistant-a | lane-a | contained | 0 | 4 | 0 |
| assistant-b | lane-b | contained | 0 | 786 | 0 |
| taskdriver-mobile-a | lane-a | contained | 0 | 0 | 0 |
| taskdriver-mobile-b | lane-b | contained | 0 | 0 | 0 |
| research-lab-b | lane-b | unmerged | 3 | 5 | 0 |
| research-lab-d | lane-d | contained | 0 | 0 | 0 |
| taskdriver.ai-b | lane-b | unmerged | 6 | 23 | 1 |
| toolstash-a | lane-a | contained | 0 | 1 | 0 |
| toolstash-b | lane-b | contained | 0 | 4 | 0 |
| toolstash-c | lane-c | contained | 0 | 0 | 0 |
| toolstash-d | lane-d | contained | 0 | 0 | 0 |
| Car-a | lane-a | unmerged | 1 | 1 | 0 |
| paneforge-next-a | lane-a | contained | 0 | 24 | 1 |
| paneforge-next-d | unknown | unmerged | ? | ? | 0 |
| clients-a | lane-a | contained | 0 | 0 | 0 |
| clients-b | lane-b | contained | 0 | 0 | 1 |
| clients-c | lane-c | unmerged | 8 | 0 | 1 |
| clients-d | lane-d | unmerged | 4 | 0 | 1 |
| guarddeck-b | lane-b | contained | 0 | 0 | 0 |
| ai-viral-content-intelligence-a | lane-a | unmerged | 2 | 17 | 0 |
| PaneForge-e | lane-e | contained | 0 | 12 | 0 |
| assistant-client-archive | fix/client-archive-open-todos | unmerged | 2 | 0 | 0 |
| assistant-g | lane-g | unmerged | 4 | 1 | 0 |
| assistant-upwork-fallback | fix/upwork-draft-account-fallback | contained | 0 | 0 | 0 |
| brandsmadeknown-a | lane-a | contained | 0 | 1 | 0 |
| claude-memory-chrome-guard | fix/chrome-guard-live-tabs | unmerged | 1 | 0 | 0 |
| guarddeck-drive | fix/drive-organiser-restore | unmerged | 8 | 0 | 0 |
| guarddeck-result-review | result-review | unmerged | 5 | 0 | 0 |
| PaneForge-i | lane-i | contained | 0 | 17 | 0 |
| paneforge-next-agent-f977d2f7d9232107-1 | paneforge/agent-f977d2f7d9232107-1 | contained | 0 | 0 | 0 |
| paneforge-next-phone | phone-gateway | unmerged | 15 | 0 | 0 |
| research-lab-agency-caller-20260930 | research/agency-caller-20260930 | unmerged | 1 | 0 | 0 |
| research-lab-guarddeck-bug-workflow | research/guarddeck-bug-workflow-20260930 | unmerged | 1 | 0 | 0 |
| research-lab-leads | research/lead-evidence-20260929 | unmerged | 1 | 0 | 0 |
| research-lab-lean-agent-tree | research/lean-agent-tree-20260930 | contained | 0 | 0 | 0 |
| research-lab-plugin-opportunity | research/plugin-opportunity-20260930 | contained | 0 | 0 | 0 |
| research-lab-ui-routing-20260930 | research/ui-routing-20260930 | contained | 0 | 0 | 0 |
| taskdriver.ai-fix-admin-todos | fix/admin-todos-flicker-narrow | unmerged | 3 | 0 | 0 |
