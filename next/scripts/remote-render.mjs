import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireRenderPc } from "./render-location.mjs";

const jobs = { review: "scripts/verify-review.mjs", workspace: "scripts/verify-voice-workspace.mjs" };
const job = jobs[process.argv[2]];
if (!job || process.argv.length !== 3) {
  console.error("Usage: node scripts/remote-render.mjs review|workspace");
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform === "win32") {
  requireRenderPc();
  console.log(`Rendering on verified PC ${hostname()}`);
  const built = spawnSync("npm.cmd", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
  if (built.status !== 0) process.exit(built.status || 1);
  const run = spawnSync(process.execPath, [job], { cwd: root, stdio: "inherit" });
  process.exit(run.status ?? 1);
}
const probe = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "Gamer@100.78.1.77", "hostname"], { encoding: "utf8", timeout: 12_000 });
if (probe.status !== 0 || probe.stdout.trim().toUpperCase() !== "DESKTOP-CMSUCM1") {
  console.error("Rendering deferred: the designated PC is unavailable or its identity differs. Nothing was rendered locally.");
  process.exit(3);
}
const rbuild = join(homedir(), "Projects", "claude-memory", "claude-config", "rbuild.mjs");
if (!existsSync(rbuild)) {
  console.error("Rendering deferred: the established remote build transport is unavailable. Nothing was rendered locally.");
  process.exit(3);
}
// Fixed job names only. rbuild snapshots this working tree and preserves the remote exit code.
const run = spawnSync(process.execPath, [rbuild, "--repo", root, "--", "node", "scripts/remote-render.mjs", process.argv[2]], {
  cwd: root, stdio: "inherit", env: { ...process.env, RBUILD_HOST: "Gamer@100.78.1.77" },
});
process.exit(run.status ?? 1);
