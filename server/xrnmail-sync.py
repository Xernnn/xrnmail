#!/usr/bin/env python3
"""xrnmail sync server: what xrnmail's devices keep in step, behind HTTP Basic auth.

xrnmail reads mail from each mail service directly, on every device; mail never comes here. What
does is what the person chose: the settings both the laptop and the phone follow (batch times,
straight-through and Summary senders, blocked and muted senders, signatures, templates, swipes,
undo times and the rest), and per thread the snoozes, reminders and pins, so a thread snoozed on
the phone is away on the laptop too. One JSON document per user, which a device sends whole after
a change, with If-Match, so one that never synced (or was reinstalled) can't wipe the copy here by
accident: it has to take this copy and merge, or say on purpose that its own replaces it
(If-Match: *). Made to run on a small home server, published under a path (/xrnmail) by a reverse
proxy such as Tailscale Funnel, which may or may not strip that prefix. Standard library only,
plus `bcrypt` to read the htpasswd file the other xrn servers share.

    GET  /state               200, the document; ETag: "<version>" (0 while there is none)
                              If-None-Match: "<version>" -> 304 when unchanged
                              ?wait=S with If-None-Match waits up to S seconds (at most 30) for a
                              change before answering 304, so an open app hears of another
                              device's change at once
    PUT  /state               needs If-Match: "<version>" (or "*"); 200 with the new ETag, or
                              412 if the copy here isn't the one the device last saw. The body
                              may come gzipped (Content-Encoding: gzip), and /state answers say
                              so (Accept-Encoding: gzip)
    GET  /versions            the earlier copies kept here, newest first, as a JSON list of
                              {id, version, updated, by}
    GET  /versions/<id>       one earlier copy
    GET  /update/<file>       the phone app's releases (app.json and the .apk), put in
                              <data>/update by the release script
    GET  /health              200 "ok", no login (for monitoring)
    HEAD                      any GET above, answered without its body

The document is an object of {"schema": n, "settings": {...}, "threads": {...}, "early": {...}};
what's inside each is the apps' business (xrnmail's docs/design.md, "Shared with the phone"). Only
its outline is checked here, and its depth.

/state answers carry X-Content-SHA256, the hash of the body as it was sent, so a device whose
write landed but whose answer was lost can tell that apart from someone else having written. And
X-Tag, a name each write gets at random, with every copy keeping the tags of the ones it was
written on top of: a device sends the tag of the copy it last saw as X-Base-Tag, and a 200 says in
X-Follows (1 or 0) whether this copy was written on top of it. A version number alone can't tell
copies apart once the data here has been restored from a backup and written to again.

Every write keeps the copy it replaces: the last KEEP_VERSIONS of them in history/, and the first
of each day in daily/ for KEEP_DAYS.

    python3 xrnmail-sync.py --data ~/xrnmail-sync/data --users ~/.config/xrn-sync/users
"""
import argparse
import base64
import hashlib
import ipaddress
import json
import math
import os
import re
import secrets
import select
import shutil
import socket
import sys
import threading
import time
import zlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

# Signatures may hold their pictures as data: addresses, so a few megabytes is honest use.
MAX_BODY = 8 * 1024 * 1024
# How many lists and objects deep a document may go. The apps' own nest a handful; json.dump gives
# up near a thousand (the recursion limit), while json.loads takes thousands, more on Python 3.14.
MAX_DEPTH = 32
FAIL_DELAY_S = 2  # after a wrong password
AUTH_CACHE_S = 600  # a bcrypt check costs ~0.3s on a phone; don't pay it per request
FAIL_LIMIT = 10  # wrong logins from one address within FAIL_WINDOW_S, then 429 until they age out
FAIL_WINDOW_S = 15 * 60
MAX_WAIT_S = 30  # Funnel and phones' networks drop a quiet connection not long after
GONE_CHECK_S = 1  # how often a long-poll looks whether its caller has gone
KEEP_VERSIONS = 20
KEEP_DAYS = 60
KEEP_TAGS = 1000  # a device this many writes behind is asked, as it can't be told it's on the same line
PREFIX = "/xrnmail"
USER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
HISTORY_ID = re.compile(r"\d{1,12}")
DAILY_ID = re.compile(r"\d{4}-\d{2}-\d{2}")
# What the document holds at its top, and what each must be.
PARTS = {"schema": int, "settings": dict, "threads": dict, "early": dict}
# What /update/ may serve: a plain file name, no path, no leading dot.
UPDATE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.(?:json|apk)")
UPDATE_TYPES = {
    ".json": "application/json; charset=utf-8",
    ".apk": "application/vnd.android.package-archive",
}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}

