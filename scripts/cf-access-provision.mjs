#!/usr/bin/env node
/**
 * Put one desk behind Cloudflare Access, over a named tunnel, from a shell.
 *
 * This is the whole public-customer path in one idempotent script: a Zero Trust org, a named
 * tunnel, the DNS record that points at it, an Access application on that hostname and a
 * policy saying who may pass. Run it twice and the second run changes nothing.
 *
 * Why a NAMED tunnel and not the quick one the app already has:
 *
 * - A quick tunnel mints a public `*.trycloudflare.com` origin per launch. Anyone who learns
 *   the hostname reaches the desk's front door, and that namespace is swept - on 2026-08-14
 *   an unknown Windows box in AWS arrived at exactly such an address. A named tunnel has no
 *   inbound port and no listening public origin at all: cloudflared dials OUT.
 * - A stable hostname is also what makes a signed-in phone stay signed in. A cookie belongs
 *   to an origin, and a random origin per launch is a new origin per launch.
 *
 * **Access must exist BEFORE the tunnel does.** A named tunnel without a policy in front is
 * the same unauthenticated origin as the quick one, with a stable hostname - strictly easier
 * to find. So `ensureAccess` runs first and the script refuses to create the tunnel if the
 * Access half could not be established. That ordering is the point of the file.
 *
 * Dry by default. Nothing mutates without `--apply`, because every step here is a change to
 * a live Cloudflare account.
 *
 * Usage:
 *   node scripts/cf-access-provision.mjs --desk mac --zone taskdriver.ai --email you@x.com
 *   node scripts/cf-access-provision.mjs --desk mac --zone taskdriver.ai --email you@x.com --apply
 *
 * Exit: 0 fine · 1 something failed · 2 the token is missing a scope (it names which).
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API = 'https://api.cloudflare.com/client/v4'

const args = process.argv.slice(2)
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? fallback : String(args[i + 1] ?? '')
}
const has = (name) => args.includes(`--${name}`)

const DESK = flag('desk')
const ZONE = flag('zone')
const SUB = flag('subdomain', 'pf')
const EMAILS = flag('email').split(',').map((s) => s.trim()).filter(Boolean)
const APPLY = has('apply')

if (!DESK || !ZONE || !EMAILS.length) {
  console.error(
    'need --desk <name> --zone <domain> --email <a@b.com[,c@d.com]> [--subdomain pf] [--apply]'
  )
  process.exit(1)
}

// `--subdomain ''` is a legitimate ask - it means "put this desk straight under the zone" -
// and joining blindly produced `panes..taskdriver.ai`, which Cloudflare accepts into an
// Access application and which nothing will ever resolve.
const HOSTNAME = [DESK, SUB, ZONE].filter(Boolean).join('.')

/**
 * The Access-scoped token is looked for FIRST and separately.
 *
 * The token already on this machine can make tunnels and DNS records but not Access apps,
 * and a script that silently fell back to it would do the dangerous half of the job - a
 * public hostname on a live tunnel - and then fail on the half that protects it.
 */
function token() {
  const paths = [
    join(homedir(), '.config/cloudflare/token-access'),
    join(homedir(), '.config/cloudflare/token')
  ]
  for (const p of paths) {
    try {
      const t = readFileSync(p, 'utf8').trim()
      if (t) return { token: t, from: p }
    } catch {
      /* the next one, or the error below */
    }
  }
  console.error(`no Cloudflare token found at:\n  ${paths.join('\n  ')}`)
  process.exit(1)
}

const TOKEN = token()

async function call(path, init, bearer) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  })
  const body = await res.json().catch(() => ({ success: false, errors: [{ message: 'not JSON' }] }))
  return { status: res.status, ok: !!body.success, result: body.result, errors: body.errors ?? [] }
}

async function cf(path, init = {}) {
  return await call(path, init, TOKEN.token)
}

/**
 * DNS, and DNS only, may fall back to the other token on the machine.
 *
 * Cloudflare's account-owned tokens (`cfat_`) can hold every Access and Tunnel permission and
 * still be unable to read a zone's DNS records, because zone permissions live on a different
 * axis - measured here 2026-08-14 on a token the dashboard called full access. Rather than
 * stall the whole run on that, the LAST and least dangerous step is allowed to try the older
 * zone-scoped token.
 *
 * This is not the fallback the header warns against. That one would have used a weaker token
 * for the guard and a stronger one for the door; this runs after Access is already in place,
 * and a DNS record with no Access app in front is the thing that cannot happen here because
 * the Access step is upstream of it and fatal.
 */
