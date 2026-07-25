// Always-on version readout in the sidebar foot.
//
// The update toast only appears when a new build is already downloaded, which
// leaves the obvious question - "what am I even running, and is it current?" -
// permanently unanswered. This answers it without being asked, and clicking it
// is the manual "check now" (or "restart into the new one" once it is ready).

import { useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'

const api = window.api

interface View {
  text: string
  tone: '' | 'ok' | 'warn' | 'accent'
  title: string
}

function view(s: UpdateState | null): View {
  if (!s) return { text: '', tone: '', title: '' }
  switch (s.phase) {
    case 'checking':
      return { text: 'checking…', tone: '', title: 'Asking GitHub for the newest release' }
    case 'none':
      return { text: 'up to date', tone: 'ok', title: 'This is the newest published release' }
    case 'available':
      return { text: `${s.version} out`, tone: 'accent', title: 'Click to open the download page' }
    case 'downloading':
      return {
        text: `${s.version} ${s.percent ?? 0}%`,
        tone: 'accent',
        title: 'Downloading the new version in the background'
      }
    case 'ready':
      return { text: `${s.version} ready`, tone: 'accent', title: 'Click to restart into the new version' }
    case 'error':
      return { text: 'check failed', tone: 'warn', title: s.error ?? 'The update check failed - click to retry' }
    case 'unsupported':
      // A folder build has no update feed, so "up to date" would be a lie.
      return { text: 'local build', tone: 'warn', title: s.error ?? 'Not an installed build - it cannot update itself' }
    default:
      return { text: 'check', tone: '', title: 'Click to check for a new version' }
  }
}

export default function VersionBadge(): JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    api.updateState().then(setState)
    return api.onUpdate(setState)
  }, [])

  const v = view(state)
  const click = (): void => {
    if (state?.phase === 'ready') return api.installUpdate()
    if (state?.phase === 'available' && state.url) return api.openExternal(state.url)
    void api.checkForUpdates().then(setState)
  }

  return (
    <button className={'version' + (v.tone ? ' ' + v.tone : '')} onClick={click} title={v.title}>
      <span className="v-num">v{state?.current ?? '…'}</span>
      {v.text && <span className="v-state">{v.text}</span>}
    </button>
  )
}