args = None
lock = threading.Lock()  # state.json, history/ and daily/
changed = threading.Condition(lock)  # a write has landed
auth_cache = {}  # sha256(user:password) -> (user, expires, users-file mtime)
fail_lock = threading.Lock()
fail_settled = threading.Condition(fail_lock)  # a login being checked has been settled
failures = {}  # client address -> (monotonic time, user name tried) of its recent wrong logins
checking = {}  # client address -> how many of its logins are being checked right now


class Unreadable(Exception):
    """state.json is there but can't be read. Answered as such, never as an empty copy: an empty
    answer looks like "everything was deleted", and a device would merge that in and write it."""


def users_mtime():
    try:
        return os.stat(args.users).st_mtime
    except OSError:
        return 0


def basic_login(header):
    """(user, password) from `Authorization: Basic ...`, or None."""
    if not header or not header.startswith("Basic "):
        return None
    try:
        user, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
    except Exception:
        return None
    return user, password


def cached_login(header):
    """The user name for a password already found right (the auth cache), else None: no check."""
    login = basic_login(header)
    if not login:
        return None
    hit = auth_cache.get(hashlib.sha256(f"{login[0]}:{login[1]}".encode()).hexdigest())
    return hit[0] if hit and hit[1] > time.time() and hit[2] == users_mtime() else None


def check_login(header):
    """The user name for a valid `Authorization: Basic ...`, else None."""
    login = basic_login(header)
    if not login:
        return None
    user, password = login
    if not USER_NAME.fullmatch(user):  # it names a folder here
        return None
    key = hashlib.sha256(f"{user}:{password}".encode()).hexdigest()
    mtime = users_mtime()
    hit = auth_cache.get(key)
    if hit and hit[1] > time.time() and hit[2] == mtime:
        return hit[0]
    import bcrypt  # only needed once someone logs in

    try:
        checked, spare = False, None
        with open(args.users, encoding="utf-8") as f:
            for line in f:
                name, _, hashed = line.strip().partition(":")
                spare = hashed or spare
                if name == user and hashed:
                    checked = True
                    if bcrypt.checkpw(password.encode(), hashed.encode()):
                        now = time.time()
                        if len(auth_cache) > 1000:  # passwords changed often: forget the stale ones
                            for k in [k for k, v in auth_cache.items() if v[1] <= now or v[2] != mtime]:
                                del auth_cache[k]
                        auth_cache[key] = (user, now + AUTH_CACHE_S, mtime)
                        return user
        if not checked and spare:
            # A name that isn't there takes as long as a wrong password for one that is, or
            # the time an answer takes says which names exist. The result is never used.
            bcrypt.checkpw(password.encode(), spare.encode())
    except (OSError, ValueError):
        pass
    return None


def client_address(handler):
    """Who a wrong login is counted for. Behind the local proxy (Funnel) that's the last
    X-Forwarded-For hop, the one the proxy added: anything before it came from the caller, who
    could make up a new address for every guess. The header is only trusted from a loopback peer,
    for the same reason. An IPv6 address counts as its /64: a line comes with at least that many,
    so counted one by one its owner had a new address for every guess and never reached the limit."""
    peer = handler.client_address[0]
    forwarded = handler.headers.get("X-Forwarded-For")
    addr = forwarded.split(",")[-1].strip() if forwarded and peer in ("127.0.0.1", "::1") else peer
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return addr
    if ip.version == 4:
        return addr
    if ip.ipv4_mapped:
        return str(ip.ipv4_mapped)
    return f"{ipaddress.IPv6Address(int(ip) >> 64 << 64)}/64"


