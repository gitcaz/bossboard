// Playwright smoke test (mobile + desktop) against the fake GitHub. No build step, uses system Chrome.
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROME=/usr/bin/google-chrome node tests/smoke.playwright.mjs
// Screenshots -> screenshots/. Exits non-zero on any failed check, page error or CSP violation.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { ROOT, git, startFake, cli } from "./node_helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "/tmp/pw/node_modules/playwright-core");
const CHROME = process.env.CHROME || "/usr/bin/google-chrome";
const SHOTS = path.join(ROOT, "screenshots");
const V2 = "/workspace/bossboard/bossboard.py";
let failures = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) failures++; };
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---------------------------------------------------------------- data: v2.1 sample db -> migrate -> bare repo
const tmp = mkdtempSync(path.join(tmpdir(), "bb3-smoke-"));
const bare = path.join(tmp, "data.git"), out = path.join(tmp, "data"), cache = path.join(tmp, "cache");
const v2 = (...a) => execFileSync("python3", [V2, ...a], { env: { ...process.env, BOSSBOARD_DB: path.join(tmp, "v2.db") }, stdio: "ignore" });
execFileSync("python3", [path.join(ROOT, "tests", "v2_fixture.py"), path.join(tmp, "v2.db")], { env: { ...process.env, BOSSBOARD_V2: V2 }, stdio: "inherit" });
v2("add-task", "Configure API gateway on vm1", "-l", "Work", "-p", "Gateway", "-P", "1", "-d", "today", "--by", "claude");
v2("add-task", "Write chatbot onboarding notes", "-l", "Work", "-p", "Chatbot", "-P", "2", "-d", "tomorrow", "--by", "codex");
v2("add-task", "Renew domain", "-l", "Errands", "-p", "Website", "-d", "2026-10-30", "--by", "boss");
v2("add-task", "Buy light bulbs", "-l", "Errands", "--by", "boss");
v2("done", "1", "--by", "boss");
v2("add-resource", "example.org", "-t", "domain", "-p", "Website", "--provider", "Example Registrar", "-s", "active", "--by", "boss");
execFileSync("python3", [path.join(ROOT, "migrate", "migrate_v2.py"), "--db", path.join(tmp, "v2.db"), "--out", out, "--git"], { stdio: "ignore" });
git(["init", "-q", "--bare", "-b", "main", bare]); git(["push", "-q", bare, "main"], out);

