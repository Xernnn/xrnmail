#!/bin/sh
# Installs or updates xrnmail-sync on a home server reached over ssh (Termux with runit and
# Tailscale Funnel), next to the other sync services. Safe to run again: an update replaces the
# program and its run script, restarts it and leaves the data alone.
#
#     server/deploy.sh [ssh-host]      (default: homeserver)
#
# Port 5243, Funnel path /xrnmail, data in ~/xrnmail-sync/data, login from the shared
# ~/.config/xrn-sync/users. Only settings and per-thread choices are kept there, never mail.
set -eu

HOST=${1:-homeserver}
HERE=$(cd "$(dirname "$0")" && pwd)
PORT=5243

echo "Testing the server code first..."
# test_deploy.py runs this script itself, so it isn't one of them.
if ! (cd "$HERE/.." && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest server/test_xrnmail_sync.py >/dev/null 2>&1); then
    echo "The server tests failed, so nothing was changed. Run them for details:" >&2
    echo "    python3 -m unittest server/test_xrnmail_sync.py" >&2
    exit 1
fi

# What it did, said again at the end.
did=""
# Shows the phone's lines as they come back and keeps them for the end.
report() {
    if [ -n "$1" ]; then
        printf '%s\n' "$1" | sed 's/^/  /'
        did="$did$1
"
    fi
}

echo "Checking $HOST..."
ssh "$HOST" '
    GUARD=$HOME/.local/bin/sv-guard
    if [ ! -x "$GUARD" ]; then
        echo "$GUARD is missing, and the run script calls it before it starts the program, so nothing" >&2
        echo "was changed. Put it there with phone/install-sv-guard from the home-server repo, then run this again." >&2
        exit 1
    fi
'

echo "Copying it to $HOST..."
tar czf - -C "$HERE" xrnmail-sync.py | ssh "$HOST" '
    set -e
    mkdir -p ~/xrnmail-sync/data
    chmod 700 ~/xrnmail-sync ~/xrnmail-sync/data
    cd ~/xrnmail-sync
    tar xzf -
    chmod 755 xrnmail-sync.py
'

echo "Setting up the service..."
report "$(ssh "$HOST" '
    set -e
    S=$PREFIX/var/service
    export SVDIR=$S
    # Written each time, so the service always runs as this script says.
    run() {
        cat <<EOS
#!$PREFIX/bin/sh
# xrnmail sync: the settings and snoozes xrnmail keeps in step between devices, never mail
# (see ~/xrnmail-sync and the home-server README).
# Login is ~/.config/xrn-sync/users, shared with the other xrn sync services.
$HOME/.local/bin/sv-guard '"$PORT"' $HOME/xrnmail-sync/xrnmail-sync.py || exit 1
exec python $HOME/xrnmail-sync/xrnmail-sync.py \\
  --port '"$PORT"' --data $HOME/xrnmail-sync/data \\
  --users $HOME/.config/xrn-sync/users 2>&1
EOS
    }
    if [ -d "$S/xrnmail-sync" ]; then
        run > "$S/xrnmail-sync/run.new"
        chmod 755 "$S/xrnmail-sync/run.new"
        mv "$S/xrnmail-sync/run.new" "$S/xrnmail-sync/run"
        sv restart xrnmail-sync >/dev/null
        echo "restarted xrnmail-sync with this program"
        exit 0
    fi
    # Built under a dot name, which runit ignores, so it never starts half written.
    T=$S/.xrnmail-sync.new
    rm -rf "$T"
    mkdir -p "$T/log"
    run > "$T/run"
    # Written out, not copied from a sibling service: a fresh phone has none to copy.
    printf "#!%s/bin/sh\nmkdir -p \"%s/var/log/sv/xrnmail-sync\"\nexec svlogd -tt \"%s/var/log/sv/xrnmail-sync\"\n" \
        "$PREFIX" "$PREFIX" "$PREFIX" > "$T/log/run"
    chmod 755 "$T/run" "$T/log/run"
    chmod 700 "$T" "$T/log"
    mv "$T" "$S/xrnmail-sync"
    echo "installed the xrnmail-sync service, on port '"$PORT"'"
')"

echo "Waiting for it to answer..."
tries=0
until [ "$(ssh "$HOST" "curl -s -m 3 http://127.0.0.1:$PORT/health" || true)" = ok ]; do
    tries=$((tries + 1))
    if [ "$tries" -ge 8 ]; then
        echo "It did not start. Its log:" >&2
        ssh "$HOST" 'tail -20 $PREFIX/var/log/sv/xrnmail-sync/current' >&2 || true
        exit 1
    fi
    sleep 2
done
report "it answers on 127.0.0.1:$PORT/health"

# `funnel`, never `serve`: serve rewrites the port as tailnet-only and takes the calendar offline.
echo "Publishing /xrnmail..."
report "$(ssh "$HOST" '
    set -e
    tailscale funnel --bg --set-path /xrnmail http://127.0.0.1:'"$PORT"' >/dev/null
    echo "published /xrnmail, to port '"$PORT"'"
')"
ssh "$HOST" 'tailscale funnel status'

echo
echo "Done. What it did:"
printf '%s' "$did" | sed 's/^/  - /'
