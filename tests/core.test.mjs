// Unit tests for app/js/core.js plus a cross-language check against cli/bb.py (canonical JSON + merge must agree).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import * as C from "../app/js/core.js";
import { ROOT } from "./node_helpers.mjs";

const T = i => "2026-11-01T10:00:0" + i + ".000Z";
const edit = (r, patch, ts, by) => C.patchRecord(r, patch, by, ts).rec;
const base = () => C.newRecord("task", { title: "Water plants", list_id: "home" }, "boss", T(0), "abcd123456");

function memDb() {
  const m = new Map(); const log = [];
  return { m, log, get: (k, id) => m.get(k + "/" + id) || null, all: k => [...m.entries()].filter(([p]) => p.startsWith(k + "/")).map(e => e[1]), put: r => m.set(r.kind + "/" + r.id, r), log_: log, log: e => log.push(e) };
}

test("merge keeps disjoint field edits and LWW on the same field", () => {
  const b = base();
  const a = edit(b, { title: "A", priority: 2 }, T(1), "phone"), c = edit(b, { notes: "n", priority: 1 }, T(2), "codex");
  for (const m of [C.mergeRecords(a, c), C.mergeRecords(c, a)]) {
    assert.equal(m.title, "A"); assert.equal(m.notes, "n"); assert.equal(m.priority, 1); assert.equal(m.updated_by, "codex"); assert.equal(m.created_by, "boss");
  }
});

test("tombstone delete vs edit resolves by time; revive later wins", () => {
  const b = base();
  const d = edit(b, { deleted: true }, T(2), "phone"), e = edit(b, { notes: "x" }, T(1), "codex");
  const m = C.mergeRecords(e, d); assert.equal(m.deleted, true); assert.equal(m.notes, "x");
  assert.equal(C.mergeRecords(m, edit(d, { deleted: false }, T(3), "boss")).deleted, false);
});

test("merge is commutative, associative, idempotent (random)", () => {
  const vals = { title: ["a", "b", "ü"], priority: [1, 2, 3], notes: [null, "x"], deleted: [false, true], status: ["todo", "doing", "done"] };
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = a => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < 300; i++) {
    const v = [0, 1, 2].map(() => { let r = base(); for (let k = 0; k < 3; k++) { const f = pick(Object.keys(vals)); r = edit(r, { [f]: pick(vals[f]) }, T(Math.floor(rnd() * 4)), pick(["x", "y", "z"])); } return r; });
    const M = C.mergeRecords, c = C.canonical;
    assert.equal(c(M(v[0], v[1])), c(M(v[1], v[0])));
    assert.equal(c(M(M(v[0], v[1]), v[2])), c(M(v[0], M(v[1], v[2]))));
    assert.equal(c(M(v[0], v[0])), c(v[0]));
  }
});

test("ids, handles, refs, timestamps, paths", async () => {
  const ids = new Set(Array.from({ length: 2000 }, C.newId)); assert.equal(ids.size, 2000);
  for (const id of ids) { assert.match(id, /^[a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]{9}$/); }
  const recs = [{ id: "kaaaa11111" }, { id: "kaaab22222" }, { id: "mzzzz33333", legacy_id: 12 }];
  assert.deepEqual(C.handles(recs), { kaaaa11111: "kaaaa", kaaab22222: "kaaab", mzzzz33333: "12" });
  assert.equal(C.resolveRef(recs, "#12", "task").id, "mzzzz33333");
  assert.throws(() => C.resolveRef(recs, "kaaa", "task"));
  const ts = Array.from({ length: 300 }, () => C.nowTs()); assert.deepEqual(ts, [...new Set(ts)].sort());
  assert.equal(C.logPath("2026-11-01T19:19:00.123Z", "abcdef"), "log/2026/11/20261101T191900123Z-abcdef.json");
  assert.equal(C.slug("Before leaving"), "before-leaving"); assert.equal(C.slug("Café Ünï"), "cafe-uni");
  assert.equal(await C.gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("parseDue matches the v2.1 grammar", () => {
  const b = new Date(2026, 10, 1); // Sunday
  assert.equal(C.parseDue("tomorrow", b), "2026-11-02"); assert.equal(C.parseDue("fri", b), "2026-11-06");
  assert.equal(C.parseDue("sun", b), "2026-11-08"); assert.equal(C.parseDue("+1w", b), "2026-11-08");
  assert.equal(C.parseDue("none", b), null); assert.throws(() => C.parseDue("someday", b));
});

test("Ops: create/update/status/remove/move log with attribution", () => {
  const db = memDb(); const ops = new C.Ops(db, "Codex", "test");
  const p = ops.create("project", { name: "Website" });
  const t1 = ops.create("task", { title: "one", list: "Home", project_id: p.id, priority: 1 });
  const t2 = ops.create("task", { title: "two", list: "Home" });
  assert.equal(t1.list_id, "home"); assert.equal(db.all("list").length, 1);
  ops.setStatus(t2.id, "doing"); assert.equal(C.nextUp(db)[0].id, t2.id);
  ops.move(t2.id, "top"); assert.ok(db.get("task", t2.id).sort_order < db.get("task", t1.id).sort_order);
  ops.update("task", t1.id, { due: "today" }); assert.equal(C.todayView(db).length, 2);
  assert.throws(() => ops.create("resource", { name: "k", notes: "ghp" + "_" + "abcdefghijklmnopqrstuvwxyz0123456789" }), /secret/);
  assert.throws(() => ops.remove("list", "home"), /still has/);
  ops.remove("task", t1.id); assert.equal(db.get("task", t1.id).deleted, true);
  assert.ok(db.log_.every(e => e.by === "codex" && e.via === "test" && e.summary));
  assert.deepEqual([...new Set(db.log_.map(e => e.action))].sort(), ["create", "delete", "reorder", "start", "update"]);
});

test("cross-language: canonical() and mergeRecords() agree with cli/bb.py", () => {
  const cases = [];
  let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const vals = { title: ["a", "Ünïcødé ✓", "line\nbreak \"q\" \\ \t", "😀"], priority: [1, 2, 5], sort_order: [10, 15.5, 0.25, 1e-7, -3], notes: [null, "", "x"], deleted: [false, true] };
  for (let i = 0; i < 150; i++) {
    const v = [0, 1].map(() => { let r = base(); for (let k = 0; k < 4; k++) { const f = pick(Object.keys(vals)); r = edit(r, { [f]: pick(vals[f]) }, T(Math.floor(rnd() * 4)), pick(["x", "y"])); } if (rnd() < 0.3) r.extra_future_field = pick([1, "z", { n: [1, 2] }]); return r; });
    cases.push({ a: v[0], b: v[1], js: C.canonical(C.mergeRecords(v[0], v[1])) });
  }
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "cli"))})
import bb
cases = json.load(sys.stdin)
bad = [i for i, c in enumerate(cases) if bb.canonical(bb.merge_records(c["a"], c["b"])) != c["js"] or bb.canonical(c["a"]) != c["jsa"]]
print(json.dumps(bad))`;
  for (const c of cases) c.jsa = C.canonical(c.a);
  const out = execFileSync("python3", ["-c", py], { input: JSON.stringify(cases), encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), []);
});
