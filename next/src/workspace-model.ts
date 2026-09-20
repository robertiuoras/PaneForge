export type Item = {
  id?: string;
  type?: string;
  text?: string;
  content?: { type?: string; text?: string }[];
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  exitCode?: number;
  changes?: { path?: string; kind?: unknown }[];
  [key: string]: unknown;
};
export type Receipt = {
  schemaVersion?: number;
  id: string;
  sessionId?: string;
  intentId: string;
  action: string;
  state: string;
  requestedAt: string;
  observedAt?: string;
  error?: string;
  evidence: { kind: string; ref: string }[];
};
export type WorkspaceAction = {
  callId: string;
  clientId: string;
  status: string;
  createdAt: string;
  presentationAck?: unknown;
  result?: {
    state?: string;
    type?: string;
    sessionId?: string;
    mode?: string;
    path?: string;
    text?: string;
    [key: string]: unknown;
  };
};
export type WorkspaceSession = {
  schemaVersion: number;
  id: string;
  sessionNumber?: number;
  kind?: string;
  title: string;
  objective: string;
  projectId?: string;
  laneId?: string;
  laneName?: string;
  cwd: string;
  machine?: string;
  provider: string;
  nativeSessionId?: string | null;
  providerThreadId?: string | null;
  providerLineage?: unknown[];
  requestedModel?: string | null;
  requestedEffort?: string | null;
  confirmedModel?: string | null;
  confirmedEffort?: string | null;
  executionState: string;
  proofState: string;
  revision: number;
  activeTurn?: string | null;
  status?: string;
  error?: string;
  permissions?: unknown;
  group?: string;
  items: Item[];
  workspaceActions?: WorkspaceAction[];
  voiceHistory?: { id?: string; role?: string; text?: string }[];
  usage?: unknown;
};
export type Project = {
  id: string;
  name: string;
  projectName?: string;
  path?: string;
};
export type Lane = {
  id: string;
  name: string;
  path: string;
  isCurrent?: boolean;
};
export type Workspace = {
  schemaVersion: 1;
  sequence: number;
  sessions: WorkspaceSession[];
  receipts: Receipt[];
  projects: Project[];
  connection: string;
};
export type TerminalRecord = {
  id: string;
  sessionId?: string;
  owner?: string | null;
  cols?: number;
  rows?: number;
  exited?: boolean;
  exitCode?: number;
  spawnError?: string;
  code?: {
    machine?: "mac" | "pc";
    provider?: "codex" | "claude";
    nativeSessionId: string | null;
    checkout?: string | null;
    host: string | null;
  };
};
export type SupervisorState = {
  reviewOnly?: boolean;
  workspace?: Workspace;
  fixture?: boolean;
  provider?: { status: string; error?: string };
  sessions?: WorkspaceSession[];
  receipts?: Receipt[];
  approvals?: {
    id: string;
    method: string;
    threadId: string;
    params: unknown;
  }[];
  terminals?: TerminalRecord[];
};
export const emptyWorkspace: Workspace = {
  schemaVersion: 1,
  sequence: 0,
  sessions: [],
  receipts: [],
  projects: [],
  connection: "connecting",
};
export const needsAttention = (s: WorkspaceSession) =>
  ["blocked", "waiting", "failed", "uncertain", "unknown"].includes(
    s.executionState,
  ) || s.proofState === "check_failed";
export const working = (s: WorkspaceSession) =>
  ["queued", "starting", "running", "stopping"].includes(s.executionState);
export function itemText(item: Item): string {
  return (
    item.text ||
    item.content
      ?.map((value) => value.text || "")
      .filter(Boolean)
      .join("\n") ||
    item.aggregatedOutput ||
    ""
  );
}
export function itemLabel(item: Item): string {
  if (/user/i.test(item.type || "")) return "Brief";
  if (/command/i.test(item.type || "")) return "Command";
  if (/fileChange/i.test(item.type || "")) return "Files changed";
  if (/tool/i.test(item.type || "")) return "Tool action";
  if (/reason/i.test(item.type || "")) return "Progress";
  return "Agent update";
}
export function nativeIdentity(session: WorkspaceSession): string {
  return session.nativeSessionId || session.providerThreadId || "Not confirmed";
}
export function saved(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: string): void {
  localStorage.setItem(key, value);
}
export function projectState(
  state: SupervisorState,
  projects: Project[],
): Workspace {
  // Renderer projection only. Unknown proof/model/identity stays unknown. The
  // legacy supervisor remains the owner of provider and persisted session state.
  return {
    schemaVersion: 1,
    sequence: 0,
    connection: "connected",
    projects,
    receipts: state.receipts || [],
    sessions: (state.sessions || []).map((session) => ({
      ...session,
      objective: session.objective || session.title || "",
      items: session.items || [],
      revision: session.revision || 0,
      executionState:
        session.executionState ||
        (session.activeTurn
          ? "running"
          : session.status === "failed"
            ? "failed"
            : session.status === "uncertain"
              ? "uncertain"
              : session.items?.length
                ? "waiting"
                : "draft"),
      proofState: session.proofState || "unverified",
    })),
  };
}
export async function api<T>(
  url: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw Error(result.error || `Request failed (${response.status})`);
  return result as T;
}
