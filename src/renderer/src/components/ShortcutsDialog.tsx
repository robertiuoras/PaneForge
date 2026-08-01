// Every key the app answers to, and what the words on screen mean, in one place. The way
// back to it is the first thing on the list: a help sheet you can only find by already
// knowing its shortcut is furniture.
//
// The Guide half exists because the shortcut list answers "which key" and nothing else.
// People do not get stuck on which key opens the grid; they get stuck on what a lane is,
// why a pane is suddenly running in a folder with a -w2 on the end, and whether a release
// is going to interrupt them. Those questions had no answer anywhere in the app - the
// nearest thing was a tooltip on a chip you had to already know to hover.

import { useMemo, useState } from 'react'
import { Segmented } from './Controls'
import MicIcon from './MicIcon'
// The rows below are written with Ctrl because that is what Windows and Linux use; on a
// Mac the same shortcuts are on Cmd, so every key is printed through `keyLabel`.
import { keyLabel, MOD } from '../platform'

interface Props {
  onClose: () => void
}

/** The one that opens this list. Kept out of KEYS so it can lead, highlighted. */
const HELP_KEY: [string, string] = [
  'F1  or  Ctrl /',
  'This list, from anywhere - also the ? button next to the gear'
]

/** key, what it does, and whether the row is called out rather than merely listed. */
type Key = [string, string, boolean?]

const KEYS: Key[] = [
  ['Ctrl K', 'Command palette: jump to a session, start a project, run any action'],
  ['Ctrl T', 'New session (tick several projects to start them together)'],
  ['Ctrl W', 'Close the focused session'],
  ['Ctrl Shift R', 'Restart the focused agent in place'],
  ['Ctrl Shift L', 'Fix the display: refit and repaint the pane without losing the run'],
  [
    'Ctrl Shift I',
    'Improve the prompt you are typing - a suggestion you read and accept, never sent for you'
  ],
  ['Ctrl Shift A', 'Switch the focused pane to the next installed AI (Claude, Codex, ...)'],
  ['Ctrl G', 'Toggle grid view (every session at once)'],
  ['Ctrl Shift G', 'Cycle the grid: tiled, columns, rows, one big on the left, one big on top'],
  ['Ctrl Shift Z', 'Zoom the focused pane to the whole window and back - the grid is untouched'],
  [
    'Ctrl Shift ← →',
    'Move the focused pane one slot along the grid - it swaps places, nothing else shifts'
  ],
  [
    'Ctrl Shift Y',
    'Type into every pane at once: every keystroke, including Ctrl+C and arrows. The panes are ringed in amber while it is on',
    true
  ],
  [
    'Ctrl F',
    'Find in this pane: every match highlighted, Enter for the next, Shift Enter for the one before, Escape to close',
    true
  ],
  [
    'Ctrl Shift U',
    'Copy from this pane with the keyboard: hjkl or arrows to move, w b e by word, v to start a selection, y to copy it, Escape to leave',
    true
  ],
  ['Ctrl 1 - 9', 'Jump to that session'],
  ['Ctrl Tab', 'Next session'],
  ['Ctrl Shift Tab', 'Previous session'],
  ['Ctrl + / Ctrl -', 'Terminal font bigger / smaller'],
  ['Ctrl C', 'Copy the selection; with nothing selected it interrupts the agent as usual'],
  ['Ctrl Shift C', 'Always copy, never interrupt'],
  ['Ctrl V', 'Paste (images go to the agent untouched)'],
  // Called out: "how do I open the Stash" is the question this dialog gets asked for
  // most, and there are two answers depending on which window you are in.
  [
    'Ctrl Shift V',
    'Open the Stash inside the app: click text, a screenshot or a stashed file into the focused pane',
    true
  ],
  [
    'Ctrl Alt V',
    'Open the floating Stash from ANY app: click a line to copy it back, → sends it to the pane, ✕ forgets it',
    true
  ],
  [
    'Hover the Stash pill',
    'Also opens the list; it closes itself a few seconds after the pointer leaves (Stash ⚙ sets how long)'
  ],
  ['Drop a file on the Stash', 'Parks a copy you can drag straight back out into any other app'],
  ['Drag the Stash title', 'Move the Stash anywhere; double-click it to put it back'],
  ['Right-click', 'Copy the selection, or paste when nothing is selected'],
  ['Drag files onto a pane', 'Types their paths at the prompt, ready to describe'],
  ['Drag a pane by its title', 'In the grid: moves it, and the gap it will drop into lights up'],
  ['Drag the edge between panes', 'In the grid: makes one bigger and its neighbour smaller'],
  ['Double-click that edge', 'Puts that row or column back to the layout’s own shares'],
  ['Ctrl Shift S', 'Swarm: one mission, one pane per role'],
  ['Ctrl Shift K', 'Tasks and shared memory for the focused folder'],
  ['Ctrl H', 'Search every past session'],
  ['Ctrl Shift D', 'Devices: another machine’s panes, in this window'],
  // Called out: the mic is the one control here people ask where to find, and the key
  // is faster than the button it points at.
  [
    'Ctrl Shift Space',
    'Talk to the agent: dictate into the focused pane. Press once to start, again to transcribe - same as the mic button floating over the prompt box at the bottom-left of the pane',
    true
  ],
  ['Ctrl ,', 'Settings'],
  ['F12', 'Developer tools'],
  ['Double-click a title', 'Rename that session']
]

