# One-command install for Windows 10/11:
#
#   irm https://raw.githubusercontent.com/robertiuoras/PaneForge/master/scripts/install.ps1 | iex
#
# Downloads the newest release and installs it for the current user (no admin
# prompt). If Smart App Control is enforcing - which blocks any unsigned
# installer, silently and with no way to allow it per-app - this falls back to
# the portable zip automatically instead of failing the way the .exe does.

$ErrorActionPreference = 'Stop'
$repo = 'robertiuoras/PaneForge'

function Say($msg) { Write-Host $msg -ForegroundColor Cyan }

if ((Get-Process PaneForge -ErrorAction SilentlyContinue)) {
  Write-Host 'PaneForge is running. Close it first, then run this again.' -ForegroundColor Yellow
  return
}

# 0 = off, 1 = enforcing, 2 = evaluation. Enforcing is the one that blocks us.
$sac = 0
try {
  $sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction Stop).VerifiedAndReputablePolicyState
} catch {}

$tmp = Join-Path $env:TEMP ("paneforge-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  if ($sac -eq 1) {
    Say 'Smart App Control is enforcing, so the installer would be blocked. Using the portable build instead.'
    $dest = Join-Path $env:LOCALAPPDATA 'Programs\PaneForge'
    $zip = Join-Path $tmp 'PaneForge-win.zip'

    Say 'Downloading PaneForge-win.zip ...'
    Invoke-WebRequest "https://github.com/$repo/releases/latest/download/PaneForge-win.zip" -OutFile $zip -UseBasicParsing

    Say "Unpacking to $dest ..."
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $dest -Force

    $exe = Join-Path $dest 'PaneForge.exe'
    if (-not (Test-Path $exe)) { throw "The download did not contain PaneForge.exe" }

    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PaneForge.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = $exe
    $s.WorkingDirectory = $dest
    $s.Save()

    Say 'Installed. Opening PaneForge (shortcut is on the Desktop).'
    Start-Process $exe
  }
  else {
    $exe = Join-Path $tmp 'PaneForge-Setup.exe'
    Say 'Downloading PaneForge-Setup.exe ...'
    Invoke-WebRequest "https://github.com/$repo/releases/latest/download/PaneForge-Setup.exe" -OutFile $exe -UseBasicParsing

    Say 'Installing (current user, no admin prompt) ...'
    # /S is the NSIS silent switch: no setup window, no SmartScreen prompt,
    # because we are launching it rather than Explorer.
    $p = Start-Process $exe -ArgumentList '/S' -PassThru -Wait
    if ($p.ExitCode -ne 0) { throw "The installer exited with code $($p.ExitCode)." }
    Say 'Installed. PaneForge is on the Desktop and in the Start Menu, and should be opening now.'
  }
}
finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
