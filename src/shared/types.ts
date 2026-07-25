// Types shared by the Electron main process and the React renderer.
// Keep this file dependency-free: it is imported from both sides of the IPC bridge.

export type SessionStatus =
  | 'starting'   // pty spawned, no output yet
  | 'working'    // output arrived in the last few seconds
  | 'idle'       // quiet, assume it is waiting for you
  | 'exited'     // process ended

export type Agent = 'claude' | 'codex'

export interface Project {
  name: string
  path: string
  /** epoch ms of the newest Claude Code transcript for this path, 0 if never used */
  lastUsed: number
  isGit: boolean
}

export interface Session {
  id: string
  title: string
  cwd: string
  agent: Agent
  status: SessionStatus
  /** epoch ms of the most recent pty output */
  lastOutput: number
  createdAt: number
  exitCode?: number
}

export interface StartSessionRequest {
  cwd: string
  title?: string
  agent?: Agent
  /** resume the most recent session in that directory (`claude --continue`) */
  resume?: boolean
  /** text typed into the agent once it is ready */
  prompt?: string
}

/** Shape exposed on window.api by the preload script. */
export interface Api {
  listProjects(): Promise<Project[]>
  listSessions(): Promise<Session[]>
  startSession(req: StartSessionRequest): Promise<Session>
  killSession(id: string): Promise<void>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** replay of everything the pty printed so far, for re-attaching a pane */
  getBuffer(id: string): Promise<string>
  onData(cb: (id: string, data: string) => void): () => void
  onSessions(cb: (sessions: Session[]) => void): () => void
}
