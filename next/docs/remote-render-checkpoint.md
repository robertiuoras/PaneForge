# PC rendering evidence, 2026-09-21

Owner: lane b, native conversation `01a0bdba-42cf-7293-a856-a908482746ea`.

## Implemented boundary

- `scripts/render-location.mjs` requires Windows and hostname `DESKTOP-CMSUCM1` before a browser launch.
- `scripts/verify-review.mjs` and `scripts/verify-voice-workspace.mjs` invoke that guard before Playwright launches Chrome.
- `scripts/remote-render.mjs` accepts only the fixed `review` and `workspace` jobs. On Mac it probes the established PC transport and delegates through rbuild. A failed probe exits 3; it does not launch a local browser.
- `server/prompt-forge.mjs` includes the existing PC-only browser/video instruction in generated build prompts. An instruction is not an execution test.

## Observed evidence

Before inbound SSH failed, the PC built the Next frontend and passed the Review fixture browser checks. Returned screenshots are retained in `evidence/review/desktop.png` and `compact.png`, committed in `7eea9784`. These are deterministic fixture checks, not a live provider or installed application test.

The Mac browser guard rejected local execution. The Mac remote wrapper deferred with exit 3 when SSH failed. Its success path through rbuild has not yet been verified for the final integrated source.

Native PC verification task `pc-next-ui-20260921` was launched in pane `s5-mu9yx0ik` through PaneForge's existing connection. It uses the independently verified outbound PC-to-Mac SSH path to pull a source archive and return browser evidence. Launch and working status were observed; completion evidence remains pending. Its initial archive predates the new CLI resume control and must not be used as evidence for that control.

## Final UI source verification

The alternate PaneForge shell transport ran the final UI archive on `DESKTOP-CMSUCM1` in pane `s8-mu9zxig8`. Source SHA-256: `1b998c8dfc347d476ca423fa9d7c7e126a562cc8c36b765bfe20808a387cdcae`. Both workspace and Review jobs exited 0. Workspace passed 19 checks each at desktop and compact sizes with zero unexpected console errors, including exact-session CLI resume, persisted requests and terminal replay. Review passed its reply/reload, acknowledgement, decision-preservation and history checks. The PC returned screenshots, logs, receipt and frontend dist through outbound SSH. Retained fixture screenshots are under `evidence/workspace` and `evidence/review`. This proves these browser flows against fixtures, not installed native or live provider acceptance.

The first run exposed a Windows file-URL screenshot path defect; `aa9eb9c8` replaces URL pathname with fileURLToPath. The successful rerun includes that correction. Inbound SSH and the normal rbuild success path remain unresolved; no local browser fallback was used.

## Windows SSH diagnosis

Native repair conversation `01a0bf60-35c6-71c0-be34-f908635bf784`, pane `s4-mu9ygeqw`, reported `blocked_admin_unavailable`. OpenSSH accepted the Mac key and then logged failure to obtain a Windows user security token, followed by failure to fork an unprivileged child. The service was running as LocalSystem, port 22 was listening, and memory was available. A read-only service START/STOP access probe returned Windows error 5. No service restart, credential, firewall, security-policy, reboot, or installation change was made.

The underlying token failure remains unresolved. An elevated sshd restart is a diagnostic candidate, not an established fix. After any authorized elevated repair, verify a fresh Mac-to-PC echo and SFTP transfer and correlate fresh OpenSSH logs.

Lane c's earlier remote Chrome `proof.png` proves that bounded browser operation only. The later independent synthetic video job passed PC FFmpeg encode, decode and outbound artifact return, documented in [video-proof-checkpoint.md](video-proof-checkpoint.md). This proves the PC media tools and alternate return transport, not an integrated PaneForge video-rendering workflow or repaired inbound SSH.

## Related migration readiness

A fresh read-only dry run after `1048a09e` discovered 184 retained records: 65 metadata records and 119 explicitly read-only orphan-log records. All 38 logs that previously exceeded the 8 MiB bound are now streamed and hashed without truncation. The report contains zero unreadable records. Orphans retain null native identity, so they cannot silently become resumable sessions. Four synthetic tests passed, including large-log, orphan-byte and idempotence checks. Zero records were imported and no activation occurred. The private report is `/tmp/paneforge-next-migration-dryrun-20260921.json`. Actual import, activation and rollback acceptance remain separate gates before cutover.
