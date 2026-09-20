# PaneForge Next: Stage 1 evidence

Date: 2026-09-20. Scope: deterministic workspace shell only. Batch: `PF-20260920-01`. [Checklist and stop boundary](paneforge-next-implementation.md).

## Session and source identity

| Field | Observed value |
| --- | --- |
| Actual pane | `s16-mu9f6fdf` |
| Assigned cwd / branch | `/Users/robertiuoras/Projects/PaneForge-b` / `lane-b` |
| Native Codex conversation | `01a0bd72-282f-7040-8520-c4eccb43033e` |
| Requested model / effort | No override requested in this task |
| Confirmed implementation model / effort | `gpt-6-astra` / `xhigh`, from native `turn_context`; pane metadata also agrees |
| Starting Git status | Clean |
| Renderer foundation | Prototype commit `0af0748c0978797463a631ef6cbb79d053626381`, read only |

All 479 contract lines were read. An initial 99-file prototype snapshot and broader experiments preceded the narrowed request. Only the fixture shell remains in the commit candidate; backend/migration/host extras are held in ignored `next/.local/deferred-pre-stage1/`. No real application state was copied or migrated. Final candidate: 16 tested source/config/fixture files, a README, nine evidence files and these two documents.

## Proven behavior

Final headless run: **2026-09-20 06:47:09–06:47:56 UTC**, Chrome, isolated contexts, external requests blocked. Both 1440×1000 and 900×800 passed 17 checks each. The complete [report](../next/evidence/stage1/report.json) lists observed requests and assertions.

- Default surface: Live rail, objective groups, timeline and inspector. No terminal is mounted until requested.
- Select, exception/search filters and evidence expansion work. Native IDs remain separate from workspace IDs. Unknown model confirmation stays unknown; requested and confirmed model/effort are displayed separately.
- Raw-terminal opening replays the existing terminal under the selected native session. Control is explicitly claimed. Closing disposes the terminal renderer.
- Disconnect disables dispatch while keeping draft and identity. Reconnect refreshes execution without upgrading proof. Reload restores selection and draft.
- Typed brief and create/rename/brief reuse supervisor endpoint shapes. Typed global control and simulated Live control produce equivalent fixture actions. Ending Live leaves the agent running.
- A rejected brief after creation keeps its draft under the exact returned session, displays the error and does not retry creation.
- Both layouts fit without document overflow and respect reduced motion. Required clean flows have **zero console errors and zero uncaught page errors**. Deliberate HTTP 409 rejection produces one expected resource-error console entry per viewport, recorded separately; no other errors.

These are fixture results, not proof of real GPT Live recognition, provider work, durable exactly-once dispatch, supervisor restart recovery or installed macOS/Windows behavior.

## Exact commands

From `/Users/robertiuoras/Projects/PaneForge-b/next`:

```sh
npm install --package-lock-only --ignore-scripts --no-audit --no-fund > .local/lockfile.log 2>&1
npm exec --yes --package=prettier@3.6.2 -- prettier --write 'src/*.{ts,tsx,css}' 'scripts/*.mjs' 'tests/fixtures/*.json' vite.config.ts tsconfig.json package.json > .local/format.log 2>&1
npm exec --offline --package=prettier@3.6.2 -- prettier --write scripts/verify-voice-workspace.mjs > .local/format-test.log 2>&1
npm run build > .local/build.log 2>&1
npm test > .local/stage1-test.log 2>&1
```

TypeScript and Vite passed. Main JS: 233.01 kB; lazy terminal JS: 292.09 kB. These are build sizes, not energy measurements. [Build output](../next/evidence/stage1/build-output.txt), [test output](../next/evidence/stage1/test-output.txt), [SHA-256 of tested source](../next/evidence/stage1/source-hashes.json).

Final headless verification acquired the coordination guard:

```sh
node /Users/robertiuoras/Projects/claude-memory/claude-config/computer-use-guard.mjs begin-browser --headless 01a0bd72-282f-7040-8520-c4eccb43033e Chrome 20032 'Stage 1 headless fixture verification'
```

Current PaneForge rollback smoke, from `/Users/robertiuoras/Projects/PaneForge-b`:

