// Put lane.mjs into a throwaway repo, with everything it imports.
//
// Four lane tests each build a real repository and run the real `lane.mjs` inside it,
// which means copying the script in. They each carried the same hand-written list -
// `['lane.mjs', 'test-app.mjs']` - and that list is only right until lane.mjs imports
// one more thing: adding `release-notes.mjs` to it broke all four at once, with an
// ERR_MODULE_NOT_FOUND from inside a temp directory rather than anything naming the
// real cause. The list is derivable, so derive it: follow lane.mjs's own relative
// imports and copy what they name.

import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Every `./x.mjs` lane.mjs pulls in, transitively, lane.mjs included. */
export function laneScripts(here, entry = 'lane.mjs') {
  const seen = new Set()
  const queue = [entry]
  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    let src
    try {
      src = readFileSync(join(here, name), 'utf8')
    } catch {
      continue
    }
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"]\.\/([\w.-]+\.mjs)['"]/gm)) queue.push(m[1])
  }
  return [...seen]
}

/** Copy them into `<repo>/scripts`, which the caller has already created. */
export function installLane(here, repo) {
  const names = laneScripts(here)
  for (const f of names) copyFileSync(join(here, f), join(repo, 'scripts', f))
  return names
}
