import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server.mjs";
import { requireRenderPc } from "./render-location.mjs";
requireRenderPc();
const artifactDir = new URL("../.local/stage1-evidence/", import.meta.url);
await mkdir(artifactDir, { recursive: true });
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  mode: "headless deterministic fixtures; no provider calls",
  runs: [],
};
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--mute-audio",
  ],
});
try {
  for (const viewport of [
    { width: 1440, height: 1000, name: "desktop" },
    { width: 900, height: 800, name: "compact" },
  ]) {
    const server = await startFixtureServer();
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
      permissions: ["microphone"],
    });
    const page = await context.newPage();
    const errors = [];
    const expectedFailureConsole = [];
    let injectingFailure = false;
    const run = {
      viewport,
      checks: [],
      consoleErrors: errors,
      expectedFailureConsole,
    };
    report.runs.push(run);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        if (injectingFailure && /409 \(Conflict\)|503 \(Service Unavailable\)/.test(message.text()))
          expectedFailureConsole.push(message.text());
        else errors.push(message.text());
      }
    });
    // Block unintended external requests. The preview must be self-contained.
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === server.url
        ? route.continue()
        : route.abort(),
    );
    const check = (label) => run.checks.push(label);
    try {
      await page.goto(server.url);
      await page
        .getByText("Fixture supervisor connected", { exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: /#12 Build the workspace shell/ })
        .waitFor();
      assert.equal(await page.locator(".xterm").count(), 0);
      assert.equal(
        await page.locator('script[src*="workspace-terminal"]').count(),
        0,
      );
      check("default structured shell; raw terminal collapsed");
      assert.equal(
        await page
          .getByRole("region", {
            name: "Objective: Ship a dependable workspace",
          })
          .count(),
        1,
      );
      check("objective-grouped agents");
      await page.screenshot({
        path: new URL(`${viewport.name}-workspace.png`, artifactDir).pathname,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: /#13 Review session continuity/ })
        .click();
      await page
        .getByRole("complementary", { name: "Session inspector" })
        .getByText("claude-native-13", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("complementary")
          .getByText("Not confirmed / Not confirmed", { exact: true })
          .count(),
        1,
      );
      check(
        "select preserves workspace/native identity and unknown model confirmation",
      );
      await page.getByRole("button", { name: /Needs attention/ }).click();
      assert.equal(await page.locator(".agent-row").count(), 1);
      await page.getByRole("button", { name: /#14 Resolve/ }).waitFor();
      check("exception filter");
      await page.getByRole("button", { name: /All agents/ }).click();
      await page.getByRole("textbox", { name: "Find agents" }).fill("shell");
      assert.equal(await page.locator(".agent-row").count(), 1);
      await page.getByRole("textbox", { name: "Find agents" }).fill("");
      check("search filter");
      await page
        .getByRole("button", { name: /#12 Build the workspace shell/ })
        .click();
      await page.getByText("build check", { exact: true }).click();
      await page
        .getByText("Build success does not verify interactions.", {
          exact: true,
        })
        .waitFor();
      check("evidence expansion without proof promotion");
      await page
        .getByRole("button", { name: "Open raw terminal", exact: false })
        .click();
      await page.locator(".xterm").waitFor();
      await page
        .getByText("Saved output · view only", { exact: true })
        .waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector(".xterm-accessibility")
          ?.textContent.includes("codex-native-12"),
      );
      await page.getByRole("button", { name: "Take terminal control" }).click();
      await page
        .getByText("You control this existing terminal", { exact: true })
        .waitFor();
      check("lazy raw terminal attaches existing terminal and replays output");
      await page.screenshot({
        path: new URL(`${viewport.name}-raw-terminal.png`, artifactDir)
          .pathname,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Close raw terminal", exact: false })
        .click();
      assert.equal(await page.locator(".xterm").count(), 0);
      check("closing raw terminal disposes renderer");
      await page
        .getByRole("textbox", { name: "Steer this agent" })
        .fill("Keep the selected native identity.");
      server.disconnect();
      await page
        .getByText("Reconnecting · controls paused · drafts saved", {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "New agent", exact: true })
          .isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Send steering" }).isDisabled(),
        true,
      );
      server.update("workspace-12", {
        executionState: "completed",
        activeTurn: null,
        status: "idle",
      });
      server.reconnect();
      await page
        .getByText("Fixture supervisor connected", { exact: true })
        .waitFor();
      await page.getByRole("textbox", { name: "Brief this agent" }).waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Brief this agent" })
          .inputValue(),
        "Keep the selected native identity.",
      );
      await page
        .getByRole("complementary")
        .getByText("codex-native-12", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("complementary")
          .locator(".proof-unverified")
          .count(),
        1,
      );
      check(
        "reconnect keeps draft/identity, updates execution, never upgrades proof",
      );
      await page.reload();
      await page
        .getByText("Fixture supervisor connected", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Brief this agent" })
          .inputValue(),
        "Keep the selected native identity.",
      );
      check("reload restores selected session and draft");
      await page.getByRole("button", { name: "Send brief" }).click();
      await page.waitForFunction(
        () => document.querySelector("#agent-brief")?.value === "",
      );
      assert.equal(
        server.requests.filter(
          (r) => r.path === "/api/sessions/workspace-12/turn",
        ).length,
        1,
      );
      check("typed session brief uses existing session turn API exactly once");
      await page
        .getByRole("button", { name: "New agent", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Agent title" })
        .fill("Check the empty state");
      await page
        .getByRole("textbox", { name: "Objective", exact: true })
        .fill(
          "Inspect a blank workspace without starting provider work outside the fixture.",
        );
      await page.getByLabel("Existing lane").selectOption("lane-b");
      await page.getByRole("button", { name: "Create & brief agent" }).click();
      await page
        .getByRole("complementary")
        .getByText("codex-native-15", { exact: true })
        .waitFor();
      assert.equal(
        server.requests.filter((r) => r.path === "/api/sessions").length,
        1,
      );
      assert.equal(
        server.requests.filter(
          (r) => r.path === "/api/sessions/workspace-15/turn",
        ).length,
        1,
      );
      check(
        "create validates lane; create/rename/brief reuse supervisor endpoints and preserve distinct IDs",
      );
      await page.getByRole("button", { name: "Open raw terminal", exact: false }).click();
      assert.equal(await page.getByRole("button", { name: "Resume in CLI", exact: true }).isDisabled(), true);
      server.update("workspace-15", { executionState: "idle", activeTurn: null });
      await page.getByRole("button", { name: "Resume in CLI", exact: true }).click();
      await page.locator(".xterm").waitFor();
      const launched = server.requests.filter((request) => request.path === "/api/terminal/launch");
      assert.equal(launched.length, 1);
      assert.equal(launched[0].body.sessionId, "workspace-15");
      assert.equal(server.state().terminals.find((item) => item.sessionId === "workspace-15").code.nativeSessionId, "codex-native-15");
      await page.getByRole("button", { name: "Close raw terminal", exact: false }).click();
      check("CLI resume waits for idle and targets the existing conversation");
      await page.getByRole("button", { name: "Type a command" }).click();
      await page
        .getByRole("textbox", { name: "Workspace command" })
        .fill("Create fixture agent");
      await page
        .getByRole("button", { name: "Send workspace command" })
        .click();
      await page
        .getByRole("complementary")
        .getByText("codex-native-16", { exact: true })
        .waitFor();
      check(
        "typed global control creates and presents another distinct session",
      );
      await page.getByRole("button", { name: /Talk to GPT Live/ }).click();
      await page.getByRole("button", { name: /listening/ }).waitFor();
      const clientId = await page.evaluate(() =>
        sessionStorage.getItem("paneforge-next.workspace-client"),
      );
      server.simulateVoice("Create fixture agent", clientId);
      await page
        .getByRole("complementary")
        .getByText("codex-native-17", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: /listening/ }).click();
      assert.equal(server.controls[0].text, server.controls[1].text);
      assert.notEqual(
        server.controls[0].nativeSessionId,
        server.controls[1].nativeSessionId,
      );
      assert.deepEqual(
        server.controls.map((c) => c.via),
        ["typed", "voice"],
      );
      check(
        "simulated voice and typed controller share workspace behavior; voice stop leaves agent running",
      );
      assert.equal(
        server.state().sessions.find((s) => s.id === "workspace-17")
          .executionState,
        "running",
      );
      const bounds = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        animations: document.getAnimations().length,
        height: innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
      }));
      assert.ok(
        bounds.scroll <= bounds.width,
        `Horizontal overflow ${JSON.stringify(bounds)}`,
      );
      assert.equal(bounds.animations, 0);
      assert.equal(
        bounds.scrollHeight,
        bounds.height,
        "No unused document scroll beyond the workspace",
      );
      check("compact/desktop fit and reduced-motion behavior");
      assert.deepEqual(errors, []);
      check("no console or uncaught page errors");
      // A separate fault injection records the expected HTTP rejection. The
      // successful Stage 1 flows above must have no console errors at all.
      injectingFailure = true;
      server.failTurn();
      await page
        .getByRole("button", { name: "New agent", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Agent title" })
        .fill("Recover an unconfirmed brief");
      await page
        .getByRole("textbox", { name: "Objective", exact: true })
        .fill("Keep this brief against the created native session.");
      await page.getByRole("button", { name: "Create & brief agent" }).click();
      await page
        .getByRole("status")
        .getByText(
          /Session workspace-18 was created. Brief submission is unconfirmed/,
        )
        .waitFor();
      await page
        .getByRole("complementary")
        .getByText("codex-native-18", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "Brief this agent" })
          .inputValue(),
        "Keep this brief against the created native session.",
      );
      assert.equal(
        server.requests.filter((r) => r.path === "/api/sessions").length,
        2,
      );
      assert.equal(
        server.requests.filter(
          (r) => r.path === "/api/sessions/workspace-18/turn",
        ).length,
        1,
      );
      assert.deepEqual(errors, []);
      assert.equal(expectedFailureConsole.length, 1);
      check(
        "injected brief rejection stays visible, keeps draft and exact created identity, and does not retry creation",
      );
      // Simulate a committed create whose response is lost, then restart the UI.
      await page.route("**/api/sessions", async route => {
        if (route.request().method() !== "POST") return route.continue();
        await route.fetch();
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Creation response lost" }) });
      });
      await page.getByRole("button", { name: "New agent", exact: true }).click();
      await page.getByRole("textbox", { name: "Agent title" }).fill("Recover lost creation");
      await page.getByRole("textbox", { name: "Objective", exact: true }).fill("Reuse this request after reload.");
      await page.getByRole("button", { name: "Create & brief agent" }).click();
      await page.getByText("Creation response lost", { exact: true }).waitFor();
      const lostId = server.requests.filter(r => r.path === "/api/sessions").at(-1).body.requestId;
      assert.ok(lostId);
      await page.unroute("**/api/sessions");
      await page.reload();
      await page.getByText("Fixture supervisor connected", { exact: true }).waitFor();
      await page.getByRole("button", { name: "New agent", exact: true }).click();
      assert.equal(await page.getByRole("textbox", { name: "Objective", exact: true }).inputValue(), "Reuse this request after reload.");
      await page.getByRole("button", { name: "Create & brief agent" }).click();
      await page.getByRole("complementary").getByText("codex-native-19", { exact: true }).waitFor();
      assert.equal(server.requests.filter(r => r.path === "/api/sessions").at(-1).body.requestId, lostId);
      assert.equal(server.state().sessions.filter(s => s.id === "workspace-19").length, 1);
      assert.equal(await page.evaluate(() => localStorage.getItem("paneforge-next.pending-action")), null);
      assert.deepEqual(errors, []);
      check("lost creation response and reload reuse the saved request identity without a duplicate session");
      run.requests = server.requests.map((r) => ({
        method: r.method,
        path: r.path,
      }));
      run.result = "passed";
    } catch (error) {
      run.result = "failed";
      run.error = error.stack;
      await page.screenshot({
        path: new URL(`${viewport.name}-failure.png`, artifactDir).pathname,
        fullPage: true,
      });
      throw error;
    } finally {
      await context.close();
      await server.close();
    }
  }
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(
    new URL("report.json", artifactDir),
    JSON.stringify(report, null, 2),
  );
}
console.log(
  JSON.stringify(
    {
      result: "passed",
      runs: report.runs.map((run) => ({
        viewport: run.viewport.name,
        checks: run.checks.length,
        consoleErrors: run.consoleErrors.length,
      })),
      artifacts: artifactDir.pathname,
    },
    null,
    2,
  ),
);