/**
 * A topic in the Guide.
 *
 * `find` is only there so the filter can match words a reader would type that the prose
 * does not happen to contain ("worktree", "conflict", "merge"). Nothing shows it.
 */
type Topic = { title: string; find?: string; body: JSX.Element }

const TOPICS: Topic[] = [
  {
    title: 'Panes, and the agent in one',
    find: 'session pane agent claude codex terminal restart',
    body: (
      <>
        <p>
          A <b>pane</b> is one terminal running one AI agent in one folder. {MOD} T starts one;
          the list on the left is all of them. A pane keeps running whether or not you are
          looking at it, so an agent working through something long does not need the window.
        </p>
        <p>
          The dot on a card is what that agent is doing: working, waiting for you, or finished.
          {MOD} Shift R restarts the agent without losing the pane or the folder it is in, and
          {MOD} Shift A swaps it for another AI you have installed.
        </p>
      </>
    )
  },
  {
    title: 'Lanes: why a second pane opens in a folder ending -w2',
    find: 'lane worktree w2 w3 branch checkout same project twice conflict',
    body: (
      <>
        <p>
          Open a second pane on a folder you already have open and the two agents fight: the
          same files, the same git index, the same dev-server port. One saves over the other
          halfway through the other&apos;s edit, and neither of them knows.
        </p>
        <p>
          So the second pane gets a <b>lane</b> — its own checkout of that repository in a
          folder beside the first (<code>myapp-w2</code>), on its own branch, with its own
          port. The first pane keeps the original folder. That is the whole idea: two chats in
          one project, each with a copy that only it writes to.
        </p>
        <p>
          The <b>w2</b> or <b>w3</b> chip on a pane&apos;s card is the lane it was given. You
          never make one and never clean one up. It is an ordinary git worktree, so you commit
          in it and merge it like any other branch — and once you have, PaneForge deletes the
          folder and the branch by itself and puts the pane&apos;s card back on the project.
        </p>
        <p>
          Click the chip to see what is in the lane and to merge it back without leaving the
          window. It only ever removes a lane it made (<code>-a</code> on a{' '}
          <code>lane-a</code> branch)
          that has nothing uncommitted in it, no untracked files, no pane open on it, and no
          commit the project does not already have. Anything else keeps its folder — including
          a lane whose several commits were squashed into one, which cannot be told apart from
          unmerged work. So a folder that is still there is a folder with something in it.
        </p>
        <p>
          Two panes in the same project still need the same care two people would: they will
          both change the same file eventually, and git will say so when the branches meet.
          A lane stops them corrupting each other&apos;s working copy, not from disagreeing.
        </p>
      </>
    )
  },
  {
    title: 'PF lanes: PaneForge building itself',
    find: 'pf lane stuck release conflict resolver adopt master ready',
    body: (
      <>
        <p>
          Only on a machine with a PaneForge checkout. Several chats improve PaneForge at
          once, each holding one <b>PF lane</b> — a numbered copy of the repository, claimed
          when the chat starts and given back when it ends. It shares the word &quot;lane&quot;
          with the chip above and is otherwise unrelated: a pane can carry both at once, and a
          PF lane says nothing about the folder the pane is open in.
        </p>
        <p>
          When a chat finishes, its lane is merged and released together with every other
          finished lane — one version, not one per chat. <b>Stuck</b> means a lane&apos;s
          finished work will not merge into master, so every release is leaving it out. That
          used to be invisible and one sat unnoticed for a day, which is why it is on screen
          now.
        </p>
        <p>
          A stuck lane is retried by itself every few minutes and most clear on their own, as
          soon as master stops disagreeing — including when the chat that made the mess has
          gone and left uncommitted files in there. The ones that need real editing are handed
          to a free pane automatically, and the <b>fix</b> button hands one over now instead of
          waiting. A lane held by a chat you have open is shown on that pane&apos;s card; the
          &quot;Lanes elsewhere&quot; list is only the ones no open pane accounts for, so on an
          ordinary day it is not on screen at all.
        </p>
      </>
    )
  },
  {
    title: 'The grid',
    find: 'grid tile layout arrange move resize drag split ctrl g',
    body: (
      <>
        <p>
          {MOD} G shows every pane at once instead of one at a time. Typing still goes to the
          focused pane only — the one with the lit border — so a grid of eight agents is safe
          to leave up.
        </p>
        <p>
          Drag a pane by its title bar to move it: the gap it would drop into lights up as you
          go, and the panes shuffle round it. Drag the edge between two panes to give one more
          room and the other less; double-click that edge to put the row back to equal shares.
          The layout is remembered per session count, so the arrangement you set for four
          panes comes back the next time you have four.
        </p>
      </>
    )
  },
  {
    title: 'Scrollback, and getting back to the prompt',
    find: 'scroll scrollback bottom newest prompt wheel',
    body: (
      <>
        <p>
          Scrolling up in a pane stops it following new output, so an agent that keeps writing
          cannot yank the line you are reading off the screen. The <b>↓ Newest</b> button
          appears while you are behind; clicking it, or scrolling back to the bottom, starts
          following again.
        </p>
        <p>
          Clicking a <b>tag</b> in the scrollback jumps to that point in the run. Pressing a
          key always returns to the bottom first, so you never type into history.
        </p>
      </>
    )
  },
  {
    title: 'The Stash',
    find: 'stash clipboard paste screenshot file drop shelf ctrl shift v',
    body: (
      <>
        <p>
          A shelf for things you want to hand to an agent. {MOD} Shift V opens it over the
          window; {keyLabel('Ctrl Alt V')} opens the floating one, which works from any other app. Click a
          line to put it back on the clipboard, → to send it straight into the focused pane, ✕
          to forget it.
        </p>
        <p>
          Drop a file on it to park a copy you can drag back out anywhere later. Screenshots
          and images go to the agent as images, not as file paths.
        </p>
      </>
    )
  },
  {
    title: 'Swarm',
    find: 'swarm mission roles parallel many agents ctrl shift s',
    body: (
      <p>
        {MOD} Shift S takes one mission and opens a pane per role, each with its own brief, all
        in the same project. Use it when a job splits cleanly into parts that do not need to
        watch each other. When they do need to share a project folder, they get lanes, as
        above.
      </p>
    )
  },
  {
    title: 'Tasks and shared memory',
    find: 'board tasks memory notes ctrl shift k',
    body: (
      <p>
        {MOD} Shift K opens the board for the focused pane&apos;s folder: a task list and a
        notes file that every agent working in that folder can read and write. It is how two
        panes in one project agree on what is done without you relaying it.
      </p>
    )
  },
  {
    title: 'Devices',
    find: 'remote device another machine mac pc ctrl shift d',
    body: (
      <p>
        {MOD} Shift D brings another machine&apos;s panes into this window, so a run started on
        the desktop can be read and typed into from the laptop. The agent keeps running on the
        machine it started on.
      </p>
    )
  },
  {
    title: 'Voice',
    find: 'voice mic dictate speak whisper transcribe',
    body: (
      <p>
        {MOD} Shift Space, or the mic floating at the bottom-left of a pane, dictates into the
        prompt. Press once to start, again to transcribe. Nothing is sent anywhere until you
        press it, and the text lands in the prompt box for you to edit before it goes.
      </p>
    )
  },
  {
    title: 'Updates',
    find: 'update version release restart install upgrade',
    body: (
      <p>
        New versions install when you quit, not while you are working, so an update never
        interrupts a run and there is nothing to accept. The version in the corner is what you
        are running now; if a newer one is waiting, it says so and it will be there next time
        you open the app.
      </p>
    )
  }
]

