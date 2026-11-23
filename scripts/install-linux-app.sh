#!/usr/bin/env bash
# Build xrnmail and (re)install it as a clickable desktop app for this user. Run it again to update.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_ID="xrnmail"
APPS_DIR="$HOME/Applications"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons"
TARGET="$APPS_DIR/${APP_ID}.AppImage"
# Where the launcher has the AppImage extract itself (TMPDIR below): xrnmail's own folder in the
# cache, on disk. Start at login (src/main/autostart.ts) uses the same one.
UNPACK_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/${APP_ID}"

npm run pack:linux

SOURCE="$(find dist -maxdepth 1 -name '*.AppImage' -type f -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)"
if [[ -z "${SOURCE:-}" ]]; then
  echo "No .AppImage in dist/." >&2
  exit 1
fi

mkdir -p "$APPS_DIR" "$DESKTOP_DIR" "$ICON_DIR"
install -d -m 700 "$UNPACK_DIR"

# Written beside the target and renamed over it: a running AppImage is mounted from this exact file,
# and truncating it would corrupt the app in use. A rename leaves that copy running.
TEMP="$(mktemp "${TARGET}.new.XXXXXX")"
install -m 755 "$SOURCE" "$TEMP"
mv -f "$TEMP" "$TARGET"
install -m 644 resources/icon.png "$ICON_DIR/${APP_ID}.png"

# --appimage-extract-and-run with NO_CLEANUP=1: run from an extracted copy in UNPACK_DIR, not
# from the FUSE mount. The mount lives only as long as the AppImage's runtime process does; if that
# process goes while the app is still running, the app dies with SIGBUS the next time it reads its own
# code from the mount, as xrncal did on 2026-11-09. NO_CLEANUP keeps the extracted copy after the
# runtime exits, so a second launch that only hands over to the running app (a mailto: link, say)
# doesn't delete that app's files on its way out. Start at login (src/main/autostart.ts) does the same.
#
# TMPDIR: the runtime extracts into $TMPDIR/appimage_extracted_<MD5 of the AppImage>, so this puts the
# copy in UNPACK_DIR, on disk. In /tmp, which is memory here, each build held about 300 MB of RAM
# until a restart, and systemd-tmpfiles removes /tmp files untouched for 10 days, from under an app
# left running that long. xrnmail gets this TMPDIR too: Chromium's single-instance socket and the
# attachments being looked at go in the same user-only folder, and a second launch still finds the
# running app through the link to that socket in its profile.
cat > "$DESKTOP_DIR/${APP_ID}.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=xrnmail
Comment=All your mail accounts in one place, delivered in batches
Exec=env NO_CLEANUP=1 "TMPDIR=${UNPACK_DIR}" "${TARGET}" --appimage-extract-and-run %U
Icon=${ICON_DIR}/${APP_ID}.png
Terminal=false
Categories=Network;Email;
MimeType=x-scheme-handler/mailto;message/rfc822;
StartupWMClass=xrnmail
DESKTOP
chmod 644 "$DESKTOP_DIR/${APP_ID}.desktop"

# Each build extracts to its own folder and NO_CLEANUP keeps it, so the copies of earlier builds that
# nothing uses are removed: no process runs from one, works in one or has one of its files mapped. The
# copy a running xrnmail uses stays, whichever build it is, and so does this build's, which a launch may
# be extracting right now. The same goes for the copies launchers before this one extracted into
# ${TMPDIR:-/tmp}, where only xrnmail's own are touched.
CURRENT_COPY="$UNPACK_DIR/appimage_extracted_$(md5sum "$TARGET" | cut -d' ' -f1)"
IN_USE="$( { find /proc/[0-9]*/exe /proc/[0-9]*/cwd -maxdepth 0 -printf '%l\n'; cat /proc/[0-9]*/maps; } 2>/dev/null || true)"
for dir in "$UNPACK_DIR"/appimage_extracted_* "${TMPDIR:-/tmp}"/appimage_extracted_*; do
  [[ -d "$dir" && "$dir" != "$CURRENT_COPY" ]] || continue
  [[ "$dir" == "$UNPACK_DIR"/* || ( -x "$dir/${APP_ID}" && -f "$dir/${APP_ID}.desktop" ) ]] || continue
  if grep -qF -- "$dir/" <<<"$IN_USE" || grep -qxF -- "$dir" <<<"$IN_USE"; then
    continue
  fi
  rm -rf -- "$dir"
done

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

echo "Installed: $TARGET"
echo "To have mail links open here: xdg-mime default ${APP_ID}.desktop x-scheme-handler/mailto"
