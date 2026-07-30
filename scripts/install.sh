#!/usr/bin/env bash
# One-command install for macOS (Apple Silicon):
#
#   curl -fsSL https://raw.githubusercontent.com/robertiuoras/PaneForge/master/scripts/install.sh | bash
#
# Downloads the newest release, puts PaneForge in /Applications and clears the
# quarantine flag, which is the only reason an unsigned app needs the
# right-click > Open dance. Nothing is installed system-wide and nothing runs as
# root; re-run it any time to force an update.

set -euo pipefail

REPO="robertiuoras/PaneForge"
APP="/Applications/PaneForge.app"
ASSET="PaneForge-arm64.zip"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows use scripts/install.ps1 or the .exe from the releases page."

if [ "$(uname -m)" != "arm64" ]; then
  die "Only Apple Silicon (M1 and later) builds are published. On an Intel Mac, build it yourself: git clone https://github.com/$REPO && npm install && npm run setup"
fi

# Installing leaves exactly one PaneForge behind. A running copy is asked to quit the
# polite way first (so panes are torn down and state is written), then killed if it is
# still there - its own bundle cannot be replaced underneath it.
if pgrep -x PaneForge >/dev/null 2>&1; then
  say "Closing the PaneForge that is already running ..."
  osascript -e 'quit app "PaneForge"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x PaneForge >/dev/null 2>&1 || break
    sleep 0.5
  done
  pgrep -x PaneForge >/dev/null 2>&1 && pkill -x PaneForge >/dev/null 2>&1
  sleep 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/$REPO/releases/latest/download/$ASSET"
say "Downloading $ASSET ..."
curl -fL --progress-bar -o "$tmp/app.zip" "$url" || die "Download failed: $url"

say "Unpacking ..."
ditto -x -k "$tmp/app.zip" "$tmp/out" || die "Could not unpack the download."
[ -d "$tmp/out/PaneForge.app" ] || die "The download did not contain PaneForge.app."

# Every place a PaneForge can end up, not just /Applications: a bundle dragged to the
# per-user ~/Applications, and the one left in ~/Downloads by an earlier zip - which is
# the copy Spotlight and the Dock keep finding after an "update", so the version people
# then report is the old one. The staged half-updates under Application Support go too;
# `macUpdate.ts` adopts anything it finds there on the next launch.
for old in "$APP" "$HOME/Applications/PaneForge.app" "$HOME/Downloads/PaneForge.app"; do
  if [ -e "$old" ]; then
    say "Removing the previous copy at $old ..."
    rm -rf "$old"
  fi
done
rm -rf "$HOME/Library/Application Support/claude-orchestrator/mac-update" 2>/dev/null || true

say "Installing to $APP ..."
ditto "$tmp/out/PaneForge.app" "$APP"

# The app is not notarised (that needs a paid Apple developer account), so
# Gatekeeper would otherwise refuse the first launch outright.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

version=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
say "PaneForge $version installed. Opening it."
open "$APP"
