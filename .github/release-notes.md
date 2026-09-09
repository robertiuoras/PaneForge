## Download

The files are in **Assets** at the bottom of this page. Pick one:

| File | Then |
|---|---|
| `PaneForge-Setup.exe` | Windows 10/11. Run it. No admin prompt. SmartScreen says *unknown publisher*: **More info** > **Run anyway**. |
| `PaneForge-win.zip` | Windows, no installer. Unzip anywhere, run `PaneForge.exe`. Does *not* get past Smart App Control - that blocks the unsigned exe itself, installer or not. |
| `PaneForge-arm64.dmg` | macOS (Apple Silicon). Drag to Applications, then **right-click the app > Open > Open** once. |

One command instead, on macOS - downloads, installs and clears the quarantine flag:

```bash
curl -fsSL https://raw.githubusercontent.com/robertiuoras/PaneForge/master/scripts/install.sh | bash
```

The build is not code signed (a certificate is a few hundred dollars a year), which is
the only reason either OS complains. Updates after the first install are automatic.

Everything else under Assets is machinery, not a download: the same two builds with the
version in the name, and the `latest*.yml` feeds the app's own updater reads. GitHub
decides what that list shows; the three files above are the whole of it for a person.

{{CHANGES}}
