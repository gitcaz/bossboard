#!/usr/bin/env python3
"""Fake GitHub REST server (Git Data API subset) backed by a real bare git repo. Test use only.

  python3 tests/fake_github.py --repo /tmp/data.git --port 8787 --token fake_token [--owner o --name r]

Endpoints (under /repos/{owner}/{name}): GET git/ref/heads/B, GET git/commits/SHA, GET git/trees/SHA[?recursive=1],
GET git/blobs/SHA, POST git/trees, POST git/commits, PATCH git/refs/heads/B (non-fast-forward -> 422).
Bearer auth (401 on a wrong token), CORS for the web app, optional rate-limit simulation:
POST /_fake/ratelimit {"n": 2, "retry_after": 1} makes the next n API calls answer 429.
POST /_fake/offline {"on": true} makes every API call fail with a dropped connection.
GET /_fake/stats returns request counters.
The same bare repo can be cloned/pushed with plain git, so CLI git-backend clients and REST/web clients share state.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Repo:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()

    def git(self, *args, inp=None, env=None, check=True):
        e = dict(os.environ)
        e.update({"GIT_AUTHOR_NAME": "fake-github", "GIT_AUTHOR_EMAIL": "fake@localhost",
                  "GIT_COMMITTER_NAME": "fake-github", "GIT_COMMITTER_EMAIL": "fake@localhost"})
        if env:
            e.update(env)
        p = subprocess.run(["git", "--git-dir", self.path] + list(args), input=inp, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=e)
        if check and p.returncode != 0:
            raise RuntimeError("git %s: %s" % (" ".join(args), p.stderr.decode(errors="replace")))
        return p

    def out(self, *a, **k):
        return self.git(*a, **k).stdout.decode().strip()

    def obj_type(self, sha):
        p = self.git("cat-file", "-t", sha, check=False)
        return p.stdout.decode().strip() if p.returncode == 0 else None

    def has_refs(self):
        return bool(self.out("for-each-ref", "--count=1"))


def _json(h, code, obj, extra=None):
    body = json.dumps(obj).encode()
    h.send_response(code)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(body)))
    h._cors()
    for k, v in (extra or {}).items():
        h.send_header(k, str(v))
    h.end_headers()
    h.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    server_version = "FakeGitHub/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write("fake-github: " + (fmt % args) + "\n")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-GitHub-Api-Version")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "x-ratelimit-remaining, x-ratelimit-reset, retry-after")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PATCH(self):
        self._handle("PATCH")

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw) if raw else {}

    def _handle(self, method):
        s = self.server
        path, _, query = self.path.partition("?")
        body = self._body() if method in ("POST", "PATCH") else None
        if path.startswith("/_fake/"):
            if path == "/_fake/ratelimit":
                s.ratelimit = int(body.get("n", 1))
                s.retry_after = int(body.get("retry_after", 1))
                return _json(self, 200, {"ok": True})
            if path == "/_fake/offline":
                s.offline = bool(body.get("on"))
                return _json(self, 200, {"ok": True, "offline": s.offline})
            if path == "/_fake/stats":
                return _json(self, 200, s.stats)
            if path == "/_fake/head":
                return _json(self, 200, {"sha": s.repo.out("rev-parse", "--verify", "-q", "refs/heads/" + s.branch, check=False)})
            return _json(self, 404, {"message": "Not Found"})
        if s.offline:
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            return
        s.stats["requests"] = s.stats.get("requests", 0) + 1
        s.stats[method] = s.stats.get(method, 0) + 1
        auth = self.headers.get("Authorization", "")
        if auth != "Bearer " + s.token:
            s.stats["unauthorized"] = s.stats.get("unauthorized", 0) + 1
            return _json(self, 401, {"message": "Bad credentials"})
        if s.ratelimit > 0:
            s.ratelimit -= 1
            s.stats["ratelimited"] = s.stats.get("ratelimited", 0) + 1
            return _json(self, 429, {"message": "API rate limit exceeded"},
                         {"retry-after": s.retry_after, "x-ratelimit-remaining": 0})
        m = re.match(r"^/repos/([^/]+)/([^/]+)/git/(.+)$", path)
        if not m or (m.group(1), m.group(2)) != (s.owner, s.name):
            return _json(self, 404, {"message": "Not Found"})
        sub = m.group(3)
        try:
            with s.repo.lock:
                return self._git_api(method, sub, query, body)
        except Exception as e:  # pragma: no cover
            return _json(self, 500, {"message": str(e)})

    def _git_api(self, method, sub, query, body):
        s = self.server
        r = s.repo
        rl = {"x-ratelimit-remaining": 4999, "x-ratelimit-reset": 9999999999}
        mm = re.match(r"^ref/heads/(.+)$", sub)
        if method == "GET" and mm:
            if not r.has_refs():
                return _json(self, 409, {"message": "Git Repository is empty."})
            sha = r.out("rev-parse", "--verify", "-q", "refs/heads/" + mm.group(1), check=False)
            if not sha:
                return _json(self, 404, {"message": "Not Found"})
            return _json(self, 200, {"ref": "refs/heads/" + mm.group(1), "object": {"sha": sha, "type": "commit"}}, rl)
        mm = re.match(r"^commits/([0-9a-f]{40})$", sub)
        if method == "GET" and mm:
            sha = mm.group(1)
            if r.obj_type(sha) != "commit":
                return _json(self, 404, {"message": "Not Found"})
            raw = r.out("cat-file", "commit", sha)
            hdr, _, msg = raw.partition("\n\n")
            tree = re.search(r"^tree (\w+)", hdr, re.M).group(1)
            parents = re.findall(r"^parent (\w+)", hdr, re.M)
            return _json(self, 200, {"sha": sha, "tree": {"sha": tree}, "parents": [{"sha": p} for p in parents],
                                     "message": msg}, rl)
        mm = re.match(r"^trees/([0-9a-f]{40})$", sub)
        if method == "GET" and mm:
            sha = mm.group(1)
            if r.obj_type(sha) != "tree":
                return _json(self, 404, {"message": "Not Found"})
            args = ["ls-tree", "-l"] + (["-r", "-t"] if "recursive" in query else []) + [sha]
            entries = []
            for line in r.out(*args).splitlines():
                meta, path = line.split("\t", 1)
                mode, typ, osha, size = meta.split()
                e = {"path": path, "mode": mode, "type": typ, "sha": osha}
                if typ == "blob":
                    e["size"] = int(size)
                entries.append(e)
            return _json(self, 200, {"sha": sha, "tree": entries, "truncated": False}, rl)
        mm = re.match(r"^blobs/([0-9a-f]{40})$", sub)
        if method == "GET" and mm:
            sha = mm.group(1)
            if r.obj_type(sha) != "blob":
                return _json(self, 404, {"message": "Not Found"})
            data = r.git("cat-file", "blob", sha).stdout
            return _json(self, 200, {"sha": sha, "size": len(data), "encoding": "base64",
                                     "content": base64.encodebytes(data).decode()}, rl)
        if method == "POST" and sub == "trees":
            return self._create_tree(body)
        if method == "POST" and sub == "commits":
            tree, parents = body.get("tree"), body.get("parents") or []
            if r.obj_type(tree or "0" * 40) != "tree" or any(r.obj_type(p) != "commit" for p in parents):
                return _json(self, 422, {"message": "Tree or parent SHA does not exist"})
            args = ["commit-tree", tree]
            for p in parents:
                args += ["-p", p]
            sha = r.git(*args, inp=(body.get("message") or "").encode()).stdout.decode().strip()
            return _json(self, 201, {"sha": sha, "tree": {"sha": tree}, "parents": [{"sha": p} for p in parents]})
        mm = re.match(r"^refs/heads/(.+)$", sub)
        if method == "PATCH" and mm:
            ref = "refs/heads/" + mm.group(1)
            new = body.get("sha")
            old = r.out("rev-parse", "--verify", "-q", ref, check=False)
            if not old:
                return _json(self, 422, {"message": "Reference does not exist"})
            if r.obj_type(new or "0" * 40) != "commit":
                return _json(self, 422, {"message": "Object does not exist"})
            if not body.get("force") and r.git("merge-base", "--is-ancestor", old, new, check=False).returncode != 0:
                s.stats["conflicts"] = s.stats.get("conflicts", 0) + 1
                return _json(self, 422, {"message": "Update is not a fast forward"})
            if r.git("update-ref", ref, new, old, check=False).returncode != 0:
                return _json(self, 422, {"message": "Reference update failed"})
            s.stats["commits"] = s.stats.get("commits", 0) + 1
            return _json(self, 200, {"ref": ref, "object": {"sha": new, "type": "commit"}})
        return _json(self, 404, {"message": "Not Found"})

    def _create_tree(self, body):
        r = self.server.repo
        base = body.get("base_tree")
        fd, idx = tempfile.mkstemp(prefix="fakegh-idx-")
        os.close(fd)
        os.unlink(idx)
        env = {"GIT_INDEX_FILE": idx}
        try:
            if base:
                if r.obj_type(base) != "tree":
                    return _json(self, 422, {"message": "base_tree does not exist"})
                r.git("read-tree", base, env=env)
            else:
                r.git("read-tree", "--empty", env=env)
            lines = []
            for e in body.get("tree") or []:
                path, mode = e["path"], e.get("mode", "100644")
                if "content" in e:
                    sha = r.git("hash-object", "-w", "--stdin", inp=e["content"].encode("utf-8")).stdout.decode().strip()
                elif e.get("sha") is None and "sha" in e:
                    r.git("update-index", "--force-remove", "--", path, env=env)
                    continue
                else:
                    sha = e["sha"]
                lines.append("%s %s\t%s" % (mode, sha, path))
            if lines:
                r.git("update-index", "--add", "--index-info", inp=("\n".join(lines) + "\n").encode("utf-8"), env=env)
            sha = r.git("write-tree", env=env).stdout.decode().strip()
            return _json(self, 201, {"sha": sha})
        finally:
            if os.path.exists(idx):
                os.unlink(idx)


def make_server(repo, port=0, token="fake_token", owner="o", name="data", branch="main", verbose=False, host="127.0.0.1"):
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    srv.repo = Repo(repo)
    srv.token, srv.owner, srv.name, srv.branch, srv.verbose = token, owner, name, branch, verbose
    srv.ratelimit, srv.retry_after, srv.offline, srv.stats = 0, 1, False, {}
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="path to a bare git repo")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--token", default="fake_token")
    ap.add_argument("--owner", default="o")
    ap.add_argument("--name", default="data")
    ap.add_argument("--branch", default="main")
    ap.add_argument("-v", action="store_true")
    a = ap.parse_args()
    srv = make_server(a.repo, a.port, a.token, a.owner, a.name, a.branch, a.v)
    print("fake github on http://127.0.0.1:%d repo=%s/%s -> %s" % (srv.server_address[1], a.owner, a.name, a.repo), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
