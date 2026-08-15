/**
 * Lanes across two machines.
 *
 * Everything here runs against `scripts/lane-peers.mjs`, which is pure - the claim is a
 * ref NAME, so a test needs no remote, no network and no second computer to exercise the
 * exact strings the two desks would really exchange.
 *
 * The load-bearing half is the negatives. A cross-device check that refuses too eagerly
 * is worse than none at all: it would send this desk's chats to a letter lane on the word
 * of a machine that was switched off last week, and nobody would ever find out, because
 * a letter lane WORKS. So the cases that must say nothing are tested as hard as the one
 * case that must speak.
 *
 *   node scripts/lane-peers-test.mjs
 */
import {
  CLAIM_NS,
  LOCK_STALE_MS,
  PEER_STALE_MS,
  REFRESH_MS,
  RELEASE_SLOT,
  claimRef,
  heldByPeer,
  lockIsStale,
  needsRefresh,
  ownedRefs,
  parseClaim,
  parseClaims,
  peerWords,
  refSafe,
  supersededRefs
} from './lane-peers.mjs'

let failed = 0
function ok(cond, what) {
  if (cond) console.log(`  ok   ${what}`)
  else {
    failed++
    console.log(`  FAIL ${what}`)
  }
}
function eq(a, b, what) {
  ok(a === b, `${what}${a === b ? '' : ` (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`)
}

const NOW = 1_700_000_000_000
const MAC = 'roberts-macbook-pro'
const PC = 'desktop-cmsucm1'
const ref = (device, slot, session, at) => claimRef({ device, slot, session, at })

console.log('\nref names')
{
  eq(
    ref(MAC, 'main', 'abc-123', NOW),
    `${CLAIM_NS}/roberts-macbook-pro/main/abc-123/${NOW}`,
    'a claim is four parts under the namespace'
  )
  // A hostname with a dot is the ordinary case, not the exotic one - every tailnet name
  // has three. A ref name may not carry them, so they are folded rather than refused.
  eq(refSafe('Roberts-MacBook-Pro.local'), 'roberts-macbook-pro-local', 'dots and case fold into a ref-safe name')
  eq(refSafe('...'), null, 'a name with nothing usable in it is refused, never mangled into an empty part')
  eq(ref('...', 'main', 'abc', NOW), null, 'and a claim with an unusable part is not published at all')
  eq(ref(MAC, 'main', 'abc', 0), null, 'nor one with no time in it')
  eq(ref(MAC, 'main', 'abc', NaN), null, 'nor one whose time is not a number')
}

console.log('\nreading a ref back')
{
  const r = ref(PC, 'main', 'sess-9', NOW)
  const c = parseClaim(r)
  eq(c.device, 'desktop-cmsucm1', 'device round-trips')
  eq(c.slot, 'main', 'slot round-trips')
  eq(c.session, 'sess-9', 'session round-trips')
  eq(c.at, NOW, 'time round-trips')

  // This namespace lives on a SHARED remote. Anything that is not exactly the shape this
  // version writes has to be dropped rather than guessed at, or a ref from some future
  // version - or from something else entirely - reads as a claim on the trunk.
  eq(parseClaim('refs/heads/master'), null, 'an ordinary branch is not a claim')
  eq(parseClaim(`${CLAIM_NS}/mac/main/sess`), null, 'three parts is not a claim')
  eq(parseClaim(`${CLAIM_NS}/mac/main/sess/9/extra`), null, 'five parts is not a claim')
  eq(parseClaim(`${CLAIM_NS}/mac/main/sess/tomorrow`), null, 'a time that is not digits is not a claim')
  eq(parseClaim(`${CLAIM_NS}/mac/main//${NOW}`), null, 'an empty part is not a claim')
  eq(parseClaim(null), null, 'and neither is nothing at all')
  eq(parseClaims([`${CLAIM_NS}/mac/main/s/${NOW}`, 'refs/tags/v1', null]).length, 1, 'junk is filtered, not thrown')
}

console.log('\nwho holds the trunk')
{
  const live = [ref(PC, 'main', 's1', NOW - 60_000)]
  const held = heldByPeer(live, { device: MAC, slot: 'main', now: NOW })
  eq(held?.device, 'desktop-cmsucm1', 'a live claim from the other desk is seen')

  // Our own machine is never consulted through the remote: the local ledger answers for
  // this desk and answers better - it knows about dirty worktrees and parked turns.
  eq(
    heldByPeer([ref(MAC, 'main', 's1', NOW - 60_000)], { device: MAC, slot: 'main', now: NOW }),
    null,
    'this desk never blocks itself'
  )
  eq(
    heldByPeer([ref('Roberts-MacBook-Pro', 'main', 's1', NOW)], { device: 'roberts-macbook-pro', slot: 'main', now: NOW }),
    null,
    'and it still recognises itself when the hostname was cased differently'
  )

  // The negative that matters most: a desk that was switched off must not hold the trunk
  // against the desk that is switched on.
  eq(
    heldByPeer([ref(PC, 'main', 's1', NOW - PEER_STALE_MS - 1)], { device: MAC, slot: 'main', now: NOW }),
    null,
    'a claim nobody has refreshed stops counting'
  )
  eq(
    heldByPeer([ref(PC, 'main', 's1', NOW - PEER_STALE_MS + 1000)], { device: MAC, slot: 'main', now: NOW })?.device,
    'desktop-cmsucm1',
    'and one a second inside the window still counts'
  )

  // A letter lane is a local-only branch in a folder on one disk. Two of them are not
  // the same thing and asking about them would buy a round trip to prevent nothing.
  eq(heldByPeer([ref(PC, 'a', 's1', NOW)], { device: MAC, slot: 'main', now: NOW }), null, 'lane a is not the trunk')
  eq(
    heldByPeer([ref(PC, RELEASE_SLOT, 's1', NOW)], { device: MAC, slot: 'main', now: NOW }),
    null,
    'and a release in progress is not a hold on the trunk either'
  )

  // A peer that crashed and came back publishes twice. The newer one is the truth; the
  // older is what the crash left behind.
  const twice = [ref(PC, 'main', 'old', NOW - 30 * 60_000), ref(PC, 'main', 'new', NOW - 60_000)]
  eq(heldByPeer(twice, { device: MAC, slot: 'main', now: NOW })?.session, 'new', 'the newest live claim wins')
}

console.log('\ntaking our own old names down')
{
  const keep = ref(MAC, 'main', 's2', NOW)
  const all = [ref(MAC, 'main', 's1', NOW - 60_000), keep, ref(PC, 'main', 'p1', NOW), ref(MAC, 'a', 's1', NOW)]
  const dead = supersededRefs(all, { device: MAC, slot: 'main', keep })
  eq(dead.length, 1, 'exactly one name is superseded')
  ok(dead[0].includes('/main/s1/'), 'and it is this desk’s older trunk name')
  ok(
    !dead.some((r) => r.includes(PC)),
    'the other desk’s refs are never deleted - we only ever take down our own'
  )

  const mine = ownedRefs(all, { device: MAC, session: 's1' })
  eq(mine.length, 2, 'a session ending gives back every slot it published, whatever the slot')
  ok(!mine.some((r) => r.includes(PC)), 'and still nothing belonging to the other desk')
}

console.log('\nheartbeat')
{
  ok(needsRefresh(null, { now: NOW }), 'having published nothing, a refresh is due')
  ok(!needsRefresh({ at: NOW - REFRESH_MS + 1000 }, { now: NOW }), 'a recent claim is left alone - an ordinary turn pushes nothing')
  ok(needsRefresh({ at: NOW - REFRESH_MS - 1 }, { now: NOW }), 'an old one is refreshed before the peer stops believing it')
  ok(REFRESH_MS < PEER_STALE_MS, 'and the refresh is due well before the claim would expire')
}

console.log('\nthe release lock')
{
  ok(
    lockIsStale([], { now: NOW }),
    'a lock ref with no claim beside it is a lock a killed machine left behind'
  )
  ok(
    !lockIsStale([ref(PC, RELEASE_SLOT, 's1', NOW - 60_000)], { now: NOW }),
    'a lock with a live claim beside it is a release that is genuinely running'
  )
  ok(
    lockIsStale([ref(PC, RELEASE_SLOT, 's1', NOW - LOCK_STALE_MS - 1)], { now: NOW }),
    'and one whose release went quiet longer than any release takes is cleared'
  )
  ok(
    lockIsStale([ref(PC, 'main', 's1', NOW)], { now: NOW }),
    'a peer holding the TRUNK is not a peer holding the release lock'
  )
}

console.log('\nthe words a person reads')
{
  eq(peerWords(null, { now: NOW }), null, 'nothing to say about nobody')
  ok(peerWords(parseClaim(ref(PC, 'main', 's', NOW - 5000)), { now: NOW }).includes('just now'), 'seconds read as just now')
  ok(
    peerWords(parseClaim(ref(PC, 'main', 's', NOW - 60_000)), { now: NOW }).includes('1 minute ago'),
    'one minute is singular'
  )
  ok(
    peerWords(parseClaim(ref(PC, 'main', 's', NOW - 12 * 60_000)), { now: NOW }).includes('12 minutes ago'),
    'and the name of the machine is in the sentence, not just a flag'
  )
  ok(peerWords(parseClaim(ref(PC, 'main', 's', NOW)), { now: NOW }).includes('desktop-cmsucm1'), 'named, so it can be found')
}

console.log(failed ? `\n${failed} failed\n` : '\nall good\n')
process.exit(failed ? 1 : 0)
