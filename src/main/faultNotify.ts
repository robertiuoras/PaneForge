// The plumbing behind `shared/faultNotify.ts`: one HTTPS POST, on the channel
// `askNotify.ts` already opened, and nothing else.
//
// It is deliberately a LISTENER on `crash.ts` rather than a call inside it. `crash.ts`
// runs before profile setup and is the thing that catches faults in everything else, so
// it may not itself depend on the network, on config, or on a module that could throw at
// import time. It writes the log line first, always, and then tells whoever is listening.

import { hostname } from 'node:os'
import { postAsk } from './askNotify'
import { onProblem } from './crash'
import { profileName } from './profile'
import { decide, type FaultState } from '../shared/faultNotify'

let state: FaultState = { sent: {}, count: 0 }

/** For the test, and for a second launch inside one process (there is not one). */
export function resetFaultNotify(): void {
  state = { sent: {}, count: 0 }
}

function device(): string {
  return process.env.PF_DEVICE || hostname().replace(/\.local$/, '')
}

/**
 * Called once from `index.ts`, after the profile is known - so a `npm run try` copy is
 * already excluded by name rather than by remembering to check.
 */
export function startFaultNotify(): void {
  onProblem((kind, detail) => {
    const { state: next, send } = decide(state, { kind, detail }, {
      now: Date.now(),
      profile: profileName(),
      device: device()
    })
    state = next
    // Never awaited: a fault report may not hold up the log line, the toast, or a quit.
    if (send) void postAsk(send)
  })
}
