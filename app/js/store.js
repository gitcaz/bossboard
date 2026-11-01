// Local persistence: IndexedDB in the browser, an in-memory Map in tests. One record per repo file:
// {path, data, sha, dirty, ver}. "meta" holds the last synced head commit etc.
export class MemoryStore {
  constructor() { this.files = new Map(); this.meta = new Map(); }
  async open() { return this; }
  async allFiles() { return [...this.files.values()].map(x => JSON.parse(JSON.stringify(x))); }
  async putFiles(recs) { for (const r of recs) this.files.set(r.path, JSON.parse(JSON.stringify(r))); }
  async deleteFiles(paths) { for (const p of paths) this.files.delete(p); }
  async getMeta(k) { return this.meta.has(k) ? JSON.parse(JSON.stringify(this.meta.get(k))) : undefined; }
  async setMeta(k, v) { this.meta.set(k, JSON.parse(JSON.stringify(v))); }
  async clear() { this.files.clear(); this.meta.clear(); }
}

function p(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }

export class IDBStore {
  constructor(name) { this.name = name; this.db = null; }
  async open() {
    const req = indexedDB.open(this.name, 1);
    req.onupgradeneeded = () => { const db = req.result; db.createObjectStore("files", { keyPath: "path" }); db.createObjectStore("meta"); };
    this.db = await p(req); return this;
  }
  tx(stores, mode) { return this.db.transaction(stores, mode); }
  async allFiles() { return p(this.tx(["files"], "readonly").objectStore("files").getAll()); }
  async putFiles(recs) {
    if (!recs.length) return;
    const t = this.tx(["files"], "readwrite"); const s = t.objectStore("files");
    for (const r of recs) s.put(r);
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
  async deleteFiles(paths) {
    if (!paths.length) return;
    const t = this.tx(["files"], "readwrite"); const s = t.objectStore("files");
    for (const k of paths) s.delete(k);
    return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  }
  async getMeta(k) { return p(this.tx(["meta"], "readonly").objectStore("meta").get(k)); }
  async setMeta(k, v) { return p(this.tx(["meta"], "readwrite").objectStore("meta").put(v, k)); }
  async clear() { this.db.close(); await p(indexedDB.deleteDatabase(this.name)); }
}
