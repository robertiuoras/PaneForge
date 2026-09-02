// One place a prompt is written, so no prompt can be written without a definition of done.
//
// `docs/prompt-review-2026-09-02.md` counted the six places this app composes instructions
// for an agent: two carry an anchor, ONE says what finished looks like, and none of them
// show an example. The worst of the six opens up to four panes at once on briefs the model
// wrote and nothing read. This file is the floor under all of them.
//
// It is pure on purpose. The renderer imports this, so nothing here touches disk: the
// exemplars come from `claude-config/promptlib` - Robert's own corpus, 12 templates mined
// off 1,482 of his prompts - and `main/promptForge.ts` is what reads them. A machine with
// no promptlib still forges a prompt; it just forges one with no example in it.
//
// `npm run test:promptforge`.

/** A kind of ask, and what the library knows about judging it. */
export interface ForgeTemplate {
  /** the promptlib template id this borrows from, when there is one */
  id: string
  /** one or two lines saying how an answer to this kind of ask is judged */
  guidance: string[]
  /** exemplars of a good ask of this kind, as written */
  examples?: string[]
}

/** Everything a forged prompt can be built out of. Only `task` is required. */
export interface ForgeInput {
  /** what is being asked, in the caller's own words */
  task: string
  /** the kind of ask, if the caller knows it */
  template?: ForgeTemplate | null
  /** files, symbols, paths or URLs the reader should start from */
  anchors?: string[]
  /** what finished looks like - a command, a flow, a shape */
  done?: string[]
  /** what may be touched, and what may not */
  scope?: string[]
  /** exemplars, overriding the template's own. At most MAX_EXAMPLES survive. */
  examples?: string[]
  /**
   * A different ceiling, when this prompt is not going into a pane.
   *
   * MAX_PROMPT_CHARS is sized for the thing that types a prompt one keystroke chunk at a
   * time. A prompt handed to a headless CLI as one argument has no such problem, and one
   * of those - the split planner - is deliberately given a LONG ask, so applying the pane
   * ceiling to it would silently truncate the very request it was asked to read.
   */
  budget?: number
}

/**
 * How long a forged prompt may be.
 *
 * A prompt is typed into a pane one keystroke chunk at a time, and a long one arriving in
 * a single pty read is treated as a PASTE by Claude Code's input - which is the bug that
 * left an autoclear resume prompt sitting unsent in the box (see `paneChunks` in
 * `claude-config/autoclear.mjs`). Six thousand characters is roughly two screens: past it
 * the prompt has stopped being an instruction and become a document, which belongs in a
 * file the prompt ANCHORS at.
 */
export const MAX_PROMPT_CHARS = 6000

/** How much of one exemplar is worth carrying. Whole promptlib templates run 2-4 KB. */
export const EXAMPLE_CHARS = 600

/**
 * Two exemplars, never more.
 *
 * One shows the shape; two show which parts of the shape are load-bearing and which are
 * this example's own. A third buys nothing and costs 600 characters of a 6000-character
 * budget that the actual ask needs.
 */
export const MAX_EXAMPLES = 2

/**
 * The done line used when the caller has none.
 *
 * It is deliberately about EVIDENCE rather than about finishing: a caller that cannot say
 * what proves the work still gets a prompt that refuses a bare claim. This is the whole
 * reason the block is unconditional - a prompt with no definition of done reads as
 * finished the moment the agent stops typing.
 */
export const DEFAULT_DONE = 'say what changed and name the command, flow or file that proves it'

/** The `Done means:` heading. Every forged prompt ends with this block. */
export const DONE_HEAD = 'Done means:'

/** Trim one exemplar, on a line boundary where there is one near the end. */
export function trimExample(text: string, max = EXAMPLE_CHARS): string {
  const body = String(text || '').trim()
  if (body.length <= max) return body
  const cut = body.slice(0, max)
  // A cut mid-line reads as a broken example rather than a shortened one, so prefer the
  // last line break - but only when it is not so far back that the example loses its point.
  const nl = cut.lastIndexOf('\n')
  return (nl > max * 0.6 ? cut.slice(0, nl) : cut).trimEnd() + '\n…'
}

function lines(v: string[] | undefined): string[] {
  return (v ?? []).map((s) => String(s || '').trim()).filter(Boolean)
}

function bullets(head: string, items: string[]): string[] {
  return items.length ? [head, ...items.map((s) => `- ${s}`), ''] : []
}

/**
 * Write the prompt.
 *
 * The order is the order somebody reads in: what is being asked, where to start, what may
 * be touched, how this kind of ask is judged, one or two examples of a good one, and last
 * - always last, so it is the thing still on screen when the reading finishes - what done
 * means.
 */
