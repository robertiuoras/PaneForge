import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  api,
  itemText,
  working,
  type TerminalRecord,
  type WorkspaceSession,
} from "./workspace-model";

export default function WorkspaceTerminal({
  session,
  terminals,
  setNotice,
}: {
  session: WorkspaceSession;
  terminals: TerminalRecord[];
  setNotice: (text: string) => void;
}) {
  const [launching, setLaunching] = useState(false);
  const [opened, setOpened] = useState<TerminalRecord | null>(null);
  useEffect(() => { setOpened(null); }, [session.id]);
  const attached = terminals.filter(
    (terminal) => terminal.sessionId === session.id,
  );
  if (opened?.sessionId === session.id && !attached.some((item) => item.id === opened.id)) attached.push(opened);
  const live = attached.some((terminal) => !terminal.exited);
  const canResume = session.provider === "codex" && Boolean(session.nativeSessionId || session.providerThreadId) && !working(session) && !session.activeTurn;
  const launch = async () => {
    setLaunching(true);
    try {
      const result = await api<{ id: string }>("/api/terminal/launch", {
        sessionId: session.id, projectId: session.projectId, machine: "mac",
      });
      setOpened({ id: result.id, sessionId: session.id });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not resume this CLI.");
    } finally { setLaunching(false); }
  };
  return (
    <div className="raw-output" aria-label="Raw session output">
      {!live && (
        <div className="terminal-launch">
          <button className="quiet" disabled={!canResume || launching} onClick={launch}>
            {launching ? "Opening CLI…" : "Resume in CLI"}
          </button>
          <p className="muted">{canResume ? "Continue this conversation in the Mac CLI. Exit the CLI to return control to chat." : "CLI resume is available when this Codex conversation is idle and its native identity is confirmed."}</p>
        </div>
      )}
      {attached.map((terminal) => (
        <SavedTerminal
          key={terminal.id}
          terminal={terminal}
          setNotice={setNotice}
        />
      ))}
      {!attached.length && (
        <p className="muted">
          No terminal is attached to this session. Its raw provider history is
          preserved below.
        </p>
      )}
      <details open={!attached.length}>
        <summary>Raw provider history</summary>
        <pre>
          {session.items
            .map((item) =>
              item.command
                ? `${item.command}\n${itemText(item)}`
                : itemText(item) || JSON.stringify(item),
            )
            .join("\n\n") || "No provider output recorded."}
        </pre>
      </details>
    </div>
  );
}
function SavedTerminal({
  terminal,
  setNotice,
}: {
  terminal: TerminalRecord;
  setNotice: (text: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState("Connecting to saved output…");
  const [owns, setOwns] = useState(false);
  const [online, setOnline] = useState(false);
  useEffect(() => {
    let disposed = false,
      owner = false,
      retry: ReturnType<typeof setTimeout>;
    const view = new Terminal({
      cursorBlink: false,
      screenReaderMode: true,
      fontFamily: "Menlo, Consolas, monospace",
      fontSize: 12,
      theme: { background: "#111416", foreground: "#d1d5d6" },
      cols: terminal.cols || 100,
      rows: terminal.rows || 24,
      scrollback: 5000,
    });
    view.open(mount.current!);
    const write = (data: string, cols?: number, rows?: number) =>
      new Promise<void>((resolve) => {
        if (disposed) return resolve();
        if (cols && rows) view.resize(cols, rows);
        view.write(data, resolve);
      });
    let writes = Promise.resolve();
    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal`,
      );
      socket.current = ws;
      ws.onopen = () => {
        if (disposed) return ws.close();
        setOnline(true);
        ws.send(JSON.stringify({ type: "open", id: terminal.id }));
      };
      ws.onmessage = (event) => {
        if (disposed) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "replay") {
            writes = writes.then(() => {
              if (!disposed) view.reset();
            });
            for (const chunk of message.chunks || [])
              writes = writes.then(() =>
                write(
                  chunk.data || "",
                  chunk.cols || message.cols,
                  chunk.rows || message.rows,
                ),
              );
            writes = writes.then(() => {
              if (!disposed)
                setStatus(
                  terminal.exited
                    ? "Saved output · process exited"
                    : "Saved output · view only",
                );
            });
          }
          if (message.type === "data")
            writes = writes.then(() =>
              write(message.data, message.cols, message.rows),
            );
          if (message.type === "owner") {
            owner = message.claimedByYou === true;
            setOwns(owner);
            setStatus(
              owner
                ? "You control this existing terminal"
                : "Saved output · view only",
            );
          }
          if (message.type === "locked")
            setNotice(
              message.reason || "Another window controls this terminal.",
            );
          if (message.type === "exit") {
            owner = false;
            setOwns(false);
            setStatus(`Process exited (${message.exitCode}). Output retained.`);
          }
        } catch {
          setNotice(
            "Invalid terminal update. Reopen saved output to reconnect.",
          );
        }
      };
      ws.onclose = () => {
        owner = false;
        if (disposed) return;
        setOwns(false);
        setOnline(false);
        setStatus("Reconnecting to saved output…");
        retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    };
    const input = view.onData((data) => {
      if (owner && socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(
          JSON.stringify({ type: "input", id: terminal.id, data }),
        );
    });
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket.current?.close();
      input.dispose();
      setTimeout(() => view.dispose(), 0);
    };
  }, [terminal.id]);
  return (
    <section className="saved-terminal" aria-label="Existing native terminal">
      <header>
        <span>{status}</span>
        {!owns && !terminal.exited && (
          <button
            className="quiet"
            disabled={!online}
            onClick={() =>
              socket.current?.send(
                JSON.stringify({ type: "claim", id: terminal.id }),
              )
            }
          >
            Take terminal control
          </button>
        )}
      </header>
      <div className="terminal-mount" ref={mount} />
    </section>
  );
}
