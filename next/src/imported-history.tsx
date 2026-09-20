import { useEffect, useState } from "react";
import { FileText, Search } from "lucide-react";
import { api } from "./workspace-model";

type Entry = {
  id: string;
  title: string | null;
  provider: string | null;
  nativeSessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sourceKind: string;
  transcript: { available: boolean; bytes: number; text?: string; truncated?: boolean };
};

export function ImportedHistory() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [malformed, setMalformed] = useState(0);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError("");
    api<{ items: Entry[]; malformed: unknown[]; total: number }>(`/api/history/imported?q=${encodeURIComponent(search)}`, undefined, "GET")
      .then(result => { if (!disposed) { setEntries(result.items); setMalformed(result.malformed.length); setTotal(result.total); } })
      .catch(reason => { if (!disposed) setError(`Saved history could not be loaded: ${reason.message}`); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [search]);
  async function open(entry: Entry) {
    if (opening) return;
    setOpening(entry.id); setError("");
    try { setSelected(await api<Entry>(`/api/history/imported/${encodeURIComponent(entry.id)}`, undefined, "GET")); }
    catch (reason) { setError(`This saved record could not be opened: ${(reason as Error).message}`); }
    finally { setOpening(null); }
  }
  const needle = query.trim().toLowerCase();
  const visible = entries.filter(entry => !needle || `${entry.title || ""} ${entry.provider || ""} ${entry.nativeSessionId || ""}`.toLowerCase().includes(needle));
  return <main className="agent-field review-field" id="agent-field" tabIndex={-1}>
    <div className="field-heading"><div><span className="eyebrow">SAVED HISTORY</span><h1>Return to earlier work.</h1><p>Preserved PaneForge records. Original files stay intact.</p></div><span className="review-storage">Read only</span></div>
    <form className="review-controls" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}><label className="review-search"><Search size={16}/><span className="sr-only">Search saved history</span><input value={query} maxLength={300} onChange={event => setQuery(event.target.value)} placeholder="Search title, provider, or conversation"/></label><button className="quiet" type="submit" disabled={loading}>Search all history</button></form>
    {total > entries.length && <p className="review-proof">Showing {entries.length} of {total} records. Search all history to find older work.</p>}
    {loading && <p className="review-loading">Loading saved history…</p>}
    {error && <p role="alert" className="review-pending">{error}</p>}
    {malformed > 0 && <p className="review-pending">{malformed} saved records could not be read. Their files were preserved.</p>}
    {!loading && !error && !visible.length && <section className="empty-state"><FileText size={20}/><h2>{entries.length ? "No matching records" : "No imported history yet"}</h2><p>{entries.length ? "Try another title or conversation identity." : "Your existing PaneForge history remains in its original location until a verified copy is imported."}</p></section>}
    <section className="review-list" aria-label="Saved history">
      {visible.map(entry => <article className="review-card" key={entry.id}><header><div><span className="eyebrow">{entry.provider || "Provider not recorded"}</span><h2>{entry.title || "Untitled saved output"}</h2></div></header><p className="review-proof">Conversation: {entry.nativeSessionId || "Identity not verified"}</p><button className="quiet" disabled={opening !== null} onClick={() => void open(entry)}>{opening === entry.id ? "Opening…" : "Read saved output"}</button>
        {selected?.id === entry.id && <section aria-label="Saved transcript"><h3>Retained output</h3><pre className="review-copy saved-history-output">{selected.transcript.available ? selected.transcript.text || "This record contains no text." : "No transcript was retained with this record."}</pre>{selected.transcript.truncated && <p className="review-pending">Showing a bounded preview. The complete transcript remains preserved on disk.</p>}<p className="review-proof">Imported records cannot be resumed here. Their identity and output are retained for reference.</p></section>}
      </article>)}
    </section>
  </main>;
}
