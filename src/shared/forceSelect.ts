// Dragging a highlight in a pane whose CLI has taken the mouse.
//
// Claude Code and Codex both turn mouse reporting on, and xterm then hands the mouse to
// them: `Terminal.ts` refuses to start a selection while `coreMouseService.areMouseEventsActive`
// unless `SelectionService.shouldForceSelection(ev)` says otherwise. That function is the
// whole of this file's reason to exist:
//
//   shouldForceSelection(event) {
//     if (Browser.isMac) return event.altKey && rawOptions.macOptionClickForcesSelection
//     return event.shiftKey
//   }
//
// So the modifier that means "this drag is a selection, not the app's mouse" is NOT the
// same key on the two machines, and `macOptionClickForcesSelection` is off by default.
// The pane marks a plain drag with that modifier before xterm sees the event, which is
// what makes a drag select in an agent pane at all - and it was marking SHIFT only. On
// the Mac that is read by nothing: every drag over a Codex or Claude Code pane went to
// the CLI and selected nothing, on a machine where the whole gesture is how you copy a
// line out of an answer.
//
// `npm run test:forceselect`.

/** What a plain drag must be dressed up as for xterm to select instead of forwarding it. */
export interface ForceKeys {
  shiftKey?: true
  altKey?: true
}

/**
 * The modifiers to stamp on a mousedown so xterm forces a selection.
 *
 * Both are set rather than the one this platform reads: the answer is applied to an event
 * that xterm judges with its OWN idea of the platform, and a renderer that disagrees with
 * it about that (an Electron window is not always what `navigator` says, and the phone's
 * client is a browser on a third machine) would otherwise stamp the key nothing reads.
 * Stamping both is right on either answer, and no PaneForge handler reads the event after
 * this - see the registration order in `TerminalPane.tsx`.
 */
export function forceKeys(): ForceKeys {
  return { shiftKey: true, altKey: true }
}

/**
 * Whether xterm would force a selection for this mousedown, given the platform it thinks
 * it is on and whether the pane asked for the mac option-click behaviour. The rule above,
 * repeated here so the test can prove the stamp against it rather than against a comment.
 */
export function wouldForce(
  e: { shiftKey: boolean; altKey: boolean },
  isMac: boolean,
  macOptionClickForcesSelection: boolean
): boolean {
  if (isMac) return e.altKey && macOptionClickForcesSelection
  return e.shiftKey
}
