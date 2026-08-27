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

!macro removePortableOnly
  ; Remove only the portable directory, not the shortcut. This runs during customUnInstall
  ; (uninstall / update). If we delete the shortcut during uninstall-for-update, it would
  ; vanish before the new version has a chance to recreate it, leaving the user without a
  ; shortcut after an update. The app recreates missing shortcuts on launch (src/main/winShortcut.ts).
  ;
  ; Only the portable layout: the NSIS install lives under `claude-orchestrator` and is
  ; handled by the built-in uninstall of the previous version. This uses a named label
  ; (not relative jump like `0 +2`) to ensure clear scope: the label is scoped to the function
  ; it is in (NSIS design), so the label name can be fixed (never conflicts between insertions
  ; in different functions).
  IfFileExists "$LOCALAPPDATA\Programs\PaneForge\PaneForge.exe" 0 portableDirGone
    RMDir /r "$LOCALAPPDATA\Programs\PaneForge"
  portableDirGone:
!macroend

!macro removePortableAndShortcut
  ; Remove portable directory AND desktop shortcut. This runs during customInit (install).
  ; We can safely delete the shortcut here because the new version will recreate it on launch.
  ;
  ; Uses named label (not relative jump like `0 +2`) to ensure the guard covers both
  ; the RMDir and Delete instructions. Previously, a relative jump `0 +2` would skip only
  ; the RMDir, causing the Delete to run unconditionally even when the portable copy did
  ; not exist - the shortcut would vanish on every installer run.
  IfFileExists "$LOCALAPPDATA\Programs\PaneForge\PaneForge.exe" 0 portableGone
    RMDir /r "$LOCALAPPDATA\Programs\PaneForge"
    Delete "$DESKTOP\PaneForge.lnk"
  portableGone:
!macroend

!macro customInit
  !insertmacro killRunning
  !insertmacro removePortableAndShortcut
!macroend

!macro customUnInit
  !insertmacro killRunning
!macroend

!macro customUnInstall
  !insertmacro removePortableOnly
!macroend
