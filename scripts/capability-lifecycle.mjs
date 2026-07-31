// The transitions a person makes, and the ones they are not allowed to make.
//
//   node scripts/capability-lifecycle.mjs --list
//   node scripts/capability-lifecycle.mjs --id motion --show
//   node scripts/capability-lifecycle.mjs --id motion --verify --evidence <path-or-url>
//   node scripts/capability-lifecycle.mjs --id motion --outcome shipped --project ebb --note "..."
//   node scripts/capability-lifecycle.mjs --id x --reject --why "unmaintained since 2024-02"
//   node scripts/capability-lifecycle.mjs --id x --review
//
// The one rule worth stating: `--verify` refuses without evidence. A capability reaches
// Verified because a sandbox run passed or because a person names the artefact that
// convinced them - never because somebody typed the word. That is the difference between a
// lifecycle and a set of labels, and it is why `stage()` derives the answer rather than
// storing it.
//
// `--reject` is not a delete. A ruled-out capability stays in the catalogue and stays
// indexed, because it has to answer the query that would otherwise make somebody propose
// it again next year.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capabilityDir, find, loadAll, reindex, safe, shared, today, update, vaultPath } from './capability-store.mjs'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const { capability } = shared()

function out(o) {
  process.stdout.write(JSON.stringify(o, null, 2) + '\n')
  process.exit(o.ok === false ? 1 : 0)
}

if (flag('--list')) {
  const wanted = value('--stage')
  const rows = loadAll()
    .map((e) => ({
      id: e.record.id,
      name: e.record.name,
      category: e.record.category,
      stage: capability.stage(e.record),
      status: e.record.status,
      nextReview: capability.nextReviewDate(e.record),
      tests: (e.record.tests ?? []).length,
      outcomes: (e.record.outcomes ?? []).length
    }))
    .filter((r) => !wanted || r.stage === wanted)
  out({ ok: true, dir: capabilityDir(), count: rows.length, capabilities: rows })
}

const id = value('--id')
if (!id) out({ ok: false, why: 'need --id <capability-id>, or --list' })
const entry = find(id)
if (!entry) out({ ok: false, why: `no record with id ${id} in ${capabilityDir()}` })
const record = entry.record

if (flag('--show')) {
  out({
    ok: true,
    id,
    stage: capability.stage(record),
    status: record.status,
    confidence: record.confidence,
    volatility: record.volatility,
    lastVerified: record.lastVerified,
    nextReview: capability.nextReviewDate(record),
    needsReview: capability.needsReview(record),
    stale: capability.isStale(record),
    tested: capability.isTested(record),
    proven: capability.isProven(record),
    tests: record.tests ?? [],
    outcomes: record.outcomes ?? [],
    provenance: record.provenance ?? null
  })
}

const dryRun = flag('--dry-run')
function commit(next, extra = {}) {
  if (dryRun) {
    out({ ok: true, dryRun: true, id, stageBefore: capability.stage(record), stageAfter: capability.stage(next), ...extra })
  }
  update(id, () => next)
  const indexed = reindex()
  out({
    ok: true,
    id,
    stageBefore: capability.stage(record),
    stageAfter: capability.stage(next),
    indexed,
    ...extra
  })
}

// ---------------------------------------------------------------------------

if (flag('--verify')) {
  const evidence = value('--evidence')
  const passed = capability.isTested(record)
  // Evidence, or a passing sandbox run. Never neither.
  if (!passed && !evidence) {
    out({
      ok: false,
      why: 'Verified needs evidence: either a passing sandbox run (capability-sandbox.mjs) or --evidence <path-or-url> naming what convinced you'
    })
  }
  if (evidence && !/^https:\/\//.test(evidence) && !existsSync(evidence)) {
    out({ ok: false, why: `--evidence ${evidence} is neither an https URL nor a file that exists` })
  }
  const next = {
    ...record,
    status: 'verified',
    confidence: value('--confidence', passed ? 'high' : 'medium'),
    lastVerified: today(),
    needsReview: false,
    provenance: {
      ...(record.provenance ?? {}),
      checkedAt: today(),
      sources: [...(record.provenance?.sources ?? []), evidence].filter(Boolean).slice(0, 8)
    }
  }
  next.nextReview = capability.nextReviewDate({ ...next, nextReview: undefined })
  commit(next, { evidence: evidence || 'sandbox run', sandboxPassed: passed })
}

