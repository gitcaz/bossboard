#!/usr/bin/env python3
"""Migrate a BossBoard v2.1 SQLite database (bossboard.db) to a v3 data-repo folder.

  python3 migrate/migrate_v2.py --db /path/to/bossboard.db --out /path/to/bossboard-data [--git] [--by migrate]

Reads (read-only) every task (done ones too), list, project, resource and activity row. Writes the v3 layout:
tasks/ projects/ resources/ lists/ (one JSON per item, new ids, legacy_id = the old number so `bb.py done 12` still works),
log/YYYY/MM/ (one file per old activity row, `who` -> `by`), bossboard.json, plus README.md, AGENTS.md, bb.py and
.gitattributes copied from data-template/. --git also runs `git init` + one commit. Never touches the source db.
"""
import argparse
import datetime as _dt
import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "cli"))
import bb  # noqa: E402

TEMPLATE_FILES = ["README.md", "AGENTS.md", "bb.py", ".gitattributes"]


def utc_ts(s, fallback):
    if not s:
        return fallback
    try:
        return bb.to_ts(bb.parse_ts(str(s)))
    except ValueError:
        return fallback


def cols(conn, table):
    try:
        return [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]
    except sqlite3.Error:
        return []


def rows(conn, table):
    if not cols(conn, table):
        return []
    return [dict(r) for r in conn.execute("SELECT * FROM %s ORDER BY id" % table)]


def record(kind, iid, fields, created, updated, by, legacy, who=None):
    cb, ub = (who or {}).get((kind, legacy), (by, by))
    r = {"id": iid, "kind": kind, "created_at": created, "created_by": cb, "updated_at": updated, "updated_by": ub,
         "legacy_id": legacy, "field_ts": {}}
    for f in bb.FIELDS[kind]:
        r[f] = fields.get(f, False if f == "deleted" else None)
        r["field_ts"][f] = updated
    if legacy is None:
        del r["legacy_id"]
    return r