export function forgePrompt(input: ForgeInput): string {
  const task = String(input.task || '').trim()
  const anchors = lines(input.anchors)
  const done = lines(input.done)
  const scope = lines(input.scope)
  const guidance = lines(input.template?.guidance)
  const examples = lines(input.examples ?? input.template?.examples)
    .slice(0, MAX_EXAMPLES)
    .map((e) => trimExample(e))

  const doneBlock = [DONE_HEAD, ...(done.length ? done : [DEFAULT_DONE]).map((s) => `- ${s}`)].join(
    '\n'
  )

  const exampleBlock = (keep: number): string[] =>
    keep <= 0 || !examples.length
      ? []
      : [
          keep === 1
            ? 'An example of a good ask of this kind:'
            : 'Examples of a good ask of this kind:',
          ...examples.slice(0, keep).flatMap((e) => ['---', e, '---']),
          ''
        ]

  const build = (keep: number, withGuidance: boolean, body: string): string =>
    [
      body,
      '',
      ...bullets('Start from:', anchors),
      ...bullets('Stay inside:', scope),
      ...(withGuidance ? bullets('Judged on:', guidance) : []),
      ...exampleBlock(keep),
      doneBlock
    ]
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

  // Everything that can be dropped is dropped before the ask itself is touched, and the
  // done block is never touched at all: a prompt that fits by losing what proves it is
  // finished is the failure this file exists to stop.
  const budget = Math.max(1, input.budget ?? MAX_PROMPT_CHARS)
  for (let keep = examples.length; keep >= 0; keep--) {
    const out = build(keep, true, task)
    if (out.length <= budget) return out
  }
  const bare = build(0, false, task)
  if (bare.length <= budget) return bare
  const over = bare.length - budget
  return build(0, false, task.slice(0, Math.max(0, task.length - over - 2)).trimEnd() + '…')
}

/**
 * The templates that ship inside the app, used when promptlib is not on this machine.
 *
 * These are a COPY of the judgement in the matching `claude-config/promptlib` template,
 * not a second source: `main/promptForge.ts` prefers the file on disk, which is the one
 * Robert edits and `harvest.mjs` appends exemplars to. The ids match promptlib's so that
 * borrowing an exemplar is a lookup rather than a mapping.
 */
export const BUILT_IN_TEMPLATES: Record<string, ForgeTemplate> = {
  'multi-item-opener': {
    id: 'multi-item-opener',
    guidance: [
      'each item is finished and proved on its own before the next is started',
      'an item that turns out to be blocked is named, not quietly dropped'
    ]
  },
  'build-feature': {
    id: 'build-feature',
    guidance: [
      'the behaviour is shown working locally before anything is pushed',
      'the files changed match the scope that was fenced'
    ]
  },
  'research-decide': {
    id: 'research-decide',
    guidance: [
      'the answer is a decision with the reason, not a survey of the options',
      'anything left out of the decision is named'
    ]
  }
}

/** The built-in copy of a template, or null when this app ships none for that id. */
export function builtInTemplate(id: string): ForgeTemplate | null {
  return BUILT_IN_TEMPLATES[id] ?? null
}

// ---------------------------------------------------------------------------
// Reading Robert's library. The DISK is `main/promptForge.ts`; the reading is here so a
// node test can run it, and because the library is plain markdown by its own rule ("the
// CLI is a convenience, never the source") - so this parses the file, not the CLI.

/** Every fenced block under a heading whose text matches `head`. */
export function fencedUnder(body: string, head: RegExp): string[] {
  const out: string[] = []
  for (const s of String(body).replace(/\r\n/g, '\n').split(/^##\s+/m).slice(1)) {
    const title = s.slice(0, s.indexOf('\n'))
    if (!head.test(title.trim())) continue
    for (const m of s.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      const text = m[1].trim()
      if (text) out.push(text)
    }
  }
  return out
}

/** The numbered checks under `## Discernment`, one line each. */
export function discernment(body: string): string[] {
  const s = String(body)
    .replace(/\r\n/g, '\n')
    .split(/^##\s+/m)
    .slice(1)
    .find((x) => /^Discernment/i.test(x.trim()))
  if (!s) return []
  return [...s.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1].trim().replace(/\s+/g, ' ')).filter(Boolean)
}

/**
 * Turn one promptlib template file into a `ForgeTemplate`.
 *
 * Order of the exemplars is deliberate: the library's own `## Template` block first,
 * because it is the SHAPE, then anything `harvest.mjs` appended - real prompts of his that
 * the run ledger says worked - newest last in the file, so newest first here. A file that
 * carries neither is not a template, and `null` sends the caller to the built-in copy.
 */
export function readPromptlibTemplate(id: string, markdown: string): ForgeTemplate | null {
  const examples = [...fencedUnder(markdown, /^Template/i), ...fencedUnder(markdown, /^Harvested/i).reverse()]
  const guidance = discernment(markdown)
  if (!examples.length && !guidance.length) return null
  return { id, guidance: guidance.length ? guidance : (builtInTemplate(id)?.guidance ?? []), examples }
}
