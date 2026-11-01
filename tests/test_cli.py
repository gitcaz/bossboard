import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import ROOT, clone, git, make_bare, run_bb, start_fake
import bb
import v2_fixture

V2 = Path("/workspace/bossboard/bossboard.py")


def J(p):
    return json.loads(p.stdout)


class GitBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.bare = make_bare(self.t)
        self.c1 = clone(self.bare, self.t / "c1")
        self.c2 = clone(self.bare, self.t / "c2")

    def tearDown(self):
        self.tmp.cleanup()

    def bb1(self, *a, **k):
        return run_bb("--dir", self.c1, *a, **k)

    def bb2(self, *a, **k):
        return run_bb("--dir", self.c2, *a, **k)

    def test_full_command_surface(self):
        p = J(self.bb1("add-project", "Website", "-o", "user", "-s", "active", "--by", "boss", "--json"))
        self.assertEqual(p["name"], "Website")
        c = J(self.bb1("add-project", "Infra", "--parent", "Website", "--by", "boss", "--json"))
        self.assertEqual(c["parent_name"], "Website")
        t = J(self.bb1("add-task", "Fix pipeline", "-l", "Work", "-p", "Website", "-P", "1", "-d", "today", "--by", "codex", "--json"))
        self.assertEqual((t["list"], t["project_name"], t["priority"]), ("Work", "Website", 1))
        t2 = J(self.bb1("add", "Water plants", "-l", "Home", "--by", "boss", "--json"))
        t3 = J(self.bb1("add", "New context task", "-l", "Garage", "--by", "boss", "--json"))
        self.assertEqual(t3["list_id"], "garage")
        nxt = J(self.bb1("next", "--json"))
        self.assertEqual(nxt["id"], t["id"])
        self.bb1("start", t2["handle"], "--by", "claude")
        self.assertEqual(J(self.bb1("next", "--json"))["id"], t2["id"])  # doing first
        today = J(self.bb1("today", "--json"))
        self.assertEqual({x["bucket"] for x in today}, {"doing", "today"})
        self.bb1("done", t["handle"], t2["handle"], "--by", "codex")
        self.assertEqual(len(J(self.bb1("list", "--json"))), 1)
        self.assertEqual(len(J(self.bb1("list", "--all", "--json"))), 3)
        self.assertEqual(len(J(self.bb1("list", "--status", "done", "--json"))), 2)
        self.bb1("reopen", t["handle"], "--by", "boss")
        e = J(self.bb1("edit", t["handle"], "--title", "Fix the pipeline", "-d", "none", "-p", "none", "--by", "codex", "--json"))
        self.assertEqual((e["title"], e["due"], e["project_id"]), ("Fix the pipeline", None, None))
        self.bb1("update-task", t3["handle"], "-l", "Home", "--by", "boss")
        self.bb1("delete-list", "Garage", "--by", "boss")
        lists = [l["name"] for l in J(self.bb1("lists", "--json"))]
        self.assertNotIn("Garage", lists)
        self.bb1("rename-list", "Errands", "Shopping", "--by", "boss")
        self.assertIn("Shopping", [l["name"] for l in J(self.bb1("lists", "--json"))])
        r = J(self.bb1("add-resource", "vm1", "-t", "server", "-p", "Website", "--host", "10.0.0.1", "-n", "root: 1Password", "--by", "boss", "--json"))
        self.assertEqual(r["project_name"], "Website")
        self.bb1("update-resource", "vm1", "--ports", "22,443", "--by", "codex")
        self.assertEqual(J(self.bb1("resources", "--json"))[0]["ports"], "22,443")
        self.assertEqual(J(self.bb1("inventory", "-t", "server", "--json"))[0]["name"], "vm1")
        self.bb1("update-project", "Infra", "-s", "paused", "--by", "boss")
        self.assertEqual({p["name"]: p["status"] for p in J(self.bb1("projects", "--json"))}["Infra"], "paused")
        self.bb1("move-task", t3["handle"], "top", "--by", "boss")
        home = [x["id"] for x in J(self.bb1("list", "-l", "Home", "--all", "--json"))]
        self.assertEqual(home[0], t3["id"])
        bad = self.bb1("add-resource", "Leak", "-n", "sk-abcdefghijklmnopqrstuvwxyz123456", "--by", "boss", check=False)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("secret", bad.stderr)
        self.bb1("delete-task", t3["handle"], "--by", "boss")
        self.bb1("delete-resource", "vm1", "--by", "boss")
        self.bb1("delete-project", "Infra", "--by", "boss")
        log = J(self.bb1("log", "-n", "100", "--json"))
        self.assertTrue(all(e.get("by") for e in log))
        self.assertEqual(log[0]["action"], "delete")
        bys = {e["by"] for e in log}
        self.assertTrue({"boss", "codex", "claude"} <= bys)
        actions = {e["action"] for e in log}
        self.assertTrue({"create", "update", "start", "done", "reopen", "delete", "rename", "reorder"} <= actions)
        # every write was pushed: c2 sees the same thing after a read
        self.assertEqual(J(self.bb2("list", "--all", "--json")), J(self.bb1("list", "--all", "--json")))
        # one commit per write, files canonical
        for f in (self.c1 / "tasks").glob("*.json"):
            self.assertEqual(f.read_text(), bb.canonical(json.loads(f.read_text())))
        self.assertIn("by codex", git("log", "--format=%s", cwd=self.c1))

    def test_offline_clients_conflict_merge(self):
        t = J(self.bb1("add", "Water plants", "-l", "Home", "--by", "boss", "--json"))
        self.bb2("list")  # c2 pulls
        # both offline: same task, different + same fields
        self.bb1("--no-push", "edit", t["handle"], "--title", "Water ALL plants", "-P", "2", "--by", "phone")
        self.bb2("--no-push", "edit", t["handle"], "-n", "windows too", "-P", "1", "--by", "codex")
        self.bb2("--no-push", "add", "Offline task from c2", "-l", "Work", "--by", "codex")
        self.bb1("--no-push", "add-list", "Garage", "--by", "phone")
        self.bb2("--no-push", "add-list", "Garage", "--by", "codex")
        self.assertIn("synced", self.bb1("sync").stdout)
        self.assertIn("synced", self.bb2("sync").stdout)
        self.bb1("sync")
        a = J(self.bb1("show", "task", t["handle"], "--json"))
        b = J(self.bb2("show", "task", t["handle"], "--json"))
        self.assertEqual(a, b)
        self.assertEqual(a["title"], "Water ALL plants")
        self.assertEqual(a["notes"], "windows too")
        self.assertEqual(a["priority"], 1)  # c2 edited priority later
        self.assertEqual([l["name"] for l in J(self.bb1("lists", "--json"))].count("Garage"), 1)
        self.assertEqual(len(J(self.bb1("list", "--json"))), 2)
        self.assertEqual(len([e for e in J(self.bb1("log", "-n", "50", "--json")) if e["action"] == "update"]), 2)

    def test_offline_unreachable_remote_commits_locally(self):
        git("remote", "set-url", "origin", str(self.t / "missing.git"), cwd=self.c1)
        p = self.bb1("add", "Offline", "--by", "boss")
        self.assertIn("committed locally", p.stderr)
        git("remote", "set-url", "origin", str(self.bare), cwd=self.c1)
        self.bb1("next")  # read publishes pending commits
        self.assertIn("Offline", self.bb2("list").stdout)

    def test_dirty_worktree_refused(self):
        (self.c1 / "tasks" / "xxxx.json").write_text("{}")
        p = self.bb1("add", "x", "--by", "boss", check=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("uncommitted", p.stderr)

    def test_newer_schema_refuses_writes(self):
        (self.c1 / "bossboard.json").write_text(bb.canonical({"schema_version": 4}))
        git("commit", "-qam", "schema4", cwd=self.c1)
        p = self.bb1("add", "x", "--by", "boss", check=False)
        self.assertIn("schema_version", p.stderr)
        self.bb1("list")  # reads still work

    def test_autodetect_dir(self):
        p = run_bb("add", "via cwd", "--by", "boss", cwd=self.c1)
        self.assertIn("via cwd", p.stdout)


class RestBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)
        self.bare = make_bare(self.t)
        self.srv, self.api = start_fake(self.bare)
        self.env = {"BOSSBOARD_REPO": "o/data", "BOSSBOARD_TOKEN": "fake_token", "BOSSBOARD_API": self.api,
                    "BOSSBOARD_CACHE": str(self.t / "cache")}

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def rb(self, *a, **k):
        env = dict(self.env)
        env.update(k.pop("env", {}))
        return run_bb(*a, env=env, **k)

    def test_rest_roundtrip_and_git_interop(self):
        t = J(self.rb("add", "Via REST", "-l", "Errands", "-P", "2", "--by", "claude", "--json"))
        self.rb("start", t["handle"], "--by", "claude")
        self.assertEqual(J(self.rb("next", "--json"))["status"], "doing")
        c = clone(self.bare, self.t / "c")
        out = J(run_bb("--dir", c, "list", "--json"))
        self.assertEqual(out[0]["title"], "Via REST")
        run_bb("--dir", c, "done", t["handle"], "--by", "codex")
        self.assertEqual(J(self.rb("list", "--all", "--json"))[0]["status"], "done")
        self.assertEqual(self.srv.stats.get("commits"), 2)
        log = J(self.rb("log", "-n", "5", "--json"))
        self.assertEqual([e["by"] for e in log], ["codex", "claude", "claude"])

    def test_rest_conflict_retry(self):
        t = J(self.rb("add", "Race", "--by", "boss", "--json"))
        be = bb.RestBackend("o/data", "fake_token", "main", self.api, str(self.t / "cache2"))
        calls = []

        def fn(ops, snap):
            if not calls:  # someone else commits between our load and our ref update
                self.rb("edit", t["handle"], "-n", "from other writer", "--by", "codex")
            calls.append(1)
            return [ops.update("task", t["id"], {"priority": 1})]
        res, snap, st = bb.run_write(be, "boss", fn, lambda r, s: "test")
        self.assertEqual(st, "pushed")
        self.assertEqual(len(calls), 2)
        self.assertGreaterEqual(self.srv.stats.get("conflicts", 0), 1)
        final = J(self.rb("show", "task", t["handle"], "--json"))
        self.assertEqual((final["priority"], final["notes"]), (1, "from other writer"))

    def test_bad_token(self):
        p = self.rb("next", env={"BOSSBOARD_TOKEN": "wrong"}, check=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("rejected the token", p.stderr)
        self.assertNotIn("wrong", p.stderr)

    def test_rate_limit_waits(self):
        self.srv.ratelimit, self.srv.retry_after = 1, 1
        p = self.rb("next")
        self.assertIn("rate limited", p.stderr)
        self.assertEqual(p.returncode, 0)

    def test_api_base_locked(self):
        p = self.rb("next", env={"BOSSBOARD_API": "https://evil.example.com"}, check=False)
        self.assertIn("api.github.com", p.stderr)
        with self.assertRaises(bb.BBError):
            bb.safe_api_base("http://10.0.0.5:80")

    def test_offline_error(self):
        self.srv.offline = True
        p = self.rb("next", check=False)
        self.assertIn("cannot reach GitHub", p.stderr)


@unittest.skipUnless(V2.exists(), "v2.1 reference not present")
class MigrationTests(unittest.TestCase):
    def test_migrate_sample_db(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            env = dict(os.environ, BOSSBOARD_DB=str(d / "v2.db"))

            def v2(*a):
                subprocess.run([sys.executable, str(V2)] + list(a), env=env, check=True, stdout=subprocess.PIPE)
            v2_fixture.make(d / "v2.db")   # v2.1 init + generic sample data instead of the built-in seed
            v2("add-task", "Buy milk", "-l", "Errands", "-P", "2", "-d", "2026-11-05", "-p", "Website", "--by", "boss")
            v2("add-task", "Garage thing", "-l", "Garage", "-n", "multi\nline", "--by", "codex")
            v2("done", "1", "--by", "codex")
            v2("start", "2", "--by", "claude")
            v2("add-resource", "dns.example", "-t", "domain", "-p", "Gateway", "--by", "boss")
            v2("update-project", "Chatbot", "-s", "paused", "--by", "boss")
            src = sqlite3.connect(str(d / "v2.db"))
            n_tasks = src.execute("select count(*) from tasks").fetchone()[0]
            n_act = src.execute("select count(*) from activity").fetchone()[0]
            src.close()
            out = d / "data"
            subprocess.run([sys.executable, str(ROOT / "migrate" / "migrate_v2.py"), "--db", str(d / "v2.db"),
                            "--out", str(out), "--git"], check=True, stdout=subprocess.PIPE)
            self.assertTrue((out / "AGENTS.md").exists() and (out / "bb.py").exists())
            self.assertEqual(json.loads((out / "bossboard.json").read_text())["schema_version"], 3)
            tasks = J(run_bb("--dir", out, "--no-push", "list", "--all", "--json"))
            self.assertEqual(len(tasks), n_tasks)
            by_legacy = {t["legacy_id"]: t for t in tasks}
            self.assertEqual(by_legacy[1]["status"], "done")
            self.assertTrue(by_legacy[1]["completed_at"].endswith("Z"))
            self.assertEqual(by_legacy[2]["status"], "doing")
            milk = next(t for t in tasks if t["title"] == "Buy milk")
            self.assertEqual((milk["list"], milk["project_name"], milk["due"], milk["priority"]),
                             ("Errands", "Website", "2026-11-05", 2))
            self.assertEqual(next(t for t in tasks if t["title"] == "Garage thing")["notes"], "multi\nline")
            projects = {p["name"]: p for p in J(run_bb("--dir", out, "projects", "--json"))}
            self.assertEqual(projects["Gateway"]["parent_name"], "Website")
            self.assertEqual(projects["Chatbot"]["status"], "paused")
            res = {r["name"]: r for r in J(run_bb("--dir", out, "resources", "--json"))}
            self.assertEqual(res["dns.example"]["project_name"], "Gateway")
            self.assertIn("vm1", res)
            log = J(run_bb("--dir", out, "log", "-n", "1000", "--json"))
            self.assertEqual(len(log), n_act)
            self.assertTrue(any(e["by"] == "claude" and e["action"] == "start" for e in log))
            self.assertTrue(all(e["ts"].endswith("Z") for e in log))
            # legacy handles keep working for writes
            run_bb("--dir", out, "--no-push", "done", "2", "--by", "codex")
            self.assertEqual(J(run_bb("--dir", out, "show", "task", "#2", "--json"))["status"], "done")
            # new items get id-prefix handles
            n = J(run_bb("--dir", out, "--no-push", "add", "fresh", "--by", "boss", "--json"))
            self.assertGreaterEqual(len(n["handle"]), 4)
            self.assertFalse(n["handle"].isdigit())


if __name__ == "__main__":
    unittest.main()
