# Agentic development and delivery pipeline

Research baseline, 13 September 2026. This proposes the development system for [PaneForge's assistant platform](assistant-platform-plan.md). It does not configure runners, launch agents, change workflow permissions or authorise releases.

## Decision

Use a **trusted local development worker running subscribed Claude/Codex**, isolated worktrees, reproducible test environments and an ordinary CI verification gate. Extend the existing lane/dispatcher machinery before adding another scheduler. The agent may investigate, implement and test authorised improvements; a recorded policy determines merge and release authority. Unattended discovery queues proposals unless that class of repair was already authorised.

The improvement loop is: observe a real problem → reproduce it → define the acceptance check → make a bounded change → run independent checks → review the experience → merge the verified candidate → release within authority → check the delivered behaviour. A new model, skill or prompt is a candidate change subject to the same regression process.

## What exists today

Read-only inspection of this checkout established these useful foundations and gaps:

| Existing surface | What it establishes | What it does not establish |
| --- | --- | --- |
| `.github/workflows/release.yml` | Tag/release/manual packaging, typecheck, Mac/Windows build jobs, asset handling | No pull-request trigger or `npm test` step in this workflow; live branch protection was not inspected |
| `scripts/test-all.mjs` | Deliberately windowless, networkless, no-real-agent fast suite | It excludes the live UI suites; a passing default test run is not visual proof |
| `scripts/ui-lab.mjs` and `ui-lab-test.mjs` | Owned headless/offscreen app, checkout identity check, viewport/region controls, actual CDP PNG capture and smoke assertions | Native window chrome, focus, installed-app behaviour or good design |
| `scripts/window-shot.mjs` | Actual macOS window image without raising its window | Needs an on-screen window and Screen Recording permission; largest-window owner heuristic is not reliable identity for many instances |
| `scripts/shots.mjs` | Separate profile, real PNGs and presentation scenarios | Some scenarios launch real PTYs/CLIs, so they are unsuitable as deterministic routine CI fixtures |
| Geometry/source tests | Useful layout arithmetic, plumbing and source invariants | They do not render CSS or examine pixels |

There is no first-class golden-image comparison or structured screenshot-to-review manifest in the inspected paths. Build on the headless UI lab, with seeded fake sessions and deterministic tool responses. Do not replace valuable unit checks with expensive agent screenshots.

## Subscription execution and trust

Codex supports noninteractive execution, structured events, resume and image input. Its documented ChatGPT-managed CI authentication workflow explicitly excludes public/open-source repositories.[^1] Claude Code supports headless operation and image-file analysis, but `--bare` skips subscription OAuth/keychain authentication and expects API authentication.[^2][^3]

Proposed arrangement:

1. The local broker accepts an owner-authorised task with a repo, base commit, allowed paths/effects and resource budget.
2. A logged-in subscribed CLI plans and edits in an isolated lane. Record the native conversation ID and actual provider route.
3. Candidate code, dependency installs and tests run without subscription credentials, unrelated secrets or personal files. A worktree alone is not a security sandbox.
4. Public CI receives source and scrubbed fixtures only. It performs deterministic verification in isolated jobs. It has no personal Claude/Codex login and no access to the desktop worker.
5. A trusted review step consumes the resulting diff and evidence, then a separate release path receives signing/deployment authority when appropriate.

A public issue or pull request is untrusted input, even if it looks like a helpful bug report. It cannot directly dispatch a privileged local job. Do not export `auth.json` into public CI or expose a credential-bearing self-hosted runner to arbitrary PR code. GitHub documents the persistence and credential risks of self-hosted runners.[^4]

Before relying on any provider route, run a separately authorised bounded qualification: remove ambient backend API credentials from the child environment, confirm the intended subscription identity, make a small real request, supply one fixture image, test the required MCP/shell tools, resume/cancel, and inspect quota/error handling. Qualify direct CLI, App Server and ACP separately. A successful CLI route does not prove an adapter preserves its features. On quota/auth failure, use the other eligible subscribed pool or defer; no silent API fallback.

## How agents see and improve the app

The [efficient observation design](efficient-ui-observation.md) makes structured assertions and scoped state the default. Screenshots are selected visual checkpoints, not an observation after every action. It also specifies token/latency measurement and terminal/canvas blind spots.

Use three proof layers. First, fast semantic assertions check actual state and interactions. Second, headless renderer screenshots let an image-capable subscribed agent inspect the visible result. Third, targeted native-platform tests establish shell, focus, permissions, packaging and installed behaviour. These answer different questions.

Codex's image input and Claude's documented file-image workflow make screenshot review feasible.[^1][^3] A screenshot is not continuous screen control. The model receives a captured artifact; an explicitly owned driver performs interactions, then captures the resulting state. Prefer DOM/accessibility selectors and application contracts over coordinates. Native capture/control uses the desktop ownership protocol and fresh target identity. Routine development stays headless; physical desktop checks follow existing authority.

Each capture should retain task/run ID, base/candidate commit, fixture version, app binary/version, device/OS, profile, driver, viewport, scale, theme, fonts, timestamp, redaction status and file hash. Link the screenshot to its scenario/assertions and reviewer verdict. Capture before/after states of the same fixture. Preserve private originals only within retention rules; scrub outputs before public CI, issues or documentation.

Evaluate concrete journeys: find the active session, recover a disconnected worker, answer a question, inspect an error, switch tasks, understand cost/device placement and review completed work. Assess hierarchy, legibility, spacing, keyboard access, focus order, loading/error states, narrow layouts, reduced motion and action clarity. The agent must tie each proposed visual change to an observed defect or agreed design direction. Aesthetic scores alone do not authorise redesign.

Playwright provides planner, generator and healer agent workflows for both Claude and Codex. Its healer may mark a test skipped when it considers a feature broken.[^5] Therefore a healer must not turn a product defect green by skipping a test, weakening an assertion, changing the expected result or accepting a new screenshot baseline. Such changes require an explicit reviewed explanation. Keep held-out acceptance tests and release rules outside the optimiser's writable scope.

Use a small stable screenshot baseline set, with fixed browser/OS/fonts/theme/viewport/data/clock. Pixel differences are sensitive to environment; review intentional changes separately.[^6] Attach traces when interaction fails.[^7] Automated accessibility checks catch some issues; keyboard and assistive-technology journeys remain separate evidence.[^8]

For the Tauri spike, current Tauri documentation recommends an embedded WebDriver service that supports macOS, Windows and Linux. The older direct native driver has narrower platform support.[^9] Evaluate the actual installed versions before selecting the harness. Test plugins expose powerful commands: compile them only into test/debug builds, bind their transport narrowly, and verify that release artifacts omit them.[^10] A browser-only React test does not prove Tauri IPC, PTY or app lifecycle behaviour.

## Development roles and resource limits

These are responsibilities, not a requirement for a permanent fleet of agents:

| Responsibility | Inputs | Required output |
| --- | --- | --- |
| Triage | User report, failed journey, scoped telemetry | Reproduction, impact, proposed scope and acceptance condition |
| Implementer | Approved task, isolated lane, current source | Small coherent diff, checks and preserved unrelated work |
| Test author | Behaviour contract and reproduction | Meaningful regression/scenario test, including failure paths |
| Reviewer | Exact candidate diff, tests, screenshots, constraints | Findings tied to evidence; explicit missing proof |
| Release controller | Verified candidate and existing authority | Artifact identity, delivery state, rollback/readback evidence |

Use one worker by default, add bounded parallel work only for independent tasks. Review is not independent merely because another model repeats the implementer's summary: give the reviewer the actual source, acceptance contract and artifacts. Queue heavyweight builds, browser runs and model workloads under one device budget. Keep the Mac interactive; place eligible compute on the PC without pretending remote execution removes local rendering/transport costs.

## Verification gates

| Gate | Required evidence | When |
| --- | --- | --- |
| Fast source | Typecheck, relevant unit/contract tests, diff hygiene, secret/dependency checks appropriate to change | Every candidate |
| Behaviour | Reproduction and meaningful regression; deterministic service/tool fixtures | Changed workflow/backend |
| Experience | Seeded interaction checks, critical screenshots, image review, accessibility checks | UI changes |
| Native integration | PTY lifecycle, IPC, file dialogs, permissions, multiple windows and platform behaviour | Desktop boundary changes |
| Recovery and load | Disconnect/restart/cancel races, duplicate messages, bounded logs/scrollback, memory/process trend | Orchestration/resource changes |
| Release | Exact merged SHA, signed package/update validation, migration/recovery checks | Authorised release |
| Delivered behaviour | Installed version/commit and changed path exercised | Before claiming the update works for users |

Check the actual merged candidate if the base changed. Store a compact run manifest linking commit, task, provider session, test results, screenshots, reviewer findings, budget usage and authority. State `failed`, `skipped`, `not_run` and `passed` distinctly. CLI exit success, an app boot, or a screenshot file over a size threshold is not task completion.

Bound autonomous repair by attempts, elapsed time, provider quota, API allowance and device resource use. Repeated identical failures trigger diagnosis and a proposal, not endless retries. Stale observations require fresh state before another UI action. Unexpected external effects stop the affected path for reconciliation.

## Self-improvement without losing control

Maintain separate candidate and stable versions of prompts, skills, routing, retrieval and runtime code. Use representative real tasks with private data removed, plus held-out failures and adversarial inputs. Compare task success, grounded evidence, interventions, latency, token/usage route, memory, retries and effect errors. An improvement must meet the same correctness bar before efficiency matters.

The optimiser cannot modify its budgets, approvals, benchmark answers, held-out tests, release gates or pass criteria. New feature ideas enter a backlog with a concrete user benefit; unattended jobs do not expand the product arbitrarily. Promotion records the exact diff and rollback target. Updates wait for a safe task checkpoint or run alongside a compatible engine; they must not kill active PTYs or silently replay side effects. Schema migrations need compatibility planning because reverting a binary alone may not revert data.

## First implementation package, once authorised

Prepare one local subscribed worker qualification, one deterministic UI fixture with image review, one real backend regression, and one disconnect/restart fixture. Add the PR verification workflow without credentials. Demonstrate the full proposal-to-reviewed-candidate path, including a deliberate failing test that remains failed. Only then expand coverage and scheduled improvement frequency. This is the smallest useful demonstration of the requested self-developing system.

## Shared preview and desktop UI decision

Use the same React component source, design tokens, local fonts/assets and motion
code in the browser review build and the Tauri app. The existing standalone HTML
designs remain concepts until converted; they are not already shared app components.
Keep the first preview small: companion activation, Agent / Code / Chat switching,
appearance colours and a file-search result. Reuse actual component props/events
with synthetic task data. Mock only the desktop/tool boundary, never maintain a
second copy of the visual implementation. No general plugin framework is needed.

Tauri runs HTML/CSS/JavaScript in the platform WebView: WKWebView on Mac and
WebView2 on Windows. Therefore shared source gives close visual/interaction
parity, not a guarantee of identical pixels or performance. Font rendering, blur,
GPU/canvas effects, device pixel ratio, input handling and WebView versions require
checking. Safari/WebKit is the closer Mac browser preview; browser-engine testing
still does not replace the packaged WKWebView build.[^10]

For each candidate update:

1. Build the shared React preview with fixed viewport, fonts, locale, fixture seed
   and motion timestamps. Test keyboard navigation, accessible names, overflow,
   empty/loading/error states and reduced motion before image review.
2. Capture selected meaningful states and a short interaction recording for motion
   changes. Keep separate visual baselines per engine/OS; do not compare Mac text
   pixels directly against Linux Chromium. Record SHA, scenario, engine/version,
   viewport, pixel ratio, theme, reduced-motion setting and artifact paths.
3. A subscribed CLI reviewer reads the changed regions and runtime trace. It must
   identify a specific observed defect or improvement against the task rubric.
   It cannot approve its own baseline replacement or override failing assertions.
4. Run the same journeys in an isolated Tauri Mac candidate. Verify real event
   delivery, resize, scaling, streaming terminal output, sleep/resume and recovery.
   Measure frame times and memory under load; attractive browser motion alone is
   not native performance evidence. Add Windows proof before Windows distribution.
5. Present before/after images and the clickable preview together in the existing
   design gallery, with known limitations. Taste changes get Robert's review;
   release stays within the separately recorded release authority.

## Image-led design exploration and demos

Use GPT Image 2.5 for visual decisions: workspace composition, companion appearance,
material/lighting studies and storyboard frames. Current official API identifiers
are `gpt-image-2.5-sunburst` and `gpt-image-2.5-flare`; the selected runtime must
actually expose the requested model before claiming it was used.[^11]

Start each exploration with one design question, the current screenshot and fixed
constraints: PaneForge name, orange default with matching theme logo, one sidebar,
compact companion above Agent / Code / Chat, recognisable provider marks and ample
working space. Prepare four clearly different directions in a contact sheet with
the same sample content and viewport. Refine Robert's selected direction using
the existing reference instead of generating endless unrelated screens.

Keep the generated concept, implemented browser preview and native capture visibly
labelled. Generated pixels establish a direction, not a completed feature or a
golden test baseline. Translate the chosen concept into the shared components;
build animation as CSS/SVG/React motion and record it from the runnable preview.
Storyboard images can guide a demo video, but do not prove actual interaction.

Use included image-generation tools when the active product explicitly provides
them. Do not assume a CLI command makes image generation subscription-funded:
the Image/Responses API is separately billed. For an API route, require an approved
image allowance; record actual model, quality, dimensions, usage and estimated cost.
No automatic image generation on every commit and no paid generation in PR CI.

## Concrete CI implementation order

The pipeline above is planned, not installed by this reconciliation. This checkout
currently has release packaging only under `.github/workflows/release.yml`.

1. Add `.github/workflows/verify.yml` for pull requests and integration-branch pushes:
   checkout without persisted credentials, pinned Node version, `npm ci`,
   `npm run typecheck`, the existing fast suite and a frontend build. Use read-only
   repository permissions and no subscription/API/signing secrets. Prove the job
   on a real candidate and a deliberately failing branch before calling it a gate.
2. Add the first shared-component fixture and a headless preview check alongside
   existing UI-lab tooling. Upload its structured receipt, selected captures and
   failure trace even when assertions fail. Existing screenshot scripts containing
   real CLI/PTY launches are not deterministic PR fixtures.
3. Connect the existing local dispatcher to one authorised improvement request.
   Record base SHA, scope, acceptance check, provider/session and budget. The worker
   returns a candidate diff; ordinary CI checks it independently. A failing gate
   permits bounded diagnosis, not weakened tests or unlimited retries.
4. Show a single review entry with the issue, change, test results, before/after,
   interactive preview, usage and rollback commit. Add scheduled proposal discovery
   only after this complete path works. Extend the existing scheduler and surface
   jobs in Taskdriver's Agents tab rather than adding another daemon.
5. Configure required-check protection and release promotion only within authority.
   A workflow file alone does not prove branch protection or an automatic updater
   is safe. Preserve active tasks and verify the delivered version after release.

## Sources

[^1]: OpenAI, [Non-interactive Codex](https://learn.chatgpt.com/docs/non-interactive-mode); installed `codex exec --help` also exposes image input and structured output. No real provider request was made in this research.
[^2]: Anthropic, [Run Claude Code programmatically](https://code.claude.com/docs/en/headless).
[^3]: Anthropic, [Common workflows, working with images](https://code.claude.com/docs/en/tutorials).
[^4]: GitHub, [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).
[^5]: Playwright, [Test agents](https://playwright.dev/docs/test-agents).
[^6]: Playwright, [Visual comparisons](https://playwright.dev/docs/test-snapshots).
[^7]: Playwright, [Trace viewer](https://playwright.dev/docs/trace-viewer).
[^8]: Playwright, [Accessibility testing](https://playwright.dev/docs/accessibility-testing).
[^9]: Tauri, [WebDriver](https://v2.tauri.app/develop/tests/webdriver/).
[^10]: Tauri, [Process model](https://v2.tauri.app/concept/process-model/).
[^11]: OpenAI, [Image generation](https://developers.openai.com/api/docs/guides/image-generation), checked 13 September 2026. No image API call was made in this reconciliation.
[^10]: WebdriverIO, [Tauri plugin setup](https://webdriver.io/docs/desktop-testing/tauri/plugin-setup/).