def from_another_site(headers):
    """Whether a request came from another site's page. A browser that was once given the password
    in its own sign-in box sends it again with a form any site posts here, and a text/plain form
    body can be JSON. The browser says where the page was in Sec-Fetch-Site; one too old for that
    still sends Origin with a POST, held against this host's name (or the proxy's X-Forwarded-Host).
    The apps send neither."""
    origin = (headers.get("Origin") or "").strip().lower()
    if origin.startswith(("chrome-extension://", "moz-extension://")):
        return False
    site = (headers.get("Sec-Fetch-Site") or "").strip().lower()
    if site:
        return site in ("cross-site", "same-site")
    scheme, _, host = origin.partition("://")
    if scheme not in ("http", "https"):
        return False  # no Origin, or "null"
    ours = [headers.get("Host") or "", *(headers.get("X-Forwarded-Host") or "").split(",")]
    return host_key(host) not in {host_key(h) for h in ours if h.strip()}


def host_key(host):
    """A host as Origin and Host both write it: lower case, without the default port."""
    return host.strip().lower().removesuffix(":443").removesuffix(":80")


def recent_failures(addr, now):
    """This address's wrong logins within FAIL_WINDOW_S; older ones are forgotten. Under fail_lock."""
    recent = [f for f in failures.get(addr, ()) if now - f[0] < FAIL_WINDOW_S]
    if recent:
        failures[addr] = recent
    else:
        failures.pop(addr, None)
    return recent


def locked_out(addr):
    """Whether this address has used up its wrong logins for now."""
    with fail_lock:
        return len(recent_failures(addr, time.monotonic())) >= FAIL_LIMIT


def retry_after(addr):
    """Seconds until this address's oldest wrong login ages out, so a device waits that long and
    no longer."""
    with fail_lock:
        now = time.monotonic()
        recent = recent_failures(addr, now)
        return max(1, math.ceil(FAIL_WINDOW_S - (now - recent[0][0]))) if recent else 1


def reserve_guess(addr):
    """Waits for a place to check a password from this address in; False once the address has
    used up its wrong logins. A login being checked holds a place until settle_guess: counted only
    afterwards, guesses sent side by side all passed the check while the first were still in
    bcrypt. It isn't a wrong login, though: one that finds no place waits for it to be settled
    rather than being turned away, so two devices signing in at once never lock each other out."""
    with fail_settled:
        now = time.monotonic()
        if len(failures) > 10000:  # a flood from many addresses: forget the stale ones
            for a in [a for a, fs in failures.items() if now - fs[-1][0] >= FAIL_WINDOW_S]:
                del failures[a]
        while True:
            wrong = len(recent_failures(addr, time.monotonic()))
            if wrong >= FAIL_LIMIT:
                return False
            if wrong + checking.get(addr, 0) < FAIL_LIMIT:
                checking[addr] = checking.get(addr, 0) + 1
                return True
            fail_settled.wait(1)


def settle_guess(addr, name, right):
    """A login reserve_guess let through has been checked. A wrong one counts against the address,
    under the name it tried. A right one clears that name's mistakes from this address, and no one
    else's: a device logging in mustn't give a guesser behind the same address its guesses back.
    None, a password already found right (cached_login) or a check that broke, settles nothing."""
    with fail_settled:
        left = checking.get(addr, 1) - 1
        if left > 0:
            checking[addr] = left
        else:
            checking.pop(addr, None)
        if right is False:
            failures.setdefault(addr, []).append((time.monotonic(), name[:64]))
        elif right:
            kept = [f for f in failures.get(addr, ()) if f[1] != name[:64]]
            if kept:
                failures[addr] = kept
            else:
                failures.pop(addr, None)
        fail_settled.notify_all()


