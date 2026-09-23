// A real run of the "expand" model over real prompts, so `EXPAND_WAIT_MS` gets set from a
// measurement rather than a guess. Costs ~20 haiku calls on the included plan - approved,
// see `docs/expand-spec.md`. NEVER run for real from this script's own author; only
// `--dry-run` is safe to run without asking, and that is what CI and this file's own
// author run.
//
// This is deliberately NOT `main/headless.ts` imported directly: that file's import chain
// reaches `main/config.ts`, which imports `electron`, and `electron` required outside a
// real Electron process is a string (the path to the binary) rather than the API surface -
// bundling it for plain `node` throws before a single prompt runs. So the exec below is a
// hand-kept COPY of `runHeadless`'s shape and `HEADLESS.claude`'s flags from
// `main/headless.ts` - if either changes there, change it here too.
//
//   node scripts/promptexpand-replay.mjs --dry-run out.md    # no model call, safe anytime
//   node scripts/promptexpand-replay.mjs out.md              # the real thing - ~20 haiku calls

import { buildSync } from 'esbuild'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const outPath = argv.find((a) => a !== '--dry-run')
if (!outPath) {
  console.error('usage: node scripts/promptexpand-replay.mjs [--dry-run] <out.md>')
  process.exit(2)
}

// The pure half - bundled the same way the test scripts do, because it carries no
// `electron` import at all.
const tmp = mkdtempSync(join(tmpdir(), 'pf-expand-replay-'))
const bundleFile = join(tmp, 'promptExpand.mjs')
buildSync({
  entryPoints: [join(root, 'src/shared/promptExpand.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundleFile
})
const { shouldExpand, wordCount, expandArgs, parseExpansion, expandedPrompt, whereFromFiles, keywordsOf } =
  await import(pathToFileURL(bundleFile).href)

// Redacted before anything is printed, written, OR sent to the model - the redacted text
// is what the model itself sees, never the original.
const REDACT = [
  [/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]'],
  [/ghp_[A-Za-z0-9]+/g, '[redacted]'],
  [/AKIA[0-9A-Z]{12,}/g, '[redacted]'],
  [/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted]'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]'],
  // After the ant-prefixed and JWT forms, so this generic one cannot double-redact them.
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[redacted]'],
  // `mcp_token=`, `api_key=` and the like count too - the boundary is before the whole
  // word-joined name, not just the bare word, since `_` is a word character and `\b`
  // never falls between it and the next letter.
  [/\b[\w-]*(?:key|token|password)=\S+/gi, '[redacted]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted]']
]
function redact(text) {
  let out = String(text || '')
  for (const [re, rep] of REDACT) out = out.replace(re, rep)
  return out
}

// --- source the prompts: promptlab's own corpus, human turns only ------------------------
const promptlabDir = process.env.PF_PROMPTLAB || join(root, '..', 'claude-memory', 'claude-config', 'promptlab')
const corpusPath = join(promptlabDir, 'data', 'corpus.jsonl')
if (!existsSync(corpusPath)) {
  console.error(`promptlab corpus not found at ${corpusPath} - nothing to replay`)
  process.exit(1)
}
const rows = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => r.origin === 'human' && typeof r.prompt === 'string' && r.prompt.trim())

const seen = new Set()
const candidates = []
for (const r of rows.slice().sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))) {
  const text = r.prompt.trim()
  if (seen.has(text) || !shouldExpand(text)) continue
  seen.add(text)
  candidates.push(r)
  if (candidates.length >= 20) break
}

// Plus one ask that is a regression, not a sample: measured 2026-09-23 in a real pane, this
// one talked haiku into answering IT instead of writing a brief (the rules were in the user
// message then). It must come back as a brief every run.
candidates.push({
  prompt:
    'I would like a short written answer only, with no file changes at all. In this empty folder there is nothing to build, so please just reply with one sentence that says what a fuller brief is for, and then list the three things you would check before starting a real coding task in a folder like this one, and then stop and wait for me.',
  cwd: '',
  regression: true
})

if (dryRun) {
  const lines = [
    '# promptexpand replay - dry run',
    '',
    `${candidates.length} most-recent shouldExpand-eligible prompts, redacted, no model called:`,
    ''
  ]
  candidates.forEach((r, i) => {
    const red = redact(r.prompt)
    lines.push(`${i + 1}. ${wordCount(r.prompt)} words - ${red.slice(0, 80).replace(/\n/g, ' ')}${red.length > 80 ? '…' : ''}`)
  })
  writeFileSync(outPath, lines.join('\n') + '\n')
  console.log(lines.join('\n'))
  process.exit(0)
}

