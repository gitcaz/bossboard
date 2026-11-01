// BossBoard v3 web UI (vanilla ES modules, no build step).
import { Engine } from "./sync.js";
import { GitHub, safeApiBase } from "./github.js";
import { IDBStore } from "./store.js";
import { live, listsSorted, tasksSorted, nextUp, todayView, nameOf, handles, dayStr, BBError } from "./core.js";

const VERSION = "3.0.0";
const $ = s => document.querySelector(s);
const LS = {
  get: k => localStorage.getItem("bb3." + k) || "",
  set: (k, v) => v ? localStorage.setItem("bb3." + k, v) : localStorage.removeItem("bb3." + k),
};
const TABS = ["next", "today", "tasks", "projects", "inventory", "activity", "settings"];
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : (LS.get("tab") || "next");
let showDone = JSON.parse(LS.get("showDone") || "{}"), dragId = null, engine = null, S = null;
let blockedUntil = 0, authBlocked = false, syncTimer = null, testMsg = "";

$("#who").value = LS.get("who") || "user";
$("#who").onchange = e => LS.set("who", e.target.value);
if (LS.get("theme")) document.documentElement.dataset.theme = LS.get("theme");
$("#theme").onclick = () => { const d = document.documentElement; const dark = d.dataset.theme ? d.dataset.theme === "dark" : matchMedia("(prefers-color-scheme:dark)").matches; d.dataset.theme = dark ? "light" : "dark"; LS.set("theme", d.dataset.theme); };

function esc(s) { return s == null ? "" : String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function err(m) { const e = $("#err"); e.textContent = m; e.style.display = "block"; clearTimeout(err.t); err.t = setTimeout(() => e.style.display = "none", 6000); }
function cfg() { return { owner: LS.get("owner"), repo: LS.get("repo"), branch: LS.get("branch") || "main", token: LS.get("token"), apiBase: safeApiBase(LS.get("apiBase")) }; }
function configured() { const c = cfg(); return !!(c.owner && c.repo && c.token); }

// ------------------------------------------------------------------ engine
async function boot() {
  const c = cfg();
  const key = "bossboard3:" + (c.owner && c.repo ? c.owner + "/" + c.repo : "_local");
  engine = new Engine({ store: new IDBStore(key), gh: configured() ? new GitHub(c) : null, via: "web", onChange: onEngine });
  await engine.init();
  if (!configured() && tab !== "settings") tab = "settings";
  render(); doSync();
}
function onEngine(kind) { renderStatus(); if (kind === "edit") { render(); scheduleSync(1500); } else if (kind === "pulled" || kind === "pushed") { if (!busy()) render(); } }
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(doSync, ms); }
async function doSync(manual) {
  if (!engine || !engine.gh) { renderStatus(); return; }
  if (!manual && (authBlocked || Date.now() < blockedUntil)) { renderStatus(); return; }
  if (!navigator.onLine) { engine._set("offline"); return; }
  try { await engine.sync(); authBlocked = false; }
  catch (e) {
    if (e.kind === "ratelimit") { blockedUntil = e.until || Date.now() + 60000; scheduleSync(Math.max(5000, blockedUntil - Date.now() + 1000)); }
    else if (e.kind === "auth" || e.kind === "notfound" || e.kind === "empty") authBlocked = true;
    else if (e.kind === "network") { /* wait for 'online' */ }
    else scheduleSync(30000);
  }
  renderStatus(); if (!busy()) render();
}
addEventListener("online", () => doSync());
addEventListener("offline", () => engine && engine._set("offline"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) doSync(); });
setInterval(() => { if (!document.hidden) doSync(); }, 60000);
$("#sync").onclick = () => { if (!configured()) return setTab("settings"); if (engine.status.state === "error") { authBlocked = false; } doSync(true); };

