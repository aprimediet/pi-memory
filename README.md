# @aprimediet/memory

Persistent, self-managing memory for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Remembers durable facts, decisions, and progress across sessions — per **project** and **globally** — decides on its own what is worth saving, restores context at session start, and prunes stale memory. Inspired by claude-mem, but deliberately **process-per-call** (no resident worker/daemon).

## Install

Run a single command — `pi` will fetch the package from npm and wire it into your project's `.pi/settings.json` for you:

```bash
pi install npm:@aprimediet/memory
```

## Configuration

Config resolves **per-project `~/.pi/projects/<id>/memory.json` → global default `~/.pi/agent/memory.json` → bundled default → env → flags**, re-read on every access. The bundled default is seeded to the global default path on first run. (Per-project config lives in the global dir too — nothing but the marker is written to your working tree.)

```json
{
  "enabled": true,
  "model": "claude-haiku-4-5",
  "capture": "both",
  "injection": { "scope": "both", "digestMaxEntries": 20 },
  "pruning": { "ttlDays": 90, "maxEntries": 200, "consolidateEverySessions": 10 },
  "useFtsIndex": false
}
```

- Flags: `--memory-model <pattern>`, `--memory-disabled`, `--memory-capture <tool|background|both>`.
- Env: `MEMORY_MODEL`, `MEMORY_DISABLED=1`.
- `capture`: `tool` (manual only), `background` (distiller only), `both`.
- `useFtsIndex`: enable SQLite FTS search (requires the optional `better-sqlite3` dependency; falls back to file keyword scan when absent).

## Storage model — clean working tree

The only thing written into your working tree is a single identifier file, `<cwd>/.pi/<project-id>.md`. **Every** memory artifact (entries, index, thoughts, db, config) lives globally, keyed by that project id:

```
<cwd>/.pi/<project-id>.md            ← the ONLY artifact in your working tree (a pointer)

~/.pi/projects/<project-id>/          ← everything else, global
  project.json                        metadata: id, name, paths seen, created, lastSeen
  memory/
    entries/*.md                      durable memory (source of truth, human-editable)
    MEMORY.md                         generated index/digest
  thoughts/<date>-<session>.md        per-session journals written by the distiller
  queue/                              pending distillation jobs
  memory.db                           optional SQLite FTS index (rebuildable)
  memory.json                         optional per-project config override

~/.pi/projects/_global/               cross-project ("global" scope) memory, same shape
```

The project id is `<dir-slug>-<8charPathHash>`, recorded in the marker — so it is stable, and if you move the directory the marker keeps memory attached to the same project. Markdown files are the source of truth; `MEMORY.md` and `memory.db` are rebuildable accelerators.

## What it does
- **Intelligent capture (both modes).** The `memory_write` tool lets the agent save facts deliberately; a **background distiller** reads each session's transcript at the end and decides what durable knowledge to keep, deduping against tool-written entries.
- **No forgetting across sessions.** At session start a compact digest of prior memory is injected as hidden context. The `memory_search` tool recalls more on demand (and bumps usage so recalled entries survive pruning).
- **Visible timeline at the very start.** The moment pi loads (in the TUI), a claude-mem-style **memory timeline** for the project appears as a banner above the editor — before you type anything — with entries grouped by day (Today / Yesterday / date), each showing a time, type icon, and title, plus project/global counts. It clears once you start working; reshow it anytime with `/memory timeline`.
- **Self-cleaning.** A cheap heuristic sweep runs every session (TTL on unused entries, supersede resolution, LRU cap); a periodic background model pass consolidates and removes stale or contradicted entries.
- **Independent & configurable.** All background intelligence runs as a separate `pi` subprocess whose **model is user-selectable**.

## Tools & command

- `memory_write { scope, type, text, tags? }` — save a durable entry.
- `memory_search { query, scope?, limit? }` — recall entries.
- `memory_forget { id? | query?, scope? }` — soft-archive entries.
- `/memory status | timeline | list [scope] | search <q> | prune | forget <id> | distill`

## Notes & boundaries

- **Your working tree only ever gets `<cwd>/.pi/<project-id>.md`** — a tiny, stable pointer. It is safe to commit (keeps the id consistent across clones) and safe to delete (recreated on next run). All actual memory is global and private to your machine; nothing project-specific is written into the repo.
- **Secrets are never stored** — the distiller prompts forbid it and entry files are written `0o600`. Still, review project memory before committing.
- The background distiller is **deferred**: `session_shutdown` enqueues a job and the next session drains the queue, so shutdown is never blocked. A failed distiller leaves the job for retry and never affects the host session.
- Disable entirely with `--memory-disabled` / `MEMORY_DISABLED=1` / `"enabled": false`.
