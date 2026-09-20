# Release verification checkpoint, 2026-09-21

Owner: lane b, native `01a0bdba-42cf-7293-a856-a908482746ea`.

## Parent PaneForge regression checks

On DESKTOP-CMSUCM1, source archive SHA256 `13528f66abfd915672eb84db9a9ebe71ff228e68031c2284e82a1000ec0126fd` passed both TypeScript configurations and 250 of 251 test commands. The sole failure was the kill-guard fixture deriving a synthetic macOS Electron path from a Windows checkout name. Commit `b2a27012` makes the written fixture platform-independent. The focused corrected test then passed all 13 checks on DESKTOP-CMSUCM1 with exit 0. No running application was killed by this fixture test.

Retained logs: `/tmp/pc-release-typecheck-current.log`, `/tmp/pc-release-tests-current.log`, `/tmp/pc-killguard-final-20260921.log`. After integrating lane c, local restore-turn (58), restore-panes, effort (36), and both TypeScript configurations passed. Independent review found the native completion phase is `final_answer`; the parser and regression fixture now recognize it before considering earlier tool activity. This prevents resuming a completed turn when `task_complete` was never written.

The later parent coordinator run was stopped after observing `confirm-fit-test.mjs` executing on the Mac: the parent suite included browser checks but bypassed Next's remote-render wrapper. That run is not acceptance evidence and the earlier PC-only claim must not be applied to it. The parent `test-all.mjs` now routes non-Windows invocations through `scripts/test-remote.mjs` before starting workers. It probes the designated PC, snapshots current source without ignored build output, and fails closed without a local fallback. Missing-transport and shell-metacharacter rejection checks passed locally. The replacement PC run passed both TypeScript configurations and all 251 existing parent test commands in 112.5 seconds; retained log: `/tmp/paneforge-final-remote-suite-20260921.log`. The snapshot was based on `50b2caf7` with the pending routing edits. The new routing regression was added afterward and is tracked separately.

## Next verification

Parent release `v0.8.220` was published as a prerelease from `e345a44390ca20299138385e061f262d036a216c`. GitHub workflow `35526684973` passed both platform builds. The eight versioned installer/feed/blockmap assets were downloaded, checked against GitHub sizes/digests, and both update feeds matched the downloaded SHA512 values. The Mac ZIP and DMG integrity checks passed. Receipt: `/tmp/paneforge-v0.8.220-served-assets/verified-receipt.json`. This is publication proof, not an installed update.

Updated dependencies pass 102 unit tests after CLI continuity and migration-integrity checks, zero npm audit findings, PC TypeScript/Vite builds, 40 workspace and 12 Review fixture checks. A bounded included-plan Chat to exact-native CLI resume to reconciled Chat journey completed on one native identity; see the integration checkpoint for its limits. See the remote-render checkpoint for source hashes and returned artifacts. Browser and video jobs ran only on the PC. Mac-to-PC SSH recovered long enough to pass the normal render path, then resumed resetting; outbound artifact return through the existing native PC connection still works. The root cause remains unknown. A subsequent guarded PC Code request completed with the exact requested response; the integration checkpoint records its retained receipt and limits.

The subsequent icon and idle-restart regression batch passed 111 of 111 unit tests from the `next` package directory. Receipt log: `/tmp/next-unit-idle-correct-cwd-20260921.log`. Running this suite from the parent checkout instead fails the legacy-history fixture because it intentionally uses the current package directory.

## Mac preview artifact

The native macOS app built successfully from clean Next source `492f6d919aff13d13e2164472d38e5e4a66f90cc`. Its ad-hoc signature passed strict deep verification. Archive `next/artifacts/PaneForge-Next-0.1.0-mac-arm64-preview.zip` has SHA256 `fcc0c8a75f4a28967460c4ae5e5233c29d78663ca9a10c223faf2306e1c41313`.

The signed app's actual bundled Node and server resources returned the expected product, source revision and isolated data directory from the health endpoint. No browser or native window was opened. Receipt: `/tmp/next-signed-app-proof-20260921.json`; build log: `/tmp/paneforge-next-native-build-final-20260921.log`. This is an ad-hoc preview, not a notarized distribution or installed WebView acceptance.

A subsequent native launch check exposed a framing defect in both older previews: the Rust probe requested HTTP/1.1 and parsed the raw body as JSON, while the real Node `writeHead`/`end` response used chunked transfer encoding. The probe now requests HTTP/1.0 with connection-close framing. All six Rust tests pass, including a live Node server regression rather than only a manually written socket response. Log: `/tmp/next-native-health-regression-20260921.log`. This source fix is later than the published parent release and both Next preview artifacts; rebuilding and observing native launch remain required.

## Windows preview artifact

The retained visible PC checkpoint passed npm ci, frontend build, runtime preparation, and Tauri NSIS packaging on source `3360bcf98844930f4228f27250faca1b0f0bfc9e` plus the exact icon from `0132766f`. The returned installer is 52,012,638 bytes with SHA256 `a4f136487e3121a524bba52354eda43cb184d69fed63dcd306a86a5ebf656258`; root independently checked both against `/tmp/next-win-native-checkpoint-r5-receipt.json`. This proves packaging, not installed Windows acceptance or later source changes.

## Remaining acceptance boundaries

Native package creation and isolated bundled-server health are distinct from installed application acceptance. Installed Windows acceptance, installed voice/update/rollback, and sustained performance evidence must be tracked separately. The lane-a peer owns the Windows checkpoint; root stopped duplicate launches. No hosting-app install or restart, silent profile activation, or default-launcher cutover is authorized by this checkpoint. A preview artifact does not establish full daily-use replacement readiness.

Automatic native updates are not implemented for the packaged Next app: `server/index.mjs` disables the update reader outside legacy port 4317, and the referenced `scripts/restart-idle.mjs` does not exist. Status now reports `automatic: false` with an explicit unavailable reason. Idle checks also block native CLI reconciliation and unresolved submissions; these guards do not establish a working updater. Native update delivery and rollback need implementation and installed verification before daily-use cutover; workflow and prompt management do not remove this requirement.
