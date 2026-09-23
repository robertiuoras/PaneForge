# PaneForge Next

Next is being built as the replacement workspace, with a native Tauri host and a Node
supervisor. Replacement acceptance is **not complete**. The installed application,
profile transition, notification/reply journey and native update/recovery still need
end-to-end proof. Keep current PaneForge available until that acceptance is complete.

`npm run server` starts the real supervisor. It can execute provider work and access
the configured session profile; use an isolated test profile for verification. The
native packaging entry point is `node scripts/package-app.mjs --prepare-only`, followed
by the platform's Tauri build. Preparing files or building an installer does not prove
installation, update delivery or successful provider work.

See the [release verification checkpoints](docs/release-verification-20260921.md) for
dated evidence and its limits. The Stage 1 links below describe the earlier fixture
milestone, not the current replacement scope.

## Fixture workspace

A distinct fixture-driven workspace: Live rail, objective-grouped agents, structured timeline, evidence inspector and collapsed raw-terminal takeover. Current PaneForge remains the running application and rollback path.

From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run dev
```

The preview serves on `http://127.0.0.1:4319`. Tests require installed Google Chrome and run headlessly at 1440×1000 and 900×800. The fixture server uses synthetic sessions and performs no provider calls. Live audio transport is simulated; typed global control exercises the same fixture controller behavior. `npm run web` is a separate Vite development entry with the inherited supervisor proxy on port 4317 and is not needed for fixture review.

[Desktop preview](evidence/stage1/desktop-workspace.png) · [Compact preview](evidence/stage1/compact-workspace.png) · [Interaction report](evidence/stage1/report.json) · [Evidence and exact commands](../docs/paneforge-next-evidence.md) · [Resume checklist](../docs/paneforge-next-implementation.md)

These fixture checks prove interactions and layout, not real speech/provider execution,
restart durability, installed Tauri behavior, migration or energy savings. Browser and
rendering verification runs on the designated PC through the existing remote queue;
an unavailable PC is not permission to render on the Mac.

## Real recent-work Review

`npm run review` serves the built Review screen at `http://127.0.0.1:4320/#review`.
It connects to the configured running PaneForge profile through its existing authenticated
Phone transport. Set `PF_USER_DATA` to a specific profile directory when testing.
Credentials stay on the local server. This host only lists saved reviews, marks informational
results reviewed/unreviewed, and opens their saved report links. It cannot start or steer sessions.

The Review screen defaults to the last hour, with Today/All history, original request, outcome,
lane and session identity. Closing a pane preserves this history. Decisions and blockers stay
pending when their report is opened. `npm run test:review` checks the host and browser interactions.
This separate Review connection does not prove the replacement supervisor's live voice
or provider control. See [result contract](../docs/reviews-runtime-contract.md).
