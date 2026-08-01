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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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
  process.exitCode = 1
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
    process.exitCode = 1
  }
}
