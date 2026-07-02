# Changelog

All notable changes to `@aprimediet/memory` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-25

### Added

- **Persistent memory system** — saves durable facts, decisions, progress, and preferences across sessions
- **Dual scope** — `project` scope for repo-specific memory, `global` scope for cross-project knowledge
- **Three registered tools** — `memory_write`, `memory_search`, `memory_forget`
- **`/memory` command** — CLI-style subcommands: `status`, `timeline`, `list`, `search`, `prune`, `forget`, `distill`
- **Background distiller** — spawns a pi subprocess to distill session transcripts into durable entries
- **Context injection** — top memory entries injected as hidden context at session start via `memory-context` custom message
- **Timeline widget** — claude-mem-style timeline shown at session start, cleared on first turn
- **Heuristic pruning** — automatic cleanup of stale, unused, and superseded entries (TTL, LRU cap, supersede resolution)
- **Entry ranking** — usage-weighted scoring (`useCount × 5 - ageDays × 0.1`)
- **Deduplication** — Jaccard similarity check (≥ 0.85) on normalized text
- **Markdown frontmatter** — source of truth for all entries (id, type, scope, created, lastUsed, useCount, tags, source, supersedes, status)
- **Atomic file writes** — all writes use `withFileMutationQueue` (temp-write + rename, mode 0o600)
- **SQLite FTS accelerator** — optional better-sqlite3 FTS5 search index (`memory.db`)
- **Session transcript** — builds session transcript from branch for background distillation
- **Thoughts journals** — per-session journals written to `thoughts/` directory
- **Queue-based distillation** — session shutdown enqueues jobs; drained at next session start
- **Project identity** — deterministic `<slug>-<sha1-hash>` from project root path
- **Marker file** — single `<project-id>.md` in `<cwd>/.pi/` keeps working tree clean
- **Config precedence** — bundled default → global default → per-project → env → flags
- **Environment overrides** — `MEMORY_MODEL`, `MEMORY_DISABLED`, `MEMORY_CAPTURE` env vars
- **Flag overrides** — `memory-model`, `memory-disabled`, `memory-capture` pi flags
- **Global scope** — reserved `~/.pi/projects/_global/` for cross-project memory
- **Config file** — `memory.json` with defaults: enabled, model, capture, injection, pruning, useFtsIndex
- **npm package** — published under `@aprimediet/memory` v1.0.0, access: public

### Configuration

- `enabled: true` — toggle memory on/off
- `model: "claude-haiku-4-5"` — model for background distiller/consolidator
- `capture: "both"` — capture mode: `tool`, `background`, or `both`
- `injection.scope: "both"` — which scopes to inject into context
- `injection.digestMaxEntries: 20` — max entries in session-start digest
- `pruning.ttlDays: 90` — TTL for never-used entries
- `pruning.maxEntries: 200` — max active entries per scope
- `pruning.consolidateEverySessions: 10` — consolidate every N sessions
- `useFtsIndex: false` — enable SQLite FTS5 search (requires better-sqlite3)
