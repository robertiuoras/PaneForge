// The Welcome screen's first-run card: pure decisions, no I/O. The facts come from the
// `setup:check` rows (`shared/setupCheck.ts`), the saved config and the list of past
// sessions; `FirstRunCard.tsx` asks for them and draws the answer.
//
// The card is for a person who has never opened a pane: it gets one coding assistant
// installed, a folder picked, and the first chat open, without a command typed anywhere.

import type { SetupRow } from './setupCheck'

/** The two assistants offered here: the ones included in a plan a person may already pay for. */
export type FirstAgent = 'claude' | 'codex'

export interface AgentState {
  id: FirstAgent
  installed: boolean
  signedIn: boolean
}

/**
 * Whether the card shows at all. `firstChatStarted` is written once a pane has opened;
 * `pastSessions` covers every profile from before that flag existed, so nobody who has
 * already used the app is walked through setting it up.
 */
export function showFirstRun(firstChatStarted: boolean | undefined, pastSessions: number): boolean {
  return !firstChatStarted && pastSessions === 0
}

/** Both assistants' state, read off the same rows the Welcome checklist draws - no second probe. */
export function agentStates(rows: SetupRow[]): AgentState[] {
  const has = (id: string): boolean => rows.some((r) => r.id === id)
  return [
    { id: 'claude', installed: !has('claude'), signedIn: !has('signin') },
    { id: 'codex', installed: !has('codex'), signedIn: !has('codex') && !has('codex-signin') }
  ]
}

/**
 * Which assistant "Start your first chat" opens. A signed-in one beats one that still has
 * to sign in (that chat opens on a sign-in screen, not a conversation), the saved default
 * breaks a tie, then Claude. Null = nothing is installed yet, so there is nothing to start.
 */
export function chatAgent(states: AgentState[], preferred?: string): FirstAgent | null {
  const rank = (s: AgentState): number =>
    (s.installed ? 4 : 0) + (s.signedIn ? 2 : 0) + (s.id === preferred ? 1 : 0)
  // Stable sort: on a full tie the catalogue order (Claude first) stands.
  const best = [...states].sort((a, b) => rank(b) - rank(a))[0]
  return best?.installed ? best.id : null
}

/**
 * The assistant to badge "Recommended" while nothing is installed: Claude, because its
 * installer needs nothing else on the machine, where Codex's needs Node first.
 */
export function recommendedInstall(states: AgentState[]): FirstAgent | null {
  return states.some((s) => s.installed) ? null : 'claude'
}

/** The folder made for the first chat when there is no projects folder to open it in yet. */
export const FIRST_FOLDER = 'my-first-project'

/**
 * Where the first chat opens: the projects folder itself when it is there, so the
 * assistant can see every project in it. A fresh machine has none yet, and the one
 * folder the window can ask for is a new project INSIDE it (`createProject`, which makes
 * the projects folder on the way), so the first chat opens in that.
 */
export function firstChatFolder(root: string, rootExists: boolean): { cwd: string } | { create: string } {
  return rootExists ? { cwd: root } : { create: FIRST_FOLDER }
}