```sh
npm run try -- --minimized --headless --remote-debugging-port=9537 > next/.local/rollback-smoke-launch.log 2>&1
npm run try -- --minimized --headless --profile=dev-b --keep --remote-debugging-port=9538 > next/.local/rollback-smoke-launch-dev-b.log 2>&1
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { connect } from './scripts/ui-lab.mjs';
import { writeFileSync } from 'node:fs';
const link = await connect('9538');
try {
 const result = await link.evaluate(`(async()=>({url:location.href,title:document.title,ready:document.readyState,rootChildren:document.getElementById('root')?.childElementCount,bodyLength:document.body.innerText.length,profile:await window.api.profile(),apiAvailable:typeof window.api.listSessions==='function'}))()`);
 assert.equal(result.profile,'dev-b');assert.equal(result.ready,'complete');assert.ok(result.rootChildren>0);assert.equal(result.apiAvailable,true);assert.ok(result.url.includes('/PaneForge-b/out/renderer/'));
 writeFileSync('next/.local/rollback-smoke.json',JSON.stringify({at:new Date().toISOString(),result:'passed',...result},null,2));console.log(JSON.stringify(result));
} finally {link.close();}
JS
npm run try -- --close --profile=dev-b > next/.local/rollback-smoke-close.log 2>&1
node /Users/robertiuoras/Projects/claude-memory/claude-config/computer-use-guard.mjs release 01a0bd72-282f-7040-8520-c4eccb43033e
```

Smoke observed `file:///Users/robertiuoras/Projects/PaneForge-b/out/renderer/index.html`, ready state `complete`, a mounted root and actual API profile `dev-b` at 06:48:46 UTC. [Smoke result](../next/evidence/stage1/rollback-smoke.json). No visible window or focus takeover. This verifies existing renderer startup, not its entire regression suite.

## Review artifacts

| View | Desktop | Compact |
| --- | --- | --- |
| Structured workspace | [1440×1000](../next/evidence/stage1/desktop-workspace.png) | [900×800](../next/evidence/stage1/compact-workspace.png) |
| Raw-terminal takeover | [1440×1000](../next/evidence/stage1/desktop-raw-terminal.png) | [900×800](../next/evidence/stage1/compact-raw-terminal.png) |

Screenshots were inspected headlessly. The terminal is collapsed in both default views. The compact inspector moves below the timeline while retaining the Live rail.

## Failures and corrections

- Two early commands used the parent cwd and failed to redirect into missing `.local/lockfile.log` / `.local/build.log`; neither ran. Corrected cwd to `next/`.
- Offline formatter lookup returned `ENOTCACHED`. Fetched pinned `prettier@3.6.2`, then the offline invocation succeeded. No formatter dependency added.
- Visual inspection found unwanted document overflow and a create-failure notice hidden behind the dialog. Fixed containment and placed failed-created-session feedback in the selected workspace. Final tests cover both.
- An earlier 16-check pass was superseded by the 17-check run with rejected-brief identity/draft coverage.
- Bare `npm run try` selected profile `dev`, despite the supplied expectation of `dev-b`. Repeated with explicit `--profile=dev-b`; runtime API confirmed it.
- First smoke assertion incorrectly searched body text for `dev-b` and failed. Corrected to the actual `window.api.profile()`, mounted-root and owning URL checks.
- Peer discovery `pf --help` was unsupported; `pf call listSessions` returned `unknown channel listSessions`. Existing surface mapping supplied the correct `pf call sessions:list`, which succeeded.
- A documentation patch using delete/add for the same path was rejected before any mutation; corrected to an update patch.
- Final deliberate rejection returned HTTP 409 once per size. Recorded separately as expected fault evidence, not hidden in the zero-error claim.

## Changed files and release boundary

Only new files: `docs/paneforge-next-implementation.md`, `docs/paneforge-next-evidence.md`; `next/.gitignore`, `next/README.md`, `next/index.html`, `next/package.json`, `next/package-lock.json`, `next/tsconfig.json`, `next/vite.config.ts`; `next/public/voice-processor.js`; `next/src/{main.tsx,voice.ts,workspace-model.ts,workspace-terminal.tsx,workspace.css,workspace.tsx}`; `next/scripts/{fixture-server.mjs,verify-voice-workspace.mjs}`; `next/tests/fixtures/workspace-v1.json`; nine files under `next/evidence/stage1/` (four PNGs, report, smoke result, source hashes, build output and test output).

Source hashes exclude narrative docs and captured evidence. Existing root source and package files are untouched. Generated builds, dependencies, local logs and shelved experiments are ignored.

Pre-commit readback matched all 16 source SHA-256 values, both passing 17-check reports and all nine evidence files. `git diff --cached --check` passed. The staged change contains exactly the 28 new files listed above, with no existing-file edits.

After the local checkpoint, the supplied lane-ready command is:

```sh
node /Users/robertiuoras/Projects/PaneForge/scripts/lane.mjs ready --repo /Users/robertiuoras/Projects/PaneForge --session 01a0bd72-282f-7040-8520-c4eccb43033e
```

Its actual result and commit hash belong in the batch receipt. This session does not cut a release. No Stages 2–7, real-data migration, auth/payment change, destructive operation or battery-improvement claim is included.
