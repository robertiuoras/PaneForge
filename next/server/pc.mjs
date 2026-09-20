import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REMOTE_ROOT = "(Join-Path $env:USERPROFILE 'Projects\\paneforge-next-runtime')";
const MIN_FREE_MEMORY_BYTES = 2 * 1024 ** 3;

function json(value) {
  return JSON.stringify(value);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${json(value)}\n`, "utf8");
  await rename(temp, path);
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Real transport is deliberately tiny: SSH plus Windows PowerShell, no daemon. */
export class SshPcTransport {
  constructor({ host = "Gamer@100.78.1.77", timeoutMs = 15_000 } = {}) {
    this.host = host;
    this.timeoutMs = timeoutMs;
  }

  async powerShell(script) {
    const { stdout } = await execFileAsync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", this.host, "powershell", "-NoProfile", "-EncodedCommand", encodePowerShell(script)],
      { timeout: this.timeoutMs, maxBuffer: 2 * 1024 * 1024 }
    );
    return stdout.trim();
  }

  async probe() {
    const output = await this.powerShell(`$root=${REMOTE_ROOT}; $os=Get-CimInstance Win32_OperatingSystem; $cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; [pscustomobject]@{host=$env:COMPUTERNAME; freeMemoryBytes=([int64]$os.FreePhysicalMemory*1024); cpuCount=$cpu; runtimeExists=(Test-Path $root) } | ConvertTo-Json -Compress`);
    return JSON.parse(output);
  }

  async prepare({ workerSource, input }) {
    const fixture = Buffer.from(input).toString("base64");
    await this.powerShell(`$root=${REMOTE_ROOT}; New-Item -ItemType Directory -Force -Path $root,$root+'\\jobs' | Out-Null; [IO.File]::WriteAllBytes((Join-Path $root 'synthetic-input.bin'),[Convert]::FromBase64String('${fixture}')); 'ready'`);
    const staging = await mkdtemp(join(tmpdir(), "paneforge-pc-worker-"));
    const localWorker = join(staging, "pc-worker.cjs");
    try {
      await writeFile(localWorker, workerSource, "utf8");
      await execFileAsync("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", localWorker, `${this.host}:Projects/paneforge-next-runtime/pc-worker.cjs`], { timeout: this.timeoutMs });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async start(job) {
    // Win32_Process.Create breaks the child away from the SSH job object. Start-Process
    // can be terminated when the transport session closes, leaving an orphaned lease.
    const script = `$root=${REMOTE_ROOT}; $jobDir=Join-Path $root 'jobs\\${job.id}'; New-Item -ItemType Directory -Force -Path $jobDir | Out-Null; $worker=Join-Path $root 'pc-worker.cjs'; $command=('node.exe ""{0}"" --root ""{1}"" --job ${job.id} --session ${job.sessionId} --request ${job.requestId} --iterations ${job.iterations}' -f $worker,$root); $created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory=$root}; [pscustomobject]@{pid=$created.ProcessId;returnValue=$created.ReturnValue} | ConvertTo-Json -Compress`;
    const started = JSON.parse(await this.powerShell(script));
    if (started.returnValue !== 0) throw new Error(`Win32_Process.Create failed with ${started.returnValue}`);
    return started;
  }

  async receipt(jobId) {
    const output = await this.powerShell(`$root=${REMOTE_ROOT}; $path=Join-Path $root 'jobs\\${jobId}\\receipt.json'; if(Test-Path $path){Get-Content -Raw $path}else{''}`);
    return output ? JSON.parse(output) : null;
  }
}

export class PcExecutor {
  constructor({ dataDir, onChange = () => {}, transport = new SshPcTransport(), iterations = 120 } = {}) {
    if (!dataDir) throw new Error("PcExecutor requires dataDir");
    this.dataDir = dataDir;
    this.file = join(dataDir, "jobs.json");
    this.onChange = onChange;
    this.transport = transport;
    this.iterations = iterations;
    this.jobs = new Map();
    this.ready = this.#load();
    this.prepared = false;
    this.pending = new Set();
    this.pendingById = new Set();
    this.persistence = Promise.resolve();
  }

  async #load() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      for (const job of saved) this.jobs.set(job.id, job);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async #persist() {
    this.persistence = this.persistence.then(() => atomicJson(this.file, [...this.jobs.values()]));
    await this.persistence;
    this.onChange(this.list());
  }

  list() { return [...this.jobs.values()]; }
  get(id) { return this.jobs.get(id) ?? null; }
  async idle() { await Promise.all([...this.pending]); }
  #schedule(id) {
    if (this.pendingById.has(id)) return;
    this.pendingById.add(id);
    const pending = this.#attempt(id).catch((error) => console.error("PaneForge PC dispatch failed", error));
    this.pending.add(pending);
    pending.finally(() => { this.pending.delete(pending); this.pendingById.delete(id); });
  }

  async enqueue({ sessionId, requestId }) {
    await this.ready;
    if (typeof sessionId !== "string" || typeof requestId !== "string" || !sessionId || !requestId || !/^[A-Za-z0-9._:-]{1,160}$/.test(sessionId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) throw new Error("sessionId and requestId must be safe stable identifiers");
    const existing = this.list().find((job) => job.sessionId === sessionId && job.requestId === requestId);
    if (existing) return existing;
    const job = { id: randomUUID(), sessionId, requestId, state: "queued", reason: "awaiting PC", result: null, iterations: this.iterations, createdAt: new Date().toISOString(), executionCount: 0 };
    this.jobs.set(job.id, job);
    await this.#persist();
    this.#schedule(job.id);
    return job;
  }

  async retry(id) {
    await this.ready;
    const job = this.get(id);
    if (!job) throw new Error(`unknown PC job ${id}`);
    if (job.state === "completed") return job;
    job.state = "queued";
    job.reason = "retry requested";
    await this.#persist();
    this.#schedule(id);
    return job;
  }

  async #attempt(id) {
    const job = this.get(id);
    if (!job || ["dispatching", "running", "completed"].includes(job.state)) return;
    try {
      // Receipt first: an interrupted Mac-side launch is uncertain, never a reason to run again.
      const prior = await this.transport.receipt(job.id);
      if (prior) {
        await this.#applyReceipt(job, prior);
        if (job.state === "completed" || job.state === "running") return;
      }
      const capacity = await this.transport.probe();
      if (!Number.isFinite(Number(capacity.freeMemoryBytes)) || Number(capacity.freeMemoryBytes) < MIN_FREE_MEMORY_BYTES) {
        job.state = "queued"; job.reason = "PC capacity is unknown or has less than 2 GiB free memory"; await this.#persist(); return;
      }
      if (!this.prepared) {
        const [workerSource, input] = await Promise.all([
          readFile(new URL("../scripts/pc-worker.cjs", import.meta.url), "utf8"),
          Promise.resolve(createHash("sha256").update("PaneForge fixed synthetic input v1").digest())
        ]);
        await this.transport.prepare({ workerSource, input });
        this.prepared = true;
      }
      job.state = "dispatching";
      job.reason = "Awaiting the PC worker receipt; a launch request is not confirmed execution";
      await this.#persist();
      const started = await this.transport.start(job);
      job.remotePid = started.pid;
      job.host = capacity.host;
      await this.#persist();
      const receipt = await this.transport.receipt(job.id);
      if (receipt) await this.#applyReceipt(job, receipt);
    } catch (error) {
      const uncertain = job.state === "dispatching";
      job.state = uncertain ? "dispatching" : "queued";
      job.reason = `${uncertain ? 'PC launch uncertain; waiting for receipt' : 'PC unavailable'}: ${error instanceof Error ? error.message : String(error)}`;
      await this.#persist();
    }
  }

  #applyReceipt(job, receipt) {
    job.state = receipt.state === "completed" ? "completed" : receipt.state === "running" ? "running" : "queued";
    job.reason = receipt.reason ?? null;
    job.result = receipt.result ?? null;
    job.executionCount = receipt.executionCount ?? job.executionCount;
    job.remotePid = receipt.pid ?? job.remotePid;
    job.host = receipt.host ?? job.host;
    job.startedAt = receipt.startedAt ?? job.startedAt;
    job.completedAt = receipt.completedAt ?? job.completedAt;
    return this.#persist().then(() => job);
  }

  async reconcile() {
    await this.ready;
    for (const job of this.list()) {
      if (job.state === "running" || job.state === "dispatching") {
        try {
          const receipt = await this.transport.receipt(job.id);
          if (receipt) await this.#applyReceipt(job, receipt);
        } catch { /* connectivity failure leaves durable running state intact */ }
      } else if (job.state === "queued") {
        this.#schedule(job.id);
      }
    }
    return this.list();
  }
}
