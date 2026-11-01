// End-to-end: two offline-capable web clients (Engine + MemoryStore) and the Python CLI against the fake GitHub
// (real bare git repo). Covers offline edits, a forced non-fast-forward conflict, delete-vs-edit, convergence,
// rate limits and a bad token.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Engine } from "../app/js/sync.js";
import { MemoryStore } from "../app/js/store.js";
import { GitHub } from "../app/js/github.js";
import * as C from "../app/js/core.js";
import { makeBare, startFake, fakeCtl, cli, git } from "./node_helpers.mjs";

function client(api, name, token = "fake_token") {
  const state = { offline: false };
  const fetchImpl = (...a) => state.offline ? Promise.reject(new TypeError("Failed to fetch")) : fetch(...a);
  const gh = new GitHub({ owner: "o", repo: "data", token, branch: "main", apiBase: api, fetchImpl });
  const eng = new Engine({ store: new MemoryStore(), gh, via: "web-" + name });
  return { eng, gh, state, name };
}
const items = e => {
  const o = {};
  for (const [p, f] of e.files) if (/^(tasks|projects|resources|lists)\//.test(p)) o[p] = C.canonical(f.data);
  return o;
};
const findTask = (e, title) => C.live(e.db, "task").find(t => t.title === title);

test("two offline clients + CLI converge through the fake GitHub", async (t) => {
  const { tmp, bare } = makeBare();
  const fake = await startFake(bare);
  t.after(() => fake.stop());
  const cache = path.join(tmp, "cache");
  const A = client(fake.api, "A"), B = client(fake.api, "B");
  await A.eng.init(); await B.eng.init();
  await A.eng.sync(); await B.eng.sync();
  assert.equal(A.eng.status.state, "synced");
  assert.deepEqual(C.listsSorted(A.eng.db).map(l => l.name), ["Home", "Errands", "Work", "Before leaving"]);

  // A creates while offline -> pending, then online -> pushed; B pulls it
  A.state.offline = true;
  const task = await A.eng.edit("boss", ops => ops.create("task", { title: "Water plants", list: "Home" }));
  const gone = await A.eng.edit("boss", ops => ops.create("task", { title: "Doomed", list: "Errands" }));
  await assert.rejects(A.eng.sync());
  assert.equal(A.eng.status.state, "offline");
  assert.ok(A.eng.status.pending > 0);
  A.state.offline = false;
  await A.eng.sync();
  assert.equal(A.eng.status.pending, 0);
  await B.eng.sync();
  assert.ok(findTask(B.eng, "Water plants"));

  // both offline; conflicting edits
  A.state.offline = B.state.offline = true;
  await A.eng.edit("phone", ops => ops.update("task", task.id, { title: "Water ALL plants", priority: 2 }));
  await A.eng.edit("phone", ops => ops.create("task", { title: "From A offline", list: "Work" }));
  await A.eng.edit("phone", ops => ops.remove("task", gone.id));          // delete (later) ...
  await new Promise(r => setTimeout(r, 5));
  await B.eng.edit("laptop", ops => ops.update("task", task.id, { priority: 1, notes: "windows too" }));
  await B.eng.edit("laptop", ops => ops.create("task", { title: "From B offline", list: "Garage" }));
  await B.eng.edit("laptop", ops => ops.ensureList("Garage"));
  // ... while the CLI (agent) edits in between, online
  cli(fake.api, ["edit", task.id.slice(0, 6), "--status", "doing", "--by", "codex"], cache);
  cli(fake.api, ["add-list", "Garage", "--by", "codex"], cache);

  // A comes back first
  A.state.offline = false;
  await A.eng.sync();
  // B comes back; force a race: another writer commits between B's createCommit and updateRef -> 422 -> refetch/merge/retry
  B.state.offline = false;
  const realUpdate = B.gh.updateRef.bind(B.gh); let raced = false;
  B.gh.updateRef = async (sha) => { if (!raced) { raced = true; cli(fake.api, ["add", "Racing agent task", "--by", "claude"], cache); } return realUpdate(sha); };
  await B.eng.sync();
  const stats = await fakeCtl(fake.api, "stats");
  assert.ok(stats.conflicts >= 1, "a non-fast-forward was rejected and retried");
  await A.eng.sync(); await B.eng.sync();

  assert.deepEqual(items(A.eng), items(B.eng), "clients converged");
  const ta = A.eng.db.get("task", task.id);
  assert.equal(ta.title, "Water ALL plants");      // A's field
  assert.equal(ta.priority, 1);                   // B wrote priority later
  assert.equal(ta.notes, "windows too");          // B's field
  assert.equal(ta.status, "doing");               // CLI's field
  assert.equal(A.eng.db.get("task", gone.id).deleted, true);
  for (const title of ["From A offline", "From B offline", "Racing agent task"]) assert.ok(findTask(A.eng, title), title);
  assert.equal(C.live(A.eng.db, "list").filter(l => l.name === "Garage").length, 1, "same list created 3x -> one file");

  // repo == clients; one commit per sync; log attribution intact
  const cliList = JSON.parse(cli(fake.api, ["list", "--all", "--json"], cache));
  assert.deepEqual(cliList.map(x => x.id).sort(), C.live(A.eng.db, "task").map(x => x.id).sort());
  const bys = new Set(A.eng.logEntries().map(e => e.by));
  for (const b of ["boss", "phone", "laptop", "codex", "claude"]) assert.ok(bys.has(b), b);
  const msgs = git(["--git-dir", bare, "log", "--format=%s"]).trim().split("\n");
  assert.ok(msgs.some(m => m.startsWith("bb: ")));

  // rate limit -> 'ratelimited' state with a retry time; then recovers
  await fakeCtl(fake.api, "ratelimit", { n: 1, retry_after: 2 });
  await A.eng.edit("boss", ops => ops.create("task", { title: "after limit" }));
  await assert.rejects(A.eng.sync());
  assert.equal(A.eng.status.state, "ratelimited");
  assert.ok(A.eng.status.until > Date.now());
  await A.eng.sync();
  assert.equal(A.eng.status.pending, 0);

  // bad token -> auth error, nothing lost locally
  const X = client(fake.api, "X", "wrong");
  await X.eng.init();
  await X.eng.edit("boss", ops => ops.create("task", { title: "kept locally" }));
  await assert.rejects(X.eng.sync());
  assert.equal(X.eng.status.state, "error");
  assert.equal(X.eng.status.errorKind, "auth");
  assert.ok(X.eng.status.pending > 0);
});

test("restart keeps the outbox (store persistence) and pushes later", async (t) => {
  const { bare } = makeBare();
  const fake = await startFake(bare);
  t.after(() => fake.stop());
  const store = new MemoryStore();
  const mk = () => new Engine({ store, gh: new GitHub({ owner: "o", repo: "data", token: "fake_token", apiBase: fake.api }), via: "web" });
  const e1 = mk(); await e1.init(); await e1.sync();
  await e1.edit("boss", ops => ops.create("task", { title: "written before reload" }));
  const e2 = mk(); await e2.init();            // "page reload" before the sync happened
  assert.ok(e2.status.pending > 0);
  await e2.sync();
  assert.equal(e2.status.pending, 0);
  const c = new Engine({ store: new MemoryStore(), gh: new GitHub({ owner: "o", repo: "data", token: "fake_token", apiBase: fake.api }) });
  await c.init(); await c.sync();
  assert.ok(findTask(c, "written before reload"));
});
