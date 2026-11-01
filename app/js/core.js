// BossBoard v3 core: data model, ids, canonical JSON, field-level merge, validation, views and edit ops.
// Pure ES module (no DOM), shared by the web app and the Node tests. cli/bb.py mirrors this logic in Python.
export const SCHEMA_VERSION = 3;
export const KINDS = ["task", "project", "resource", "list"];
export const DIRS = { task: "tasks", project: "projects", resource: "resources", list: "lists" };
export const FIELDS = {
  task: ["title", "list_id", "project_id", "priority", "status", "due", "notes", "sort_order", "completed_at", "deleted"],
  project: ["name", "description", "owner", "status", "notes", "parent_id", "deleted"],
  resource: ["name", "type", "project_id", "host", "provider", "os", "ports", "status", "notes", "deleted"],
  list: ["name", "sort_order", "deleted"],
};
export const LABEL = { task: "title", project: "name", resource: "name", list: "name" };
export const META = ["id", "kind", "created_at", "created_by", "updated_at", "updated_by", "legacy_id", "field_ts"];
export const TASK_STATUSES = ["todo", "doing", "done"];
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9_\-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abpr]-[A-Za-z0-9\-]{10,}/, /\bAIza[0-9A-Za-z_\-]{35}/,
];

export class BBError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// ---------------------------------------------------------------- time & ids
let _lastTs = "";
/** UTC ISO timestamp with ms, fixed width (string order == time order); strictly increasing per process. */
export function nowTs(date) {
  let t = (date || new Date()).toISOString();
  if (!date && t <= _lastTs) t = new Date(Date.parse(_lastTs) + 1).toISOString();
  if (!date) _lastTs = t;
  return t;
}
const ID_FIRST = "abcdefghjkmnpqrstvwxyz";            // Crockford base32 letters (no i l o u)
const ID_REST = "0123456789abcdefghjkmnpqrstvwxyz";   // Crockford base32, lowercase
function rnd(n) { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; }
/** 10-char collision-resistant id; always starts with a letter so it never looks like a legacy number. */
export function newId() {
  const b = rnd(10); let s = ID_FIRST[b[0] % ID_FIRST.length];
  for (let i = 1; i < 10; i++) s += ID_REST[b[i] % 32];
  return s;
}
export function randSuffix(n = 6) { const b = rnd(n); let s = ""; for (let i = 0; i < n; i++) s += ID_REST[b[i] % 32]; return s; }
export function slug(name) {
  return String(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "list";
}
export function pathFor(kind, id) { return DIRS[kind] + "/" + id + ".json"; }
export function parsePath(path) {
  const m = /^(tasks|projects|resources|lists)\/([A-Za-z0-9_-]+)\.json$/.exec(path);
  if (!m) return null;
  const kind = Object.keys(DIRS).find(k => DIRS[k] === m[1]);
  return { kind, id: m[2] };
}
/** log/YYYY/MM/YYYYMMDDTHHMMSSmmmZ-xxxxxx.json (file names sort chronologically) */
export function logPath(ts, suffix) {
  const c = ts.replace(/[-:.]/g, "");  // 20261101T191900123Z
  return "log/" + ts.slice(0, 4) + "/" + ts.slice(5, 7) + "/" + c + "-" + (suffix || randSuffix()) + ".json";
}

// ---------------------------------------------------------------- canonical JSON
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]); return o; }
  return v;
}
/** Deterministic serialization; byte-identical to Python json.dumps(sort_keys=True, indent=2, ensure_ascii=False)+"\n". */
export function canonical(obj) { return JSON.stringify(sortKeys(obj), null, 2) + "\n"; }
export async function gitBlobSha(text) {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode("blob " + body.length + "\0");
  const all = new Uint8Array(head.length + body.length); all.set(head); all.set(body, head.length);
  const h = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", all));
  return [...h].map(x => x.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- merge (field-level last-writer-wins)
function cmpVal(a, b) { const x = JSON.stringify(sortKeys(a ?? null)), y = JSON.stringify(sortKeys(b ?? null)); return x < y ? -1 : x > y ? 1 : 0; }
/**
 * Merge two versions of the same record. Commutative, associative and idempotent, so every client converges.
 * Each data field carries its own timestamp in field_ts; the newer one wins. Exact ties break on the
 * (canonical) value so the result does not depend on argument order. `deleted` is an ordinary field (tombstone).
 */
export function mergeRecords(a, b) {
  if (!a) return b; if (!b) return a;
  const fa = a.field_ts || {}, fb = b.field_ts || {};
  const out = {}, ft = {};
  const ua = a.updated_at || "", ub = b.updated_at || "";
  let newer;
  if (ua !== ub) newer = ua > ub ? a : b; else newer = cmpVal(a.updated_by, b.updated_by) >= 0 ? a : b;
  // unknown/extra keys (future fields without field_ts): take from the newer record
  for (const src of [newer === a ? b : a, newer]) for (const k of Object.keys(src)) if (!META.includes(k) && !(k in fa) && !(k in fb)) out[k] = src[k];
  for (const f of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    const ta = fa[f] || "", tb = fb[f] || "";
    let pick;
    if (ta !== tb) pick = ta > tb ? a : b; else pick = cmpVal(a[f], b[f]) >= 0 ? a : b;
    out[f] = pick[f] === undefined ? null : pick[f];
    ft[f] = ta > tb ? ta : tb;
  }
  out.id = a.id || b.id; out.kind = a.kind || b.kind;
  const ca = a.created_at || "", cb = b.created_at || "";
  const older = !ca ? b : !cb ? a : ca !== cb ? (ca < cb ? a : b) : (cmpVal(a.created_by, b.created_by) <= 0 ? a : b);
  out.created_at = older.created_at || null; out.created_by = older.created_by || null;
  out.updated_at = newer.updated_at || null; out.updated_by = newer.updated_by || null;
  const la = a.legacy_id ?? null, lb = b.legacy_id ?? null;
  if (la != null || lb != null) out.legacy_id = la == null ? lb : lb == null ? la : Math.min(la, lb);
  out.field_ts = ft;
  return out;
}

// ---------------------------------------------------------------- dates
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
export function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
export function todayIso(base) { return ymd(base || new Date()); }
export function dayStr(off, base) { const d = base ? new Date(base) : new Date(); d.setDate(d.getDate() + off); return ymd(d); }
function validDate(y, m, d) { const x = new Date(y, m - 1, d); if (x.getFullYear() !== y || x.getMonth() !== m - 1 || x.getDate() !== d) throw new BBError("invalid date"); return ymd(x); }
/** YYYY-MM-DD, YYYY/MM/DD, DD.MM.YYYY, today, tomorrow, yesterday, mon..sun (next occurrence, never today), +3d, +2w, none */
export function parseDue(s, base) {
  if (s == null) return null;
  s = String(s).trim(); const low = s.toLowerCase();
  if (["", "none", "null", "-", "clear"].includes(low)) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][0-9:.+\-Z]*)?$/.exec(s) || /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return validDate(+m[3], +m[2], +m[1]);
  const t = base ? new Date(base) : new Date(); t.setHours(12, 0, 0, 0);
  const add = n => { const d = new Date(t); d.setDate(d.getDate() + n); return ymd(d); };
  if (low === "today" || low === "tod") return add(0);
  if (["tomorrow", "tmr", "tmrw", "tom"].includes(low)) return add(1);
  if (low === "yesterday") return add(-1);
  m = /^\+?(\d{1,4})\s*(d|day|days|w|wk|week|weeks)$/.exec(low);
  if (m) return add(+m[1] * (m[2][0] === "w" ? 7 : 1));
  const w = low.startsWith("next ") ? low.slice(5) : low;
  const wd = (t.getDay() + 6) % 7;
  for (let i = 0; i < 7; i++) if (w.length >= 3 && WEEKDAYS[i].startsWith(w)) return add(((i - wd) % 7 + 7) % 7 || 7);
  throw new BBError("unrecognized due date '" + s + "' (use YYYY-MM-DD, today, tomorrow, mon..sun, +3d, +1w, none)");
}