async function dns(path, init = {}) {
  const first = await cf(path, init)
  if (first.ok || !isAuth(first)) return first
  let other = ''
  try {
    other = readFileSync(join(homedir(), '.config/cloudflare/token'), 'utf8').trim()
  } catch {
    return first
  }
  if (!other || other === TOKEN.token) return first
  const second = await call(path, init, other)
  if (second.ok) say('  (used ~/.config/cloudflare/token for DNS - the Access token has no zone scope)')
  return second.ok ? second : first
}

const isAuth = (r) => r.errors.some((e) => e.code === 10000 || /authentication/i.test(String(e.message)))

const say = (s) => console.log(s)
const plan = (s) => console.log(APPLY ? `  ${s}` : `  WOULD ${s}`)

function die(what, r, scope = '') {
  const why = r.errors.map((e) => `${e.code}:${e.message}`).join('; ') || `HTTP ${r.status}`
  console.error(`\n${what} failed - ${why}`)
  if (scope) {
    console.error(
      `\nThis is a token scope. Mint a token at\n` +
        `  https://dash.cloudflare.com/profile/api-tokens\n` +
        `with ${scope}\nand save it to ~/.config/cloudflare/token-access`
    )
    process.exit(2)
  }
  process.exit(1)
}

// ---- 1. who we are ------------------------------------------------------------------

/**
 * "Is this token any good" is NOT `/user/tokens/verify`.
 *
 * That endpoint only knows USER-owned tokens. An account-owned one (the `cfat_` prefix, which
 * is what the dashboard mints now) answers it with a flat `1000: Invalid API Token` while
 * being perfectly valid for every account and zone call - measured 2026-08-14, and it stopped
 * this script dead on a token that could do the entire job. So the fallback is the real
 * question: can it list the accounts we are about to work in.
 */
const verify = await cf('/user/tokens/verify')
if (verify.ok) {
  say(`token: valid, user-owned (${TOKEN.from})`)
} else {
  const accounts = await cf('/accounts')
  if (!accounts.ok) die('token verify', accounts, 'Account: Account Settings: Read')
  say(`token: valid, account-owned (${TOKEN.from})`)
}

const zones = await cf(`/zones?name=${encodeURIComponent(ZONE)}`)
if (!zones.ok || !zones.result?.length) die(`looking up zone ${ZONE}`, zones, 'Zone: Zone: Read')
const zone = zones.result[0]
const ACCOUNT = zone.account.id
say(`zone:  ${zone.name} (${zone.status}) in account ${zone.account.name}`)
say(`host:  ${HOSTNAME}`)
say(APPLY ? 'mode:  APPLY - this will change a live account\n' : 'mode:  dry run - nothing will change\n')

// ---- 2. Access FIRST, always --------------------------------------------------------
//
// Everything below this point creates a way in. If the thing that guards it cannot be put in
// place, the right outcome is no way in at all.

say('Access')
const org = await cf(`/accounts/${ACCOUNT}/access/organizations`)
if (!org.ok) {
  // Two different refusals, and they need different words. "not_enabled" is a one-time
  // account setup; an auth error is a scope on the token.
  const notEnabled = org.errors.some((e) => String(e.message).includes('not_enabled'))
  die(
    'reading the Zero Trust organisation',
    org,
    notEnabled
      ? 'Access enabled on the account (visit https://one.dash.cloudflare.com once), then a token with Access: Apps and Policies: Edit + Access: Organizations: Read'
      : 'Access: Organizations: Read and Access: Apps and Policies: Edit'
  )
}
say(`  org: ${org.result?.name ?? org.result?.auth_domain ?? 'present'}`)

const apps = await cf(`/accounts/${ACCOUNT}/access/apps`)
if (!apps.ok) die('listing Access applications', apps, 'Access: Apps and Policies: Edit')
let app = (apps.result ?? []).find((a) => a.domain === HOSTNAME)
if (app) {
  say(`  app: already exists (${app.id})`)
} else {
  plan(`create an Access application for ${HOSTNAME}`)
  if (APPLY) {
    const made = await cf(`/accounts/${ACCOUNT}/access/apps`, {
      method: 'POST',
      body: JSON.stringify({
        name: `PaneForge ${DESK}`,
        domain: HOSTNAME,
        type: 'self_hosted',
        // A day, not a month: this is the outer session, and the passkey gate inside the app
        // is what makes a long one unnecessary.
        session_duration: '24h',
        http_only_cookie_attribute: true,
        // The desk is not a browser and cannot do an OIDC redirect; without this every
        // request from cloudflared itself would bounce off the login page.
        allowed_idps: [],
        auto_redirect_to_identity: false
      })
    })
    if (!made.ok) die('creating the Access application', made, 'Access: Apps and Policies: Edit')
    app = made.result
    say(`  app: created (${app.id})`)
  }
}

