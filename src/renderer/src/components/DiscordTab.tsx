import { useEffect, useState } from 'react'
import type { Config } from '@shared/types'
import {
  DEFAULT_DISCORD_STYLE,
  DEFAULT_LINK_LABEL,
  DEFAULT_LINK_URL,
  DISCORD_PRESETS,
  MAX_BUTTONS,
  NO_PRESENCE_STATUS,
  PRESENCE_IMAGE_TEXT,
  PRESET_ROWS,
  TOKEN_PHRASES,
  VISIBLE_ROWS,
  buildActivity,
  buildButtons,
  newRowId,
  pickLook,
  chosenRows,
  togglePhrase,
  visibleRows,
  withLook,
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
 * The Discord tab: what the profile says, and a picture of it while you choose.
 *
 * Its own file rather than another block inside `SettingsDialog.tsx` because the rows
 * editor is a list with its own state-free arithmetic, and because the preview is the
 * only place in the app deliberately drawn in ANOTHER product's colours - Discord's,
 * sampled from its own dark profile card. The rest of the app derives every colour from
 * the accent (`shared/theme.ts`); a replica that did the same would be a picture of
 * PaneForge, which is the one thing it must not be.
 *
 * The order is the order of the decisions: on or off, which look, the four things a look
 * may add, what that comes out as. Writing lines by hand is under Advanced, closed, because
 * it is the one part that needs the reader to know what a template is (Robert, 2026-09-27:
 * "make it a lot easier to edit and change in settings").
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
 * A desk that stands in for yours while you choose. Fixed numbers rather than the live
 * ones on purpose: the point of the preview is that a look can be judged with an empty
 * desk and no Discord open, and real counts of 0/0 would render every look as the same
 * nothing. Five of seven is the shape of the desk this tab was rebuilt for.
 */
const SAMPLE_BUSY: PresenceCounts = {
  running: 5,
  total: 7,
  names: ['PaneForge', 'Toolstash', 'Manic-s-Auction-House'],
  oldestRunSince: 0,
  asleep: 1,
  appStart: 0,
  tokensToday: 1_480_000,
  tokensWeek: 9_200_000
}
const SAMPLE_IDLE: PresenceCounts = {
  running: 0,
  total: 7,
  names: [],
  asleep: 2,
  appStart: 0,
  tokensToday: 1_480_000,
  tokensWeek: 9_200_000
}

const WHEN_OPTIONS: { value: RowWhen; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: 'running', label: 'Working' },
  { value: 'idle', label: 'Waiting' }
]

