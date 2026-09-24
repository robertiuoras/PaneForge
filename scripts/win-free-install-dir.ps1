# Stop everything still running out of PaneForge's install folder, and wait until it is gone.
#
# Run by the Windows installer (`build/installer.nsh`, customInit) before it touches a file.
# `taskkill /IM PaneForge.exe` only reaches processes by that name. The install folder also
# ships node-pty's OpenConsole.exe, elevate.exe and the uninstaller, and a pane's console
# host outlives the app when nobody drains its pipe (see src/main/consoles.ts). Any of them
# still holding a file makes the old version's uninstall fail, and the stock "is the app
# running" check answers its own "cannot close" box with Cancel in a silent install - the
# update simply does not happen, and PaneForge comes back as the old version. 2026-09-24.
#
# Matches by the process's executable path, so a PaneForge running from anywhere else (a
# dev copy, another install) is left alone. Exit 0 = the folder is free, 1 = something
# was still running when the time ran out (the installer carries on either way).
#
# Two plain [string] folders rather than one [string[]]: `powershell -File` hands every
# argument over as one string, so an array parameter would arrive as a single path.
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Also = '',
  [int]$Seconds = 10
)

$roots = @(@($Dir, $Also) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') + '\' })
$deadline = (Get-Date).AddSeconds($Seconds)

function Get-Holders {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $exe = $_.ExecutablePath
    $_.ProcessId -ne $PID -and $exe -and ($roots | Where-Object { $exe.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })
  }
}

while ($true) {
  $left = @(Get-Holders)
  if ($left.Count -eq 0) { exit 0 }
  if ((Get-Date) -ge $deadline) {
    $left | ForEach-Object { Write-Output "still running: $($_.ProcessId) $($_.ExecutablePath)" }
    exit 1
  }
  $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
}
