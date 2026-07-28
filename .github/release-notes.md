## Download

| | Download | Then |
|---|---|---|
| **Windows 10/11** | [**PaneForge-Setup.exe**](https://github.com/robertiuoras/PaneForge/releases/latest/download/PaneForge-Setup.exe) | Run it. No admin prompt. SmartScreen says *unknown publisher*: **More info** > **Run anyway**. |
| Windows, no installer | [PaneForge-win.zip](https://github.com/robertiuoras/PaneForge/releases/latest/download/PaneForge-win.zip) | Unzip anywhere, run `PaneForge.exe`. Use this if Smart App Control blocks the installer. |
| **macOS (Apple Silicon)** | [**PaneForge-arm64.dmg**](https://github.com/robertiuoras/PaneForge/releases/latest/download/PaneForge-arm64.dmg) | Drag to Applications, then **right-click the app > Open > Open** once. |
| macOS, one command | (none to click) | `curl -fsSL https://raw.githubusercontent.com/robertiuoras/PaneForge/master/scripts/install.sh \| bash` - downloads, installs and clears the quarantine flag for you. |

The build is not code signed (a certificate is a few hundred dollars a year), which is
the only reason either OS complains. Updates after the first install are automatic.

The four links above always point at the newest release, so they keep working.
The `*-{{VERSION}}-*` files below are the same builds with the version in the name, and
`latest.yml` / `latest-mac.yml` are the feed the app's own updater reads.

New in this build: see the [commit history](https://github.com/robertiuoras/PaneForge/commits/v{{VERSION}}).
