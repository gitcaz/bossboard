import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BB = ROOT / "cli" / "bb.py"
sys.path.insert(0, str(ROOT / "cli"))
sys.path.insert(0, str(ROOT / "tests"))


def git(*args, cwd=None):
    return subprocess.run(["git"] + list(args), cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True).stdout


def make_bare(tmp, template=None):
    """Bare repo seeded with data-template (or another folder). Returns its path."""
    tmp = Path(tmp)
    bare = tmp / "data.git"
    git("init", "-q", "--bare", "-b", "main", str(bare))
    seed = tmp / "seed"
    shutil.copytree(str(template or (ROOT / "data-template")), str(seed))
    git("init", "-q", "-b", "main", cwd=seed)
    git("add", "-A", cwd=seed)
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", cwd=seed)
    git("push", "-q", str(bare), "main", cwd=seed)
    return bare


def clone(bare, dest):
    git("clone", "-q", str(bare), str(dest))
    git("config", "user.name", "tester", cwd=dest)
    git("config", "user.email", "tester@localhost", cwd=dest)
    return Path(dest)


def start_fake(bare, token="fake_token"):
    import fake_github
    srv = fake_github.make_server(str(bare), 0, token)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


def run_bb(*args, env=None, check=True, cwd=None):
    e = {k: v for k, v in os.environ.items() if not k.startswith("BOSSBOARD_") and k not in ("GITHUB_TOKEN",)}
    e.update(env or {})
    p = subprocess.run([sys.executable, str(BB)] + [str(a) for a in args], env=e, cwd=cwd, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, universal_newlines=True)
    if check and p.returncode != 0:
        raise AssertionError("bb %s failed (%d):\n%s\n%s" % (" ".join(map(str, args)), p.returncode, p.stdout, p.stderr))
    return p
