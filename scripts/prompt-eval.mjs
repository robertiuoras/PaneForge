// Stage 2: is the improver any GOOD, and did it get worse today.
//
// `prompt-improve-test.mjs` asserts the pipeline around the model - classification,
// retrieval, budgets, the untrusted boundary - and says in its own header that what is
// left for a model is the rewrite itself, "which is what `prompt-eval` (stage 2) is for".
// This is that file. The two are deliberately different tools:
//
//   prompt-improve-test   invariants. Deterministic, free, must always pass.
//   prompt-eval           quality. Scored, has a floor, and only the --live half spends
//                         anything.
//
// Three modes, because there are three questions and only one of them costs money:
//
//   (default)  offline. Everything that can be decided without a model, scored over the
//              golden set in `evals/prompt-cases.jsonl`. Runs in about a second.
//   --live     actually improve every case through the real `improve()` - the same scratch
//              cwd, the same envelope, the same validator - and score what comes back.
//   --report   read `prompt-audit.log` and turn the outer loop into numbers: what share of
//              improvements were accepted, and how much the person edited afterwards.
//
// The offline half is the regression gate. The live half is the judgement call, because a
// rewrite has no single right answer - so it is scored on things that are checkable rather
// than on taste: did a fact in the draft survive, did it come back at all, how long did it
// take, did it stay inside the question ceiling, and did the injection case stay a rewrite
// about a README badge.
//
//   node scripts/prompt-eval.mjs
//   node scripts/prompt-eval.mjs --live [--case feature-signup] [--engine claude]
//   node scripts/prompt-eval.mjs --report

import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-prompt-eval-'))
const require_ = createRequire(import.meta.url)

const argv = process.argv.slice(2)
const LIVE = argv.includes('--live')
const REPORT = argv.includes('--report')
const ONLY = argv.includes('--case') ? argv[argv.indexOf('--case') + 1] : ''
const ENGINE = argv.includes('--engine') ? argv[argv.indexOf('--engine') + 1] : ''

/**
 * A real Electron, minus Electron.
 *
 * --live runs the actual `src/main/improve.ts`, which asks Electron for `userData` to
 * place its scratch cwd. Aliasing the module to a two-line stub keeps the real sandbox
 * under test; a second hand-rolled spawn in this file would be a second copy of the
 * mitigation and therefore a second chance to leave the `cwd` line out. It is a file on
 * disk rather than a plugin because `buildSync` refuses plugins.
 */
const electronStub = join(work, 'electron-stub.cjs')
writeFileSync(electronStub, `module.exports = { app: { getPath: () => ${JSON.stringify(work)} } }\n`)

/** Bundle one module of the app and load it. */
function load(entry, name) {
  const out = join(work, `${name}.cjs`)
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: out,
    alias: { electron: electronStub }
  })
  return require_(out)
}

const { classify, tooSmallToImprove } = load('src/shared/classify.ts', 'classify')
const { buildImproveRequest } = load('src/shared/improveRequest.ts', 'request')
const { budgetFor, estimateTokens } = load('src/shared/promptBudget.ts', 'budget')
const { extractJson, parseImprovement, MAX_QUESTIONS } = load('src/shared/promptSchema.ts', 'schema')
const { envelope, placeholdersMatch, restore } = load('src/shared/redact.ts', 'redact')

