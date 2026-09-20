# Release verification checkpoint, 2026-09-21

Owner: lane b, native `01a0bdba-42cf-7293-a856-a908482746ea`.

## Parent PaneForge regression checks

On DESKTOP-CMSUCM1, source archive SHA256 `13528f66abfd915672eb84db9a9ebe71ff228e68031c2284e82a1000ec0126fd` passed both TypeScript configurations and 250 of 251 test commands. The sole failure was the kill-guard fixture deriving a synthetic macOS Electron path from a Windows checkout name. Commit `b2a27012` makes the written fixture platform-independent. The focused corrected test then passed all 13 checks on DESKTOP-CMSUCM1 with exit 0. No running application was killed by this fixture test.

Retained logs: `/tmp/pc-release-typecheck-current.log`, `/tmp/pc-release-tests-current.log`, `/tmp/pc-killguard-final-20260921.log`. These results predate integration of lane c; its affected checks must be verified after merging.

## Next verification

Updated dependencies pass 99 unit tests, zero npm audit findings, PC TypeScript/Vite builds, 40 workspace and 12 Review fixture checks. See the remote-render checkpoint for source hashes and returned artifacts. Browser and video jobs ran only on the PC. Mac-to-PC SSH recovered long enough to pass the normal render path, then resumed resetting; outbound artifact return through the existing native PC connection still works. The root cause remains unknown.

## Remaining acceptance boundaries

Native package creation and isolated bundled-server health are distinct from installed application acceptance. Live PC Code completion, Windows native packaging, exact Chat/CLI continuity, installed voice/update/rollback, and sustained performance evidence must be tracked separately. No hosting-app install or restart, silent profile activation, or default-launcher cutover is authorized by this checkpoint. A preview artifact does not establish full daily-use replacement readiness.
