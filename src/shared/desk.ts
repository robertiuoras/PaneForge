// Every pane on the desk, this machine's and every paired machine's, as one list.
//
// A pane on the other machine used to be invisible in this window until somebody picked
// it for mirroring in Devices - so "is anything running over there" was a question you
// had to go and ask, which is no way to watch a machine that is meant to be doing the
// work. Everything needed to answer it already crosses the link: `RemotePaneInfo` rides
// the `remote:changed` message that is sent whenever anything over there moves.
//
// **Listing is not mirroring, and that split is the whole design.** LISTING a remote pane
// costs a few fields in a message already being sent; MIRRORING one costs a live byte
// stream and an xterm buffer on this machine, per pane. So every pane is listed and none
// is mirrored until it is opened - which is what makes a desk showing fifty of the PC's
// panes cost what showing none of them used to.
//
// The arithmetic is here rather than in the component for the same reason `fleet.ts` and
// `place.ts` are: it is a pile of small judgements (which device counts, which pane is
// already in the list, what ranks a question that cannot be answered from here) and every
// one of them is worth pinning without a window. `npm run test:desk`.

import type { FleetPane, FleetSection } from './fleet'
import { fleetSections } from './fleet'
import type { RemotePaneInfo, RemotePeerState, Session } from './types'

/**
 * One row of the sessions list.
 *
 * Either a pane on this desk (`session`), or one merely LISTED from a paired device
 * (`listed`). It carries the fields `fleet.ts` reads flat, so both kinds sort into the
 * same sections by the same rules and the list cannot disagree with itself about which
 * pane wants a person.
 */
export interface DeskRow extends FleetPane {
  /** React key, and the id `fleetOrder` sorts on. Never a session id for a listed pane. */
  key: string
  /** Ctrl+N. 0 for a listed pane - there is nothing on this machine to switch to yet. */
  number: number
  session?: Session
  listed?: { pane: RemotePaneInfo; device: { id: string; name: string } }
  /**
   * When the desk that OWNS this pane will close it for being idle, epoch ms.
   *
   * Forwarded from whichever machine holds the pty, exactly like `job`: this desk does not
   * close another device's pane and cannot know its settings, so a listed row draws the
   * far end's own number or nothing at all.
   */
  closingAt?: number
}

export interface DeskGroup {
  key: string
  /** empty in the arranged view, which draws no headings */
  title: string
  rows: DeskRow[]
}

function fromSession(s: Session, number: number): DeskRow {
  return {
    key: s.id,
    number,
    session: s,
    status: s.status,
    bell: s.bell,
    stalledSince: s.stalledSince,
    engaged: s.engaged,
    runSince: s.runSince,
    lastOutput: s.lastOutput,
    createdAt: s.createdAt,
    exitCode: s.exitCode,
    job: s.job,
    closingAt: s.closingAt
  }
}

function fromListed(pane: RemotePaneInfo, device: { id: string; name: string }): DeskRow {
  return {
    key: `${device.id}:${pane.id}`,
    number: 0,
    listed: { pane, device },
    status: pane.status,
    // A question over there cannot be ANSWERED from a row - the buttons need the frame
    // the chooser was read off, which needs a mirror - but it is the loudest reason to
    // open one, so it ranks the row exactly as a local question does.
    bell: pane.bell || pane.asking,
    stalledSince: pane.stalledSince,
    engaged: pane.engaged,
    runSince: pane.runSince,
    lastOutput: pane.lastOutput,
    createdAt: pane.createdAt,
    exitCode: pane.exitCode,
    job: pane.job,
    closingAt: pane.closingAt
  }
}

/**
 * @param all every session in this window, in the order the sidebar numbers them - the
 *   pane NUMBER is Ctrl+N and must come from that list, never from this screen's order.
 * @param shown the same list after the device filter, which is visual only.
 */
export function deskRows(
  all: Session[],
  shown: Session[],
  peers: RemotePeerState[],
  deviceFilter: string
): DeskRow[] {
  const number = new Map(all.map((s, i) => [s.id, i + 1]))
  const rows = shown.map((s) => fromSession(s, number.get(s.id) ?? 0))
  if (deviceFilter === 'local') return rows
  for (const peer of peers) {
    // A device that is off or reconnecting is reporting a pane list from before it went,
    // and drawing that as live work is worse than drawing nothing at all.
    if (peer.status !== 'online') continue
    if (deviceFilter !== 'all' && deviceFilter !== peer.id) continue
    for (const pane of peer.panes) {
      // A mirrored pane is already in the list above, as a session like any other. Both
      // halves are true at once for a beat while a mirror attaches, and a pane drawn
      // twice - once live, once as an invitation to open it - is the bug this prevents.
      if (pane.watched) continue
      rows.push(fromListed(pane, { id: peer.id, name: peer.name }))
    }
  }
  return rows
}

/**
 * The list either grouped by who needs a person, or left in the order it was arranged.
 *
 * Grouped is the default and is what replaced the Fleet dialog: that screen's whole value
 * was "sorted by whoever needs you first", and it was a screen you had to remember to
 * open. The arranged view draws ONE group with no title, so the sidebar renders both
 * shapes through the same loop rather than branching around the headings.
 */
export function deskGroups(rows: DeskRow[], byState: boolean): DeskGroup[] {
  if (!byState) return [{ key: 'arranged', title: '', rows }]
  return (fleetSections(rows.map((r) => ({ ...r, id: r.key }))) as FleetSection<DeskRow & { id: string }>[]).map(
    (sec) => ({ key: sec.key, title: sec.title, rows: sec.sessions as DeskRow[] })
  )
}
