import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const HOST = 'Gamer@100.78.1.77'
const ROOT = 'C:\\Users\\Gamer\\Projects'
const MAX_FILES = 2000
const MAX_BYTES = 40 * 1024 * 1024
const SAFE = new Set(['.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rs', '.toml', '.ts', '.tsx', '.txt', '.yml', '.yaml'])
const BLOCKED = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.git', '.next', '.turbo', '.cache'])
const SECRET = /(^|[._-])(env|secret|token|credential|password|private|id_rsa|key)([._-]|$)|\.(pem|p12|pfx|key)$/i

function fail (message) { throw Error(message) }
function sha (data) { return createHash('sha256').update(data).digest('hex') }
function quotePs (value) { return `'${String(value).replace(/'/g, "''")}'` }
function encode (script) { return Buffer.from(script, 'utf16le').toString('base64') }
function under (root, path) { const part = relative(root, path); return part && part !== '..' && !part.startsWith(`..${sep}`) && !part.includes(`..${sep}`) }
function validFile (path) { const parts = path.split('/'); return !parts.some(p => !p || p.startsWith('.') || BLOCKED.has(p) || SECRET.test(p)) && SAFE.has(path.slice(path.lastIndexOf('.')).toLowerCase()) }
function validIdentity ({ id, projectId, laneId, cwd }) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(projectId || '') || (laneId !== null && !/^lane-[a-f0-9]{16}$/.test(laneId || '')) || typeof cwd !== 'string' || !cwd) fail('PC lane identity is invalid.') }

async function realDirectory (cwd) {
  const root = await realpath(cwd); const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) fail('The selected lane is not an available real directory.')
  return root
}

async function safeCopy (root, source, target) {
  let parent
  try { parent = await realpath(dirname(source)) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (parent !== root && !under(root, parent)) return null
  let handle
  try { handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    // A directory entry can be replaced between readdir and open. Do not follow
    // it outside the verified source tree.
    if (error.code === 'ELOOP' || error.code === 'ENOENT') return null
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BYTES) return null
    const data = await handle.readFile()
    // Detect a parent-directory replacement that happened while this entry was
    // opened. The descriptor preserves the original file, so discard it rather
    // than risking data from a directory outside the selected lane.
    let currentParent
    try { currentParent = await realpath(dirname(source)) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (currentParent !== parent || (currentParent !== root && !under(root, currentParent))) return null
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data, { mode: 0o600 })
    return { bytes: data.length, sha256: sha(data) }
  } finally { await handle.close() }
}

async function makeSnapshot (cwd, source) {
  const root = await realDirectory(cwd); const stage = await mkdtemp(join(tmpdir(), 'paneforge-pc-lane-'))
  const files = []; const excluded = []; let bytes = 0
  async function visit (directory) {
    // Re-check every directory immediately before traversing it: readdir's
    // Dirent is only a snapshot and an attacker could replace it with a link.
    let info
    try { info = await lstat(directory) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) return
    const resolved = await realpath(directory)
    if (resolved !== root && !under(root, resolved)) return
    const entries = await readdir(directory, { withFileTypes: true })
    const afterRead = await realpath(directory)
    if (afterRead !== resolved || (afterRead !== root && !under(root, afterRead))) return
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); const rel = relative(root, path).split(sep).join('/')
      if (entry.isSymbolicLink() || !under(root, path)) { excluded.push(rel); continue }
      if (entry.isDirectory()) {
        if (rel.split('/').some(p => p.startsWith('.') || BLOCKED.has(p) || SECRET.test(p))) { excluded.push(`${rel}/`); continue }
        let child
        try { child = await lstat(path) } catch (error) { if (error.code === 'ENOENT') { excluded.push(`${rel}/`); continue }; throw error }
        if (!child.isDirectory() || child.isSymbolicLink()) { excluded.push(`${rel}/`); continue }
        await visit(path); continue
      }
      if (!entry.isFile() || !validFile(rel)) { excluded.push(rel); continue }
      if (files.length >= MAX_FILES) fail(`PC snapshot exceeds ${MAX_FILES} safe files.`)
      const copied = await safeCopy(root, path, join(stage, rel))
      if (!copied) { excluded.push(rel); continue }
      if (bytes + copied.bytes > MAX_BYTES) fail('PC snapshot exceeds 40 MB of safe files.')
      bytes += copied.bytes; files.push({ path: rel, ...copied })
    }
  }
  try {
    await visit(root); if (!files.length) fail('The selected lane has no safe source files to snapshot.')
    const manifest = { version: 1, createdAt: new Date().toISOString(), source, files, excluded: excluded.slice(0, 200), bytes }
    await writeFile(join(stage, '.paneforge-snapshot.json'), JSON.stringify(manifest), { mode: 0o600 })
    const archive = join(tmpdir(), `paneforge-pc-lane-${randomUUID()}.tar.gz`)
    await exec('tar', ['-czf', archive, '-C', stage, '.'], { timeout: 30_000, maxBuffer: 4096 })
    return { stage, archive, manifest }
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}

