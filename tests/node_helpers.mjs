import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

/** temp dir with a bare data repo seeded from data-template */
export function makeBare() {
  const tmp = mkdtempSync(path.join(tmpdir(), "bb3-"));
  const bare = path.join(tmp, "data.git"), seed = path.join(tmp, "seed");
  git(["init", "-q", "--bare", "-b", "main", bare]);
  cpSync(path.join(ROOT, "data-template"), seed, { recursive: true });
  git(["init", "-q", "-b", "main"], seed); git(["add", "-A"], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], seed);
  git(["push", "-q", bare, "main"], seed);
  return { tmp, bare };
}

export function startFake(bare, port = 0, token = "fake_token") {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [path.join(ROOT, "tests", "fake_github.py"), "--repo", bare, "--port", String(port), "--token", token], { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    p.stdout.on("data", d => { buf += d; const m = /127\.0\.0\.1:(\d+)/.exec(buf); if (m) resolve({ proc: p, api: "http://127.0.0.1:" + m[1], stop: () => p.kill() }); });
    p.on("exit", c => reject(new Error("fake exited " + c)));
  });
}

export async function fakeCtl(api, what, body) {
  const r = await fetch(api + "/_fake/" + what, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, headers: { "Content-Type": "application/json" } });
  return r.json();
}

/** run the Python CLI against the fake via the REST backend */
export function cli(api, args, cacheDir) {
  const env = { ...process.env, BOSSBOARD_REPO: "o/data", BOSSBOARD_TOKEN: "fake_token", BOSSBOARD_API: api, BOSSBOARD_CACHE: cacheDir };
  delete env.BOSSBOARD_DIR;
  return execFileSync("python3", [path.join(ROOT, "cli", "bb.py"), ...args], { env, encoding: "utf8" });
}