def user_dir(user, *parts):
    return os.path.join(args.data, "users", user, *parts)


def read_doc(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def read_state(user):
    """The stored copy, or an empty one at version 0 while there is none. Unreadable raises."""
    path = user_dir(user, "state.json")
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        return {"version": 0, "data": {}}
    except (OSError, ValueError) as e:
        raise Unreadable(path) from e
    if not isinstance(doc, dict) or not isinstance(doc.get("version"), int) or not isinstance(doc.get("data"), dict):
        raise Unreadable(path)
    return doc


def nested_within(value, limit):
    """Whether no list or object in [value] sits more than [limit] deep, the outermost being 1.
    Walked with a list of its own, not by recursion, so any depth is measured without a stack."""
    todo = [(value, 1)] if isinstance(value, (dict, list)) else []
    while todo:
        value, depth = todo.pop()
        if depth > limit:
            return False
        for v in value.values() if isinstance(value, dict) else value:
            if isinstance(v, (dict, list)):
                todo.append((v, depth + 1))
    return True


def outline_fault(data):
    """What's wrong with a document's outline, or None: an object of PARTS, each its own type."""
    if not isinstance(data, dict):
        return "the body must be a JSON object"
    for key, value in data.items():
        kind = PARTS.get(key)
        if kind is None:
            return f"unknown part {key[:40]!r}"
        # True is an int to Python, and no schema number.
        if not isinstance(value, kind) or isinstance(value, bool):
            return f"{key} must be {'a number' if kind is int else 'an object'}"
    if not isinstance(data.get("settings"), dict):
        return "settings missing"
    return None


def finite(value):
    """Whether every number in [value] is one JSON can write back: Python reads NaN and Infinity,
    which no other parser takes, so one stored would break every device's next read."""
    todo = [value]
    while todo:
        v = todo.pop()
        if isinstance(v, float) and not math.isfinite(v):
            return False
        if isinstance(v, dict):
            todo.extend(v.values())
        elif isinstance(v, list):
            todo.extend(v)
    return True


def write_json(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def keep_old(user, cur):
    """Files away the copy a write is about to replace, and drops what's past keeping."""
    if not cur.get("version"):
        return
    history = user_dir(user, "history")
    write_json(os.path.join(history, f"{cur['version']}.json"), cur)
    # The oldest filed go, not the lowest numbers: once state.json is put back from an older copy
    # the numbers go backwards, and the copy just filed was the lowest, so it went at once.
    names = [n for n in os.listdir(history) if re.fullmatch(r"\d+\.json", n)]
    names.sort(key=lambda n: (os.stat(os.path.join(history, n)).st_mtime_ns, int(n[:-5])))
    for n in names[:-KEEP_VERSIONS]:
        os.remove(os.path.join(history, n))

    daily = user_dir(user, "daily")
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not os.path.exists(os.path.join(daily, f"{day}.json")):
        write_json(os.path.join(daily, f"{day}.json"), cur)
    days = sorted(n for n in os.listdir(daily) if re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", n))
    for n in days[:-KEEP_DAYS]:
        os.remove(os.path.join(daily, n))


def earlier_copies(user):
    """What's kept, newest first. A copy in both folders is listed once, by its history name, since
    that's the one that goes first and its daily twin is still there when it does."""
    found = {}
    for sub, pattern in (("daily", DAILY_ID), ("history", HISTORY_ID)):
        folder = user_dir(user, sub)
        if not os.path.isdir(folder):
            continue
        for n in os.listdir(folder):
            if not n.endswith(".json") or not pattern.fullmatch(n[:-5]):
                continue
            doc = read_doc(os.path.join(folder, n))
            if doc and isinstance(doc.get("version"), int):
                found[doc["version"]] = {
                    "id": n[:-5],
                    "version": doc["version"],
                    "updated": doc.get("updated", ""),
                    "by": doc.get("by", ""),
                }
    return [found[v] for v in sorted(found, reverse=True)]


def earlier_path(user, name):
    if HISTORY_ID.fullmatch(name):
        return user_dir(user, "history", f"{name}.json")
    if DAILY_ID.fullmatch(name):
        return user_dir(user, "daily", f"{name}.json")
    return None


def etag_version(header):
    return (header or "").strip().removeprefix("W/").strip('"')


def doc_headers(doc):
    return {
        "ETag": f'"{doc["version"]}"',
        "X-Content-SHA256": doc.get("sha256", ""),
        "X-Updated": doc.get("updated", ""),
        "X-Updated-By": doc.get("by", ""),
        "X-Tag": doc.get("tag", ""),
    }


def same_copy(doc, tag):
    """Whether the copy a device names by its X-Base-Tag is this one, as far as the tags can tell."""
    here = doc.get("tag", "")
    return not tag or not here or tag == here


# The request line and X-Forwarded-For come from the caller. Written to the log as they are, a
# control character in them could rewrite the terminal the log is read in, or (a \r) start a line
# of its own for xrnhub's log reader. Escaped as http.server's own log_message, replaced here, does.
LOG_ESCAPES = str.maketrans({**{c: f"\\x{c:02x}" for c in (*range(0x20), *range(0x7F, 0xA0))}, "\\": "\\\\"})


class Handler(BaseHTTPRequestHandler):
    server_version = "xrnmail-sync/1"
    sys_version = ""  # the Server header named the Python version too
    timeout = 120  # seconds of silence before a connection is dropped, so a stalled client can't hold a thread

    def log_message(self, fmt, *a):
        headers = getattr(self, "headers", None)  # none yet on a request line that didn't parse
        who = headers.get("X-Forwarded-For", self.client_address[0]) if headers else "-"
        sys.stderr.write(f"{who} {fmt % a}".translate(LOG_ESCAPES) + "\n")

    def handle(self):
        # A caller hanging up, mid-upload or before the answer is out, is the network, not a fault
        # here: a phone loses its signal or its VPN reconnects. One line says so, not socketserver's
        # thirty lines of traceback, which xrnhub's log page shows as an error.
        try:
            super().handle()
        except ConnectionError as e:
            self.close_connection = True
            self.log_message("connection dropped: %s", type(e).__name__)

    def parse_request(self):
        if not super().parse_request():
            return False
        # Before the login, which a page elsewhere can have the browser pass for it.
        if self.command not in ("GET", "HEAD", "OPTIONS") and from_another_site(self.headers):
            self.send(403, "refused: sent from another site's page")
            return False
        return True

    def route(self):
        path, _, query = self.path.partition("?")
        if path == PREFIX or path.startswith(PREFIX + "/"):
            path = path[len(PREFIX):] or "/"
        return path, {k: v[-1] for k, v in parse_qs(query).items()}

    def caller_gone(self):
        """Whether the caller has closed its end, as Funnel does once the caller gives up on a
        long-poll: what it would have been told is then for no one."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and not self.connection.recv(1, socket.MSG_PEEK)
        except (OSError, ValueError):
            return True

    def send(self, code, body=b"", ctype="text/plain; charset=utf-8", headers=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        if code != 304:
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
        if self.route()[0] == "/state":
            # What this takes in a request body (RFC 7694): a device sends its copy gzipped only to
            # a server that says so.
            self.send_header("Accept-Encoding", "gzip")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and code != 304:
            self.wfile.write(body)

    def length(self, limit):
        """The request body's length, or None once an error has been answered."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.send(400, "bad Content-Length")
            return None
        if length <= 0 or length > limit:
            self.send(413, "body missing or too large")
            return None
        return length

    def unpacked(self, raw):
        """[raw] as the device wrote it, gunzipped if it came so; None once an error has been answered."""
        coding = (self.headers.get("Content-Encoding") or "identity").strip().lower()
        if coding == "identity":
            return raw
        if coding != "gzip":
            self.send(415, "Content-Encoding must be gzip or none")
            return None
        # Unpacked only up to MAX_BODY: a few kilobytes of gzip can unpack to gigabytes.
        unpack = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
        try:
            out = unpack.decompress(raw, MAX_BODY + 1)
        except zlib.error:
            out = None
        if out is None or (not unpack.eof and len(out) <= MAX_BODY):
            self.send(400, "bad gzip")
            return None
        if len(out) > MAX_BODY:
            self.send(413, "body missing or too large")
            return None
        return out

    def login(self):
        addr = client_address(self)
        header = self.headers.get("Authorization")
        if not (reserve_guess(addr) if header else not locked_out(addr)):
            if header:
                time.sleep(FAIL_DELAY_S)
            self.send(429, "too many wrong passwords; try again later",
                      headers={"Retry-After": str(retry_after(addr))})
            return None
        right = None
        try:
            # A password already found right is a session, not a login, and settles nothing: a
            # device sending it with every sync would clear the count for its whole address, so a
            # guesser behind the same one never ran out of guesses.
            user = cached_login(header)
            if not user:
                user = check_login(header)
                right = user is not None
        finally:
            if header:
                settle_guess(addr, (basic_login(header) or ("",))[0], right)
        if not user:
            if header:  # a request with none guessed nothing, and needn't hold a thread for it
                time.sleep(FAIL_DELAY_S)
            self.send(401, "login required", headers={"WWW-Authenticate": 'Basic realm="xrnmail"'})
            return None
        return user

    def do_GET(self):
        path, query = self.route()
        if path == "/health":
            return self.send(200, "ok")
        known = path in ("/state", "/versions")
        if not known and not path.startswith(("/versions/", "/update/")):
            return self.send(404, "not found")
        user = self.login()
        if not user:
            return
        if path == "/versions":
            return self.send(200, json.dumps(earlier_copies(user)), "application/json; charset=utf-8")
        if path.startswith("/versions/"):
            where = earlier_path(user, path[len("/versions/"):])
            doc = read_doc(where) if where else None
            if not isinstance(doc, dict) or not isinstance(doc.get("version"), int):
                return self.send(404, "not found")
            body = json.dumps(doc.get("data") or {}, ensure_ascii=False, separators=(",", ":"))
            return self.send(200, body, "application/json; charset=utf-8", doc_headers(doc))
        if path.startswith("/update/"):
            return self.update_file(path[len("/update/"):])
        try:
            wait = float(query.get("wait", 0))
            if not math.isfinite(wait):  # NaN is past every comparison: the wait below would never end
                raise ValueError
            wait = min(max(wait, 0), MAX_WAIT_S)
        except ValueError:
            return self.send(400, "bad wait")
        known_version = etag_version(self.headers.get("If-None-Match"))
        tag = (self.headers.get("X-Base-Tag") or "").strip()
        try:
            with lock:
                doc = read_state(user)
                deadline = time.monotonic() + wait
                while known_version == str(doc["version"]) and same_copy(doc, tag):
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    if changed.wait(min(left, GONE_CHECK_S)):
                        doc = read_state(user)
                    elif self.caller_gone():
                        self.close_connection = True
                        return self.log_message("caller left a long-poll after %.0fs",
                                                wait - (deadline - time.monotonic()))
        except Unreadable:
            return self.send(503, "the stored copy can't be read")
        headers = doc_headers(doc)
        if known_version == str(doc["version"]) and same_copy(doc, tag):
            return self.send(304, headers=headers)
        if tag and doc.get("tag"):
            # Whether the device can take this as newer than its own, or must merge first.
            headers["X-Follows"] = "1" if tag == doc["tag"] or tag in doc.get("trail", ()) else "0"
        body = json.dumps(doc.get("data") or {}, ensure_ascii=False, separators=(",", ":"))
        self.send(200, body, "application/json; charset=utf-8", headers)

    # A GET's answer without its body, as curl -I and monitors ask: http.server answered 501
    # "Unsupported method", which xrnhub's log page shows as an error.
    do_HEAD = do_GET

    def update_file(self, name):
        """A release, streamed as is: an .apk is already compressed and runs to megabytes. Only
        after the login, so a caller without one can't even tell which releases exist."""
        if not UPDATE_NAME.fullmatch(name):
            return self.send(404, "not found")
        try:
            f = open(os.path.join(args.data, "update", name), "rb")
        except OSError:
            return self.send(404, "not found")
        with f:
            # The release script swaps files in by rename, so the open file is one whole version.
            size = os.fstat(f.fileno()).st_size
            self.send_response(200)
            self.send_header("Cache-Control", "no-store")
            for k, v in SECURITY_HEADERS.items():
                self.send_header(k, v)
            self.send_header("Content-Type", UPDATE_TYPES[os.path.splitext(name)[1]])
            self.send_header("Content-Length", str(size))
            self.end_headers()
            if self.command != "HEAD":
                shutil.copyfileobj(f, self.wfile)

    def do_PUT(self):
        path, _ = self.route()
        if path != "/state":
            return self.send(404, "not found")
        user = self.login()
        if not user:
            return
        length = self.length(MAX_BODY)
        if length is None:
            return
        raw = self.rfile.read(length)
        if len(raw) < length:
            # The connection closed part way: Funnel cuts this side off when the device's side
            # drops. What came is no document, so it isn't read as one.
            self.close_connection = True
            return self.send(400, "the upload stopped short")
        raw = self.unpacked(raw)
        if raw is None:
            return
        try:
            data = json.loads(raw)
        except (ValueError, RecursionError):  # nested past the parser's depth: no traceback, a 400
            return self.send(400, "the body isn't JSON")
        fault = outline_fault(data)
        if fault:
            return self.send(400, fault)
        if not nested_within(data, MAX_DEPTH):
            # Parsed, but past what json.dump can write back: refused before anything is written,
            # not after the copy before was filed.
            return self.send(400, f"body nested deeper than {MAX_DEPTH} levels")
        if not finite(data):
            return self.send(400, "a number in the body isn't finite")
        want = (self.headers.get("If-Match") or "").strip()
        if not want:
            return self.send(428, "If-Match required")
        try:
            with lock:
                cur = read_state(user)
                stale = etag_version(want) != str(cur["version"]) or not same_copy(
                    cur, (self.headers.get("X-Base-Tag") or "").strip())
                if want != "*" and stale:
                    return self.send(412, "changed since you read it", headers=doc_headers(cur))
                keep_old(user, cur)
                doc = {
                    "version": cur["version"] + 1,
                    "tag": secrets.token_hex(8),
                    "trail": [t for t in cur.get("trail", []) + [cur.get("tag", "")] if t][-KEEP_TAGS:],
                    "updated": datetime.now(timezone.utc).isoformat(),
                    "by": (self.headers.get("X-Device") or "")[:64],
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "data": data,
                }
                write_json(user_dir(user, "state.json"), doc)
                changed.notify_all()
        except Unreadable:
            # Written over, the copy that can't be read would be gone without a trace; it's left
            # for a person to look at, and the device keeps its changes until then.
            return self.send(503, "the stored copy can't be read")
        self.send(200, '{"ok":true}', "application/json", doc_headers(doc))


def main():
    global args
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5243)
    p.add_argument("--data", required=True, help="where the documents live")
    p.add_argument("--users", required=True, help="htpasswd file with bcrypt hashes")
    args = p.parse_args()
    args.data = os.path.expanduser(args.data)
    args.users = os.path.expanduser(args.users)
    os.umask(0o077)  # the documents name who the owner writes to; no one else on the machine reads them
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    sys.stderr.write(f"xrnmail-sync on http://{args.host}:{args.port}, data in {args.data}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