function transferArchive ({ host, archive, checkout, runner = spawn }) {
  const script = [
    "$ErrorActionPreference='Stop'", `$checkout=${quotePs(checkout)}`,
    "if(Test-Path -LiteralPath $checkout){throw 'Allocated PC checkout path already exists.'}",
    'New-Item -ItemType Directory -Path $checkout | Out-Null',
    "tar -xzf - -C $checkout; if($LASTEXITCODE -ne 0){throw 'Could not extract the safe lane snapshot.'}",
    "$manifest=Get-Content -LiteralPath (Join-Path $checkout '.paneforge-snapshot.json') -Raw | ConvertFrom-Json",
    "foreach($entry in $manifest.files){$path=Join-Path $checkout $entry.path; if(!(Test-Path -LiteralPath $path)){throw 'Snapshot file is missing.'}; if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -ne $entry.sha256){throw 'Snapshot digest verification failed.'}}",
    "git -C $checkout init --quiet; if($LASTEXITCODE -ne 0){throw 'Could not initialize PC lane repository.'}",
    'Write-Output $checkout'
  ].join('; ')
  return new Promise((resolvePromise, reject) => {
    const child = runner('/usr/bin/ssh', ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', host, 'powershell', '-NoLogo', '-NoProfile', '-EncodedCommand', encode(script)], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject); child.on('close', code => code === 0 ? resolvePromise(stdout) : reject(Error(stderr || `SSH exited ${code}`)))
    createReadStream(archive).on('error', reject).pipe(child.stdin)
  })
}

function sshArgs (host, script) {
  return ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', host, 'powershell', '-NoLogo', '-NoProfile', '-EncodedCommand', encode(script)]
}

function startTaskSsh (host, script, spawnFn) {
  // The generated task wrapper contains the user prompt. Send it on SSH stdin
  // instead of expanding it twice into a Windows command line. The stdin is
  // ASCII base64 so Windows PowerShell's console code page cannot corrupt it.
  const decoder = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $payload=[Console]::In.ReadToEnd(); $script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)); Invoke-Expression $script"
  const child = spawnFn('/usr/bin/ssh', sshArgs(host, decoder), { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stdin.end(Buffer.from(script, 'utf8').toString('base64'), 'ascii')
  return child
}

function startDirectPcTurn ({ host, script, onData, spawnFn }) {
  const child = spawnFn('/usr/bin/ssh', sshArgs(host, script), { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; let stderr = ''; let settled = false
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { const value = chunk.toString(); output += value; onData(value) })
    child.stderr.on('data', chunk => { const value = chunk.toString(); stderr += value; onData(value) })
    child.on('error', reject)
    child.on('close', code => { settled = true; if (code === 0) resolve({ output, stderr }); else { const error = Error(stderr || output || `PC Code exited ${code}`); error.output = output; reject(error) } })
  })
  return { done, stop: () => { if (settled) return false; child.kill('SIGINT'); return true } }
}

