// Sync engine: local cache (store) + outbox (dirty files) <-> GitHub data repo. One sync = one commit.
import { Ops, BBError, SCHEMA_VERSION, DIRS, pathFor, parsePath, logPath, canonical, gitBlobSha, mergeRecords } from "./core.js";

const ITEM_RE = /^(tasks|projects|resources|lists)\/[A-Za-z0-9_-]+\.json$/;
const LOG_RE = /^log\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.json$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

export class Engine {
  constructor({ store, gh, logWindow, via, onChange }) {
    this.store = store; this.gh = gh; this.logWindow = logWindow || 200; this.via = via || "web";
    this.onChange = onChange || (() => {});
    this.files = new Map(); this.meta = {}; this.remoteLog = []; this.readOnly = null;
    this.status = { state: gh ? "idle" : "unconfigured", pending: 0, lastSync: null, error: null, until: null };
    this._syncing = null; this._again = false;
  }
  async init() {
    await this.store.open();
    for (const f of await this.store.allFiles()) this.files.set(f.path, f);
    this.meta = (await this.store.getMeta("sync")) || {};
    this.remoteLog = (await this.store.getMeta("remoteLog")) || [];
    this.status.lastSync = this.meta.lastSync || null;
    this._updPending(); return this;
  }
  // ------------------------------------------------------------ db adapter for Ops
  get db() {
    const self = this;
    return {
      get(kind, id) { const p = pathFor(kind, id); const s = self._stage && self._stage.get(p); if (s) return s.data; const f = self.files.get(p); return f ? f.data : null; },
      all(kind) {
        const pre = DIRS[kind] + "/"; const out = new Map();
        for (const [p, f] of self.files) if (p.startsWith(pre) && f.data) out.set(p, f.data);
        if (self._stage) for (const [p, s] of self._stage) if (p.startsWith(pre)) out.set(p, s.data);
        return [...out.values()];
      },
      put(rec) { self._stage.set(pathFor(rec.kind, rec.id), { data: rec }); },
      log(e) { self._stage.set(logPath(e.ts), { data: e }); },
    };
  }
  /** Run edit ops atomically: fn(ops) -> result; all writes land in the outbox together or not at all. */
  async edit(by, fn) {
    if (this.readOnly) throw new BBError(this.readOnly);
    this._stage = new Map();
    let res;
    try { res = fn(new Ops(this.db, by, this.via)); } catch (e) { this._stage = null; throw e; }
    const recs = [];
    for (const [path, s] of this._stage) {
      const old = this.files.get(path);
      const f = { path, data: s.data, sha: old ? old.sha : null, dirty: true, ver: (old ? old.ver || 0 : 0) + 1 };
      this.files.set(path, f); recs.push(f);
    }
    this._stage = null;
    await this.store.putFiles(recs);
    this._updPending(); this.onChange("edit");
    return res;
  }
  _updPending() {
    let logs = 0, items = 0;
    for (const f of this.files.values()) if (f.dirty) { if (f.path.startsWith("log/")) logs++; else items++; }
    this.status.pending = logs || items;
    if (["idle", "synced", "pending"].includes(this.status.state)) this.status.state = this.status.pending ? "pending" : (this.status.lastSync ? "synced" : "idle");
  }
  _set(state, extra) { Object.assign(this.status, { state, error: null, until: null }, extra || {}); this.onChange("status"); }
  logEntries() {
    const out = [];
    for (const [p, f] of this.files) if (p.startsWith("log/") && f.data) out.push(Object.assign({ _path: p }, f.data));
    return out.sort((a, b) => (a._path < b._path ? 1 : -1));
  }
  olderLogCount() {
    const local = this.logEntries(); const oldest = local.length ? local[local.length - 1]._path : null;
    return this.remoteLog.filter(p => !this.files.has(p) && (!oldest || p < oldest)).length;
  }
  // ------------------------------------------------------------ sync
  sync() {
    if (!this.gh) return Promise.resolve(this.status);
    if (this._syncing) { this._again = true; return this._syncing; }
    this._syncing = (async () => {
      try {
        do { this._again = false; await this._syncOnce(); } while (this._again);
      } finally { this._syncing = null; }
      return this.status;
    })();
    return this._syncing;
  }
  async _syncOnce() {
    this._set("syncing");
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const head = await this.gh.headSha();
        if (head !== this.meta.head) await this._pull(head);
        if (this.readOnly) throw new BBError(this.readOnly);
        const dirty = [...this.files.values()].filter(f => f.dirty);
        if (!dirty.length) { await this._saveMeta({ head, tree: this.meta.tree }); break; }
        const snap = dirty.map(f => ({ path: f.path, ver: f.ver, text: canonical(f.data) }));
        const tree = await this.gh.createTree(this.meta.tree, snap.map(s => ({ path: s.path, mode: "100644", type: "blob", content: s.text })));
        const commit = await this.gh.createCommit(this._message(dirty), tree.sha, [head]);
        try { await this.gh.updateRef(commit.sha); }
        catch (e) {
          if (e.kind === "conflict" && attempt < 5) { this.onChange("conflict"); await sleep(150 * 2 ** attempt + Math.random() * 200); continue; }
          throw e;
        }
        const upd = [];
        for (const s of snap) {
          const f = this.files.get(s.path); f.sha = await gitBlobSha(s.text);
          if (f.ver === s.ver) f.dirty = false;
          upd.push(f);
        }
        await this.store.putFiles(upd);
        this.remoteLog = [...new Set([...this.remoteLog, ...snap.map(s => s.path).filter(p => LOG_RE.test(p))])].sort();
        await this.store.setMeta("remoteLog", this.remoteLog);
        await this._saveMeta({ head: commit.sha, tree: tree.sha });
        this.onChange("pushed");
        if (![...this.files.values()].some(f => f.dirty)) break;
      }
      this.meta.lastSync = new Date().toISOString(); await this._saveMeta({});
      this.status.lastSync = this.meta.lastSync;
      this._set("idle"); this._updPending(); this.onChange("status");
    } catch (e) {
      this._updPending();
      if (e.kind === "network") this._set("offline");
      else if (e.kind === "ratelimit") this._set("ratelimited", { error: e.message, until: e.until });
      else this._set("error", { error: e.message, errorKind: e.kind || "app" });
      throw e;
    }
  }
  async _saveMeta(m) { Object.assign(this.meta, m); await this.store.setMeta("sync", this.meta); }
  _message(dirty) {
    const logs = dirty.filter(f => f.path.startsWith("log/")).map(f => f.data).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const by = [...new Set(logs.map(l => l.by))].join(",") || "user";
    const first = logs.length ? logs[0].summary : "merge " + dirty.length + " item(s)";
    return "bb: " + first + (logs.length > 1 ? " (+" + (logs.length - 1) + " more)" : "") + "\n\nvia " + this.via + " by " + by;
  }
  async _pull(head) {
    const commit = await this.gh.commit(head);
    const tree = await this.gh.tree(commit.tree.sha);
    if (tree.truncated) throw new BBError("data repo tree too large for a single listing (truncated)");
    const remote = new Map();
    for (const e of tree.tree) if (e.type === "blob") remote.set(e.path, e.sha);
    if (!remote.has("bossboard.json")) throw new BBError("not a BossBoard data repo (bossboard.json missing) - push data-template first");
    const sf = this.files.get("bossboard.json");
    if (!sf || sf.sha !== remote.get("bossboard.json")) {
      const d = JSON.parse(await this.gh.blobText(remote.get("bossboard.json")));
      const f = { path: "bossboard.json", data: d, sha: remote.get("bossboard.json"), dirty: false, ver: 0 };
      this.files.set(f.path, f); await this.store.putFiles([f]);
    }
    const sv = this.files.get("bossboard.json").data.schema_version;
    this.readOnly = sv > SCHEMA_VERSION ? "the data repo uses schema " + sv + "; this app supports " + SCHEMA_VERSION + " - reload to update the app" : null;
    const logs = [...remote.keys()].filter(p => LOG_RE.test(p)).sort();
    this.remoteLog = logs;
    const localLogs = [...this.files.keys()].filter(p => p.startsWith("log/")).sort();
    const oldest = localLogs.length ? localLogs[0] : null;
    const wantLog = new Set(logs.filter((p, i) => !this.files.has(p) && ((oldest && p > oldest) || i >= logs.length - this.logWindow)));
    const need = [];
    for (const [p, sha] of remote) {
      if (ITEM_RE.test(p)) { const f = this.files.get(p); if (!f || f.sha !== sha) need.push([p, sha]); }
      else if (wantLog.has(p)) need.push([p, sha]);
      else if (LOG_RE.test(p) && this.files.has(p) && !this.files.get(p).sha) { const f = this.files.get(p); f.sha = sha; }
    }
    const texts = await pool(need, 6, ([p, sha]) => this.gh.blobText(sha));
    const upd = [];
    need.forEach(([p, sha], i) => {
      let data; try { data = JSON.parse(texts[i]); } catch (e) { console.warn("bad JSON in", p); return; }
      const f = this.files.get(p);
      if (f && f.dirty && !p.startsWith("log/")) {
        const merged = mergeRecords(f.data, data);
        f.data = merged; f.sha = sha;
        if (canonical(merged) === texts[i]) f.dirty = false;
        upd.push(f);
      } else if (f && f.dirty) { f.sha = sha; f.dirty = false; upd.push(f); }
      else { const n = { path: p, data, sha, dirty: false, ver: f ? f.ver || 0 : 0 }; this.files.set(p, n); upd.push(n); }
    });
    const gone = [];
    for (const [p, f] of this.files) if ((ITEM_RE.test(p) || LOG_RE.test(p)) && !remote.has(p) && f.sha && !f.dirty) gone.push(p);
    for (const p of gone) this.files.delete(p);
    await this.store.putFiles(upd); await this.store.deleteFiles(gone);
    await this.store.setMeta("remoteLog", this.remoteLog);
    await this._saveMeta({ head, tree: commit.tree.sha });
    this.onChange("pulled");
  }
  async loadOlderLog(n) {
    const local = this.logEntries(); const oldest = local.length ? local[local.length - 1]._path : "~";
    const want = this.remoteLog.filter(p => !this.files.has(p) && p < oldest).slice(-(n || 200));
    if (!want.length || !this.gh) return 0;
    const tree = await this.gh.tree(this.meta.tree);
    const sha = new Map(tree.tree.map(e => [e.path, e.sha]));
    const texts = await pool(want, 6, p => this.gh.blobText(sha.get(p)));
    const upd = want.map((p, i) => ({ path: p, data: JSON.parse(texts[i]), sha: sha.get(p), dirty: false, ver: 0 }));
    upd.forEach(f => this.files.set(f.path, f)); await this.store.putFiles(upd); this.onChange("pulled");
    return upd.length;
  }
}
export { parsePath };
