"""Tests for xrnmail-sync.py: the If-Match rule, long-polls, earlier copies, releases, logins.

    python3 -m unittest server/test_xrnmail_sync.py     (from the repo root; needs bcrypt)
"""
import base64
import gzip
import hashlib
import http.client
import importlib.util
import io
import json
import os
import socket
import struct
import tempfile
import threading
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("xrnmail_sync", os.path.join(HERE, "xrnmail-sync.py"))
srv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(srv)

RIGHT = "secret"


class LoopbackServer(ThreadingHTTPServer):
    request_queue_size = 64  # room for requests sent side by side, so none waits to connect


def document(*vip, snooze=None):
    """A made-up shared document: straight-through senders, and a snoozed thread if asked."""
    doc = {"schema": 1, "settings": {"batch": {"live": False, "times": ["09:00"], "vip": list(vip), "earlyPerDay": 1}}}
    if snooze:
        doc["threads"] = {f"alex@example.com\n{snooze}": {"snooze": {"until": 1790000000000, "at": 1789990000000}}}
    return doc


class SyncServerTest(unittest.TestCase):
    def setUp(self):
        import bcrypt

        self.tmp = tempfile.TemporaryDirectory()
        users = os.path.join(self.tmp.name, "users")
        with open(users, "w") as f:
            for name in ("owner", "other"):
                f.write(f"{name}:" + bcrypt.hashpw(RIGHT.encode(), bcrypt.gensalt(4)).decode() + "\n")
        self.data = os.path.join(self.tmp.name, "data")
        srv.args = type("Args", (), {"data": self.data, "users": users})()
        srv.FAIL_DELAY_S = 0
        srv.failures.clear()
        srv.checking.clear()
        srv.auth_cache.clear()
        self.httpd = LoopbackServer(("127.0.0.1", 0), srv.Handler)
        self.httpd.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None, password=RIGHT, raw=False, user="owner", timeout=10):
        data = body if raw else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, method=method, data=data)
        if password is not None:
            req.add_header("Authorization", "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode())
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read(), e.headers

    def put(self, doc, base, **kw):
        return self.call("PUT", "/state", doc, {"If-Match": base}, **kw)

    def state_file(self, user="owner"):
        return os.path.join(self.data, "users", user, "state.json")

    # The protocol

    def test_an_empty_server_takes_a_first_sync(self):
        status, body, headers = self.call("GET", "/state")
        self.assertEqual((status, json.loads(body), headers["ETag"]), (200, {}, '"0"'))
        status, _, headers = self.put(document("alex@example.com"), '"0"')
        self.assertEqual((status, headers["ETag"]), (200, '"1"'))
        status, body, _ = self.call("GET", "/state")
        self.assertEqual(json.loads(body)["settings"]["batch"]["vip"], ["alex@example.com"])

    def test_the_path_works_with_and_without_the_prefix(self):
        self.assertEqual(self.call("GET", "/xrnmail/health", password=None)[1], b"ok")
        self.assertEqual(self.call("GET", "/health", password=None)[1], b"ok")
        self.assertEqual(self.call("PUT", "/xrnmail/state", document(), {"If-Match": '"0"'})[0], 200)
        self.assertEqual(self.call("GET", "/state")[2]["ETag"], '"1"')
        self.assertEqual(self.call("GET", "/xrnmailx/health", password=None)[0], 404)

    def test_a_stale_write_is_refused_and_changes_nothing(self):
        self.put(document("first@example.com"), '"0"')
        self.put(document("second@example.com"), '"1"')
        status, _, headers = self.put(document("from a phone a version behind"), '"1"')
        self.assertEqual((status, headers["ETag"]), (412, '"2"'))
        self.assertEqual(json.loads(self.call("GET", "/state")[1])["settings"]["batch"]["vip"], ["second@example.com"])

    def test_a_write_without_if_match_is_refused(self):
        self.assertEqual(self.call("PUT", "/state", document())[0], 428)

    def test_a_device_that_never_synced_cannot_replace_a_copy_by_accident(self):
        self.put(document("kept@example.com"), '"0"')
        self.assertEqual(self.put(document("fresh install"), '"0"')[0], 412)

    def test_saying_so_on_purpose_replaces_it_and_keeps_the_old_one(self):
        self.put(document("old@example.com"), '"0"')
        status, _, headers = self.put(document("new@example.com"), "*")
        self.assertEqual((status, headers["ETag"]), (200, '"2"'))
        self.assertEqual([e["version"] for e in json.loads(self.call("GET", "/versions")[1])], [1])

    def test_unchanged_answers_304(self):
        self.put(document(), '"0"')
        self.assertEqual(self.call("GET", "/state", headers={"If-None-Match": '"1"'})[0], 304)
        self.assertEqual(self.call("GET", "/state", headers={"If-None-Match": '"0"'})[0], 200)

    def test_a_write_says_which_device_made_it(self):
        self.call("PUT", "/state", document(), {"If-Match": '"0"', "X-Device": "phone"})
        self.assertEqual(self.call("GET", "/state")[2]["X-Updated-By"], "phone")

    def test_every_write_gets_a_tag_of_its_own(self):
        _, _, first = self.put(document("a@example.com"), '"0"')
        _, _, second = self.put(document("b@example.com"), '"1"')
        self.assertTrue(first["X-Tag"])
        self.assertNotEqual(first["X-Tag"], second["X-Tag"])
        self.assertEqual(self.call("GET", "/state")[2]["X-Tag"], second["X-Tag"])

    def test_a_copy_written_on_top_of_the_devices_follows_it(self):
        _, _, first = self.put(document("one@example.com"), '"0"')
        seen = {"If-None-Match": '"1"', "X-Base-Tag": first["X-Tag"]}
        self.assertEqual(self.call("GET", "/state", headers=seen)[0], 304)
        self.put(document("two@example.com"), '"1"')
        status, _, headers = self.call("GET", "/state", headers=seen)
        self.assertEqual((status, headers["X-Follows"]), (200, "1"))

    def test_after_a_restore_here_the_same_version_is_not_taken_for_the_devices_copy(self):
        self.put(document("one@example.com"), '"0"')
        with open(self.state_file()) as f:
            backup = f.read()
        _, _, mine = self.put(document("two, from this phone"), '"1"')
        with open(self.state_file(), "w") as f:
            f.write(backup)  # the data here restored from a backup
        self.put(document("two, from the laptop"), '"1"')
        status, _, headers = self.call("GET", "/state", headers={"If-None-Match": '"2"', "X-Base-Tag": mine["X-Tag"]})
        self.assertEqual((status, headers["X-Follows"]), (200, "0"))
        status = self.call("PUT", "/state", document("three"), {"If-Match": '"2"', "X-Base-Tag": mine["X-Tag"]})[0]
        self.assertEqual(status, 412)
        self.assertEqual(json.loads(self.call("GET", "/state")[1])["settings"]["batch"]["vip"], ["two, from the laptop"])

    def test_a_snoozed_thread_goes_up_and_comes_back_as_it_was(self):
        self.put(document(snooze="18a2b3c4d5e6f708"), '"0"')
        threads = json.loads(self.call("GET", "/state")[1])["threads"]
        self.assertEqual(threads["alex@example.com\n18a2b3c4d5e6f708"]["snooze"]["until"], 1790000000000)

    def test_only_a_document_of_the_known_parts_is_taken(self):
        for bad in ({"items": []}, [], {"settings": []}, {"settings": {}, "threads": []}, {"threads": {}},
                    {"settings": {}, "schema": "1"}, {"settings": {}, "schema": True}, {"settings": {}, "mail": {}}):
            self.assertEqual(self.put(bad, '"0"')[0], 400, bad)
        self.assertEqual(self.call("PUT", "/state", b"not json", {"If-Match": '"0"'}, raw=True)[0], 400)
        self.assertEqual(self.put({"schema": 1, "settings": {}, "threads": {}, "early": {}}, '"0"')[0], 200)

    def test_a_number_json_cant_write_is_refused(self):
        # Python reads NaN and Infinity; stored, they'd make every device's next read fail.
        for raw in (b'{"settings":{"undoSeconds":NaN}}', b'{"settings":{"x":[Infinity]}}'):
            self.assertEqual(self.call("PUT", "/state", raw, {"If-Match": '"0"'}, raw=True)[0], 400, raw)
        self.assertEqual(self.call("GET", "/state")[2]["ETag"], '"0"')

    def test_a_write_reports_the_hash_of_what_it_was_sent(self):
        raw = json.dumps(document("a@example.com"), separators=(",", ":")).encode()
        want = hashlib.sha256(raw).hexdigest()
        _, _, put = self.call("PUT", "/state", raw, {"If-Match": '"0"'}, raw=True)
        self.assertEqual(put["X-Content-SHA256"], want)
        self.assertEqual(self.call("GET", "/state")[2]["X-Content-SHA256"], want)

    def test_a_refused_write_says_what_is_here_so_a_lost_answer_can_be_spotted(self):
        raw = json.dumps(document("landed, answer lost"), separators=(",", ":")).encode()
        self.call("PUT", "/state", raw, {"If-Match": '"0"'}, raw=True)
        status, _, headers = self.put(document("next change"), '"0"')
        self.assertEqual((status, headers["X-Content-SHA256"], headers["ETag"]),
                         (412, hashlib.sha256(raw).hexdigest(), '"1"'))

    def test_a_gzipped_upload_is_taken_and_hashed_as_the_document_it_holds(self):
        raw = json.dumps(document("packed@example.com", "x" * 5000), separators=(",", ":")).encode()
        status, _, put = self.call("PUT", "/state", gzip.compress(raw), {"If-Match": '"0"', "Content-Encoding": "gzip"},
                                   raw=True)
        self.assertEqual((status, put["X-Content-SHA256"]), (200, hashlib.sha256(raw).hexdigest()))
        _, body, got = self.call("GET", "/state")
        self.assertEqual((json.loads(body)["settings"]["batch"]["vip"][0], got["X-Content-SHA256"]),
                         ("packed@example.com", hashlib.sha256(raw).hexdigest()))

    def test_state_answers_say_a_gzipped_body_is_taken(self):
        self.assertEqual(self.call("GET", "/state")[2]["Accept-Encoding"], "gzip")
        self.assertEqual(self.put(document(), '"0"')[2]["Accept-Encoding"], "gzip")

    def test_gzip_that_unpacks_past_the_limit_or_wont_unpack_is_refused(self):
        packed = gzip.compress(b'{"settings":{"x":"' + b"a" * 5000 + b'"}}')
        with unittest.mock.patch.object(srv, "MAX_BODY", 1000):
            self.assertEqual(self.call("PUT", "/state", packed, {"If-Match": '"0"', "Content-Encoding": "gzip"},
                                       raw=True)[0], 413)
        for bad in (b"not gzip", packed[: len(packed) // 2]):
            self.assertEqual(self.call("PUT", "/state", bad, {"If-Match": '"0"', "Content-Encoding": "gzip"},
                                       raw=True)[0], 400)
        self.assertEqual(self.call("PUT", "/state", packed, {"If-Match": '"0"', "Content-Encoding": "br"},
                                   raw=True)[0], 415)
        self.assertEqual(self.call("GET", "/state")[2]["ETag"], '"0"')

    def test_a_body_past_the_limit_is_refused(self):
        with unittest.mock.patch.object(srv, "MAX_BODY", 100):
            self.assertEqual(self.put(document("x" * 200), '"0"')[0], 413)

    # Long-polls

    def test_a_long_poll_answers_as_soon_as_another_device_writes(self):
        self.put(document("one@example.com"), '"0"')
        got = {}

        def poll():
            start = time.monotonic()
            got["answer"] = self.call("GET", "/state?wait=10", headers={"If-None-Match": '"1"'})
            got["took"] = time.monotonic() - start

        waiting = threading.Thread(target=poll)
        waiting.start()
        time.sleep(0.3)
        self.put(document("two@example.com"), '"1"', user="owner")
        waiting.join(5)
        status, body, headers = got["answer"]
        self.assertEqual((status, headers["ETag"]), (200, '"2"'))
        self.assertEqual(json.loads(body)["settings"]["batch"]["vip"], ["two@example.com"])
        self.assertLess(got["took"], 3)

    def test_a_long_poll_with_nothing_new_ends_in_a_304(self):
        self.put(document(), '"0"')
        start = time.monotonic()
        status = self.call("GET", "/state?wait=0.5", headers={"If-None-Match": '"1"'})[0]
        self.assertEqual(status, 304)
        self.assertGreaterEqual(time.monotonic() - start, 0.5)

    def test_another_users_write_doesnt_end_a_long_poll(self):
        self.put(document(), '"0"')
        got = {}
        waiting = threading.Thread(target=lambda: got.setdefault(
            "status", self.call("GET", "/state?wait=1", headers={"If-None-Match": '"1"'})[0]))
        waiting.start()
        time.sleep(0.2)
        self.put(document("theirs@example.com"), '"0"', user="other")
        waiting.join(5)
        self.assertEqual(got["status"], 304)

    def test_a_long_poll_is_held_to_the_cap_and_a_bad_wait_is_refused(self):
        for bad in ("nan", "inf", "soon"):
            self.assertEqual(self.call("GET", f"/state?wait={bad}", headers={"If-None-Match": '"0"'})[0], 400, bad)
        with unittest.mock.patch.object(srv, "MAX_WAIT_S", 0.3):
            start = time.monotonic()
            self.assertEqual(self.call("GET", "/state?wait=1000", headers={"If-None-Match": '"0"'})[0], 304)
            self.assertLess(time.monotonic() - start, 3)

    def test_a_long_poll_without_if_none_match_answers_at_once(self):
        start = time.monotonic()
        self.assertEqual(self.call("GET", "/state?wait=10")[0], 200)
        self.assertLess(time.monotonic() - start, 3)

    def test_a_long_poll_whose_caller_left_ends_without_an_answer(self):
        self.put(document(), '"0"')
        login = base64.b64encode(f"owner:{RIGHT}".encode())
        with unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as log:
            with socket.create_connection(("127.0.0.1", self.httpd.server_address[1]), timeout=10) as s:
                s.sendall(b"GET /state?wait=20 HTTP/1.1\r\nHost: x\r\nAuthorization: Basic " + login +
                          b'\r\nIf-None-Match: "1"\r\n\r\n')
                time.sleep(0.3)
            for _ in range(50):
                if "caller left" in log.getvalue():
                    break
                time.sleep(0.1)
        self.assertIn("caller left a long-poll", log.getvalue())

    # Earlier copies

    def test_earlier_copies_can_be_listed_and_fetched(self):
        self.put(document("one@example.com"), '"0"')
        self.put(document("two@example.com"), '"1"')
        self.call("PUT", "/state", document("three@example.com"), {"If-Match": '"2"', "X-Device": "laptop"})
        earlier = json.loads(self.call("GET", "/versions")[1])
        self.assertEqual([e["version"] for e in earlier], [2, 1])
        self.assertTrue(earlier[0]["updated"])
        status, body, headers = self.call("GET", f"/versions/{earlier[1]['id']}")
        self.assertEqual((status, json.loads(body)["settings"]["batch"]["vip"]), (200, ["one@example.com"]))
        self.assertTrue(headers["X-Content-SHA256"])

    def test_a_copy_past_the_history_is_still_there_in_the_daily_folder(self):
        self.put(document("first of the day"), '"0"')
        for i in range(1, srv.KEEP_VERSIONS + 3):
            self.put(document(f"change {i}"), f'"{i}"')
        earlier = json.loads(self.call("GET", "/versions")[1])
        oldest = earlier[-1]
        self.assertEqual(oldest["version"], 1)
        self.assertRegex(oldest["id"], r"\d{4}-\d{2}-\d{2}")
        self.assertEqual(len(earlier), srv.KEEP_VERSIONS + 1)
        body = json.loads(self.call("GET", f"/versions/{oldest['id']}")[1])
        self.assertEqual(body["settings"]["batch"]["vip"], ["first of the day"])

    def test_a_copy_replaced_after_a_rollback_stays_in_the_history(self):
        self.put(document("first of the day"), '"0"')
        for i in range(1, srv.KEEP_VERSIONS + 5):
            self.put(document(f"change {i}"), f'"{i}"')
        history = os.path.join(self.data, "users", "owner", "history")
        self.assertEqual(sorted(int(n[:-5]) for n in os.listdir(history)), list(range(5, 25)))
        daily = os.path.join(self.data, "users", "owner", "daily")
        with open(os.path.join(daily, os.listdir(daily)[0]), encoding="utf-8") as f:
            first = f.read()
        with open(self.state_file(), "w", encoding="utf-8") as f:
            f.write(first)
        self.assertEqual(self.put(document("after the rollback"), '"1"')[0], 200)
        self.assertEqual(sorted(int(n[:-5]) for n in os.listdir(history)), [1] + list(range(6, 25)))

    def test_no_earlier_copies_is_an_empty_list(self):
        self.assertEqual(self.call("GET", "/versions")[:2], (200, b"[]"))

    def test_an_unknown_or_unsafe_version_is_not_found(self):
        self.put(document(), '"0"')
        for name in ("99", "2020-01-01", "..", "../state", "%2e%2e%2fstate", "state"):
            self.assertEqual(self.call("GET", f"/versions/{name}")[0], 404, name)

    # A copy that can't be read

    def test_a_copy_that_cant_be_read_is_never_answered_as_empty(self):
        # An empty answer reads as "everything was deleted", and a device would merge that in.
        self.put(document("kept@example.com"), '"0"')
        for broken in ("{not json", "[]", '{"version": "1", "data": {}}', '{"version": 1, "data": []}'):
            with open(self.state_file(), "w") as f:
                f.write(broken)
            self.assertEqual(self.call("GET", "/state")[0], 503, broken)
            self.assertEqual(self.call("GET", "/state?wait=1", headers={"If-None-Match": '"1"'})[0], 503, broken)

    def test_a_write_over_a_copy_that_cant_be_read_is_refused_and_leaves_it(self):
        self.put(document("kept@example.com"), '"0"')
        with open(self.state_file(), "w") as f:
            f.write("{not json")
        self.assertEqual(self.put(document("new@example.com"), "*")[0], 503)
        with open(self.state_file()) as f:
            self.assertEqual(f.read(), "{not json")
        self.assertEqual(json.loads(self.call("GET", "/versions")[1]), [])

    # Releases

    def release(self, name, body):
        folder = os.path.join(self.data, "update")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, name), "wb") as f:
            f.write(body)

    def test_a_release_is_served_to_a_signed_in_phone(self):
        self.release("app.json", b'{"versionCode": 3}')
        self.release("xrnmail-0.1.0.apk", b"PK\x03\x04apk")
        status, body, headers = self.call("GET", "/update/app.json")
        self.assertEqual((status, json.loads(body), headers["Content-Type"]),
                         (200, {"versionCode": 3}, "application/json; charset=utf-8"))
        status, body, headers = self.call("GET", "/update/xrnmail-0.1.0.apk")
        self.assertEqual((status, body, headers["Content-Type"]),
                         (200, b"PK\x03\x04apk", "application/vnd.android.package-archive"))

    def test_releases_need_the_login_and_a_plain_name(self):
        self.release("app.json", b"{}")
        self.assertEqual(self.call("GET", "/update/app.json", password=None)[0], 401)
        self.assertEqual(self.call("GET", "/update/missing.apk")[0], 404)
        for name in (".app.json", "..%2fusers", "app.sh", "x/app.json", "../users/owner/state.json"):
            self.assertEqual(self.call("GET", f"/update/{name}")[0], 404, name)

    # The hardening every xrn server carries

    def test_a_page_on_another_site_cant_write_with_the_browsers_password(self):
        for elsewhere in ({"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
                          {"Sec-Fetch-Site": "same-site", "Origin": "https://other.homeserver.example"},
                          {"Origin": "https://evil.example"}):  # a browser from before Sec-Fetch-Site
            self.assertEqual(self.call("PUT", "/state", document("Junk"), {"If-Match": "*", **elsewhere})[0], 403)
        self.assertEqual(json.loads(self.call("GET", "/state")[1]), {})
        self.assertEqual(self.call("GET", "/state", headers={"Sec-Fetch-Site": "cross-site"})[0], 200)
        port = self.httpd.server_address[1]
        for ours in ({"Sec-Fetch-Site": "same-origin", "Origin": "https://homeserver.example"},
                     {"Origin": f"http://127.0.0.1:{port}"},
                     {"Origin": "https://HomeServer.example", "X-Forwarded-Host": "homeserver.example:443"},
                     {}):
            self.assertEqual(self.call("PUT", "/state", document("ok"), {"If-Match": "*", **ours})[0], 200, ours)

    def head(self, path, login=True):
        """The whole answer to a HEAD request, read to the end: a body sent anyway shows up in it."""
        auth = b"Authorization: Basic " + base64.b64encode(f"owner:{RIGHT}".encode()) + b"\r\n" if login else b""
        with socket.create_connection(("127.0.0.1", self.httpd.server_address[1]), timeout=10) as s:
            s.sendall(b"HEAD " + path.encode() + b" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n" + auth + b"\r\n")
            return b"".join(iter(lambda: s.recv(4096), b""))

    def test_head_is_a_get_without_the_body(self):
        self.put(document(), '"0"')
        self.release("app.json", b'{"versionCode": 3}')
        for path, login, status, header in (("/health", False, b"200", b"Content-Length: 2"),
                                            ("/state", True, b"200", b'ETag: "1"'),
                                            ("/update/app.json", True, b"200", b"Content-Length: 18"),
                                            ("/state", False, b"401", b"WWW-Authenticate")):
            answer = self.head(path, login)
            self.assertRegex(answer, rb"^HTTP/1\.[01] " + status + rb" ", path)
            self.assertIn(header, answer, path)
            self.assertTrue(answer.endswith(b"\r\n\r\n"), (path, answer[-40:]))

    def test_an_unparseable_request_gets_an_answer(self):
        with socket.create_connection(("127.0.0.1", self.httpd.server_address[1]), timeout=10) as s:
            s.sendall(b"GARBAGE\r\n\r\n")
            self.assertIn(b"400", s.recv(200))

    def test_a_document_nested_too_deep_is_refused_with_an_answer(self):
        deep = b'{"settings":' + b"[" * 100_000 + b"]" * 100_000 + b"}"
        self.assertEqual(self.call("PUT", "/state", deep, {"If-Match": '"0"'}, raw=True)[0], 400)
        self.assertEqual(self.call("GET", "/state")[2]["ETag"], '"0"')

    def test_a_document_too_deep_to_write_back_is_refused_before_anything_is_written(self):
        self.put(document("kept@example.com"), '"0"')
        deep = b'{"settings":{"x":' + b"[" * 2000 + b"]" * 2000 + b"}}"
        status, body, _ = self.call("PUT", "/state", deep, {"If-Match": '"1"'}, raw=True)
        self.assertEqual(status, 400)
        self.assertIn(b"nested", body)
        self.assertEqual(self.call("GET", "/state")[2]["ETag"], '"1"')
        self.assertEqual(json.loads(self.call("GET", "/versions")[1]), [])

    def test_a_document_nested_up_to_the_limit_is_taken(self):
        def nested(depth):  # {"settings": {"x": [[...]]}}: the outer object is level 1
            return b'{"settings":{"x":' + b"[" * (depth - 2) + b"]" * (depth - 2) + b"}}"
        status, _, headers = self.call("PUT", "/state", nested(srv.MAX_DEPTH), {"If-Match": '"0"'}, raw=True)
        self.assertEqual((status, headers["ETag"]), (200, '"1"'))
        self.assertEqual(self.call("PUT", "/state", nested(srv.MAX_DEPTH + 1), {"If-Match": '"1"'}, raw=True)[0], 400)

    def cut_upload(self, reset):
        """A PUT /state whose body stops half way, then the connection closes, as Funnel closes
        it when the phone's side drops: with [reset], hard, before any answer can come back."""
        body = json.dumps(document("a" * 4000)).encode()
        login = base64.b64encode(f"owner:{RIGHT}".encode())
        head = (b"PUT /state HTTP/1.1\r\nHost: x\r\nAuthorization: Basic " + login +
                b'\r\nIf-Match: "0"\r\nContent-Length: ' + str(len(body)).encode() + b"\r\n\r\n")
        with unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as log:
            with socket.create_connection(("127.0.0.1", self.httpd.server_address[1]), timeout=10) as s:
                s.sendall(head + body[:len(body) // 2])
                if reset:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                    answer = b""
                else:
                    s.shutdown(socket.SHUT_WR)
                    answer = b"".join(iter(lambda: s.recv(4096), b""))
            for _ in range(300):  # the handler finishes on its own thread
                if any(word in log.getvalue() for word in ("dropped", "Traceback", '" 400 ')):
                    break
                time.sleep(0.01)
            time.sleep(0.1)
        return answer, log.getvalue()

    def test_an_upload_cut_short_is_answered_as_such_and_writes_nothing(self):
        answer, log = self.cut_upload(reset=False)
        self.assertRegex(answer, rb"^HTTP/1\.[01] 400 ")
        self.assertIn(b"the upload stopped short", answer)
        self.assertNotIn("Traceback", log)
        self.assertEqual(self.call("GET", "/state")[2]["ETag"], '"0"')

    def test_a_caller_that_hangs_up_is_one_line_in_the_log_not_a_traceback(self):
        _, log = self.cut_upload(reset=True)
        self.assertNotIn("Traceback", log)
        self.assertIn("connection dropped: ConnectionResetError", log)
        self.assertEqual(self.call("GET", "/state")[2]["ETag"], '"0"')

    def test_the_log_shows_a_callers_control_characters_escaped(self):
        forged = b'2026-11-06_01:09:14.23919 198.51.100.66 "POST /state HTTP/1.1" 200 -'
        with unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as log:
            for raw in (b"GET /a\x1b[2Jb HTTP/1.1\r\nX-Forwarded-For: 203.0.113.70\x1b]0;hi\x07\r\n\r\n",
                        b"GET /a\r" + forged + b" HTTP/1.1\r\n\r\n"):
                with socket.create_connection(("127.0.0.1", self.httpd.server_address[1]), timeout=10) as s:
                    s.sendall(raw)
                    while s.recv(4096):
                        pass
        text = log.getvalue()
        self.assertIn("203.0.113.70\\x1b]0;hi\\x07", text)
        self.assertIn("/a\\x1b[2Jb", text)
        self.assertIn("/a\\x0d2026-11-06", text)
        self.assertEqual([], [c for c in text if c != "\n" and (ord(c) < 0x20 or 0x7F <= ord(c) < 0xA0)])

    def test_no_answer_names_the_python_version(self):
        for method in ("GET", "PATCH"):  # PATCH: http.server's own 501 page
            conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=10)
            conn.request(method, "/health")
            res = conn.getresponse()
            res.read()
            conn.close()
            self.assertNotIn("Python", res.getheader("Server"), method)

    def test_every_answer_carries_the_security_headers(self):
        for path, password in (("/health", None), ("/state", RIGHT), ("/state", None), ("/nowhere", RIGHT)):
            headers = self.call("GET", path, password=password)[2]
            self.assertEqual(headers["Cache-Control"], "no-store", path)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff", path)
            self.assertIn("default-src 'none'", headers["Content-Security-Policy"], path)

    def test_a_connection_that_goes_quiet_is_let_go(self):
        with unittest.mock.patch.object(srv.Handler, "timeout", 0.5):
            with socket.create_connection(("127.0.0.1", self.httpd.server_address[1]), timeout=10) as s:
                s.sendall(b"GET /health HTTP/1.1\r\n")  # and nothing more
                start = time.monotonic()
                while s.recv(4096):
                    pass
                self.assertLess(time.monotonic() - start, 5)

    def test_everything_needs_the_login_except_health(self):
        for path in ("/state", "/versions", "/versions/1", "/update/app.json"):
            self.assertEqual(self.call("GET", path, password=None)[0], 401, path)
            self.assertEqual(self.call("GET", path, password="wrong")[0], 401, path)
        self.assertEqual(self.put(document(), '"0"', password="wrong")[0], 401)
        self.assertEqual(self.call("GET", "/health", password=None)[0], 200)

    def guess(self, forwarded, n=0):
        return self.call("GET", "/state", password=f"guess{n}", headers={"X-Forwarded-For": forwarded})[0]

    def test_a_made_up_forwarded_hop_is_not_a_new_address(self):
        for i in range(10):
            self.assertEqual(401, self.guess(f"198.51.100.{i}, 203.0.113.20", i))
        self.assertEqual(429, self.guess("198.51.100.200, 203.0.113.20", 10))
        self.assertEqual(401, self.guess("203.0.113.20, 203.0.113.21"))  # another caller isn't held

    def test_an_ipv6_guesser_is_its_64_not_each_address_in_it(self):
        for i in range(10):
            self.assertEqual(401, self.guess(f"2001:db8:1:2::{i + 1:x}", i))
        self.assertEqual(429, self.guess("2001:db8:1:2:aaaa::1", 10))
        self.assertEqual(401, self.guess("2001:db8:1:3::1"))
        self.assertEqual(401, self.guess("::ffff:203.0.113.40"))
        self.assertIn("203.0.113.40", srv.failures)

    def test_a_name_that_isnt_there_costs_a_check_like_one_that_is(self):
        import bcrypt

        def checks(login):
            header = "Basic " + base64.b64encode(login.encode()).decode()
            with unittest.mock.patch.object(bcrypt, "checkpw", wraps=bcrypt.checkpw) as checkpw:
                self.assertIsNone(srv.check_login(header))
            return checkpw.call_count
        self.assertEqual(checks("owner:nope"), 1)
        self.assertEqual(checks("nobody:nope"), 1)
        self.assertEqual(checks("../owner:nope"), 0)  # a name that can't be a folder isn't looked up

    def test_a_request_with_no_password_isnt_held(self):
        def timed(addr, password):
            start = time.monotonic()
            status = self.call("GET", "/state", password=password, headers={"X-Forwarded-For": addr})[0]
            return status, time.monotonic() - start
        srv.failures["203.0.113.61"] = [(time.monotonic(), "owner")] * srv.FAIL_LIMIT  # locked out
        srv.FAIL_DELAY_S = 0.5
        try:
            for addr, status in (("203.0.113.60", 401), ("203.0.113.61", 429)):
                got, took = timed(addr, None)
                self.assertEqual(got, status)
                self.assertLess(took, 0.4, addr)
                got, took = timed(addr, "nope")
                self.assertEqual(got, status)
                self.assertGreaterEqual(took, 0.5, addr)
        finally:
            srv.FAIL_DELAY_S = 0

    def test_too_many_wrong_passwords_lock_the_address_out_until_the_oldest_ages_out(self):
        for _ in range(srv.FAIL_LIMIT):
            self.assertEqual(self.call("GET", "/state", password="wrong")[0], 401)
        status, _, headers = self.call("GET", "/state", password=RIGHT)
        self.assertEqual(status, 429)
        self.assertLessEqual(int(headers["Retry-After"]), srv.FAIL_WINDOW_S)
        # Ten minutes on, the oldest has five left to go, and that's the wait.
        srv.failures["127.0.0.1"] = [(t - 600, n) for t, n in srv.failures["127.0.0.1"]]
        retry = int(self.call("GET", "/state", password=RIGHT)[2]["Retry-After"])
        self.assertTrue(250 <= retry <= 301, retry)

    def test_wrong_passwords_sent_side_by_side_get_no_more_tries(self):
        real = srv.check_login

        def slow(header):  # as bcrypt is, which is when the others arrive
            time.sleep(0.5)
            return real(header)

        srv.check_login = slow
        try:
            tries = srv.FAIL_LIMIT * 3
            with ThreadPoolExecutor(tries) as pool:
                codes = list(pool.map(lambda _: self.call("GET", "/state", password="wrong")[0], range(tries)))
        finally:
            srv.check_login = real
        self.assertEqual((codes.count(401), codes.count(429)), (srv.FAIL_LIMIT, tries - srv.FAIL_LIMIT))
        self.assertEqual(self.call("GET", "/state", password=RIGHT)[0], 429)

    def guess_as(self, name, password, addr):
        return self.call("GET", "/state", password=password, user=name, headers={"X-Forwarded-For": addr})[0]

    def test_a_right_login_clears_only_its_own_users_mistakes(self):
        addr = "203.0.113.80"
        for _ in range(5):
            self.assertEqual(401, self.guess_as("other", "nope", addr))
        for _ in range(4):
            self.assertEqual(401, self.guess_as("owner", "nope", addr))
        srv.auth_cache.clear()
        self.assertEqual(200, self.guess_as("owner", RIGHT, addr))
        for _ in range(srv.FAIL_LIMIT - 5):
            self.assertEqual(401, self.guess_as("other", "nope", addr))
        self.assertEqual(429, self.guess_as("other", "nope", addr))

    def test_a_device_sending_the_password_it_had_clears_nothing(self):
        addr = "203.0.113.81"
        self.assertEqual(200, self.guess_as("owner", RIGHT, addr))
        for _ in range(srv.FAIL_LIMIT - 1):
            self.assertEqual(401, self.guess_as("owner", "nope", addr))
            self.assertEqual(200, self.guess_as("owner", RIGHT, addr))
        self.assertEqual(401, self.guess_as("owner", "nope", addr))
        self.assertEqual(429, self.guess_as("owner", "nope", addr))

    def test_a_login_in_flight_is_not_a_wrong_guess(self):
        addr = "203.0.113.82"
        real = srv.check_login

        def slow(header):
            time.sleep(0.3)
            return real(header)

        with unittest.mock.patch.object(srv, "FAIL_LIMIT", 3):
            self.assertEqual(401, self.guess_as("owner", "nope", addr))
            self.assertEqual(401, self.guess_as("owner", "nope", addr))
            srv.auth_cache.clear()
            start = threading.Barrier(2)

            def login(name):
                start.wait()
                return self.guess_as(name, RIGHT, addr)

            both = ["owner", "other"]  # the two people signing in at once
            with unittest.mock.patch.object(srv, "check_login", slow):
                with ThreadPoolExecutor(2) as pool:
                    self.assertEqual([200, 200], list(pool.map(login, both)))

    def test_users_do_not_see_each_others_copies(self):
        self.put(document("mine@example.com"), '"0"')
        self.put(document("newer@example.com"), '"1"')
        status, body, headers = self.call("GET", "/state", user="other")
        self.assertEqual((status, json.loads(body), headers["ETag"]), (200, {}, '"0"'))
        self.assertEqual(json.loads(self.call("GET", "/versions", user="other")[1]), [])
        self.assertEqual(self.call("GET", "/versions/1", user="other")[0], 404)

    # ---- device logins (DeviceTokens) ---------------------------------------------------------

    def tokens_path(self):
        return os.path.join(os.path.dirname(srv.args.users), "device-tokens.json")

    def write_tokens(self, entries):
        """device-tokens.json as the server's owner writes it: a new file in the old one's place."""
        with open(self.tokens_path() + ".test", "w", encoding="utf-8") as f:
            f.write(entries if isinstance(entries, str) else json.dumps({"tokens": entries}))
        os.replace(self.tokens_path() + ".test", self.tokens_path())

    @staticmethod
    def a_token(services=("xrnmail",), user="owner"):
        """(a device token, its entry in the file)."""
        token_id = os.urandom(4).hex()
        secret = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
        entry = {"id": token_id, "user": user, "device": f"device {token_id}", "services": list(services),
                 "sha256": hashlib.sha256(secret.encode()).hexdigest(), "created": 1764115200}
        return f"xrndev_{token_id}_{secret}", entry

    def device_call(self, auth, addr, method="GET", path="/state", body=b"", **headers):
        """(status, body, headers) of a request sent with Authorization: [auth], from [addr]."""
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=10)
        conn.request(method, path, body=body, headers={"Authorization": auth, "X-Forwarded-For": addr, **headers})
        res = conn.getresponse()
        answer = res.status, res.read(), res
        conn.close()
        return answer

    def bearer(self, token, addr, **kw):
        return self.device_call(f"Bearer {token}", addr, **kw)[0]

    def with_password(self, addr, **kw):
        return self.device_call("Basic " + base64.b64encode(b"owner:secret").decode(), addr, **kw)[0]

    def test_a_device_token_signs_in_as_its_user(self):
        token, entry = self.a_token()
        self.write_tokens([entry])
        status, body, _ = self.device_call(f"Bearer {token}", "198.18.7.1", path="/xrnmail/state")
        self.assertEqual(200, status)
        self.assertEqual(self.device_call("Basic " + base64.b64encode(b"owner:secret").decode(), "198.18.7.1")[1], body, "owner's, as the password reads them")

    def test_a_token_for_other_services_is_refused_and_guessed_nothing(self):
        token, entry = self.a_token(services=("xrnrule", "xrnnote"))
        self.write_tokens([entry])
        addr = "198.18.7.2"
        for _ in range(srv.FAIL_LIMIT + 2):
            status, body, res = self.device_call(f"Bearer {token}", addr)
            self.assertEqual(403, status)
            self.assertIn(b"xrnmail", body)
            self.assertIsNone(res.getheader("WWW-Authenticate"))
        self.assertEqual(200, self.with_password(addr), "not locked out: it guessed nothing")

    def test_a_wrong_token_is_a_wrong_login(self):
        token, entry = self.a_token()
        self.write_tokens([entry])
        addr = "198.18.7.3"
        wrong = [f"{token[:16]}{self.a_token()[0][16:]}",  # its id, another secret
                 self.a_token()[0],  # an id that isn't there
                 "xrnhub_" + token[7:],  # another kind of token
                 "not-a-token"]
        for i in range(srv.FAIL_LIMIT):
            self.assertEqual(401, self.bearer(wrong[i % len(wrong)], addr))
        self.assertEqual(429, self.bearer(token, addr), "locked out, the right token too, as with a password")
        self.assertEqual(200, self.bearer(token, "198.18.7.4"))

    def test_a_revoked_token_is_refused_from_its_next_request(self):
        token, entry = self.a_token()
        other, kept = self.a_token()
        self.write_tokens([entry, kept])
        self.assertEqual(200, self.bearer(token, "198.18.7.5"))
        self.write_tokens([kept])  # revoked, and nothing restarted
        self.assertEqual(401, self.bearer(token, "198.18.7.5"))
        self.assertEqual(200, self.bearer(other, "198.18.7.5"))

    def test_a_tokens_user_must_be_in_the_users_file(self):
        import bcrypt

        token, entry = self.a_token(user="sam")
        self.write_tokens([entry])
        self.assertEqual(401, self.bearer(token, "198.18.7.6"), "no sam in the users file")
        with open(srv.args.users, encoding="utf-8") as f:
            before = f.read()
        try:
            with open(srv.args.users, "a", encoding="utf-8") as f:
                f.write("sam:" + bcrypt.hashpw(b"other", bcrypt.gensalt(4)).decode() + "\n")
            self.assertEqual(200, self.bearer(token, "198.18.7.6"))
        finally:
            with open(srv.args.users + ".test", "w", encoding="utf-8") as f:
                f.write(before)
            os.replace(srv.args.users + ".test", srv.args.users)
        self.assertEqual(401, self.bearer(token, "198.18.7.6"), "taken out of it, sam's tokens end")

    def test_a_tokens_file_that_cant_be_read_lets_no_token_in_and_the_password_still_works(self):
        token, entry = self.a_token()
        addr = "198.18.7.7"
        broken = ("{not json", '{"tokens": {}}', "[1]")
        with unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as log:
            for doc in broken:
                self.write_tokens(doc)
                self.assertEqual(401, self.bearer(token, addr))
                self.assertEqual(401, self.bearer(token, addr))
                self.assertEqual(200, self.with_password(addr))
        self.assertEqual(len(broken), log.getvalue().count("can't be read, so no device token signs in"),
                         "a line for each, not for each request")
        self.write_tokens([entry])
        self.assertEqual(200, self.bearer(token, "198.18.7.8"))
        os.remove(self.tokens_path())
        self.assertEqual(401, self.bearer(token, "198.18.7.8"), "no file, no tokens")

    def test_an_entry_not_as_it_should_be_signs_no_one_in(self):
        token, entry = self.a_token()
        for bad in (dict(entry, sha256="\u00e9" * 64), dict(entry, sha256=entry["sha256"].upper()),
                    dict(entry, user="../owner"), dict(entry, user=["owner"]), dict(entry, services="xrnmail"),
                    {k: v for k, v in entry.items() if k != "services"}):
            self.write_tokens([bad, "not an entry"])
            self.assertEqual(401, self.bearer(token, "198.18.7.9"), bad)

    def test_when_a_device_was_last_here_is_written_down_now_and_then(self):
        token, entry = self.a_token()
        gone, revoked = self.a_token()
        self.write_tokens([entry, revoked])
        seen = os.path.join(os.path.dirname(srv.args.users), "device-seen", "xrnmail.json")

        def written():
            st = os.stat(seen)
            with open(seen, encoding="utf-8") as f:
                return (st.st_ino, st.st_mtime_ns), json.load(f), st.st_mode & 0o777

        start = int(time.time())
        self.assertEqual(200, self.bearer(gone, "198.18.7.11"))
        self.assertEqual(200, self.bearer(token, "198.18.7.11"))
        stamp, doc, mode = written()
        self.assertGreaterEqual(doc[entry["id"]], start)
        self.assertIn(revoked["id"], doc)
        self.assertEqual(0o600, mode)
        for _ in range(3):
            self.assertEqual(200, self.bearer(token, "198.18.7.11"))
        self.assertEqual(stamp, written()[0], "not written again within DEVICE_SEEN_S")
        self.write_tokens([entry])
        with unittest.mock.patch.object(srv, "DEVICE_SEEN_S", 0):
            self.assertEqual(200, self.bearer(token, "198.18.7.11"))
        stamp2, doc, _ = written()
        self.assertNotEqual(stamp, stamp2)
        self.assertEqual([entry["id"]], list(doc), "a revoked token's time goes with it")
        with open(seen, encoding="utf-8") as f:
            self.assertNotIn(token[16:], f.read())

    def test_a_token_never_reaches_the_log(self):
        token, entry = self.a_token()
        self.write_tokens([entry])
        wrong = self.a_token()[0]
        with unittest.mock.patch("sys.stderr", new_callable=io.StringIO) as log:
            self.assertEqual(200, self.bearer(token, "198.18.7.12"))
            self.assertEqual(401, self.bearer(wrong, "198.18.7.12"))
            time.sleep(0.05)
        self.assertIn("/state", log.getvalue())
        for secret in (token[16:], wrong[16:]):
            self.assertNotIn(secret, log.getvalue())


if __name__ == "__main__":
    unittest.main()
