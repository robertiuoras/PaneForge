# Remote/pairing UX as it is today (located 2026-09-02)

## Phone
1. RemoteDialog.tsx:179 toggle "Gives this desk a public https address…" → api.setPhoneTunnel(on)
2. RemoteDialog.tsx:421-431 QR (PairQr) caption "Open the link it offers and the phone is in"; fed by api.phoneState()/onPhone
3. RemoteDialog.tsx:465-469 button Copy (address) → api.copyText(url)
4. RemoteDialog.tsx:480 port input → api.setPhonePort(n)
5. RemoteDialog.tsx:490-503 Copy (code), New code → api.copyText(state.code), api.rotatePhoneCode()
6. RemoteDialog.tsx:518 toggle "It raises a card on this screen with four digits…" → api.setPhoneAsking(on)
7. RemoteDialog.tsx:524-526 toggle "Ask for a passkey before typing" → api.setPhoneTypeGate(on)
8. PhoneAsk.tsx:46-67 approve card (rendered from App): "Is this you?", "A phone wants to sign in · on this network · <address>", 4 digits, No/Yes → api.answerPhoneAsk(false/true)
9. RemoteDialog.tsx:274-281 paired devices, Forget → api.forgetPhoneDevice(id); 296-300 clear mark → api.clearPhoneMark(id)
10. RemoteDialog.tsx:537-541 passkeys, remove → api.forgetPhoneKey(id)

## Another computer
1. RemoteDialog.tsx:900 toggle host → api.setRemoteHost(on)
2. RemoteDialog.tsx:911 toggle "It puts a card on this screen with six digits" → api.setPairByAsking(on)
3. RemoteDialog.tsx:946-947 Copy invite → api.remoteInvite() then api.copyText(text)
4. RemoteDialog.tsx:960-984 Fold "Pair by hand": show/hide code, Copy code, New code → api.rotateRemoteCode(), port → api.setRemotePort(n)
5. RemoteDialog.tsx:1229-1232 "Pair with <name>" (clipboard invite) → api.pairFromClipboard(); cancel 1255 → api.cancelAsk()
6. RemoteDialog.tsx:1265-1278 LAN found-device row → api.askToPair({address,port,name}) or api.pairRemote(input)
7. RemoteDialog.tsx:1297 textarea "Paste the invite from your other device" → api.pairRemoteText(text)
8. RemoteDialog.tsx:1312-1313 "Type an address and code instead" → manual fields → api.pairRemote(input)
9. PairAsk.tsx:34-51 six-digit compare card: "<name> wants to pair with this desk · <address>", 3+3 digits, "Approve only if that same number is on the other screen", Deny / "Numbers match, approve" → api.answerPair(false/true)
10. RemoteDialog.tsx:1077-1120 paired list: Connected/Connecting…, Connect/Disconnect → api.connectRemote(id,…), Forget → api.forgetRemote(id)
11. RemoteDialog.tsx:1140-1151 watch → api.watchRemote(id, [], on)

## Channels (src/shared/surface.ts:139-176,204)
phone:serve (setPhoneServing), phone:state, phone:port, phone:tunnel (setPhoneTunnel, t.stable), phone:answerAsk, phone:asking, phone:forget, phone:changed (onPhone);
remote:pair, remote:ask (askToPair), remote:answer (answerPair), remote:pairText, remote:pairClipboard, remote:forget.

Card title after a rename: App.tsx:5624 header shows s.title; sidebar place chip App.tsx:5141-5165 (dropped on trunk when it equals the title; full place in tooltip).
