# Release verification checkpoint, 2026-09-21

Owner: lane b, native `01a0bdba-42cf-7293-a856-a908482746ea`.

## Parent PaneForge regression checks

On DESKTOP-CMSUCM1, source archive SHA256 `13528f66abfd915672eb84db9a9ebe71ff228e68031c2284e82a1000ec0126fd` passed both TypeScript configurations and 250 of 251 test commands. The sole failure was the kill-guard fixture deriving a synthetic macOS Electron path from a Windows checkout name. Commit `b2a27012` makes the written fixture platform-independent. The focused corrected test then passed all 13 checks on DESKTOP-CMSUCM1 with exit 0. No running application was killed by this fixture test.

Retained logs: `/tmp/pc-release-typecheck-current.log`, `/tmp/pc-release-tests-current.log`, `/tmp/pc-killguard-final-20260921.log`. After integrating lane c, local restore-turn (58), restore-panes, effort (36), and both TypeScript configurations passed. Independent review found the native completion phase is `final_answer`; the parser and regression fixture now recognize it before considering earlier tool activity. This prevents resuming a completed turn when `task_complete` was never written.

## Next verification

Updated dependencies pass 100 unit tests after CLI continuity integration, zero npm audit findings, PC TypeScript/Vite builds, 40 workspace and 12 Review fixture checks. A bounded included-plan Chat to exact-native CLI resume to reconciled Chat journey completed on one native identity; see the integration checkpoint for its limits. See the remote-render checkpoint for source hashes and returned artifacts. Browser and video jobs ran only on the PC. Mac-to-PC SSH recovered long enough to pass the normal render path, then resumed resetting; outbound artifact return through the existing native PC connection still works. The root cause remains unknown.

## Mac preview artifact

The native macOS app built successfully from clean Next source `492f6d919aff13d13e2164472d38e5e4a66f90cc`. Its ad-hoc signature passed strict deep verification. Archive `next/artifacts/PaneForge-Next-0.1.0-mac-arm64-preview.zip` has SHA256 `fcc0c8a75f4a28967460c4ae5e5233c29d78663ca9a10c223faf2306e1c41313`.

The signed app's actual bundled Node and server resources returned the expected product, source revision and isolated data directory from the health endpoint. No browser or native window was opened. Receipt: `/tmp/next-signed-app-proof-20260921.json`; build log: `/tmp/paneforge-next-native-build-final-20260921.log`. This is an ad-hoc preview, not a notarized distribution or installed WebView acceptance.

## Remaining acceptance boundaries

Native package creation and isolated bundled-server health are distinct from installed application acceptance. Live PC Code completion, Windows native packaging, installed voice/update/rollback, and sustained performance evidence must be tracked separately. The lane-a peer owns the Windows checkpoint; root stopped duplicate launches. No hosting-app install or restart, silent profile activation, or default-launcher cutover is authorized by this checkpoint. A preview artifact does not establish full daily-use replacement readiness.

Automatic native updates are not implemented for the packaged Next app: `server/index.mjs` disables the update reader outside legacy port 4317, and the referenced `scripts/restart-idle.mjs` does not exist. The current `automatic: true` status is not evidence of a working updater. Native update delivery and rollback need implementation and installed verification before daily-use cutover; workflow and prompt management do not remove this requirement.
