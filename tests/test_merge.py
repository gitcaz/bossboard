import itertools
import json
import random
import unittest

import helpers  # noqa: F401
import bb


def rec(fields, ts, by="a", iid="abcd123456", kind="task"):
    r = {"id": iid, "kind": kind, "created_at": ts, "created_by": by, "updated_at": ts, "updated_by": by, "field_ts": {}}
    for k, v in fields.items():
        r[k] = v
        r["field_ts"][k] = ts
    return r


def edit(r, patch, ts, by):
    return bb.patch_record(r, patch, by, ts)[0]


T0, T1, T2, T3 = ("2026-11-01T10:00:00.000Z", "2026-11-01T10:00:01.000Z", "2026-11-01T10:00:02.000Z", "2026-11-01T10:00:03.000Z")


class MergeTests(unittest.TestCase):
    def base(self):
        return bb.new_record("task", {"title": "Water plants", "list_id": "home"}, "boss", T0, "abcd123456")

    def test_disjoint_fields_both_kept(self):
        b = self.base()
        a = edit(b, {"title": "Water ALL plants"}, T1, "phone")
        c = edit(b, {"priority": 1}, T2, "codex")
        m = bb.merge_records(a, c)
        self.assertEqual(m["title"], "Water ALL plants")
        self.assertEqual(m["priority"], 1)
        self.assertEqual(m["updated_by"], "codex")
        self.assertEqual(m["created_by"], "boss")

    def test_same_field_last_writer_wins(self):
        b = self.base()
        a = edit(b, {"title": "A"}, T2, "phone")
        c = edit(b, {"title": "C"}, T1, "codex")
        self.assertEqual(bb.merge_records(a, c)["title"], "A")
        self.assertEqual(bb.merge_records(c, a)["title"], "A")

    def test_tie_is_deterministic(self):
        b = self.base()
        a = edit(b, {"title": "A"}, T1, "x")
        c = edit(b, {"title": "C"}, T1, "y")
        self.assertEqual(bb.merge_records(a, c), bb.merge_records(c, a))

    def test_delete_vs_edit_tombstone(self):
        b = self.base()
        d = edit(b, {"deleted": True}, T2, "phone")
        e = edit(b, {"notes": "later"}, T1, "codex")
        m = bb.merge_records(d, e)
        self.assertTrue(m["deleted"])
        self.assertEqual(m["notes"], "later")
        # a later revive beats the older delete
        r = edit(d, {"deleted": False}, T3, "boss")
        self.assertFalse(bb.merge_records(m, r)["deleted"])

    def test_status_carries_completed_at(self):
        b = self.base()
        d = edit(b, {"status": "done"}, T2, "phone")
        self.assertEqual(d["completed_at"], T2)
        e = edit(b, {"status": "doing"}, T1, "codex")
        m = bb.merge_records(e, d)
        self.assertEqual((m["status"], m["completed_at"]), ("done", T2))

    def test_none_sides(self):
        b = self.base()
        self.assertIs(bb.merge_records(None, b), b)
        self.assertIs(bb.merge_records(b, None), b)

    def test_legacy_id_min(self):
        a = dict(self.base(), legacy_id=7)
        c = self.base()
        self.assertEqual(bb.merge_records(a, c)["legacy_id"], 7)

    def test_properties_random(self):
        rnd = random.Random(42)
        fields = ["title", "priority", "notes", "deleted", "status"]
        vals = {"title": ["a", "b", "c"], "priority": [1, 2, 3], "notes": [None, "x"], "deleted": [False, True],
                "status": ["todo", "doing", "done"]}
        stamps = [T0, T1, T2, T3]
        for _ in range(300):
            versions = []
            for _v in range(3):
                r = self.base()
                for f in rnd.sample(fields, rnd.randint(1, 3)):
                    r = edit(r, {f: rnd.choice(vals[f])}, rnd.choice(stamps), rnd.choice("xyz"))
                versions.append(r)
            a, b, c = versions
            m = bb.merge_records
            self.assertEqual(bb.canonical(m(a, b)), bb.canonical(m(b, a)), "commutative")
            self.assertEqual(bb.canonical(m(m(a, b), c)), bb.canonical(m(a, m(b, c))), "associative")
            self.assertEqual(bb.canonical(m(a, a)), bb.canonical(a), "idempotent")
            self.assertEqual(bb.canonical(m(m(a, b), b)), bb.canonical(m(a, b)), "absorbing")


class CoreTests(unittest.TestCase):
    def test_canonical_and_sha(self):
        t = bb.canonical({"b": 1.0, "a": [1, {"z": None, "y": "ü"}]})
        self.assertEqual(t, '{\n  "a": [\n    1,\n    {\n      "y": "ü",\n      "z": null\n    }\n  ],\n  "b": 1\n}\n')
        self.assertEqual(bb.git_blob_sha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a")

    def test_ids(self):
        ids = {bb.new_id() for _ in range(2000)}
        self.assertEqual(len(ids), 2000)
        for i in ids:
            self.assertEqual(len(i), 10)
            self.assertTrue(i[0].isalpha())
            self.assertTrue(set(i) <= set(bb.ID_REST))

    def test_ts_monotonic_fixed_width(self):
        ts = [bb.now_ts() for _ in range(500)]
        self.assertEqual(ts, sorted(set(ts)))
        self.assertTrue(all(len(t) == 24 and t.endswith("Z") for t in ts))

    def test_handles_and_resolve(self):
        recs = [{"id": "kaaaa11111"}, {"id": "kaaab22222"}, {"id": "mzzzz33333", "legacy_id": 12}]
        h = bb.handles(recs)
        self.assertEqual(h, {"kaaaa11111": "kaaaa", "kaaab22222": "kaaab", "mzzzz33333": "12"})
        self.assertEqual(bb.resolve_ref(recs, "#12", "task")["id"], "mzzzz33333")
        self.assertEqual(bb.resolve_ref(recs, "kaaab", "task")["id"], "kaaab22222")
        with self.assertRaises(bb.BBError):
            bb.resolve_ref(recs, "kaaa", "task")

    def test_parse_due(self):
        import datetime as d
        base = d.date(2026, 11, 1)  # Sunday
        self.assertEqual(bb.parse_due("tomorrow", base), "2026-11-02")
        self.assertEqual(bb.parse_due("fri", base), "2026-11-06")
        self.assertEqual(bb.parse_due("sun", base), "2026-11-08")
        self.assertEqual(bb.parse_due("+1w", base), "2026-11-08")
        self.assertEqual(bb.parse_due("5.11.2026", base), "2026-11-05")
        self.assertIsNone(bb.parse_due("none", base))
        with self.assertRaises(bb.BBError):
            bb.parse_due("someday", base)

    def test_secret_rejected(self):
        with self.assertRaises(bb.BBError):
            bb.clean("resource", {"name": "x", "notes": "-----" + "BEGIN OPENSSH PRIVATE KEY-----"}, False)
        bb.clean("resource", {"name": "x", "notes": "root pw lives in 1Password"}, False)

    def test_log_path(self):
        p = bb.log_path("2026-11-01T19:19:00.123Z", "abcdef")
        self.assertEqual(p, "log/2026/11/20261101T191900123Z-abcdef.json")
        self.assertTrue(bb.LOG_RE.match(p))


if __name__ == "__main__":
    unittest.main()
