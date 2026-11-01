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

const fake = await startFake(bare);
const webPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(webPort), "--bind", "127.0.0.1", "--directory", path.join(ROOT, "app")], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 700));
cli(fake.api, ["start", "7", "--by", "claude"], cache);  // task #7 in progress -> Next up
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
    await page.fill("input[name=owner]", "o"); await page.fill("input[name=repo]", "data"); await page.fill("input[name=token]", "fake_token");
    await page.selectOption("#who", "boss");
    await Promise.all([page.waitForNavigation(), page.click("#setf button.pri")]);
    await page.waitForFunction(() => document.querySelector("#sync").classList.contains("synced"), null, { timeout: 15000 });
    check(true, "Save & sync -> chip 'synced'");
    check(await page.evaluate(() => localStorage.getItem("bb3.token")) === "fake_token", "token stored in this device's localStorage");
    const nextTitle = await page.locator(".card.big .next").innerText();
    check(nextTitle.includes("Configure API gateway"), "Next up shows the in-progress task: " + nextTitle);
    const projSize = await page.evaluate(() => { const e = document.querySelector(".nextproj"); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; });
    const titleSize = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".card.big .next")).fontSize));
    check(projSize >= 20, "Next up project name is big (" + projSize + "px, title " + titleSize + "px)");
    check((await page.locator(".nextproj").innerText()).includes("Gateway"), "Next up shows the project name");
    check(await page.locator(".rowproj").count() > 0, "'After that' rows show project names");
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
      const repo = JSON.parse(cli(fake.api, ["list", "--json"], cache));
      const t = repo.find(x => x.title === "Offline task from phone");
      check(t && t.priority === 1, "offline task reached the data repo");
      const log = JSON.parse(cli(fake.api, ["log", "-n", "3", "--json"], cache));
      check(log.some(e => e.by === "boss" && e.via === "web"), "web edit logged with by=boss via=web");
      // agent writes via CLI -> phone sees it after a sync
      cli(fake.api, ["add", "Agent added this", "-l", "Home", "-p", "Website", "--by", "codex"], cache);
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
      await page.evaluate(() => localStorage.setItem("bb3.token", "fake_wrong"));
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#sync").classList.contains("error"), null, { timeout: 15000 });
      check(/token rejected/.test(await page.locator("#banner").innerText()), "bad token -> error banner with Settings link");
      await page.screenshot({ path: path.join(SHOTS, "desktop-bad-token.png") });
      await page.evaluate(() => localStorage.setItem("bb3.token", "fake_token"));
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
