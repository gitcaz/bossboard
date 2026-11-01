# BossBoard v3

Offline-first task / project / DevOps-inventory board. v3 drops the local server: the **source of truth is a private
GitHub repo of JSON files**, the UI is a **static PWA on GitHub Pages**, and agents write through a **stdlib-only Python CLI**.
Every v2.1 feature is kept (lists/contexts, tasks with priority 1-5, due date picker, notes, todo/doing/done, show-done +
reopen, project + list links, projects with parent/status/notes, inventory, Next up, Today, activity log with `--by`).
New: the project name under the Next-up title is large (21-22px, accent colour), and "After that" rows show it too.

```
app/            the PWA (index.html, css/, js/, sw.js, manifest.json, icons/) - plain ES modules, no build step
cli/bb.py       CLI for agents/terminals (Python 3.8+, stdlib only; git-clone or GitHub-REST backend)
data-template/  initial content of the private data repo: README.md (format), AGENTS.md, bb.py, bossboard.json, lists/
migrate/        migrate_v2.py: v2.1 bossboard.db -> v3 data-repo folder
tests/          unit, CLI, cross-language, end-to-end (fake GitHub on a real bare repo) and Playwright smoke tests
screenshots/    smoke-test screenshots (mobile 390x844, desktop 1280x800)
.github/workflows/pages.yml   publishes app/ to GitHub Pages (upload only, nothing is built)
```

## How it works

* **Data format** - one canonical JSON file per item (`tasks/`, `projects/`, `resources/`, `lists/`), one file per
  activity-log entry (`log/YYYY/MM/<ts>-<rand>.json`), `bossboard.json` with `schema_version: 3`. Details:
  [data-template/README.md](data-template/README.md).
* **IDs** - random 10-char Crockford base32 ids (offline-safe); short handles = old v2.1 number for migrated items,
  otherwise the shortest unique prefix (>= 4 chars). Lists are keyed by the slug of their name.
* **Merge** - every record carries `field_ts` (per-field timestamps). Two versions merge per field, last writer wins;
  deletes are tombstones. Commutative + idempotent, identical in JS and Python (tested byte-for-byte).
* **Web sync** - IndexedDB cache + outbox (dirty files) + service worker for the shell. Syncs on load, on reconnect,
  when the tab becomes visible, every 60 s and 1.5 s after an edit. Each sync = pull changed blobs, merge into local edits,
  then **one commit** via the Git Data API (create tree -> create commit -> update ref with `force:false`). A rejected
  (non-fast-forward, 422) update refetches, merges and retries with backoff. Status chip: synced / pending N / syncing /
  offline / rate limited / sync error; error banner for bad tokens (sync pauses until you fix it) and rate limits
  (waits until the reset time).
* **Token** - entered in Settings, stored in `localStorage` on that device only, sent only to `https://api.github.com`
  (the API base cannot be changed to anything except localhost test servers). "Forget token" and "Clear local cache" buttons.
* **CLI** - same commands as v2.1 (see [data-template/AGENTS.md](data-template/AGENTS.md)); every write takes `--by` and
  adds a log entry. Backends: a local git clone (offline commits are merged field-by-field on the next run) or GitHub REST
  (`BOSSBOARD_REPO` + `BOSSBOARD_TOKEN`/`GITHUB_TOKEN`).

## Run locally / tests

```sh
python3 -m http.server 8000 --directory app          # open http://localhost:8000 (Settings needs a repo + token)
tests/run_all.sh                                      # all suites; SKIP_SMOKE=1 to skip the browser test
BOSSBOARD_TOKEN=... node tests/live.playwright.mjs    # read-only check of the deployed app against real GitHub
python3 tests/fake_github.py --repo /tmp/data.git --port 8787   # fake GitHub on a bare repo, for manual tries
```

To point the app at the fake: in the browser console `localStorage.setItem("bb3.apiBase","http://127.0.0.1:8787")`, then
use owner `o`, repo `data`, token `fake_token` in Settings.

## Deploy (needs GitHub credentials)

Planned names: private data repo `gitcaz/bossboard-data`, public code repo `gitcaz/bossboard`.

1. **Create the private data repo** (empty, no README): `gh repo create gitcaz/bossboard-data --private`
2. **Fill it** - either fresh from the template or migrated from v2.1:
   ```sh
   # fresh
   cp -r data-template /tmp/bossboard-data && cd /tmp/bossboard-data
   git init -b main && git add -A && git commit -m "BossBoard data v3"
   # or migrated (on the machine that has the v2.1 bossboard.db)
   python3 migrate/migrate_v2.py --db /path/to/bossboard.db --out /tmp/bossboard-data --git && cd /tmp/bossboard-data
   # then
   git remote add origin git@github.com:gitcaz/bossboard-data.git && git push -u origin main
   ```
3. **Create the public code repo** and push this folder: `gh repo create gitcaz/bossboard --public`, then
   `git init -b main && git add -A && git commit -m "BossBoard v3" && git remote add origin git@github.com:gitcaz/bossboard.git && git push -u origin main`.
   It contains code only, never data.
4. **Enable Pages**: gitcaz/bossboard -> Settings -> Pages -> Source: **GitHub Actions**. The included workflow publishes
   `app/` on every push to main. App URL: `https://gitcaz.github.io/bossboard/`. (Alternative without Actions: put the
   contents of `app/` at the repo root and use "Deploy from a branch: main / (root)" - Pages cannot serve `/app` directly.)
5. **Per device token**: github.com -> Settings -> Developer settings -> Fine-grained tokens -> Generate:
   resource owner `gitcaz`, repository access *Only select repositories* -> `gitcaz/bossboard-data`, permissions
   *Contents: Read and write* (Metadata read is automatic), pick an expiry. On the phone/desktop open the app, Settings:
   owner `gitcaz`, repo `bossboard-data`, branch `main`, paste the token, *Save & sync*. Install to home screen.
   (If the org/user requires approval for fine-grained tokens, approve it.)
6. **Agents**: clone `gitcaz/bossboard-data` and run `python3 bb.py ...` inside it (uses the clone's git credentials), or
   set `BOSSBOARD_REPO=gitcaz/bossboard-data` and `BOSSBOARD_TOKEN=<a fine-grained token as above>`. Point them at AGENTS.md.
7. Retire v2.1 once the migrated data looks right (keep `bossboard.db` as a backup).

## Limitations / open decisions

* LWW uses device clocks; a device with a badly wrong clock can win or lose edits it should not.
* Tombstones are never garbage-collected; deleted items stay in the repo (small JSON files).
* Trees over GitHub's recursive-listing limit (~100k entries / 7 MB) are reported as an error, not paged.
* The REST CLI backend has no offline outbox (it fails when offline); the git backend does.
* Logs: the app downloads the newest 200 entries (+ everything newer); "Load older" fetches more.
* Rename of a list that another device renamed concurrently: last rename wins (normal LWW on `name`).
* A 401/403 pauses automatic sync until the token is fixed or "Sync now" is pressed; rate limits wait for the reset time.
* Networks whose DNS returns one shared (fake) IP for every host (some VPNs / transparent proxies) can make Chrome
  reuse the github.io HTTP/2 connection for api.github.com; the CORS preflight then fails (chip: "can't reach GitHub").
  Normal DNS is unaffected. A custom domain for Pages would avoid it.
* One GitHub API commit per sync = roughly 3 + changed-file reads per sync; well inside the 5000 req/h limit.
