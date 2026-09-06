// Checks the renderer's issue classifier without starting Electron. The component itself
// owns the dialog/focus behaviour; this protects the safety claims it puts on screen.
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'pf-issues-'))
try {
  const out = join(dir, 'issues.cjs')
  buildSync({ entryPoints: ['src/renderer/src/components/IssuesDialog.tsx'], outfile: out, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', tsconfig: 'tsconfig.web.json' })
  // The pure exports are in the component file. Its module-level bridge is never called
  // by this test, but Electron normally supplies it before the renderer imports.
  globalThis.window = { api: {} }
  const { laneIssues, rememberIssueError, readIssueErrors, folderInspectionResults } = await import(out)
  const board = { repo: '/work/widget', device: 'desk', releasing: null, lastShip: null, hold: { reason: 'Waiting for checks.', at: 1 }, lanes: [
    { lane: 'main', dir: '/work/widget', branch: 'main', from: null, session: null, ownerPane: null, held: false, seen: 1, ready: false, conflicted: false, adoptable: false, resolver: null, device: 'desk', peer: false },
    { lane: 'a', dir: '/work/widget-a', branch: 'lane-a', from: '/work/widget', session: 'one', ownerPane: null, held: false, seen: 1, ready: false, conflicted: true, conflictDetail: 'src/a.ts', adoptable: true, resolver: null, device: 'desk', peer: false },
    { lane: 'b', dir: '/work/widget-b', branch: 'lane-b', from: '/work/widget', session: 'two', ownerPane: 'missing-pane', held: true, gone: true, seen: 1, ready: false, conflicted: false, adoptable: false, resolver: null, device: 'desk', peer: false }
  ] }
  const work = { '/work/widget-a': { lane: 'a', dir: '/work/widget-a', repo: '/work/widget', branch: 'lane-a', base: 'main', ahead: 1, dirty: 1, conflicts: [], baseDirty: false, empty: false, subject: null, at: null, touching: [] } }
  const issues = laneIssues([board], [], work)
  if (!issues.some(x => x.key.endsWith(':hold')) || !issues.some(x => x.key.endsWith(':conflict')) || !issues.some(x => x.key.endsWith(':unowned-work'))) throw new Error(`Missing expected safety issues: ${JSON.stringify(issues)}`)
  if (!issues.some(x => x.key.endsWith(':assignment'))) throw new Error(`Missing assignment mismatch: ${JSON.stringify(issues)}`)
  const asleepHeld = laneIssues([{ ...board, lanes: [{ ...board.lanes[2], ownerPane: 'asleep-pane', held: true, gone: false }] }], [{ id: 'asleep-pane', status: 'exited', asleep: true }], { '/work/widget-b': { ...work['/work/widget-a'], lane: 'b', dir: '/work/widget-b' } })
  if (asleepHeld.some(x => x.key.endsWith(':unowned-work'))) throw new Error(`An asleep held pane was treated as orphaned: ${JSON.stringify(asleepHeld)}`)
  if (asleepHeld.some(x => x.key.endsWith(':assignment'))) throw new Error(`An asleep held pane was treated as stale: ${JSON.stringify(asleepHeld)}`)
  const unheld = laneIssues([{ ...board, lanes: [{ ...board.lanes[2], ownerPane: 'open-pane', held: false }] }], [{ id: 'open-pane', status: 'working' }], { '/work/widget-b': { ...work['/work/widget-a'], lane: 'b', dir: '/work/widget-b' } })
  if (!unheld.some(x => x.key.endsWith(':unowned-work'))) throw new Error(`Unheld dirty lane was not an orphan risk: ${JSON.stringify(unheld)}`)
  const unknown = laneIssues([{ ...board, lanes: [board.lanes[0], { ...board.lanes[1], lane: 'c', dir: '/work/widget-c', conflicted: false, ownerPane: null, held: false }] }], [], { '/work/widget-a': work['/work/widget-a'], '/work/widget-c': null })
  if (!unknown.some(x => x.key.endsWith(':unknown'))) throw new Error(`Missing unknown inspection warning: ${JSON.stringify(unknown)}`)
  if (unknown.some(x => x.key.includes(':main:unknown'))) throw new Error(`Main checkout must not be inspected: ${JSON.stringify(unknown)}`)
  const peer = laneIssues([{ ...board, lanes: [{ ...board.lanes[2], peer: true, ownerPane: 'other-desk-pane', held: true }] }], [], {})
  if (peer.some(x => x.key.endsWith(':assignment'))) throw new Error(`Peer lane was compared to local panes: ${JSON.stringify(peer)}`)
  const enumeration = folderInspectionResults([board], [{ status: 'rejected', reason: new Error('git failed') }])
  if (!enumeration.failed || Object.keys(enumeration.folders).length) throw new Error('Rejected folder enumeration was treated as a clean empty list.')
  const physical = laneIssues([{ ...board, lanes: [] }], [], { '/work/widget-z': { ...work['/work/widget-a'], lane: 'z', dir: '/work/widget-z' }, '/work/widget-bad': null }, { '/work/widget': ['/work/widget-z', '/work/widget-bad'] })
  if (!physical.some(x => x.key.endsWith(':physical-orphan')) || !physical.some(x => x.key.endsWith(':unknown'))) throw new Error(`Physical-lane partial inspection was not retained: ${JSON.stringify(physical)}`)
  const error = rememberIssueError([], '/private/path/token=secret')[0]
  if (/private|secret/.test(error) || !/reported an error/.test(error)) throw new Error(`Error storage is not redacted: ${error}`)
  if (readIssueErrors('["safe"]')[0] !== 'safe' || readIssueErrors('{"not":"an array"}').length || readIssueErrors('["safe", 2]').length) throw new Error('Stored issue errors were not validated.')
  console.log('Issues dialog safety classifier passed.')
} finally { rmSync(dir, { recursive: true, force: true }) }