if (app) {
  const pols = await cf(`/accounts/${ACCOUNT}/access/apps/${app.id}/policies`)
  if (!pols.ok) die('listing Access policies', pols, 'Access: Apps and Policies: Edit')
  const wanted = `PaneForge ${DESK} owner`
  if ((pols.result ?? []).some((p) => p.name === wanted)) {
    say('  policy: already exists')
  } else {
    plan(`create an allow policy for ${EMAILS.join(', ')}`)
    if (APPLY) {
      const made = await cf(`/accounts/${ACCOUNT}/access/apps/${app.id}/policies`, {
        method: 'POST',
        body: JSON.stringify({
          name: wanted,
          decision: 'allow',
          include: EMAILS.map((email) => ({ email: { email } }))
        })
      })
      if (!made.ok) die('creating the Access policy', made, 'Access: Apps and Policies: Edit')
      say('  policy: created')
    }
  }
}

// ---- 3. the tunnel, only now --------------------------------------------------------

say('\nTunnel')
// Overridable: a desk provisioned by hand may already own a tunnel under another name, and
// deriving it from --desk would quietly build a SECOND tunnel next to the working one.
const name = flag('tunnel', `paneforge-${DESK}`)
const list = await cf(`/accounts/${ACCOUNT}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`)
if (!list.ok) die('listing tunnels', list, 'Account: Cloudflare Tunnel: Edit')
let tunnel = (list.result ?? [])[0]
if (tunnel) {
  say(`  tunnel: already exists (${tunnel.id})`)
} else {
  plan(`create a named tunnel "${name}"`)
  if (APPLY) {
    const made = await cf(`/accounts/${ACCOUNT}/cfd_tunnel`, {
      method: 'POST',
      // `cloudflared` is the modern secret-less kind: Cloudflare mints the credential and
      // hands it back once, as `token`, which is what the desk runs with.
      body: JSON.stringify({ name, config_src: 'cloudflare' })
    })
    if (!made.ok) die('creating the tunnel', made, 'Account: Cloudflare Tunnel: Edit')
    tunnel = made.result
    say(`  tunnel: created (${tunnel.id})`)
  }
}

if (tunnel) {
  plan(`point the tunnel's public hostname ${HOSTNAME} at http://127.0.0.1:7312`)
  if (APPLY) {
    const cfg = await cf(`/accounts/${ACCOUNT}/cfd_tunnel/${tunnel.id}/configurations`, {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname: HOSTNAME, service: 'http://127.0.0.1:7312' },
            // Required terminator. Without it the whole config is rejected.
            { service: 'http_status:404' }
          ]
        }
      })
    })
    if (!cfg.ok) die('writing the tunnel configuration', cfg, 'Account: Cloudflare Tunnel: Edit')
    say('  ingress: written')
  }
}

// ---- 4. DNS -------------------------------------------------------------------------

say('\nDNS')
const recs = await dns(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(HOSTNAME)}`)
if (!recs.ok) die('listing DNS records', recs, 'Zone: DNS: Edit')
const want = tunnel ? `${tunnel.id}.cfargotunnel.com` : '<tunnel-id>.cfargotunnel.com'
const rec = (recs.result ?? [])[0]
if (rec && rec.content === want) {
  say('  CNAME: already correct')
} else if (rec) {
  plan(`repoint the existing CNAME from ${rec.content} to ${want}`)
  if (APPLY) {
    const up = await dns(`/zones/${zone.id}/dns_records/${rec.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: want, proxied: true })
    })
    if (!up.ok) die('updating the CNAME', up, 'Zone: DNS: Edit')
    say('  CNAME: updated')
  }
} else {
  plan(`create CNAME ${HOSTNAME} -> ${want} (proxied)`)
  if (APPLY) {
    const made = await dns(`/zones/${zone.id}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'CNAME', name: HOSTNAME, content: want, proxied: true })
    })
    if (!made.ok) die('creating the CNAME', made, 'Zone: DNS: Edit')
    say('  CNAME: created')
  }
}

// ---- 5. what the desk needs ---------------------------------------------------------

if (APPLY && tunnel) {
  const tok = await cf(`/accounts/${ACCOUNT}/cfd_tunnel/${tunnel.id}/token`)
  if (!tok.ok) die('fetching the tunnel token', tok, 'Account: Cloudflare Tunnel: Edit')
  say('\nRun this on the desk (it dials out; nothing listens):')
  say(`  cloudflared tunnel run --token ${tok.result}`)
  say('\nThat token IS the tunnel credential - treat it like a password.')
} else if (!APPLY) {
  say('\nNothing was changed. Re-run with --apply to do it.')
}

say(`\nWhen it is up: https://${HOSTNAME} - Cloudflare asks who you are before PaneForge sees the request.`)
