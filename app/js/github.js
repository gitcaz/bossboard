// Minimal GitHub REST client (Git Data API) for the data repo. The token is only ever sent to the API base,
// which is https://api.github.com unless a localhost test server is configured.
export const DEFAULT_API = "https://api.github.com";

export class GHError extends Error {
  constructor(kind, message, status, extra) { super(message); this.kind = kind; this.status = status || 0; Object.assign(this, extra || {}); }
}

export function safeApiBase(base) {
  if (!base) return DEFAULT_API;
  try {
    const u = new URL(base);
    if (u.origin === DEFAULT_API) return DEFAULT_API;
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return u.origin;  // test fakes only
  } catch (e) { /* fallthrough */ }
  return DEFAULT_API;
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class GitHub {
  constructor({ owner, repo, token, branch, apiBase, fetchImpl }) {
    this.owner = owner; this.repo = repo; this.token = token; this.branch = branch || "main";
    this.base = safeApiBase(apiBase); this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.rate = null;
  }
  get repoPath() { return "/repos/" + encodeURIComponent(this.owner) + "/" + encodeURIComponent(this.repo); }
  async req(method, path, body, opts) {
    opts = opts || {};
    const headers = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Authorization": "Bearer " + this.token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let r;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeout || 30000) : null;
    try {
      r = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: opts.cache || "no-store", signal: ctl ? ctl.signal : undefined });
    } catch (e) {
      const to = e && e.name === "AbortError";
      throw new GHError("network", to ? "network: no answer from api.github.com in " + ((opts.timeout || 30000) / 1000) + " s"
        : "network/CORS error: the request to api.github.com failed before GitHub answered (offline, firewall, proxy, browser extension or CORS)", 0);
    } finally { if (timer) clearTimeout(timer); }
    const rem = r.headers.get("x-ratelimit-remaining"), reset = r.headers.get("x-ratelimit-reset");
    if (rem != null) this.rate = { remaining: +rem, reset: reset ? +reset * 1000 : null };
    if (r.ok) return r.status === 204 ? null : r.json();
    let msg = ""; try { msg = (await r.json()).message || ""; } catch (e) { /* ignore */ }
    const ra = r.headers.get("retry-after");
    if (r.status === 429 || (r.status === 403 && (rem === "0" || ra || /rate limit/i.test(msg)))) {
      const until = ra ? Date.now() + (+ra) * 1000 : (reset ? +reset * 1000 : Date.now() + 60000);
      throw new GHError("ratelimit", "GitHub rate limit reached; retrying after " + new Date(until).toLocaleTimeString(), r.status, { until });
    }
    const repo = this.owner + "/" + this.repo, gm = msg ? " (GitHub: " + msg + ")" : "";
    const need = r.headers.get("x-accepted-github-permissions");
    if (r.status === 401) throw new GHError("auth", "401 bad token: GitHub rejected it (expired, revoked or mistyped)" + gm + " - paste a new one in Settings", 401);
    if (r.status === 403) throw new GHError("auth", "403 missing permission on " + repo + (need ? ": needs " + need : ": the token needs Contents: Read and write") + gm, 403);
    if (r.status === 404) throw new GHError("notfound", "404 not found: " + repo + (path.includes("/git/ref") ? " branch '" + this.branch + "'" : "") + " does not exist or this token has no access to it (fine-grained token must include this repo)" + gm, 404);
    if (r.status === 409) throw new GHError("empty", "409 the data repo " + repo + " is empty - push data-template first" + gm, 409);
    if (r.status === 422) throw new GHError("conflict", "422 " + (msg || "update is not a fast forward"), 422);
    throw new GHError("server", r.status + " GitHub error" + (msg ? ": " + msg : ""), r.status);
  }
  async repoInfo() { return this.req("GET", this.repoPath); }
  async headSha() { const j = await this.req("GET", this.repoPath + "/git/ref/heads/" + encodeURIComponent(this.branch)); return j.object.sha; }
  async commit(sha) { return this.req("GET", this.repoPath + "/git/commits/" + sha, undefined, { cache: "force-cache" }); }
  async tree(sha) { return this.req("GET", this.repoPath + "/git/trees/" + sha + "?recursive=1", undefined, { cache: "force-cache" }); }
  async blobText(sha) { const j = await this.req("GET", this.repoPath + "/git/blobs/" + sha, undefined, { cache: "force-cache" }); return b64ToText(j.content); }
  async createTree(baseTree, entries) { return this.req("POST", this.repoPath + "/git/trees", { base_tree: baseTree, tree: entries }); }
  async createCommit(message, tree, parents) { return this.req("POST", this.repoPath + "/git/commits", { message, tree, parents }); }
  async updateRef(sha) { return this.req("PATCH", this.repoPath + "/git/refs/heads/" + encodeURIComponent(this.branch), { sha, force: false }); }
}
