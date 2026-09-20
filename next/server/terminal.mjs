import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as pty from 'node-pty'
import { WebSocketServer, WebSocket } from 'ws'
import { PcLanePreparer, startPcCodeTurn } from './pc-lanes.mjs'

const START_COLS = 120
const START_ROWS = 30
const MIN_COLS = 20
const MIN_ROWS = 5
const MAX_COLS = 400
const MAX_ROWS = 200
const MAX_INPUT_BYTES = 32 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_ACTIVE_TERMINALS = 6
const DISPROVEN_RUNNER_ERROR = 'PC CLI connected. Editing and builds are blocked: the installed Codex command runner times out before execution. No Mac fallback.'
const require = createRequire(import.meta.url)

/**
 * A durable terminal executor with explicitly selected Mac or PC CLI launch.
 * The browser is a viewer/controller. `spawnPty` exists only to make the transport testable with a
 * disposable node-pty process.
 */
export class TerminalService {
  constructor ({ dataDir, onChange = () => {}, allowedOrigin = 'http://localhost:4317', spawnPty, prepareTerminal, startCodeTurn, sessionLock = () => null, onMacCliExit = () => {} } = {}) {
    if (!dataDir) throw new Error('TerminalService requires dataDir')
    this.dataDir = dataDir
    this.journalPath = join(dataDir, 'terminal.jsonl')
    this.onChange = onChange
    this.allowedOrigin = allowedOrigin
    this.spawnPty = spawnPty ?? defaultPcPty
    this.prepareTerminal = prepareTerminal ?? (this.spawnPty === defaultPcPty ? defaultPcTerminal : async () => ({}))
    this.startCodeTurn = startCodeTurn ?? startPcCodeTurn
    this.sessionLock = sessionLock
    this.onMacCliExit = onMacCliExit
    this.terminals = new Map()
    this.clients = new Map()
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
    this.journal = Promise.resolve()
    this.creating = new Map()
    this.codeTurns = new Map()
    this.codeCreating = new Map()
    this.loaded = this.loadJournal()
    this.boundUpgrade = null
  }

  async ready () { await this.loaded }

