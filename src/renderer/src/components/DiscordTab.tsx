import { useEffect, useState } from 'react'
import type { Config } from '@shared/types'
import {
  DEFAULT_DISCORD_STYLE,
  DEFAULT_LINK_LABEL,
  DEFAULT_LINK_URL,
  DISCORD_TOKENS,
  MAX_BUTTONS,
  NO_PRESENCE_STATUS,
  PRESENCE_IMAGE_TEXT,
  VISIBLE_ROWS,
  buildActivity,
  newRowId,
  chosenRows,
  type DiscordButton,
  type DiscordRow,
  type DiscordStyle,
  type PresenceCounts,
  type PresenceStatus,
  type RowWhen
} from '@shared/discordRpc'
import { Segmented, Switch } from './Controls'

const api = window.api

/**
 * The Discord tab: what the profile says, and a picture of it while you write it.
 *
 * Its own file rather than another block inside `SettingsDialog.tsx` because the rows
 * editor is a list with its own state-free arithmetic, and because the preview is the
 * only place in the app deliberately drawn in ANOTHER product's colours - Discord's,
 * sampled from its own dark profile card. The rest of the app derives every colour from
 * the accent (`shared/theme.ts`); a replica that did the same would be a picture of
 * PaneForge, which is the one thing it must not be.
 *
 * `scripts/settings-index.mjs` reads this file whole and files every setting in it under
 * the `discord` tab, so the search box finds these rows exactly like the ones that
 * stayed behind.
 */

interface Props {
  config: Config
  onChange: (patch: Partial<Config>) => void
}

/**
 * A desk that stands in for yours while you edit the wording. Fixed numbers rather than
 * the live ones on purpose: the point of the preview is that a template can be judged
 * with an empty desk and no Discord open, and real counts of 0/0 would render every
 * template as the same nothing.
 */
const SAMPLE_BUSY: PresenceCounts = {
  running: 2,
  total: 5,
  names: ['PaneForge', 'Toolstash', 'Manic-s-Auction-House'],
  oldestRunSince: 0,
  asleep: 1,
  appStart: 0,
  tokensToday: 1_480_000,
  tokensWeek: 9_200_000
}
const SAMPLE_IDLE: PresenceCounts = {
  running: 0,
  total: 5,
  names: [],
  asleep: 2,
  appStart: 0,
  tokensToday: 1_480_000,
  tokensWeek: 9_200_000
}

const WHEN_OPTIONS: { value: RowWhen; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: 'running', label: 'Working' },
  { value: 'idle', label: 'Idle' }
]

