// The two rules about a peer list that are worth asserting on their own.
//
// A device can be told to pair with any address, and one of the addresses it can reach is
// itself - a tailnet IP, a LAN IP, `localhost`. That pairing succeeds: the handshake is
// with a real PaneForge holding the right code. What follows is silent and confusing
// rather than broken: every local pane comes back mirrored under `@<self>/<id>`, so the
// sidebar lists the same work twice, one copy of which cannot be improved, resized or
// handed off because the app believes it belongs to another machine.
//
// Measured on this desk's PC, whose config held `peers: [{ id: <its own id>, address:
// <its own tailnet address> }]` - which is why "why does my desktop have two sessions of
// the same thing" was every session, not one.
//
// Pure, and separate from the class, so scripts/remote-test.mjs can assert both without
// an Electron app around them.

import type { RemotePeer } from '../../shared/types'

/** Is this the machine we are running on, rather than another one? */
export function isSelfPeer(peerId: string, myId: string): boolean {
  return Boolean(peerId) && peerId === myId
}

/** The peer list with any pairing to this device taken out of it. */
export function dropSelf<T extends { id: string }>(peers: T[], myId: string): T[] {
  return peers.filter((p) => !isSelfPeer(p.id, myId))
}

/** Ids this device mirrors from a peer, kept to the panes that peer still has. */
export function liveWatch(peer: Pick<RemotePeer, 'watch'>, panes: { id: string }[]): string[] {
  const live = new Set(panes.map((p) => p.id))
  return (peer.watch ?? []).filter((id) => live.has(id))
}

/**
 * Is this device taking pairing requests?
 *
 * One field, and it used to be read two different ways: the state the switch draws itself
 * from asked `pairByAsking !== false`, while the guard that answers a request asked
 * `!pairByAsking`. `getConfig` is a SHALLOW merge - a `remote` block written before this
 * feature shipped carries no such key at all - so on every existing install the field was
 * `undefined`, the switch rendered ON, and every ask was refused instantly with "Refused
 * on that device". Measured 2026-08-23 between this desk's PC and Mac.
 *
 * An absent field means the default, and the default is on. Both callers ask here now, so
 * they cannot disagree again.
 */
export function pairAskingOn(remote: { pairByAsking?: boolean }): boolean {
  return remote.pairByAsking !== false
}