  async loadJournal () {
    await repairMacPtyHelper()
    await mkdir(this.dataDir, { recursive: true })
    let text = ''
    try { text = await readFile(this.journalPath, 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (!event.id || !event.type) continue
      let terminal = this.terminals.get(event.id)
      if (!terminal && event.type === 'create') {
        terminal = Object.assign(storedTerminal(event.id, event.cols, event.rows, { sessionId: event.sessionId, projectId: event.projectId }), event.code ? {code:event.code} : {})
        this.terminals.set(event.id, terminal)
      }
      if (!terminal) continue
      applyJournalEvent(terminal, event)
    }
    // No PTY can be reattached after supervisor shutdown. Preserve its journal
    // and require a new terminal even if a hard shutdown missed the exit event.
    for (const terminal of this.terminals.values()) {
      if (!terminal.exited) { terminal.exited = true; terminal.spawnError = 'Supervisor restarted. Output is preserved; open a new PC terminal.' }
      // Keep raw journal output as evidence, but do not re-publish the exact
      // runner status disproven by the later PC edit/build verification.
      if (terminal.exited && terminal.code?.executionError === DISPROVEN_RUNNER_ERROR) {
        const { executionError: _obsolete, ...code } = terminal.code
        terminal.code = code
      }
      if (terminal.code?.kind === 'job' && terminal.code.status === 'running') terminal.code.status = 'uncertain'
    }
  }

  attach (server) {
    if (this.boundUpgrade) throw new Error('TerminalService is already attached')
    this.boundUpgrade = (req, socket, head) => {
      let url
      try { url = new URL(req.url, this.allowedOrigin) } catch { socket.destroy(); return }
      if (url.pathname === '/api/voice') return // The supervisor owns this separately validated upgrade.
      if (url.pathname !== '/api/terminal' || !sameOrigin(req, this.allowedOrigin)) {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    }
    server.on('upgrade', this.boundUpgrade)
    return () => {
      if (!this.boundUpgrade) return
      server.off('upgrade', this.boundUpgrade)
      this.boundUpgrade = null
    }
  }

  state () {
    return [...this.terminals.values()].map(({ id, sessionId, projectId, owner, cols, rows, exited, exitCode, spawnError, code }) => ({
      id,
      sessionId,
      projectId,
      owner: owner ? 'claimed' : null,
      cols,
      rows,
      exited,
      exitCode,
      spawnError,
      ...(code && Object.keys(code).length ? { code: terminalCodeState(code) } : {})
    }))
  }

  async create ({ sessionId = 'legacy-default', projectId = 'paneforge-next', laneId = null, laneName = null, cwd = null, provider = 'codex', machine = 'pc', nativeSessionId = null, model = 'gpt-6-astra', effort = 'high' } = {}) {
    await this.ready()
    if (!validIdentity(sessionId) || !validIdentity(projectId)) throw new Error('Terminal conversation identity is invalid')
    if (!['mac', 'pc'].includes(machine)) throw Error('Choose Mac or PC')
    if (!['codex', 'claude'].includes(provider)) throw Error('Unknown CLI provider')
    const key = `${projectId}:${sessionId}:${machine}`
    const existing = [...this.terminals.values()].find(t => !t.exited && t.sessionId === sessionId && t.projectId === projectId && t.code?.kind !== 'job' && (t.code?.machine ?? 'pc') === machine)
    if (existing) return { id: existing.id, reused: true }
    if (this.creating.has(key)) return this.creating.get(key)
    if ([...this.terminals.values()].filter(t => !t.exited).length >= MAX_ACTIVE_TERMINALS) throw new Error('All six PC terminal slots are in use. Close or reuse a terminal before opening another.')
    const creating = this.startTerminal({ sessionId, projectId, laneId, laneName, cwd, provider, machine, nativeSessionId, model, effort })
    this.creating.set(key, creating)
    try { return await creating } finally { this.creating.delete(key) }
  }

  async startTerminal ({ sessionId, projectId, laneId, laneName, cwd, provider, machine, nativeSessionId, model, effort }) {
    const id = randomUUID()
    const terminal = storedTerminal(id, START_COLS, START_ROWS, { sessionId, projectId })
    this.terminals.set(id, terminal)
    try {
      await this.record(terminal, { type: 'create', id, sessionId, projectId, cols: terminal.cols, rows: terminal.rows })
      terminal.code = machine === 'mac' ? { machine, checkout: cwd, host: 'mac', provider, laneId, laneName, nativeSessionId, model, effort } : await this.prepareTerminal({ id, sessionId, projectId, laneId, laneName, cwd, provider, dataDir: this.dataDir })
      if (terminal.code && Object.keys(terminal.code).length) await this.record(terminal, { type: 'code', id, code: terminal.code })
      terminal.proc = (machine === 'mac' && this.spawnPty === defaultPcPty ? defaultMacPty : this.spawnPty)({ cols: terminal.cols, rows: terminal.rows, code: terminal.code })
    } catch (error) {
      terminal.exited = true
      terminal.spawnError = String(error.message ?? error)
      await this.record(terminal, { type: 'spawn-error', id, message: terminal.spawnError })
      this.changed()
      throw error
    }
    terminal.proc.onData((data) => this.data(terminal, data))
    terminal.proc.onExit(({ exitCode }) => this.exit(terminal, exitCode))
    this.changed()
    return { id, reused: false }
  }

  async runCodeTurn (args) {
    const key = `${args?.projectId}:${args?.sessionId}`
    const fingerprint = requestFingerprint({ laneId: args?.laneId, provider: args?.provider ?? 'codex', text: args?.text })
    const existing = this.codeCreating.get(key)
    if (existing) {
      if (existing.requestId === args?.requestId && existing.fingerprint === fingerprint) return existing.promise
      throw Error('A different PC Code turn is still preparing for this conversation. Wait for it before continuing.')
    }
    const pending = this._runCodeTurn(args)
    this.codeCreating.set(key, { requestId: args?.requestId, fingerprint, promise: pending })
    try { return await pending } finally { this.codeCreating.delete(key) }
  }

  async _runCodeTurn ({ sessionId, projectId, laneId, laneName, cwd, provider = 'codex', model = null, effort = null, requestId, text }) {
    await this.ready()
    if (!validIdentity(sessionId) || !validIdentity(projectId) || !validIdentity(requestId) || typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16 * 1024) throw Error('PC Code turn is invalid')
    // Raw terminal sessions do not expose a trustworthy native provider ID. A
    // fresh job would create another PC checkout and split this conversation's
    // history, even after the terminal has exited, so it cannot be continued.
    const interactive = [...this.terminals.values()].find(item => item.sessionId === sessionId && item.projectId === projectId && item.code?.kind !== 'job' && item.code?.machine !== 'mac')
    if (interactive) throw Error('This conversation has a legacy interactive PC terminal without a resumable native session. Open a new conversation to run Code.')
    let terminal = [...this.terminals.values()].find(item => item.sessionId === sessionId && item.projectId === projectId && item.code?.kind === 'job')
    const fingerprint = requestFingerprint({ laneId, provider, text })
    if (terminal?.code?.requests?.[requestId]) {
      if (terminal.code.requests[requestId].fingerprint !== fingerprint) throw Error('This PC Code request ID is already bound to different lane, provider, or text.')
      return { id: terminal.id, requestId, state: terminal.code.requests[requestId].status, nativeSessionId: terminal.code.nativeSessionId ?? null }
    }
    if (terminal?.code?.status === 'running') throw Error('A PC Code turn is already running for this conversation. Wait for its result before continuing.')
    if (terminal && this.codeTurns.has(terminal.id)) throw Error('The previous PC Code turn is still finalizing its receipt. Wait before continuing.')
    if (terminal?.code?.status === 'uncertain') throw Error('The previous PC Code turn may still be running after a supervisor restart. Do not retry it automatically.')
    if (!terminal) {
      if ([...this.terminals.values()].filter(item => !item.exited || item.code?.status === 'running').length >= MAX_ACTIVE_TERMINALS) throw Error('All six PC terminal slots are in use. Close or wait for a terminal before continuing Code.')
      const id = randomUUID()
      terminal = storedTerminal(id, START_COLS, START_ROWS, { sessionId, projectId })
      terminal.exited = true
      this.terminals.set(id, terminal)
      await this.record(terminal, { type: 'create', id, sessionId, projectId, cols: terminal.cols, rows: terminal.rows })
      terminal.code = { ...(await this.prepareTerminal({ id, sessionId, projectId, laneId, laneName, cwd, provider, dataDir: this.dataDir })), model, effort, kind: 'job', status: 'ready', requests: {} }
      await this.record(terminal, { type: 'code', id, code: terminal.code })
    }
    if (terminal.code.projectId !== projectId || terminal.code.laneId !== laneId || terminal.code.provider !== provider) throw Error('This PC Code checkout belongs to a different lane or provider.')
    terminal.code.requests[requestId] = { status: 'running', fingerprint, at: new Date().toISOString() }
    terminal.code.status = 'running'
    terminal.exited = false
    await this.record(terminal, { type: 'code', id: terminal.id, code: terminal.code })
    let job
    try { job = this.startCodeTurn({ host: terminal.code.host, checkout: terminal.code.checkout, provider, model: terminal.code.model, effort: terminal.code.effort, nativeSessionId: terminal.code.nativeSessionId, text, onData: data => this.data(terminal, data) }) } catch (error) {
      terminal.code.status = 'failed'; terminal.code.requests[requestId].status = 'failed'; terminal.code.requests[requestId].error = String(error.message || error).slice(0, 360); terminal.exited = true
      await this.record(terminal, { type: 'code', id: terminal.id, code: terminal.code }); this.changed(); throw error
    }
    this.codeTurns.set(terminal.id, job)
    void job.done.then(({ output }) => {
      const nativeSessionId = nativeSession(output, provider)
      if (nativeSessionId) terminal.code.nativeSessionId = nativeSessionId
      if (!completedTurn(output, provider) || !nativeSessionId) {
        terminal.code.status = 'failed'; terminal.code.requests[requestId].status = 'failed'; terminal.code.requests[requestId].error = 'PC Code did not return a completed native turn receipt.'; terminal.exited = true; terminal.exitCode = null; terminal.spawnError = terminal.code.requests[requestId].error
        return this.record(terminal, { type: 'code', id: terminal.id, code: terminal.code }).then(() => this.record(terminal, { type: 'spawn-error', id: terminal.id, message: terminal.spawnError }))
      }
      terminal.code.status = 'completed'; terminal.code.outcome = turnOutcome(output); terminal.code.requests[requestId].status = 'completed'; terminal.code.requests[requestId].outcome = terminal.code.outcome; terminal.exited = true; terminal.exitCode = 0
      return this.record(terminal, { type: 'code', id: terminal.id, code: terminal.code }).then(() => this.record(terminal, { type: 'exit', id: terminal.id, exitCode: 0 }))
    }, error => {
      const nativeSessionId = nativeSession(error.output, provider)
      if (nativeSessionId) terminal.code.nativeSessionId = nativeSessionId
      const uncertain = terminal.code.status === 'uncertain' || error.uncertain === true
      terminal.code.status = uncertain ? 'uncertain' : 'failed'; terminal.code.requests[requestId].status = uncertain ? 'uncertain' : 'failed'; terminal.code.requests[requestId].error = String(error.message || error).slice(0, 360); terminal.exited = true; terminal.exitCode = null; terminal.spawnError = terminal.code.requests[requestId].error
      return this.record(terminal, { type: 'code', id: terminal.id, code: terminal.code }).then(() => this.record(terminal, { type: 'spawn-error', id: terminal.id, message: terminal.spawnError }))
    }).finally(() => { if (this.codeTurns.get(terminal.id) === job) this.codeTurns.delete(terminal.id); this.changed() })
    this.changed()
    return { id: terminal.id, requestId, state: 'running', nativeSessionId: terminal.code.nativeSessionId ?? null }
  }

  async stopCodeTurn (sessionId) {
    const terminal = [...this.terminals.values()].find(item => item.sessionId === sessionId && item.code?.kind === 'job' && item.code.status === 'running')
    const job = terminal && this.codeTurns.get(terminal.id)
    if (!terminal || !job || !job.stop()) throw Error('No active PC Code turn can be stopped.')
    terminal.code.status = 'uncertain'
    await this.record(terminal, { type: 'code', id: terminal.id, code: terminal.code })
    this.changed()
    return { id: terminal.id, state: 'uncertain' }
  }

  async close () {
    for (const [id, job] of this.codeTurns) {
      job.stop()
      const terminal = this.terminals.get(id)
      if (terminal?.code?.kind === 'job' && terminal.code.status === 'running') { terminal.code.status = 'uncertain'; await this.record(terminal, { type: 'code', id, code: terminal.code }) }
    }
    for (const terminal of this.terminals.values()) {
      try { terminal.proc?.kill() } catch {}
    }
    for (const ws of this.clients.keys()) ws.close()
    await this.journal
    await new Promise((resolve) => this.wss.close(resolve))
  }

  accept (ws) {
    this.clients.set(ws, { terminalId: null })
    ws.on('message', (raw) => this.message(ws, raw))
    ws.on('close', () => this.disconnect(ws))
    ws.on('error', () => this.disconnect(ws))
    send(ws, { type: 'state', terminals: this.state() })
  }

  message (ws, raw) {
    if ((typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length) > MAX_MESSAGE_BYTES) return ws.close(1009, 'message too large')
    let message
    try { message = JSON.parse(raw.toString()) } catch { return ws.close(1008, 'invalid JSON') }
    const client = this.clients.get(ws)
    if (!client || typeof message?.type !== 'string') return ws.close(1008, 'invalid message')
    if (message.type === 'open') return this.open(ws, client, message.id)
    const terminal = this.terminals.get(message.id ?? client.terminalId)
    if (!terminal) return ws.close(1008, 'unknown terminal')
    if (message.type === 'claim') return this.claim(ws, client, terminal)
    if (message.type === 'resize') return this.resize(ws, terminal, message.cols, message.rows)
    if (message.type === 'input') return this.input(ws, terminal, message.data)
    ws.close(1008, 'unsupported message')
  }

  open (ws, client, id) {
    const terminal = this.terminals.get(id)
    if (!terminal) return ws.close(1008, 'unknown terminal')
    client.terminalId = id
    send(ws, {
      type: 'replay',
      chunks: terminal.chunks,
      cols: terminal.cols,
      rows: terminal.rows,
      owner: terminal.owner ? 'claimed' : null,
      exited: terminal.exited,
      exitCode: terminal.exitCode,
      spawnError: terminal.spawnError
    })
  }

  claim (ws, client, terminal) {
    const lock = this.sessionLock(terminal.sessionId)
    if (lock) return send(ws, { type: 'locked', reason: lock.reason, generation: lock.generation })
    if (terminal.code?.kind === 'job') return ws.close(1008, 'Code job output is read-only')
    if (terminal.exited) return ws.close(1008, 'terminal has exited')
    if (terminal.owner === ws) return this.broadcastOwner(terminal)
    if (terminal.owner) return ws.close(1008, 'terminal already owned')
    terminal.owner = ws
    client.terminalId = terminal.id
    this.broadcastOwner(terminal)
    this.changed()
  }

  resize (ws, terminal, cols, rows) {
    if (terminal.exited) return ws.close(1008, 'terminal has exited')
    if (terminal.owner !== ws) return ws.close(1008, 'terminal is not owned by this client')
    if (!validSize(cols, rows)) return ws.close(1008, 'invalid terminal size')
    if (terminal.cols === cols && terminal.rows === rows) return
    terminal.cols = cols
    terminal.rows = rows
    try { terminal.proc?.resize(cols, rows) } catch {}
    this.record(terminal, { type: 'resize', id: terminal.id, seq: ++terminal.seq, data: '', cols, rows })
    terminal.chunks.push({ seq: terminal.seq, data: '', cols, rows })
    this.broadcastOwner(terminal)
    this.changed()
  }

  input (ws, terminal, data) {
    const lock = this.sessionLock(terminal.sessionId)
    if (lock) return send(ws, { type: 'locked', reason: lock.reason, generation: lock.generation })
    if (terminal.code?.kind === 'job') return ws.close(1008, 'Code job input is not supported')
    if (terminal.exited) return ws.close(1008, 'terminal has exited')
    if (terminal.owner !== ws) return ws.close(1008, 'terminal is not owned by this client')
    if (typeof data !== 'string' || !data || Buffer.byteLength(data) > MAX_INPUT_BYTES) return ws.close(1008, 'invalid terminal input')
    try { terminal.proc?.write(data) } catch { ws.close(1011, 'terminal unavailable') }
  }

  data (terminal, data) {
    if (terminal.exited || typeof data !== 'string') return
    const chunk = { seq: ++terminal.seq, data, cols: terminal.cols, rows: terminal.rows }
    terminal.chunks.push(chunk)
    this.record(terminal, { type: 'data', id: terminal.id, ...chunk })
    this.broadcast(terminal, { type: 'data', ...chunk })
  }

  exit (terminal, exitCode) {
    if (terminal.exited) return
    terminal.exited = true
    terminal.exitCode = exitCode ?? null
    terminal.proc = null
    terminal.owner = null
    this.record(terminal, { type: 'exit', id: terminal.id, exitCode: terminal.exitCode })
    this.broadcast(terminal, { type: 'exit', exitCode: terminal.exitCode })
    this.broadcastOwner(terminal)
    this.changed()
    // A Mac terminal is an exact native Codex continuation. Its CLI can add
    // turns while the browser is disconnected, so reconcile the saved thread
    // before allowing the conversation to accept another browser turn.
    if (terminal.code?.machine === 'mac' && terminal.code?.provider === 'codex' && terminal.code.nativeSessionId) {
      void Promise.resolve(this.onMacCliExit({ sessionId: terminal.sessionId, nativeSessionId: terminal.code.nativeSessionId, terminalId: terminal.id, exitCode: terminal.exitCode })).catch(() => {})
    }
  }

  disconnect (ws) {
    const client = this.clients.get(ws)
    this.clients.delete(ws)
    if (!client) return
    for (const terminal of this.terminals.values()) {
      if (terminal.owner !== ws) continue
      terminal.owner = null
      this.broadcastOwner(terminal)
    }
    this.changed()
  }

  broadcast (terminal, payload) {
    for (const [ws, client] of this.clients) if (client.terminalId === terminal.id) send(ws, payload)
  }

  broadcastOwner (terminal) {
    for (const [ws, client] of this.clients) {
      if (client.terminalId !== terminal.id) continue
      send(ws, { type: 'owner', owner: terminal.owner ? 'claimed' : null, claimedByYou: terminal.owner === ws, cols: terminal.cols, rows: terminal.rows })
    }
  }

  record (_terminal, event) {
    this.journal = this.journal.then(() => appendFile(this.journalPath, `${JSON.stringify({ at: Date.now(), ...event })}\n`))
    return this.journal
  }

  changed () { this.onChange(this.state()) }
}

function storedTerminal (id, cols = START_COLS, rows = START_ROWS, { sessionId = 'legacy-default', projectId = 'paneforge-next' } = {}) {
  return { id, sessionId, projectId, owner: null, cols, rows, seq: 0, chunks: [], proc: null, exited: false, exitCode: null, spawnError: null }
}

function applyJournalEvent (terminal, event) {
  if (event.type === 'resize') {
    terminal.cols = event.cols
    terminal.rows = event.rows
    terminal.seq = Math.max(terminal.seq, event.seq ?? 0)
    terminal.chunks.push({ seq: event.seq, data: '', cols: event.cols, rows: event.rows })
  }
  if (event.type === 'data') {
    terminal.cols = event.cols
    terminal.rows = event.rows
    terminal.seq = Math.max(terminal.seq, event.seq ?? 0)
    terminal.chunks.push({ seq: event.seq, data: event.data, cols: event.cols, rows: event.rows })
  }
  if (event.type === 'exit') {
    terminal.exited = true
    terminal.exitCode = event.exitCode ?? null
  }
  if (event.type === 'spawn-error') {
    terminal.exited = true
    terminal.spawnError = typeof event.message === 'string' ? event.message : 'PC terminal unavailable'
  }
  if (event.type === 'code' && event.code && typeof event.code === 'object') terminal.code = event.code
}

function terminalCodeState (code) {
  return {
    machine: code.machine ?? 'pc',
    kind: code.kind ?? 'terminal',
    status: code.status ?? null,
    nativeSessionId: code.nativeSessionId ?? null,
    checkout: code.checkout ?? code.cwd ?? null,
    host: code.host ?? null,
    launch: code.launch ?? 'resume',
    provider: code.provider ?? null,
    laneId: code.laneId ?? null,
    laneName: code.laneName ?? null,
    requests: code.requests ?? null,
    outcome: code.outcome ?? null
  }
}

function nativeSession (output, provider) {
  for (const line of String(output).split(/\r?\n/)) {
    try {
      const event = JSON.parse(line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''))
      const id = provider === 'codex' ? event.thread_id : event.session_id
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(id)) return id
    } catch {}
  }
  return null
}