function codexCommand ({ nativeSessionId, prompt, model, effort }) {
  if(typeof model!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(model)||typeof effort!=='string'||!/^[a-z]{1,32}$/.test(effort)) fail('PC Codex requires the session’s confirmed model and effort.')
  const base = `$codexWorker exec --json --disable unified_exec_tty -c $receiptConfig -m ${model} -c 'model_reasoning_effort="${effort}"' -c 'model_provider="openai"' -c 'forced_login_method="chatgpt"' -c 'approval_policy="on-request"' -s workspace-write`
  return nativeSessionId ? `${base} resume ${quotePs(nativeSessionId)} ${prompt}` : `${base} ${prompt}`
}

function codexTaskScripts ({ checkout, nativeSessionId, text, jobId, model, effort }) {
  const task = `PaneForgeNext-Code-${jobId}`
  const command = codexCommand({ nativeSessionId, prompt: quotePs(text.trim()), model, effort })
  const runScript = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding", `$job=Join-Path $env:LOCALAPPDATA ${quotePs(`PaneForgeNext\\code-turns\\${jobId}`)}`,
    "$identity=[pscustomobject]@{pid=$PID;created=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks}",
    "$tmp=Join-Path $job 'pid.tmp'; $identity|ConvertTo-Json -Compress|Set-Content -LiteralPath $tmp -NoNewline; Move-Item -LiteralPath $tmp -Destination (Join-Path $job 'pid.json') -Force",
    '$code=1; try {',
    `$checkout=${quotePs(checkout)}`, "if(!(Test-Path -LiteralPath $checkout)){throw 'PC lane checkout is unavailable.'}",
    'Set-Location -LiteralPath $checkout',
    "$env:KNOWLEDGE_RECEIPTS=Join-Path $checkout '.paneforge-knowledge-receipts'; $receiptConfig='shell_environment_policy.set.KNOWLEDGE_RECEIPTS='+(ConvertTo-Json -InputObject $env:KNOWLEDGE_RECEIPTS -Compress)",
    // 0.155.1 fails Windows runtime sandbox validation on the paired PC. The
    // isolated 0.154.0 worker passed the same Limited-task sandbox checkpoint.
    // Preserve the global CLI and fail closed if this verified worker is absent.
    "$codexWorker=Join-Path $env:LOCALAPPDATA 'PaneForgeNext\\codex-compat-0.154.0\\node_modules\\.bin\\codex.cmd'; if(!(Test-Path -LiteralPath $codexWorker)){throw 'Next PC worker Codex 0.154.0 is not installed in its isolated directory.'}; $workerVersion=& $codexWorker --version; if($LASTEXITCODE -ne 0 -or $workerVersion.Trim() -ne 'codex-cli 0.154.0'){throw 'Next PC worker version verification failed.'}",
    "Get-ChildItem Env: | Where-Object {$_.Name -match 'API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|OPENAI_BASE_URL|ANTHROPIC|AWS_|VERTEX|BEDROCK'} | ForEach-Object {Remove-Item ('Env:'+$_.Name)}",
    `$previousErrorAction=$ErrorActionPreference; $ErrorActionPreference='Continue'; if(Test-Path -LiteralPath (Join-Path $job 'cancel.marker')){$code=130}else{& ${command} 1> (Join-Path $job 'stdout.log') 2> (Join-Path $job 'stderr.log'); if($null -ne $LASTEXITCODE){$code=$LASTEXITCODE}}; $ErrorActionPreference=$previousErrorAction`,
    "} catch { $_ | Out-String | Add-Content -LiteralPath (Join-Path $job 'stderr.log'); $code=1 } finally { $tmp=Join-Path $job 'exit.tmp'; Set-Content -LiteralPath $tmp -Value $code -NoNewline; Move-Item -LiteralPath $tmp -Destination (Join-Path $job 'exit.txt') -Force }; exit $code"
  ].join('; ')
  const setup = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding", `$job=Join-Path $env:LOCALAPPDATA ${quotePs(`PaneForgeNext\\code-turns\\${jobId}`)}; $run=Join-Path $job 'run.ps1'; $task=${quotePs(task)}`,
    'try {',
    'New-Item -ItemType Directory -Force -Path $job | Out-Null',
    "if(Test-Path -LiteralPath (Join-Path $job 'cancel.marker')){exit 1}",
    `$content=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(${quotePs(Buffer.from(runScript, 'utf16le').toString('base64'))})); [IO.File]::WriteAllText($run,$content,[Text.Encoding]::Unicode)`,
    "$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File \"'+$run+'\"')",
    "$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited",
    '$settings=New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    'Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null',
    'Start-ScheduledTask -TaskName $task',
    '$outAt=0; $errAt=0; $started=Get-Date',
    `while($true){foreach($pair in @(@((Join-Path $job 'stdout.log'),'outAt'),@((Join-Path $job 'stderr.log'),'errAt'))){$path=$pair[0];$name=$pair[1];if(Test-Path -LiteralPath $path){$value=Get-Content -LiteralPath $path -Raw;if($value.Length -gt (Get-Variable -Name $name -ValueOnly)){[Console]::Out.Write($value.Substring((Get-Variable -Name $name -ValueOnly)));Set-Variable -Name $name -Value $value.Length}}};if(Test-Path -LiteralPath (Join-Path $job 'exit.txt')){foreach($pair in @(@((Join-Path $job 'stdout.log'),'outAt'),@((Join-Path $job 'stderr.log'),'errAt'))){$path=$pair[0];$name=$pair[1];if(Test-Path -LiteralPath $path){$value=Get-Content -LiteralPath $path -Raw;if($value.Length -gt (Get-Variable -Name $name -ValueOnly)){[Console]::Out.Write($value.Substring((Get-Variable -Name $name -ValueOnly)));Set-Variable -Name $name -Value $value.Length}}};$code=[int](Get-Content -LiteralPath (Join-Path $job 'exit.txt') -Raw);[Console]::Out.WriteLine(('__PANEFORGE_CODE_EXIT__:${jobId}:'+$code));exit $code};$state=(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State;if($state -ne 'Running' -and ((Get-Date)-$started).TotalSeconds -ge 10){Write-Error 'PaneForge PC Code task ended without an exit receipt.';exit 1};Start-Sleep -Milliseconds 250}`,
    '} finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $job -Force -Recurse -ErrorAction SilentlyContinue }'
  ].join('; ')
  const cancel = [
    "$ErrorActionPreference='Stop'", `$job=Join-Path $env:LOCALAPPDATA ${quotePs(`PaneForgeNext\\code-turns\\${jobId}`)}; $task=${quotePs(task)}; $pidPath=Join-Path $job 'pid.json'`,
    "New-Item -ItemType Directory -Force -Path $job | Out-Null; Set-Content -LiteralPath (Join-Path $job 'cancel.marker') -Value 'cancelled' -NoNewline",
    "if(!(Test-Path -LiteralPath $pidPath)){Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 100; $state=(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State; if($state -eq 'Running'){exit 2}; Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue; exit 0}",
    '$identity=Get-Content -LiteralPath $pidPath -Raw|ConvertFrom-Json; $process=Get-Process -Id $identity.pid -ErrorAction SilentlyContinue',
    'if(!$process -or $process.StartTime.ToUniversalTime().Ticks -ne [int64]$identity.created){exit 3}',
    'taskkill /PID $identity.pid /T /F | Out-Null; if($LASTEXITCODE -ne 0){exit 4}; Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue',
    "Start-Sleep -Milliseconds 100; $still=Get-Process -Id $identity.pid -ErrorAction SilentlyContinue; $state=(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State; if($still -or $state -eq 'Running'){exit 5}; Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue;exit 0"
  ].join('; ')
  return { setup, cancel }
}

