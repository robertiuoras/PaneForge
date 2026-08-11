/**
 * Which copy of this UI is running.
 *
 * The renderer is deliberately one program on two surfaces: this window, where the preload
 * supplies `window.api`, and a browser on a phone, where `browserApi.ts` builds the same
 * object over HTTP. Almost nothing needs to know the difference, and anything that asks
 * "am I the phone" to change a LAYOUT is asking the wrong question - that is the viewport's
 * job (`handheld.ts`), and a small desktop window deserves the same answer as a phone.
 *
 * What genuinely differs is AUTHORITY. Letting a new device in is decided at the desk, by
 * somebody comparing four digits with the screen in their hand, so the card that decides it
 * belongs to the desk alone. Drawn on a phone it is worse than useless twice over: it is a
 * full-screen veil over whatever that phone was doing, and it offers Approve to a device
 * that cannot see the desk.
 */
export function isPhoneClient(): boolean {
  return !!(window as unknown as { __pfPhone?: boolean }).__pfPhone
}