const TOK = "github_pat_fake_token";
const fake = await startFake(bare, 0, TOK);
const webPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(webPort), "--bind", "127.0.0.1", "--directory", path.join(ROOT, "app")], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
cli(fake.api, ["start", "7", "--by", "claude"], cache, TOK);  // task #7 in progress -> Next up
const APP = "http://127.0.0.1:" + webPort + "/";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const TABS = ["next", "today", "tasks", "projects", "inventory", "activity", "settings"];
try {
  for (const vp of [{ name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
                    { name: "desktop", viewport: { width: 1280, height: 800 } }]) {
    console.log("== " + vp.name);
    const ctx = await browser.newContext({ viewport: vp.viewport, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1, serviceWorkers: "allow" });
    const errors = [];
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push("pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(m.text())) errors.push("console: " + m.text()); if (/Content Security Policy/i.test(m.text())) errors.push("csp: " + m.text()); });
    page.on("dialog", d => d.accept(d.type() === "prompt" ? "Garage" : undefined));
    // first run: unconfigured -> settings
    await page.goto(APP);
    await page.waitForSelector("#setf");
    check(await page.locator("#synctxt").innerText() === "not connected", "unconfigured app opens Settings, chip says 'not connected'");
    await page.evaluate(api => localStorage.setItem("bb3.apiBase", api), fake.api);  // test-only: point at the fake
    check(await page.inputValue("input[name=owner]") === "gitcaz" && await page.inputValue("input[name=repo]") === "bossboard-data" && await page.inputValue("input[name=branch]") === "main", "owner/repo/branch prefilled as real values");
    await page.click("#setf button.pri"); await page.waitForTimeout(300);
    check(/Missing: Fine-grained token/.test(await page.locator("#setmsg").innerText()), "Save without token -> inline 'Missing: Fine-grained token'");
    await page.fill("input[name=token]", "ghp_" + "A".repeat(36));
    await page.click("#setf button.pri"); await page.waitForTimeout(300);
    check(/Classic personal access tokens/.test(await page.locator("#setmsg").innerText()), "classic ghp_ token is refused");
    await page.fill("input[name=owner]", "o"); await page.fill("input[name=repo]", "data"); await page.fill("input[name=token]", TOK);
    await page.selectOption("#who", "boss");
    await Promise.all([page.waitForNavigation(), page.click("#setf button.pri")]);
    await page.waitForFunction(() => document.querySelector("#sync").classList.contains("synced"), null, { timeout: 15000 });
    check(true, "Save & sync -> chip 'synced'");
    check(await page.evaluate(t => localStorage.getItem("bb3.token") === t, TOK), "token stored in this device's localStorage");
    const nextTitle = await page.locator(".card.big .next").innerText();
    check(nextTitle.includes("Configure API gateway"), "Next up shows the in-progress task: " + nextTitle);
    const projSize = await page.evaluate(() => { const e = document.querySelector(".nextproj"); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; });
    const titleSize = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".card.big .next")).fontSize));
    check(projSize >= 20, "Next up project name is big (" + projSize + "px, title " + titleSize + "px)");
    check((await page.locator(".nextproj").innerText()).includes("Gateway"), "Next up shows the project name");
    check(await page.locator(".rowproj").count() > 0, "'After that' rows show project names");
    check((await page.title()) === "BossBoard (by Grok)", "document title is BossBoard (by Grok)");
    check(/BossBoard\s*\(by Grok\)/.test(await page.locator("header h1").textContent()), "header title is BossBoard (by Grok)");
    const rendered = [];
    for (const t of TABS) {
      await page.evaluate(t => { location.hash = "#" + t; }, t);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, vp.name + "-" + t + ".png"), fullPage: true });
      rendered.push((await page.locator("#main .card").count()) > 0);
    }
    check(rendered.every(Boolean), "all " + TABS.length + " tabs render (screenshots saved)");
    await page.evaluate(() => { location.hash = "#tasks"; });
    await page.waitForSelector("#addtask");
    // show done + reopen exists
    const sd = page.locator('[data-a=showdone]').first();
    if (await sd.count()) { await sd.click(); check(await page.locator(".row.done [data-a=reopen]").count() > 0, "Show done reveals done tasks with Reopen"); }

    // ---- v3.1 grouping
    await page.evaluate(() => { location.hash = "#tasks"; });
    await page.waitForSelector("#addtask");
    check(await page.locator(".ghead").count() > 0, "Tasks view groups by project tree by default");
    const work = page.locator(".droplist").filter({ hasText: "Work" }).first();
    check(await work.locator(".ghead", { hasText: "Website" }).count() > 0, "Work list has a Website group");
    check(await work.locator(".ghead", { hasText: "Gateway" }).count() > 0, "Gateway appears in the Work tree");
    check(await work.locator(".ghead", { hasText: "Chatbot" }).count() > 0, "Chatbot appears in the Work tree");
    const nested2 = await work.evaluate(el => {
      const title = e => (e.querySelector(".gtitle") || e).textContent.trim();
      const w = [...el.querySelectorAll(".ghead")].find(e => title(e) === "Website");
      if (!w) return false;
      const heads = [...w.closest(".pgroup").querySelectorAll(".gbody .ghead")].map(title);
      return heads.includes("Gateway") && heads.includes("Chatbot");
    });
    check(nested2, "Gateway and Chatbot are nested under Website in Work");
    check(await page.locator(".droplist").filter({ hasText: "Errands" }).locator(".ghead", { hasText: "No project" }).count() > 0, "Errands has a No project group");
    check(await work.locator(".ghead", { hasText: "Website" }).innerText().then(t => /\d+ open/.test(t)), "group headers show open counts");
    await work.locator(".ghead", { hasText: "Website" }).click();
    check(await work.locator("text=Configure API gateway").count() === 0, "collapsing Website hides descendant tasks");
    check(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("bb3.collapsed") || "{}")).some(k => k.startsWith("t:"))), "collapsed project group remembered in localStorage");
    await page.click('[data-a="expand-all"][data-scope="tasks"]');
    check(await work.locator("text=Configure API gateway").count() > 0, "Expand all reveals descendant tasks again");
    await page.click('[data-a="collapse-all"][data-scope="tasks"]');
    check(await work.locator("text=Configure API gateway").count() === 0, "Collapse all hides grouped tasks");
    await page.click('[data-a="expand-all"][data-scope="tasks"]');
    await page.click('[data-a="toggle-group-tasks"]');
    check(await page.locator(".droplist .ghead").count() === 0, "Group by project can be turned off (flat list)");
    check(await page.locator("text=Configure API gateway").count() > 0, "flat list still shows tasks");
    check(await page.evaluate(() => localStorage.getItem("bb3.groupTasks") === "0"), "grouping-off pref stored");
    await page.click('[data-a="toggle-group-tasks"]');
    check(await page.locator(".droplist .ghead").count() > 0, "grouping can be turned back on");
    const dupBtn = page.locator(".row", { hasText: "Sort the mail" }).first().locator('[data-a="dup-task"]');
    check(await dupBtn.getAttribute("aria-label") === "Duplicate", "Duplicate button has aria-label");
    const before = await page.locator(".row", { hasText: "Sort the mail" }).count();
    await dupBtn.click();
    await page.waitForFunction(n => document.querySelectorAll('.row').length && [...document.querySelectorAll('.row')].filter(r => r.innerText.includes("Sort the mail")).length > n, before, { timeout: 8000 });
    check(await page.locator(".row", { hasText: "Sort the mail" }).count() === before + 1, "Duplicate adds a second task with the same title");
    check(await page.locator(".row.flash", { hasText: "Sort the mail" }).count() === 1, "new copy is briefly highlighted");
    const order = await page.evaluate(() => [...document.querySelectorAll(".droplist")].filter(el => el.querySelector("h3") && el.querySelector("h3").textContent.includes("Home")).flatMap(el => [...el.querySelectorAll(".row")].filter(r => r.innerText.includes("Sort the mail")).map(r => r.className)));
    check(order.length >= 2 && /flash/.test(order[1]), "copy is placed immediately after the original");
    await page.screenshot({ path: path.join(SHOTS, vp.name + "-tasks-grouped.png"), fullPage: true });

    await page.evaluate(() => { location.hash = "#projects"; });
    await page.waitForTimeout(250);
    check(await page.locator('[data-a="proj-mode"][data-m="tree"].on').count() > 0, "Projects view defaults to By hierarchy");
    const treeNest = await page.evaluate(() => {
      const title = e => (e.querySelector(".gtitle") || e).textContent.trim();
      const w = [...document.querySelectorAll(".ptree .ghead")].find(e => title(e) === "Website");
      if (!w) return false;
      const heads = [...w.closest(".pgroup").querySelectorAll(".gbody .ghead")].map(title);
      return heads.includes("Gateway") && heads.includes("Chatbot");
    });
    check(treeNest, "Projects hierarchy nests Chatbot and Gateway under Website");
    await page.screenshot({ path: path.join(SHOTS, vp.name + "-projects-tree.png"), fullPage: true });
    await page.click('[data-a="proj-mode"][data-m="list"]');
    check(await page.evaluate(() => localStorage.getItem("bb3.projMode") === "list"), "By list pref stored");
    check(await page.locator(".ghead", { hasText: "Work" }).count() > 0, "By list groups projects under Work");
    check(await page.locator(".ghead", { hasText: "Errands" }).count() > 0, "By list groups projects under Errands");
    await page.screenshot({ path: path.join(SHOTS, vp.name + "-projects-list.png"), fullPage: true });
    await page.click('[data-a="proj-mode"][data-m="tree"]');  // restore default for later shots
    await page.evaluate(() => { location.hash = "#tasks"; });
    await page.waitForSelector("#addtask");

    if (vp.name === "mobile") {
      // offline: add a task, see pending, back online -> synced and in the repo
      await ctx.setOffline(true);
      await page.waitForTimeout(300);
      await page.fill("#addtask input[name=title]", "Offline task from phone");
      await page.selectOption("#addtask select[name=priority]", "1");
      await page.click("#addtask button.pri");
      await page.waitForTimeout(2200);  // edit -> scheduled sync after 1.5s fails offline
      const txt = await page.locator("#synctxt").innerText();
      check(/pending/.test(txt), "offline edit shows pending: '" + txt + "'");
      await page.evaluate(() => { location.hash = "#next"; });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SHOTS, "mobile-offline-pending.png"), fullPage: true });
      // reload while offline: service worker serves the shell, IndexedDB keeps the outbox
      await page.reload(); await page.waitForSelector("#main .card");
      check(/pending/.test(await page.locator("#synctxt").innerText()), "offline reload works (service worker + IndexedDB outbox)");
      await ctx.setOffline(false);
      await page.evaluate(() => dispatchEvent(new Event("online")));
      await page.waitForFunction(() => document.querySelector("#sync").classList.contains("synced"), null, { timeout: 15000 });
      check(true, "back online -> synced");
      const repo = JSON.parse(cli(fake.api, ["list", "--json"], cache, TOK));
      const t = repo.find(x => x.title === "Offline task from phone");
      check(t && t.priority === 1, "offline task reached the data repo");
      const log = JSON.parse(cli(fake.api, ["log", "-n", "3", "--json"], cache, TOK));
      check(log.some(e => e.by === "boss" && e.via === "web"), "web edit logged with by=boss via=web");
      // agent writes via CLI -> phone sees it after a sync
      cli(fake.api, ["add", "Agent added this", "-l", "Home", "-p", "Website", "--by", "codex"], cache, TOK);
      await page.click("#sync");
      await page.waitForTimeout(800);
      await page.evaluate(() => { location.hash = "#tasks"; });
      check(await page.locator("text=Agent added this").count() > 0, "CLI write appears in the app after sync");
      await page.screenshot({ path: path.join(SHOTS, "mobile-tasks-after-sync.png"), fullPage: true });
      // complete via Next up Done button
      await page.evaluate(() => { location.hash = "#next"; });
      await page.click(".card.big [data-a=done]");
      await page.waitForTimeout(300);
      check(!(await page.locator(".card.big .next").innerText()).includes("Configure API gateway"), "Done on Next up advances to the next task");
    } else {
      // dialog + bad token banner
      await page.locator("[data-a=edit-task]").first().click();
      await page.waitForSelector("#dlg[open]");
      await page.screenshot({ path: path.join(SHOTS, "desktop-edit-dialog.png") });
      await page.click("#dform button[value=cancel]");
      await page.evaluate(() => localStorage.setItem("bb3.token", "github_pat_wrong"));
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#sync").classList.contains("error"), null, { timeout: 15000 });
      check(/401 bad token/.test(await page.locator("#banner").innerText()), "bad token -> error banner with Settings link");
      await page.screenshot({ path: path.join(SHOTS, "desktop-bad-token.png") });
      await page.evaluate(t => localStorage.setItem("bb3.token", t), TOK);
    }
    check(errors.length === 0, "no page errors / CSP violations" + (errors.length ? ": " + errors.join(" | ") : ""));
    await ctx.close();
  }
} finally {
  await browser.close(); web.kill(); fake.stop();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? failures + " check(s) FAILED" : "all smoke checks passed; screenshots in " + SHOTS);
process.exit(failures ? 1 : 0);
