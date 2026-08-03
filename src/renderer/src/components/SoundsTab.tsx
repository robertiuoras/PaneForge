import { useState } from 'react'
import type { Config } from '@shared/types'
import {
  DEFAULT_SOUNDS,
  SOUND_EXTS,
  soundOptions,
  type SoundConfig,
  type SoundEvent
} from '@shared/sounds'
import Select from './Select'
import { previewSound } from '../useChime'

const api = window.api

/**
 * Which sound each alert makes.
 *
 * Its own tab rather than three more rows under General, for one reason: General answers
 * "should the app interrupt me", and this answers "with what". They are different
 * questions and the switches for the first were already the longest block on that page.
 *
 * Every row is picker + play, always both. A sound list with no way to hear a sound is a
 * list of adjectives - nobody knows what "Droid chirp" is until it happens, and finding
 * out by waiting for a real alert is how you end up with a cat noise you cannot live with
 * firing at 2am.
 */
const EVENTS: { key: SoundEvent; label: string; hint: string }[] = [
  {
    key: 'done',
    label: 'A session finished its turn',
    hint: 'The one you will hear most - it plays even while PaneForge is focused, because a pane you are not reading can still finish. Pick something you can hear forty times a day.'
  },
  {
    key: 'stall',
    label: 'A running turn went silent',
    hint: 'The turn clock is still going and the pane has printed nothing for the number of minutes set under General. Worth making audibly different from the one above - it is the only check on the app claiming an agent is working.'
  },
  {
    key: 'bell',
    label: 'A pane rang the terminal bell',
    hint: 'A CLI asking for a person directly: a prompt it needs answered, a build that failed. Short is better here, since a chatty CLI can ring several times a minute.'
  }
]

interface Props {
  config: Config
  onChange: (patch: Partial<Config>) => void
}

export default function SoundsTab({ config, onChange }: Props): JSX.Element {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const sounds: SoundConfig = { ...DEFAULT_SOUNDS, ...(config.sounds ?? {}), custom: config.sounds?.custom ?? [] }
  const options = soundOptions(sounds.custom)

  const set = (patch: Partial<SoundConfig>): void => onChange({ sounds: { ...sounds, ...patch } })

  const add = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    const r = await api.addSound()
    setBusy(false)
    // A cancelled file dialog is not an error and must not leave a red line behind.
    if (!r.ok && r.error) setMsg(r.error)
    if (r.ok && r.sound) {
      setMsg(`Added ${r.sound.name}.`)
      onChange({ sounds: { ...sounds, custom: [...sounds.custom, r.sound] } })
      // Heard immediately: the whole point of uploading one is to check it is the right
      // file and the right loudness, and both are answered in half a second.
      previewSound('custom:' + r.sound.id, { ...sounds, custom: [...sounds.custom, r.sound] })
    }
  }

  const remove = async (id: string, name: string): Promise<void> => {
    const next = await api.removeSound(id)
    onChange({ sounds: next })
    setMsg(`Removed ${name}. Anything that used it is back on its built-in sound.`)
  }

  const rename = async (id: string, current: string): Promise<void> => {
    const name = window.prompt('Name for this sound', current)?.trim()
    if (!name || name === current) return
    onChange({ sounds: await api.renameSound(id, name) })
  }

  return (
    <>
      <div className="setting">
        <label>Volume ({Math.round(sounds.volume * 100)}%)</label>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(sounds.volume * 100)}
          onChange={(e) => set({ volume: Number(e.target.value) / 100 })}
          onMouseUp={() => previewSound(sounds.done, sounds)}
        />
        <div className="hint">
          Applies to all three below. At 0% the alerts still mark the pane and flash the
          taskbar - they just do it silently.
        </div>
      </div>

      {EVENTS.map((ev) => (
        <div key={ev.key} className="setting">
          <label>{ev.label}</label>
          <div className="setting-row">
            <Select
              className="sound-pick"
              value={sounds[ev.key]}
              onChange={(v) => {
                set({ [ev.key]: v } as Partial<SoundConfig>)
                // Picked, then played. Choosing from a list of two dozen is a comparison,
                // and a comparison you have to click a second button for is not one.
                previewSound(v, sounds)
              }}
              menuWidth={280}
              searchable
              options={options}
            />
            <button
              className="ghost small"
              title="Play it"
              onClick={() => previewSound(sounds[ev.key], sounds)}
            >
              ▶ Play
            </button>
          </div>
          <div className="hint">{ev.hint}</div>
        </div>
      ))}

      <div className="setting">
        <label>Your own sounds</label>
        <div className="hint">
          Any {SOUND_EXTS.map((e) => e.slice(1)).join(', ')} file under 8 MB. PaneForge takes
          its own copy, so the alert keeps working after you move or tidy the original.
        </div>
        {sounds.custom.map((c) => (
          <div key={c.id} className="setting-row sound-row">
            <span className="sound-name">{c.name}</span>
            <button className="ghost small" title="Play it" onClick={() => previewSound('custom:' + c.id, sounds)}>
              ▶
            </button>
            <button className="ghost small" onClick={() => void rename(c.id, c.name)}>
              Rename
            </button>
            <button className="ghost small" onClick={() => void remove(c.id, c.name)}>
              Remove
            </button>
          </div>
        ))}
        {!sounds.custom.length && <div className="empty">Nothing uploaded yet.</div>}
        <div className="setting-row">
          <button className="ghost" disabled={busy} onClick={() => void add()}>
            {busy ? 'Choosing…' : 'Add a sound file…'}
          </button>
          {msg && <span className="hint">{msg}</span>}
        </div>
      </div>
    </>
  )
}
