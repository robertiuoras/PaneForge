// What test-all.mjs decides around its suites, kept here so it can be pinned on a machine
// that hands the suite itself to the PC (`suite-plan-test.mjs`).
//
// Two decisions, both measured on the PC (30 Sep-3 Oct 2026, 208 full runs):
//
// - The suites that drive scripts/lane.mjs through throwaway repositories were 76% of all
//   suite time (1,100s of 1,450s summed per run), and gate/lanecompletion/lanecleared alone
//   were the run's critical path. Only about a quarter of master's commits touch the lane
//   scripts at all. So such a suite is skipped when every file it can execute is
//   byte-for-byte what already passed on this machine, and `--full` (a release) runs it anyway.
// - 56 of 208 runs were red on exactly one suite, most often a timing-sensitive one that
//   passes on its own. A red suite is therefore run once more by itself, and only one that
//   fails again is a failure.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { buildSync } from 'esbuild'

/** Where this machine remembers which lane-suite inputs passed. Outside any checkout: every
 * PC suite run happens in a fresh snapshot folder, so the record has to outlive them all. */
export const passesFile = () => join(homedir(), '.cache', 'paneforge', 'suite-passes.json')

// A script a suite (or a script it runs) NAMES - `join(here, 'lane.mjs')`, `'scripts/pf-ctl.mjs'`
// - is run as a child process, which no import graph shows.
const NAMED = /['"/]([\w.-]+\.(?:mjs|cjs|js|vbs|ps1|sh))['"]/g
const BUNDLED = new Set(['.mjs', '.cjs', '.js'])

/**
 * Every file under scripts/ that running `file` can execute: the suite, each sibling script it
 * names, everything those import, and every script THEY name, to a fixed point. Repo-relative,
 * sorted. Throws for a suite that bundles app code at run time: those inputs are a string
 * handed to a bundler, and a list that misses one would skip a suite that should have run.
 */
export function suiteInputs(root, file) {
  const scripts = join(root, 'scripts')
  if (/\besbuild\b|electron-vite/.test(readFileSync(join(scripts, file), 'utf8'))) {
    throw new Error(`${file} builds app code at run time, so its inputs cannot be listed`)
  }
  const inputs = new Set([`scripts/${file}`])
  for (let grew = true; grew; ) {
    grew = false
    const entries = [...inputs].filter((f) => BUNDLED.has(extname(f)))
    const { metafile } = buildSync({
      absWorkingDir: root, entryPoints: entries, bundle: true, platform: 'node', format: 'esm',
      packages: 'external', write: false, metafile: true, outdir: join(root, 'out', 'suite-plan'), logLevel: 'silent'
    })
    const found = new Set(Object.keys(metafile.inputs))
    for (const f of [...found, ...inputs]) {
      for (const m of readFileSync(join(root, f), 'utf8').matchAll(NAMED)) {
        if (existsSync(join(scripts, m[1]))) found.add(`scripts/${m[1]}`)
      }
    }
    for (const f of found) if (!inputs.has(f)) { inputs.add(f); grew = true }
  }
  return [...inputs].sort()
}

/** One hash of what those files hold. CRLF reads as LF: a Windows checkout of the same bytes
 * is the same code. Node's version is in it, since the same script can behave differently. */
export function fingerprint(root, files) {
  const h = createHash('sha256').update(process.version)
  for (const f of files) h.update(`\0${f}\0`).update(readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n'))
  return h.digest('hex')
}

/** `{ suite: [{ fp, at }] }`. Missing or torn reads as nothing passed - never a throw. */
export function readPasses(path) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

const KEEP = 20

/** Record a pass. Two runs finishing together can lose one entry; that only means a rerun. */
export function recordPass(path, name, fp, at = Date.now()) {
  const all = readPasses(path)
  const prior = Array.isArray(all[name]) ? all[name].filter((p) => p?.fp !== fp) : []
  all[name] = [...prior, { fp, at }].slice(-KEEP)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(all))
  renameSync(tmp, path)
}

/**
 * Which suites run. A `cacheable` suite whose fingerprint already passed is skipped unless the
 * run is `full`; its fingerprint is kept either way so a pass can be recorded. A suite whose
 * fingerprint cannot be taken runs, with nothing to record.
 */
export function planRun(entries, { cacheable, full, passes, fingerprintOf }) {
  const run = []
  const skipped = []
  const fps = new Map()
  for (const entry of entries) {
    const [name, file] = entry
    if (cacheable.has(name)) {
      let fp = null
      try { fp = fingerprintOf(file) } catch {}
      if (fp) {
        fps.set(name, fp)
        if (!full && (passes[name] ?? []).some((p) => p?.fp === fp)) {
          skipped.push(name)
          continue
        }
      }
    }
    run.push(entry)
  }
  return { run, skipped, fps }
}

/** Run each red suite again, one at a time. Passing on its own = a flake; failing again = real. */
export async function retryAlone(red, runOne) {
  const flaky = []
  const real = []
  for (const entry of red) {
    const res = await runOne(entry)
    if (res.ok) flaky.push(entry.name)
    else real.push(res)
  }
  return { flaky, real }
}

/** The closing lines. The first keeps the shape lane.mjs, the tour and the PC probes read:
 * `N tests passed in Xs` or `K of N failed in Xs: names`. */
export function summary({ total, secs, real, flaky, skipped }) {
  const ran = total - skipped.length
  const lines = [real.length
    ? `${real.length} of ${ran} failed in ${secs}s: ${real.join(', ')}`
    : `${ran} tests passed in ${secs}s`]
  if (flaky.length) lines.push(`flaky (red in this run, passed on its own): ${flaky.join(', ')}`)
  if (skipped.length) {
    lines.push(`${skipped.length} lane suite${skipped.length === 1 ? '' : 's'} not run - the lane scripts they run are unchanged since they passed here (--full runs them): ${skipped.join(', ')}`)
  }
  return lines
}
