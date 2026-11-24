// BossBoard v3 web UI (vanilla ES modules, no build step).
import { Engine } from "./sync.js";
import { GitHub, safeApiBase } from "./github.js";
import { IDBStore } from "./store.js";
import { live, listsSorted, tasksSorted, nextUp, todayView, nameOf, handles, dayStr, BBError } from "./core.js";

const VERSION = "3.1.0";
const DEFAULTS = { owner: "gitcaz", repo: "bossboard-data", branch: "main" };  // empty fields fall back to these
const $ = s => document.querySelector(s);
const LS = {
  get: k => localStorage.getItem("bb3." + k) || "",
  set: (k, v) => v ? localStorage.setItem("bb3." + k, v) : localStorage.removeItem("bb3." + k),
};
const TABS = ["next", "today", "tasks", "projects", "inventory", "activity", "settings"];
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : (LS.get("tab") || "next");
let showDone = JSON.parse(LS.get("showDone") || "{}"), dragId = null, engine = null, S = null;
let groupTasks = LS.get("groupTasks") !== "0";                 // default ON
let projMode = LS.get("projMode") === "list" ? "list" : "tree";
let collapsed = {};
try { collapsed = JSON.parse(LS.get("collapsed") || "{}") || {}; } catch (e) { collapsed = {}; }
let blockedUntil = 0, authBlocked = false, syncTimer = null, testMsg = "";

$("#who").value = LS.get("who") || "user";
$("#who").onchange = e => LS.set("who", e.target.value);
if (LS.get("theme")) document.documentElement.dataset.theme = LS.get("theme");
$("#theme").onclick = () => { const d = document.documentElement; const dark = d.dataset.theme ? d.dataset.theme === "dark" : matchMedia("(prefers-color-scheme:dark)").matches; d.dataset.theme = dark ? "light" : "dark"; LS.set("theme", d.dataset.theme); };

