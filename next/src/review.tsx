import { useEffect, useMemo, useState } from "react";
import { Check, Clock3, ExternalLink, FileWarning, Search } from "lucide-react";
import { api } from "./workspace-model";

export type ReviewResult = {
  id: string;
  sessionId: string;
  nativeSessionId?: string;
  title: string;
  prompt: string;
  report: string;
  lane?: string;
  provider?: string;
  cwd?: string;
  createdAt?: string;
  completedAt?: string;
  closedAt?: string;
  reviewedAt?: string;
  kind: "result" | "decision" | "blocked" | "closed";
  links: Array<{ label: string; url: string }>;
  proof?: string;
  evidence?: string[];
};

type ReviewsResponse = { reviews: ReviewResult[]; persistent: boolean };
type Range = "hour" | "today" | "all";

const timestamp = (value?: string) => {
  const date = new Date(value || "");
  return Number.isFinite(date.valueOf())
    ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "Time not recorded";
};

const allowedLink = (value: string) => {
  try {
    return ["https:", "http:", "file:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export function Review({ setNotice, reviewOnly = false }: { setNotice: (value: string) => void; reviewOnly?: boolean }) {
  const [response, setResponse] = useState<ReviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<Range>("hour");
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [updating, setUpdating] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setResponse(await api<ReviewsResponse>("/api/reviews", undefined, "GET"));
    } catch (error) {
      setNotice(`Review history: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const reviews = useMemo(() => {
    const now = Date.now();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const needle = query.trim().toLowerCase();
    return (response?.reviews || []).filter((review) => {
      const completed = Date.parse(review.completedAt || review.closedAt || review.createdAt || "");
      if (range === "hour" && (!Number.isFinite(completed) || completed < now - 3_600_000)) return false;
      if (range === "today" && (!Number.isFinite(completed) || completed < today.valueOf())) return false;
      if (!showAll && review.reviewedAt) return false;
      return !needle || `${review.title} ${review.prompt} ${review.report} ${review.lane || ""}`.toLowerCase().includes(needle);
    });
  }, [query, range, response, showAll]);

  async function acknowledge(review: ReviewResult, reviewed = true) {
    if (review.kind !== "result" || updating) return;
    setUpdating(review.id);
    try {
      await api(`/api/reviews/${encodeURIComponent(review.id)}/ack`, { reviewed });
      await refresh();
    } catch (error) {
      setNotice(`Could not mark this result reviewed: ${(error as Error).message}`);
    } finally {
      setUpdating(null);
    }
  }

  async function openLink(review: ReviewResult, link: ReviewResult["links"][number], index: number) {
    if (!allowedLink(link.url)) {
      setNotice("This report link has an unsupported address.");
      return;
    }
    try {
      const result = await api<{ opened?: boolean }>(`/api/reviews/${encodeURIComponent(review.id)}/open`, { index });
      if (!result.opened) throw Error("The report was not opened.");
    } catch (error) {
      setNotice("The report did not open. Your review status was left unchanged.");
      return;
    }
    if (review.kind === "result" && !review.reviewedAt) await acknowledge(review);
  }

  return <main className="agent-field review-field" id="agent-field" tabIndex={-1}>
    <div className="field-heading">
      <div>
        <span className="eyebrow">REVIEW</span>
        <h1>See what finished.</h1>
        <p>{reviewOnly ? "Review connected to PaneForge. Results need a clear read." : "Results need a clear read. Decisions and blocks remain pending until their work changes."}</p>
      </div>
      <div className="review-heading-actions">{response && <span className="review-storage">{response.persistent ? "Durable history" : "History is not persistent"}</span>}<button className="quiet" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>
    </div>
    <div className="review-controls" aria-label="Review filters">
      <div className="review-filter-group" role="group" aria-label="Time range">
        {([ ["hour", "Last hour"], ["today", "Today"], ["all", "All"] ] as const).map(([value, label]) =>
          <button className={range === value ? "selected" : ""} key={value} onClick={() => setRange(value)}>{label}</button>,
        )}
      </div>
      <div className="review-filter-group" role="group" aria-label="Review status">
        <button className={!showAll ? "selected" : ""} onClick={() => setShowAll(false)}>Pending</button>
        <button className={showAll ? "selected" : ""} onClick={() => setShowAll(true)}>All</button>
      </div>
      <label className="review-search"><Search size={16} /><span className="sr-only">Search reviews</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prompt, title, or report" /></label>
    </div>
    {loading && <p className="muted review-loading">Loading review history…</p>}
    {!loading && !response && <section className="empty-state"><FileWarning size={20} /><h2>Review history is unavailable</h2><p>The saved record could not be loaded. The workspace has not assumed anything was reviewed.</p><button className="quiet" onClick={() => void refresh()}>Try again</button></section>}
    {!loading && response && reviews.length === 0 && <section className="empty-state"><Clock3 size={20} /><h2>No matching review records</h2><p>{range === "hour" ? "Nothing completed in the last hour matches these filters." : "No saved review result matches these filters."}</p></section>}
    <section className="review-list" aria-label="Review history">
      {reviews.map((review) => <article className={`review-card review-${review.kind}`} key={review.id}>
        <header><div><span className="eyebrow">{review.kind === "closed" ? "closed · recorded" : `${review.kind}${review.reviewedAt ? " · reviewed" : " · pending"}`}</span><h2>{review.title || "Untitled result"}</h2></div><time dateTime={review.completedAt || review.closedAt || review.createdAt}>{timestamp(review.completedAt || review.closedAt || review.createdAt)}</time></header>
        <dl className="review-meta"><div><dt>Lane</dt><dd>{review.lane || "Not recorded"}</dd></div><div><dt>Provider</dt><dd>{review.provider || "Not recorded"}</dd></div><div><dt>Session</dt><dd>{review.nativeSessionId || review.sessionId}</dd></div>{review.closedAt && <div><dt>Closed</dt><dd>{timestamp(review.closedAt)}</dd></div>}</dl>
        <section><h3>Original prompt</h3><p className="review-copy">{review.prompt || "No original prompt was recorded."}</p></section>
        <section><h3>Outcome</h3><p className="review-copy">{review.report || "No report was recorded."}</p>{review.proof && <p className="review-proof">Proof: {review.proof}</p>}{review.evidence?.length ? <ul className="review-evidence" aria-label="Evidence">{review.evidence.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}</ul> : null}</section>
        <div className="review-links"><button className="quiet" onClick={() => void openLink(review, { label: "Open report", url: "https://report.local" }, -1)}><ExternalLink size={14} />Open report</button>{review.links.map((link, index) => <button key={`${link.url}-${index}`} className="quiet" onClick={() => void openLink(review, link, index)} disabled={!allowedLink(link.url)} title={allowedLink(link.url) ? link.url : "Unsupported link address"}><ExternalLink size={14} />{link.label || "Open link"}</button>)}</div>
        <footer>{review.kind === "result" ? <button className="primary" disabled={updating === review.id} onClick={() => void acknowledge(review, !review.reviewedAt)}><Check size={15} />{updating === review.id ? "Saving…" : review.reviewedAt ? "Mark unreviewed" : "Mark reviewed"}</button> : <p className="review-pending">{review.kind === "decision" ? "Decision remains pending." : review.kind === "blocked" ? "Block remains pending." : "This closed session has no completion result."}</p>}{review.cwd && <code>{review.cwd}</code>}</footer>
      </article>)}
    </section>
  </main>;
}
