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

## Windows SSH diagnosis

Native repair conversation `01a0bf60-35c6-71c0-be34-f908635bf784`, pane `s4-mu9ygeqw`, reported `blocked_admin_unavailable`. OpenSSH accepted the Mac key and then logged failure to obtain a Windows user security token, followed by failure to fork an unprivileged child. The service was running as LocalSystem, port 22 was listening, and memory was available. A read-only service START/STOP access probe returned Windows error 5. No service restart, credential, firewall, security-policy, reboot, or installation change was made.

The underlying token failure remains unresolved. An elevated sshd restart is a diagnostic candidate, not an established fix. After any authorized elevated repair, verify a fresh Mac-to-PC echo and SFTP transfer and correlate fresh OpenSSH logs.

Lane c's earlier remote Chrome `proof.png` proves that bounded browser operation only. Video encoding and video artifact return remain unverified. No claim of complete browser/video remote verification is justified by the partial evidence.
