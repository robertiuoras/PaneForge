// What model a Claude Code pane is REALLY running, as opposed to the one it was launched
// with.
//
// The chip on a session card reads the `--model` flag a pane was started with
// (`agentModelLabel(agent, s.model)`, `App.tsx`). Typing `/model fable` inside the CLI
// changes nothing that flag remembers - the pane keeps answering to whatever it launched
// as, for ever, while the transcript on disk has been saying the truth the whole time:
// every assistant turn's own JSON line carries the model that answered it
// (`"message":{"model":"claude-..."}`). This file reads that line, the same way
// `handoffSteps.ts` reads a handoff - a pure parser here, a cached disk reader in
// `main/paneModel.ts`.

/** A transcript line worth reading is the LAST one an assistant turn actually used. */
interface AssistantModelLine {
  type?: string
  message?: { role?: string; model?: string }
}

/**
 * The model on the last real assistant turn, from a chunk of transcript text.
 *
 * Reads only whatever text it is handed - the caller passes the TAIL of the file, never
 * the whole thing, because a transcript is an append log and the answer is always near
 * the end. A line split by that cut is dropped rather than mis-parsed: `JSON.parse`
 * throws on a partial line and the loop just keeps going.
 *
 * `<synthetic>` is a marker line the CLI writes for its own bookkeeping (compaction,
 * summaries) and answers no question about which model is running - skipped like a line
 * with no model at all.
 */
export function lastAssistantModel(tailText: string): string | undefined {
  const text = String(tailText || '')
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || line[0] !== '{') continue
    let row: AssistantModelLine
    try {
      row = JSON.parse(line)
    } catch {
      continue // a line the tail cut in half, or garbage - not evidence either way
    }
    const model = row.message?.model
    if (!model || model === '<synthetic>') continue
    if (row.type && row.type !== 'assistant') continue
    return model
  }
  return undefined
}

/** How much of the file's tail is worth reading. A turn's own line is never this long. */
export const TAIL_BYTES = 64 * 1024

/**
 * The real model id mapped onto whatever this build's own catalogue calls it, so it can
 * pass through `agentModelLabel` and draw a proper chip rather than the raw id.
 *
 * The Anthropic API's own id and this app's catalogue value disagree in exactly the ways a
 * version number disagrees with itself: the API answers `claude-fable-5-1` where the
 * catalogue's entry is `claude-fable-5`, and `claude-haiku-4-5-20251001` where the
 * catalogue's is `claude-haiku-4-5`. Both are the SAME model losing a dated or minor-version
 * tail, so a raw id that has no exact match is trimmed one segment at a time from the right
 * before it is given up on. A model the catalogue has genuinely never heard of (an older
 * `claude-sonnet-4-6`) stops trimming with nothing found and MUST fall back to the pane's
 * launch value - never a blank chip, never a guess wearing someone else's name.
 */
export function resolveCatalogueValue(raw: string, catalogueValues: string[]): string | undefined {
  const id = String(raw || '')
  if (!id) return undefined
  const known = new Set(catalogueValues)
  if (known.has(id)) return id
  let trimmed = id
  for (let guard = 0; guard < 4; guard++) {
    const cut = trimmed.replace(/-[^-]+$/, '')
    if (cut === trimmed || !cut) break
    trimmed = cut
    if (known.has(trimmed)) return trimmed
  }
  return undefined
}