export default function ShortcutsDialog({ onClose }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'keys' | 'guide'>('keys')
  const needle = q.trim().toLowerCase()

  const keyRows = useMemo(
    () => (needle ? KEYS.filter(([k, what]) => (k + ' ' + what).toLowerCase().includes(needle)) : KEYS),
    [needle]
  )
  // Searching the prose means searching rendered elements, so each topic carries the words
  // it should be findable by instead. `find` covers the ones a reader would type that the
  // text does not contain - "worktree", "conflict" - and the title covers the rest.
  const topics = useMemo(
    () => (needle ? TOPICS.filter((t) => (t.title + ' ' + (t.find ?? '')).toLowerCase().includes(needle)) : TOPICS),
    [needle]
  )

  // While filtering, both halves are shown together: someone typing "lane" wants the
  // explanation and would not think to look for a tab first.
  const showKeys = !needle ? tab === 'keys' : keyRows.length > 0
  const showGuide = !needle ? tab === 'guide' : topics.length > 0

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>Help</strong>
          <span className="hint">Esc closes</span>
        </div>
        <div className="key-row lead">
          <span className="kbd-box">{keyLabel(HELP_KEY[0])}</span>
          <span>{HELP_KEY[1]}</span>
        </div>
        {!needle && (
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as 'keys' | 'guide')}
            options={[
              { value: 'keys', label: 'Keyboard' },
              { value: 'guide', label: 'Guide' }
            ]}
          />
        )}
        <input
          className="key-filter"
          autoFocus
          placeholder="Filter - type what you want to do, or what a word means"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="keys">
          {showKeys &&
            keyRows.map(([k, what, hot]) => (
              <div className={'key-row' + (hot ? ' hot' : '')} key={k}>
                <span className="kbd-box">{keyLabel(k)}</span>
                <span>
                  {what}
                  {hot && <MicIcon size={12} />}
                </span>
              </div>
            ))}
          {showGuide &&
            topics.map((t) => (
              <section className="guide-topic" key={t.title}>
                <h4>{t.title}</h4>
                {t.body}
              </section>
            ))}
          {!showKeys && !showGuide && <div className="hint">Nothing matches &quot;{q}&quot;.</div>}
        </div>
        <div className="dialog-row">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
