# BossBoard data (v3)

This private repo is the **source of truth** for BossBoard: tasks, projects, inventory (resources), context lists and the
activity log. The web app (GitHub Pages PWA) and agents (`bb.py`) read and write it; git history is the backup.

**No secrets in here, ever.** Inventory records say *where* a credential lives ("1Password: vm1 root"), never the value.
`bb.py` and the app refuse values that look like keys or tokens.

## Layout

```
bossboard.json                 schema marker: {"schema_version": 3, ...}
lists/<slug>.json              context lists (Home, Errands, Work, Before leaving, ...); id = slug of the name
tasks/<id>.json                one file per task
projects/<id>.json             one file per project
resources/<id>.json            one file per inventory item (servers, domains, services, where-a-key-lives)
log/YYYY/MM/<ts>-<rand>.json   one file per change (activity log), e.g. log/2026/11/20261101T191900123Z-k3f9qa.json
bb.py                          agent/terminal CLI (Python 3.8+, stdlib only) - see AGENTS.md
```

Every JSON file is written canonically (sorted keys, 2-space indent, trailing newline) so diffs stay small.

## IDs and handles

New items get a random 10-character Crockford base32 id (`k3f9qa2mzd`, first char always a letter), so any device can
create items offline without collisions. People and agents use short **handles**: items migrated from v2.1 keep their old
number (`legacy_id`, so `#12` / `12` still works); new items are addressed by the shortest unique id prefix (min. 4 chars,
e.g. `k3f9`). Projects and resources can also be addressed by name. Lists use the slug of their name as id
(`lists/before-leaving.json`), so two devices creating the same list offline converge on one file.

## Record format

Common fields: `id`, `kind` (task|project|resource|list), `created_at`, `created_by`, `updated_at`, `updated_by`,
`deleted` (tombstone, false/true), optional `legacy_id`, and `field_ts` - a map field -> UTC timestamp of its last change.

| kind | fields |
|---|---|
| task | `title`, `list_id`, `project_id`, `priority` (1 highest..5), `status` (todo/doing/done), `due` (YYYY-MM-DD or null), `notes`, `sort_order` (number), `completed_at` |
| project | `name`, `description`, `owner`, `status`, `notes`, `parent_id` |
| resource | `name`, `type`, `project_id`, `host`, `provider`, `os`, `ports`, `status`, `notes` |
| list | `name`, `sort_order` |

Timestamps are UTC ISO 8601 with milliseconds (`2026-11-01T19:19:00.123Z`), fixed width so string order is time order.

Log entry: `{"ts", "by", "action" (create/update/start/done/reopen/delete/reorder/rename), "entity", "entity_id",
"legacy_id"?, "summary", "via" (web/cli/v2.1), "details"?}`. `by` is who made the change (user, boss, codex, claude, ...).

## Merge rules (how concurrent/offline edits combine)

Two versions of the same file merge **per field, last writer wins by `field_ts`** (ties broken deterministically by
value), so editing the title on the phone and the priority from an agent keeps both. Deletes are tombstones
(`deleted: true` is just another field), so a delete and an edit made offline resolve by time too. `created_*` comes from
the older version, `updated_*` from the newer. Log files are unique per change and never conflict. The merge is
commutative and idempotent, so every client converges. Writers commit with a compare-and-swap ref update; on a race they
refetch, merge and retry.

Deleted items stay as tombstones (nothing is garbage-collected yet). Deleting a project leaves tasks/resources pointing at it;
they show as "no project".
