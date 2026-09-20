import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app } from "electron";
import { profileName } from "./profile";
import type { HistoryEntry } from "../shared/types";
import type {
  ReviewInput,
  ReviewKind,
  ReviewLink,
  ReviewProof,
  ReviewRecord,
} from "../shared/reviews";

export interface ReviewCloseArm {
  sessionId: string;
  nativeSessionId: string;
  capturedAt: number;
}

/** Decides whether an event-bound requested close may advance at this session update. */
export function reviewCloseArmAction(
  arm: ReviewCloseArm,
  session: {
    nativeSessionId?: string;
    lastKeyboard: number;
    drafting?: boolean;
    ask?: boolean;
    owedPrompt?: boolean;
    handingOff?: boolean;
    pendingWork?: boolean;
    idle: boolean;
  } | undefined,
): "wait" | "cancel" | "close" {
  if (!session) return "cancel";
  if (
    session.nativeSessionId !== arm.nativeSessionId ||
    session.lastKeyboard > arm.capturedAt ||
    session.drafting ||
    session.ask ||
    session.owedPrompt ||
    session.handingOff ||
    session.pendingWork
  )
    return "cancel";
  return session.idle ? "close" : "wait";
}
const validId = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v);
const kinds: ReviewKind[] = ["result", "decision", "blocked", "closed"],
  proofs: ReviewProof[] = ["measured", "claimed", "unverified"];
const fileExt = new Set([
  ".html",
  ".htm",
  ".md",
  ".txt",
  ".log",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".csv",
  ".json",
]);
const root = () => join(app.getPath("userData"), "reviews"),
  jsonPath = (id: string) => join(root(), `${id}.json`),
  htmlPath = (id: string) => join(root(), `${id}.html`);
const receiptPath = (id: string) =>
  join(homedir(), ".claude", "guarddeck", "result-receipts", `${id}.json`);
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const iso = (v: unknown) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v))
    ? new Date(v).toISOString()
    : undefined;