def migrate(db, out, by="migrate", now=None):
    now = now or bb.now_ts()
    conn = sqlite3.connect("file:%s?mode=ro" % Path(db).resolve(), uri=True)
    conn.row_factory = sqlite3.Row
    files = {}
    used_ids = set()

    def nid():
        while True:
            i = bb.new_id()
            if i not in used_ids:
                used_ids.add(i)
                return i

    # attribution from the v2.1 activity log: created_by = who created it, updated_by = who touched it last
    who, created_seen = {}, set()
    for a in rows(conn, "activity"):
        ent, old, w = a.get("entity"), a.get("entity_id"), (a.get("who") or "user").lower()
        if ent in ("task", "project", "resource") and old is not None:
            k = (ent, old)
            cb = who[k][0] if k in who else w            # first actor seen ...
            if a.get("action") == "create" and k not in created_seen:
                cb = w                                    # ... unless there is an explicit create row
                created_seen.add(k)
            who[k] = (cb, w)                              # last actor = updated_by
    who = {k: (v[0] or by, v[1] or by) for k, v in who.items()}

    # lists: table rows + any names only used by tasks
    list_ids, lists = {}, []
    tasks = rows(conn, "tasks")
    names = [(r["name"], r.get("sort_order") or 0, r.get("created_at")) for r in rows(conn, "lists")]
    known = {n.lower() for n, _, _ in names}
    mx = max([s for _, s, _ in names] + [0])
    for t in tasks:
        n = (t.get("list") or "Inbox").strip() or "Inbox"
        if n.lower() not in known:
            known.add(n.lower())
            mx += 10
            names.append((n, mx, None))
    taken = set()
    for n, so, ca in names:
        iid = bb.slug(n)
        k = 2
        while iid in taken:
            iid = "%s-%d" % (bb.slug(n), k)
            k += 1
        taken.add(iid)
        list_ids[n.lower()] = iid
        ts = utc_ts(ca, now)
        r = record("list", iid, {"name": n, "sort_order": so, "deleted": False}, ts, ts, by, None)
        files[bb.path_for("list", iid)] = r
        lists.append(r)

    proj = rows(conn, "projects")
    pid = {p["id"]: nid() for p in proj}
    for p in proj:
        c = utc_ts(p.get("created_at"), now)
        u = max(c, utc_ts(p.get("updated_at"), c))
        f = {k: p.get(k) for k in ("name", "description", "owner", "status", "notes")}
        f["parent_id"] = pid.get(p.get("parent_id"))
        f["deleted"] = False
        files[bb.path_for("project", pid[p["id"]])] = record("project", pid[p["id"]], f, c, u, by, p["id"], who)

    res = rows(conn, "resources")
    rid = {r["id"]: nid() for r in res}
    for r in res:
        c = utc_ts(r.get("created_at"), now)
        u = max(c, utc_ts(r.get("updated_at"), c))
        f = {k: r.get(k) for k in ("name", "type", "host", "provider", "os", "ports", "status", "notes")}
        f["project_id"] = pid.get(r.get("project_id"))
        f["deleted"] = False
        files[bb.path_for("resource", rid[r["id"]])] = record("resource", rid[r["id"]], f, c, u, by, r["id"], who)

    tid = {t["id"]: nid() for t in tasks}
    for t in tasks:
        c = utc_ts(t.get("created_at"), now)
        u = max(c, utc_ts(t.get("updated_at"), c))
        due = t.get("due")
        try:
            due = bb.parse_due(due) if due else None
        except bb.BBError:
            pass
        f = {"title": t.get("title"), "list_id": list_ids[((t.get("list") or "Inbox").strip() or "Inbox").lower()],
             "project_id": pid.get(t.get("project_id")), "priority": t.get("priority") or 3,
             "status": t.get("status") or "todo", "due": due, "notes": t.get("notes"),
             "sort_order": t.get("sort_order") or 0,
             "completed_at": utc_ts(t.get("completed_at"), u) if (t.get("status") == "done" or t.get("completed_at")) else None,
             "deleted": False}
        if f["status"] != "done":
            f["completed_at"] = None
        files[bb.path_for("task", tid[t["id"]])] = record("task", tid[t["id"]], f, c, u, by, t["id"], who)

    maps = {"task": tid, "project": pid, "resource": rid}
    nlog = 0
    for a in rows(conn, "activity"):
        ts = utc_ts(a.get("ts"), now)
        e = {"ts": ts, "by": (a.get("who") or "user").lower(), "action": a.get("action"), "entity": a.get("entity"),
             "entity_id": None, "summary": a.get("summary"), "via": "v2.1"}
        ent, old = a.get("entity"), a.get("entity_id")
        if ent in maps and old is not None:
            e["entity_id"] = maps[ent].get(old)
            e["legacy_id"] = old
        if a.get("details"):
            try:
                e["details"] = json.loads(a["details"])
            except ValueError:
                e["details"] = a["details"]
        files[bb.log_path(ts, "v2a%06d" % a["id"])] = e
        nlog += 1
    conn.close()

    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for d in ("tasks", "projects", "resources", "lists", "log"):
        (out / d).mkdir(exist_ok=True)
    for p, d in files.items():
        f = out / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(bb.canonical(d), encoding="utf-8")
    (out / "bossboard.json").write_text(bb.canonical({
        "schema_version": bb.SCHEMA_VERSION, "app": "bossboard", "created_at": now,
        "migrated_from": {"version": "2.1", "db": Path(db).name, "at": now},
        "note": "BossBoard v3 data repo. See README.md (format) and AGENTS.md (how agents write)."}), encoding="utf-8")
    tpl = ROOT / "data-template"
    for name in TEMPLATE_FILES:
        if (tpl / name).exists() and not (out / name).exists():
            shutil.copy2(str(tpl / name), str(out / name))
    return {"lists": len(lists), "projects": len(proj), "resources": len(res), "tasks": len(tasks),
            "done_tasks": len([t for t in tasks if t.get("status") == "done"]), "log": nlog}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", required=True, help="v2.1 bossboard.db (opened read-only)")
    ap.add_argument("--out", required=True, help="output folder (new data repo); must be empty or not exist")
    ap.add_argument("--by", default="migrate")
    ap.add_argument("--git", action="store_true", help="git init the output folder and commit")
    ap.add_argument("--force", action="store_true", help="allow a non-empty output folder")
    a = ap.parse_args(argv)
    if not Path(a.db).exists():
        sys.exit("error: %s not found" % a.db)
    out = Path(a.out)
    if out.exists() and any(out.iterdir()) and not a.force:
        sys.exit("error: %s is not empty (use --force)" % out)
    stats = migrate(a.db, out, a.by)
    if a.git:
        g = ["git", "-C", str(out)]
        subprocess.run(g + ["init", "-q", "-b", "main"], check=True)
        subprocess.run(g + ["add", "-A"], check=True)
        subprocess.run(g + ["-c", "user.name=bossboard-migrate", "-c", "user.email=bossboard@localhost", "commit", "-q",
                            "-m", "Migrate from BossBoard v2.1 (%s)" % json.dumps(stats)], check=True)
    print("migrated: " + ", ".join("%s=%s" % kv for kv in stats.items()) + " -> %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
