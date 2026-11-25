"""deploy.sh against a made-up server: ssh, sv, curl, tailscale and sv-guard are stand-ins that run here.

    python3 -m unittest server/test_deploy.py

It installs a fresh service and is run again on top of it, reading back what it wrote on the
"phone". The server's own tests, which deploy.sh runs first, are left to test_xrnmail_sync.py:
here they pass, or fail when a test says so.
"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY = os.path.join(HERE, "deploy.sh")
PYTHON3 = shutil.which("python3")

FAKES = {
    # ssh HOST SCRIPT: the script runs here, in the made-up home, as it would on the phone.
    "ssh": '#!/bin/sh\nshift\nexec sh -c "$*"\n',
    # runit's sv, with no runsv running: `status` fails as it does once one has exited, and a
    # service it is told about must be there.
    "sv": """#!/bin/sh
echo "sv $*" >> "$HOME/calls"
while [ "${1#-}" != "$1" ]; do
    if [ "$1" = -w ]; then shift; fi
    shift
done
command=$1
shift
[ "$command" = status ] && exit 1
for service; do
    case $service in
        /*) [ -d "$service" ] || exit 1 ;;
        *) [ -d "$SVDIR/$service" ] || exit 1 ;;
    esac
done
exit 0
""",
    "curl": "#!/bin/sh\nprintf ok\n",
    # Funnel's paths, one "<path> <target>" a line in $HOME/funnel.
    "tailscale": """#!/bin/sh
echo "tailscale $*" >> "$HOME/calls"
paths=$HOME/funnel
touch "$paths"
case "$*" in
    "funnel status --json")
        echo '{"Web": {"host.example:443": {"Handlers": {'
        sed 's/^\\([^ ]*\\) \\(.*\\)$/  "\\1": {"Proxy": "\\2"},/' "$paths"
        echo '}}}}' ;;
    "funnel status") echo "Funnel on"; cat "$paths" ;;
    "funnel --bg --set-path "*)
        grep -v "^$4 " "$paths" > "$paths.new" || true
        echo "$4 $5" >> "$paths.new"
        mv "$paths.new" "$paths" ;;
    *) exit 1 ;;
esac
""",
    "python": '#!/bin/sh\nexec python3 "$@"\n',
    # The server tests deploy.sh runs first pass, unless the test has made them fail.
    "python3": f"""#!/bin/sh
if [ "$*" = "-m unittest server/test_xrnmail_sync.py" ]; then
    [ -e "$HOME/tests-fail" ] && exit 1
    exit 0
fi
exec {PYTHON3} "$@"
""",
}

# The home-server's sv-guard: says what it was asked, and fails as one that found the port taken
# when $HOME/port-taken is there.
GUARD = '#!/bin/sh\necho "sv-guard $*" >> "$HOME/calls"\n[ -e "$HOME/port-taken" ] && exit 1\nexit 0\n'


def write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)


def read(path):
    with open(path) as f:
        return f.read()


@unittest.skipUnless(shutil.which("sh") and shutil.which("tar") and PYTHON3, "needs sh, tar and python3")
class Deploy(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="xrnmail-deploy-")
        self.home = os.path.join(self.root, "home")
        self.prefix = os.path.join(self.root, "usr")
        self.bin = os.path.join(self.root, "bin")
        self.services = os.path.join(self.prefix, "var", "service")
        self.logs = os.path.join(self.prefix, "var", "log", "sv")
        for d in (self.home, self.services, self.bin):
            os.makedirs(d)
        for name, body in FAKES.items():
            write(os.path.join(self.bin, name), body, stat.S_IRWXU)
        write(self.guard, GUARD, stat.S_IRWXU)

    def tearDown(self):
        shutil.rmtree(self.root)

    guard = property(lambda self: os.path.join(self.home, ".local", "bin", "sv-guard"))
    home_dir = property(lambda self: os.path.join(self.home, "xrnmail-sync"))

    def deploy(self):
        open(os.path.join(self.home, "calls"), "w").close()
        env = {**os.environ, "HOME": self.home, "PREFIX": self.prefix, "PATH": f"{self.bin}:{os.environ['PATH']}",
               "PYTHONDONTWRITEBYTECODE": "1"}
        return subprocess.run(["sh", DEPLOY, "phone"], env=env, capture_output=True, text=True, timeout=120)

    def calls(self):
        return read(os.path.join(self.home, "calls")).splitlines()

    def funnel(self):
        path = os.path.join(self.home, "funnel")
        return read(path).splitlines() if os.path.exists(path) else []

    def assert_no_half_built_service(self):
        self.assertEqual([n for n in os.listdir(self.services) if n.startswith(".")], [])

    def test_a_fresh_install_writes_the_service_and_publishes_the_path(self):
        write(os.path.join(self.home, "funnel"), "/ http://127.0.0.1:5232\n")
        done = self.deploy()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue(os.path.isfile(os.path.join(self.home_dir, "xrnmail-sync.py")))
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.home_dir, "data")).st_mode), 0o700)
        service = os.path.join(self.services, "xrnmail-sync")
        run = read(os.path.join(service, "run"))
        self.assertTrue(run.startswith(f"#!{self.prefix}/bin/sh\n"))
        self.assertIn(f"\n{self.home}/.local/bin/sv-guard 5243 {self.home}/xrnmail-sync/xrnmail-sync.py || exit 1\n"
                      f"exec python {self.home}/xrnmail-sync/xrnmail-sync.py \\\n  --port 5243 "
                      f"--data {self.home}/xrnmail-sync/data \\\n  --users {self.home}/.config/xrn-sync/users 2>&1\n", run)
        self.assertEqual(read(os.path.join(service, "log", "run")),
                         f'#!{self.prefix}/bin/sh\nmkdir -p "{self.prefix}/var/log/sv/xrnmail-sync"\n'
                         f'exec svlogd -tt "{self.prefix}/var/log/sv/xrnmail-sync"\n')
        self.assert_no_half_built_service()
        # The calendar's path is left as it was.
        self.assertEqual(sorted(self.funnel()), ["/ http://127.0.0.1:5232", "/xrnmail http://127.0.0.1:5243"])
        self.assertNotIn("serve", " ".join(self.calls()))
        said = done.stdout.split("What it did:")[1]
        for line in ("installed the xrnmail-sync service", "published /xrnmail"):
            self.assertIn(line, said)

    def test_running_it_again_restarts_it_and_keeps_the_data(self):
        self.assertEqual(self.deploy().returncode, 0)
        state = os.path.join(self.home_dir, "data", "users", "alex", "state.json")
        write(state, '{"version": 3, "data": {"settings": {}}}')
        run = os.path.join(self.services, "xrnmail-sync", "run")
        write(run, "#!/bin/sh\nexec python an-old-run-script.py\n", 0o755)
        done = self.deploy()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(read(state), '{"version": 3, "data": {"settings": {}}}')
        self.assertIn("sv restart xrnmail-sync", self.calls())
        self.assertIn("sv-guard 5243", read(run))
        self.assert_no_half_built_service()
        self.assertIn("restarted xrnmail-sync", done.stdout.split("What it did:")[1])

    def assert_nothing_changed(self):
        self.assertFalse(os.path.exists(self.home_dir))
        self.assertFalse(os.path.exists(os.path.join(self.services, "xrnmail-sync")))
        self.assertFalse([c for c in self.calls() if c.startswith(("sv ", "tailscale "))])

    def test_without_sv_guard_nothing_changes(self):
        os.remove(self.guard)
        done = self.deploy()
        self.assertEqual(done.returncode, 1)
        self.assertIn("sv-guard is missing", done.stderr)
        self.assert_nothing_changed()

    def test_failing_server_tests_change_nothing(self):
        write(os.path.join(self.home, "tests-fail"), "")
        done = self.deploy()
        self.assertEqual(done.returncode, 1)
        self.assertIn("The server tests failed", done.stderr)
        self.assert_nothing_changed()


if __name__ == "__main__":
    unittest.main()