function need(v: unknown, max: number, name: string) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new Error(`Invalid ${name}`);
  return v.trim();
}
function optional(v: unknown, max: number, name: string) {
  return v === undefined ? undefined : need(v, max, name);
}
function atomic(path: string, value: string) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}
function reviewLinks(value: unknown): ReviewLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30)
    throw new Error("Invalid review links");
  return value.map((link) => {
    if (!link || typeof link !== "object")
      throw new Error("Invalid review link");
    const label = need((link as ReviewLink).label, 300, "review link label"),
      raw = need((link as ReviewLink).url, 4000, "review link URL");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("Invalid review link URL");
    }
    if (u.protocol === "http:" || u.protocol === "https:")
      return { label, url: u.href };
    if (u.protocol !== "file:" || u.hostname)
      throw new Error("Unsupported review link URL");
    const path = fileURLToPath(u);
    if (
      !fileExt.has(extname(path).toLowerCase()) ||
      !existsSync(path) ||
      !statSync(path).isFile()
    )
      throw new Error("Unsupported review evidence file");
    return { label, url: pathToFileURL(path).href };
  });
}
function reviewEvidence(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40)
    throw new Error("Invalid review evidence");
  return value.map((v) => need(v, 10000, "review evidence"));
}
function page(r: ReviewRecord) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title><style>:root{color-scheme:dark}body{max-width:820px;margin:60px auto;padding:0 28px;background:#121416;color:#e9e9e6;font:16px/1.65 -apple-system,BlinkMacSystemFont,sans-serif}h1{font-size:32px;line-height:1.2;letter-spacing:-.025em}h2{margin-top:32px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#adb0ac}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;background:#1c1f21;border:1px solid #303437;border-radius:12px;padding:20px}a{color:#d6e5ec;text-underline-offset:4px}li{margin:8px 0}</style><h1>${esc(r.title)}</h1><p>${esc(r.kind)} · ${esc(r.proof)}</p><pre>${esc(r.report)}</pre><h2>Original prompt</h2><pre>${esc(r.prompt)}</pre><h2>Evidence</h2><ul>${(r.evidence ?? []).map((e) => `<li>${esc(e)}</li>`).join("")}</ul><h2>Links</h2><ul>${(r.links ?? []).map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join("")}</ul>`;
}
function immutable(r: ReviewRecord) {
  const {
    createdAt,
    closedAt,
    reviewedAt,
    attention,
    closeBlocked,
    reportPath,
    payloadHash,
    noticeSentAt,
    ...rest
  } = r;
  return rest;
}
function digest(r: ReviewRecord) {
  return createHash("sha256")
    .update(JSON.stringify(immutable(r)))
    .digest("hex");
}
function read(id: string): ReviewRecord | null {
  try {
    return JSON.parse(readFileSync(jsonPath(id), "utf8")) as ReviewRecord;
  } catch {
    return null;
  }
}
function receipt(id: string) {
  try {
    const r = JSON.parse(readFileSync(receiptPath(id), "utf8")) as {
      id?: unknown;
      reviewedAt?: unknown;
    };
    return r.id === id ? iso(r.reviewedAt) : undefined;
  } catch {
    return undefined;
  }
}
function spoolNotice(record: ReviewRecord): ReviewRecord {
  if (
    !record.notify ||
    process.platform !== "darwin" ||
    !app.isPackaged ||
    profileName()
  )
    return record;
  const notice = join(
    homedir(),
    ".claude",
    "guarddeck",
    "notices",
    `paneforge-review-${record.id}.json`,
  );
  if (!existsSync(notice))
    atomic(
      notice,
      JSON.stringify(
        {
          id: `paneforge-review-${record.id}`,
          actor: "paneforge",
          title: record.title,
          detail: record.report,
          result: {
            id: record.id,
            lane: record.lane,
            kind: record.kind,
            reportPath: record.reportPath,
          },
        },
        null,
        2,
      ),
    );
  if (!record.noticeSentAt) {
    record.noticeSentAt = new Date().toISOString();
    atomic(jsonPath(record.id), JSON.stringify(record, null, 2));
  }
  return record;
}
function closed(h: HistoryEntry): ReviewRecord {
  const at = new Date(h.endedAt ?? h.startedAt).toISOString(),
    log = join(app.getPath("userData"), "history", `${h.id}.log`);
  return {
    id: `closed_${h.id}`,
    sessionId: h.id,
    nativeSessionId: h.resumeId ?? h.id,
    kind: "closed",
    proof: "unverified",
    report:
      "Closed without a saved completion report. Open the retained transcript to review.",
    prompt: h.askLines?.join("\n") || h.gist || "",
    evidence: [],
    links: existsSync(log)
      ? [{ label: "Retained transcript", url: pathToFileURL(log).href }]
      : [],
    title: `${h.title} (closed session)`,
    provider: h.agent,
    cwd: h.cwd,
    reportPath: log,
    createdAt: at,
    closedAt: at,
    attention: false,
  };
}
export function recordReview(
  input: ReviewInput,
  native: Pick<ReviewRecord, "title" | "provider" | "cwd" | "nativeSessionId">,
): ReviewRecord {
  if (
    !validId(input.id) ||
    !validId(input.sessionId) ||
    !validId(native.nativeSessionId)
  )
    throw new Error("Invalid review or native session ID");
  if (
    input.nativeSessionId !== undefined &&
    input.nativeSessionId !== native.nativeSessionId
  )
    throw new Error(
      "Review native session ID does not match the retained session",
    );
  if (
    !kinds.includes(input.kind) ||
    input.kind === "closed" ||
    !proofs.includes(input.proof)
  )
    throw new Error("Invalid review kind or proof");
  const completedAt =
      input.completedAt === undefined ? undefined : iso(input.completedAt),
    capturedAt =
      input.capturedAt === undefined ? undefined : iso(input.capturedAt);
  if (input.completedAt !== undefined && !completedAt)
    throw new Error("Invalid completion timestamp");
  if (completedAt && Date.parse(completedAt) > Date.now())
    throw new Error("Completion timestamp is in the future");
  if (input.capturedAt !== undefined && !capturedAt)
    throw new Error("Invalid captured timestamp");
  const base: ReviewRecord = {
    id: input.id,
    sessionId: input.sessionId,
    nativeSessionId: native.nativeSessionId,
    kind: input.kind,
    report: need(input.report, 100000, "review report"),
    prompt: optional(input.prompt, 100000, "review prompt") ?? "",
    lane: optional(input.lane, 300, "review lane"),
    proof: input.proof,
    evidence: reviewEvidence(input.evidence),
    links: reviewLinks(input.links),
    completedAt,
    capturedAt,
    closeSession: input.closeSession === true,
    notify: input.notify === true,
    workPreserved: input.workPreserved === true,
    noRemainingWork: input.noRemainingWork === true,
    title: need(native.title, 1000, "native title"),
    provider: need(native.provider, 200, "native provider"),
    cwd: need(native.cwd, 4000, "native cwd"),
    reportPath: htmlPath(input.id),
    createdAt: new Date().toISOString(),
    attention: input.kind !== "result",
  };
  const prior = read(input.id);
  if (prior) {
    if ((prior.payloadHash ?? digest(prior)) !== digest(base))
      throw new Error("Conflicting duplicate review ID");
    atomic(prior.reportPath, page(prior));
    return spoolNotice(prior);
  }
  atomic(base.reportPath, page(base));
  base.payloadHash = digest(base);
  atomic(jsonPath(base.id), JSON.stringify(base, null, 2));
  return spoolNotice(base);
}
export function listReviews(history: HistoryEntry[] = []): ReviewRecord[] {
  const saved = existsSync(root())
    ? readdirSync(root())
        .filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f))
        .flatMap((f) => {
          const r = read(f.slice(0, -5));
          if (!r) return [];
          const reviewedAt = receipt(r.id) ?? iso(r.reviewedAt);
          return [
            {
              ...r,
              reviewedAt,
              attention: r.kind === "result" ? !reviewedAt : r.attention,
            },
          ];
        })
    : [];
  const known = new Set(saved.flatMap((r) => [r.sessionId, r.nativeSessionId]));
  return [
    ...saved,
    ...history
      .filter(
        (h) => h.endedAt && !known.has(h.id) && !known.has(h.resumeId ?? ""),
      )
      .map(closed),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
export function acknowledgeReview(id: string, reviewed: boolean) {
  if (!validId(id)) return { ok: false, clearedAttention: false };
  const r = read(id);
  if (!r) return { ok: false, clearedAttention: false };
  if (r.kind !== "result") return { ok: true, clearedAttention: false };
  if (reviewed) {
    const at = new Date().toISOString();
    atomic(receiptPath(id), JSON.stringify({ id, reviewedAt: at }));
    r.reviewedAt = at;
    r.attention = false;
    atomic(jsonPath(id), JSON.stringify(r, null, 2));
    return { ok: true, clearedAttention: true };
  }
  rmSync(receiptPath(id), { force: true });
  delete r.reviewedAt;
  r.attention = true;
  atomic(jsonPath(id), JSON.stringify(r, null, 2));
  return { ok: true, clearedAttention: false };
}
export function noteReviewClose(
  id: string,
  reason?: string,
  closedAt?: string,
) {
  const r = validId(id) ? read(id) : null;
  if (!r) return;
  if (reason) r.closeBlocked = reason;
  else delete r.closeBlocked;
  if (closedAt) r.closedAt = closedAt;
  atomic(jsonPath(id), JSON.stringify(r, null, 2));
}
export function reviewOpenTarget(
  id: string,
  index: number,
  history: HistoryEntry[] = [],
): string | null {
  if (!validId(id) || !Number.isInteger(index)) return null;
  const old = id.startsWith("closed_")
    ? history.find((h) => `closed_${h.id}` === id && Boolean(h.endedAt))
    : undefined;
  const r = read(id) ?? (old ? closed(old) : null);
  if (!r) return null;
  if (index === -1) return existsSync(r.reportPath) ? r.reportPath : null;
  const link = (r.links ?? [])[index];
  if (!link) return null;
  try {
    const u = new URL(link.url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    if (u.protocol !== "file:" || u.hostname) return null;
    const path = fileURLToPath(u);
    return fileExt.has(extname(path).toLowerCase()) &&
      existsSync(path) &&
      statSync(path).isFile()
      ? path
      : null;
  } catch {
    return null;
  }
}
