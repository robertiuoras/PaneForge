; Extra steps for the Windows installer: leave exactly one PaneForge behind.
;
; electron-builder already uninstalls the previous version of the SAME product before
; installing - what it cannot know about is the other copy this project can produce.
; `scripts/install.ps1` falls back to the portable zip when Smart App Control is
; enforcing, and that unpacks to `%LOCALAPPDATA%\Programs\PaneForge` while the NSIS build
; installs to `%LOCALAPPDATA%\Programs\claude-orchestrator` (the directory comes from
; package.json's `name`, which stays `claude-orchestrator` on purpose - see CLAUDE.md).
; Install both ways over a year and you end up with two PaneForges, two Desktop shortcuts,
; two update checkers and two single-instance locks that do not know about each other.
;
; So: before installing, close anything running and delete the portable copy and its
; shortcut. `customInit` runs before files are laid down; `customUnInstall` mirrors it so
; uninstalling really does remove PaneForge rather than half of it.

!macro killRunning
  ; taskkill rather than nsProcess: no plugin to vendor, and /T takes the pane consoles
  ; and the agent processes under them, which are what actually hold the exe open.
  nsExec::Exec 'taskkill /F /T /IM PaneForge.exe'
  Pop $0
  Sleep 400
!macroend

!macro removePortable
  ; Only the portable layout: the NSIS install lives under `claude-orchestrator` and is
  ; handled by the built-in uninstall of the previous version.
  ;
  ; The Delete USED TO SIT OUTSIDE THIS GUARD, and that is a bug worth naming: `IfFileExists
  ; ... 0 +2` skips exactly one instruction, so it covered the RMDir and nothing else. The
  ; Desktop shortcut was therefore deleted on every run of this installer, portable copy or
  ; not - and this macro runs from `customInit` AND from `customUnInstall`, which is the old
  ; version's uninstaller during an ordinary update. A shortcut that vanishes after an
  ; update reads as "the app uninstalled itself". Both are inside the block now, and the app
  ; puts a missing shortcut back on launch anyway (src/main/winShortcut.ts).
  ; LogicLib, not a jump and not a label. `+N` is what caused the bug above, and the first
  ; attempt at fixing it - a label named with ${__LINE__} - failed the Windows build
  ; outright: inside a macro that token expands to `239.1.11`, and an NSIS label may not
  ; contain a dot ("could not resolve label portableGone_239.1.11 in uninstall section").
  ; A label would also have to be unique across BOTH insertions of this macro. ${If} has
  ; neither problem and says what it means; electron-builder already includes LogicLib in
  ; the installer and the uninstaller.
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\PaneForge\PaneForge.exe"
    RMDir /r "$LOCALAPPDATA\Programs\PaneForge"
    Delete "$DESKTOP\PaneForge.lnk"
  ${EndIf}
!macroend

!macro customInit
  !insertmacro killRunning
  !insertmacro removePortable
!macroend

!macro customUnInit
  !insertmacro killRunning
!macroend

!macro customUnInstall
  !insertmacro removePortable
!macroend
