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
  ; taskkill rather than nsProcess: no plugin to vendor.
  ;
  ; Never /T. An update's installer is a CHILD of the app: electron-updater starts it and
  ; only then quits, so while the app is still closing, `taskkill /T /IM PaneForge.exe`
  ; takes the installer down with the app's tree - nothing is installed and nothing starts
  ; the app again. Measured on the PC 2026-10-01 with a stand-in parent and a detached
  ; child running this line: with /T the child died, without it the child lived and the
  ; parent still went. The PC sat on v0.8.231 that way, its app quitting to install every
  ; two minutes and coming back only because a keep-alive relaunched the old version.
  ;
  ; Again until none is left (128 = no PaneForge.exe running), at most 10 passes. One pass
  ; is not enough: the app runs its own scripts on its own exe (lane.mjs, pf-ctl.mjs), and a
  ; script killed while it was starting a child leaves that child created SUSPENDED and
  ; never resumed - after taskkill had already listed the processes. On the PC on 2026-09-30
  ; such a `PaneForge.exe pf-ctl.mjs list` stub outlived the update, held the exe, and read
  ; as "PaneForge is running" to the PC's keep-alive for 34 hours with no app up. A second
  ; pass kills it: a suspended process ends like any other.
  Push $1
  StrCpy $1 0
  killRunningAgain:
    nsExec::Exec 'taskkill /F /IM PaneForge.exe'
    Pop $0
    StrCmp $0 "128" killRunningDone
    Sleep 400
    IntOp $1 $1 + 1
    IntCmp $1 10 killRunningDone killRunningAgain killRunningDone
  killRunningDone:
  Pop $1
!macroend

!macro freeInstallDir
  ; killRunning names one exe. Everything else that runs out of the install folder - node-pty's
  ; OpenConsole.exe, elevate.exe, a stray PaneForge helper - can still hold a file; then
  ; the old version's uninstall can fail, and the stock app-running check quits a SILENT install
  ; without a word: the update never happens (2026-09-24, a friend stuck on v0.8.179). So stop
  ; every process whose exe lives under $INSTDIR or the portable folder, and wait (10s at most)
  ; until they are gone. This runs from the NEW release's installer, so it also rescues builds
  ; that shipped before it. The script is `scripts/win-free-install-dir.ps1`, tested on its own.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\pf-free-install-dir.ps1" "${PROJECT_DIR}\scripts\win-free-install-dir.ps1"
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pf-free-install-dir.ps1" -Dir "$INSTDIR" -Also "$LOCALAPPDATA\Programs\PaneForge" -Seconds 10'
  Pop $0
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
  !insertmacro freeInstallDir
  !insertmacro removePortableAndShortcut
!macroend

!macro customUnInit
  !insertmacro killRunning
!macroend

!macro customUnInstall
  !insertmacro removePortableOnly
!macroend