// --- the real run --------------------------------------------------------------------
// A hand-kept copy of `HEADLESS.claude` in `main/headless.ts` - see the header above for
// why this cannot simply import that file.
const HEADLESS_CLAUDE_FLAGS = ['-p', '--setting-sources', '', '--strict-mcp-config', '--settings', '{"hooks":{},"outputStyle":"default"}']

/** A hand-kept copy of `runHeadless`'s shape - see the header above. */
function runHeadlessLike({ bin, args, cwd, env, timeoutMs }) {
  const start = Date.now()
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env, windowsHide: true }, (err, stdout, stderr) => {
      const ms = Date.now() - start
      const killed = Boolean(err && err.killed)
      const why = killed ? 'timed out' : `exited with code ${String(err?.code ?? '?')}`
      if (err && !stdout.trim()) resolve({ out: '', err: stderr.trim() || why, ms, killed })
      else resolve({ out: stdout, ms, killed })
    })
  })
}

function scrubbedEnv() {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_BASE_URL
  delete env.OPENAI_API_KEY
  return env
}

// One quiet, empty folder for every run - the same reason `main/promptExpand.ts` gives
// the real feature its own `<userData>/expand`: a headless run loads the settings and the
// CLAUDE.md of the directory it starts in.
const quietCwd = mkdtempSync(join(tmpdir(), 'pf-expand-replay-cwd-'))

const results = []
for (const row of candidates) {
  const redacted = redact(row.prompt)
  const model = await runHeadlessLike({
    bin: 'claude',
    args: [...HEADLESS_CLAUDE_FLAGS, ...expandArgs(redacted)],
    cwd: quietCwd,
    env: scrubbedEnv(),
    timeoutMs: 90_000
  })
  const expansion = model.out.trim() ? parseExpansion(model.out) : null

  let where = []
  const rowCwd = row.cwd && existsSync(row.cwd) ? row.cwd : null
  if (rowCwd) {
    const git = await runHeadlessLike({ bin: 'git', args: ['ls-files'], cwd: rowCwd, env: process.env, timeoutMs: 4_000 })
    if (git.out.trim()) {
      const files = git.out.split('\n').map((s) => s.trim()).filter(Boolean)
      where = whereFromFiles(files, keywordsOf(redacted))
    }
  }

  // The brief carries the original word for word; the report shows that as one marker line,
  // so a past prompt appears once (capped, in BEFORE) and never whole.
  const after = expansion
    ? expandedPrompt(redacted, expansion, expansion.questions.map((q) => q.options[0]), where).replace(
        redacted.trim(),
        '[the original prompt, word for word]'
      )
    : '(no brief - the model did not answer with one)'

  results.push({ before: redacted.slice(0, 600), after, ms: model.ms, ok: Boolean(expansion) })
}

// The forced-timeout case: a budget of 1ms cannot possibly finish before the process is
// killed, so this proves the app's own "give up and send the original" path actually ends
// quickly rather than hanging on a CLI stuck behind an auth prompt nobody can see.
const timeoutStart = Date.now()
const timeoutCase = await runHeadlessLike({
  bin: 'claude',
  args: [...HEADLESS_CLAUDE_FLAGS, ...expandArgs('a forced-timeout probe')],
  cwd: quietCwd,
  env: scrubbedEnv(),
  timeoutMs: 1
})
const timeoutMs = Date.now() - timeoutStart
const timeoutOk = timeoutMs < 2000 && (timeoutCase.killed || Boolean(timeoutCase.err))

const times = results.map((r) => r.ms).sort((a, b) => a - b)
const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor((times.length - 1) * p))] : 0)
const summary = [
  `n=${results.length}`,
  `parsed ok=${results.filter((r) => r.ok).length}`,
  `p50=${pct(0.5)}ms`,
  `p95=${pct(0.95)}ms`,
  `max=${times[times.length - 1] ?? 0}ms`,
  `forced-timeout case: ${timeoutOk ? 'ok' : 'DID NOT return under 2000ms'} (${timeoutMs}ms, killed=${timeoutCase.killed ?? false})`
].join(', ')

const lines = ['# promptexpand replay', '', summary, '']
results.forEach((r, i) => {
  lines.push(`## ${i + 1} (${r.ms}ms, parse ${r.ok ? 'ok' : 'FAILED'})`, '', '**BEFORE**', '```', r.before, '```', '', '**AFTER**', '```', r.after, '```', '')
})
writeFileSync(outPath, lines.join('\n') + '\n')
console.log(summary)