function esc(s) { return s == null ? "" : String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function err(m) { const e = $("#err"); e.textContent = m; e.style.display = "block"; clearTimeout(err.t); err.t = setTimeout(() => e.style.display = "none", 6000); }
function cleanToken(t) { return (t || "").replace(/^\s*(bearer|token)\s+/i, "").replace(/\s+/g, ""); }  // pasted with spaces/newlines/prefix
function fineToken(t) { t = cleanToken(t); return /^github_pat_/.test(t) ? t : ""; }  // classic ghp_ tokens are refused
function cfg() { return { owner: LS.get("owner") || DEFAULTS.owner, repo: LS.get("repo") || DEFAULTS.repo, branch: LS.get("branch") || DEFAULTS.branch, token: fineToken(LS.get("token")), apiBase: safeApiBase(LS.get("apiBase")) }; }
function showBanner(msg, withButtons) { const b = $("#banner"); b.style.display = "block"; b.innerHTML = esc(msg) + (withButtons ? ' <button data-tab="settings">Settings</button> <button data-a="sync-now">Retry</button>' : ""); }
function configured() { const c = cfg(); return !!(c.owner && c.repo && c.token); }

// ------------------------------------------------------------------ engine
async function boot() {
  if (window.__bbFramed || window.top !== window.self) {
    window.__bbReady = true;
    document.body.innerHTML = '<main style="padding:2rem;max-width:36rem;margin:10vh auto;font:16px/1.5 system-ui,sans-serif"><h1>BossBoard (by Grok)</h1><p>This app cannot run inside another site. Open it at its own address.</p></main>';
    return;
  }
  const c = cfg(), connecting = LS.get("connect") === "1"; LS.set("connect", "");
  const key = "bossboard3:" + (c.owner && c.repo ? c.owner + "/" + c.repo : "_local");
  engine = new Engine({ store: new IDBStore(key), gh: configured() ? new GitHub(c) : null, via: "web", onChange: onEngine });
  if (connecting && engine.gh) engine._set("syncing", { connecting: true });
  await engine.init();
  window.__bbReady = true;
  if (!configured() && tab !== "settings") tab = "settings";
  render(); doSync(connecting);
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
    else if (e.kind === "network") { if (navigator.onLine) scheduleSync(30000); /* else wait for 'online' */ }
    else scheduleSync(30000);
    if (!e.kind) { engine._set("error", { error: "sync failed: " + (e.message || e) }); }   // unexpected bug: never silent
  }
  renderStatus(); if (!busy()) render();
}
addEventListener("online", () => doSync());
addEventListener("offline", () => { if (engine) { engine._set("offline", { error: null }); renderStatus(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) doSync(); });
setInterval(() => { if (!document.hidden) doSync(); }, 60000);
$("#sync").onclick = () => { if (!configured()) return setTab("settings"); if (engine.status.state === "error") { authBlocked = false; } doSync(true); };

function renderStatus() {
  if (!engine) return;
  const st = engine.status, el = $("#sync"); let txt, cls = st.state;
  const t = st.lastSync ? new Date(st.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (!engine.gh) { cls = "unconfigured"; txt = "not connected"; }
  else if (st.state === "syncing") txt = (!st.lastSync ? "connecting" : "syncing") + (st.pending ? " (" + st.pending + ")" : "") + "...";
  else if (st.state === "offline") txt = (st.error ? "can't reach GitHub" : "offline") + (st.pending ? " · " + st.pending + " pending" : "");
  else if (st.state === "error") txt = "sync error" + (st.pending ? " · " + st.pending + " pending" : "");
  else if (st.state === "ratelimited") txt = "rate limited" + (st.pending ? " · " + st.pending + " pending" : "");
  else if (st.pending) { cls = "pending"; txt = "pending " + st.pending; }
  else { cls = st.lastSync ? "synced" : "pending"; txt = st.lastSync ? "synced " + t : "not synced yet"; }
  el.className = "sync " + cls; $("#synctxt").textContent = txt;
  el.title = (st.error ? st.error + " - " : "") + "click to sync now";
  const b = $("#banner");
  if (engine.gh && ["error", "ratelimited", "offline"].includes(st.state) && st.error) showBanner(st.error, true);
  else if (b.dataset.sticky !== "1") b.style.display = "none";
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
      '<p><button class="pri" data-a="done" data-id="' + esc(n.id) + '">&#10003; Done</button> ' + (n.status !== "doing" ? '<button data-a="start" data-id="' + esc(n.id) + '">Start</button> ' : '<button data-a="reopen" data-id="' + esc(n.id) + '">Pause</button> ') + '<button data-a="edit-task" data-id="' + esc(n.id) + '">Edit</button></p>';
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
  return '<div class="row' + (done ? " done" : "") + '"' + (o.noMove ? "" : ' draggable="true"') + ' data-tid="' + esc(t.id) + '" data-list="' + esc(t.list_id) + '">' +
    (o.noMove ? "" : '<span class="handle" title="drag to reorder / move to another list">&#8942;&#8942;</span>') + '<input type="checkbox" title="' + (done ? "reopen" : "mark done") + '" data-a="toggle" data-id="' + esc(t.id) + '"' + (done ? " checked" : "") + '>' +
    '<div class="t"><span class="tt">' + esc(t.title) + '</span>' + pill(t, { list: o.list, noProj: o.noProj || !!pn }) + '<span class="hdl">' + esc(S.th[t.id]) + '</span>' + (pn ? '<div class="rowproj">' + esc(pn) + '</div>' : "") + (t.notes ? '<div class="nt">' + esc(t.notes) + '</div>' : "") + '</div>' +
    (done ? '<button class="ic" data-a="reopen" data-id="' + esc(t.id) + '">&#8634; Reopen</button>' :
      (t.status === "todo" ? '<button class="ic" data-a="start" data-id="' + esc(t.id) + '" title="start">&#9654;</button>' : '<button class="ic" data-a="reopen" data-id="' + esc(t.id) + '" title="pause (back to todo)">&#10073;&#10073;</button>') +
      (o.noMove ? "" : '<button class="ic" data-a="up" data-id="' + esc(t.id) + '" title="move up">&#8593;</button><button class="ic" data-a="down" data-id="' + esc(t.id) + '" title="move down">&#8595;</button>')) +
    '<button class="ic" data-a="edit-task" data-id="' + esc(t.id) + '">edit</button><button class="ic del" data-a="del-task" data-id="' + esc(t.id) + '">&#10005;</button></div>';
}
function listSel(name, sel) {
  return '<select name="' + name + '" data-listsel data-prev="' + esc(sel || "") + '">' + S.lists.map(l => '<option value="' + esc(l.id) + '"' + (l.id === sel ? " selected" : "") + '>' + esc(l.name) + '</option>').join("") + '<option value="__new__">New list&hellip;</option></select>';
}
function projOpts(sel, exclude) { return '<option value="">(no project)</option>' + S.projects.map(p => '<option value="' + esc(p.id) + '"' + (p.id === sel ? " selected" : "") + (p.id === exclude ? " disabled" : "") + '>' + esc(p.name) + '</option>').join(""); }
function curList() { const l = LS.get("list"); return S.lists.some(x => x.id === l) ? l : (S.lists[0] ? S.lists[0].id : ""); }

function saveCollapsed() { const j = JSON.stringify(collapsed); LS.set("collapsed", j === "{}" ? "" : j); }
function isCol(k) { return !!collapsed[k]; }
function flipCol(k) { if (collapsed[k]) delete collapsed[k]; else collapsed[k] = 1; saveCollapsed(); render(); }
function setCols(keys, on) { keys.forEach(k => { if (on) collapsed[k] = 1; else delete collapsed[k]; }); saveCollapsed(); render(); }
function childrenOf(pid) {
  return S.projects.filter(p => (p.parent_id || null) === (pid || null))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : 1));
}
function ancestorsOf(id) {
  const out = []; let cur = id, seen = new Set();
  while (cur && !seen.has(cur)) { seen.add(cur); const p = S.projects.find(x => x.id === cur); if (!p) break; out.unshift(p); cur = p.parent_id; }
  return out;
}
function treeOf(idSet) {
  const needed = new Set();
  idSet.forEach(id => ancestorsOf(id).forEach(p => needed.add(p.id)));
  function node(id) { return { id, project: S.projects.find(p => p.id === id), children: childrenOf(id).filter(c => needed.has(c.id)).map(c => node(c.id)) }; }
  return S.projects.filter(p => needed.has(p.id) && !needed.has(p.parent_id))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.id < b.id ? -1 : 1))
    .map(p => node(p.id));
}
function tasksFor(pid, list) { return list.filter(t => t.project_id === pid); }
function walkCount(n, list, pred) { return tasksFor(n.id, list).filter(pred).length + n.children.reduce((s, c) => s + walkCount(c, list, pred), 0); }
function collectTreeKeys(n, prefix) { return [prefix + n.id].concat(n.children.flatMap(c => collectTreeKeys(c, prefix))); }
function gHead(key, title, pills, extra) {
  const c = isCol(key);
  const btn = '<button type="button" class="ghead" data-a="toggle-group" data-k="' + esc(key) + '" aria-expanded="' + (!c) + '">' +
    '<span class="chev" aria-hidden="true">' + (c ? "\u25b8" : "\u25be") + '</span><span class="gtitle">' + esc(title) + '</span>' +
    (pills || "") + '</button>';
  return extra ? '<div class="gheadrow">' + btn + extra + '</div>' : btn;
}
function countPills(open, total) {
  return '<span class="pill">' + open + ' open' + (total > open ? " / " + total : "") + '</span>';
}
function taskGroupsFor(lid, all) {
  const assigned = new Set(), none = [];
  for (const t of all) { if (t.project_id && pname(t.project_id)) assigned.add(t.project_id); else none.push(t); }
  return { roots: treeOf(assigned), none };
}
function listGroups() {
  const known = new Set(S.lists.map(l => l.id));
  const groups = S.lists.map(l => [l.id, l.name, S.tasks.filter(t => t.list_id === l.id)]);
  const orphans = S.tasks.filter(t => !known.has(t.list_id));
  if (orphans.length) groups.push(["", "(no list)", orphans]);
  return groups;
}
function allGroupKeys(scope) {
  if (scope === "tasks") {
    const keys = [];
    for (const [lid, , all] of listGroups()) {
      const { roots, none } = taskGroupsFor(lid, all);
      roots.forEach(n => collectTreeKeys(n, "t:" + lid + ":").forEach(k => keys.push(k)));
      if (none.length) keys.push("t:" + lid + ":_none");
    }
    return keys;
  }
  if (projMode === "tree") return S.projects.map(p => "p:" + p.id);
  const keys = [], seen = new Set();
  for (const l of S.lists) {
    const ids = new Set(S.tasks.filter(t => t.list_id === l.id && t.project_id && pname(t.project_id)).map(t => t.project_id));
    if (!ids.size) continue;
    keys.push("pl:" + l.id);
    treeOf(ids).forEach(n => collectTreeKeys(n, "pl:" + l.id + ":").forEach(k => keys.push(k)));
    ids.forEach(id => ancestorsOf(id).forEach(p => seen.add(p.id)));
  }
  const unused = S.projects.filter(p => !seen.has(p.id));
  if (unused.length) { keys.push("pl:_none"); treeOf(new Set(unused.map(p => p.id))).forEach(n => collectTreeKeys(n, "pl:_none:").forEach(k => keys.push(k))); }
  return keys;
}