if (flag('--reject')) {
  const why = value('--why')
  if (!why) out({ ok: false, why: 'need --why "<the specific, dated reason>"' })
  const supersededBy = value('--superseded-by')
  const next = {
    ...record,
    status: 'superseded',
    ruling: supersededBy ? 'superseded' : flag('--deprecated') ? 'deprecated' : 'rejected',
    whyNot: why.slice(0, 200),
    supersededBy: supersededBy || undefined,
    // Inert: a ruled-out record is revisited when evidence arrives, not on a clock. A date
    // here would schedule a research run whose conclusion is already known.
    volatility: 'inert',
    needsReview: false,
    lastVerified: today()
  }
  next.nextReview = capability.nextReviewDate({ ...next, nextReview: undefined })

  const path = join(vaultPath(), '30 Knowledge', 'capabilities', `${id}-ruled-out.md`)
  if (!dryRun) {
    mkdirSync(join(vaultPath(), '30 Knowledge', 'capabilities'), { recursive: true })
    writeFileSync(
      path,
      `---
type: decision
area: capabilities
status: superseded
sensitivity: internal
updated: ${today()}
---

# Ruled out — ${safe(record.name)}

\`ruling: ${next.ruling}\` · \`capability: ${id}\`

This note exists to be FOUND. A ruled-out option that is merely deleted gets
reconsidered from scratch every year.

## Why

${safe(why)}

## Use instead

${supersededBy ? `\`${safe(supersededBy)}\`` : 'nothing — the requirement was wrong'}

## What would change this

New evidence: a major release, a maintainer returning, a licence change. Until
then this is not re-researched.
`,
      'utf8'
    )
  }
  commit(next, { note: path })
}

if (value('--outcome')) {
  const result = value('--outcome')
  if (!['shipped', 'reverted', 'rejected'].includes(result)) {
    out({ ok: false, why: 'need --outcome shipped|reverted|rejected' })
  }
  const project = value('--project')
  if (!project) out({ ok: false, why: 'need --project <slug> (a slug, never a client name or a path)' })
  const note = value('--note', '')
  const outcome = { project: project.slice(0, 80), at: today(), result, note: note.slice(0, 160) }
  const next = {
    ...record,
    outcomes: [...(record.outcomes ?? []), outcome].slice(-20),
    testedProjects: [...new Set([...(record.testedProjects ?? []), project])].slice(0, 20)
  }

  const path = join(vaultPath(), '70 Agent Memory', 'outcomes', `${today()}-${id}-${project}.md`)
  if (!dryRun) {
    mkdirSync(join(vaultPath(), '70 Agent Memory', 'outcomes'), { recursive: true })
    writeFileSync(
      path,
      `---
type: outcome
project: ${safe(project)}
area: capabilities
status: verified
sensitivity: internal
updated: ${today()}
---

# Outcome — ${safe(record.name)} in ${safe(project)} — ${today()}

\`capability: ${id}\` · result \`${result}\`

Concise and privacy-safe on purpose: the slug and the result are the durable
part. No client data, no secrets, no raw conversations, no complete prompts.

## What happened

${safe(note) || 'Not recorded.'}

## Recommend again?

${result === 'shipped' ? 'Yes — this is what moves the record to Recommended.' : 'No, on this evidence.'}
`,
      'utf8'
    )
  }
  commit(next, { outcome, note: path })
}

if (flag('--review')) {
  commit({ ...record, needsReview: true }, { detail: 'queued for another look regardless of the clock' })
}

out({ ok: false, why: 'nothing to do - pass --show, --verify, --reject, --outcome, --review or --list' })
