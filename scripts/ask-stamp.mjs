// The question's identity, for a button that will outlive the question.
//
// A COPY of `askStamp` in src/shared/choices.ts, and a deliberate one: this file is loaded
// by pf-telegram.mjs, which is plain ESM run by `node` with no bundler and no TypeScript,
// and the app's own copy has to run in a renderer that imports nothing from node. Five
// lines of arithmetic are cheaper than making one of those two carry the other's build.
//
// scripts/ask-stamp-test.mjs asserts the two agree, so they cannot drift apart in silence.
// If you change one, change both, and the test will tell you if you did not.

/** The string the stamp is taken of: the question and its options, never the arrow. */
export function askText(ask) {
  return `${ask.question}|${ask.options.map((o) => `${o.n}.${o.label}`).join('|')}`
}

/** FNV-1a, 32-bit, hex. Not crypto - see the note in src/shared/choices.ts. */
export function askStamp(ask) {
  if (!ask) return ''
  const text = askText(ask)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
