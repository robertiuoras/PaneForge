# Efficient UI observation for agentic development

Research recommendation, 13 September 2026. This refines the [agentic development pipeline](agentic-development-pipeline.md): **structured observations should be the default; images should be deliberate visual evidence.** It is a design proposal, not a measured performance improvement.

## Recommended observation loop

An agent changing our own app has source code, test fixtures and structured runtime state available. Use those advantages. It should not rediscover every control from a fresh image after every click, or receive the entire DOM/accessibility tree after every action.

1. Define the intended behaviour and visible change from the request and current component.
2. Render the affected component or journey with deterministic data in the existing isolated UI lab.
3. Execute the interaction through a semantic locator or the appropriate native driver. Wait for the relevant state/assertion with a bounded timeout.
4. Return a compact result: expected versus actual state, affected control/region, error, relevant geometry and artifact reference if needed.
5. Capture a visual checkpoint when appearance matters, on unexplained rendering failure, or for final acceptance. Review the actual image before declaring the visual result good.

Structured state is usually cheaper to inspect, but its advantage must be measured on PaneForge's tasks. A giant text tree can cost more than a cropped image. Capture cost, model input cost and model reasoning latency are separate measurements.

## Match the observation to the question

| Question | Cheapest useful evidence | When to add images |
| --- | --- | --- |
| Did the requested action complete? | Correlated engine receipt plus expected UI state | The state is correct but presentation looks wrong |
| Can a user discover and activate the control? | Accessible role/name, visibility, enabled state, focus/keyboard sequence | Hierarchy, icon recognition, contrast or visual affordance needs judgement |
| Did this dialog change correctly? | Scoped accessibility snapshot and assertions | New layout, typography, clipping or spacing |
| Is content overflowing or overlapping? | Rendered bounds, scroll/client sizes and targeted hit-testing | Geometry is ambiguous or clipping/z-order/rendering needs confirmation |
| Is interaction slower? | Timed user action, marks/measures and process metrics | Motion/frame presentation is itself the issue |
| Does an icon, image or terminal render properly? | Asset checks and underlying model/transcript plus a crop | Visual confirmation is part of acceptance |
| Does the native app behave correctly? | Native driver/app lifecycle evidence | Titlebar, focus, permissions, compositing or installed window behaviour |

Use role/name locators for meaningful user-facing controls and stable test IDs where identity needs to survive wording changes. Accessibility snapshots describe roles, names and states in a selected region.[^1] They do not prove actual pixels, correct icons, clipping, gradients, font fallback, contrast, animation or canvas content. They also cannot establish that wording makes sense to a person.

Playwright's auto-waiting checks actionability, and retrying assertions can wait for expected UI state.[^2] Prefer those to fixed sleeps or repeatedly asking a model whether the screen changed. A bounded timeout remains a failure with evidence, not an excuse to wait indefinitely. Do not bypass the UI for the interaction being tested: directly changing application state only proves the shortcut.

## CLI, MCP and our own application

Microsoft's Playwright MCP documentation recommends considering CLI + skills for coding agents because concise commands avoid large schema/tree context overhead. MCP remains useful for interactive exploration that benefits from rich live state.[^3] This is a source recommendation, not a PaneForge benchmark.

For routine known journeys, run a deterministic test/CLI scenario and return its compact result to Claude/Codex. Reuse PaneForge's existing UI-lab and CDP helpers first. Add a small observation command only where repeated real callers justify it; avoid a new generic UI framework. A future Playwright CLI integration should earn its place against those working helpers.

For unfamiliar behaviour, use scoped MCP/driver inspection. Load the necessary tools on demand, inspect the affected pane/dialog, and retain larger snapshots outside the model context. A model can ask for a region or artifact when needed. The transport label alone does not determine efficiency: narrow MCP results can also be efficient, and a CLI dumping a whole tree is not.

The proposed application observation surface should expose existing task/pane events, not another source of truth. Correlate action ID → engine receipt → rendered UI assertion. Provide state revision/event sequence with each observation. A delta requires a known base; after dropped events, remount or reconnect, fetch a fresh scoped snapshot. Old element references must be resolved again. Application events cannot claim the user saw a change until the renderer is checked.

