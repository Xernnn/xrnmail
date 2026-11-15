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

# --appimage-extract-and-run with NO_CLEANUP=1: run from an extracted copy in ${TMPDIR:-/tmp}, not
# from the FUSE mount. The mount lives only as long as the AppImage's runtime process does; if that
# process goes while the app is still running, the app dies with SIGBUS the next time it reads its own
# code from the mount, as xrncal did on 2026-11-09. NO_CLEANUP keeps the extracted copy after the
# runtime exits, so a second launch that only hands over to the running app (a mailto: link, say)
# doesn't delete that app's files on its way out. Start at login (src/main/autostart.ts) does the same.
cat > "$DESKTOP_DIR/${APP_ID}.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=xrnmail
Comment=All your mail accounts in one place, delivered in batches
Exec=env NO_CLEANUP=1 "${TARGET}" --appimage-extract-and-run %U
Icon=${ICON_DIR}/${APP_ID}.png
Terminal=false
Categories=Network;Email;
MimeType=x-scheme-handler/mailto;
StartupWMClass=xrnmail
DESKTOP
chmod 644 "$DESKTOP_DIR/${APP_ID}.desktop"

# Each build extracts to its own ${TMPDIR:-/tmp}/appimage_extracted_<digest>, and NO_CLEANUP keeps it
# there, so the copies of earlier builds that no running process uses are removed.
for dir in "${TMPDIR:-/tmp}"/appimage_extracted_*; do
  [[ -x "$dir/${APP_ID}" && -f "$dir/${APP_ID}.desktop" ]] || continue
  in_use=0
  for exe in /proc/[0-9]*/exe; do
    if [[ "$(readlink "$exe" 2>/dev/null)" == "$dir/"* ]]; then
      in_use=1
      break
    fi
  done
  (( in_use )) || rm -rf -- "$dir"
done

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed: $TARGET"
echo "To have mail links open here: xdg-mime default ${APP_ID}.desktop x-scheme-handler/mailto"
