// Whose name is on other people's Discord profiles?
//
// Discord heads a rich presence with the APPLICATION's name and nothing the app sends can
// override it - not the details line, not the state line, not the image tooltip. So the
// header is decided entirely by `discordClientId`, and the default in src/main/config.ts
// is the one every user who never opens Settings will ship.
//
// That default started life as a BORROWED application - "Manic's Auction House", the
// author's own Discord bot - because creating one needs a portal login and a captcha and
// a script cannot do either. Nineteen digits do not say whose brand they carry, which is
// exactly how it survived: the id looks like configuration, reads like configuration, and
// is in fact somebody else's trademark being printed on a stranger's profile.
//
// This test is the thing that says so out loud. It is not a unit test of the presence -
// discord-presence-test.mjs owns that, model-free and network-free. This one asks the
// live public endpoint what the SHIPPED id is actually called, and fails while the answer
// is not PaneForge.
//
// Deliberately not silent when the network is unavailable in the other direction either:
// an offline machine SKIPS, and a skip is printed as a skip. A check that quietly passes
// when it could not run is worse than no check, because the one thing it exists to catch
// is a wrong answer that looks like no answer.
//
//   node scripts/discord-brand-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (c, n) => {
  console.log((c ? 'PASS ' : 'FAIL ') + n)
  if (!c) failed++
}

