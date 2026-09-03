# Remote screen lag - what was measured and what was changed (lane-d, 2026-09-03)

Robert: "its a bit laggy, try to optimise that remote screen etc."

## Method, written before anything was run

Two throwaway scripts, both driving the SHIPPING code rather than a mock of it:

1. **`measure-remote.tmp.mjs`** - record a real pty (`@lydell/node-pty`, 120x40) running
   `git --no-pager log -p -n 300`, keeping a timestamp for every scrap of output it
   emits; then replay that recording through a real `Conn` (built from
   `src/main/remote/wire.ts` with esbuild) over a loopback socket, once the way the code
   sends today and once coalesced, and log frames, sender CPU, bytes actually written to
   the socket, and bytes the receiver decoded.
2. **`measure-host.tmp.mjs`** - the same recording through the real `RemoteHost` with a
   stub backend and a real guest connection that attaches to the pane. This is the whole
   shipping path, so the before/after numbers below come from it. The recording is saved
   to disk and replayed, so the before run and the after run see byte-identical input
   (a fresh pty capture varies 12k-40k chunks run to run, which would have made any
   comparison meaningless).

Both were run twice; the numbers repeat.

### Read first, so the measurement pointed at the right hop

Four hops carry a mirrored pane's output. Three were already fine:

- `src/main/remote/client.ts:447` - the guest appends the scrap to its own scrollback.
  O(chunk), no whole-buffer rebuild.
- `src/main/index.ts:1149` - the guest hands it to `DataPump`, which already coalesces to
  at most one renderer message per pane every 8ms.
- `src/renderer/src/components/TerminalPane.tsx:1898` - `t.write(bytes)`, an incremental
  xterm write. There is no full redraw per message.

One was not:

- `src/main/remote/host.ts:223` - `backend.onData((id, data) => conn.send({ t: 'data', id, data }))`.
  Every scrap became its own encrypted message.

## Numbers

### Network, for context

`ping -c 10 100.78.1.77` (the PC), 2026-09-03:

```
10 packets transmitted, 10 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 64.192/80.936/152.443/28.029 ms
```

81ms average. That is real and it is felt in keystroke echo, but it is the link between
the two machines, not something this app can shorten. It also sets the scale for the fix:
holding output for up to 16ms is a fifth of one round trip.

### What one pane actually emits

```
chunks=20648 bytes=3562492 in 1764ms -> 11,704 scraps/second, median 116 bytes
```

Same order as the 7,359/second at 41 bytes recorded in `src/main/dataPump.ts` for the
local screen path.

### Through the real host, same recording both times

| | wire frames | sender CPU | time in the send loop | bytes on the socket | output delivered |
|---|---|---|---|---|---|
| before (one frame per scrap) | 20,648 | 516 ms | 402 ms | 5,528,722 | 3,562,492 |
| after (gathered into 16ms) | 55 | 123 ms | 69 ms | 4,457,886 | 3,562,492 |

- **375x fewer messages** on the wire.
- **4.2x less sender CPU** (516ms -> 123ms) to move 1.8 seconds of one pane's output, and
  the receiver pays the mirror image of that saving - it was decrypting and parsing 20,648
  messages a run.
- **19.4% fewer bytes across the network**: 1,070,836 bytes of pure per-message overhead
  removed (12-byte nonce, 16-byte tag, 4-byte length and the JSON envelope, paid 20,648
  times).
- Output delivered is byte-identical, so nothing is lost or reordered.

That is roughly 12,000 encrypt-and-write operations per second per busy pane on the PC and
12,000 decrypt-and-parse operations per second on the Mac, to move scraps with a median of
116 bytes - with several mirrored panes printing at once, that is the stutter.

## The one change

`src/shared/wireBatch.ts` holds the rule: a pane's output is joined and sent as one
message per 16ms, released immediately when a burst passes 64 KB, and released in full
whenever something would otherwise reorder it (a device asking for a pane's history, a
pane ending, hosting switched off). `src/main/remote/host.ts` uses it; nothing else in the
path was touched.

Test: `npm run test:wirebatch` (`scripts/wire-batch-test.mjs`), also in `npm test`. It was
proved able to fail by putting the old one-message-per-scrap behaviour back, which broke
5 of its checks.

## Not done

- The 81ms round trip to the PC is untouched and is now the biggest remaining number in
  the path. Anything about it is a network question, not an app one.
- The guest still decodes each message on the main thread. At 55 messages a run instead of
  20,648 that no longer measures, so it was left alone.
