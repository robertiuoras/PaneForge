/**
 * Noticing that a signed-in phone has stopped being the phone that was approved.
 *
 * A device token here is deliberately long-lived - ten years - because the alternative was
 * measured and it was worse: a cookie that expires is a cookie a phone loses, and a phone
 * that loses it has to be re-approved by somebody standing at the desk, which is the exact
 * manual step the whole feature exists to delete. So the answer to "the cookie lasts a long
 * time" is not a shorter cookie. It is that a stolen one should be VISIBLE.
 *
 * Two rules run this file, and both are about not crying wolf:
 *
 * - **Nothing here ever refuses a request.** A watcher that signs a device out on suspicion
 *   locks Robert out of his own desk from a train, which is the failure that made the
 *   feature not worth having. It marks the row; the revoke is `Sign out`, by hand, by name.
 * - **A signal that fires on ordinary life is not a signal.** A phone leaving the house and
 *   coming back over the tunnel changes its address and its origin every single day, so
 *   "the place changed" is recorded and never alarmed on. What is left is the two things a
 *   phone does not do by itself: change into a different browser, and be in two places at
 *   the same moment.
 */

import { deviceKind, type Origin } from './net'

/** The two things that mean the token is somewhere it should not be. */
export type DeviceMarkKind = 'browser-changed' | 'two-places'

/** What was noticed, kept on the device so the panel can say it and he can act on it. */
export interface DeviceMark {
  kind: DeviceMarkKind
  /** ms epoch it was noticed */
  at: number
  /** what the row looked like before */
  was: string
  /** what just arrived */
  now: string
  /** one sentence, written for somebody deciding whether to press Sign out */
  words: string
}

/** One arrival: a request or a stream opening, carrying this device's cookie. */
export interface Arrival {
  address: string
  origin: Origin
  ua: string
  at: number
}

/** What the desk already knows about the device that cookie belongs to. */
export interface KnownDevice {
  kind: string
  address: string
  origin: Origin
  ua?: string
}

/**
 * A user-agent with every version number taken out of it.
 *
 * Compared coarsely on purpose. Browsers rewrite their version string on their own every
 * few weeks and an iOS upgrade rewrites the OS number too, so a strict comparison would
 * mark every phone in the house the morning after an update - and a mark that appears for
 * everybody is one nobody reads. What survives a version bump, and does not survive the
 * cookie being carried to another machine, is the shape: the platform and the engine.
 */
export function uaShape(ua: string): string {
  return ua
    .toLowerCase()
    .replace(/[\d]+(?:[._][\d]+)*/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
}

/**
 * Did this arrival come from a different browser than the one that was approved?
 *
 * An empty stored shape is not a difference - it is a row written before this existed, or a
 * device approved through a path that never saw a user-agent. Silence beats a guess.
 */
export function browserChanged(known: KnownDevice, now: Arrival): boolean {
  const was = uaShape(known.ua ?? '')
  const got = uaShape(now.ua)
  if (!was || !got) return false
  return was !== got
}

/**
 * The mark for one arrival, or null when there is nothing to say.
 *
 * `elsewhere` is the origins of this same device's OTHER live streams at this moment. One
 * browser holds one stream, so two streams under one token are two browsers - and if they
 * are in different places, the token has been copied. Two streams from the same place are
 * left alone: that is a phone whose page was reloaded, or two tabs.
 */
export function markFor(
  known: KnownDevice,
  now: Arrival,
  elsewhere: readonly Origin[] = []
): DeviceMark | null {
  if (browserChanged(known, now)) {
    return {
      kind: 'browser-changed',
      at: now.at,
      was: known.kind,
      now: now.ua ? kindWords(now.ua) : 'another browser',
      words:
        `Signed in from a different browser than the one that was approved ` +
        `(${known.kind}, now ${now.ua ? kindWords(now.ua) : 'another browser'}). ` +
        `If that was not you, sign it out.`
    }
  }
  const other = elsewhere.find((o) => o !== now.origin)
  if (other) {
    return {
      kind: 'two-places',
      at: now.at,
      was: other,
      now: now.origin,
      words:
        `Watching from two places at once (${other} and ${now.origin}). ` +
        `One sign-in is one browser, so the cookie has been copied. Sign it out.`
    }
  }
  return null
}

/**
 * The make of a device out of its user-agent, in the same words the list already uses.
 *
 * Taken from `deviceKind` in `net.ts` by IMPORT rather than by copy - the panel and this
 * file printing two different names for one phone is exactly the sort of disagreement that
 * makes somebody distrust the mark and stop reading it.
 */
function kindWords(ua: string): string {
  return deviceKind(ua)
}