// --- what happens to the id ALREADY on disk -------------------------------
//
// Changing the default reaches nobody who has ever launched the app: getConfig() merges
// the saved file over the defaults, so a saved id wins forever. Every user from the
// borrowed-id months has those digits written into their config.json, and without the
// migration below they would go on printing a stranger's brand no matter what ships.
//
// config.ts pulls `app` from electron for the userData path, so it is bundled and the
// electron require is pointed at a stub - the same trick gamemode-test.mjs uses for
// tasklist, and for the same reason: without it this would measure nothing.
const work = join(tmpdir(), 'pf-discord-brand-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
writeFileSync(
  join(work, 'electron-stub.cjs'),
  `module.exports={app:{getPath:()=>${JSON.stringify(work)},getVersion:()=>'0.0.0'}}\n`
)
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/config.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'config.bundle.cjs'),
  external: ['electron']
})
const bundleFile = join(work, 'config.bundle.cjs')
const bundleSrc = readFileSync(bundleFile, 'utf8')
const patchedSrc = bundleSrc.replace(
  /require\((["'])electron\1\)/g,
  'require("./electron-stub.cjs")'
)
if (patchedSrc === bundleSrc) {
  console.error('FAIL could not point config.ts at the electron stub')
  failed++
} else {
  writeFileSync(bundleFile, patchedSrc)
  const { migrateDiscordId } = createRequire(import.meta.url)(bundleFile)
  const BORROWED = '1494887437367771276'
  const NOW = 'the-shipped-default'
  ok(
    migrateDiscordId(BORROWED, NOW) === NOW,
    'a config still holding the borrowed id is moved to the shipped one'
  )
  ok(
    migrateDiscordId('999999999999999999', NOW) === '999999999999999999',
    "somebody else's own application id is left exactly alone"
  )
  ok(migrateDiscordId(undefined, NOW) === NOW, 'a config written before the field existed gets the default')
  ok(migrateDiscordId('', NOW) === NOW, 'and so does an empty one')
}
rmSync(work, { recursive: true, force: true })

// Read the literal out of config.ts rather than importing it: this must track the value
// that actually ships, and a copy of the id in the test is a second place to forget.
const cfg = readFileSync(join(root, 'src/main/config.ts'), 'utf8')
const m = /discordClientId:\s*'(\d+)'/.exec(cfg)
// process.exitCode rather than process.exit(): exiting while the fetch handle is still
// closing aborts Node on Windows with a libuv assertion (`!(handle->flags &
// UV_HANDLE_CLOSING)`), and an abort replaces the exit code with its own - so a FAIL that
// says everything it should still came back as 127, which reads like "no such command"
// rather than like a failed check.
if (!m) {
  console.error('FAIL no discordClientId default found in src/main/config.ts')
  console.error('     The presence header comes from that literal; without it there is')
  console.error('     nothing to check and the shipped brand is unknown.')
  failed++
} else {
  const id = m[1]
  const res = await fetch(`https://discord.com/api/v10/applications/${id}/rpc`, {
    signal: AbortSignal.timeout(8000)
  }).catch(() => null)
  const name = res && res.ok ? String((await res.json())?.name ?? '') : null

  if (name === null) {
    console.log(`SKIP could not reach Discord to ask what application ${id} is called.`)
    console.log('     Offline, rate limited, or the id belongs to nobody. Not a pass.')
  } else if (/paneforge/i.test(name)) {
    console.log(`PASS the shipped Discord application ${id} is called ${JSON.stringify(name)}`)
    console.log('     Every user who never opens Settings gets that as their presence header.')
  } else {
    console.error(`FAIL the shipped Discord application ${id} is called ${JSON.stringify(name)}.`)
    console.error('')
    console.error("     Discord prints that string as the header of every PaneForge user's")
    console.error('     presence, and no setting in the app can change what it says. Until it')
    console.error('     reads PaneForge, the feature is advertising somebody else.')
    console.error('')
    console.error('     Fixing it is one thing a script cannot do (portal login + captcha):')
    console.error('       1. https://discord.com/developers/applications')
    console.error('       2. New Application -> name it PaneForge -> Create')
    console.error('       3. copy the Application ID')
    console.error(`       4. replace discordClientId in src/main/config.ts (currently ${id})`)
    console.error('')
    console.error('     No bot, no scopes, no OAuth and no "connection" to link: rich presence')
    console.error('     talks to the local Discord client over a named pipe, and the id is the')
    console.error('     only thing it needs.')
    failed++
  }

  // The header is only half the brand. `buildActivity` names an art asset, and an id
  // whose portal no longer has one under that name draws a card with no image at all -
  // which is exactly how the mark went missing while the name was already correct.
  const rpc = readFileSync(join(root, 'src/shared/discordRpc.ts'), 'utf8')
  const key = /PRESENCE_IMAGE\s*=\s*'([^']+)'/.exec(rpc)?.[1] ?? null
  if (!key) {
    console.error('FAIL no PRESENCE_IMAGE constant found in src/shared/discordRpc.ts')
    console.error('     Nothing names the artwork, so the card is text only.')
    failed++
  } else {
    const res = await fetch(`https://discord.com/api/v9/oauth2/applications/${id}/assets`, {
      signal: AbortSignal.timeout(8000)
    }).catch(() => null)
    const assets = res && res.ok ? await res.json().catch(() => null) : null

    if (!Array.isArray(assets)) {
      console.log(`SKIP could not reach Discord to list application ${id}'s art assets.`)
      console.log('     Offline or rate limited. Not a pass.')
    } else if (assets.some((a) => a?.name === key)) {
      console.log(`PASS the art asset ${JSON.stringify(key)} exists, so the card draws the mark`)
    } else {
      const names = assets.map((a) => a?.name).filter(Boolean)
      console.error(`FAIL application ${id} has no art asset named ${JSON.stringify(key)}.`)
      console.error(`     It has: ${names.length ? names.join(', ') : '(none at all)'}`)
      console.error('')
      console.error('     Discord silently drops an image key it cannot resolve, so the presence')
      console.error('     still sends and still reads PaneForge - with no logo on it, and nothing')
      console.error('     anywhere saying why.')
      console.error('')
      console.error('     Uploading art is the other thing a script cannot do:')
      console.error(`       1. https://discord.com/developers/applications/${id}/rich-presence/assets`)
      console.error(`       2. Add Image -> upload icon.png -> name it exactly ${JSON.stringify(key)}`)
      console.error('       3. it can take a few minutes to serve')
      failed++
    }
  }
}

if (failed) process.exitCode = 1
