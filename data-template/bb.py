#!/usr/bin/env python3
"""bb - BossBoard v3 CLI (Python 3.8+, standard library only).

Reads and writes the BossBoard data repo (one JSON file per item, git history = backup).
Backends:
  git   a local clone of the data repo: --dir PATH or BOSSBOARD_DIR, or the folder holding this script /
        the current folder if it contains bossboard.json. Each write = fetch, apply, commit, push (retries on conflict).
  rest  GitHub REST (Git Data API): BOSSBOARD_REPO=owner/name plus BOSSBOARD_TOKEN or GITHUB_TOKEN.
Every write takes --by (or BOSSBOARD_BY) and adds an activity-log entry. Run `bb.py -h` / `bb.py CMD -h`.
"""
import argparse
import base64
import datetime as _dt
import hashlib
import json
import os
import random
import re
import secrets
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "3.0.0"
SCHEMA_VERSION = 3
DIRS = {"task": "tasks", "project": "projects", "resource": "resources", "list": "lists"}
FIELDS = {
    "task": ["title", "list_id", "project_id", "priority", "status", "due", "notes", "sort_order", "completed_at", "deleted"],
    "project": ["name", "description", "owner", "status", "notes", "parent_id", "deleted"],
    "resource": ["name", "type", "project_id", "host", "provider", "os", "ports", "status", "notes", "deleted"],
    "list": ["name", "sort_order", "deleted"],
}
LABEL = {"task": "title", "project": "name", "resource": "name", "list": "name"}
META = ["id", "kind", "created_at", "created_by", "updated_at", "updated_by", "legacy_id", "field_ts"]
TASK_STATUSES = ("todo", "doing", "done")
SECRET_PATTERNS = [re.compile(p) for p in (
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----", r"\bsk-[A-Za-z0-9_\-]{20,}", r"\bgh[pousr]_[A-Za-z0-9]{30,}",
    r"\bgithub_pat_[A-Za-z0-9_]{30,}", r"\bAKIA[0-9A-Z]{16}\b", r"\bxox[abpr]-[A-Za-z0-9\-]{10,}", r"\bAIza[0-9A-Za-z_\-]{35}",
)]
ITEM_RE = re.compile(r"^(tasks|projects|resources|lists)/[A-Za-z0-9_-]+\.json$")
LOG_RE = re.compile(r"^log/\d{4}/\d{2}/[A-Za-z0-9_-]+\.json$")
DEFAULT_API = "https://api.github.com"


class BBError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


class Conflict(Exception):
    pass


class Offline(Exception):
    pass


# ---------------------------------------------------------------- time & ids
_last_ts = [""]


def to_ts(d):
    d = d.astimezone(_dt.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)


def parse_ts(s):
    s = s.strip().replace(" ", "T")
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = _dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.astimezone()
    return d


def now_ts():
    """UTC ISO timestamp with ms, fixed width, strictly increasing per process (same format as JS toISOString)."""
    t = to_ts(_dt.datetime.now(_dt.timezone.utc))
    if t <= _last_ts[0]:
        t = to_ts(parse_ts(_last_ts[0]) + _dt.timedelta(milliseconds=1))
    _last_ts[0] = t
    return t


ID_FIRST = "abcdefghjkmnpqrstvwxyz"
ID_REST = "0123456789abcdefghjkmnpqrstvwxyz"


def new_id():
    b = secrets.token_bytes(10)
    return ID_FIRST[b[0] % len(ID_FIRST)] + "".join(ID_REST[x % 32] for x in b[1:])


def rand_suffix(n=6):
    return "".join(ID_REST[x % 32] for x in secrets.token_bytes(n))


def slug(name):
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40]
    return s or "list"


def path_for(kind, iid):
    return "%s/%s.json" % (DIRS[kind], iid)


def log_path(ts, suffix=None):
    c = re.sub(r"[-:.]", "", ts)
    return "log/%s/%s/%s-%s.json" % (ts[:4], ts[5:7], c, suffix or rand_suffix())


# ---------------------------------------------------------------- canonical JSON
# Byte-identical to the web app: JSON.stringify(sortKeys(obj), null, 2) + "\n" (numbers formatted the JavaScript way).
import math as _math
from decimal import Decimal as _Decimal