function completedTurn (output, provider) {
  return String(output).split(/\r?\n/).some(line => {
    try {
      const event = JSON.parse(line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''))
      return provider === 'codex' ? event.type === 'turn.completed' : event.type === 'result' && event.is_error !== true
    } catch { return false }
  })
}

function requestFingerprint ({ laneId, provider, text }) {
  return createHash('sha256').update(JSON.stringify([laneId, provider, text])).digest('hex')
}

// A provider's `turn.completed` only proves that it stopped responding. It does
// not prove that a requested edit, read, build, or client workflow happened.
function turnOutcome (output) {
  const messages = []
  for (const line of String(output).split(/\r?\n/)) {
    try { const event = JSON.parse(line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')); if (event?.item?.type === 'agent_message' && typeof event.item.text === 'string') messages.push(event.item.text) } catch {}
  }
  return /\b(couldn['’]t|unable|cannot|timed out|unverified|failed)\b/i.test(messages.join('\n')) ? 'needs_attention' : 'unverified'
}

function validIdentity (value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
}

export function pcInteractiveCommand (code) {
  if (code.provider === 'claude') return 'claude'
  if(typeof code.model!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(code.model)||typeof code.effort!=='string'||!/^[a-z]{1,32}$/.test(code.effort))throw Error('PC Codex requires the session’s confirmed model and effort')
  return `codex -m ${code.model} -c 'model_reasoning_effort="${code.effort}"' -c 'model_provider="openai"' -c 'forced_login_method="chatgpt"' -a on-request -s workspace-write --enable code_mode_host --disable unified_exec_tty -C '${code.checkout}'`
}

export function macInteractiveArgs(code) {
  if(code?.provider!=='codex'||typeof code.nativeSessionId!=='string'||!/^[0-9a-f-]{16,80}$/i.test(code.nativeSessionId))throw Error('Mac CLI requires the exact saved Codex native session identity');
  if(typeof code.model!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(code.model)||typeof code.effort!=='string'||!/^[a-z]{1,32}$/.test(code.effort))throw Error('Mac CLI requires the session’s confirmed model and effort');
  return ['resume',code.nativeSessionId,'-m',code.model,'-c',`model_reasoning_effort=${JSON.stringify(code.effort)}`,'-c','model_provider="openai"','-c','forced_login_method="chatgpt"','-a','on-request','-s','workspace-write','-C',code.checkout];
}
function defaultMacPty ({ cols, rows, code }) {
  if (process.platform !== 'darwin') throw Error('Mac launch is only available on the Mac supervisor')
  if (!code.checkout) throw Error('A verified local lane is required')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|OPENAI_BASE_URL|ANTHROPIC|AWS_|VERTEX|BEDROCK/i.test(key)))
  return pty.spawn('codex',macInteractiveArgs(code), { name: 'xterm-256color', cols, rows, cwd: code.checkout, env })
}

function defaultPcPty ({ cols, rows, code }) {
  // A terminal receives an isolated PC checkout. Each selected provider creates
  // its own native session in that checkout.
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
    if ((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 2097152) {throw 'PC has less than 2 GB available; retry later. No Mac fallback.'};
    Get-ChildItem Env: | Where-Object {$_.Name -match 'API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|OPENAI_BASE_URL|ANTHROPIC|AWS_|VERTEX|BEDROCK'} | ForEach-Object {Remove-Item ('Env:'+$_.Name)};
    Set-Location '${code.checkout}';
    ${pcInteractiveCommand(code)}`;
  return pty.spawn('/usr/bin/ssh', [
    '-tt', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes',
    code.host, 'powershell', '-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script,'utf16le').toString('base64')
  ], { name: 'xterm-256color', cols, rows, cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key])=>!/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|OPENAI_BASE_URL|ANTHROPIC|AWS_|VERTEX|BEDROCK/i.test(key))) })
}

async function defaultPcTerminal ({ id, sessionId, projectId, laneId, laneName, cwd, provider }) {
  return new PcLanePreparer().prepare({ id, sessionId, projectId, laneId, laneName, cwd, provider })
}

export function isExpectedPcCheckoutOutput (stdout, checkout) {
  return typeof stdout === 'string' && stdout.trim().replace(/\r/g, '') === checkout
}

async function repairMacPtyHelper () {
  if (process.platform !== 'darwin') return
  // npm's package extraction can drop the executable bit from node-pty's signed helper.
  // This repair is local and idempotent; without it node-pty reports only `posix_spawnp failed`.
  const helper = join(dirname(require.resolve('node-pty/package.json')), 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  try { await chmod(helper, 0o755) } catch {}
}

function sameOrigin (req, allowedOrigin) {
  const origin = req.headers.origin
  const host = req.headers.host
  try {
    const allowed = new URL(allowedOrigin)
    return origin === allowed.origin && host === allowed.host
  } catch { return false }
}

function validSize (cols, rows) {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= MIN_COLS && cols <= MAX_COLS && rows >= MIN_ROWS && rows <= MAX_ROWS
}

function send (ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}
