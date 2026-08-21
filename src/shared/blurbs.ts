// What a feature IS, said once, at the top of the thing itself.
//
// Every dialog in this app opens with a noun and no explanation: "Devices". "Board".
// "Swarm". Each of those is obvious to the person who built it and a guess to everybody
// else, and the guess is usually wrong in the expensive direction - "Board" reads as a
// private to-do list until you find out the agents read it, and "Devices" reads as a
// hardware list until you find out it drives another machine's panes.
//
// So each one now says what it is and what it does, in one sentence, the first time and
// every time until it is dismissed. Three rules hold the set together:
//
//   - **What it is, then what it does, then what it costs you.** Not a feature name
//     restated. If the sentence would still be true with the feature's name swapped for
//     another one, it says nothing.
//   - **One sentence, plain words.** The title bar already has the noun; this is the
//     line under it, not documentation. `scripts/blurb-test.mjs` pins the length and the
//     shape so a later edit cannot quietly grow one into a paragraph.
//   - **Dismissible, per feature, forever.** Robert opens Devices forty times; a note he
//     has read is noise by the third. The × hides that one, and one button in Settings
//     brings them all back.

export interface Blurb {
  /** stable key: it is what a dismissal is saved under, so it may never be renamed */
  id: string
  /** what the dialog calls itself, used by the test to keep the two in step */
  title: string
  text: string
}

export const BLURBS: Blurb[] = [
  {
    id: 'devices',
    title: 'Devices',
    text: 'Your other computer, driven from this one. Pair the two and each can open, read and type into the other machine’s panes - the agent, its folder and its files stay where they were started, so nothing is copied anywhere.'
  },
  {
    id: 'history',
    title: 'History',
    text: 'Everything every pane has ever printed, kept after the pane is closed. Search all of it at once, read a whole past session back, or reopen one in its old folder with the agent it was using.'
  },
  {
    id: 'board',
    title: 'Board',
    text: 'A to-do list and a notes file that the agents in this project can read. Both are saved into the project’s own .paneforge folder, so a task you write here is a task an agent working in that folder can be pointed at.'
  },
  {
    id: 'swarm',
    title: 'Swarm',
    text: 'Start several agents on one project at once, each told what it owns. They share the folder, so what keeps them apart is their briefs - and the shared memory file is the handover between them. Work whose parts are genuinely independent wants a lane each instead.'
  },
  {
    id: 'lane',
    title: 'Lane',
    text: 'This pane is working in its own copy of the repo on its own branch, so another chat editing the same project cannot collide with it. Merging brings the work back into the main checkout and lets the copy be cleaned up.'
  },
  {
    id: 'newSession',
    title: 'New session',
    text: 'Open one or more panes, each an agent running in a project folder. Tick several projects to start them all in one go, and each pane keeps its own terminal, history and folder.'
  },
  {
    id: 'stash',
    title: 'Stash',
    text: 'Everything you copy, kept in a list you can float over any window. Click an entry to put it back on the clipboard, pin the ones you keep needing, and drag files or images straight out of it.'
  },
  {
    id: 'shortcuts',
    title: 'Help',
    text: 'Every key this app answers to, and what each pane’s marks and colours mean. Nothing here changes anything - it is the map.'
  },
  {
    id: 'changes',
    title: 'Changes',
    text: 'Every line the agent in this pane has written, read here instead of in its terminal. Switch between what is uncommitted, what the whole branch holds, or both at once before merging a lane back. Nothing here stages, commits or discards anything.'
  },
  {
    id: 'fleet',
    title: 'Fleet',
    text: 'Every open pane on one screen, sorted by who needs a person first: a finished turn at the top, a run that has gone quiet under it, and whatever the app is happily busy with below both. The bar on each row is how much that folder has changed, and clicking it opens the lines.'
  },
  {
    id: 'restore',
    title: 'Restore',
    text: 'The panes that were open when PaneForge last closed. Reopening puts each agent back in its folder and, where the CLI supports it, back into the conversation it was in.'
  }
]

const BY_ID = new Map(BLURBS.map((b) => [b.id, b]))

export function blurbFor(id: string): Blurb | null {
  return BY_ID.get(id) ?? null
}

/** Whether this note is still worth drawing, given what has been dismissed. */
export function blurbShown(id: string, hidden: string[] | undefined): boolean {
  if (!BY_ID.has(id)) return false
  return !(hidden ?? []).includes(id)
}