Browser techniques cover Electron's renderer and browser tests of React. They do not automatically work inside a Tauri system webview or the native Taskdriver mobile app. Use the selected platform driver for those boundaries and compare equivalent scenarios. Preserve a small real-native acceptance lane even when most checks are headless.

## Improving design without constant image review

Keep an approved design vocabulary: typography, spacing, colour/contrast, component states, motion and navigation patterns. Agents can detect deviations and make consistent local changes through source and rendered-style checks. Numeric consistency is not sufficient design quality, but it reduces avoidable drift.

Use a fixture gallery of actual components/states: session cards, task detail, approval request, offline worker, error, empty/loading states and narrow/mobile presentation. Storybook's interaction-testing approach supports exercising components in controlled states and combining that with visual testing.[^4] Borrow the pattern in the existing UI lab first; adopting Storybook is optional. Render the real shared component, rather than a duplicate mock that can drift from the product.

For a visual redesign, let the agent make a coherent batch of changes against the design brief, then inspect selected before/after crops with enough surrounding context to judge hierarchy. For a behaviour-only change, use state and interaction evidence; add images only when the change affects presentation or a failure suggests it. Avoid arbitrary promises such as every change needing exactly one screenshot.

Example: improving the disconnected-session experience. A deterministic fixture disconnects a fake worker. Assertions establish that the session remains listed, the status changes to offline, the resume action is disabled until reconnect and keyboard focus remains usable. A timed check measures interaction response. One visual checkpoint then judges whether the status is clear and the recovery action is well placed. Repeated screenshot-and-think turns are unnecessary for the predictable steps.

For UX ideas beyond consistency, gather actual task friction: repeated navigation, failed recovery, unclear questions and slow actions. Use scoped opt-in metrics that exclude terminal/brief content. An agent can propose a shorter flow and compare task completion, errors and user feedback. Simulated agents can reveal defects; they do not substitute for Robert's taste or real-user usability evidence.

## Failure diagnostics and performance

On meaningful failures, preserve a trace with actions, DOM snapshots, console/network details and relevant images. Playwright supports failure/retry tracing; avoid always recording expensive traces for every successful run.[^5] Scrub traces as carefully as screenshots because they can contain private content and request data.

Measure pane creation, task switching, terminal scrolling and streamed assistant updates in separate repeatable scenarios. Use browser marks/measures and targeted performance traces for the renderer, with OS/process measurements for the worker, webview and PTY tree. Chrome DevTools documents custom timings and interaction/main-thread diagnostics.[^6] Web page metrics alone do not explain desktop memory pressure, and instrumentation must not create the lag being investigated.

Terminal/canvas is a PaneForge-specific blind spot. Test canonical PTY output and parser/state invariants deterministically, then use a small visual set for ANSI styles, wide characters, selection, scrolling, resizing and cursor placement. A correct transcript does not prove a correct canvas, and a healthy shell process does not prove responsive input. Motion defects need a short controlled recording/frame trace, not just a still.

## Validation experiment

After implementation authority, run the same fixed scenarios with (A) frequent screenshot observation, (B) scoped semantic observations, and (C) semantic observations plus selected visual checkpoints. Include a normal button/state change, offline recovery, narrow layout, a misleading accessible label, canvas/terminal rendering and a purely visual defect.

Record successful defect detection, false passes, human interventions, model calls, exposed token/image usage, wall time, capture overhead and peak memory. Keep provider/model/version and fixtures fixed; repeat enough to expose variation. Any efficiency gain must retain the necessary visual and native defect coverage. No speedup percentage is claimed before this comparison.

## Sources

[^1]: Playwright, [ARIA snapshots](https://playwright.dev/docs/aria-snapshots).
[^2]: Playwright, [Auto-waiting](https://playwright.dev/docs/actionability).
[^3]: Microsoft, [Playwright MCP versus CLI](https://github.com/microsoft/playwright-mcp#playwright-mcp-vs-playwright-cli).
[^4]: Storybook, [Interaction tests](https://storybook.js.org/docs/writing-tests/interaction-testing).
[^5]: Playwright, [Trace viewer](https://playwright.dev/docs/trace-viewer).
[^6]: Chrome Developers, [Performance features reference](https://developer.chrome.com/docs/devtools/performance/reference).