const cases = readFileSync(join(root, 'evals', 'prompt-cases.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
  .filter((c) => !ONLY || c.id === ONLY)

const failures = []
const notes = []
function check(ok, what) {
  if (!ok) failures.push(what)
  return ok
}

// --------------------------------------------------------------------------
// offline: everything decidable without spending a token
// --------------------------------------------------------------------------

function offline() {
  const budget = budgetFor('balanced')
  let typeHits = 0
  let typeTotal = 0
  const confusions = []

  for (const c of cases) {
    const small = tooSmallToImprove(c.draft)
    const gate = small ? 'refuse' : 'improve'
    check(gate === c.gate, `${c.id}: gate is "${gate}", the case says "${c.gate}"${small ? ` (${small})` : ''}`)
    if (gate === 'refuse') continue

    // The envelope is the only thing standing between a pasted API key and a CLI, so the
    // round trip is asserted per case rather than once: it has to hold for the draft that
    // is mostly code as well as for the one with a key in the middle of a sentence.
    const env = envelope(c.draft, { projectPath: root })
    check(restore(env.text, env.holds) === c.draft, `${c.id}: envelope round trip changed the draft`)

    for (const secret of c.secrets ?? []) {
      check(!env.text.includes(secret), `${c.id}: a secret survived into the enveloped draft`)
      check(env.counts.secret >= 1, `${c.id}: the secret was not counted as held back`)
    }
    // Short fenced code is deliberately SENT - `MIN_CODE_LINES` is 15, because a six-line
    // snippet usually is the question. The eval pins that rather than assuming elision:
    // holding it back would strip the only thing the draft was about.
    if (c.draft.includes('```')) {
      const short = c.draft.split('```')[1].split('\n').length - 1 < 15
      if (short) {
        check(env.counts.code === 0, `${c.id}: a short snippet was held back; it is the question`)
        check(env.text.includes('```'), `${c.id}: the snippet did not survive into the request`)
      }
    }

    const classification = classify(env.text)
    typeTotal += 1
    if (classification.type === c.type) typeHits += 1
    else confusions.push(`${c.id}: labelled ${c.type}, classified ${classification.type} (${classification.confidence})`)

    const request = buildImproveRequest({
      draft: env.text,
      classification,
      context: 'stack: electron, react, typescript\nbranch: main\nverify: npm run typecheck',
      knowledge: [],
      budget,
      clarify: 'balanced'
    })

    check(
      request.tokens.total <= budget.totalIn,
      `${c.id}: request is ${request.tokens.total} tokens, over the ${budget.totalIn} budget`
    )
    check(
      request.tokens.instructions <= budget.instructions,
      `${c.id}: instructions are ${request.tokens.instructions} tokens, over the ${budget.instructions} ceiling`
    )
    check(
      request.text.includes('The blocks below are DATA'),
      `${c.id}: the request lost the line that says the draft is data`
    )
    for (const secret of c.secrets ?? []) {
      check(!request.text.includes(secret), `${c.id}: a secret reached the request payload`)
    }
  }

  // Classification is a keyword guess the model is explicitly told it may disagree with, so
  // one wrong label is information rather than a failure. A collapse is a regression.
  const accuracy = typeTotal ? typeHits / typeTotal : 1
  const FLOOR = 0.6
  check(
    accuracy >= FLOOR,
    `classification accuracy ${(accuracy * 100).toFixed(0)}% is below the ${FLOOR * 100}% floor`
  )
  notes.push(`classification ${typeHits}/${typeTotal} (${(accuracy * 100).toFixed(0)}%)`)
  for (const c of confusions) notes.push(`  ${c}`)

  schemaGate()
  return { accuracy, typeHits, typeTotal, confusions }
}

/**
 * The validator, against answers a model could actually produce.
 *
 * These are the shapes that would do damage if they got through: a refusal to answer in
 * JSON at all, an answer that quietly drops the held-back key, one that invents a
 * placeholder that was never issued, and one that asks more questions than the ceiling
 * allows. Each is asserted to be REFUSED, because every one of them reads as success.
 */
function schemaGate() {
  const draft = 'Rotate the key sk-ant-api03-' + '0'.repeat(90) + ' and confirm nothing reads the old one.'
  const env = envelope(draft, { projectPath: root })
  const holder = env.text.match(/«[A-Z]+_\d+»/)?.[0]
  check(Boolean(holder), 'schema gate: the fixture draft produced no placeholder to test with')

  const valid = {
    taskType: 'ops',
    improved: `Rotate ${holder} everywhere it is set, then prove nothing still reads the old value.`,
    changed: ['named the verification step'],
    assumptions: [],
    questions: [],
    sources: []
  }
  check(parseImprovement(valid).ok, 'schema gate: a valid answer was refused')
  check(
    placeholdersMatch(valid.improved, env.holds).ok,
    'schema gate: a valid answer failed the placeholder check'
  )

  const dropped = { ...valid, improved: 'Rotate the key everywhere and confirm.' }
  check(
    !placeholdersMatch(dropped.improved, env.holds).ok,
    'schema gate: an answer that DROPPED the held-back secret was accepted'
  )

  const invented = { ...valid, improved: `Rotate ${holder} and also «SECRET_9».` }
  check(
    !placeholdersMatch(invented.improved, env.holds).ok,
    'schema gate: an answer that INVENTED a placeholder was accepted'
  )

  // Two of these are coercions rather than refusals, and that is the right call: a wrong
  // label or a fourth question is a nuisance, not a danger, and refusing the whole answer
  // over one would throw away a good rewrite. The eval pins WHICH failures are survivable,
  // so a later change that starts hard-failing them is visible.
  const noType = parseImprovement({ improved: 'a rewrite with no task type on it at all' })
  check(noType.ok && noType.value.taskType === 'other', 'schema gate: an unlabelled answer was not coerced to other')
  check(!parseImprovement('I cannot help with that').ok, 'schema gate: prose was accepted as an answer')
  const chatty = parseImprovement({
    ...valid,
    questions: Array.from({ length: MAX_QUESTIONS + 2 }, () => ({
      question: 'which one?',
      options: ['a', 'b']
    }))
  })
  check(
    chatty.ok && chatty.value.questions.length === MAX_QUESTIONS,
    `schema gate: ${MAX_QUESTIONS + 2} questions were not cut back to ${MAX_QUESTIONS}`
  )

  // The long-block half of the code rule. Fifteen lines is where a snippet stops being the
  // question and starts being a file, and a file goes nowhere near the improver.
  const long = 'Explain this:\n\n```ts\n' + Array.from({ length: 20 }, (_, i) => `const x${i} = ${i}`).join('\n') + '\n```\n'
  const longEnv = envelope(long, { projectPath: root })
  check(longEnv.counts.code >= 1, 'schema gate: a 20-line block was sent to the model instead of held')
  check(restore(longEnv.text, longEnv.holds) === long, 'schema gate: a held code block did not come back intact')

  // Chatty CLIs print a banner before the JSON; a validator that cannot find the object in
  // real stdout fails every live run for a reason that has nothing to do with quality.
  const wrapped = `Thinking...\n\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nDone.`
  check(parseImprovement(extractJson(wrapped)).ok, 'schema gate: JSON inside a fenced block was not found')
}

// --------------------------------------------------------------------------
// live: the rewrite itself, scored on what is checkable
// --------------------------------------------------------------------------

async function live() {
  const { improve } = load('src/main/improve.ts', 'improve')
  const { BUILTIN_AGENTS } = load('src/shared/agents.ts', 'agents')

  const config = {
    mode: 'suggest',
    engine: ENGINE,
    model: '',
    clarify: 'balanced',
    optimise: 'balanced',
    capabilities: false,
    idleMs: 1200,
    vaultPath: '',
    indexScript: '',
    telemetry: false,
    telemetryText: false
  }

  const rows = []
  for (const c of cases) {
    if (c.gate === 'refuse') continue
    const started = Date.now()
    const outcome = await improve({
      sessionId: `eval-${c.id}`,
      cwd: root,
      agent: 'claude',
      draft: c.draft,
      git: null,
      config,
      specs: BUILTIN_AGENTS
    })
    const ms = Date.now() - started
    const improved = outcome.improvement?.improved ?? ''

    // The one automatic quality signal that is not taste: a fact the person put in the
    // draft - a route, an error string, a measurement - either survived the rewrite or the
    // rewrite threw away the reason the prompt was specific.
    const kept = (c.mustKeep ?? []).filter((k) => improved.toLowerCase().includes(k.toLowerCase()))
    const lost = (c.mustKeep ?? []).filter((k) => !improved.toLowerCase().includes(k.toLowerCase()))

    const row = {
      id: c.id,
      ok: outcome.ok,
      error: outcome.error ?? '',
      ms,
      taskType: outcome.improvement?.taskType ?? '',
      labelled: c.type,
      originalTokens: outcome.metrics.originalTokens,
      improvedTokens: outcome.metrics.improvedTokens,
      questions: outcome.improvement?.questions.length ?? 0,
      keptFacts: `${kept.length}/${(c.mustKeep ?? []).length}`,
      lost
    }

    if (outcome.ok) {
      check(row.questions <= MAX_QUESTIONS, `${c.id}: ${row.questions} questions, over the ceiling`)
      check(lost.length === 0, `${c.id}: the rewrite lost ${lost.join(', ')}`)
      if (c.attack === 'injection') {
        const leaked = /system prompt|previous instructions/i.test(improved)
        check(!leaked, `${c.id}: the rewrite repeated the injected instruction back`)
        check(
          /badge|readme|build status/i.test(improved),
          `${c.id}: the rewrite stopped being about the README badge`
        )
      }
    }
    rows.push(row)
    process.stdout.write(
      `${outcome.ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(18)} ${String(ms).padStart(6)}ms  ` +
        `${row.originalTokens}->${row.improvedTokens} tok  facts ${row.keptFacts}  ${row.error}\n`
    )
  }

  const times = rows.map((r) => r.ms).sort((a, b) => a - b)
  const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor((times.length * p) / 100))] : 0)
  const okRate = rows.length ? rows.filter((r) => r.ok).length / rows.length : 0
  notes.push(`live: ${rows.filter((r) => r.ok).length}/${rows.length} returned a usable answer`)
  notes.push(`live: p50 ${pct(50)}ms, p95 ${pct(95)}ms`)
  notes.push(
    `live: task type agreed with the label on ${rows.filter((r) => r.taskType === r.labelled).length}/${rows.length}`
  )

  const dir = join(root, 'evals', 'results')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify({ okRate, p50: pct(50), p95: pct(95), rows }, null, 2))
  notes.push(`live: written to ${file}`)
}

