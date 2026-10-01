/** Durable, agent-authored handoffs for human review. */
import { formatTokens } from "./tokenTally";

export type ReviewKind = "result" | "decision" | "blocked" | "closed";
export type ReviewProof = "measured" | "claimed" | "unverified";
export interface ReviewLink {
  label: string;
  url: string;
}
export interface ReviewInput {
  id: string;
  sessionId: string;
  nativeSessionId?: string;
  kind: ReviewKind;
  report: string;
  prompt?: string;
  lane?: string;
  proof: ReviewProof;
  evidence?: string[];
  links?: ReviewLink[];
  completedAt?: string;
  capturedAt?: string;
  closeSession?: boolean;
  notify?: boolean;
  workPreserved?: boolean;
  noRemainingWork?: boolean;
}
/**
 * How full the chat's context was after its last reply. `used` = input + cache read +
 * cache creation of the LAST assistant message (Codex: that turn's `total_tokens`);
 * `window` = what the model holds.
 */
export interface ReviewContext {
  used: number;
  window: number;
}
export interface ReviewRecord extends ReviewInput {
  nativeSessionId: string;
  prompt: string;
  title: string;
  provider: string;
  cwd: string;
  reportPath: string;
  createdAt: string;
  closedAt?: string;
  reviewedAt?: string;
  attention: boolean;
  closeBlocked?: string;
  payloadHash?: string;
  noticeSentAt?: string;
  /*
   * Finished-chat report contract v1 (2026-09-27, shared with GuardDeck and PaneForge
   * Next - field names fixed). All optional: a record written before them, or one whose
   * transcript could not be read, has none, and every reader works without them.
   */
  /** The number on the chat's card when the report was recorded (`pf list` column 1). */
  paneNumber?: number;
  /** Which app hosted the chat; absent = "paneforge". */
  app?: "paneforge" | "paneforge-next";
  context?: ReviewContext;
  /** Whole-session spend: input + cache creation + output over every reply; cache reads left out. */
  sessionTokens?: number;
  /** A report copied from its owning PaneForge device. Absent means this device owns it. */
  origin?: { id: string; name: string; platform: string };
}

const CLAUDE_WINDOW = 200_000,
  BIG_WINDOW = 1_000_000;

/**
 * The context a Claude model holds. `[1m]` asks for the 1M window; Opus 5 and 5.5 have it
 * without asking (`shared/agents.ts` lists them "1M context", and a real Opus 5.5 chat was
 * measured at 546,800 tokens in context on 2026-09-27); and anything already past 200k is
 * on the big window whatever its name says.
 */
export function contextWindowFor(model: string | undefined, used: number): number {
  const m = model ?? "";
  return /\[1m\]/i.test(m) || /^claude-opus-5(-|$)/.test(m) || used > CLAUDE_WINDOW
    ? BIG_WINDOW
    : CLAUDE_WINDOW;
}

const count = (u: Record<string, unknown> | undefined, k: string): number => {
  const v = u?.[k];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
};

/**
 * `context` and `sessionTokens` out of a chat's own transcript lines, oldest first.
 * Lines that are not JSON (the last one is routinely half-written) are skipped. Nothing
 * countable = nothing returned, never a zero.
 *
 * Claude Code writes one message several times while it streams, each copy carrying the
 * same usage (`shared/tokenTally.ts`), so the session total counts each message id once.
 * A subagent's messages (`isSidechain`) and the CLI's own `<synthetic>` notes are not the
 * chat's context and are skipped.
 */
export function transcriptTokens(
  agent: string,
  lines: Iterable<string>,
): { context?: ReviewContext; sessionTokens?: number } {
  if (agent === "codex") {
    let last: Record<string, any> | undefined;
    for (const line of lines) {
      let row: Record<string, any>;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      // A rate-limit-only update carries `info: null` and says nothing about tokens.
      if (row?.type === "event_msg" && row.payload?.type === "token_count" && row.payload.info)
        last = row.payload.info;
    }
    if (!last) return {};
    const out: { context?: ReviewContext; sessionTokens?: number } = {};
    const used = count(last.last_token_usage, "total_tokens"),
      window = count(last, "model_context_window");
    if (used && window && used <= window) out.context = { used, window };
    const total = last.total_token_usage;
    const spent =
      count(total, "input_tokens") - count(total, "cached_input_tokens") + count(total, "output_tokens");
    if (spent > 0) out.sessionTokens = spent;
    return out;
  }
  const billed = new Map<string, number>();
  let last: { used: number; model?: string } | undefined;
  for (const line of lines) {
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const message = row?.message,
      usage = message?.usage;
    if (row?.type !== "assistant" || row.isSidechain || !usage || typeof usage !== "object") continue;
    if (message.model === "<synthetic>") continue;
    billed.set(
      String(message.id ?? row.uuid ?? billed.size),
      count(usage, "input_tokens") + count(usage, "cache_creation_input_tokens") + count(usage, "output_tokens"),
    );
    last = {
      used:
        count(usage, "input_tokens") +
        count(usage, "cache_read_input_tokens") +
        count(usage, "cache_creation_input_tokens"),
      model: typeof message.model === "string" ? message.model : undefined,
    };
  }
  const out: { context?: ReviewContext; sessionTokens?: number } = {};
  if (last?.used) out.context = { used: last.used, window: contextWindowFor(last.model, last.used) };
  let spent = 0;
  for (const n of billed.values()) spent += n;
  if (spent > 0) out.sessionTokens = spent;
  return out;
}

export const contextPercent = (c: ReviewContext): number => Math.round((c.used / c.window) * 100);
/**
 * GuardDeck's colours for the same number: green under half, amber to 80%, red past it.
 * Judged on the percent the label shows, so "80% full" is never drawn red.
 */
export type ContextLevel = "ok" | "warn" | "danger";
export function contextLevel(c: ReviewContext): ContextLevel {
  const pct = contextPercent(c);
  return pct > 80 ? "danger" : pct >= 50 ? "warn" : "ok";
}

/** "142k of 200k context used (71%) · 316k tokens this session", in words a person reads. */
export function contextWords(r: Pick<ReviewRecord, "context" | "sessionTokens">): string {
  const parts: string[] = [];
  if (r.context)
    parts.push(
      `${formatTokens(r.context.used)} of ${formatTokens(r.context.window)} context used (${contextPercent(r.context)}%)`,
    );
  if (r.sessionTokens) parts.push(`${formatTokens(r.sessionTokens)} tokens this session`);
  return parts.join(" · ");
}
/** What a nearly full chat needs before more work is sent to it. */
export const FULL_ADVICE = "clear before the next big job";
