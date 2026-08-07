/**
 * The pairing QR: point a camera at it and the phone is in.
 *
 * The six characters were never hard, but they are the only typing left in this product and
 * they are done in the worst possible place - an on-screen keyboard, held in one hand,
 * copying from a screen a metre away. The camera app on every phone made after 2017 opens a
 * link from a QR with one tap, so this is the whole of pairing.
 *
 * What it encodes is `<address>/#<code>`. The fragment is the point: a browser never sends
 * it to the server, so the secret stays out of the access log and out of any `Referer` -
 * see the pairing page in `main/phone.ts`, which posts it exactly as a person would.
 *
 * Drawn as one `<path>` in `currentColor` on a `--bg` plate rather than as an image: a QR is
 * black on white by convention and a phone's camera will not look at a dark-mode one, so the
 * plate is always light and the modules always dark, whatever the theme is doing around it.
 */

import { useMemo } from 'react'
import { qr, qrPath } from '@shared/qr'

export function PairQr({ url, code, size = 132 }: { url: string; code: string; size?: number }): JSX.Element | null {
  const drawn = useMemo(() => {
    if (!url || !code) return null
    try {
      const symbol = qr(`${url}/#${code}`)
      // Four modules of quiet zone: less and a camera stops finding the finder patterns.
      const quiet = 4
      return { d: qrPath(symbol, quiet), box: symbol.size + quiet * 2 }
    } catch {
      // An address too long for a version 6 symbol is not worth a broken picture - the
      // typed code below it still works. See `qr()` for why it refuses rather than truncates.
      return null
    }
  }, [url, code])

  if (!drawn) return null
  return (
    <svg
      className="pair-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${drawn.box} ${drawn.box}`}
      role="img"
      aria-label="Pairing code, as a QR to scan with a phone camera"
    >
      <rect width={drawn.box} height={drawn.box} fill="#ffffff" />
      <path d={drawn.d} fill="#000000" />
    </svg>
  )
}
