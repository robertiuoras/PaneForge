/**
 * A pane is already open on this folder and there is a prompt to deliver. One or two panes?
 *
 * The old answer was always "one": `startOrSend` handed the request to the pane that was
 * already there. Measured 2026-09-07 - the pane it handed two briefs to was MID-TURN, so
 * both went into `queuePrompt`'s wait behind a turn that ran for twenty minutes, and when
 * the pane was recreated they were gone. Queueing behind a busy pane is a promise the app
 * cannot keep on any useful timescale, and the brief was written to be worked on now.
 *
 * So a prompt only ever goes to a pane that can take it THIS MOMENT: idle, holding no
 * question, with nothing already waiting to be typed into it. Anything else opens its own
 * pane, which is what the person asking for the work wanted in the first place.
 *
 * Without a prompt nothing changes: "go to the chat for this client" is a request to look
 * at a pane, and a busy pane is still the right one to look at.
 */

/** What is known about the pane already open on the folder. */
export interface OpenPane {
  id: string
  /** `Session.status` - 'starting' and 'working' both mean it cannot take a line now. */
  status?: string
  /** A turn is running. */
  runSince?: number | null
  /** The agent is asking a person something. */
  ask?: unknown
  /** An unsent line in the composer. */
  drafting?: boolean
  /** Prompts already accepted for this pane and not yet typed. */
  queued?: number
}

export interface SendOrOpen {
  /** 'send' hands the prompt to `pane`; 'open' starts a new one. */
  action: 'send' | 'open'
  /** The pane, when there is one to go to. */
  id?: string
  /** One line, for the toast and for `pf open`'s own output. */
  why: string
}

export function sendOrOpen(p: { prompt?: string; pane?: OpenPane | null }): SendOrOpen {
  const pane = p.pane
  if (!pane) return { action: 'open', why: 'nothing is open in that folder' }
  // No prompt: this is somebody going to a chat, and the pane is the chat whatever it is
  // doing. This is the reuse behaviour that has always been here.
  if (!p.prompt || !p.prompt.trim()) return { action: 'send', id: pane.id, why: 'the pane is already open there' }
  if (pane.status === 'exited') return { action: 'open', why: 'the pane there has no agent in it' }
  if (pane.status === 'starting') return { action: 'open', why: 'the pane there is still starting' }
  if (pane.runSince || pane.status === 'working') return { action: 'open', why: 'the pane there is mid-turn' }
  if (pane.ask) return { action: 'open', why: 'the pane there is waiting on an answer' }
  if (pane.drafting) return { action: 'open', why: 'there is an unsent line in that pane' }
  if (pane.queued) return { action: 'open', why: 'that pane is already holding a prompt nobody has typed yet' }
  return { action: 'send', id: pane.id, why: 'the pane there is idle' }
}
