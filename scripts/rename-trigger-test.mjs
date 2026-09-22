// Rename is a deliberate card action. A double-click is too easy to make while switching
// panes or moving a tiled pane, so it must never open the inline editor.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const info = readFileSync(new URL('../src/renderer/src/components/SessionInfo.tsx', import.meta.url), 'utf8')

assert.doesNotMatch(
  app,
  /onDoubleClick=\{\(\) => setRenaming\(s\.id\)\}/,
  'a double-click cannot open the rename editor'
)
assert.match(
  app,
  /\{ key: 'rename', label: 'Rename…', run: \(\) => setRenaming\(s\.id\) \}/,
  'the card menu still offers deliberate rename'
)
assert.match(
  info,
  /<button className="ghost" onClick=\{onRename\}>[\s\S]{0,80}Rename/,
  'the session info dialog still offers deliberate rename'
)

console.log('rename-trigger: double-click cannot open rename; menu and session info can')