function startCodexTaskTurn ({ host, checkout, nativeSessionId, text, model, effort, onData, spawnFn }) {
  const jobId = randomUUID(); const { setup, cancel } = codexTaskScripts({ checkout, nativeSessionId, text, jobId, model, effort })
  const child = startTaskSsh(host, setup, spawnFn)
  let output = ''; let stderr = ''; let settled = false; let stopRequested = false; let stopper = null
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { const value = chunk.toString(); output += value; onData(value) })
    child.stderr.on('data', chunk => { const value = chunk.toString(); stderr += value; onData(value) })
    child.on('error', reject)
    child.on('close', code => {
      settled = true
      const receipt = new RegExp(`__PANEFORGE_CODE_EXIT__:${jobId}:(-?\\d+)`).exec(output)
      if (code === 0 && receipt?.[1] === '0') resolve({ output, stderr })
      else { const error = Error(stderr || output || `PC Code exited ${code}`); error.output = output; error.uncertain = stopRequested || !receipt; reject(error) }
    })
  })
  return {
    done,
    stop: () => {
      if (settled) return false
      stopRequested = true
      stopper = spawnFn('/usr/bin/ssh', sshArgs(host, cancel), { stdio: ['ignore', 'ignore', 'ignore'] })
      stopper.on('error', () => {})
      return true
    }
  }
}