export default function DiscordTab({ config, onChange }: Props): JSX.Element {
  // Which half of the preview is on screen. The idle wording is the half nobody would
  // otherwise see until the desk went quiet, which is too late to edit it.
  const [preview, setPreview] = useState<'busy' | 'idle'>('busy')
  const style = config.discordStyle
  const setStyle = (patch: Partial<DiscordStyle>): void =>
    onChange({ discordStyle: { ...style, ...patch } })
  const setRows = (rows: DiscordRow[]): void => setStyle({ rows })
  const patchRow = (i: number, patch: Partial<DiscordRow>): void =>
    setRows(style.rows.map((r, n) => (n === i ? { ...r, ...patch } : r)))
  const moveRow = (i: number, by: number): void => {
    const rows = [...style.rows]
    const to = i + by
    if (to < 0 || to >= rows.length) return
    ;[rows[i], rows[to]] = [rows[to], rows[i]]
    setRows(rows)
  }
  const setButtons = (buttons: DiscordButton[]): void => setStyle({ buttons })
  const patchButton = (i: number, patch: Partial<DiscordButton>): void =>
    setButtons(style.buttons.map((b, n) => (n === i ? { ...b, ...patch } : b)))

  const counts = preview === 'busy' ? SAMPLE_BUSY : SAMPLE_IDLE
  // Which rows this sample desk would actually put on the card, so a row that is
  // written but cannot be drawn can say why rather than looking broken. By id, not by
  // text: two rows worded the same are still two rows, and matching on the words would
  // have credited the second one with the first one's place.
  const shown = chosenRows(counts, style).map((r) => r.id)

  return (
    <>
      <Switch
        checked={config.discordPresence}
        onChange={(v) => onChange({ discordPresence: v })}
        label="Show what the desk is doing on Discord"
        hint="Rich presence on your profile, refreshed as turns start and finish. Counts, project folder names and your own token totals - never a byte of what a pane says. Needs the Discord app running; off tells Discord nothing at all."
      />

      {config.discordPresence && (
        <>
          <DiscordStatus />

          <div className="setting">
            <div className="setting-row">
              <label>What other people see</label>
              <Segmented
                value={preview}
                onChange={(v) => setPreview(v as 'busy' | 'idle')}
                options={[
                  { value: 'busy', label: 'A turn running' },
                  { value: 'idle', label: 'Nothing running' }
                ]}
              />
            </div>
            <DiscordPreview style={style} counts={counts} />
          </div>

          <div className="setting">
            <div className="setting-row">
              <label>Lines</label>
              <button
                className="ghost small"
                onClick={() =>
                  setRows([
                    ...style.rows,
                    { id: newRowId(style.rows), text: '', when: 'always', on: true }
                  ])
                }
              >
                Add a line
              </button>
            </div>
            <div className="hint">
              Discord draws two lines and no more, so the first two that have something to
              say are the ones on the card. Drag order decides which: move a line up to put
              it on top, switch one off to hand its place to the one under it. A line whose
              words come out empty - "on {'{projects}'}" with nothing running - takes no
              space either.
            </div>
            <div className="row-list">
              {style.rows.map((row, i) => {
                const text = row.text.trim()
                const drawn = shown.indexOf(row.id)
                return (
                  <div className={'row-edit' + (row.on ? '' : ' off')} key={row.id}>
                    <div className="re-top">
                      <Switch
                        checked={row.on}
                        onChange={(v) => patchRow(i, { on: v })}
                        label={`Line ${i + 1}`}
                      />
                      <Segmented
                        value={row.when}
                        onChange={(v) => patchRow(i, { when: v as RowWhen })}
                        options={WHEN_OPTIONS}
                      />
                      <div className="re-moves">
                        <button
                          className="ghost small"
                          title="Move up"
                          disabled={i === 0}
                          onClick={() => moveRow(i, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="ghost small"
                          title="Move down"
                          disabled={i === style.rows.length - 1}
                          onClick={() => moveRow(i, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className="ghost small"
                          title="Remove this line"
                          onClick={() => setRows(style.rows.filter((_, n) => n !== i))}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <input
                      className="search"
                      value={row.text}
                      placeholder="Write what this line says"
                      spellCheck={false}
                      onChange={(e) => patchRow(i, { text: e.target.value })}
                    />
                    <div className="hint dim">
                      {!row.on
                        ? 'Switched off - nothing on the card.'
                        : !text
                          ? 'Empty, so it takes no room on the card.'
                          : drawn >= 0
                            ? `On the card now, as line ${drawn + 1}.`
                            : `Not on the card right now - ${
                                row.when === 'running'
                                  ? 'this one only shows while a turn is running.'
                                  : row.when === 'idle'
                                    ? 'this one only shows while nothing is running.'
                                    : `Discord only draws ${VISIBLE_ROWS} lines and two above it got there first.`
                              }`}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="setting">
            <div className="hint">
              Write whatever you like around these, which stand in for the numbers:
            </div>
            <div className="token-legend">
              {DISCORD_TOKENS.map(([token, what]) => (
                <div key={token}>
                  <code>{token}</code>
                  <span>{what}</span>
                </div>
              ))}
            </div>
            <div className="hint">
              Discord cuts a line off past 128 characters, so a long project list drops its
              tail for a "+2 more" rather than being chopped mid-word. The token totals are
              every agent on this machine, counted from the transcripts Claude Code and
              Codex already write - cache included, which is what a token counter shows.
            </div>
          </div>

          <div className="switches">
            <Switch
              checked={style.elapsed}
              onChange={(v) => setStyle({ elapsed: v })}
              label="Show the elapsed clock"
              hint="Discord counts up from the oldest running turn, or from when PaneForge started while everything is idle."
            />
          </div>

          <div className="setting">
            <div className="setting-row">
              <label>Buttons</label>
              {style.buttons.length < MAX_BUTTONS && (
                <button
                  className="ghost small"
                  onClick={() =>
                    setButtons([
                      ...style.buttons,
                      {
                        id: newRowId(style.buttons),
                        label: DEFAULT_LINK_LABEL,
                        url: DEFAULT_LINK_URL,
                        on: true
                      }
                    ])
                  }
                >
                  Add a button
                </button>
              )}
            </div>
            <div className="hint">
              Discord draws the lines above as plain text, so a link written into one is not
              clickable. A button is the only clickable thing a rich presence has, it takes
              two of them, and Discord shows them to everyone except you - so your own
              profile will not have them.
            </div>
            {style.buttons.map((b, i) => (
              <div className={'row-edit' + (b.on ? '' : ' off')} key={b.id}>
                <div className="re-top">
                  <Switch
                    checked={b.on}
                    onChange={(v) => patchButton(i, { on: v })}
                    label={`Button ${i + 1}`}
                  />
                  <div className="re-moves">
                    <button
                      className="ghost small"
                      title="Remove this button"
                      onClick={() => setButtons(style.buttons.filter((_, n) => n !== i))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <input
                  className="search"
                  value={b.label}
                  placeholder={DEFAULT_LINK_LABEL}
                  spellCheck={false}
                  maxLength={32}
                  onChange={(e) => patchButton(i, { label: e.target.value })}
                />
                <input
                  className="search"
                  value={b.url}
                  placeholder={DEFAULT_LINK_URL}
                  spellCheck={false}
                  onChange={(e) => patchButton(i, { url: e.target.value.trim() })}
                />
                <div className="hint dim">
                  Must start with http:// or https:// - Discord throws the whole presence
                  away over a malformed button, not just the button. Text is cut at 32
                  characters.
                </div>
              </div>
            ))}
          </div>

          <div className="setting">
            <button
              className="ghost small"
              onClick={() => onChange({ discordStyle: cloneStyle(DEFAULT_DISCORD_STYLE) })}
            >
              Back to the default wording
            </button>
          </div>
        </>
      )}
    </>
  )
}

/** A style nothing shares a row object with, so editing one never edits the default. */
function cloneStyle(style: DiscordStyle): DiscordStyle {
  return {
    ...style,
    rows: style.rows.map((r) => ({ ...r })),
    buttons: style.buttons.map((b) => ({ ...b }))
  }
}

/**
 * What Discord itself last said, rather than what the app meant to send.
 *
 * Every other answer here is a guess dressed up as a fact. This one answers the question
 * anyone actually asks, which is "is this on my profile". The last line closes the rest
 * of it: everything up to Discord can be right and other people can still see nothing,
 * because hiding it is Discord's own switch and no application can read or change it.
 */
function DiscordStatus(): JSX.Element {
  const [status, setStatus] = useState<PresenceStatus>(NO_PRESENCE_STATUS)
  useEffect(() => {
    void api.discordStatus().then(setStatus)
    return api.onDiscordStatus(setStatus)
  }, [])
  const at = status.acceptedAt ? new Date(status.acceptedAt).toLocaleTimeString() : ''
  return (
    <div className="setting">
      {!status.connected ? (
        <div className="hint">
          No Discord to talk to. PaneForge looks for it again every minute, so starting
          Discord is enough - nothing here needs touching.
        </div>
      ) : status.error ? (
        <div className="hint warn">Discord refused the last presence: {status.error}</div>
      ) : status.cleared ? (
        <div className="hint">
          Connected{status.user ? <> as <b>{status.user}</b></> : null} - and told Discord to
          show nothing, because the desk is empty.
        </div>
      ) : status.acceptedAt ? (
        <div className="hint">
          Discord accepted this at <b>{at}</b>
          {status.user ? <> for <b>{status.user}</b></> : null}
          {status.appName ? <>, under <b>{status.appName}</b></> : null}.
        </div>
      ) : (
        <div className="hint">Connected to Discord, waiting to send the first presence.</div>
      )}
      <div className="hint dim">
        Nobody can see it? That is not something this app can tell you, and if the line
        above says accepted, it is one of Discord's own switches: Discord → Settings →
        Activity Privacy, with both <b>Share your activity</b> and the per-server toggle on.
      </div>
    </div>
  )
}

/**
 * The card as Discord draws it - its own layout, its own colours, its own sizes, built
 * from the same `buildActivity` the main process sends. A preview that looks right
 * cannot be a presence that reads wrong, because it is the same function.
 *
 * The 60px art with the little badge on its corner, the uppercase heading, the
 * 32px-tall buttons under it: all of that is Discord's profile card, not this app's
 * design. It is the only screen here that ignores the theme on purpose.
 */
function DiscordPreview({
  style,
  counts
}: {
  style: DiscordStyle
  counts: PresenceCounts
}): JSX.Element {
  const activity = buildActivity(counts, style) as {
    details?: string
    state?: string
    timestamps?: unknown
    buttons?: { label: string; url: string }[]
  } | null
  // The header is the application's name and the application is a constant, so this is
  // not a lookup - it is the same literal the presence sends as its image tooltip.
  const header = PRESENCE_IMAGE_TEXT
  return (
    <div className="discord-card">
      <div className="dc-head">Playing a game</div>
      {activity ? (
        <>
          <div className="dc-body">
            <div className="dc-art" aria-hidden="true">
              {header.slice(0, 1).toUpperCase()}
              <span className="dc-badge" />
            </div>
            <div className="dc-lines">
              <div className="dc-name">{header}</div>
              {activity.details && <div className="dc-line">{activity.details}</div>}
              {activity.state && <div className="dc-line">{activity.state}</div>}
              {!!activity.timestamps && <div className="dc-line">12:34 elapsed</div>}
            </div>
          </div>
          {activity.buttons?.map((b) => (
            <div className="dc-button" key={b.url}>
              {b.label}
            </div>
          ))}
        </>
      ) : (
        <div className="dc-empty">
          Nothing at all - your profile shows no activity right now.
        </div>
      )}
    </div>
  )
}
