# Portable native packaging checkpoint

`scripts/package-app.mjs --prepare-only` creates the Tauri resource tree from the current `dist`, `scripts`, `server`, installed `node_modules`, and an explicitly selected Node executable. It writes a SHA-256 inventory and the materialized Git revision plus dirty state at `src-tauri/resources/runtime/runtime-manifest.json`; `runtime-revision.txt` is passed to the supervisor as `PANEFORGE_REVISION`.

The native process runs only `runtime/scripts/start.mjs` from its own resource directory. It supplies loopback port `4321`, `PANEFORGE_DIST_DIR` for the bundled frontend, and `PANEFORGE_DATA_DIR` under the operating system's application-data directory. No bundled path is used for writable state.

Before showing its WebView, the wrapper waits up to eight seconds for `GET /api/health` on loopback. It reuses only a supervisor whose product, materialized revision, and data directory all match; an unrelated or mismatched listener is left untouched and reported as an error.

The wrapper supplies the bundled Node directory first in its child `PATH`, followed by the user and standard Codex CLI locations. This keeps a Finder launch independent of a developer-shell `PATH` while allowing an installed Codex shim to resolve its Node interpreter.

The script refuses a Node executable that links to Homebrew dynamic libraries. A self-contained Node runtime must be supplied through `PANEFORGE_NODE_RUNTIME` before an actual bundle can be prepared. This avoids silently making an installed app depend on the developer checkout or Homebrew installation.

The current macOS candidate uses official Node v24.10.0 for Darwin arm64, downloaded from nodejs.org and checked against that release's SHA-256 manifest before materialization. No package was installed, launched, or tested through a native WebView. Windows packaging remains a separate native build gate.

The local Tauri app bundle must be ad-hoc signed after resource assembly and verified with `codesign --verify --deep --strict`; no Developer ID signing identity is configured for this candidate.