// ---------------------------------------------------------------- validation
const INT_FIELDS = new Set(["priority"]);
export function clean(kind, data, partial) {
  if (!data || typeof data !== "object") throw new BBError("body must be an object");
  const allowed = FIELDS[kind].filter(f => f !== "deleted" && f !== "completed_at");
  const out = {};
  for (const k of allowed) {
    if (!(k in data)) continue;
    let v = data[k];
    if (typeof v === "string") { v = v.trim(); if (v === "") v = null; }
    if (INT_FIELDS.has(k) && v != null) { v = Number(v); if (!Number.isInteger(v)) throw new BBError(k + " must be an integer"); }
    if (k === "sort_order" && v != null) { v = Number(v); if (!Number.isFinite(v)) throw new BBError("sort_order must be a number"); }
    if (typeof v === "string") for (const p of SECRET_PATTERNS) if (p.test(v))
      throw new BBError("field '" + k + "' looks like it contains a secret. Never store secrets here; write WHERE the secret lives instead (e.g. 'in 1Password: vm1 root').");
    out[k] = v;
  }
  const label = LABEL[kind];
  if (!partial && !out[label]) throw new BBError(label + " is required");
  if (partial && label in out && !out[label]) throw new BBError(label + " cannot be empty");
  if (kind === "task") {
    if ("status" in out) { out.status = String(out.status || "todo").toLowerCase(); if (!TASK_STATUSES.includes(out.status)) throw new BBError("status must be one of: todo, doing, done"); }
    if ("priority" in out) { if (out.priority == null) out.priority = 3; if (out.priority < 1 || out.priority > 5) throw new BBError("priority must be 1 (highest) .. 5 (lowest)"); }
    if ("due" in out) out.due = parseDue(out.due);
    if ("sort_order" in out && out.sort_order == null) delete out.sort_order;
  }
  return out;
}