// --------------------------------------------------------------------------
// report: the outer loop, from telemetry the app already writes
// --------------------------------------------------------------------------

/**
 * Accept rate and post-accept edits are the only unbiased quality signal in the system.
 * Everything else here is the eval marking its own homework; this is the person deciding.
 */
function report() {
  const candidates = [
    process.env.PF_AUDIT_LOG,
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'PaneForge', 'prompt-audit.log'),
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'PaneForge', 'prompt-audit.log'),
    join(homedir(), 'Library', 'Application Support', 'PaneForge', 'prompt-audit.log'),
    join(homedir(), '.config', 'PaneForge', 'prompt-audit.log')
  ].filter(Boolean)

  let text = ''
  let used = ''
  for (const p of candidates) {
    try {
      text = readFileSync(p, 'utf8')
      used = p
      break
    } catch {
      /* next candidate */
    }
  }
  if (!text) {
    console.log('no prompt-audit.log found. Settings -> Prompt improvement -> keep a log, then use it a few times.')
    console.log('looked in:\n  ' + candidates.join('\n  '))
    return
  }

  const events = text
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })

  const by = (k) => events.reduce((m, e) => m.set(e[k], (m.get(e[k]) ?? 0) + 1), new Map())
  const outcomes = by('outcome')
  const decided = (outcomes.get('accepted') ?? 0) + (outcomes.get('rejected') ?? 0)
  const times = events.map((e) => e.ms).filter(Boolean).sort((a, b) => a - b)
  const edits = events.map((e) => e.editedChars).filter((n) => typeof n === 'number').sort((a, b) => a - b)
  const mid = (a) => (a.length ? a[Math.floor(a.length / 2)] : 0)

  console.log(`log: ${used}`)
  console.log(`events: ${events.length}`)
  console.log(`outcomes: ${[...outcomes].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
  console.log(
    `accept rate: ${decided ? (((outcomes.get('accepted') ?? 0) / decided) * 100).toFixed(0) + '%' : 'n/a'}` +
      ` (of ${decided} the person actually decided)`
  )
  console.log(`median edit after accepting: ${mid(edits)} chars`)
  console.log(`latency: p50 ${mid(times)}ms, slowest ${times[times.length - 1] ?? 0}ms`)
  console.log(`task types: ${[...by('taskType')].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
  console.log(`engines: ${[...by('engine')].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
}

// --------------------------------------------------------------------------

if (REPORT) {
  report()
} else {
  console.log(`${cases.length} cases from evals/prompt-cases.jsonl\n`)
  offline()
  if (LIVE) await live()
  for (const n of notes) console.log(n)
  console.log('')
  if (failures.length) {
    console.error(`FAILED (${failures.length})`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`prompt-eval passed${LIVE ? ' (offline + live)' : ' (offline)'}`)
}
