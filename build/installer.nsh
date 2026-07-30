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
  IfFileExists "$LOCALAPPDATA\Programs\PaneForge\PaneForge.exe" 0 +2
    RMDir /r "$LOCALAPPDATA\Programs\PaneForge"
  Delete "$DESKTOP\PaneForge.lnk"
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
