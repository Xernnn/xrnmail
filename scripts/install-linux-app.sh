#!/usr/bin/env bash
# Build xrnmail and (re)install it as a clickable desktop app for this user. Run it again to update.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_ID="xrnmail"
APPS_DIR="$HOME/Applications"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons"
TARGET="$APPS_DIR/${APP_ID}.AppImage"

npm run pack:linux

SOURCE="$(find dist -maxdepth 1 -name '*.AppImage' -type f -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [[ -z "${SOURCE:-}" ]]; then
  echo "No .AppImage in dist/." >&2
  exit 1
fi

mkdir -p "$APPS_DIR" "$DESKTOP_DIR" "$ICON_DIR"

# Written beside the target and renamed over it: a running AppImage is mounted from this exact file,
# and truncating it would corrupt the app in use. A rename leaves that copy running.
TEMP="$(mktemp "${TARGET}.new.XXXXXX")"
install -m 755 "$SOURCE" "$TEMP"
mv -f "$TEMP" "$TARGET"
install -m 644 resources/icon.png "$ICON_DIR/${APP_ID}.png"

cat > "$DESKTOP_DIR/${APP_ID}.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=xrnmail
Comment=Your Gmail, delivered in batches
Exec="${TARGET}" %U
Icon=${ICON_DIR}/${APP_ID}.png
Terminal=false
Categories=Network;Email;
StartupWMClass=xrnmail
DESKTOP
chmod 644 "$DESKTOP_DIR/${APP_ID}.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed: $TARGET"
