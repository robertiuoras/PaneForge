import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
import { codexTranscriptPath, transcriptPath } from "./transcripts";
import { cardNumber } from "../../scripts/pf-ctl-lib.mjs";
import type { HistoryEntry } from "../shared/types";
import {
  FULL_ADVICE,
  contextLevel,
  contextWords,
  transcriptTokens,
  type ReviewInput,
  type ReviewKind,
  type ReviewLink,
  type ReviewProof,
  type ReviewRecord,
} from "../shared/reviews";

/** The desk in `sessions:list` order (index.ts), so a report can carry its card number. */
let desk: () => ReadonlyArray<{ id: string }> = () => [];
export function setReviewDesk(list: () => ReadonlyArray<{ id: string }>) {
  desk = list;
}

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
/** "4:10pm Sun 27 Sep", this computer's clock. */
function when(at: string) {
  const d = new Date(at),
    h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}${h < 12 ? "am" : "pm"} ${d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }).replace(/,/g, "")}`;
}
/**
 * The reply as it was written, made readable: `**bold**`, `code` and `#` headings keep
 * their meaning instead of showing their marks. Everything is escaped first, so only these
 * fixed tags are ever added; a fenced code block is left exactly as written (its `#` is a
 * shell comment, not a heading).
 */
function markdown(text: string) {
  let fenced = false;
  return esc(text)
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      const body = (h ? h[1] : line)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
      return h ? `<strong class="h">${body}</strong>` : body;
    })
    .join("\n");
}
/** GuardDeck's green / amber / red, on this page's dark background. */
const LEVEL_COLOUR = { ok: "#35d07f", warn: "#f0b429", danger: "#ff8f8f" } as const;
function contextLine(r: ReviewRecord) {
  const words = contextWords(r);
  if (!words) return "";
  const level = r.context ? contextLevel(r.context) : "ok";
  return `<p class="ctx" style="color:${LEVEL_COLOUR[level]}"><b>${esc(words)}</b>${level === "danger" ? ` - ${FULL_ADVICE}` : ""}</p>`;
}
function page(r: ReviewRecord) {
  const num = r.paneNumber ? `<span class="num">${esc(String(r.paneNumber))}</span> ` : "";
  const list = (title: string, items: string[]) =>
    items.length ? `<h2>${title}</h2><ul>${items.join("")}</ul>` : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${r.paneNumber ? `${esc(String(r.paneNumber))} ` : ""}${esc(r.title)}</title><style>:root{color-scheme:dark}body{max-width:820px;margin:60px auto;padding:0 28px;background:#121416;color:#e9e9e6;font:16px/1.65 -apple-system,BlinkMacSystemFont,sans-serif}h1{font-size:32px;line-height:1.2;letter-spacing:-.025em;font-weight:800}.num{display:inline-block;min-width:1.4em;padding:0 .3em;margin-right:.15em;border-radius:8px;background:#f0a868;color:#121416;text-align:center;font-variant-numeric:tabular-nums}.meta{color:#adb0ac}.ctx{margin-top:-6px}h2{margin-top:32px;font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#adb0ac}pre,.report{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;background:#1c1f21;border:1px solid #303437;border-radius:12px;padding:20px}.report strong{color:#fff}.report .h{color:#f0a868}code{font:14px ui-monospace,Menlo,monospace;background:#2a2e31;border-radius:5px;padding:1px 5px}a{color:#d6e5ec;text-underline-offset:4px}li{margin:8px 0}</style><h1>${num}${esc(r.title)}</h1><p class="meta">${esc(r.kind)} · ${esc(r.proof)} · finished ${esc(when(r.completedAt ?? r.createdAt))}</p>${contextLine(r)}<div class="report">${markdown(r.report)}</div><h2>Original prompt</h2><pre>${esc(r.prompt)}</pre>${list("Evidence", (r.evidence ?? []).map((e) => `<li>${esc(e)}</li>`))}${list("Links", (r.links ?? []).map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`))}`;
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
    // Read off the desk and the transcript at the moment of recording: a retry of the same
    // report is the same report even when the card has moved or the chat has said more.
    paneNumber,
    app,
    context,
    sessionTokens,
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
          // Everything GuardDeck needs to hand the next prompt back to THIS conversation:
          // `pf continue <resumeId> --prompt-file <file>` on the `machine` that wrote it.
          // Added fields only - older readers keep reading id/lane/kind/reportPath.
          result: {
            id: record.id,
            lane: record.lane,
            kind: record.kind,
            reportPath: record.reportPath,
            sessionId: record.sessionId,
            // A shell (a compute job's observer) has no conversation to continue: its
            // `nativeSessionId` is the pane id, which `pf continue` would only refuse.
            resumeId: record.provider === "shell" ? undefined : record.nativeSessionId,
            cwd: record.cwd,
            agent: record.provider,
            // The gate above lets only the Mac app write notices; the field is here so a
            // PC notice, when there is one, needs no new reader.
            machine: "mac",
            // Finished-chat report contract v1: optional, absent when unknown.
            paneNumber: record.paneNumber,
            app: record.app,
            context: record.context,
            sessionTokens: record.sessionTokens,
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
/**
 * A transcript's lines that hold `needle`, read 1MB at a time: a Codex rollout reaches
 * 128MB and is never held whole, and only a matching line is decoded. Measured 2026-09-27
 * on a 20MB Claude transcript: 12-16ms, against 75ms decoding every line. Started at `from`
 * inside the file, the first line read is a fragment of one and is skipped.
 */
function* linesWith(file: string, needle: string, from = 0): Generator<string> {
  const want = Buffer.from(needle);
  const fd = openSync(file, "r");
  try {
    let buf = Buffer.alloc(1 << 20),
      have = 0,
      pos = from,
      fragment = from > 0;
    for (;;) {
      if (have === buf.length) {
        const grown = Buffer.alloc(buf.length * 2);
        buf.copy(grown, 0, 0, have);
        buf = grown;
      }
      const n = readSync(fd, buf, have, buf.length - have, pos);
      if (!n) break;
      pos += n;
      have += n;
      let start = 0,
        nl: number;
      while ((nl = buf.indexOf(10, start)) >= 0 && nl < have) {
        const line = buf.subarray(start, nl);
        if (fragment) fragment = false;
        else if (line.indexOf(want) >= 0) yield line.toString("utf8");
        start = nl + 1;
      }
      buf.copy(buf, 0, start, have);
      have -= start;
    }
    const tail = buf.subarray(0, have);
    if (have && !fragment && tail.indexOf(want) >= 0) yield tail.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
/** The end of a Codex rollout read for its token count: many turns' worth of rows. */
const CODEX_TOKEN_TAIL = 2 * 1024 * 1024;
/**
 * The report contract's live facts: the card number now, and how full the chat is. Any of
 * them unreadable is left out - a report is never held back for a number.
 */
function sessionFacts(
  sessionId: string,
  r: Pick<ReviewRecord, "provider" | "cwd" | "nativeSessionId">,
): Pick<ReviewRecord, "paneNumber" | "app" | "context" | "sessionTokens"> {
  const out: Pick<ReviewRecord, "paneNumber" | "app" | "context" | "sessionTokens"> = {
    app: "paneforge",
  };
  try {
    const n = cardNumber(desk(), sessionId);
    if (n > 0) out.paneNumber = n;
  } catch {
    /* no desk to count on */
  }
  if (r.provider === "shell" || r.provider === "screen") return out;
  try {
    const file =
      r.provider === "codex"
        ? codexTranscriptPath(r.cwd, r.nativeSessionId)
        : transcriptPath(r.cwd, r.nativeSessionId);
    if (file) {
      const needle = r.provider === "codex" ? '"token_count"' : '"usage"';
      // Codex's last token_count holds the whole session's running total, so only the end of
      // a rollout is read; the whole file only when its end has no token count at all.
      // Measured 2026-09-27 on a 128MB rollout: 72-90ms whole, 1-3ms tail, same numbers.
      const size = r.provider === "codex" ? statSync(file).size : 0;
      let tokens: ReturnType<typeof transcriptTokens> =
        size > CODEX_TOKEN_TAIL
          ? transcriptTokens("codex", linesWith(file, needle, size - CODEX_TOKEN_TAIL))
          : {};
      if (!tokens.context && !tokens.sessionTokens)
        tokens = transcriptTokens(r.provider, linesWith(file, needle));
      Object.assign(out, tokens);
    }
  } catch {
    /* an unreadable transcript leaves the numbers out */
  }
  return out;
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
  Object.assign(base, sessionFacts(input.sessionId, base));
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