export function startPcCodeTurn ({ host = HOST, checkout, provider, model = null, effort = null, nativeSessionId = null, text, onData = () => {}, spawnFn = spawn } = {}) {
  if (typeof checkout !== 'string' || !checkout || !['codex', 'claude'].includes(provider) || typeof text !== 'string' || !text.trim() || text.length > 4000) fail('PC Code turn is invalid.')
  if (provider === 'codex') return startCodexTaskTurn({ host, checkout, nativeSessionId, text, model, effort, onData, spawnFn })
  const prompt = quotePs(text.trim())
  const command = nativeSessionId ? `claude --resume ${quotePs(nativeSessionId)} -p ${prompt} --output-format json` : `claude -p ${prompt} --output-format json`
  const script = [
    "$ErrorActionPreference='Stop'", `$checkout=${quotePs(checkout)}`,
    "if(!(Test-Path -LiteralPath $checkout)){throw 'PC lane checkout is unavailable.'}",
    'Set-Location -LiteralPath $checkout',
    "Get-ChildItem Env: | Where-Object {$_.Name -match 'API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|OPENAI_BASE_URL|ANTHROPIC|AWS_|VERTEX|BEDROCK'} | ForEach-Object {Remove-Item ('Env:'+$_.Name)}",
    command, 'exit $LASTEXITCODE'
  ].join('; ')
  return startDirectPcTurn({ host, script, onData, spawnFn })
}

/** Copies only safe, bounded files from a server-verified lane into a new PC directory. */
export class PcLanePreparer {
  constructor ({ host = HOST, remoteRoot = ROOT, transfer = transferArchive } = {}) { this.host = host; this.remoteRoot = remoteRoot; this.transfer = transfer }
  async prepare ({ id, sessionId, projectId, laneId = null, laneName, cwd, provider = 'codex' }) {
    validIdentity({ id, projectId, laneId, cwd }); if (!['codex', 'claude'].includes(provider)) fail('PC provider is invalid.')
    const checkout = `${this.remoteRoot}\\paneforge-${projectId.slice(0, 32)}-${(laneId || 'folder').slice(0, 21)}-${id}`
    const source = { projectId, laneId, laneName: laneName || null, cwd: await realDirectory(cwd), provider }
    const prepared = await makeSnapshot(source.cwd, source)
    try {
      const stdout = await this.transfer({ host: this.host, archive: prepared.archive, checkout })
      if (String(stdout).trim().replace(/\r/g, '') !== checkout) fail('PC lane preparation returned an unexpected checkout path.')
      return { host: this.host, checkout, cwd: checkout, launch: 'new', sessionId, projectId, laneId, laneName: laneName || null, provider, snapshotDigest: sha(JSON.stringify(prepared.manifest.files)) }
    } catch (error) { fail(`PC isolated lane could not be prepared: ${String(error.message || error).trim().slice(-1000)}`) } finally { await rm(prepared.archive, { force: true }); await rm(prepared.stage, { recursive: true, force: true }) }
  }
}
