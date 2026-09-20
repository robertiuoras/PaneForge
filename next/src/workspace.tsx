import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  ChevronDown,
  Circle,
  CircleAlert,
  Command,
  FileText,
  Folder,
  Layers,
  ListChecks,
  Mic,
  Plus,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useVoice } from "./voice";
import {
  api,
  emptyWorkspace,
  itemLabel,
  itemText,
  nativeIdentity,
  needsAttention,
  projectState,
  saved,
  save,
  working,
  type Lane,
  type Project,
  type SupervisorState,
  type Workspace,
  type WorkspaceSession,
} from "./workspace-model";
import { Review } from "./review";
const RawTerminal = lazy(() => import("./workspace-terminal"));
const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const human = (value: string) => value.replaceAll("_", " ");
const time = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

export function WorkspaceApp() {
  const [clientId] = useState(() => {
    const key = "paneforge-next.workspace-client";
    try {
      const value = sessionStorage.getItem(key) || crypto.randomUUID();
      sessionStorage.setItem(key, value);
      return value;
    } catch {
      return crypto.randomUUID();
    }
  });
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [state, setState] = useState<SupervisorState>({});
  const [connection, setConnection] = useState("connecting");
  const [selectedId, setSelectedId] = useState(() =>
    saved("paneforge-selected-session"),
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [typed, setTyped] = useState(false);
  const [raw, setRaw] = useState(false);
  const [view, setView] = useState(() =>
    window.location.hash === "#review" ? "review" : "workspace",
  );
  const [globalDraft, setGlobalDraft] = useState(() =>
    saved("paneforge-assistant-draft"),
  );
  const [pending, setPending] = useState(false);
  const [presentation, setPresentation] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const assistantPreparing = useRef(false);
  const handled = useRef(new Set<string>());
  const pendingAction = useRef<{ signature: string; requestId: string } | null>(
    null,
  );
  const eventRevision = useRef(0);
  const sessions = workspace.sessions.filter((s) => s.kind !== "assistant");
  const selected = sessions.find((s) => s.id === selectedId) || sessions[0];
  const assistant =
    workspace.sessions.find((s) => s.kind === "assistant") ||
    state.sessions?.find((s) => s.kind === "assistant");
  const reviewOnly = (state as SupervisorState & { reviewOnly?: boolean }).reviewOnly === true;
  const online = connection === "connected" && !reviewOnly;
  const voice = useVoice(assistant?.id, clientId);
  const attention = sessions.filter(needsAttention);
  const liveCount = sessions.filter(working).length;
  const projectName = (id?: string) => {
    const project = workspace.projects.find((p) => p.id === id);
    return project?.projectName || project?.name || "Unmapped project";
  };
  const updateState = useCallback((next: SupervisorState) => {
    setState(next);
    setWorkspace((current) => projectState(next, current.projects));
  }, []);
  const refresh = useCallback(async () => {
    const revision = eventRevision.current;
    const [next, projects] = await Promise.all([
      api<SupervisorState>("/api/state"),
      api<{ projects: Project[] }>("/api/projects"),
    ]);
    if (revision === eventRevision.current) updateState(next);
    setWorkspace((current) => ({ ...current, projects: projects.projects }));
  }, [updateState]);
  useEffect(() => {
    const syncView = () => setView(window.location.hash === "#review" ? "review" : "workspace");
    window.addEventListener("hashchange", syncView);
    return () => window.removeEventListener("hashchange", syncView);
  }, []);
  useEffect(() => {
    if (reviewOnly) setView("review");
  }, [reviewOnly]);
  useEffect(() => {
    let disposed = false;
    const events = new EventSource(
      `/api/events?client=${encodeURIComponent(clientId)}`,
    );
    const receive = (event: MessageEvent) => {
      if (disposed) return;
      try {
        const next = JSON.parse(event.data);
        eventRevision.current++;
        updateState(next);
        setConnection("connected");
      } catch {
        setNotice(
          "A workspace update was invalid. Saved work remains available.",
        );
      }
    };
    events.addEventListener("state", receive);
    events.onmessage = receive;
    events.onopen = () => {
      if (!disposed) void refresh().catch((error) => setNotice(error.message));
    };
    events.onerror = () => {
      if (!disposed) setConnection("reconnecting");
    };
    void refresh().catch((error) => {
      if (!disposed) {
        setConnection("reconnecting");
        setNotice(error.message);
      }
    });
    return () => {
      disposed = true;
      events.close();
    };
  }, [clientId, refresh, updateState]);
  useEffect(() => {
    try {
      save("paneforge-selected-session", selected?.id || "");
    } catch {
      setNotice("Selection could not be saved.");
    }
  }, [selected?.id]);
  useEffect(() => {
    try {
      save("paneforge-assistant-draft", globalDraft);
    } catch {
      setNotice(
        "Draft could not be saved. Keep this window open until you copy it.",
      );
    }
  }, [globalDraft]);
  useEffect(() => {
    if (
      !online ||
      state.provider?.status !== "ready" ||
      assistant ||
      assistantPreparing.current
    )
      return;
    assistantPreparing.current = true;
    void api<WorkspaceSession>("/api/assistant", {})
      .then((next) => {
        setState((current) => ({
          ...current,
          sessions: [
            next,
            ...(current.sessions || []).filter((s) => s.id !== next.id),
          ],
        }));
        return refresh();
      })
      .catch((error) => setNotice(`Controller: ${error.message}`))
      .finally(() => {
        assistantPreparing.current = false;
      });
  }, [online, state.provider?.status, assistant, refresh]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.altKey &&
        event.code === "KeyV" &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        if (online && assistant) void voice.toggle();
      }
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !creating &&
        !presentation &&
        !(
          event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            /INPUT|TEXTAREA|SELECT/.test(event.target.tagName))
        )
      ) {
        event.preventDefault();
        document
          .querySelector<HTMLInputElement>(".agent-search input")
          ?.focus();
      }
      if (event.key === "Escape") {
        setCreating(false);
        setPresentation(null);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [assistant, online, voice.toggle, creating, presentation]);
  useEffect(() => {
    for (const action of assistant?.workspaceActions || []) {
      if (
        action.clientId !== clientId ||
        action.status !== "completed" ||
        action.result?.state !== "navigation_requested" ||
        action.presentationAck ||
        handled.current.has(action.callId)
      )
        continue;
      handled.current.add(action.callId);
      let error = "";
      try {
        const key = `paneforge-action:${action.callId}`;
        const previous = sessionStorage.getItem(key);
        if (previous)
          throw Error(
            "Presentation was already attempted. Ask Live to open it again.",
          );
        sessionStorage.setItem(key, "attempted");
        if (Date.now() - Date.parse(action.createdAt) > 60_000)
          throw Error(
            "This presentation expired while disconnected. Ask Live to open it again.",
          );
        if (action.result.type === "session") {
          if (!sessions.some((s) => s.id === action.result?.sessionId))
            throw Error(
              "The requested session is not in the current workspace.",
            );
          setSelectedId(action.result.sessionId!);
          setFilter("all");
          setProjectFilter("");
          setQuery("");
          setRaw(action.result.mode === "code");
        } else if (
          action.result.type === "source" ||
          action.result.type === "results"
        )
          setPresentation({
            title: action.result.path || "Controller results",
            text: action.result.text || pretty(action.result),
          });
        else
          throw Error(
            "This presentation is unavailable in the workspace. Its result remains in controller history.",
          );
      } catch (failure) {
        error =
          failure instanceof Error ? failure.message : "Presentation failed";
        setNotice(error);
      }
      const ack = {
        assistantId: assistant!.id,
        callId: action.callId,
        clientId,
        error,
      };
      requestAnimationFrame(() => {
        void api("/api/workspace/ack", ack).catch((failure) =>
          setNotice(`Presentation acknowledgement: ${failure.message}`),
        );
      });
    }
  }, [assistant, clientId, sessions]);
  async function act(action: string, args: Record<string, unknown>) {
    if (!online)
      throw Error("Reconnect before controlling work. Your draft is saved.");
    const signature = JSON.stringify({ action, args });
    if (pendingAction.current?.signature !== signature)
      pendingAction.current = { signature, requestId: crypto.randomUUID() };
    const id = encodeURIComponent(String(args.sessionId || ""));
    if (action === "create_and_submit") {
      const next = await api<WorkspaceSession>("/api/sessions", {
        projectId: args.projectId,
        laneId: args.laneId,
        provider: args.provider,
      });
      try {
        await api(
          `/api/sessions/${encodeURIComponent(next.id)}`,
          { title: args.title },
          "PATCH",
        );
        await api(`/api/sessions/${encodeURIComponent(next.id)}/turn`, {
          text: args.text,
          clientId,
          requestId: pendingAction.current.requestId,
        });
      } catch (error) {
        // Keep the brief against the returned identity. Retrying creation could
        // start a replacement session while the original outcome is uncertain.
        try {
          const drafts = JSON.parse(saved("paneforge-drafts", "{}"));
          save(
            "paneforge-drafts",
            JSON.stringify({ ...drafts, [next.id]: args.text }),
          );
        } catch {
          /* The original new-agent draft remains available. */
        }
        setSelectedId(next.id);
        setCreating(false);
        setRaw(false);
        setFilter("all");
        setProjectFilter("");
        setQuery("");
        const message = `Session ${next.id} was created. Brief submission is unconfirmed; inspect this session before continuing. ${(error as Error).message}`;
        setNotice(message);
        await refresh().catch(() => {});
        throw Error(message);
      }
      setRaw(false);
      pendingAction.current = null;
      await refresh();
      return { sessionId: next.id };
    }
    const path = (
      {
        stop_turn: "stop",
        resume_session: "resume",
        submit_turn: "turn",
        steer_turn: "steer",
      } as Record<string, string>
    )[action];
    if (!path) throw Error("This supervisor action is not supported.");
    await api(`/api/sessions/${id}/${path}`, {
      text: args.text,
      clientId,
      requestId: pendingAction.current.requestId,
    });
    pendingAction.current = null;
    await refresh();
    return { sessionId: String(args.sessionId) };
  }
  function select(session: WorkspaceSession) {
    setSelectedId(session.id);
    setRaw(false);
  }
  async function control(action: string) {
    if (!selected || pending) return;
    setPending(true);
    try {
      await act(action, { sessionId: selected.id });
      setNotice(
        `${human(action)} request accepted. ${action === "stop_turn" ? "Awaiting provider outcome." : "Inspect provider activity for the outcome."}`,
      );
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function sendGlobal(event: FormEvent) {
    event.preventDefault();
    if (!assistant || !globalDraft.trim() || pending || !online) return;
    setPending(true);
    try {
      const key = "paneforge-next.controller-intent";
      const previous = JSON.parse(saved(key, "null")) as {
        text: string;
        requestId: string;
      } | null;
      const intent =
        previous?.text === globalDraft
          ? previous
          : { text: globalDraft, requestId: crypto.randomUUID() };
      save(key, JSON.stringify(intent));
      await api(`/api/sessions/${encodeURIComponent(assistant.id)}/turn`, {
        ...intent,
        clientId,
      });
      setGlobalDraft("");
      save(key, "null");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setPending(false);
    }
  }
  const visible = sessions.filter(
    (s) =>
      (!projectFilter || s.projectId === projectFilter) &&
      (filter !== "attention" || needsAttention(s)) &&
      (filter !== "working" || working(s)) &&
      `#${s.sessionNumber} ${s.title} ${s.objective} ${projectName(s.projectId)} ${s.laneName || ""} ${s.provider}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const controllerMessage =
    [...(assistant?.voiceHistory || [])]
      .reverse()
      .find((item) => item.role === "assistant" && item.text)?.text ||
    [...(assistant?.items || [])].reverse().map(itemText).find(Boolean);
  function showWorkspace() {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setView("workspace");
  }
  return (
    <div className="workspace-app">
      <a className="skip-link" href="#agent-field">
        Skip to agent workspace
      </a>
      <header className="live-rail">
        <div className="brand">
          <Layers size={22} />
          <span>
            PaneForge <b>Next</b>
          </span>
        </div>
        {!reviewOnly && <button
          className={`live-button ${voice.active ? "is-live" : ""}`}
          onClick={() => void voice.toggle()}
          disabled={!assistant || !online}
          title="Toggle GPT Live · Alt V"
          aria-pressed={voice.active}
        >
          <Mic size={19} />
          <span>
            <strong>
              {voice.active ? human(voice.phase) : "Talk to GPT Live"}
            </strong>
            <small>
              {voice.active
                ? "Click to end voice"
                : "Your workspace controller"}
            </small>
          </span>
          {voice.active ? <Square size={14} /> : <kbd>⌥ V</kbd>}
        </button>}
        <div className="live-context">
          <span className={`connection-dot ${online ? "connected" : ""}`} />
          <span>
            {online
              ? state.fixture
                ? "Fixture workspace"
                : "Workspace connected"
              : human(connection)}
            <small>
              {liveCount} working · {attention.length} need attention
            </small>
          </span>
        </div>
        {!reviewOnly && <button
          className="quiet typed-toggle"
          aria-expanded={typed}
          onClick={() => setTyped(!typed)}
        >
          <Command size={16} /> Type a command
        </button>}
      </header>
      {!reviewOnly && (voice.detail || (!voice.status.configured && voice.status.reason)) && (
        <div className="voice-note">
          <AudioLines size={14} />
          {voice.detail || voice.status.reason}
          <span>Typed control is available.</span>
        </div>
      )}
      {(typed || voice.active) && (
        <section className="controller" aria-label="Workspace controller">
          <div>
            <span className="eyebrow">GPT LIVE · GLOBAL CONTEXT</span>
            <p>
              {controllerMessage ||
                "Create an agent, check progress, steer work, or ask what needs your attention."}
            </p>
          </div>
          {typed && (
            <form onSubmit={sendGlobal}>
              <label className="sr-only" htmlFor="global-command">
                Workspace command
              </label>
              <textarea
                id="global-command"
                value={globalDraft}
                onChange={(event) => setGlobalDraft(event.target.value)}
                placeholder="Ask Live to work across your agents…"
                rows={2}
              />
              <button
                className="primary"
                disabled={
                  !online || !assistant || pending || !globalDraft.trim()
                }
              >
                <ArrowRight size={18} />
                <span className="sr-only">Send workspace command</span>
              </button>
            </form>
          )}
        </section>
      )}
      <div className="workspace-body">
        <nav className="workspace-index" aria-label="Workspace index">
          <div className="index-heading">
            <span className="eyebrow">WORKSPACE</span>
            <span className="small-tag">{sessions.length}</span>
          </div>
          <button
            className={`index-link ${view === "workspace" && filter === "all" && !projectFilter ? "selected" : ""}`}
            onClick={() => {
              showWorkspace();
              setFilter("all");
              setProjectFilter("");
            }}
            disabled={reviewOnly}
          >
            <Layers size={16} />
            All agents<span>{sessions.length}</span>
          </button>
          <button
            className={`index-link ${view === "workspace" && filter === "working" ? "selected" : ""}`}
            onClick={() => {
              showWorkspace();
              setFilter("working");
              setProjectFilter("");
            }}
            disabled={reviewOnly}
          >
            <Circle size={15} />
            Working<span>{liveCount}</span>
          </button>
          <button
            className={`index-link ${view === "workspace" && filter === "attention" ? "selected" : ""}`}
            onClick={() => {
              showWorkspace();
              setFilter("attention");
              setProjectFilter("");
            }}
            disabled={reviewOnly}
          >
            <CircleAlert size={16} />
            Needs attention<span>{attention.length}</span>
          </button>
          <button
            className={`index-link ${view === "review" ? "selected" : ""}`}
            onClick={() => {
              window.location.hash = "review";
              setView("review");
            }}
          >
            <ListChecks size={16} />
            Review
          </button>
          <div className="index-heading projects-heading">
            <span className="eyebrow">PROJECTS</span>
          </div>
          {workspace.projects.map((project) => (
            <button
              className={`index-link project-link ${projectFilter === project.id ? "selected" : ""}`}
              key={project.id}
              onClick={() => {
                showWorkspace();
                setProjectFilter(project.id);
                setFilter("all");
              }}
              disabled={reviewOnly}
              title={project.path}
            >
              <Folder size={15} />
              <span>{project.projectName || project.name}</span>
              <small>
                {sessions.filter((s) => s.projectId === project.id).length}
              </small>
            </button>
          ))}
          <div className="index-footer">
            <ShieldCheck size={17} />
            <p>
              Exact session identity.
              <small>Evidence stays with the work.</small>
            </p>
          </div>
        </nav>
        {view === "review" ? <Review setNotice={setNotice} reviewOnly={reviewOnly} /> : <>
        <main className="agent-field" id="agent-field" tabIndex={-1}>
          <div className="field-heading">
            <div>
              <span className="eyebrow">YOUR AGENT WORKSPACE</span>
              <h1>
                {filter === "attention"
                  ? "What needs you"
                  : projectFilter
                    ? projectName(projectFilter)
                    : "Move the work forward."}
              </h1>
              <p>Give direction. See what happened. Review the proof.</p>
            </div>
            <button
              className="primary"
              onClick={() => setCreating(true)}
              disabled={!online}
            >
              <Plus size={17} />
              New agent
            </button>
          </div>
          <label className="agent-search">
            <Search size={17} />
            <input
              aria-label="Find agents"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an objective, project, or agent number"
            />
            <kbd>/</kbd>
          </label>
          <section aria-label="Agents">
            {[
              ...new Set(
                visible.map(
                  (session) => session.group || "Independent objectives",
                ),
              ),
            ].map((group) => (
              <section
                className="objective-group"
                key={group}
                aria-label={`Objective: ${group}`}
              >
                <header className="objective-heading">
                  <Layers size={14} />
                  <h2>{group}</h2>
                  <span>
                    {
                      visible.filter(
                        (session) =>
                          (session.group || "Independent objectives") === group,
                      ).length
                    }{" "}
                    agents
                  </span>
                </header>
                <div className="agent-cards">
                  {visible
                    .filter(
                      (session) =>
                        (session.group || "Independent objectives") === group,
                    )
                    .map((session) => (
                      <button
                        className={`agent-row ${selected?.id === session.id ? "active" : ""}`}
                        key={session.id}
                        onClick={() => select(session)}
                        aria-pressed={selected?.id === session.id}
                      >
                        <span className="agent-number">
                          #{session.sessionNumber ?? "?"}
                        </span>
                        <div className="row-summary">
                          <h2>{session.title || "Untitled objective"}</h2>
                          <p>
                            {session.objective || "No objective recorded yet."}
                          </p>
                          <small>
                            {projectName(session.projectId)}
                            {session.laneName
                              ? ` / ${session.laneName}`
                              : ""} · {session.provider}
                          </small>
                        </div>
                        <div className="row-state">
                          <span
                            className={`status-pill state-${session.executionState}`}
                          >
                            <Circle size={7} fill="currentColor" />
                            {human(session.executionState)}
                          </span>
                          <span
                            className={`proof-tag proof-${session.proofState}`}
                          >
                            <ShieldCheck size={12} />
                            {human(session.proofState)}
                          </span>
                        </div>
                      </button>
                    ))}
                </div>
              </section>
            ))}
            {!visible.length && (
              <div className="empty-state">
                <Layers size={28} />
                <h2>
                  {sessions.length
                    ? "No matching agents"
                    : "Start with an objective"}
                </h2>
                <p>
                  {sessions.length
                    ? "Try another project or search."
                    : "Tell GPT Live what you want done, or create your first agent."}
                </p>
              </div>
            )}
          </section>
          {selected && (
            <section className="selected-work" aria-label="Selected agent work">
              <header className="work-heading">
                <div>
                  <span className="eyebrow">
                    WORK TIMELINE · #{selected.sessionNumber ?? "?"}
                  </span>
                  <h2>{selected.title}</h2>
                </div>
                <div className="work-controls">
                  <button
                    className="quiet"
                    onClick={() => void control("resume_session")}
                    disabled={!online || pending || working(selected)}
                  >
                    Resume
                  </button>
                  <button
                    className="quiet"
                    onClick={() => void control("stop_turn")}
                    disabled={!online || pending || !working(selected)}
                  >
                    <Square size={12} />
                    Stop
                  </button>
                </div>
              </header>
              <div className="state-strip">
                <span>
                  Execution <b>{human(selected.executionState)}</b>
                </span>
                <span>
                  Proof{" "}
                  <b className={`proof-${selected.proofState}`}>
                    {human(selected.proofState)}
                  </b>
                </span>
              </div>
              {selected.error && (
                <p className="exception">
                  <CircleAlert size={16} />
                  {selected.error}
                </p>
              )}
              {(state.approvals || [])
                .filter(
                  (approval) =>
                    approval.threadId === selected.id ||
                    approval.threadId === selected.providerThreadId ||
                    approval.threadId === selected.nativeSessionId,
                )
                .map((approval) => (
                  <div className="approval" key={approval.id}>
                    <strong>Approval required</strong>
                    <p>{approval.method}</p>
                    <pre>{pretty(approval.params)}</pre>
                    <button
                      className="primary"
                      disabled={!online}
                      onClick={() =>
                        void api(
                          `/api/approvals/${encodeURIComponent(approval.id)}`,
                          { decision: "accept" },
                        )
                          .then(refresh)
                          .catch((error) => setNotice(error.message))
                      }
                    >
                      Allow once
                    </button>
                    <button
                      className="quiet"
                      disabled={!online}
                      onClick={() =>
                        void api(
                          `/api/approvals/${encodeURIComponent(approval.id)}`,
                          { decision: "decline" },
                        )
                          .then(refresh)
                          .catch((error) => setNotice(error.message))
                      }
                    >
                      Decline
                    </button>
                  </div>
                ))}
              <div className="timeline">
                {selected.items
                  ?.filter(
                    (item) => itemText(item) || item.command || item.changes,
                  )
                  .map((item, index) => (
                    <article className="timeline-entry" key={item.id || index}>
                      <div className="timeline-dot">
                        <Circle size={9} />
                      </div>
                      <div>
                        <span className="eyebrow">
                          {itemLabel(item)}
                          {item.status ? ` · ${human(item.status)}` : ""}
                        </span>
                        {item.command && <code>{item.command}</code>}
                        {itemText(item) && <p>{itemText(item)}</p>}
                        {item.changes?.map((change, n) => (
                          <code key={n}>{change.path}</code>
                        ))}
                        {item.exitCode !== undefined && (
                          <small>
                            Exit {item.exitCode}. This alone does not verify the
                            objective.
                          </small>
                        )}
                      </div>
                    </article>
                  ))}
                {!selected.items?.length && (
                  <p className="muted timeline-empty">
                    Provider activity will appear here. Opening this agent sends
                    no prompt.
                  </p>
                )}
              </div>
              <BriefComposer
                key={selected.id}
                session={selected}
                disabled={!online || pending}
                act={act}
                setNotice={setNotice}
              />
              <button
                className="raw-toggle"
                aria-expanded={raw}
                onClick={() => setRaw(!raw)}
              >
                <Terminal size={16} />
                {raw ? "Close raw terminal" : "Open raw terminal"}
                <span>Native output, on demand</span>
                <ChevronDown size={16} />
              </button>
              {raw && (
                <Suspense
                  fallback={<p className="muted">Opening saved output…</p>}
                >
                  <RawTerminal
                    session={selected}
                    terminals={state.terminals || []}
                    setNotice={setNotice}
                  />
                </Suspense>
              )}
            </section>
          )}
        </main>
        <aside className="workspace-inspector" aria-label="Session inspector">
          <span className="eyebrow">INSPECTOR</span>
          {selected ? (
            <>
              <h2>
                #{selected.sessionNumber ?? "?"} · {selected.title}
              </h2>
              <div className="inspector-section">
                <h3>Objective</h3>
                <p>{selected.objective || "Not recorded"}</p>
              </div>
              <div className="inspector-section">
                <h3>Execution & proof</h3>
                <div className="inspector-states">
                  <span
                    className={`status-pill state-${selected.executionState}`}
                  >
                    {human(selected.executionState)}
                  </span>
                  <span className={`proof-tag proof-${selected.proofState}`}>
                    <ShieldCheck size={13} />
                    {human(selected.proofState)}
                  </span>
                </div>
                <p className="muted">
                  Completion records the turn outcome. Verification needs
                  evidence.
                </p>
              </div>
              <div className="inspector-section">
                <h3>Native identity</h3>
                <dl>
                  <dt>Provider</dt>
                  <dd>{selected.provider}</dd>
                  <dt>Workspace ID</dt>
                  <dd>{selected.id}</dd>
                  <dt>Native session</dt>
                  <dd>{nativeIdentity(selected)}</dd>
                  <dt>Working directory</dt>
                  <dd>{selected.cwd}</dd>
                  <dt>Lane</dt>
                  <dd>
                    {selected.laneName || selected.laneId || "Not recorded"}
                  </dd>
                  <dt>Machine</dt>
                  <dd>{selected.machine || "Not confirmed"}</dd>
                  <dt>Requested model / effort</dt>
                  <dd>
                    {selected.requestedModel || "Provider default"} /{" "}
                    {selected.requestedEffort || "Provider default"}
                  </dd>
                  <dt>Confirmed model / effort</dt>
                  <dd>
                    {selected.confirmedModel || "Not confirmed"} /{" "}
                    {selected.confirmedEffort || "Not confirmed"}
                  </dd>
                  <dt>Permissions</dt>
                  <dd>
                    {selected.permissions
                      ? pretty(selected.permissions)
                      : "Not reported by provider"}
                  </dd>
                </dl>
              </div>
              <div className="inspector-section">
                <h3>Evidence & receipts</h3>
                {workspace.receipts
                  .filter((receipt) => receipt.sessionId === selected.id)
                  .slice()
                  .reverse()
                  .map((receipt) => (
                    <details className="receipt" key={receipt.id}>
                      <summary>
                        <span>{human(receipt.action)}</span>
                        <small>{receipt.state}</small>
                      </summary>
                      <p>
                        {time(receipt.observedAt || receipt.requestedAt)} ·{" "}
                        {receipt.id}
                      </p>
                      {receipt.error && (
                        <p className="exception">{receipt.error}</p>
                      )}
                      {receipt.evidence.map((entry, i) => (
                        <p key={i}>
                          <b>{entry.kind}</b>
                          <code>{entry.ref}</code>
                        </p>
                      ))}
                    </details>
                  ))}
                {!workspace.receipts.some(
                  (receipt) => receipt.sessionId === selected.id,
                ) && <p className="muted">No action receipt recorded yet.</p>}
              </div>
              <div className="inspector-section">
                <h3>Artifacts</h3>
                {selected.items
                  .flatMap((item) => item.changes || [])
                  .map((change, index) => (
                    <div className="artifact" key={index}>
                      <FileText size={15} />
                      <code>{change.path}</code>
                      <ArrowUpRight size={13} />
                    </div>
                  ))}
                {!selected.items.some((item) => item.changes?.length) && (
                  <p className="muted">No file artifacts reported yet.</p>
                )}
              </div>
              {selected.providerLineage?.length ? (
                <details className="receipt">
                  <summary>Provider lineage</summary>
                  <pre>{pretty(selected.providerLineage)}</pre>
                </details>
              ) : null}
              {selected.usage && (
                <details className="receipt">
                  <summary>Reported usage</summary>
                  <pre>{pretty(selected.usage)}</pre>
                </details>
              )}
            </>
          ) : (
            <p className="muted">
              Select an agent to inspect its identity and evidence.
            </p>
          )}
        </aside>
        </>}
      </div>
      <footer className="workspace-status">
        <span>
          <span className={`connection-dot ${online ? "connected" : ""}`} />
            {reviewOnly
              ? "Review connected to PaneForge"
              : online
            ? state.fixture
              ? "Fixture supervisor connected"
              : "Supervisor connected"
            : "Reconnecting · controls paused · drafts saved"}
        </span>
        <span>
          {state.fixture
            ? "Stage 1 preview · simulated work"
            : "Local workspace"}
        </span>
      </footer>
      {notice && (
        <div className="notice" role="status">
          <CircleAlert size={17} />
          <span>{notice}</span>
            {!reviewOnly && <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={16} />
            </button>}
        </div>
      )}
      {creating && (
        <CreateAgent
          projects={workspace.projects}
          act={act}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setSelectedId(id);
            setCreating(false);
            setFilter("all");
            setProjectFilter("");
            setQuery("");
          }}
        />
      )}
      {presentation && (
        <div className="modal-backdrop">
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="presentation-title"
          >
            <header>
              <h2 id="presentation-title">{presentation.title}</h2>
              <button
                aria-label="Close results"
                onClick={() => setPresentation(null)}
              >
                <X size={18} />
              </button>
            </header>
            <pre>{presentation.text}</pre>
          </section>
        </div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
          {reviewOnly
            ? "Review connected to PaneForge"
            : online
          ? `${liveCount} agents working. ${attention.length} need attention.`
          : "Workspace reconnecting. Controls paused."}
      </div>
    </div>
  );
}

type Act = (
  action: string,
  args: Record<string, unknown>,
) => Promise<{ sessionId?: string }>;
function BriefComposer({
  session,
  disabled,
  act,
  setNotice,
}: {
  session: WorkspaceSession;
  disabled: boolean;
  act: Act;
  setNotice: (text: string) => void;
}) {
  const [text, setText] = useState(() => {
    try {
      return JSON.parse(saved("paneforge-drafts", "{}"))[session.id] || "";
    } catch {
      return "";
    }
  });
  const [sending, setSending] = useState(false);
  useEffect(() => {
    try {
      const drafts = JSON.parse(saved("paneforge-drafts", "{}"));
      save(
        "paneforge-drafts",
        JSON.stringify({ ...drafts, [session.id]: text }),
      );
    } catch {
      setNotice("This draft could not be saved. Copy it before closing.");
    }
  }, [text, session.id, setNotice]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || disabled || sending) return;
    setSending(true);
    try {
      await act(working(session) ? "steer_turn" : "submit_turn", {
        sessionId: session.id,
        text,
      });
      setText("");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <form className="brief-composer" onSubmit={submit}>
      <label htmlFor="agent-brief">
        {working(session) ? "Steer this agent" : "Brief this agent"}
      </label>
      <div>
        <textarea
          id="agent-brief"
          placeholder={
            working(session)
              ? "Add direction without losing the current work…"
              : "Give this agent its next instruction…"
          }
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          className="primary"
          disabled={disabled || sending || !text.trim()}
        >
          <ArrowRight size={17} />
          <span className="sr-only">
            {working(session) ? "Send steering" : "Send brief"}
          </span>
        </button>
      </div>
      <small>Drafts stay with their native session.</small>
    </form>
  );
}
function CreateAgent({
  projects,
  act,
  onClose,
  onCreated,
}: {
  projects: Project[];
  act: Act;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [draft, setDraft] = useState(() => {
    try {
      return {
        title: "",
        text: "",
        projectId: projects[0]?.id || "",
        provider: "codex",
        ...JSON.parse(saved("paneforge-next.new-agent-draft", "{}")),
      };
    } catch {
      return {
        title: "",
        text: "",
        projectId: projects[0]?.id || "",
        provider: "codex",
      };
    }
  });
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [laneId, setLaneId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const container = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    container.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    try {
      save("paneforge-next.new-agent-draft", JSON.stringify(draft));
    } catch {
      setError(
        "Draft storage unavailable. Keep this dialog open until submitted.",
      );
    }
  }, [draft]);
  useEffect(() => {
    let current = true;
    setLanes([]);
    setLaneId("");
    if (draft.projectId)
      void api<{ lanes: Lane[] }>(
        `/api/projects/${encodeURIComponent(draft.projectId)}/lanes`,
      )
        .then((result) => {
          if (current) {
            setLanes(result.lanes);
            setLaneId(
              result.lanes.find((lane) => lane.isCurrent)?.id ||
                result.lanes[0]?.id ||
                "",
            );
          }
        })
        .catch((failure) => {
          if (current) setError(failure.message);
        });
    return () => {
      current = false;
    };
  }, [draft.projectId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await act("create_and_submit", { ...draft, laneId });
      if (!result.sessionId)
        throw Error(
          "No session identity was returned. Inspect the workspace before retrying.",
        );
      save("paneforge-next.new-agent-draft", "{}");
      onCreated(result.sessionId);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <form
        ref={container}
        className="dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const nodes = [
            ...container.current!.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input,select,textarea",
            ),
          ];
          const first = nodes[0],
            last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <span className="eyebrow">A DISTINCT NATIVE SESSION</span>
            <h2 id="create-title">Give an agent an objective.</h2>
          </div>
          <button type="button" aria-label="Close new agent" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <label>
          Agent title
          <input
            required
            maxLength={160}
            value={draft.title}
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
            placeholder="What should this agent deliver?"
          />
        </label>
        <label>
          Objective
          <textarea
            required
            maxLength={32000}
            rows={4}
            value={draft.text}
            onChange={(event) =>
              setDraft({ ...draft, text: event.target.value })
            }
            placeholder="Describe the outcome, constraints, and what proves it is done."
          />
        </label>
        <div className="form-grid">
          <label>
            Project
            <select
              required
              value={draft.projectId}
              onChange={(event) =>
                setDraft({ ...draft, projectId: event.target.value })
              }
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.projectName || project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Provider
            <select
              value={draft.provider}
              onChange={(event) =>
                setDraft({ ...draft, provider: event.target.value })
              }
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
        </div>
        <label>
          Existing lane
          <select
            value={laneId}
            required
            onChange={(event) => setLaneId(event.target.value)}
          >
            {!lanes.length && <option value="">Loading lanes…</option>}
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
        <p className="path-preview">
          {lanes.find((lane) => lane.id === laneId)?.path ||
            "Waiting for a validated working directory."}
        </p>
        <p className="muted">
          Creates a native session and submits this objective. Provider
          permissions remain in force.
        </p>
        {error && (
          <p className="exception" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              busy || !laneId || !draft.title.trim() || !draft.text.trim()
            }
          >
            {busy ? "Starting…" : "Create & brief agent"}
            <ArrowRight size={16} />
          </button>
        </footer>
      </form>
    </div>
  );
}
