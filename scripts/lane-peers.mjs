/**
 * Lanes, across two machines.
 *
 * The lane ledger is `<repo>/.git/paneforge-lanes.json` - inside the local `.git`, never
 * pushed and never fetched. That is right for almost all of it: a letter lane is a
 * worktree on a branch (`lane-a`) that is local scratch and is never pushed either, so
 * this desk's `lane-a` and the other desk's `lane-a` are two unrelated branches in two
 * unrelated folders. They cannot collide, and coordinating them would cost a network
 * round trip to prevent nothing.
 *
 * Exactly two things DO collide, and both of them are the trunk:
 *
 *   - `main` is not a lane like the others. It is the repository itself, on the branch
 *     everybody shares, so two devices holding it are two chats committing and pushing
 *     `origin/<branch>` with neither ledger able to see the other. That is the real
 *     report: an assistant chat on the Mac and an assistant chat on the PC, both handed
 *     `main`, both editing the same branch.
 *   - A release. Two devices cutting a version at the same moment is two tags, two
 *     GitHub releases and the one-legged feed this repo has already shipped once.
 *
 * So the claim published here is not the ledger. It is those two facts and nothing else.
 *
 * **The claim is carried by the ref NAME, and the ref points at a commit origin already
 * has.** Reading every device's claim is then one `git ls-remote`, with no fetch and not
 * one object transferred - which matters because this sits in front of a lane claim, and
 * a lane claim happens on a prompt. Storing the JSON in a blob would have been tidier and
 * would have cost a fetch per read, plus a push of an object, plus the question of whether
 * a ref pointing at a blob survives every host. A name costs nothing and every host stores
 * it verbatim.
 *
 * Everything here is pure: the caller passes the ref names it read and the clock. The git
 * plumbing lives in lane.mjs, so the tests need no network and no remote.
 */

/** Where a claim lives. One namespace, one repo's origin, so repos never see each other's. */
export const CLAIM_NS = 'refs/paneforge/claims'

/**
 * The lock a release takes, and the reason it is a SEPARATE ref from the claims above.
 *
 * A claim is advisory: it is read, and a decision is made about it. A release cannot be
 * advisory, because "read, then decide" has a window in the middle and both devices can
 * be inside it. So the PUSH is the decision: this ref is created by a plain, non-forced
 * push of a commit only the pushing device could have made, and the other desk's push is
 * then a non-fast-forward that git refuses on its own. It is deleted on the way out and
 * force-cleared when it goes stale.
 *
 * Pushing something both desks already have - the branch tip - is NOT a decision: pushing
 * a sha a ref already points at succeeds as a no-op. That was the first version and the
 * end-to-end test caught it. `takeReleaseLock` in lane.mjs carries the measurement.
 */
export const LOCK_REF = 'refs/paneforge/lock/release'

/**
 * How long a device's claim is believed.
 *
 * The local ledger holds a lane for 12h before deciding the chat died (STALE_MS), because
 * losing a lane out from under a live chat costs it its checkout. This is shorter for the
 * opposite reason: a claim nobody refreshes only ever costs the OTHER machine the trunk,
 * and it is refreshed on every turn that ends. 45 minutes is several turns of silence.
 */
export const PEER_STALE_MS = 45 * 60 * 1000

/** A release that has gone quiet for this long was killed, and its lock is cleared. */
export const LOCK_STALE_MS = 20 * 60 * 1000

/** Refresh our own claim once it is this old. A turn ending sooner than this costs nothing. */
export const REFRESH_MS = 10 * 60 * 1000

/**
 * The claim namespace for a release, which is not a lane and must never be handed out as
 * one. `main` and the letters are lanes; this is the word a release publishes about
 * itself so a peer can tell a live release from a leaked lock.
 */
export const RELEASE_SLOT = 'release'

/**
 * A ref name may not hold most punctuation, and every part of a claim comes from
 * somewhere that can contain it - a hostname with a dot, a session id from a CLI we do
 * not own, a lane id from a repo's own `.lanes.json`. Refuse rather than mangle: an
 * unusable part means the claim is not published, and not publishing degrades to exactly
 * the behaviour this repo had before any of this existed.
 */