function rTasks() {
  const anyDone = S.tasks.some(t => t.status === "done"); const allOn = S.lists.length && S.lists.every(l => showDone[l.id]);
  let h = '<div class="card"><form class="addf" id="addtask"><input name="title" placeholder="New task&hellip;" required autocomplete="off">' + listSel("list_id", curList()) +
    '<input type="date" name="due" title="due date (optional)">' +
    '<select name="project_id">' + projOpts(null) + '</select><select name="priority" title="priority"><option value="1">P1</option><option value="2">P2</option><option value="3" selected>P3</option><option value="4">P4</option><option value="5">P5</option></select>' +
    '<button class="pri">Add</button></form><span class="small mut">Lists are contexts (where/what), dates go in Due. </span>' +
    '<button class="ic" data-a="newlist">+ list</button> ' + (anyDone ? '<button class="ic' + (allOn ? " on" : "") + '" data-a="alldone">' + (allOn ? "Hide" : "Show") + ' done in all lists</button>' : "") +
    '<div class="viewbar"><button type="button" class="ic' + (groupTasks ? " on" : "") + '" data-a="toggle-group-tasks">' + (groupTasks ? "Grouped by project" : "Group by project") + '</button>' +
    (groupTasks ? '<button type="button" class="ic" data-a="expand-all" data-scope="tasks">Expand all</button><button type="button" class="ic" data-a="collapse-all" data-scope="tasks">Collapse all</button>' : "") + '</div></div>';
  if (!S.lists.length) h += '<div class="card empty">No lists yet.</div>';
  const groups = listGroups();
  function taskBranch(n, lid, all, showD) {
    const key = "t:" + lid + ":" + n.id, openN = walkCount(n, all, t => t.status !== "done"), tot = walkCount(n, all, () => true);
    const mine = tasksFor(n.id, all), open = mine.filter(t => t.status !== "done"), done = mine.filter(t => t.status === "done");
    let body = open.map(t => taskRow(t, { noProj: true })).join("");
    if (showD && done.length) body += '<div class="donehdr">Done</div>' + done.map(t => taskRow(t, { noProj: true })).join("");
    body += n.children.map(c => taskBranch(c, lid, all, showD)).join("");
    if (!body) body = '<div class="empty">' + (done.length ? "all done" : "no tasks") + '</div>';
    return '<div class="pgroup">' + gHead(key, n.project.name, countPills(openN, tot)) + (isCol(key) ? "" : '<div class="gbody">' + body + '</div>') + '</div>';
  }
  for (const [lid, lnm, all] of groups) {
    const open = all.filter(t => t.status !== "done"); const done = all.filter(t => t.status === "done");
    h += '<div class="card droplist" data-list="' + esc(lid) + '"><h3>' + esc(lnm) + ' <span class="pill">' + open.length + ' open</span><span class="sp"></span>' +
      (done.length ? '<button class="ic' + (showDone[lid] ? " on" : "") + '" data-a="showdone" data-list="' + esc(lid) + '">' + (showDone[lid] ? "Hide" : "Show") + ' done (' + done.length + ')</button>' : "") +
      (lid ? '<button class="ic" data-a="renlist" data-list="' + esc(lid) + '" title="rename list">&#9998;</button>' + (all.length ? "" : '<button class="ic del" data-a="dellist" data-list="' + esc(lid) + '" title="delete empty list">&#10005;</button>') : "") + '</h3>';
    if (!groupTasks) {
      h += (open.map(t => taskRow(t)).join("") || '<div class="empty">' + (done.length ? "all done" : "no tasks &mdash; drop one here") + '</div>') +
        (showDone[lid] && done.length ? '<div class="donehdr">Done</div>' + done.map(t => taskRow(t)).join("") : "");
    } else {
      const { roots, none } = taskGroupsFor(lid, all), showD = !!showDone[lid];
      let body = roots.map(n => taskBranch(n, lid, all, showD)).join("");
      if (none.length) {
        const nOpen = none.filter(t => t.status !== "done"), nDone = none.filter(t => t.status === "done"), key = "t:" + lid + ":_none";
        let nb = nOpen.map(t => taskRow(t)).join("");
        if (showD && nDone.length) nb += '<div class="donehdr">Done</div>' + nDone.map(t => taskRow(t)).join("");
        if (!nb) nb = '<div class="empty">' + (nDone.length ? "all done" : "no tasks") + '</div>';
        body += '<div class="pgroup">' + gHead(key, "No project", countPills(nOpen.length, none.length)) + (isCol(key) ? "" : '<div class="gbody">' + nb + '</div>') + '</div>';
      }
      h += body || ('<div class="empty">' + (done.length ? "all done" : "no tasks &mdash; drop one here") + '</div>');
    }
    h += '</div>';
  }
  return h;
}
function projectBody(p, o) {
  o = o || {};
  const ts = S.tasks.filter(t => t.project_id === p.id && (!o.listId || t.list_id === o.listId));
  const open = ts.filter(t => t.status !== "done").length;
  const rs = S.resources.filter(r => r.project_id === p.id);
  const kids = o.kids || childrenOf(p.id);
  const par = o.hideParent ? "" : pname(p.parent_id);
  return '<div class="kv"><div><b>Owner:</b> ' + esc(p.owner || "-") + ' &nbsp; <b>Status:</b> ' + esc(p.status || "-") + '</div>' +
    (par ? '<div><b>Part of:</b> ' + esc(par) + '</div>' : "") +
    (kids.length ? '<div><b>Sub-projects:</b> ' + kids.map(k => esc(k.project ? k.project.name : k.name)).join(", ") + '</div>' : "") +
    (p.description ? '<p>' + esc(p.description) + '</p>' : "") + (p.notes ? '<p class="mut pre">' + esc(p.notes) + '</p>' : "") +
    '<div><b>Tasks:</b> ' + open + ' open / ' + ts.length + (o.listId ? " in this list" : "") + ' &nbsp; <b>Resources:</b> ' + (rs.map(r => esc(r.name)).join(", ") || "-") + '</div></div>';
}
function projectHead(p, key, o) {
  const ts = o.tasks || S.tasks.filter(t => t.project_id === p.id);
  const open = ts.filter(t => t.status !== "done").length;
  const kids = o.kids || [];
  const actions = '<span class="sp"></span><button class="ic" data-a="edit-project" data-id="' + esc(p.id) + '">edit</button><button class="ic del" data-a="del-project" data-id="' + esc(p.id) + '">&#10005;</button>';
  return gHead(key, p.name, countPills(open, ts.length) + (kids.length ? '<span class="pill">' + kids.length + ' sub</span>' : "") + '<span class="hdl">' + esc(S.ph[p.id]) + '</span>', actions);
}
function descTasks(n, listId) {
  return S.tasks.filter(t => t.project_id === n.id && (!listId || t.list_id === listId)).concat(n.children.flatMap(c => descTasks(c, listId)));
}
function renderProjBranch(n, keyPrefix, o) {
  o = o || {};
  const key = keyPrefix + n.id, kids = n.children, ts = descTasks(n, o.listId);
  return '<div class="pgroup">' + projectHead(n.project, key, { tasks: ts, kids: kids }) +
    (isCol(key) ? "" : '<div class="gbody"><div class="card">' + projectBody(n.project, { hideParent: true, listId: o.listId, kids: kids }) + '</div>' + kids.map(c => renderProjBranch(c, keyPrefix, o)).join("") + '</div>') +
    '</div>';
}
function rProjects() {
  let h = '<div class="card"><button class="pri" data-a="new-project">+ Project</button>' +
    '<div class="viewbar"><button type="button" class="ic' + (projMode === "tree" ? " on" : "") + '" data-a="proj-mode" data-m="tree">By hierarchy</button>' +
    '<button type="button" class="ic' + (projMode === "list" ? " on" : "") + '" data-a="proj-mode" data-m="list">By list</button>' +
    '<button type="button" class="ic" data-a="expand-all" data-scope="proj">Expand all</button>' +
    '<button type="button" class="ic" data-a="collapse-all" data-scope="proj">Collapse all</button></div></div>';
  if (!S.projects.length) return h + '<div class="card empty">No projects.</div>';
  if (projMode === "tree") {
    const roots = treeOf(new Set(S.projects.map(p => p.id)));
    return h + '<div class="ptree">' + roots.map(n => renderProjBranch(n, "p:", {})).join("") + '</div>';
  }
  const seen = new Set();
  for (const l of S.lists) {
    const ids = new Set(S.tasks.filter(t => t.list_id === l.id && t.project_id && pname(t.project_id)).map(t => t.project_id));
    if (!ids.size) continue;
    ids.forEach(id => ancestorsOf(id).forEach(p => seen.add(p.id)));
    const roots = treeOf(ids), key = "pl:" + l.id;
    const open = S.tasks.filter(t => t.list_id === l.id && t.project_id && ids.has(t.project_id) && t.status !== "done").length;
    const tot = S.tasks.filter(t => t.list_id === l.id && t.project_id && ids.has(t.project_id)).length;
    h += '<div class="card"><h3>' + gHead(key, l.name, countPills(open, tot) + '<span class="pill">' + ids.size + ' project' + (ids.size === 1 ? "" : "s") + '</span>') + '</h3>' +
      (isCol(key) ? "" : '<div class="gbody">' + roots.map(n => renderProjBranch(n, "pl:" + l.id + ":", { listId: l.id })).join("") + '</div>') + '</div>';
  }
  const unused = S.projects.filter(p => !seen.has(p.id));
  if (unused.length) {
    const key = "pl:_none", roots = treeOf(new Set(unused.map(p => p.id)));
    h += '<div class="card"><h3>' + gHead(key, "No tasks", '<span class="pill">' + unused.length + ' project' + (unused.length === 1 ? "" : "s") + '</span>') + '</h3>' +
      (isCol(key) ? "" : '<div class="gbody">' + roots.map(n => renderProjBranch(n, "pl:_none:", {})).join("") + '</div>') + '</div>';
  }
  if (!seen.size && !unused.length) h += '<div class="card empty">No projects.</div>';
  return h;
}
function rInv() {
  let h = '<div class="card"><button class="pri" data-a="new-resource">+ Resource</button> <span class="small mut">Never store secrets here &mdash; note where the secret lives.</span></div><div class="card"><table class="resp"><tr class="hd"><th>Name</th><th>Type</th><th>Project</th><th>Host/IP</th><th>Provider</th><th>OS</th><th>Ports</th><th>Status</th><th>Notes</th><th></th></tr>';
  for (const r of S.resources) h += '<tr><td><b>' + esc(r.name) + '</b><span class="hdl">' + esc(S.rh[r.id]) + '</span></td><td data-l="Type">' + esc(r.type) + '</td><td data-l="Project">' + esc(pname(r.project_id)) + '</td><td data-l="Host">' + esc(r.host) + '</td><td data-l="Provider">' + esc(r.provider) + '</td><td data-l="OS">' + esc(r.os) + '</td><td data-l="Ports">' + esc(r.ports) + '</td><td data-l="Status">' + esc(r.status) + '</td><td class="small" data-l="Notes">' + esc(r.notes) + '</td><td class="nowrap"><button class="ic" data-a="edit-resource" data-id="' + esc(r.id) + '">edit</button><button class="ic del" data-a="del-resource" data-id="' + esc(r.id) + '">&#10005;</button></td></tr>';
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
    '<div class="acts"><button class="pri">Save &amp; sync</button><button type="button" data-a="test-conn">Test connection</button><button type="button" data-a="sync-now">Sync now</button><button type="button" class="del" data-a="forget-token">Forget token</button><button type="button" class="del" data-a="clear-cache">Clear local cache</button></div></form>' +
    '<div id="setmsg" class="setmsg">' + (testMsg ? esc(testMsg) : "") + '</div><ol id="testout" class="testout small"></ol>' +
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
  if (a === "toggle-group-tasks") { groupTasks = !groupTasks; LS.set("groupTasks", groupTasks ? "1" : "0"); return render(); }
  if (a === "proj-mode") { projMode = b.dataset.m === "list" ? "list" : "tree"; LS.set("projMode", projMode); return render(); }
  if (a === "toggle-group") { flipCol(b.dataset.k); return; }
  if (a === "expand-all" || a === "collapse-all") { setCols(allGroupKeys(b.dataset.scope), a === "collapse-all"); return; }
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
  if (a === "test-conn") return testConnection();
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
    const owner = (fd.get("owner") || "").trim() || DEFAULTS.owner, repo = (fd.get("repo") || "").trim() || DEFAULTS.repo,
      branch = (fd.get("branch") || "").trim() || DEFAULTS.branch, token = cleanToken(fd.get("token"));
    const say = m => { const el = $("#setmsg"); if (el) { el.textContent = m; el.classList.add("bad"); } err(m); };
    if (!token && !fineToken(LS.get("token"))) { say("Missing: Fine-grained token. Paste it into the token field, then Save & sync."); $("input[name=token]").focus(); return; }
    if (token && /^gh[pousr]_/.test(token)) { say("Classic personal access tokens (ghp_...) are not accepted. Create a fine-grained token (it starts with github_pat_) with Contents: Read and write on the data repo only."); return; }
    if (token && !/^github_pat_/.test(token)) { say("That does not look like a fine-grained GitHub token (it should start with github_pat_)."); return; }
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) { say("Owner / repo name contains invalid characters."); return; }
    LS.set("owner", owner); LS.set("repo", repo); LS.set("branch", branch); if (token) LS.set("token", token);
    LS.set("connect", "1");
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
async function testConnection() {
  const f = $("#setf"), out = $("#testout"); if (!f || !out) return;
  const fd = new FormData(f), c = cfg();
  const o = (fd.get("owner") || "").trim() || DEFAULTS.owner, r = (fd.get("repo") || "").trim() || DEFAULTS.repo, br = (fd.get("branch") || "").trim() || DEFAULTS.branch;
  const tok = cleanToken(fd.get("token")) || c.token;
  out.innerHTML = ""; $("#setmsg").textContent = "Testing " + o + "/" + r + "@" + br + " ...";
  const line = (ok, m) => { const li = document.createElement("li"); li.className = ok ? "ok" : "bad"; li.textContent = (ok ? "\u2713 " : "\u2717 ") + m; out.appendChild(li); return ok; };
  if (!tok) { line(false, "no token: paste a fine-grained token (github_pat_...) into the token field"); $("#setmsg").textContent = "Test failed."; return; }
  if (!/^github_pat_/.test(tok)) { line(false, "classic or unknown token: only fine-grained tokens (github_pat_...) are accepted"); $("#setmsg").textContent = "Test failed."; return; }
  line(true, "token present (" + tok.length + " chars, starts with " + tok.slice(0, 11) + "...)" + (/^github_pat_/.test(tok) ? "" : " - not a fine-grained token"));
  const gh = new GitHub({ owner: o, repo: r, branch: br, token: tok, apiBase: c.apiBase });
  try {
    const info = await gh.repoInfo();
    line(true, "1. repo " + info.full_name + " found (" + (info.private ? "private" : "PUBLIC!") + ", default branch " + info.default_branch + ")");
    const p = info.permissions || {};
    if (!line(!!p.push, "2. write access: " + (p.push ? "yes" : "NO - the token needs Contents: Read and write"))) throw null;
    const head = await gh.headSha(); line(true, "3. branch " + br + " at " + head.slice(0, 10));
    const cm = await gh.commit(head); line(true, "4. last commit: " + (cm.message || "").split("\n")[0].slice(0, 60));
    const tr = await gh.tree(cm.tree.sha); const files = (tr.tree || []).filter(x => x.type === "blob");
    const hasSchema = files.some(x => x.path === "bossboard.json");
    if (!line(hasSchema, "5. data: " + files.length + " files" + (hasSchema ? ", bossboard.json present" : ", bossboard.json MISSING - is this the data repo?"))) throw null;
    const saved = c.owner === o && c.repo === r && c.branch === br && (!cleanToken(fd.get("token")) || cleanToken(fd.get("token")) === c.token) && c.token;
    $("#setmsg").textContent = "Connection OK." + (saved ? "" : " Press Save & sync to use these settings.");
  } catch (x) {
    if (x) line(false, x.message || String(x));
    $("#setmsg").textContent = "Test failed - see the red line above.";
  }
}
function busy() {
  const a = document.activeElement; if ($("#dlg").open || dragId != null) return true; if (!a) return false;
  if (a.closest && a.closest("#setf")) return true;
  if (a.closest && a.closest("#addtask")) return [...$("#addtask").elements].some(x => x.name === "title" && x.value) || a.tagName === "SELECT" || a.type === "date";
  return (a.tagName === "INPUT" && a.type !== "checkbox" || a.tagName === "TEXTAREA") && !!a.value;
}
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
boot().catch(e => { window.__bbReady = true; const m = "BossBoard failed to start: " + (e && e.message || e); err(m); if (window.bbShowError) window.bbShowError(m); else showBanner(m); });
