// The whole screen, while you are talking to it.
//
// A phone is not a small desktop: the mic on a pane header is a 32 px target beside
// a terminal, which is the right thing on a 27-inch monitor and unusable at arm's
// length. So on a narrow or touch screen the act of dictating takes the screen -
// the one thing in this app that is allowed to, because a finger asked for it.
//
// It also earns its place on a desktop while the model is downloading: that is a
// once-ever 77 MB wait, and a spinner in a pane corner is where a wait goes to be
// mistaken for a hang.

import { useEffect } from 'react'
import MicIcon from './MicIcon'
import type { Voice } from '../useVoice'

export interface VoiceOverlayProps {
  voice: Voice
  /** where the words are going, in the words of shared/place.ts */
  where: string
}

export function VoiceOverlay({ voice, where }: VoiceOverlayProps): React.JSX.Element | null {
  const open = voice.phase !== 'idle'

  // Escape throws the clip away. On a phone there is no Escape, which is why
  // Cancel is a button of the same weight as Send rather than a corner cross.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        voice.cancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        voice.stop()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, voice])

  if (!open) return null

  const recording = voice.phase === 'recording'
  const downloading = voice.progress >= 0

  return (
    <div className="voice-overlay" role="dialog" aria-label="Dictation" aria-live="polite">
      <div className="voice-sheet">
        <div className="voice-where">{where}</div>

        <div
          className={'voice-orb' + (recording ? ' live' : '')}
          // The ring is the level, not a decoration: it is the only proof on a phone
          // that the mic is hearing anything at all before the words arrive.
          style={{ '--level': recording ? voice.level.toFixed(3) : '0' } as React.CSSProperties}
        >
          <span className="voice-ring" />
          <span className="voice-face">
            {voice.phase === 'thinking' || voice.phase === 'loading' ? (
              <span className="voice-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : (
              <MicIcon size={44} />
            )}
          </span>
        </div>

        <div className="voice-said">
          {voice.interim ? (
            voice.interim
          ) : recording ? (
            <span className="voice-hint">Listening. Say it, then Send.</span>
          ) : voice.phase === 'loading' ? (
            <span className="voice-hint">
              {downloading
                ? `Downloading the model, once - ${voice.modelMb} MB`
                : 'Starting the transcriber'}
            </span>
          ) : (
            <span className="voice-hint">Working it out</span>
          )}
        </div>

        {downloading && (
          <div className="voice-bar" aria-label={`${voice.progress}%`}>
            <span style={{ width: `${voice.progress}%` }} />
          </div>
        )}

        <div className="voice-acts">
          <button type="button" className="voice-act ghost" onClick={voice.cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="voice-act go"
            onClick={voice.stop}
            disabled={!recording}
          >
            Send
          </button>
        </div>

        <div className="voice-why">{voice.choice.why}</div>
      </div>
    </div>
  )
}
