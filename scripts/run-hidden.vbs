' run-hidden.vbs <exe> [args...] - run the command completely hidden, without waiting.
'
' Why this exists (measured 2026-08-01, PC): Node's `windowsHide: true` is IGNORED for
' detached console spawns once Windows Terminal is the default terminal - Win11
' delegates the child to a visible Terminal window regardless of CREATE_NO_WINDOW, so
' every detached hook spawn popped a window over Robert's game. `conhost --headless`
' looks like a fix but silently never executes its child on this build (26200).
' WScript.Shell.Run with window style 0 (SW_HIDE semantics) both executes and stays
' invisible - proven with a window-watcher plus marker files. wscript.exe itself is a
' GUI app, so no layer of this ever owns a console window.
'
' Each argument is quote-wrapped; arguments must not themselves contain double quotes.
Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & """" & WScript.Arguments(i) & """"
Next
If cmd <> "" Then sh.Run cmd, 0, False
