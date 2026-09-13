# PaneForge: three interaction directions

Open [the comparison gallery](gallery.html) to select and scrub the three directions. [The silent MP4](paneforge-directions.mp4) demonstrates the same fictional task in each layout. These are authored visual prototypes, not a functioning assistant or measured performance demo.

| Direction | Main advantage | Tradeoff |
| --- | --- | --- |
| [Quiet workspace](option-1.png) | Calm task detail and evidence beside the work | Less expressive; parallel work needs a separate overview |
| [Focus companion](option-2.png) | Conversation and deliverable canvas stay together | Less room for dense technical sessions |
| [Mission canvas](option-3.png) | Spacious stages make work coordination visible | Can become noisy if every worker gets a permanent card |

Recommended starting direction: Quiet workspace with the Focus companion conversation/canvas interaction. Keep Mission canvas as an alternative to test, not an automatic third implementation requirement. All can use a compact global command surface. Phone concepts prioritise status, steering and review; native desktop sign-in remains on the desktop.

The 42-second study shows context, a sign-in wait, then a private proof pack. This is an accelerated sequence of simulated states. It does not represent task execution speed. Voice bars are visual placeholders; the video has no generated voice audio. A muted microphone is not the same as ending a billed session. Ending voice does not cancel durable work.

## Competitor research

Primary-source interface documentation reviewed on 2026-09-13:

- [Linear](https://linear.app/): subdued navigation and a durable task record. Borrow clear status, provenance and review evidence.
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) and [parallel agents](https://zed.dev/blog/parallel-agents): threads, steering and changes beside the editor. Provider capabilities can differ.
- [Warp](https://www.warp.dev/ai): natural language and commands share an entry point, with attached context. Preserve the actual terminal separately.
- [Raycast](https://manual.raycast.com/quicklinks): compact command search and discoverable actions. Do not hide pending approvals there.
- [Claude Cowork](https://claude.com/blog/cowork-web-mobile): desktop depth and phone continuity. [Computer-use guidance](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork) prefers direct connectors where available.
- [Codex](https://openai.com/codex/): parallel work, worktrees and skills. PaneForge's provider-neutral session behaviour still needs qualification.

These are pattern references, not copied assets or a claim that one product implements our entire vision. The supplied YouTube reference has not been visually verified at its four-minute mark in this pass.

## Tauri and React decision

PaneForge already uses React. Keeping React preserves components and UI expertise; it is not a new advantage over Electron. Both shells can present these designs and animations.

[Tauri](https://v2.tauri.app/concept/architecture/) uses the operating system webview and a Rust host, avoiding Electron's bundled Chromium runtime. That can reduce distribution size and shell overhead. It does not establish a specific RAM saving or cure leaks, excessive terminal history, synchronous work or runaway child agents. [Electron's process model](https://www.electronjs.org/docs/latest/tutorial/process-model) also supports separate processes; isolation is an implementation decision.

Proposed sequence: preserve the React/xterm interface and existing TypeScript worker logic, prototype a Tauri host, then compare the same sessions and data against Electron. Measure the entire process tree, memory pressure, input latency, terminal throughput, startup, idle CPU and recovery. Include WebKit compatibility, PTY lifecycle, accessibility, clipboard, permissions, updates and Mac signing; Windows WebView2 follows. [Capabilities](https://v2.tauri.app/security/capabilities/) can scope frontend access but need deliberate configuration.

Do not rewrite the full backend into Rust before the prototype proves a reason. The first migration gate is equivalent behaviour with better measured resource use.

## Reproduce and verify

`build.py` generates the composition and local interactive gallery. The existing pinned HyperFrames 0.7.99 CLI renders it; GSAP 3.14.2 is vendored with its embedded licence header. Run from this directory: `hyperframes check --snapshots --json`, then `hyperframes render --fps 30 --quality standard --workers 1 --output paneforge-directions.mp4` using the pinned package binary.

Validation receipt is [verification.json](verification.json). Visuals and final MP4 require human visual inspection in addition to automated checks. Gallery controls are prototype playback controls; the depicted app buttons are not connected to services.

## Optional identity study

[Names and vector logo concepts](branding/index.html): PaneForge, Fold, Relay and Aven. These are creative sketches, not cleared trademarks or available domains. No rename or installed-icon change is selected. Private use for Robert's projects takes priority; a public identity can be revisited later.

## Updated workspace direction

[Orbital: futuristic workspaces, folders and saved agents](workspace.html) is the newer direction requested by Robert. It includes 108 simulated records, working project/status/search filters, pagination and a selected conversation inspector. No live agents or voice connections are created. The target of 100+ concurrently executing agents still requires staged runtime, provider and resource qualification.

## Personal studio revision

Open `studio.html` for the latest Chat, Work and Code direction, following feedback about artificial counters, colour and orchestration jargon. Astra is a reversible personal-name placeholder. `studio-chat.png`, `studio-work.png` and `studio-code.png` are verified headless previews. Navigation, project switching, clear-view behaviour, mobile width and catalogue integration passed in `studio-verification.json`. All content is simulated; no execution, voice or actual renderer fix is connected. The earlier MP4 illustrates the earlier three directions, not this revision.

### Ember identity refinement

The studio now preserves the real PaneForge icon and carries its ember colour through selected states and actions. Codex and Claude paths come from the existing app; Antigravity uses the official press asset. `assets/brands/README.md` records provenance, with the Lobe Icons licence retained. Provider cards switch their selected state and composer label locally; they do not connect a provider. Typography, layered surfaces, a sample project cover and short hover/selection transitions add identity without continuous animation.
