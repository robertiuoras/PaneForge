/**
 * "See the PC's screen": which viewer to start, pointed at which machine.
 *
 * The first cut of the feature is a button, not a stream. The PC already runs Sunshine
 * (a GPU-encoded desktop stream, ports 47984/47989 on the tailnet) and this Mac already
 * has Moonlight paired with it, so the shortest path to "the PC screen in one click" is
 * to start Moonlight on the peer PaneForge already knows. The in-app stream (PC PaneForge
 * captures, Mac PaneForge draws, zoom and pinch ours) is the next step and is designed in
 * docs/superpowers/specs/2026-09-23-pc-screen-design.md; this module is the part both
 * share: deciding WHO to look at and refusing out loud when there is nobody.
 *
 * Pure: the caller hands in the platform, whether a viewer binary exists, and the peer
 * list; scripts/screen-view-test.mjs asserts every branch without Electron.
 */

/** Sunshine's name for the whole desktop, the app Moonlight streams when asked for it. */
export const SCREEN_APP = 'Desktop'

export interface ScreenPeer {
  /** The paired device's id; absent only in tests that never open a pane. */
  id?: string
  name: string
  address: string
  status: 'off' | 'connecting' | 'online' | 'error'
}

export type ScreenPlan =
  | { ok: true; peer: ScreenPeer; args: string[] }
  | { ok: false; reason: 'no-viewer' | 'no-peer'; message: string }

/**
 * Where Moonlight lives on each platform. Absent = the button is not drawn: a control
 * that opens an install page is a control that does nothing when pressed in a hurry.
 */
export function moonlightCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') return ['/Applications/Moonlight.app/Contents/MacOS/Moonlight']
  if (platform === 'win32') {
    const out: string[] = []
    if (env.LOCALAPPDATA) out.push(`${env.LOCALAPPDATA}\\Programs\\Moonlight Game Streaming Project\\Moonlight.exe`)
    if (env.ProgramFiles) out.push(`${env.ProgramFiles}\\Moonlight Game Streaming Project\\Moonlight.exe`)
    return out
  }
  return ['/usr/bin/moonlight', '/usr/local/bin/moonlight']
}

/**
 * The machine to look at: the peer that is online, else the first one paired. Two
 * online peers would need a pick; this desk has one PC, so the first online wins and the
 * button's title names it, which is how a wrong guess gets noticed.
 */
export function screenPeer(peers: ScreenPeer[]): ScreenPeer | null {
  return peers.find((p) => p.status === 'online') ?? peers[0] ?? null
}

/** `moonlight stream <host> "<app>"` - the exact shape `Moonlight stream --help` prints. */
export function screenPlan(viewer: string | null, peers: ScreenPeer[]): ScreenPlan {
  if (!viewer) return { ok: false, reason: 'no-viewer', message: 'Moonlight is not installed on this machine.' }
  const peer = screenPeer(peers)
  if (!peer) return { ok: false, reason: 'no-peer', message: 'No other machine is paired with this one yet.' }
  return { ok: true, peer, args: ['stream', peer.address, SCREEN_APP] }
}

/** `Take control`'s title, in words for somebody who has never heard of Sunshine. */
export function screenTitle(peers: ScreenPeer[]): string {
  const peer = screenPeer(peers)
  return peer ? `Take control of ${peer.name}'s screen (opens Moonlight)` : 'See the other machine\'s screen'
}

/**
 * The quick button, v1: it opens the other machine's screen in a pane here, so it is drawn
 * whenever a machine is paired - Moonlight is only behind `Take control` now. A paired
 * machine that is not connected greys the button out with its status in the title,
 * and no pane opens: a pane that could only ever say "not connected" is noise.
 */
export function screenButton(peers: ScreenPeer[]): { ok: boolean; disabled: boolean; title: string } {
  const peer = screenPeer(peers)
  if (!peer) return { ok: false, disabled: true, title: 'No other machine is paired with this one yet.' }
  if (peer.status !== 'online') {
    const why = peer.status === 'connecting' ? 'connecting' : peer.status === 'error' ? 'could not connect' : 'not connected'
    return { ok: true, disabled: true, title: `${peer.name}'s screen - ${why} right now` }
  }
  return { ok: true, disabled: false, title: `See ${peer.name}'s screen` }
}