def js_number(x):
    """Format a number exactly like JavaScript's Number#toString (shortest round-trip digits, JS exponent rules)."""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if _math.isnan(x) or _math.isinf(x):
        return "null"
    if x == 0:
        return "0"
    if x.is_integer() and abs(x) < 2 ** 53:
        return str(int(x))
    sign, digits, exp = _Decimal(repr(x)).as_tuple()
    d = "".join(map(str, digits)).rstrip("0") or "0"
    exp += len(digits) - len(d)
    k = len(d)
    n = k + exp
    if k <= n <= 21:
        out = d + "0" * (n - k)
    elif 0 < n <= 21:
        out = d[:n] + "." + d[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + d
    else:
        e = n - 1
        out = d[0] + ("." + d[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return ("-" if sign else "") + out


def js_json(v, indent=None, _lvl=0):
    """JSON.stringify(sortKeys(v), null, indent) for JSON-compatible Python values."""
    if v is None:
        return "null"
    if isinstance(v, (bool, int, float)):
        return js_number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    nl = "\n" + " " * (indent * (_lvl + 1)) if indent else ""
    end = "\n" + " " * (indent * _lvl) if indent else ""
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        return "[" + ",".join(nl + js_json(x, indent, _lvl + 1) for x in v) + end + "]"
    if isinstance(v, dict):
        if not v:
            return "{}"
        sep = ": " if indent else ":"
        return "{" + ",".join(nl + json.dumps(str(k), ensure_ascii=False) + sep + js_json(v[k], indent, _lvl + 1)
                              for k in sorted(v, key=str)) + end + "}"
    raise TypeError("not JSON serializable: %r" % type(v))


def canonical(obj):
    """Byte-identical to the web app's canonical() (JSON.stringify with sorted keys, indent 2, trailing newline)."""
    return js_json(obj, 2) + "\n"


def git_blob_sha(text):
    b = text.encode("utf-8")
    return hashlib.sha1(b"blob %d\0" % len(b) + b).hexdigest()


# ---------------------------------------------------------------- merge
def _cv(v):
    return js_json(v)


def _cmp(a, b):
    x, y = _cv(a), _cv(b)
    return -1 if x < y else (1 if x > y else 0)


def merge_records(a, b):
    """Field-level last-writer-wins merge; commutative, associative, idempotent (mirrors core.js mergeRecords)."""
    if not a:
        return b
    if not b:
        return a
    fa, fb = a.get("field_ts") or {}, b.get("field_ts") or {}
    out, ft = {}, {}
    ua, ub = a.get("updated_at") or "", b.get("updated_at") or ""
    if ua != ub:
        newer = a if ua > ub else b
    else:
        newer = a if _cmp(a.get("updated_by"), b.get("updated_by")) >= 0 else b
    for src in ((b if newer is a else a), newer):
        for k in src:
            if k not in META and k not in fa and k not in fb:
                out[k] = src[k]
    keys = list(fa) + [k for k in fb if k not in fa]
    for f in keys:
        ta, tb = fa.get(f) or "", fb.get(f) or ""
        if ta != tb:
            pick = a if ta > tb else b
        else:
            pick = a if _cmp(a.get(f), b.get(f)) >= 0 else b
        out[f] = pick.get(f)
        ft[f] = ta if ta > tb else tb
    out["id"] = a.get("id") or b.get("id")
    out["kind"] = a.get("kind") or b.get("kind")
    ca, cb = a.get("created_at") or "", b.get("created_at") or ""
    if not ca:
        older = b
    elif not cb:
        older = a
    elif ca != cb:
        older = a if ca < cb else b
    else:
        older = a if _cmp(a.get("created_by"), b.get("created_by")) <= 0 else b
    out["created_at"] = older.get("created_at") or None
    out["created_by"] = older.get("created_by") or None
    out["updated_at"] = newer.get("updated_at") or None
    out["updated_by"] = newer.get("updated_by") or None
    la, lb = a.get("legacy_id"), b.get("legacy_id")
    if la is not None or lb is not None:
        out["legacy_id"] = lb if la is None else (la if lb is None else min(la, lb))
    out["field_ts"] = ft
    return out


# ---------------------------------------------------------------- dates
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def today_iso():
    return _dt.date.today().isoformat()


def parse_due(s, today=None):
    if s is None:
        return None
    s = str(s).strip()
    low = s.lower()
    if low in ("", "none", "null", "-", "clear"):
        return None
    try:
        m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][0-9:.+\-Z]*)?", s) or re.fullmatch(r"(\d{4})/(\d{1,2})/(\d{1,2})", s)
        if m:
            return _dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat()
        m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", s)
        if m:
            return _dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
    except ValueError:
        raise BBError("invalid date: %s" % s)
    today = today or _dt.date.today()
    if low in ("today", "tod"):
        return today.isoformat()
    if low in ("tomorrow", "tmr", "tmrw", "tom"):
        return (today + _dt.timedelta(days=1)).isoformat()
    if low == "yesterday":
        return (today - _dt.timedelta(days=1)).isoformat()
    m = re.fullmatch(r"\+?(\d{1,4})\s*(d|day|days|w|wk|week|weeks)", low)
    if m:
        return (today + _dt.timedelta(days=int(m[1]) * (7 if m[2].startswith("w") else 1))).isoformat()
    w = low[5:] if low.startswith("next ") else low
    for i, name in enumerate(WEEKDAYS):
        if len(w) >= 3 and name.startswith(w):
            return (today + _dt.timedelta(days=(i - today.weekday()) % 7 or 7)).isoformat()
    raise BBError("unrecognized due date '%s' (use YYYY-MM-DD, today, tomorrow, mon..sun, +3d, +1w, none)" % s)


def due_label(due, status=None):
    if not due:
        return ""
    try:
        d = _dt.date.fromisoformat(due)
    except ValueError:
        return due
    t = _dt.date.today()
    if d == t:
        lab = "today"
    elif d == t + _dt.timedelta(days=1):
        lab = "tomorrow"
    else:
        lab = "%s %d %s" % (d.strftime("%a"), d.day, d.strftime("%b")) + (" %d" % d.year if d.year != t.year else "")
    if d < t and status != "done":
        lab = "OVERDUE " + lab
    return lab


# ---------------------------------------------------------------- validation & records
def clean(kind, data, partial):
    allowed = [f for f in FIELDS[kind] if f not in ("deleted", "completed_at")]
    out = {}
    for k in allowed:
        if k not in data:
            continue
        v = data[k]
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        if k == "priority" and v is not None:
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise BBError("priority must be an integer")
        if k == "sort_order" and v is not None:
            v = float(v)
        if isinstance(v, str):
            for pat in SECRET_PATTERNS:
                if pat.search(v):
                    raise BBError("field '%s' looks like it contains a secret. Never store secrets here; write WHERE the "
                                  "secret lives instead (e.g. 'in 1Password: vm1 root')." % k)
        out[k] = v
    label = LABEL[kind]
    if not partial and not out.get(label):
        raise BBError("%s is required" % label)
    if partial and label in out and not out[label]:
        raise BBError("%s cannot be empty" % label)
    if kind == "task":
        if "status" in out:
            out["status"] = str(out["status"] or "todo").lower()
            if out["status"] not in TASK_STATUSES:
                raise BBError("status must be one of: todo, doing, done")
        if "priority" in out:
            if out["priority"] is None:
                out["priority"] = 3
            if not 1 <= out["priority"] <= 5:
                raise BBError("priority must be 1 (highest) .. 5 (lowest)")
        if "due" in out:
            out["due"] = parse_due(out["due"])
        if "sort_order" in out and out["sort_order"] is None:
            del out["sort_order"]
    return out


DEFAULTS = {
    "task": {"list_id": "inbox", "project_id": None, "priority": 3, "status": "todo", "due": None, "notes": None,
             "sort_order": 10, "completed_at": None},
    "project": {"description": None, "owner": None, "status": None, "notes": None, "parent_id": None},
    "resource": {"type": None, "project_id": None, "host": None, "provider": None, "os": None, "ports": None,
                 "status": None, "notes": None},
    "list": {"sort_order": 10},
}


def new_record(kind, fields, by, ts, iid=None):
    r = {"id": iid or new_id(), "kind": kind, "created_at": ts, "created_by": by, "updated_at": ts, "updated_by": by,
         "field_ts": {}}
    for f in FIELDS[kind]:
        r[f] = fields[f] if f in fields else (False if f == "deleted" else DEFAULTS[kind].get(f))
        r["field_ts"][f] = ts
    if kind == "task" and r["status"] == "done" and not r.get("completed_at"):
        r["completed_at"] = ts
    return r


def patch_record(rec, patch, by, ts):
    out = json.loads(json.dumps(rec))
    out.setdefault("field_ts", {})
    changes = {}
    for k, v in patch.items():
        if _cmp(out.get(k), v) == 0:
            continue
        changes[k] = [out.get(k), v]
        out[k] = v
        out["field_ts"][k] = ts
    if rec.get("kind") == "task" and "status" in changes:
        out["completed_at"] = ts if out["status"] == "done" else None
        out["field_ts"]["completed_at"] = ts
    if changes:
        out["updated_at"] = ts
        out["updated_by"] = by
    return out, changes


def handles(recs):
    """Short handles: the v2.1 number for migrated items, else the shortest unique id prefix (min 4 chars)."""
    ids = [r["id"] for r in recs]
    out = {}
    for r in recs:
        if r.get("legacy_id") is not None:
            out[r["id"]] = str(r["legacy_id"])
            continue
        n = 4
        while n < len(r["id"]) and any(o != r["id"] and o.startswith(r["id"][:n]) for o in ids):
            n += 1
        out[r["id"]] = r["id"][:n]
    return out


def resolve_ref(recs, ref, kind):
    ref = str(ref).strip().lstrip("#")
    live_ = [r for r in recs if not r.get("deleted")]
    if ref.isdigit():
        m = [r for r in recs if r.get("legacy_id") == int(ref)]
        if m:
            return next((r for r in m if not r.get("deleted")), m[0])
    m = [r for r in recs if r["id"] == ref]
    if m:
        return m[0]
    m = [r for r in live_ if r["id"].startswith(ref.lower())]
    if len(m) == 1:
        return m[0]
    if len(m) > 1:
        raise BBError("%s '%s' is ambiguous: %s" % (kind, ref, ", ".join(r["id"] for r in m)))
    if kind != "task":
        lab = LABEL[kind]
        m = [r for r in live_ if (r.get(lab) or "").lower() == ref.lower()]
        if m:
            return m[0]
        m = [r for r in live_ if ref.lower() in (r.get(lab) or "").lower()]
        if len(m) == 1:
            return m[0]
        if len(m) > 1:
            raise BBError("%s '%s' is ambiguous: %s" % (kind, ref, ", ".join(r[lab] for r in m)))
    raise BBError("%s '%s' not found" % (kind, ref), 404)


# ---------------------------------------------------------------- views
def live(db, kind):
    return [r for r in db.all(kind) if not r.get("deleted")]


def lists_sorted(db):
    return sorted(live(db, "list"), key=lambda l: (l.get("sort_order") or 0, l["name"].lower(), l["id"]))


def name_of(db, kind, iid):
    if not iid:
        return None
    r = db.get(kind, iid)
    return r[LABEL[kind]] if r and not r.get("deleted") else None


def tasks_sorted(db):
    lo = {l["id"]: i for i, l in enumerate(lists_sorted(db))}
    return sorted(live(db, "task"), key=lambda t: (lo.get(t.get("list_id"), 1e9), t.get("sort_order") or 0,
                                                   t.get("created_at") or "", t["id"]))


def next_key(t):
    def k(x):
        due = x.get("due")
        return (0 if x.get("status") == "doing" else 1, 0 if (due and due < t) else 1, 0 if (due and due == t) else 1,
                x.get("priority") or 3, 0 if due else 1, due or "", x.get("sort_order") or 0, x.get("created_at") or "", x["id"])
    return k


def next_up(db, list_id=None, n=1, today=None):
    t = today or today_iso()
    ts = [x for x in live(db, "task") if x.get("status") != "done" and (not list_id or x.get("list_id") == list_id)]
    return sorted(ts, key=next_key(t))[:n]


def today_view(db, today=None):
    t = today or today_iso()
    out = []
    for x in sorted([x for x in live(db, "task") if x.get("status") != "done" and
                     (x.get("status") == "doing" or (x.get("due") and x["due"] <= t))], key=next_key(t)):
        d = dict(x)
        d["bucket"] = "overdue" if (x.get("due") and x["due"] < t) else ("today" if x.get("due") == t else "doing")
        out.append(d)
    return out


# ---------------------------------------------------------------- ops (mirror core.js Ops)
class Ops:
    def __init__(self, db, by, via="cli", ts=None):
        self.db, self.via = db, via
        self.by = (by or "user").strip().lower() or "user"
        self.ts = ts or now_ts()

    def _h(self, rec):
        return "#%s" % rec["legacy_id"] if rec.get("legacy_id") is not None else rec["id"][:4]

    def _log(self, action, entity, rec, summary, details=None):
        e = {"ts": self.ts, "by": self.by, "action": action, "entity": entity, "entity_id": rec["id"] if rec else None,
             "summary": summary, "via": self.via}
        if rec and rec.get("legacy_id") is not None:
            e["legacy_id"] = rec["legacy_id"]
        if details is not None:
            e["details"] = details
        self.db.log(e)

    def list_by_name(self, name):
        n = str(name).strip().lower()
        return next((l for l in live(self.db, "list") if l["name"].lower() == n), None)

    def ensure_list(self, name):
        name = (name or "").strip() or "Inbox"
        ex = self.list_by_name(name)
        if ex:
            return ex
        iid = slug(name)
        taken = self.db.get("list", iid)
        if taken and not (taken.get("deleted") and taken["name"].lower() == name.lower()):
            iid = iid + "-" + rand_suffix(4)
        mx = max([0] + [l.get("sort_order") or 0 for l in live(self.db, "list")])
        if taken and iid == slug(name):
            rec, _ = patch_record(taken, {"deleted": False, "name": name}, self.by, self.ts)
        else:
            rec = new_record("list", {"name": name, "sort_order": mx + 10}, self.by, self.ts, iid)
        self.db.put(rec)
        self._log("create", "list", rec, "created list '%s'" % name)
        return rec

    def _max_sort(self, list_id, except_id=None):
        return max([0] + [t.get("sort_order") or 0 for t in live(self.db, "task")
                          if t.get("list_id") == list_id and t["id"] != except_id])

    def _check_refs(self, d, self_id=None, kind=None):
        for k in ("project_id", "parent_id"):
            if d.get(k) is not None:
                p = self.db.get("project", d[k])
                if not p or p.get("deleted"):
                    raise BBError("%s %s does not exist" % (k, d[k]))
        if kind == "project" and self_id and d.get("parent_id"):
            cur, seen = d["parent_id"], set()
            while cur and cur not in seen:
                if cur == self_id:
                    raise BBError("parent_id would create a cycle")
                seen.add(cur)
                r = self.db.get("project", cur)
                cur = r.get("parent_id") if r else None

    def _unique(self, kind, name, self_id=None):
        if name and any(r["id"] != self_id and r["name"].lower() == name.lower() for r in live(self.db, kind)):
            raise BBError("%s '%s' already exists" % (kind, name), 409)

    def create(self, kind, data):
        data = dict(data)
        list_name = data.pop("list", None) if kind == "task" else None
        d = clean(kind, data, False)
        self._check_refs(d, None, kind)
        if kind != "task":
            self._unique(kind, d.get("name"))
        if kind == "task":
            if not d.get("list_id"):
                d["list_id"] = self.ensure_list(list_name or "Inbox")["id"]
            if d.get("sort_order") is None:
                d["sort_order"] = self._max_sort(d["list_id"]) + 10
        rec = new_record(kind, d, self.by, self.ts)
        self.db.put(rec)
        det = {k: v for k, v in d.items() if v is not None}
        self._log("create", kind, rec, "created %s %s '%s'" % (kind, self._h(rec), rec[LABEL[kind]]), det)
        return rec

    def update(self, kind, iid, data, action=None):
        data = dict(data)
        old = self.db.get(kind, iid)
        if not old or old.get("deleted"):
            raise BBError("%s %s not found" % (kind, iid), 404)
        list_name = data.pop("list", None) if kind == "task" else None
        d = clean(kind, data, True)
        self._check_refs(d, iid, kind)
        if kind != "task" and d.get("name"):
            self._unique(kind, d["name"], iid)
        if list_name is not None:
            d["list_id"] = self.ensure_list(list_name)["id"]
        if kind == "task" and d.get("list_id") and d["list_id"] != old.get("list_id") and d.get("sort_order") is None:
            d["sort_order"] = self._max_sort(d["list_id"], iid) + 10
        rec, changes = patch_record(old, d, self.by, self.ts)
        if not changes:
            return old
        self.db.put(rec)
        keys = [k for k in changes if k != "sort_order" or len(changes) == 1]
        if not action:
            action = {"done": "done", "doing": "start", "todo": "reopen"}[rec["status"]] \
                if (kind == "task" and keys == ["status"]) else "update"
        if kind == "task" and keys == ["sort_order"] and action == "update":
            self._log("reorder", "task", rec, "moved task %s '%s'" % (self._h(rec), rec["title"]))
        else:
            verb = "updated" if action == "update" else action
            self._log(action, kind, rec, "%s %s %s '%s'%s" % (verb, kind, self._h(rec), old[LABEL[kind]],
                                                               (": " + ", ".join(keys)) if action == "update" else ""), changes)
        return rec

    def set_status(self, iid, st):
        return self.update("task", iid, {"status": st})

    def remove(self, kind, iid):
        old = self.db.get(kind, iid)
        if not old or old.get("deleted"):
            raise BBError("%s %s not found" % (kind, iid), 404)
        if kind == "list":
            n = len([t for t in live(self.db, "task") if t.get("list_id") == iid])
            if n:
                raise BBError("list '%s' still has %d task(s); move or delete them first (or rename the list)" % (old["name"], n), 409)
        rec, _ = patch_record(old, {"deleted": True}, self.by, self.ts)
        self.db.put(rec)
        self._log("delete", kind, rec, "deleted %s %s'%s'" % (kind, "" if kind == "list" else self._h(rec) + " ", old[LABEL[kind]]))
        return rec

    def rename_list(self, iid, new_name):
        new_name = (new_name or "").strip()
        if not new_name:
            raise BBError("new list name is required")
        old = self.db.get("list", iid)
        if not old or old.get("deleted"):
            raise BBError("list not found", 404)
        target = next((l for l in live(self.db, "list") if l["id"] != iid and l["name"].lower() == new_name.lower()), None)
        tasks = sorted([t for t in live(self.db, "task") if t.get("list_id") == iid], key=lambda t: t.get("sort_order") or 0)
        if target:
            base = self._max_sort(target["id"])
            for t in tasks:
                base += 10
                self.db.put(patch_record(t, {"list_id": target["id"], "sort_order": base}, self.by, self.ts)[0])
            self.db.put(patch_record(old, {"deleted": True}, self.by, self.ts)[0])
        else:
            self.db.put(patch_record(old, {"name": new_name}, self.by, self.ts)[0])
        self._log("rename", "list", old, "renamed list '%s' -> '%s' (%d tasks)" % (
            old["name"], target["name"] if target else new_name, len(tasks)))
        return target or self.db.get("list", iid)

    def place(self, iid, list_id, before_id):
        t = self.db.get("task", iid)
        sibs = sorted([x for x in live(self.db, "task") if x.get("list_id") == list_id and x["id"] != iid],
                      key=lambda x: (x.get("sort_order") or 0, x["id"]))
        idx = next((k for k, x in enumerate(sibs) if x["id"] == before_id), len(sibs)) if before_id else len(sibs)
        lo = sibs[idx - 1]["sort_order"] if idx > 0 else None
        hi = sibs[idx]["sort_order"] if idx < len(sibs) else None
        if lo is None and hi is None:
            so = 10
        elif lo is None:
            so = hi - 10
        elif hi is None:
            so = lo + 10
        else:
            so = (lo + hi) / 2
        if lo is not None and hi is not None and not (hi - lo > 1e-6):
            sibs.insert(idx, t)
            for k, x in enumerate(sibs):
                if x["id"] != iid:
                    self.db.put(patch_record(x, {"sort_order": (k + 1) * 10}, self.by, self.ts)[0])
            so = (idx + 1) * 10
        patch = {"sort_order": so}
        if list_id != t.get("list_id"):
            patch["list_id"] = list_id
        return self.update("task", iid, patch)

    def move(self, iid, direction):
        t = self.db.get("task", iid)
        sibs = sorted([x for x in live(self.db, "task") if x.get("list_id") == t.get("list_id")],
                      key=lambda x: (x.get("sort_order") or 0, x["id"]))
        i = next(k for k, x in enumerate(sibs) if x["id"] == iid)
        if direction == "up":
            if i == 0:
                return t
            before = sibs[i - 1]["id"]
        elif direction == "down":
            if i == len(sibs) - 1:
                return t
            before = sibs[i + 2]["id"] if i + 2 < len(sibs) else None
        elif direction == "top":
            if i == 0:
                return t
            before = sibs[0]["id"]
        elif direction == "bottom":
            if i == len(sibs) - 1:
                return t
            before = None
        else:
            raise BBError("direction must be up|down|top|bottom")
        return self.place(iid, t["list_id"], before)


# ---------------------------------------------------------------- snapshot (in-memory view of the repo)
def kind_of_path(path):
    m = re.match(r"^(tasks|projects|resources|lists)/([A-Za-z0-9_-]+)\.json$", path)
    if not m:
        return None, None
    return {v: k for k, v in DIRS.items()}[m.group(1)], m.group(2)


class Snapshot:
    """items: path -> record (loaded); log_paths: sorted list; staged: path -> data written by ops."""

    def __init__(self, items, log_paths, log_reader, schema):
        self.items = items
        self.log_paths = sorted(log_paths)
        self._read_log = log_reader
        self.schema = schema or {}
        self.staged = {}

    # db adapter for Ops / views
    def get(self, kind, iid):
        p = path_for(kind, iid)
        if p in self.staged:
            return self.staged[p]
        return self.items.get(p)

    def all(self, kind):
        pre = DIRS[kind] + "/"
        out = {p: r for p, r in self.items.items() if p.startswith(pre)}
        out.update({p: r for p, r in self.staged.items() if p.startswith(pre)})
        return list(out.values())

    def put(self, rec):
        self.staged[path_for(rec["kind"], rec["id"])] = rec

    def log(self, e):
        self.staged[log_path(e["ts"])] = e

    def changes(self):
        """path -> canonical text for every staged file, field-merged over what was loaded (never regresses a newer field)."""
        out = {}
        for p, d in self.staged.items():
            if ITEM_RE.match(p):
                d = merge_records(self.items.get(p), d)
            out[p] = canonical(d)
        return out

    def log_entries(self, n):
        paths = self.log_paths[-n:] if n else self.log_paths
        out = []
        for p in reversed(paths):
            d = self._read_log(p)
            if d:
                out.append(d)
        return out

    def check_writable(self):
        v = self.schema.get("schema_version", SCHEMA_VERSION)
        if isinstance(v, int) and v > SCHEMA_VERSION:
            raise BBError("data repo uses schema_version %s but this bb.py only knows %s; update bb.py before writing" % (v, SCHEMA_VERSION))


def _loads(text, path):
    try:
        return json.loads(text)
    except ValueError:
        warn("skipping unreadable JSON file %s" % path)
        return None


def warn(msg):
    sys.stderr.write("bb: %s\n" % msg)


# ---------------------------------------------------------------- git backend (local clone)
DATA_PATHS = ["tasks", "projects", "resources", "lists", "log", "bossboard.json"]


class GitBackend:
    name = "git"

    def __init__(self, root, push=True):
        self.root = Path(root).resolve()
        self.push_enabled = push
        if not (self.root / ".git").exists():
            raise BBError("%s is not a git clone of the data repo" % self.root)
        self.offline = False

    def git(self, *args, check=True, inp=None):
        p = subprocess.run(["git", "-C", str(self.root)] + list(args), input=inp, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, universal_newlines=True)
        if check and p.returncode != 0:
            raise BBError("git %s failed: %s" % (" ".join(args[:2]), (p.stderr or p.stdout).strip()))
        return p

    def _branch(self):
        b = self.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        if b == "HEAD":
            raise BBError("data clone is on a detached HEAD; check out a branch")
        return b

    def _remote_ref(self):
        if not self.push_enabled:
            return None
        if "origin" not in self.git("remote").stdout.split():
            return None
        return "refs/remotes/origin/" + self._branch()

    def _ensure_clean(self):
        st = self.git("status", "--porcelain", "--", *DATA_PATHS).stdout.strip()
        if st:
            raise BBError("data files in %s have uncommitted changes; commit or discard them first:\n%s" % (self.root, st))

    def _fetch(self):
        if not self._remote_ref():
            return False
        p = self.git("fetch", "--quiet", "origin", self._branch(), check=False)
        if p.returncode != 0:
            self.offline = True
            warn("offline or remote unreachable (%s); using the local clone" % (p.stderr.strip().splitlines() or ["?"])[-1])
            return False
        self.offline = False
        return True

    def _has(self, ref):
        return self.git("rev-parse", "--verify", "--quiet", ref, check=False).returncode == 0

    def _reconcile(self):
        """Bring the local branch up to date with origin, merging unpushed local commits field-by-field."""
        rr = self._remote_ref()
        if not rr or not self._has(rr):
            return
        head = self.git("rev-parse", "HEAD").stdout.strip()
        remote = self.git("rev-parse", rr).stdout.strip()
        if head == remote:
            return
        if self.git("merge-base", "--is-ancestor", "HEAD", rr, check=False).returncode == 0:
            self.git("merge", "--ff-only", "--quiet", rr)
            return
        if self.git("merge-base", "--is-ancestor", rr, "HEAD", check=False).returncode == 0:
            return  # only ahead: push will publish
        base = self.git("merge-base", "HEAD", rr).stdout.strip()
        changed = [l for l in self.git("diff", "--name-only", "--no-renames", base, "HEAD", "--").stdout.splitlines() if l]
        outbox = {}
        for p in changed:
            if ITEM_RE.match(p) or LOG_RE.match(p):
                f = self.root / p
                if f.exists():
                    d = _loads(f.read_text(encoding="utf-8"), p)
                    if d is not None:
                        outbox[p] = d
        self.git("reset", "--hard", "--quiet", rr)
        for p, d in outbox.items():
            f = self.root / p
            if ITEM_RE.match(p) and f.exists():
                cur = _loads(f.read_text(encoding="utf-8"), p)
                d = merge_records(cur, d)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(canonical(d), encoding="utf-8")
        self.git("add", "-A", "--", *[p for p in DATA_PATHS if (self.root / p).exists()])
        if self.git("diff", "--cached", "--quiet", check=False).returncode != 0:
            ident = [] if self._has_identity() else ["-c", "user.name=bossboard-cli", "-c", "user.email=bossboard-cli@localhost"]
            self.git(*(ident + ["commit", "--quiet", "-m", "bb: merge %d offline change(s)" % len(outbox)]))

    def _push(self):
        rr = self._remote_ref()
        if not rr or self.offline:
            return "local"
        if self._has(rr) and self.git("rev-parse", "HEAD").stdout.strip() == self.git("rev-parse", rr).stdout.strip():
            return "pushed"
        p = self.git("push", "--quiet", "origin", "HEAD:" + self._branch(), check=False)
        if p.returncode == 0:
            self.git("fetch", "--quiet", "origin", self._branch(), check=False)
            return "pushed"
        err = (p.stderr or "").lower()
        if "rejected" in err or "non-fast-forward" in err or "fetch first" in err:
            raise Conflict()
        self.offline = True
        warn("push failed (%s); committed locally, run `bb.py sync` later" % (p.stderr.strip().splitlines() or ["?"])[-1])
        return "local"

    def load(self):
        items = {}
        for d in DIRS.values():
            for f in sorted((self.root / d).glob("*.json")) if (self.root / d).is_dir() else []:
                p = "%s/%s" % (d, f.name)
                if ITEM_RE.match(p):
                    r = _loads(f.read_text(encoding="utf-8"), p)
                    if isinstance(r, dict):
                        items[p] = r
        logs = []
        ld = self.root / "log"
        if ld.is_dir():
            for f in ld.glob("*/*/*.json"):
                p = f.relative_to(self.root).as_posix()
                if LOG_RE.match(p):
                    logs.append(p)
        schema = {}
        sf = self.root / "bossboard.json"
        if sf.exists():
            schema = _loads(sf.read_text(encoding="utf-8"), "bossboard.json") or {}

        def rd(p):
            return _loads((self.root / p).read_text(encoding="utf-8"), p)
        return Snapshot(items, logs, rd, schema)

    def begin(self, write):
        if write:
            self._ensure_clean()
        if self._fetch():
            self._reconcile()

    def read(self):
        self.begin(False)
        if not self.offline and self._remote_ref():
            try:
                self._push()  # publish earlier offline commits
            except Conflict:
                pass
        return self.load()

    def commit(self, snap, message):
        files = snap.changes()
        for p, text in files.items():
            f = self.root / p
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(text, encoding="utf-8")
        self.git("add", "--", *files.keys())
        ident = [] if self._has_identity() else ["-c", "user.name=bossboard-cli", "-c", "user.email=bossboard-cli@localhost"]
        self.git(*(ident + ["commit", "--quiet", "-m", message]))
        return self._push()

    def _has_identity(self):
        return bool(self.git("config", "user.email", check=False).stdout.strip())

    def retry_prepare(self):
        self._fetch()
        self._reconcile()

    def sync(self):
        self._ensure_clean()
        if self._fetch():
            self._reconcile()
        for _ in range(5):
            try:
                return self._push()
            except Conflict:
                self._fetch()
                self._reconcile()
        raise BBError("could not push after several attempts")


# ---------------------------------------------------------------- REST backend (GitHub Git Data API)
def safe_api_base(v):
    """Token only ever goes to api.github.com; localhost is allowed for test fakes."""
    if not v:
        return DEFAULT_API
    v = v.rstrip("/")
    if v == DEFAULT_API or re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", v):
        return v
    raise BBError("BOSSBOARD_API must be https://api.github.com (or http://localhost:PORT for tests)")


class GHError(BBError):
    def __init__(self, kind, msg, status=0, retry_after=None):
        super().__init__(msg, status)
        self.kind = kind
        self.retry_after = retry_after


class RestBackend:
    name = "rest"

    def __init__(self, repo, token, branch="main", api=None, cache_dir=None):
        if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", repo or ""):
            raise BBError("BOSSBOARD_REPO must look like owner/name")
        if not token:
            raise BBError("set BOSSBOARD_TOKEN or GITHUB_TOKEN for the REST backend")
        self.repo, self._token, self.branch = repo, token, branch
        self.api = safe_api_base(api)
        base = Path(cache_dir or os.environ.get("BOSSBOARD_CACHE") or (Path.home() / ".cache" / "bossboard"))
        self.cache = base / repo.replace("/", "__") / "blobs"
        self.head = None

    def __repr__(self):
        return "RestBackend(%s)" % self.repo  # never expose the token

    def req(self, method, path, body=None, _tries=0):
        url = "%s/repos/%s%s" % (self.api, self.repo, path)
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + self._token, "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "bossboard-cli/" + VERSION,
            "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            st = e.code
            try:
                msg = json.loads(e.read() or b"{}").get("message", "")
            except ValueError:
                msg = ""
            h = e.headers
            ra = h.get("retry-after")
            if st == 429 or (st == 403 and (h.get("x-ratelimit-remaining") == "0" or ra)):
                wait = int(ra) if ra and ra.isdigit() else max(1, int(h.get("x-ratelimit-reset") or time.time() + 60) - int(time.time()))
                if wait <= 60 and _tries < 2:
                    warn("rate limited by GitHub; waiting %ds" % wait)
                    time.sleep(wait)
                    return self.req(method, path, body, _tries + 1)
                raise GHError("ratelimit", "GitHub rate limit hit; try again in %ds" % wait, st, wait)
            if st in (401, 403):
                raise GHError("auth", "GitHub rejected the token (%d %s). Check BOSSBOARD_TOKEN: it needs Contents read/write on %s"
                              % (st, msg, self.repo), st)
            if st == 404:
                raise GHError("notfound", "%s not found (or the token cannot see it): %s" % (self.repo, path), st)
            if st == 409:
                raise GHError("empty", "repository %s is empty; push data-template first (see README)" % self.repo, st)
            if st == 422:
                raise GHError("conflict", msg or "conflict", st)
            if st >= 500 and _tries < 2:
                time.sleep(1 + _tries)
                return self.req(method, path, body, _tries + 1)
            raise GHError("server", "GitHub error %d: %s" % (st, msg), st)
        except (urllib.error.URLError, OSError) as e:
            raise GHError("network", "cannot reach GitHub (%s)" % getattr(e, "reason", e))

    def blob(self, sha):
        f = self.cache / (sha + ".json")
        if f.exists():
            return f.read_text(encoding="utf-8")
        d = self.req("GET", "/git/blobs/" + sha)
        text = base64.b64decode(d["content"]).decode("utf-8") if d.get("encoding") == "base64" else d["content"]
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(text, encoding="utf-8")
        except OSError:
            pass
        return text

    def load(self):
        ref = self.req("GET", "/git/ref/heads/" + self.branch)
        self.head = ref["object"]["sha"]
        commit = self.req("GET", "/git/commits/" + self.head)
        tree = self.req("GET", "/git/trees/%s?recursive=1" % commit["tree"]["sha"])
        if tree.get("truncated"):
            raise BBError("repository tree is too large for one API call (truncated); use the git backend")
        self.base_tree = commit["tree"]["sha"]
        items, logs, shas, schema = {}, [], {}, {}
        for e in tree.get("tree", []):
            if e.get("type") != "blob":
                continue
            p = e["path"]
            shas[p] = e["sha"]
            if ITEM_RE.match(p):
                r = _loads(self.blob(e["sha"]), p)
                if isinstance(r, dict):
                    items[p] = r
            elif LOG_RE.match(p):
                logs.append(p)
            elif p == "bossboard.json":
                schema = _loads(self.blob(e["sha"]), p) or {}

        def rd(p):
            return _loads(self.blob(shas[p]), p) if p in shas else None
        return Snapshot(items, logs, rd, schema)

    def begin(self, write):
        pass

    def read(self):
        return self.load()

    def commit(self, snap, message):
        files = snap.changes()
        tree = self.req("POST", "/git/trees", {"base_tree": self.base_tree, "tree": [
            {"path": p, "mode": "100644", "type": "blob", "content": t} for p, t in sorted(files.items())]})
        c = self.req("POST", "/git/commits", {"message": message, "tree": tree["sha"], "parents": [self.head]})
        try:
            self.req("PATCH", "/git/refs/heads/" + self.branch, {"sha": c["sha"], "force": False})
        except GHError as e:
            if e.kind == "conflict":
                raise Conflict()
            raise
        for p, t in files.items():
            try:
                f = self.cache / (git_blob_sha(t) + ".json")
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(t, encoding="utf-8")
            except OSError:
                pass
        self.head = c["sha"]
        return "pushed"

    def sync(self):
        self.load()
        return "pushed"


# ---------------------------------------------------------------- backend selection
def pick_backend(args):
    d = getattr(args, "dir", None) or os.environ.get("BOSSBOARD_DIR")
    if d:
        return GitBackend(d, push=not getattr(args, "no_push", False))
    repo = os.environ.get("BOSSBOARD_REPO")
    token = os.environ.get("BOSSBOARD_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if repo and token:
        return RestBackend(repo, token, os.environ.get("BOSSBOARD_BRANCH", "main"), os.environ.get("BOSSBOARD_API"))
    for cand in (Path(__file__).resolve().parent, Path.cwd()):
        for c in [cand] + list(cand.parents)[:2]:
            if (c / "bossboard.json").exists() and (c / ".git").exists():
                return GitBackend(c, push=not getattr(args, "no_push", False))
    raise BBError("no data repo found. Use --dir PATH (a git clone of the data repo), or set BOSSBOARD_REPO=owner/name "
                  "and BOSSBOARD_TOKEN for the GitHub REST backend.")


def run_write(be, by, fn, describe):
    """Load, apply ops, commit; on a remote conflict reload and re-apply (REST) or merge-and-push (git)."""
    for attempt in range(6):
        be.begin(True)
        snap = be.load()
        snap.check_writable()
        ops = Ops(snap, by, "cli")
        res = fn(ops, snap)
        if not snap.staged:
            return res, snap, "unchanged"
        msg = "bb: %s (by %s)" % (describe(res, snap), ops.by)
        try:
            return res, snap, be.commit(snap, msg)
        except Conflict:
            if isinstance(be, GitBackend):
                return res, snap, be.sync()
            time.sleep(min(4, 0.3 * (2 ** attempt)) * (0.5 + random.random()))
    raise BBError("gave up after repeated conflicts; try again")


# ---------------------------------------------------------------- presentation
MARK = {"todo": "[ ]", "doing": "[>]", "done": "[x]"}


class View:
    def __init__(self, snap):
        self.s = snap
        self.h = {k: handles(snap.all(k)) for k in ("task", "project", "resource")}

    def task(self, t):
        d = {k: v for k, v in t.items() if k != "field_ts"}
        d["handle"] = self.h["task"].get(t["id"], t["id"][:4])
        d["list"] = name_of(self.s, "list", t.get("list_id"))
        d["project_name"] = name_of(self.s, "project", t.get("project_id"))
        return d

    def project(self, p):
        d = {k: v for k, v in p.items() if k != "field_ts"}
        d["handle"] = self.h["project"].get(p["id"], p["id"][:4])
        d["parent_name"] = name_of(self.s, "project", p.get("parent_id"))
        ts = [t for t in live(self.s, "task") if t.get("project_id") == p["id"]]
        d["open_tasks"] = len([t for t in ts if t.get("status") != "done"])
        d["done_tasks"] = len(ts) - d["open_tasks"]
        return d

    def resource(self, r):
        d = {k: v for k, v in r.items() if k != "field_ts"}
        d["handle"] = self.h["resource"].get(r["id"], r["id"][:4])
        d["project_name"] = name_of(self.s, "project", r.get("project_id"))
        return d


def fmt_task(t):
    s = "%5s %s P%d %s" % (t["handle"], MARK.get(t.get("status"), "[?]"), t.get("priority") or 3, t["title"])
    extra = []
    if t.get("project_name"):
        extra.append("@" + t["project_name"])
    if t.get("due"):
        extra.append("due %s [%s]" % (due_label(t["due"], t.get("status")), t["due"]))
    if extra:
        s += "  (" + ", ".join(extra) + ")"
    if t.get("notes"):
        s += "\n           - " + t["notes"].replace("\n", "\n             ")
    return s


def fmt_project(p):
    s = "%5s %s  [%s] owner=%s  open=%d done=%d" % (p["handle"], p["name"], p.get("status") or "-", p.get("owner") or "-",
                                                    p["open_tasks"], p["done_tasks"])
    if p.get("parent_name"):
        s += " parent=" + p["parent_name"]
    for k in ("description", "notes"):
        if p.get(k):
            s += "\n        %s: %s" % (k, p[k])
    return s


def fmt_resource(r):
    s = "%5s %s  type=%s status=%s" % (r["handle"], r["name"], r.get("type") or "-", r.get("status") or "-")
    for k in ("project_name", "host", "provider", "os", "ports", "notes"):
        if r.get(k):
            s += "\n        %s: %s" % (k.replace("_name", ""), r[k])
    return s


def fmt_act(a):
    ts = a.get("ts", "")
    try:
        ts = parse_ts(ts).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        pass
    return "%s  %-7s %-7s %s" % (ts, a.get("by") or a.get("who") or "?", a.get("action"), a.get("summary") or "")


def out_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------- command implementations
def _ref(snap, kind, ref):
    return resolve_ref(snap.all(kind), ref, kind)


def _opt_ref(snap, kind, ref):
    if ref is None:
        return None, False
    if str(ref).strip().lower() in ("none", "null", "-", ""):
        return None, True
    return _ref(snap, kind, ref)["id"], True


def _task_data(a, snap, create):
    d = {}
    if create or a.title is not None:
        d["title"] = a.title
    for k in ("priority", "status", "due", "notes"):
        v = getattr(a, k, None)
        if v is not None:
            d[k] = v
    if a.list is not None:
        d["list"] = a.list
    pid, given = _opt_ref(snap, "project", a.project)
    if given:
        d["project_id"] = pid
    return d


def _named_data(a, snap, kind, create):
    keys = {"project": ["description", "owner", "status", "notes"],
            "resource": ["type", "host", "provider", "os", "ports", "status", "notes"]}[kind]
    d = {}
    if create or a.name is not None:
        d["name"] = a.name
    for k in keys:
        v = getattr(a, k, None)
        if v is not None:
            d[k] = v
    if kind == "project":
        pid, given = _opt_ref(snap, "project", a.parent)
        if given:
            d["parent_id"] = pid
    else:
        pid, given = _opt_ref(snap, "project", a.project)
        if given:
            d["project_id"] = pid
    return d


def cmd_write(a, be):
    by = a.by
    js = a.json
    c = a.cmd

    def fn(ops, snap):
        if c == "add-task":
            return [ops.create("task", _task_data(a, snap, True))]
        if c == "update-task":
            t = _ref(snap, "task", a.id)
            return [ops.update("task", t["id"], _task_data(a, snap, False))]
        if c in ("done", "start", "reopen"):
            st = {"done": "done", "start": "doing", "reopen": "todo"}[c]
            return [ops.set_status(_ref(snap, "task", i)["id"], st) for i in a.ids]
        if c == "delete-task":
            return [ops.remove("task", _ref(snap, "task", i)["id"]) for i in a.ids]
        if c == "move-task":
            return [ops.move(_ref(snap, "task", a.id)["id"], a.direction)]
        if c == "add-list":
            return [ops.ensure_list(a.name)]
        if c == "rename-list":
            l = ops.list_by_name(a.old) or _ref(snap, "list", a.old)
            return [ops.rename_list(l["id"], a.new)]
        if c == "delete-list":
            l = ops.list_by_name(a.name) or _ref(snap, "list", a.name)
            return [ops.remove("list", l["id"])]
        if c == "add-project":
            return [ops.create("project", _named_data(a, snap, "project", True))]
        if c == "update-project":
            p = _ref(snap, "project", a.id)
            return [ops.update("project", p["id"], _named_data(a, snap, "project", False))]
        if c == "delete-project":
            return [ops.remove("project", _ref(snap, "project", a.id)["id"])]
        if c == "add-resource":
            return [ops.create("resource", _named_data(a, snap, "resource", True))]
        if c == "update-resource":
            r = _ref(snap, "resource", a.id)
            return [ops.update("resource", r["id"], _named_data(a, snap, "resource", False))]
        if c == "delete-resource":
            return [ops.remove("resource", _ref(snap, "resource", a.id)["id"])]
        raise BBError("unknown command " + c)

    def describe(res, snap):
        logs = [d for p, d in snap.staged.items() if p.startswith("log/")]
        return "; ".join(e.get("summary", "") for e in logs)[:200] or c

    res, snap, state = run_write(be, by, fn, describe)
    snap.items.update(snap.staged)
    v = View(snap)
    rows = []
    for r in res:
        cur = snap.get(r["kind"], r["id"]) or r
        rows.append(getattr(v, cur["kind"])(cur) if cur["kind"] != "list" else {k: x for k, x in cur.items() if k != "field_ts"})
    if js:
        out_json(rows[0] if len(rows) == 1 else rows)
    else:
        for r in rows:
            k = r.get("kind")
            if c.startswith("delete"):
                print("deleted %s %s" % (k, r.get("handle") or r.get("name")))
            elif k == "task":
                print(fmt_task(r))
            elif k == "project":
                print(fmt_project(r))
            elif k == "resource":
                print(fmt_resource(r))
            else:
                print("list '%s' (%s)" % (r["name"], r["id"]))
        if state == "local":
            warn("committed locally only (not pushed); it will be pushed on the next bb.py command when online")
        elif state == "unchanged":
            warn("nothing changed")
    return 0


def cmd_read(a, be):
    snap = be.read()
    v = View(snap)
    c = a.cmd
    js = a.json
    if c == "list":
        ts = tasks_sorted(snap)
        if a.list:
            l = next((x for x in live(snap, "list") if x["name"].lower() == a.list.lower()), None) or _ref(snap, "list", a.list)
            ts = [t for t in ts if t.get("list_id") == l["id"]]
        if a.project:
            pid = _ref(snap, "project", a.project)["id"]
            ts = [t for t in ts if t.get("project_id") == pid]
        st = "all" if a.all else a.status
        if st == "open":
            ts = [t for t in ts if t.get("status") != "done"]
        elif st != "all":
            ts = [t for t in ts if t.get("status") == st]
        rows = [v.task(t) for t in ts]
        if js:
            return out_json(rows) or 0
        cur = object()
        for r in rows:
            if r["list"] != cur:
                cur = r["list"]
                print("== %s ==" % (cur or "?"))
            print(fmt_task(r))
        if not rows:
            print("(no tasks)")
        return 0
    if c in ("next", "today"):
        if c == "next":
            lid = None
            if a.list:
                l = next((x for x in live(snap, "list") if x["name"].lower() == a.list.lower()), None) or _ref(snap, "list", a.list)
                lid = l["id"]
            rows = [v.task(t) for t in next_up(snap, lid, a.n)]
        else:
            rows = []
            for t in today_view(snap):
                d = v.task(t)
                d["bucket"] = t["bucket"]
                rows.append(d)
        if js:
            return out_json(rows[0] if (c == "next" and a.n == 1 and rows) else (None if c == "next" and a.n == 1 else rows)) or 0
        for r in rows:
            print(("%-8s " % r["bucket"] if c == "today" else "") + fmt_task(r) + ("  {%s}" % r["list"] if r.get("list") else ""))
        if not rows:
            print("nothing to do" if c == "next" else "nothing due today")
        return 0
    if c == "lists":
        rows = []
        for l in lists_sorted(snap):
            ts = [t for t in live(snap, "task") if t.get("list_id") == l["id"]]
            o = len([t for t in ts if t.get("status") != "done"])
            rows.append({"id": l["id"], "name": l["name"], "open": o, "done": len(ts) - o, "sort_order": l.get("sort_order")})
        if js:
            return out_json(rows) or 0
        for r in rows:
            print("%-20s open=%-3d done=%d" % (r["name"], r["open"], r["done"]))
        return 0
    if c == "projects":
        rows = [v.project(p) for p in sorted(live(snap, "project"), key=lambda p: p["name"].lower())]
        if js:
            return out_json(rows) or 0
        for r in rows:
            print(fmt_project(r))
        if not rows:
            print("(no projects)")
        return 0
    if c == "resources":
        rs = sorted(live(snap, "resource"), key=lambda r: ((r.get("type") or "").lower(), r["name"].lower()))
        if a.type:
            rs = [r for r in rs if (r.get("type") or "").lower() == a.type.lower()]
        rows = [v.resource(r) for r in rs]
        if js:
            return out_json(rows) or 0
        for r in rows:
            print(fmt_resource(r))
        if not rows:
            print("(no resources)")
        return 0
    if c == "show":
        r = _ref(snap, a.entity, a.id)
        d = getattr(v, a.entity)(r)
        if js:
            return out_json(d) or 0
        print({"task": fmt_task, "project": fmt_project, "resource": fmt_resource}[a.entity](d))
        print("        id: %s  created %s by %s, updated %s by %s%s" % (
            r["id"], r.get("created_at"), r.get("created_by"), r.get("updated_at"), r.get("updated_by"),
            "  [deleted]" if r.get("deleted") else ""))
        return 0
    if c == "log":
        rows = snap.log_entries(a.limit)
        if js:
            return out_json(rows) or 0
        for e in rows:
            print(fmt_act(e))
        return 0
    if c == "export":
        dump = {"schema_version": SCHEMA_VERSION, "exported_at": now_ts(),
                "lists": [r for r in snap.all("list")], "tasks": snap.all("task"), "projects": snap.all("project"),
                "resources": snap.all("resource")}
        text = json.dumps(dump, ensure_ascii=False, indent=2, sort_keys=True)
        if a.out:
            Path(a.out).write_text(text + "\n", encoding="utf-8")
            print("wrote %s" % a.out)
        else:
            print(text)
        return 0
    raise BBError("unknown command " + c)


# ---------------------------------------------------------------- argparse
WRITE_CMDS = {"add-task", "update-task", "done", "start", "reopen", "delete-task", "move-task", "add-list", "rename-list",
              "delete-list", "add-project", "update-project", "delete-project", "add-resource", "update-resource",
              "delete-resource"}
ALIASES = {"add": "add-task", "edit": "update-task", "ls": "list", "inventory": "resources"}


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--by", default=argparse.SUPPRESS,
                        help="who is making the change: user/boss/codex/claude/... (env BOSSBOARD_BY)")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="machine-readable JSON output")
    common.add_argument("--dir", default=argparse.SUPPRESS, help="path to a git clone of the data repo (env BOSSBOARD_DIR)")
    common.add_argument("--no-push", action="store_true", default=argparse.SUPPRESS,
                        help="git backend: commit locally, do not fetch/push")
    ap = argparse.ArgumentParser(prog="bb.py", description=__doc__.split("\n")[0], parents=[common],
                                 epilog="Data: tasks/ projects/ resources/ lists/ (one JSON per item), log/YYYY/MM/ (one JSON per change).")
    ap.add_argument("--version", action="version", version=VERSION)
    sp = ap.add_subparsers(dest="cmd", metavar="COMMAND")

    def sub(name, help_, aliases=()):
        return sp.add_parser(name, help=help_, parents=[common], aliases=list(aliases))

    def task_fields(p, create):
        if create:
            p.add_argument("title")
        else:
            p.add_argument("--title")
        p.add_argument("--list", "-l", help="context list e.g. Home, Errands, Work, 'Before leaving' (new names create a list)")
        p.add_argument("--project", "-p", help="project handle, id or name ('none' to clear)")
        p.add_argument("--priority", "-P", type=int, help="1 (highest) .. 5 (lowest), default 3")
        p.add_argument("--status", choices=TASK_STATUSES)
        p.add_argument("--due", "-d", help="YYYY-MM-DD, today, tomorrow, mon..sun, +3d, +1w, or none to clear")
        p.add_argument("--notes", "-n")

    task_fields(sub("add-task", "add a task", ["add"]), True)
    p = sub("update-task", "update task fields", ["edit"])
    p.add_argument("id", help="task handle (#12, 12, k3fa...) or full id")
    task_fields(p, False)
    for name, h in (("done", "mark task(s) done"), ("start", "mark task(s) doing"),
                    ("reopen", "mark task(s) todo"), ("delete-task", "delete task(s)")):
        p = sub(name, h)
        p.add_argument("ids", nargs="+", help="task handle(s)")
    p = sub("move-task", "reorder a task within its list")
    p.add_argument("id")
    p.add_argument("direction", choices=["up", "down", "top", "bottom"])
    p = sub("list", "list tasks (open only by default)", ["ls"])
    p.add_argument("--list", "-l")
    p.add_argument("--project", "-p")
    p.add_argument("--status", choices=TASK_STATUSES + ("open", "all"), default="open")
    p.add_argument("--all", "-a", action="store_true", help="include done tasks")
    p = sub("next", "show the single next task")
    p.add_argument("--list", "-l")
    p.add_argument("-n", type=int, default=1, help="show the next N")
    sub("today", "overdue + due today + in progress")
    sub("lists", "show context lists with open/done counts")
    p = sub("add-list", "create an (empty) context list")
    p.add_argument("name")
    p = sub("rename-list", "rename a list (merges if NEW exists)")
    p.add_argument("old")
    p.add_argument("new")
    p = sub("delete-list", "delete an empty list")
    p.add_argument("name")
    p = sub("show", "show one item: show task|project|resource REF")
    p.add_argument("entity", choices=["task", "project", "resource"])
    p.add_argument("id")

    def proj_fields(p, create):
        if create:
            p.add_argument("name")
        else:
            p.add_argument("--name")
        p.add_argument("--description", "-d")
        p.add_argument("--owner", "-o", help="who runs it: user/Codex/Claude/...")
        p.add_argument("--status", "-s")
        p.add_argument("--notes", "-n")
        p.add_argument("--parent", help="parent project handle or name ('none' to clear)")

    proj_fields(sub("add-project", "add a project"), True)
    p = sub("update-project", "update project fields")
    p.add_argument("id")
    proj_fields(p, False)
    sub("projects", "list projects")
    p = sub("delete-project", "delete a project (its tasks/resources are kept, unlinked)")
    p.add_argument("id")

    def res_fields(p, create):
        if create:
            p.add_argument("name")
        else:
            p.add_argument("--name")
        p.add_argument("--type", "-t", help="server/domain/service/api-key-location/...")
        p.add_argument("--project", "-p")
        p.add_argument("--host", help="hostname or IP")
        p.add_argument("--provider")
        p.add_argument("--os")
        p.add_argument("--ports")
        p.add_argument("--status", "-s")
        p.add_argument("--notes", "-n", help="NO secrets - say where the secret lives")

    res_fields(sub("add-resource", "add an inventory item"), True)
    p = sub("update-resource", "update inventory item fields")
    p.add_argument("id")
    res_fields(p, False)
    p = sub("resources", "list inventory", ["inventory"])
    p.add_argument("--type", "-t")
    p = sub("delete-resource", "delete an inventory item")
    p.add_argument("id")
    p = sub("log", "show activity log (newest first)")
    p.add_argument("--limit", "-n", type=int, default=30)
    p = sub("export", "dump everything as JSON")
    p.add_argument("--out", "-o", help="write to file instead of stdout")
    sub("sync", "git backend: fetch, merge offline commits, push")
    return ap


def main(argv=None):
    ap = build_parser()
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return e.code if isinstance(e.code, int) else 2
    if not a.cmd:
        ap.print_help()
        return 0
    a.cmd = ALIASES.get(a.cmd, a.cmd)
    a.by = getattr(a, "by", None) or os.environ.get("BOSSBOARD_BY") or "user"
    a.json = bool(getattr(a, "json", False))
    a.dir = getattr(a, "dir", None)
    a.no_push = bool(getattr(a, "no_push", False))
    try:
        be = pick_backend(a)
        if a.cmd == "sync":
            st = be.sync()
            print("synced" if st == "pushed" else "offline: changes kept locally")
            return 0
        if a.cmd in WRITE_CMDS:
            return cmd_write(a, be)
        return cmd_read(a, be)
    except BBError as e:
        sys.stderr.write("error: %s\n" % e)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
