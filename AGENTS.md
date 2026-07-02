# AGENTS.md

## Project Overview

`@aprimediet/memory` is a Pi coding agent extension that provides persistent, self-managing memory. It saves durable facts, decisions, progress notes, and preferences to Markdown files under `~/.pi/projects/<project-id>/`, with a reserved `~/.pi/projects/_global/` for cross-project memory. The working tree stays clean — the only file written into `<cwd>/.pi` is a single `<project-id>.md` marker.

**Key technologies:** TypeScript, Pi Extension API, TypeBox, better-sqlite3 (optional FTS accelerator), Node.js `fs`.

## Setup Commands

- Install dependencies: `pi install npm:@aprimediet/memory`
- No manual `npm install` or `settings.json` edit needed.

## Development Workflow

- Start development: the package is a Pi extension — install via `pi install` and it registers automatically.
- TypeScript is used; no separate build step required (Pi handles TS compilation).
- The extension registers 3 tools (`memory_write`, `memory_search`, `memory_forget`) and the `/memory` command.

## Testing Instructions

- No dedicated test suite in this extension (Pi extensions are tested via integration with the Pi harness).
- Run lint + type-check: `pnpm lint` (if available in the monorepo).
- Run tests: `pnpm test` (if available in the monorepo).

## Code Style

- **Language:** TypeScript with ES modules (`"type": "module"`).
- **Imports:** Use relative paths; prefer named imports from sibling modules.
- **File organization:** One module per concern:
  - `index.ts` — entry point, tool registration, lifecycle hooks, `/memory` command
  - `config.ts` — configuration resolution (bundled → global default → per-project → env → flags)
  - `store.ts` — entry model, read/write, deduplication, ranking, heuristic pruning, index rebuild
  - `project.ts` — project identity + path layout (marker, global dir, memory/entries, thoughts, queue, db)
  - `digest.ts` — session-start context digest for injection
  - `timeline.ts` — claude-mem-style timeline data structure
  - `index-fts.ts` — optional SQLite FTS5 search accelerator
  - `distiller.ts` — background "memory agent" (spawns pi subprocess, NDJSON parsing)
  - `prompts/` — distill.md and consolidate.md system prompts for the spawned agent
- **Atomic writes:** All file writes use `withFileMutationQueue` (temp-write + rename, mode 0o600).
- **Memory types:** `fact`, `decision`, `progress`, `preference`, `reference`.
- **Scopes:** `project` (repo-specific) and `global` (cross-project).

## Configuration

Config lives in `~/.pi/projects/<id>/memory.json` (NOT in the working tree). Precedence:

```
bundled default (memory.json in package)
→ global default (~/.pi/agent/memory.json)
→ per-project (~/.pi/projects/<id>/memory.json)
→ env (MEMORY_MODEL / MEMORY_DISABLED)
→ flags
```

Default config:
- `enabled: true`
- `model: "claude-haiku-4-5"`
- `capture: "both"` (tool + background)
- `injection.scope: "both"`, `digestMaxEntries: 20`
- `pruning.ttlDays: 90`, `maxEntries: 200`, `consolidateEverySessions: 10`
- `useFtsIndex: false`

## Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `memory_write` | `scope`, `type`, `text`, `tags?` | Save a durable fact/decision to persistent memory |
| `memory_search` | `query`, `scope?`, `limit?` | Search memory for keywords/questions |
| `memory_forget` | `id?`, `query?`, `scope?` | Archive (soft-delete) entries by id or keywords |

## Commands

`/memory status` — show config, entry counts, pruning settings, FTS status  
`/memory timeline` — show/reshow the memory timeline widget  
`/memory list [scope]` — list entries (default: project scope)  
`/memory search <q>` — search all memory  
`/memory prune` — heuristic prune + background consolidation  
`/memory forget <id>` — archive a specific entry  
`/memory distill` — manually trigger session distillation

## Build and Deployment

- This is a Pi package — published to npm under `@aprimediet/memory` v1.0.0.
- Publish account: `aditya.prima` (owner of `@aprimediet` org).
- Publish config: `publishConfig.access: public` in package.json.
- `.npmignore` excludes `.pi/`, `AGENTS.md`, `docs/`.
- npm metadata propagates in 1-5 min; tarballs may take 10-15+ min. Use `npm view` for verification.

## Architecture Notes

### Memory Model
- **Source of truth:** Markdown files with frontmatter (`id`, `type`, `scope`, `created`, `lastUsed`, `useCount`, `tags`, `source`, `supersedes`, `status`) + body text.
- **Derived index:** `MEMORY.md` is rebuilt on every write; not the source of truth.
- **SQLite FTS:** Optional accelerator (`memory.db`); best-effort — falls back to plain file keyword scan if `better-sqlite3` is missing.

### Background Agent
- The distiller spawns a `pi` subprocess in headless JSON mode (`--mode json --no-session`) with a system prompt.
- Uses `MEMORY_INTERNAL` env var to prevent recursive re-entrance.
- Session transcripts are enqueued at `session_shutdown`; drained at next `session_start` for that project.
- Consolidation runs every N sessions (`consolidateEverySessions` default: 10).

### Project Identity
- Deterministic from project root path: `<slug>-<sha1-hash>` (first 8 hex chars).
- If a marker file already exists with an `id`, that id wins (stable across renames).
- Marker file: `<cwd>/.pi/<id>.md` with frontmatter `pi-project: true`.

### Pruning (heuristic)
1. Resolve superseded entries
2. Archive never-used entries older than `ttlDays` (default: 90)
3. LRU cap at `maxEntries` (default: 200)

## Security Considerations

- **Never store secrets** in memory entries.
- All file writes use mode 0o600 (owner-only).
- `MEMORY_DISABLED` env var can disable memory entirely.
- `memory_forget` soft-deletes (archives) entries rather than permanently removing them.

## Monorepo Considerations

- This extension lives in a Pi monorepo (`pi-harnes`).
- Install via `pi install` from the workspace root.
- The `.pi/` directory in the package root contains local markers and must be excluded from publishing (`.npmignore`).

## Debugging and Troubleshooting

- **No memories found:** Check that the extension is enabled (`/memory status` shows `enabled: true`).
- **FTS not working:** Install `better-sqlite3` (optional dependency). Check `/memory status` for "enabled (better-sqlite3 missing → file scan)".
- **Distillation not happening:** Check `capture` is not `"tool"`; verify the model flag is set correctly.
- **Recursive distiller crash:** The `MEMORY_INTERNAL` env guard prevents this. If it still happens, check that the spawned process is using the correct invocation path.
- **Timeline widget not showing:** Verify `ctx.hasUI` is true and the extension is enabled.
- **Entry duplicates:** `findDuplicate` uses Jaccard similarity ≥ 0.85 on normalized text.

## PR Guidelines

- Title format: `[memory] <description>`
- Always run lint and type-check before committing.
- Update `memory.json` (bundled default) when changing default config values.
- Add or update tests for the code you change.

## Additional Notes

- The extension is designed to work with Pi's native tool system — no custom tools needed.
- The timeline widget is a startup banner that clears when the first turn begins (doesn't permanently consume space).
- The `before_agent_start` hook injects a `memory-context` custom message with the top entries as hidden context.
- The `context` hook strips duplicate `memory-context` messages to avoid bloat.
- All error handling is non-fatal — failures in pruning, distillation, FTS, etc. are caught and logged but don't break the session.