function renderStatus() {
  if (!engine) return;
  const st = engine.status, el = $("#sync"); let txt, cls = st.state;
  const t = st.lastSync ? new Date(st.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (!engine.gh) { cls = "unconfigured"; txt = "not connected"; }
  else if (st.state === "syncing") txt = "syncing" + (st.pending ? " (" + st.pending + ")" : "") + "...";
  else if (st.state === "offline") txt = "offline" + (st.pending ? " · " + st.pending + " pending" : "");
  else if (st.state === "error") txt = "sync error" + (st.pending ? " · " + st.pending + " pending" : "");
  else if (st.state === "ratelimited") txt = "rate limited" + (st.pending ? " · " + st.pending + " pending" : "");
  else if (st.pending) { cls = "pending"; txt = "pending " + st.pending; }
  else { cls = st.lastSync ? "synced" : "pending"; txt = st.lastSync ? "synced " + t : "not synced yet"; }
  el.className = "sync " + cls; $("#synctxt").textContent = txt;
  el.title = (st.error ? st.error + " - " : "") + "click to sync now";
  const b = $("#banner");
  if (engine.gh && (st.state === "error" || st.state === "ratelimited") && st.error) {
    b.style.display = "block"; b.innerHTML = esc(st.error) + ' <button data-tab="settings">Settings</button> <button data-a="sync-now">Retry</button>';
  } else b.style.display = "none";
}

// ------------------------------------------------------------------ derived state
function derive() {
  const db = engine.db;
  const lists = listsSorted(db), projects = live(db, "project").sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const tasks = tasksSorted(db), resources = live(db, "resource").sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const up = nextUp(db, null, 6);
  S = { db, lists, projects, tasks, resources, next: up[0] || null, upcoming: up, today: todayView(db), activity: engine.logEntries().slice(0, 300),
    th: handles(db.all("task")), ph: handles(db.all("project")), rh: handles(db.all("resource")) };
}
const pname = id => nameOf(S.db, "project", id) || "";
const lname = id => nameOf(S.db, "list", id) || "(no list)";

// ------------------------------------------------------------------ rendering (mirrors v2.1)
function setTab(t) { tab = t; LS.set("tab", t === "settings" ? LS.get("tab") : t); history.replaceState(null, "", "#" + t); render(); }
addEventListener("hashchange", () => { const h = location.hash.slice(1); if (TABS.includes(h)) setTab(h); });
document.addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });

function dueInfo(due, status) {
  if (!due) return null; const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due); if (!m) return { label: due, cls: "" };
  const t = dayStr(0); let label;
  if (due === t) label = "Today"; else if (due === dayStr(1)) label = "Tomorrow"; else if (due === dayStr(-1)) label = "Yesterday";
  else { const d = new Date(+m[1], +m[2] - 1, +m[3]); label = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "") + (+m[1] !== new Date().getFullYear() ? " " + m[1] : ""); }
  const cls = status === "done" ? "" : (due < t ? "over" : (due === t ? "today" : "")); return { label: (cls === "over" && label !== "Yesterday" ? "overdue · " : "") + label, cls };
}
function pill(t, o) {
  o = o || {}; let h = ""; if (t.status === "doing") h += '<span class="pill doing">doing</span>';
  const di = dueInfo(t.due, t.status); if (di) h += '<span class="pill ' + di.cls + '" title="due ' + esc(t.due) + '">' + esc(di.label) + '</span>';
  if (t.priority < 3) h += '<span class="pill p' + t.priority + '">P' + t.priority + '</span>';
  if (t.project_id && !o.noProj && pname(t.project_id)) h += '<span class="pill">' + esc(pname(t.project_id)) + '</span>';
  if (o.list) h += '<span class="pill lst">' + esc(lname(t.list_id)) + '</span>'; return h;
}
function render() {
  if (!engine) return; derive();
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  const nOver = S.today.filter(t => t.bucket !== "doing").length; $("#tcnt").innerHTML = nOver ? '<span class="cnt">' + nOver + '</span>' : "";
  $("#main").innerHTML = ({ next: rNext, today: rToday, tasks: rTasks, projects: rProjects, inventory: rInv, activity: rAct, settings: rSettings }[tab] || rNext)();
  renderStatus();
}
function rNext() {
  const n = S.next; let h = '<div class="card big">';
  if (!n) h += '<div class="next">Nothing to do &mdash; all clear.</div>' + (engine.gh ? "" : '<p class="mut">Connect your data repo in <a href="#settings">Settings</a> first.</p>');
  else {
    const pn = pname(n.project_id);
    h += '<div class="mut small">' + (n.status === "doing" ? "IN PROGRESS" : "NEXT UP") + ' &middot; ' + esc(lname(n.list_id)) + '<span class="hdl" title="handle for the CLI: bb done ' + esc(S.th[n.id]) + '">' + esc(S.th[n.id]) + '</span></div><div class="next">' + esc(n.title) + '</div>' +
      (pn ? '<div class="nextproj"><span class="lab">Project</span>' + esc(pn) + '</div>' : "") +
      '<div>' + pill(n, { noProj: true }) + '</div>' + (n.notes ? '<p class="mut pre">' + esc(n.notes) + '</p>' : "") +
      '<p><button class="pri" data-a="done" data-id="' + n.id + '">&#10003; Done</button> ' + (n.status !== "doing" ? '<button data-a="start" data-id="' + n.id + '">Start</button> ' : '<button data-a="reopen" data-id="' + n.id + '">Pause</button> ') + '<button data-a="edit-task" data-id="' + n.id + '">Edit</button></p>';
  }
  h += '</div><div class="card"><h2>After that</h2>';
  const up = S.upcoming.slice(1); h += up.length ? up.map(t => taskRow(t, { list: true, noMove: true, bigProj: true })).join("") : '<div class="empty">nothing else open</div>';
  return h + '</div>';
}
function rToday() {
  const sec = (b, title, cls) => { const ts = S.today.filter(t => t.bucket === b); if (!ts.length) return ""; return '<div class="card"><h2 class="' + (cls || "") + '">' + title + ' <span class="pill">' + ts.length + '</span></h2>' + ts.map(t => taskRow(t, { list: true, noMove: true })).join("") + '</div>'; };
  const h = sec("overdue", "Overdue", "over") + sec("today", "Due today") + sec("doing", "In progress");
  return h || '<div class="card big"><div class="next">Nothing overdue or due today.</div><p class="mut">Tasks with a due date of today (or earlier) and tasks you have started show up here.</p></div>';
}
function taskRow(t, o) {
  o = o || {}; const done = t.status === "done"; const pn = o.bigProj ? pname(t.project_id) : "";
  return '<div class="row' + (done ? " done" : "") + '"' + (o.noMove ? "" : ' draggable="true"') + ' data-tid="' + t.id + '" data-list="' + esc(t.list_id) + '">' +
    (o.noMove ? "" : '<span class="handle" title="drag to reorder / move to another list">&#8942;&#8942;</span>') + '<input type="checkbox" title="' + (done ? "reopen" : "mark done") + '" data-a="toggle" data-id="' + t.id + '"' + (done ? " checked" : "") + '>' +
    '<div class="t"><span class="tt">' + esc(t.title) + '</span>' + pill(t, { list: o.list, noProj: !!pn }) + '<span class="hdl">' + esc(S.th[t.id]) + '</span>' + (pn ? '<div class="rowproj">' + esc(pn) + '</div>' : "") + (t.notes ? '<div class="nt">' + esc(t.notes) + '</div>' : "") + '</div>' +
    (done ? '<button class="ic" data-a="reopen" data-id="' + t.id + '">&#8634; Reopen</button>' :
      (t.status === "todo" ? '<button class="ic" data-a="start" data-id="' + t.id + '" title="start">&#9654;</button>' : '<button class="ic" data-a="reopen" data-id="' + t.id + '" title="pause (back to todo)">&#10073;&#10073;</button>') +
      (o.noMove ? "" : '<button class="ic" data-a="up" data-id="' + t.id + '" title="move up">&#8593;</button><button class="ic" data-a="down" data-id="' + t.id + '" title="move down">&#8595;</button>')) +
    '<button class="ic" data-a="edit-task" data-id="' + t.id + '">edit</button><button class="ic del" data-a="del-task" data-id="' + t.id + '">&#10005;</button></div>';
}
function listSel(name, sel) {
  return '<select name="' + name + '" data-listsel data-prev="' + esc(sel || "") + '">' + S.lists.map(l => '<option value="' + esc(l.id) + '"' + (l.id === sel ? " selected" : "") + '>' + esc(l.name) + '</option>').join("") + '<option value="__new__">New list&hellip;</option></select>';
}
function projOpts(sel, exclude) { return '<option value="">(no project)</option>' + S.projects.map(p => '<option value="' + p.id + '"' + (p.id === sel ? " selected" : "") + (p.id === exclude ? " disabled" : "") + '>' + esc(p.name) + '</option>').join(""); }
function curList() { const l = LS.get("list"); return S.lists.some(x => x.id === l) ? l : (S.lists[0] ? S.lists[0].id : ""); }
function rTasks() {
  const anyDone = S.tasks.some(t => t.status === "done"); const allOn = S.lists.length && S.lists.every(l => showDone[l.id]);
  let h = '<div class="card"><form class="addf" id="addtask"><input name="title" placeholder="New task&hellip;" required autocomplete="off">' + listSel("list_id", curList()) +
    '<input type="date" name="due" title="due date (optional)">' +
    '<select name="project_id">' + projOpts(null) + '</select><select name="priority" title="priority"><option value="1">P1</option><option value="2">P2</option><option value="3" selected>P3</option><option value="4">P4</option><option value="5">P5</option></select>' +
    '<button class="pri">Add</button></form><span class="small mut">Lists are contexts (where/what), dates go in Due. </span>' +
    '<button class="ic" data-a="newlist">+ list</button> ' + (anyDone ? '<button class="ic' + (allOn ? " on" : "") + '" data-a="alldone">' + (allOn ? "Hide" : "Show") + ' done in all lists</button>' : "") + '</div>';
  if (!S.lists.length) h += '<div class="card empty">No lists yet.</div>';
  const known = new Set(S.lists.map(l => l.id));
  const orphans = S.tasks.filter(t => !known.has(t.list_id));
  const groups = S.lists.map(l => [l.id, l.name, S.tasks.filter(t => t.list_id === l.id)]);
  if (orphans.length) groups.push(["", "(no list)", orphans]);
  for (const [lid, lnm, all] of groups) {
    const open = all.filter(t => t.status !== "done"); const done = all.filter(t => t.status === "done");
    h += '<div class="card droplist" data-list="' + esc(lid) + '"><h3>' + esc(lnm) + ' <span class="pill">' + open.length + ' open</span><span class="sp"></span>' +
      (done.length ? '<button class="ic' + (showDone[lid] ? " on" : "") + '" data-a="showdone" data-list="' + esc(lid) + '">' + (showDone[lid] ? "Hide" : "Show") + ' done (' + done.length + ')</button>' : "") +
      (lid ? '<button class="ic" data-a="renlist" data-list="' + esc(lid) + '" title="rename list">&#9998;</button>' + (all.length ? "" : '<button class="ic del" data-a="dellist" data-list="' + esc(lid) + '" title="delete empty list">&#10005;</button>') : "") + '</h3>' +
      (open.map(t => taskRow(t)).join("") || '<div class="empty">' + (done.length ? "all done" : "no tasks &mdash; drop one here") + '</div>') +
      (showDone[lid] && done.length ? '<div class="donehdr">Done</div>' + done.map(t => taskRow(t)).join("") : "") + '</div>';
  }
  return h;
}
function rProjects() {
  let h = '<div class="card"><button class="pri" data-a="new-project">+ Project</button></div><div class="grid">';
  for (const p of S.projects) {
    const ts = S.tasks.filter(t => t.project_id === p.id); const open = ts.filter(t => t.status !== "done").length; const rs = S.resources.filter(r => r.project_id === p.id); const kids = S.projects.filter(c => c.parent_id === p.id);
    const par = pname(p.parent_id);
    h += '<div class="card"><h3>' + esc(p.name) + '<span class="hdl">' + esc(S.ph[p.id]) + '</span><span class="sp"></span><button class="ic" data-a="edit-project" data-id="' + p.id + '">edit</button><button class="ic del" data-a="del-project" data-id="' + p.id + '">&#10005;</button></h3><div class="kv">' +
      '<div><b>Owner:</b> ' + esc(p.owner || "-") + ' &nbsp; <b>Status:</b> ' + esc(p.status || "-") + '</div>' + (par ? '<div><b>Part of:</b> ' + esc(par) + '</div>' : "") +
      (kids.length ? '<div><b>Sub-projects:</b> ' + kids.map(k => esc(k.name)).join(", ") + '</div>' : "") +
      (p.description ? '<p>' + esc(p.description) + '</p>' : "") + (p.notes ? '<p class="mut pre">' + esc(p.notes) + '</p>' : "") +
      '<div><b>Tasks:</b> ' + open + ' open / ' + ts.length + ' &nbsp; <b>Resources:</b> ' + (rs.map(r => esc(r.name)).join(", ") || "-") + '</div></div></div>';
  }
  if (!S.projects.length) h += '<div class="card empty">No projects.</div>';
  return h + '</div>';
}
function rInv() {
  let h = '<div class="card"><button class="pri" data-a="new-resource">+ Resource</button> <span class="small mut">Never store secrets here &mdash; note where the secret lives.</span></div><div class="card"><table class="resp"><tr class="hd"><th>Name</th><th>Type</th><th>Project</th><th>Host/IP</th><th>Provider</th><th>OS</th><th>Ports</th><th>Status</th><th>Notes</th><th></th></tr>';
  for (const r of S.resources) h += '<tr><td><b>' + esc(r.name) + '</b><span class="hdl">' + esc(S.rh[r.id]) + '</span></td><td data-l="Type">' + esc(r.type) + '</td><td data-l="Project">' + esc(pname(r.project_id)) + '</td><td data-l="Host">' + esc(r.host) + '</td><td data-l="Provider">' + esc(r.provider) + '</td><td data-l="OS">' + esc(r.os) + '</td><td data-l="Ports">' + esc(r.ports) + '</td><td data-l="Status">' + esc(r.status) + '</td><td class="small" data-l="Notes">' + esc(r.notes) + '</td><td class="nowrap"><button class="ic" data-a="edit-resource" data-id="' + r.id + '">edit</button><button class="ic del" data-a="del-resource" data-id="' + r.id + '">&#10005;</button></td></tr>';
  if (!S.resources.length) h += '<tr><td colspan="10" class="empty">No resources.</td></tr>';
  return h + '</table></div>';
}
function rAct() {
  const older = engine.olderLogCount();
  return '<div class="card"><table class="act"><tr><th>When</th><th>Who</th><th>What</th></tr>' + S.activity.map(a => '<tr><td class="small mut nowrap">' + esc(new Date(a.ts).toLocaleString()) + '</td><td><span class="who">' + esc(a.by) + '</span></td><td>' + esc(a.summary || a.action) + '</td></tr>').join("") +
    (S.activity.length ? "" : '<tr><td colspan="3" class="empty">No activity yet.</td></tr>') + '</table>' +
    (older ? '<div class="more"><button data-a="older">Load older (' + older + ' more)</button></div>' : "") + '</div>';
}
function rSettings() {
  const c = cfg(), st = engine.status, rate = engine.gh && engine.gh.rate;
  return '<div class="card settings"><h2>Settings &mdash; this device only</h2>' +
    '<p class="small mut">BossBoard keeps its data in a <b>private GitHub repo</b>. Owner, repo and token are stored in this browser\'s localStorage only and the token is sent only to api.github.com.</p>' +
    '<form id="setf"><label>Data repo owner</label><input name="owner" value="' + esc(c.owner) + '" placeholder="gitcaz" autocomplete="off" autocapitalize="off" spellcheck="false">' +
    '<label>Data repo name</label><input name="repo" value="' + esc(c.repo) + '" placeholder="bossboard-data" autocomplete="off" autocapitalize="off" spellcheck="false">' +
    '<label>Branch</label><input name="branch" value="' + esc(c.branch) + '" autocomplete="off">' +
    '<label>Fine-grained token (Contents: Read and write, this repo only)</label><input name="token" type="password" value="" placeholder="' + (c.token ? "saved &mdash; leave empty to keep" : "github_pat_...") + '" autocomplete="off">' +
    '<div class="acts"><button class="pri">Save &amp; sync</button><button type="button" data-a="sync-now">Sync now</button><button type="button" class="del" data-a="forget-token">Forget token</button><button type="button" class="del" data-a="clear-cache">Clear local cache</button></div></form>' +
    (testMsg ? '<p>' + testMsg + '</p>' : "") +
    '<h3>Status</h3><div class="statgrid"><b>Connection</b><span>' + (engine.gh ? esc(c.owner + "/" + c.repo + "@" + c.branch) : '<span class="bad">not configured</span>') + '</span>' +
    '<b>State</b><span>' + esc(st.state) + (st.error ? ' &mdash; <span class="bad">' + esc(st.error) + '</span>' : "") + '</span>' +
    '<b>Pending changes</b><span>' + st.pending + '</span><b>Last sync</b><span>' + (st.lastSync ? esc(new Date(st.lastSync).toLocaleString()) : "never") + '</span>' +
    '<b>Head commit</b><span class="small">' + esc((engine.meta.head || "-").slice(0, 12)) + '</span>' +
    (rate ? '<b>API quota</b><span>' + rate.remaining + ' left' + (rate.reset ? ", resets " + esc(new Date(rate.reset).toLocaleTimeString()) : "") + '</span>' : "") +
    '<b>App</b><span>v' + VERSION + '</span></div>' +
    '<h3>Create a token</h3><ol class="small"><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com &rarr; Settings &rarr; Developer settings &rarr; Fine-grained tokens</a>.</li>' +
    '<li>Resource owner: the data repo owner. Repository access: <b>Only select repositories</b> &rarr; the data repo.</li><li>Repository permissions: <b>Contents: Read and write</b> (Metadata: read is added automatically). Nothing else.</li><li>Pick an expiry, generate, paste above. One token per device makes revoking a lost phone easy.</li></ol></div>';
}

