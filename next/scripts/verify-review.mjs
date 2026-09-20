import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server.mjs";
import { requireRenderPc } from "./render-location.mjs";

requireRenderPc();

const now = Date.now();
const reviews = [
  {
    id: "review-result", sessionId: "workspace-12", nativeSessionId: "codex-native-12", title: "Workspace shell built", prompt: "Build the workspace shell and return the outcome.", report: "The shell built successfully with saved evidence.", lane: "lane-b", provider: "codex", cwd: "/fixtures/workspace-b", completedAt: new Date(now - 5 * 60_000).toISOString(), closedAt: new Date(now - 4 * 60_000).toISOString(), kind: "result", links: [{ label: "Open build report", url: "https://example.test/report" }], proof: "fixture-build-12", evidence: ["fixture build log retained"],
  },
  {
    id: "review-decision", sessionId: "workspace-13", title: "Choose release timing", prompt: "Decide whether to release this afternoon.", report: "A release decision is still required.", lane: "lane-a", provider: "claude", completedAt: new Date(now - 10 * 60_000).toISOString(), kind: "decision", links: [],
  },
  {
    id: "review-old", sessionId: "workspace-14", title: "Older retained report", prompt: "Keep this result searchable.", report: "This record was reviewed yesterday.", completedAt: new Date(now - 26 * 60 * 60_000).toISOString(), reviewedAt: new Date(now - 25 * 60 * 60_000).toISOString(), kind: "result", links: [],
  },
  {
    id: "review-closed", sessionId: "workspace-15", title: "Closed without a result", prompt: "", report: "", closedAt: new Date(now - 8 * 60_000).toISOString(), kind: "closed", links: [],
  },
];
let failAck = true;
let failOpen = true;
const opens = [];
const replies = [];
const artifactDir = new URL("../evidence/review/", import.meta.url);
await mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const server = await startFixtureServer();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(8_000);
try {
  await context.route(/\/api\/reviews(?:\/.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ reviews, persistent: true }) });
    const id = request.url().split("/").at(-2);
    const review = reviews.find((item) => item.id === id);
    if (!review) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Review not found" }) });
    if (request.url().endsWith("/reply")) {
      replies.push(request.postDataJSON());
      if (replies.length === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture reply unavailable" }) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessionId: "workspace-12", nativeSessionId: "codex-native-12" }) });
    }
    if (request.url().endsWith("/open")) {
      const body = request.postDataJSON();
      opens.push({ id, index: body.index });
      if (failOpen) {
        failOpen = false;
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture report opener unavailable" }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ opened: true }) });
    }
    if (!request.url().endsWith("/ack"))
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Unknown review action" }) });
    if (failAck) {
      failAck = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture acknowledgement unavailable" }) });
    }
    const body = request.postDataJSON();
    review.reviewedAt = body.reviewed ? new Date().toISOString() : undefined;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`${server.url}/#review`);
  await page.getByRole("heading", { name: "See what finished." }).waitFor();
  await page.getByRole("button", { name: /All agents/ }).click();
  await page.getByRole("heading", { name: "Move the work forward." }).waitFor();
  assert.equal(await page.evaluate(() => window.location.hash), "");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("heading", { name: "See what finished." }).waitFor();
  const reply = page.getByRole("textbox", { name: "Continue this conversation" });
  await reply.fill("Please check the final result again.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page.getByText(/Reply was not confirmed/).waitFor();
  await page.reload();
  await reply.waitFor();
  assert.equal(await reply.inputValue(), "Please check the final result again.", "reply draft survives reload after rejected send");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page.getByRole("heading", { name: "Move the work forward." }).waitFor();
  assert.equal(replies.length, 2);
  assert.equal(replies[0].requestId, replies[1].requestId, "retry retains idempotency key");
  assert.equal(await page.evaluate(() => localStorage.getItem("paneforge-selected-session")), "workspace-12");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await reply.waitFor();
  assert.equal(await reply.inputValue(), "", "confirmed send clears draft");
  await page.screenshot({ path: fileURLToPath(new URL("desktop.png", artifactDir)), fullPage: true });
  await page.setViewportSize({ width: 900, height: 800 });
  await page.screenshot({ path: fileURLToPath(new URL("compact.png", artifactDir)), fullPage: true });
  assert.equal(await page.getByText("Workspace shell built", { exact: true }).count(), 1);
  assert.equal(await page.getByText("fixture build log retained", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Choose release timing", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Closed without a result", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Older retained report", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Open report" }).first().click();
  await page.getByText(/The report did not open. Your review status was left unchanged/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Mark reviewed" }).count(), 1);
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await page.getByText(/Could not mark this result reviewed: Fixture acknowledgement unavailable/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Mark reviewed" }).count(), 1);
  await page.getByRole("button", { name: "Open report" }).first().click();
  await page.getByText("Workspace shell built", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(opens.slice(0, 2), [{ id: "review-result", index: -1 }, { id: "review-result", index: -1 }]);
  await page.getByRole("button", { name: "Open report" }).first().click();
  assert.equal(await page.getByText("Choose release timing", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Choose release timing", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /Mark reviewed/ }).count(), 0);
  await page.locator(".review-filter-group").first().getByRole("button", { name: "All", exact: true }).click();
  await page.locator(".review-filter-group").nth(1).getByRole("button", { name: "All", exact: true }).click();
  await page.getByText("Older retained report", { exact: true }).waitFor();
  await page.getByText("This closed session has no completion result.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Mark unreviewed" }).first().click();
  await page.getByRole("button", { name: "Mark reviewed" }).waitFor();
  await page.getByPlaceholder("Search prompt, title, or report").fill("retained");
  assert.equal(await page.getByText("Older retained report", { exact: true }).count(), 1);
  console.log(JSON.stringify({ result: "passed", checks: ["reply draft survives rejection and reload", "retry reuses request id", "confirmed reply selects original session", "hash selects review", "responsive synthetic screenshots", "failed open leaves result pending", "acknowledgement failure remains visible", "successful report open acknowledges informational result", "decision open remains pending", "undo returns a result to pending", "closed history avoids completion claim", "reviewed history is searchable"], artifacts: artifactDir.pathname }));
} finally {
  await context.close();
  await server.close();
  await browser.close();
}