// ---------------------------------------------------------------- records
export function newRecord(kind, fields, by, ts, id) {
  const r = { id: id || newId(), kind, created_at: ts, created_by: by, updated_at: ts, updated_by: by, field_ts: {} };
  const defaults = { task: { list_id: "inbox", project_id: null, priority: 3, status: "todo", due: null, notes: null, sort_order: 10, completed_at: null },
    project: { description: null, owner: null, status: null, notes: null, parent_id: null },
    resource: { type: null, project_id: null, host: null, provider: null, os: null, ports: null, status: null, notes: null },
    list: { sort_order: 10 } }[kind];
  for (const f of FIELDS[kind]) { r[f] = f in fields ? fields[f] : (f === "deleted" ? false : (defaults[f] ?? null)); r.field_ts[f] = ts; }
  if (kind === "task" && r.status === "done" && !r.completed_at) r.completed_at = ts;
  return r;
}
/** Returns {rec, changes} with only the fields whose value actually changed stamped with ts. */
export function patchRecord(rec, patch, by, ts) {
  const out = JSON.parse(JSON.stringify(rec)); out.field_ts = out.field_ts || {};
  const changes = {};
  for (const [k, v] of Object.entries(patch)) {
    if (cmpVal(out[k], v) === 0) continue;
    changes[k] = [out[k] ?? null, v]; out[k] = v; out.field_ts[k] = ts;
  }
  if (rec.kind === "task" && "status" in changes) { out.completed_at = out.status === "done" ? ts : null; out.field_ts.completed_at = ts; }
  if (Object.keys(changes).length) { out.updated_at = ts; out.updated_by = by; }
  return { rec: out, changes };
}