export default function DiscordTab({ config, onChange }: Props): JSX.Element {
  // Which half of the preview is on screen. The idle wording is the half nobody would
  // otherwise see until the desk went quiet, which is too late to change it.
  const [preview, setPreview] = useState<'busy' | 'idle'>('busy')
  const style = config.discordStyle
  const custom = style.preset === 'custom'
  // Controlled rather than left to the browser so picking "Your own lines" can open it.
  const [advanced, setAdvanced] = useState(false)
  const setStyle = (patch: Partial<DiscordStyle>): void =>
    onChange({ discordStyle: { ...style, ...patch } })
  const setLook = (patch: Partial<Pick<DiscordStyle, 'preset' | 'idle' | 'tokens'>>): void =>
    onChange({ discordStyle: withLook(style, patch) })
  // Any hand edit to a line makes the card the person's own: a look would otherwise
  // rebuild the lines on the next switch flip and throw the edit away.
  const setRows = (rows: DiscordRow[]): void => setStyle({ rows, preset: 'custom' })
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
  const [addingLine, setAddingLine] = useState(false)
  // On means a button actually reaches the card: one with a broken link is dropped before
  // sending, and a switch saying on over no button would be the old lie in a new place.
  const linkOn = buildButtons(style).length > 0
  // Turning it on brings back the first button only - a second one somebody switched off
  // stays off.
  const setLink = (on: boolean): void =>
    setButtons(
      on && !style.buttons.length
        ? [{ id: 'link', label: DEFAULT_LINK_LABEL, url: DEFAULT_LINK_URL, on: true }]
        : style.buttons.map((b, i) => (on ? (i === 0 ? { ...b, on } : b) : { ...b, on }))
    )

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
        label="Show what your chats are doing on Discord"
        hint="Puts a short line on your Discord profile saying how many chats are working. Numbers only, unless you pick the look with project names - never a word of what a chat says. Needs the Discord app open. Your other computer, if it is linked to this one, uses the same choices and is counted too."
      />

      {config.discordPresence && (
        <>
          <DiscordStatus />

          <div className="setting">
            <label>Look</label>
            <div className="look-cards" role="radiogroup" aria-label="Look">
              {DISCORD_PRESETS.map((p) => (
                <LookCard
                  key={p.id}
                  name={p.label}
                  hint={p.hint}
                  sample={visibleRows(SAMPLE_BUSY, withLook(style, { preset: p.id }))}
                  on={style.preset === p.id}
                  onPick={() => onChange({ discordStyle: pickLook(style, p.id) })}
                />
              ))}
              <LookCard
                name="Your own lines"
                hint={
                  custom
                    ? 'Written by hand under Advanced. Pick another look and they wait here for when you come back.'
                    : 'Start from the look you have now and change the words yourself, under Advanced.'
                }
                sample={custom ? visibleRows(SAMPLE_BUSY, style) : []}
                on={custom}
                onPick={() => {
                  if (!custom) onChange({ discordStyle: pickLook(style, 'custom') })
                  setAdvanced(true)
                }}
              />
            </div>
          </div>

          {custom && (
            <div className="hint">
              Your own lines decide what the card says, so the switches for waiting chats and
              tokens are put away. Pick one of the other looks to get them back.
            </div>
          )}
          <div className="switches">
            {!custom && (
              <Switch
                checked={style.idle}
                onChange={(v) => setLook({ idle: v })}
                label="Say how many are waiting"
                hint={'Adds how many chats are waiting beside the ones working: "5 running · 2 idle" rather than "5 running".'}
              />
            )}
            <Switch
              checked={style.elapsed}
              onChange={(v) => setStyle({ elapsed: v })}
              label="Show how long it has been going"
              hint="A clock under the lines, counting from the chat that has been working longest - or from when PaneForge opened, while every chat is waiting."
            />
            {!custom && (
              <Switch
                checked={style.tokens}
                onChange={(v) => setLook({ tokens: v })}
                label="Show tokens used today"
                hint="How much every agent on your computers has used since midnight, from the logs Claude Code and Codex already keep."
              />
            )}
            <Switch
              checked={linkOn}
              onChange={setLink}
              label="Show the link button"
              hint="A button under the card that opens the PaneForge page. Discord shows it to everyone except you, so your own profile will not have it."
            />
          </div>

          <div className="setting">
            <div className="setting-row">
              <label>What other people see</label>
              <Segmented
                value={preview}
                onChange={(v) => setPreview(v as 'busy' | 'idle')}
                options={[
                  { value: 'busy', label: 'Chats working' },
                  { value: 'idle', label: 'All waiting' }
                ]}
              />
            </div>
            <DiscordPreview style={style} counts={counts} />
            <div className="hint dim">
              Made-up numbers - five of seven chats working - so you can judge a look with
              nothing open. A change reaches Discord within fifteen seconds.
            </div>
          </div>

          <details
            className="discord-advanced"
            open={advanced}
            onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>Advanced: write your own lines</summary>
            <div className="da-body">
              <div className="setting">
                <div className="setting-row">
                  <label>Lines</label>
                  <button className="ghost small" onClick={() => setAddingLine((v) => !v)}>
                    {addingLine ? 'Never mind' : 'Add a line'}
                  </button>
                </div>
                <div className="hint">
                  Discord draws two lines and no more, so the first two that have something to
                  say are the ones on the card. Move a line up to put it on top, switch one off
                  to hand its place to the one under it. A line whose words come out empty -
                  "on {'{projects}'}" with nothing running - takes no space either. Changing a
                  line here makes the look "Your own lines".
                </div>
                {addingLine && (
                  <div className="pickrow discord-presets">
                    {PRESET_ROWS.map((preset) => (
                      <button
                        key={preset.label}
                        className="chip pick"
                        onClick={() => {
                          setRows([
                            ...style.rows,
                            { id: newRowId(style.rows), text: preset.text, when: preset.when, on: true }
                          ])
                          setAddingLine(false)
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <button
                      className="chip pick"
                      onClick={() => {
                        setRows([
                          ...style.rows,
                          { id: newRowId(style.rows), text: '', when: 'always', on: true }
                        ])
                        setAddingLine(false)
                      }}
                    >
                      Blank line to write myself
                    </button>
                  </div>
                )}
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
                        <div className="pickrow discord-chips">
                          {TOKEN_PHRASES.map((t) => {
                            const kept = rowHasPhrase(row.text, t.phrase)
                            return (
                              <button
                                key={t.token}
                                className={'chip pick' + (kept ? ' on' : '')}
                                title={
                                  kept
                                    ? `Remove ${t.label.toLowerCase()} from this line`
                                    : `Add ${t.label.toLowerCase()} to this line`
                                }
                                onClick={() => patchRow(i, { text: togglePhrase(row.text, t.phrase) })}
                              >
                                {t.label}
                              </button>
                            )
                          })}
                        </div>
                        <div className="hint dim">
                          {!row.on
                            ? 'Switched off - nothing on the card.'
                            : !text
                              ? 'Empty, so it takes no room on the card.'
                              : drawn >= 0
                                ? `On the card now, as line ${drawn + 1}.`
                                : `Not on the card right now - ${
                                    row.when === 'running'
                                      ? 'this one only shows while a chat is working.'
                                      : row.when === 'idle'
                                        ? 'this one only shows while every chat is waiting.'
                                        : `Discord only draws ${VISIBLE_ROWS} lines and two above it got there first.`
                                  }`}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="hint">
                  The buttons on each line build the wording for you - click one to add that
                  bit, click it again to take it back out. The box itself still works if you
                  want to type your own words around them, but nothing here needs it. Discord
                  cuts a line off past 128 characters, so a long project list drops its tail
                  for a "+2 more" rather than being chopped mid-word.
                </div>
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
                  Discord draws the lines as plain text, so a link written into one is not
                  clickable. A button is the only clickable thing a Discord profile card has,
                  and it takes two of them.
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
                      Must start with http:// or https:// - Discord throws the whole card away
                      over a broken link, not just the button. Text is cut at 32 characters.
                    </div>
                  </div>
                ))}
              </div>

              <div className="setting">
                <button
                  className="ghost small"
                  onClick={() => onChange({ discordStyle: cloneStyle(DEFAULT_DISCORD_STYLE) })}
                >
                  Reset to default
                </button>
              </div>
            </div>
          </details>
        </>
      )}
    </>
  )
}

/**
 * One look to pick, with the line it would put on the card under its name - the words
 * themselves, because "Out of all" means nothing until you read "5/7 sessions running".
 * A radio, not a button: exactly one is on, and arrow-key users get told which.
 */
function LookCard({
  name,
  hint,
  sample,
  on,
  onPick
}: {
  name: string
  hint: string
  sample: string[]
  on: boolean
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={'look-card' + (on ? ' on' : '')}
      onClick={onPick}
    >
      <span className="lc-top">
        <span className="lc-dot" aria-hidden="true" />
        <span className="lc-name">{name}</span>
      </span>
      {sample.length > 0 && (
        <span className="lc-sample">
          {sample.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      )}
      <span className="lc-hint">{hint}</span>
    </button>
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

/** Whether a line's own words already include a chip's phrase - so the chip can show as pressed. */
function rowHasPhrase(text: string, phrase: string): boolean {
  return text
    .split(' · ')
    .map((p) => p.trim())
    .includes(phrase)
}

/**
 * What Discord itself last said, rather than what the app meant to send.
 *
 * Every other answer here is a guess dressed up as a fact. This one answers the question
 * anyone actually asks, which is "is this on my profile" - down to the two lines Discord
 * stored, as it echoed them back. The last line closes the rest of it: everything up to
 * Discord can be right and other people can still see nothing, because hiding it is
 * Discord's own switch and no application can read or change it.
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
      {status.countedBy ? (
        <div className="hint">
          Your Discord profile is showing {status.countedBy}&apos;s count, which already
          includes the chats on this computer, so this computer stays quiet.
        </div>
      ) : !status.connected ? (
        <div className="hint">
          No Discord to talk to. PaneForge looks for it again every minute, so starting
          Discord is enough - nothing here needs touching.
        </div>
      ) : status.error ? (
        <div className="hint warn">Discord refused the last card: {status.error}</div>
      ) : status.cleared ? (
        <div className="hint">
          Connected{status.user ? <> as <b>{status.user}</b></> : null} - and told Discord to
          show nothing, because no chat is open.
        </div>
      ) : status.acceptedAt ? (
        <div className="hint">
          Discord accepted this at <b>{at}</b>
          {status.user ? <> for <b>{status.user}</b></> : null}
          {status.appName ? <>, under <b>{status.appName}</b></> : null}
          {status.lines.length ? (
            <>
              {' '}
              - your profile says <b className="discord-said">{status.lines.join(' / ')}</b>
            </>
          ) : null}
          .
        </div>
      ) : (
        <div className="hint">Connected to Discord, waiting to send the first card.</div>
      )}
      <div className="hint dim">
        Nobody can see it? That is not something this app can tell you, and if the line
        above says accepted, it is one of Discord&apos;s own switches: Discord → Settings →
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