// ------------------------------------------------------------------ dialogs
const F = {
  task: [["title", "Title"], ["list_id", "List (context)", "list"], ["due", "Due date (optional)", "date"], ["project_id", "Project", "proj"], ["priority", "Priority (1 high - 5 low)", "prio"], ["status", "Status", "status"], ["notes", "Notes", "area"]],
  project: [["name", "Name"], ["owner", "Owner / agent (user, Codex, Claude...)"], ["status", "Status"], ["parent_id", "Parent project", "proj"], ["description", "Description", "area"], ["notes", "Notes", "area"]],
  resource: [["name", "Name"], ["type", "Type (server, domain, service, api-key location...)"], ["project_id", "Project", "proj"], ["host", "Host / IP"], ["provider", "Provider"], ["os", "OS"], ["ports", "Ports"], ["status", "Status"], ["notes", "Notes (NO secrets - say where they live)", "area"]],
};
function openDlg(kind, item) {
  const d = $("#dlg"); const hd = item ? ({ task: S.th, project: S.ph, resource: S.rh }[kind][item.id]) : "";
  $("#dtitle").textContent = (item ? "Edit " : "New ") + kind + (hd ? "  (" + hd + ")" : "");
  $("#dbody").innerHTML = F[kind].map(([k, l, ty]) => {
    const v = item ? item[k] : (k === "priority" ? 3 : (k === "status" && kind === "task" ? "todo" : "")); let i;
    if (ty === "area") i = '<textarea name="' + k + '">' + esc(v) + '</textarea>';
    else if (ty === "proj") i = '<select name="' + k + '">' + projOpts(v, kind === "project" && item ? item.id : null) + '</select>';
    else if (ty === "list") i = listSel(k, item ? v : curList());
    else if (ty === "date") i = '<input type="date" name="' + k + '" value="' + esc(/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : "") + '">';
    else if (ty === "prio") i = '<select name="' + k + '">' + [1, 2, 3, 4, 5].map(n => '<option' + (n == v ? " selected" : "") + '>' + n + '</option>').join("") + '</select>';
    else if (ty === "status") i = '<select name="' + k + '">' + ["todo", "doing", "done"].map(n => '<option' + (n == v ? " selected" : "") + '>' + n + '</option>').join("") + '</select>';
    else i = '<input name="' + k + '" value="' + esc(v) + '"' + (k === "title" || k === "name" ? " required" : "") + '>';
    return '<label>' + esc(l) + '</label>' + i;
  }).join("");
  d.onclose = () => {
    if (d.returnValue !== "ok") return; const body = {}; new FormData($("#dform")).forEach((v, k) => body[k] = v);
    fixList(body);
    act(ops => item ? ops.update(kind, item.id, body) : ops.create(kind, body));
  };
  d.returnValue = ""; d.showModal();
}
function fixList(b) { if ("list_id" in b) { if (b.list_id === "__new__") delete b.list_id; else if (b.list_id.startsWith("new:")) { b.list = b.list_id.slice(4); delete b.list_id; } } }
function newListName() { const n = (prompt("New list name (a context, e.g. Home, Errands, Work, Garage):") || "").trim(); return n || null; }
async function act(fn) { try { return await engine.edit($("#who").value, fn); } catch (e) { err(e.message); } }

