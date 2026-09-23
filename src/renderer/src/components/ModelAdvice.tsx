// A Claude Code pane's first ask reads lighter or harder than the model and effort it is
// already on - a quiet card in the corner, never a hold on the ask itself. See
// `shared/modelAdvice.ts` for the rule and `Robert's decisions` at the top of the spec
// this was built from: no sound, no countdown, no focus steal. `Switch` presses it;
// `Keep` or doing nothing at all leaves the pane exactly as it was.
//
// Same shape as `OffloadSoon`, and drawn beside it in `.corner-stack` for the same reason:
// this is another thing the app noticed and is offering, not asking. Unlike that card it
// has no deadline of its own - it leaves only when the pane's next ask goes in (main
// clears `meta.modelAdvice` itself), the pane closes, or `useIdleDismiss` decides five
// minutes of silence was an answer (`shared/cardIdle.ts`, the same clock `WhatsNewCard`
// uses for the same reason: it says something and wants nothing back).

import React, { useEffect, useState } from 'react'
import type { AgentInfo } from '@shared/agents'
import { agentModelLabel } from '@shared/agents'
import type { Session } from '@shared/types'
import { describePlace } from '@shared/place'
import { paneWord } from '@shared/mascot'
import CardX from './CardX'
import { useIdleDismiss } from '../idleDismiss'

const api = window.api

export interface ModelAdviceAsk {
  id: string
  tier: 'light' | 'heavy'
  to: { model: string; effort: string }
  from: { model: string; effort: string }
  askedAt: number
}

export interface ModelAdviceProps {
  sessions: Session[]
  agents: AgentInfo[]
}

function capitalise(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word
}

/** One card, self-contained: it owns the list of asks it has been told about and drops
 * one the moment the pane it names is gone, answered elsewhere, or has moved past its
 * first ask - see `write()` in `main/sessions.ts`, which clears `meta.modelAdvice` on
 * every later turn boundary and re-broadcasts the sessions list when it does. */
function Card({
  ask,
  session,
  agents,
  pane
}: {
  ask: ModelAdviceAsk
  session: Session
  agents: AgentInfo[]
  pane: number
}): React.JSX.Element {
  const [gone, setGone] = useState(false)
  const idle = useIdleDismiss(!gone, () => setGone(true))
  if (gone) return <></>
  const spec = agents.find((a) => a.id === session.agent)
  const fromLabel = agentModelLabel(spec, ask.from.model) || ask.from.model
  const toLabel = agentModelLabel(spec, ask.to.model) || ask.to.model
  const place = describePlace({ cwd: session.cwd, lane: session.lane })
  const name = paneWord({
    name: session.title,
    pane,
    where: place.kind === 'lane' ? place.role : ''
  })
  const answer = (doSwitch: boolean): void => {
    void api.answerModelAdvice(ask.id, doSwitch)
    setGone(true)
  }
  const say =
    ask.tier === 'heavy'
      ? `This looks like a hard one. ${toLabel} on ${ask.to.effort} effort would do it better.`
      : `This looks like a quick one. ${toLabel} on ${ask.to.effort} effort would do it.`
  return (
    <div className="move-soon" role="status" data-testid="model-advice" {...idle.handlers}>
      <CardX onDismiss={() => answer(false)} />
      <div className="move-soon-say">{say}</div>
      <div className="move-soon-why">{name}</div>
      <div className="move-soon-acts">
        <button type="button" onClick={() => answer(false)}>
          Keep {fromLabel} {ask.from.effort}
        </button>
        <button type="button" className="ghost" onClick={() => answer(true)}>
          Switch
        </button>
      </div>
    </div>
  )
}

export default function ModelAdvice({ sessions, agents }: ModelAdviceProps): React.JSX.Element | null {
  const [asks, setAsks] = useState<ModelAdviceAsk[]>([])
  useEffect(
    () =>
      api.onModelAdvice((ask: ModelAdviceAsk) => {
        setAsks((prev) => [...prev.filter((a) => a.id !== ask.id), ask])
      }),
    []
  )
  // A pane that closed, or one main has already moved past this ask on, drops the card
  // without waiting for the idle clock - the sessions list is the one thing that always
  // knows both facts.
  const live = asks.filter((a) => {
    const s = sessions.find((x) => x.id === a.id)
    return s && s.status !== 'exited' && s.modelAdvice?.askedAt === a.askedAt
  })
  if (!live.length) return null
  return (
    <>
      {live.map((ask) => {
        const i = sessions.findIndex((x) => x.id === ask.id)
        const session = i < 0 ? undefined : sessions[i]
        if (!session) return null
        return (
          <Card
            key={`${ask.id}:${ask.askedAt}`}
            ask={ask}
            session={session}
            agents={agents}
            pane={i + 1}
          />
        )
      })}
    </>
  )
}
