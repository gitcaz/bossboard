# AGENTS.md - how agents use BossBoard (v3)

This repo holds the boss's tasks, projects, inventory and activity log as JSON. **Use `bb.py`** (Python 3.8+, stdlib
only) instead of hand-editing JSON: it validates, merges, writes the activity log and commits/pushes for you.

## Rules

1. **Always pass `--by <you>`** (`--by codex`, `--by claude`, ...) on every write. Every write adds a log entry with it.
2. **Never write secrets** (passwords, API keys, tokens, private keys) anywhere. For credentials record *where they live*:
   `--notes "root password: 1Password vault 'Infra', item vm1"`. `bb.py` rejects values that look like secrets.
3. Prefer updating existing items over creating duplicates: check `bb.py list --json`, `projects --json`, `resources --json`.
4. Read before you act: `bb.py next`, `bb.py today`, `bb.py log -n 20`.

## Setup

Either work in a clone of this repo (git backend, recommended; offline-safe):

```sh
git clone git@github.com:gitcaz/bossboard-data.git && cd bossboard-data
python3 bb.py next                     # auto-detects the clone it lives in (or use --dir PATH / BOSSBOARD_DIR)
```

or without a clone via the GitHub REST API (needs a fine-grained token: this repo only, Contents read/write):

```sh
export BOSSBOARD_REPO=gitcaz/bossboard-data BOSSBOARD_TOKEN=github_pat_...   # never print or commit the token
python3 bb.py next
```

Git backend: each write = fetch, apply, commit, push; if offline it commits locally and pushes on the next run
(offline commits are merged field-by-field with whatever happened remotely). REST backend: each write is one commit via
the Git Data API, retried with a fresh merge on conflict. Refuses to write if the repo's `schema_version` is newer than it knows.

## Commands (same as v2.1)

```sh
bb.py next [-n 3] [--list Home] [--json]          # what to do next (doing > overdue > due today > priority > due > order)
bb.py today [--json]                               # overdue + due today + in progress
bb.py list [--list Work] [--project Website] [--all|--status done] [--json]
bb.py lists | add-list NAME | rename-list OLD NEW | delete-list NAME
bb.py add-task "Title" [-l Home] [-p Website] [-P 1..5] [-d tomorrow|2026-11-05|fri|+3d] [-n notes] --by codex
bb.py update-task 12 [--title ..] [-l ..] [-p ..|none] [-P ..] [-d ..|none] [-n ..] [--status ..] --by codex   (alias: edit)
bb.py start 12 | done 12 13 | reopen 12 | delete-task 12 | move-task 12 up|down|top|bottom   --by codex
bb.py show task|project|resource REF [--json]
bb.py projects [--json] | add-project NAME [-d ..] [-o owner] [-s status] [-n ..] [--parent NAME] --by codex
bb.py update-project REF [...] --by codex | delete-project REF --by codex
bb.py resources [-t server] [--json] | add-resource NAME [-t ..] [-p ..] [--host ..] [--provider ..] [--os ..] [--ports ..] [-s ..] [-n ..] --by codex
bb.py update-resource REF [...] --by codex | delete-resource REF --by codex
bb.py log [-n 30] [--json]       bb.py export [-o file]       bb.py sync (git backend: push pending offline commits)
```

REF = handle (`12`, `#12`, `k3f9`), full id, or for projects/resources the name.

## If you must write JSON by hand

Follow README.md exactly: one file per item, canonical JSON (sorted keys, 2-space indent, newline), set `field_ts[f]`
to the current UTC time (`YYYY-MM-DDTHH:MM:SS.mmmZ`) for every field you change, bump `updated_at`/`updated_by`, delete by
setting `deleted: true` (never remove the file), and add a log file `log/YYYY/MM/<YYYYMMDDTHHMMSSmmmZ>-<6 random [0-9a-z]>.json`
with `ts`, `by`, `action`, `entity`, `entity_id`, `summary`, `via`. Commit with a message like `bb: <summary> (by you)`.