// ------------------------------------------------------------------ events
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-a]"); if (!b || b.tagName === "INPUT" || b.tagName === "SELECT") return; const a = b.dataset.a, id = b.dataset.id;
  const t = id && engine.db.get("task", id);
  if (a === "done" || a === "start" || a === "reopen") return act(o => o.setStatus(id, { done: "done", start: "doing", reopen: "todo" }[a]));
  if (a === "up" || a === "down") return act(o => o.move(id, a));
  if (a === "edit-task") return openDlg("task", t);
  if (a === "del-task") { if (confirm("Delete task '" + (t ? t.title : id) + "'?")) act(o => o.remove("task", id)); return; }
  if (a === "showdone") { const l = b.dataset.list; showDone[l] = !showDone[l]; LS.set("showDone", JSON.stringify(showDone)); return render(); }
  if (a === "alldone") { const on = !S.lists.every(l => showDone[l.id]); S.lists.forEach(l => showDone[l.id] = on); LS.set("showDone", JSON.stringify(showDone)); return render(); }
  if (a === "newlist") { const n = newListName(); if (n) act(o => { if (o.listByName(n)) throw new BBError("list '" + n + "' already exists"); return o.ensureList(n); }); return; }
  if (a === "renlist") { const l = engine.db.get("list", b.dataset.list); const n = (prompt("Rename list '" + l.name + "' to (an existing name merges the lists):", l.name) || "").trim(); if (n && n !== l.name) act(o => o.renameList(l.id, n)); return; }
  if (a === "dellist") { const l = engine.db.get("list", b.dataset.list); if (confirm("Delete empty list '" + l.name + "'?")) act(o => o.remove("list", l.id)); return; }
  if (a === "new-project") return openDlg("project"); if (a === "edit-project") return openDlg("project", engine.db.get("project", id));
  if (a === "del-project") { if (confirm("Delete project? Its tasks/resources stay, unlinked.")) act(o => o.remove("project", id)); return; }
  if (a === "new-resource") return openDlg("resource"); if (a === "edit-resource") return openDlg("resource", engine.db.get("resource", id));
  if (a === "del-resource") { if (confirm("Delete resource?")) act(o => o.remove("resource", id)); return; }
  if (a === "older") { try { await engine.loadOlderLog(200); } catch (x) { err(x.message); } return render(); }
  if (a === "sync-now") { authBlocked = false; blockedUntil = 0; return doSync(true); }
  if (a === "forget-token") { if (confirm("Remove the token from this device? Unsynced changes stay in the local cache.")) { LS.set("token", ""); testMsg = "Token removed from this device."; location.reload(); } return; }
  if (a === "clear-cache") {
    const n = engine.status.pending;
    if (confirm(n ? "There are " + n + " unsynced change(s) that will be LOST. Clear the local cache anyway?" : "Clear the local cache? It is re-downloaded on the next sync.")) { await engine.store.clear(); location.reload(); }
    return;
  }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.a === "toggle") act(o => o.setStatus(el.dataset.id, el.checked ? "done" : "todo"));
  if (el.hasAttribute("data-listsel")) {
    if (el.value === "__new__") {
      const n = newListName();
      if (n) { const ex = S.lists.find(x => x.name.toLowerCase() === n.toLowerCase()); let o = ex ? [...el.options].find(x => x.value === ex.id) : [...el.options].find(x => x.value === "new:" + n); if (!o) { o = new Option(n, "new:" + n); el.insertBefore(o, el.lastElementChild); } el.value = o.value; }
      else el.value = el.dataset.prev;
    }
    el.dataset.prev = el.value;
    if (el.form && el.form.id === "addtask" && !el.value.startsWith("new:")) LS.set("list", el.value);
  }
});
document.addEventListener("submit", async e => {
  if (e.target.id === "setf") {
    e.preventDefault(); const fd = new FormData(e.target); const old = cfg();
    const owner = (fd.get("owner") || "").trim(), repo = (fd.get("repo") || "").trim(), branch = (fd.get("branch") || "").trim() || "main", token = (fd.get("token") || "").trim();
    if (token && !/^(github_pat_|ghp_|gho_|ghu_|ghs_|fake_)/.test(token)) { err("That does not look like a GitHub token."); return; }
    LS.set("owner", owner); LS.set("repo", repo); LS.set("branch", branch); if (token) LS.set("token", token);
    if (old.owner !== owner || old.repo !== repo) LS.set("tab", "next");
    testMsg = ""; authBlocked = false; blockedUntil = 0;
    location.hash = configured() ? "#next" : "#settings"; location.reload(); return;
  }
  if (e.target.id !== "addtask") return; e.preventDefault(); const fd = new FormData(e.target); const b = {}; fd.forEach((v, k) => b[k] = v);
  fixList(b); if (b.list_id) LS.set("list", b.list_id);
  await act(o => o.create("task", b));
  const f = $("#addtask"); if (f) f.elements.title.focus();
});
document.addEventListener("dragstart", e => { const r = e.target.closest && e.target.closest(".row[data-tid][draggable]"); if (!r) return; dragId = r.dataset.tid; r.classList.add("drag"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
document.addEventListener("dragend", () => { dragId = null; document.querySelectorAll(".drag,.over").forEach(x => x.classList.remove("drag", "over")); });
document.addEventListener("dragover", e => { if (dragId == null) return; const c = e.target.closest(".droplist"); if (!c || !c.dataset.list) return; e.preventDefault(); document.querySelectorAll(".over").forEach(x => x.classList.remove("over")); const r = e.target.closest(".row[data-tid]"); if (r) r.classList.add("over"); });
document.addEventListener("drop", e => {
  if (dragId == null) return; const c = e.target.closest(".droplist"); if (!c || !c.dataset.list) return; e.preventDefault(); const list = c.dataset.list; const r = e.target.closest(".row[data-tid]");
  const id = dragId; dragId = null; if (r && r.dataset.tid === id) return;
  let before = null;
  if (r) { const rc = r.getBoundingClientRect(); if (e.clientY > rc.top + rc.height / 2) { const nx = r.nextElementSibling; before = nx && nx.dataset && nx.dataset.tid ? nx.dataset.tid : null; } else before = r.dataset.tid; }
  if (before === id) return;
  act(o => o.place(id, list, before));
});
function busy() {
  const a = document.activeElement; if ($("#dlg").open || dragId != null) return true; if (!a) return false;
  if (a.closest && a.closest("#setf")) return true;
  if (a.closest && a.closest("#addtask")) return [...$("#addtask").elements].some(x => x.name === "title" && x.value) || a.tagName === "SELECT" || a.type === "date";
  return (a.tagName === "INPUT" && a.type !== "checkbox" || a.tagName === "TEXTAREA") && !!a.value;
}
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
boot().catch(e => { err("startup failed: " + e.message); });
