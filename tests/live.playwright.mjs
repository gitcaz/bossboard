// Read-only check of the deployed app against real GitHub (mobile viewport). Never prints the token.
//   BOSSBOARD_TOKEN=... LIVE_URL=https://gitcaz.github.io/bossboard/ LIVE_REPO=gitcaz/bossboard-data node tests/live.playwright.mjs
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./node_helpers.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "/tmp/pw/node_modules/playwright-core");
const URL_ = process.env.LIVE_URL || "https://gitcaz.github.io/bossboard/";
const [OWNER, REPO] = (process.env.LIVE_REPO || "gitcaz/bossboard-data").split("/");
const TOKEN = process.env.BOSSBOARD_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("set BOSSBOARD_TOKEN"); process.exit(2); }
const SHOTS = path.join(ROOT, "screenshots");
mkdirSync(SHOTS, { recursive: true });
let fails = 0;
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails++; };
const appHost = new URL(URL_).host;
const profile = mkdtempSync(path.join(tmpdir(), "bb-live-profile-"));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME || "/usr/bin/google-chrome", // On networks whose DNS hands out ONE (fake) IP for every host - like this test box's egress proxy - Chrome
  // coalesces HTTP/2 connections: the Pages cert also covers *.github.com, so api.github.com requests ride the
  // github.io connection and Pages' CDN answers the CORS preflight with 405. HTTP/1.1 never coalesces.
  // Real DNS gives api.github.com and *.github.io different IPs, so real devices are unaffected. LIVE_HTTP2=1 to keep h2.
  args: ["--no-sandbox"].concat(process.env.LIVE_HTTP2 ? [] : ["--disable-http2"]),
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "allow" });
const errors = [], authHosts = new Set(), hosts = new Set();
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" || /Content Security Policy/i.test(m.text())) errors.push("console: " + m.text().replaceAll(TOKEN, "***")); });
  const netlog = [];
  const cdp = await ctx.newCDPSession(page); await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", e => { if (/api\.github\.com/.test(e.response.url)) netlog.push(e.type + " " + e.response.status + " " + e.response.url.replace(/^https:\/\/api\.github\.com/, "").slice(0, 70) + " acao=" + (e.response.headers["access-control-allow-origin"] || "-")); });
  cdp.on("Network.requestWillBeSentExtraInfo", e => { const h = e.headers || {}; if (h["Access-Control-Request-Method"] || h["access-control-request-method"]) netlog.push("preflight-req " + JSON.stringify(Object.fromEntries(Object.entries(h).filter(([k]) => !/authorization|cookie/i.test(k))))); });
  cdp.on("Network.responseReceivedExtraInfo", e => { if (e.statusCode === 405) netlog.push("405-resp " + JSON.stringify(e.headers).slice(0, 600)); });
  cdp.on("Network.loadingFailed", e => netlog.push("FAILED " + e.type + " " + e.errorText + (e.corsErrorStatus ? " " + JSON.stringify(e.corsErrorStatus) : "")));
  ctx.on("request", r => { const u = new URL(r.url()); hosts.add(u.host); if (r.headers()["authorization"]) authHosts.add(u.host); });
  const resp = await page.goto(URL_);
  check(resp.status() === 200, "live page HTTP " + resp.status());
  await page.waitForSelector("#setf");
  check(await page.locator("#synctxt").innerText() === "not connected", "fresh profile -> Settings, 'not connected'");
  await page.fill("input[name=owner]", OWNER); await page.fill("input[name=repo]", REPO);
  await page.fill("input[name=branch]", "main"); await page.fill("input[name=token]", TOKEN);
  check(await page.getAttribute("input[name=token]", "type") === "password", "token input is masked (type=password)");
  await Promise.all([page.waitForNavigation(), page.click("#setf button.pri")]);
  await page.waitForFunction(() => document.querySelector("#sync").classList.contains("synced"), null, { timeout: 45000 })
    .then(() => check(true, "Save & sync -> chip 'synced' (" + OWNER + "/" + REPO + ")"),
          async () => { check(false, "chip never reached synced: " + await page.locator("#synctxt").innerText()); console.log("    network:\n      " + netlog.join("\n      ")); });
  check(await page.evaluate(() => !!navigator.serviceWorker.controller) || (await page.reload(), await page.evaluate(() => !!navigator.serviceWorker.controller)),
        "service worker controls the page");
  await page.evaluate(() => { location.hash = "#next"; }); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, "live-mobile-next.png"), fullPage: true });
  await page.evaluate(() => { location.hash = "#settings"; }); await page.waitForSelector("#setf");
  check(await page.inputValue("input[name=token]") === "", "token field is empty in Settings (screenshot safe)");
  const txt = await page.evaluate(() => document.body.innerText);
  check(!txt.includes(TOKEN), "token not rendered anywhere in the page");
  await page.screenshot({ path: path.join(SHOTS, "live-mobile-settings.png"), fullPage: true });
  check([...authHosts].every(h => h === "api.github.com") && authHosts.has("api.github.com"),
        "Authorization header sent only to api.github.com (hosts with auth: " + [...authHosts].join(",") + ")");
  check([...hosts].every(h => h === appHost || h === "api.github.com"), "no third-party requests (" + [...hosts].join(",") + ")");
  // offline reload from the service worker cache + IndexedDB
  await ctx.setOffline(true); await page.reload(); await page.waitForSelector("#main");
  await page.waitForFunction(() => !/syncing/.test(document.querySelector("#synctxt").textContent), null, { timeout: 20000 }).catch(() => {});
  check(/offline|reach GitHub/.test(await page.locator("#synctxt").innerText()), "offline reload works from cache: '" + await page.locator("#synctxt").innerText() + "'");
  await ctx.setOffline(false);
  const real = errors.filter(e => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e));  // expected while offline
  check(real.length === 0, "no page errors / CSP violations" + (real.length ? ": " + real.join(" | ").slice(0, 300) : ""));
  // leave nothing behind: forget token + clear cache, then the profile dir is deleted below
  page.on("dialog", d => d.accept());
  await page.evaluate(() => { location.hash = "#settings"; }); await page.waitForSelector("#setf");
  await page.click("button[data-a=forget-token]"); await page.waitForTimeout(300);
  await page.click("button[data-a=clear-cache]").catch(() => {}); await page.waitForTimeout(500);
  check(await page.evaluate(() => !localStorage.getItem("bb3.token")), "token removed from localStorage");
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
  console.log("browser profile deleted");
}
console.log(fails ? fails + " check(s) FAILED" : "all live checks passed");
process.exit(fails ? 1 : 0);