export function refSafe(part, max = 64) {
  const s = String(part ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return s || null
}

/** `refs/paneforge/claims/<device>/<slot>/<session>/<millis>` */
export function claimRef({ device, slot, session, at }) {
  const d = refSafe(device, 40)
  const s = refSafe(slot, 16)
  const id = refSafe(session, 64)
  const ts = Number(at)
  if (!d || !s || !id || !Number.isFinite(ts) || ts <= 0) return null
  return `${CLAIM_NS}/${d}/${s}/${id}/${Math.floor(ts)}`
}

/**
 * Read one back. Anything that is not exactly the shape written above is dropped rather
 * than guessed at: this namespace is on a shared remote, so a ref from a future version -
 * or from something else entirely - must never be read as a claim on the trunk.
 */
export function parseClaim(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(`${CLAIM_NS}/`)) return null
  const parts = ref.slice(CLAIM_NS.length + 1).split('/')
  if (parts.length !== 4) return null
  const [device, slot, session, ts] = parts
  if (!device || !slot || !session) return null
  if (!/^\d+$/.test(ts)) return null
  const at = Number(ts)
  if (!Number.isFinite(at) || at <= 0) return null
  return { ref, device, slot, session, at }
}

/** Every claim on the remote, oldest first, with anything unrecognisable dropped. */
export function parseClaims(refs) {
  return (refs ?? [])
    .map(parseClaim)
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
}

/**
 * Who is holding a slot on ANOTHER device right now.
 *
 * Our own device is never a blocker: the local ledger already answers for this machine,
 * and it answers better - it knows about dirty worktrees and parked turns and this does
 * not. A claim older than `staleMs` is not a blocker either; see PEER_STALE_MS.
 *
 * The NEWEST live claim wins when a peer somehow published two, because the older one is
 * the one a crash would have left behind.
 */
export function heldByPeer(claims, { device, slot, now, staleMs = PEER_STALE_MS }) {
  const ours = refSafe(device, 40)
  const want = refSafe(slot, 16)
  let best = null
  for (const c of parseClaims(claims)) {
    if (c.slot !== want) continue
    if (c.device === ours) continue
    if (now - c.at > staleMs) continue
    if (!best || c.at > best.at) best = c
  }
  return best
}

/**
 * The refs this device should delete when it publishes a new claim for `slot`.
 *
 * Publishing is create-new-then-delete-old rather than force-update, because the timestamp
 * is IN the name: an update would leave the old name sitting there, and a peer reading
 * names would then see this device holding the trunk at two different times and believe
 * the older one until it aged out. Ours are the only refs we ever delete.
 */
export function supersededRefs(claims, { device, slot, keep }) {
  const ours = refSafe(device, 40)
  const want = refSafe(slot, 16)
  return parseClaims(claims)
    .filter((c) => c.device === ours && c.slot === want && c.ref !== keep)
    .map((c) => c.ref)
}

/** Every ref this device holds, whatever the slot - what a session's end gives back. */
export function ownedRefs(claims, { device, session }) {
  const ours = refSafe(device, 40)
  const id = session ? refSafe(session, 64) : null
  return parseClaims(claims)
    .filter((c) => c.device === ours && (!id || c.session === id))
    .map((c) => c.ref)
}

/** Is our published claim old enough that a peer is about to stop believing it. */
export function needsRefresh(claim, { now, refreshMs = REFRESH_MS }) {
  if (!claim) return true
  return now - claim.at >= refreshMs
}

/**
 * Is a release lock on the remote worth believing, or did the device holding it die?
 *
 * The lock ref itself carries no time - it cannot, because its whole value is that its
 * NAME never changes and so the server can refuse a second creation of it. The time comes
 * from the claim the winner publishes immediately afterwards. No claim, or a claim older
 * than LOCK_STALE_MS, means the release that took this lock is gone and the lock is
 * cleared. A release that is genuinely running refreshes nothing and does not need to:
 * LOCK_STALE_MS is longer than any release this repo has ever cut.
 */
export function lockIsStale(claims, { now, staleMs = LOCK_STALE_MS }) {
  const live = parseClaims(claims).filter((c) => c.slot === RELEASE_SLOT && now - c.at <= staleMs)
  return live.length === 0
}

/**
 * The sentence a person reads. Named here rather than at the call site because `doctor`,
 * the refusal and the claim result all have to say the same thing about the same fact.
 */
export function peerWords(claim, { now }) {
  if (!claim) return null
  const mins = Math.max(0, Math.round((now - claim.at) / 60_000))
  const when = mins < 1 ? 'just now' : mins === 1 ? '1 minute ago' : `${mins} minutes ago`
  return `${claim.device} (last said so ${when})`
}