// ---------------------------------------------------------------- handles
/** Short human handles per kind: legacy number ("3") if migrated from v2.1, else the shortest unique id prefix (min 4). */
export function handles(recs) {
  const ids = recs.map(r => r.id); const out = {};
  for (const r of recs) {
    if (r.legacy_id != null) { out[r.id] = String(r.legacy_id); continue; }
    let n = 4; while (n < r.id.length && ids.some(o => o !== r.id && o.startsWith(r.id.slice(0, n)))) n++;
    out[r.id] = r.id.slice(0, n);
  }
  return out;
}
export function resolveRef(recs, ref, kind) {
  ref = String(ref).trim().replace(/^#/, "");
  const live = recs.filter(r => !r.deleted);
  if (/^\d+$/.test(ref)) { const m = recs.filter(r => r.legacy_id === +ref); if (m.length) return m.find(r => !r.deleted) || m[0]; }
  let m = recs.filter(r => r.id === ref); if (m.length) return m[0];
  m = live.filter(r => r.id.startsWith(ref.toLowerCase()));
  if (m.length === 1) return m[0];
  if (m.length > 1) throw new BBError(kind + " '" + ref + "' is ambiguous: " + m.map(r => r.id).join(", "));
  const lab = LABEL[kind];
  if (kind !== "task") {
    m = live.filter(r => (r[lab] || "").toLowerCase() === ref.toLowerCase()); if (m.length) return m[0];
    m = live.filter(r => (r[lab] || "").toLowerCase().includes(ref.toLowerCase()));
    if (m.length === 1) return m[0];
    if (m.length > 1) throw new BBError(kind + " '" + ref + "' is ambiguous: " + m.map(r => r[lab]).join(", "));
  }
  throw new BBError(kind + " '" + ref + "' not found", 404);
}

// ---------------------------------------------------------------- views
export function live(db, kind) { return db.all(kind).filter(r => !r.deleted); }
export function listsSorted(db) {
  return live(db, "list").sort((a, b) => (a.sort_order - b.sort_order) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : 1));
}
export function nameOf(db, kind, id) { if (!id) return null; const r = db.get(kind, id); return r && !r.deleted ? r[LABEL[kind]] : null; }
export function tasksSorted(db) {
  const lo = {}; listsSorted(db).forEach((l, i) => lo[l.id] = i);
  return live(db, "task").sort((a, b) => ((lo[a.list_id] ?? 1e9) - (lo[b.list_id] ?? 1e9)) || (a.sort_order - b.sort_order) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) || (a.id < b.id ? -1 : 1));
}
export function nextCmp(t) {
  return (a, b) => {
    const k = x => [x.status === "doing" ? 0 : 1, x.due && x.due < t ? 0 : 1, x.due && x.due === t ? 0 : 1, x.priority, x.due ? 0 : 1, x.due || "", x.sort_order, x.created_at || "", x.id];
    const ka = k(a), kb = k(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
}
export function nextUp(db, listId, n = 1, today) {
  const t = today || todayIso();
  return live(db, "task").filter(x => x.status !== "done" && (!listId || x.list_id === listId)).sort(nextCmp(t)).slice(0, n);
}
export function todayView(db, today) {
  const t = today || todayIso();
  return live(db, "task").filter(x => x.status !== "done" && (x.status === "doing" || (x.due && x.due <= t))).sort(nextCmp(t))
    .map(x => Object.assign({}, x, { bucket: x.due && x.due < t ? "overdue" : x.due === t ? "today" : "doing" }));
}

// ---------------------------------------------------------------- edit ops
/**
 * Ops run against a db adapter {get(kind,id), all(kind), put(rec), log(entry)} and mirror the v2.1 semantics.
 * Every write records an activity entry with attribution `by`.
 */
export class Ops {
  constructor(db, by, via) { this.db = db; this.by = (by || "user").trim().toLowerCase() || "user"; this.via = via || "web"; }
  _log(ts, action, entity, rec, summary, details) {
    const e = { ts, by: this.by, action, entity, entity_id: rec ? rec.id : null, summary, via: this.via };
    if (rec && rec.legacy_id != null) e.legacy_id = rec.legacy_id;
    if (details !== undefined) e.details = details;
    this.db.log(e);
  }
  _h(rec) { return rec.legacy_id != null ? "#" + rec.legacy_id : rec.id.slice(0, 4); }
  ensureList(name, ts) {
    name = (name || "").trim() || "Inbox";
    const ex = live(this.db, "list").find(l => l.name.toLowerCase() === name.toLowerCase());
    if (ex) return ex;
    let id = slug(name); const taken = this.db.get("list", id);
    if (taken && !(taken.deleted && taken.name.toLowerCase() === name.toLowerCase())) id = id + "-" + randSuffix(4);
    const max = Math.max(0, ...live(this.db, "list").map(l => l.sort_order || 0));
    let rec;
    if (taken && id === slug(name)) rec = patchRecord(taken, { deleted: false, name }, this.by, ts).rec;  // revive tombstone
    else rec = newRecord("list", { name, sort_order: max + 10 }, this.by, ts, id);
    this.db.put(rec); this._log(ts, "create", "list", rec, "created list '" + name + "'");
    return rec;
  }
  listByName(name) { return live(this.db, "list").find(l => l.name.toLowerCase() === String(name).trim().toLowerCase()) || null; }
  _maxSort(listId, exceptId) { return Math.max(0, ...live(this.db, "task").filter(t => t.list_id === listId && t.id !== exceptId).map(t => t.sort_order || 0)); }
  _checkRefs(d, selfId, kind) {
    for (const k of ["project_id", "parent_id"]) if (d[k] != null) { const p = this.db.get("project", d[k]); if (!p || p.deleted) throw new BBError(k + " " + d[k] + " does not exist"); }
    if (kind === "project" && selfId && d.parent_id) {
      let cur = d.parent_id; const seen = new Set();
      while (cur && !seen.has(cur)) { if (cur === selfId) throw new BBError("parent_id would create a cycle"); seen.add(cur); const r = this.db.get("project", cur); cur = r ? r.parent_id : null; }
    }
  }
  _uniqueName(kind, name, selfId) {
    if (name && live(this.db, kind).some(r => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase())) throw new BBError(kind + " '" + name + "' already exists", 409);
  }
  /** data may carry `list` (a name) instead of list_id */
  create(kind, data, ts) {
    ts = ts || nowTs(); data = Object.assign({}, data);
    let listName = null; if (kind === "task" && "list" in data) { listName = data.list; delete data.list; }
    const d = clean(kind, data, false); this._checkRefs(d, null, kind);
    if (kind !== "task") this._uniqueName(kind, d.name);
    if (kind === "task") {
      if (!d.list_id) d.list_id = this.ensureList(listName || "Inbox", ts).id;
      if (d.sort_order == null) d.sort_order = this._maxSort(d.list_id) + 10;
    }
    const rec = newRecord(kind, d, this.by, ts); this.db.put(rec);
    const det = {}; for (const [k, v] of Object.entries(d)) if (v != null) det[k] = v;
    this._log(ts, "create", kind, rec, "created " + kind + " " + this._h(rec) + " '" + rec[LABEL[kind]] + "'", det);
    return rec;
  }
  update(kind, id, data, ts, action) {
    ts = ts || nowTs(); data = Object.assign({}, data);
    const old = this.db.get(kind, id); if (!old || old.deleted) throw new BBError(kind + " " + id + " not found", 404);
    let listName = null; if (kind === "task" && "list" in data) { listName = data.list; delete data.list; }
    const d = clean(kind, data, true); this._checkRefs(d, id, kind);
    if (kind !== "task" && d.name) this._uniqueName(kind, d.name, id);
    if (listName != null) d.list_id = this.ensureList(listName, ts).id;
    if (kind === "task" && d.list_id && d.list_id !== old.list_id && d.sort_order == null) d.sort_order = this._maxSort(d.list_id, id) + 10;
    const { rec, changes } = patchRecord(old, d, this.by, ts);
    if (!Object.keys(changes).length) return old;
    this.db.put(rec);
    const keys = Object.keys(changes).filter(k => k !== "sort_order" || Object.keys(changes).length === 1);
    if (!action) action = kind === "task" && keys.length === 1 && keys[0] === "status" ? { done: "done", doing: "start", todo: "reopen" }[rec.status] : "update";
    if (!(kind === "task" && keys.length === 1 && keys[0] === "sort_order" && action === "update")) {
      const verb = { update: "updated" }[action] || action;
      this._log(ts, action, kind, rec, verb + " " + kind + " " + this._h(rec) + " '" + old[LABEL[kind]] + "'" + (action === "update" ? ": " + keys.join(", ") : ""), changes);
    } else this._log(ts, "reorder", "task", rec, "moved task " + this._h(rec) + " '" + rec.title + "'");
    return rec;
  }
  setStatus(id, st, ts) { return this.update("task", id, { status: st }, ts); }
  remove(kind, id, ts) {
    ts = ts || nowTs(); const old = this.db.get(kind, id); if (!old || old.deleted) throw new BBError(kind + " " + id + " not found", 404);
    if (kind === "list") {
      const n = live(this.db, "task").filter(t => t.list_id === id).length;
      if (n) throw new BBError("list '" + old.name + "' still has " + n + " task(s); move or delete them first (or rename the list)", 409);
    }
    const { rec } = patchRecord(old, { deleted: true }, this.by, ts); this.db.put(rec);
    this._log(ts, "delete", kind, rec, "deleted " + kind + " " + (kind === "list" ? "" : this._h(rec) + " ") + "'" + old[LABEL[kind]] + "'");
    return rec;
  }
  renameList(id, newName, ts) {
    ts = ts || nowTs(); newName = (newName || "").trim(); if (!newName) throw new BBError("new list name is required");
    const old = this.db.get("list", id); if (!old || old.deleted) throw new BBError("list not found", 404);
    const target = live(this.db, "list").find(l => l.id !== id && l.name.toLowerCase() === newName.toLowerCase());
    const tasks = live(this.db, "task").filter(t => t.list_id === id).sort((a, b) => a.sort_order - b.sort_order);
    if (target) {  // merge into existing list, appended at the end
      let base = this._maxSort(target.id);
      for (const t of tasks) { base += 10; this.db.put(patchRecord(t, { list_id: target.id, sort_order: base }, this.by, ts).rec); }
      this.db.put(patchRecord(old, { deleted: true }, this.by, ts).rec);
    } else this.db.put(patchRecord(old, { name: newName }, this.by, ts).rec);
    this._log(ts, "rename", "list", old, "renamed list '" + old.name + "' -> '" + (target ? target.name : newName) + "' (" + tasks.length + " tasks)");
    return target || this.db.get("list", id);
  }
  /** Move task to sit before `beforeId` (null = end) in list `listId`; writes only the moved task. */
  place(id, listId, beforeId, ts) {
    ts = ts || nowTs(); const t = this.db.get("task", id);
    const sibs = live(this.db, "task").filter(x => x.list_id === listId && x.id !== id).sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
    let i = beforeId ? sibs.findIndex(x => x.id === beforeId) : sibs.length; if (i < 0) i = sibs.length;
    const lo = i > 0 ? sibs[i - 1].sort_order : null, hi = i < sibs.length ? sibs[i].sort_order : null;
    let so;
    if (lo == null && hi == null) so = 10; else if (lo == null) so = hi - 10; else if (hi == null) so = lo + 10; else so = (lo + hi) / 2;
    if (lo != null && hi != null && !(hi - lo > 1e-6)) {  // renumber (rare)
      sibs.splice(i, 0, t); sibs.forEach((x, k) => { if (x.id !== id) this.db.put(patchRecord(x, { sort_order: (k + 1) * 10 }, this.by, ts).rec); });
      so = (i + 1) * 10;
    }
    const patch = { sort_order: so }; if (listId !== t.list_id) patch.list_id = listId;
    return this.update("task", id, patch, ts);
  }
  move(id, dir, ts) {
    const t = this.db.get("task", id); if (!t || t.deleted) throw new BBError("task not found", 404);
    const sibs = live(this.db, "task").filter(x => x.list_id === t.list_id).sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
    const i = sibs.findIndex(x => x.id === id);
    let before;
    if (dir === "up") { if (i === 0) return t; before = sibs[i - 1].id; }
    else if (dir === "down") { if (i === sibs.length - 1) return t; before = i + 2 < sibs.length ? sibs[i + 2].id : null; }
    else if (dir === "top") { if (i === 0) return t; before = sibs[0].id; }
    else if (dir === "bottom") { if (i === sibs.length - 1) return t; before = null; }
    else throw new BBError("direction must be up|down|top|bottom");
    return this.place(id, t.list_id, before, ts);
  }
}
