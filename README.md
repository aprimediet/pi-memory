<!-- prettier-ignore -->
<div align="center">

<img src="./docs/images/icon.png" alt="" align="center" height="96" />

# @aprimediet/memory

*Persistent, self-managing memory for the pi coding agent*

[![npm version](https://img.shields.io/npm/v/@aprimediet/memory?style=flat-square)](https://www.npmjs.com/package/@aprimediet/memory)
[![Node.js](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

⭐ If you like this project, star it on GitHub — it helps a lot!

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Configuration](#configuration) • [Architecture](#architecture) • [Troubleshooting](#troubleshooting)

</div>

## Overview

`@aprimediet/memory` gives the pi coding agent a persistent memory system that survives across sessions. It remembers durable facts, decisions, progress, and preferences — and keeps them organized by project scope.

The working tree stays clean: the only file written into `<cwd>/.pi` is a single `<project-id>.md` marker. All memory artifacts live globally under `~/.pi/projects/<project-id>/`, with a reserved `~/.pi/projects/_global/` for cross-project ("global") memory.

## Features

- **Persistent Memory** — Save and recall durable facts, decisions, progress, and preferences across sessions
- **Dual Scope** — `project` scope for repo-specific memory, `global` scope for cross-project knowledge
- **Background Distillation** — Automatically distills session transcripts into durable memory entries in the background
- **Smart Search** — Keyword search over memory entries with optional SQLite FTS5 acceleration
- **Heuristic Pruning** — Automatic cleanup of stale, unused, or superseded entries
- **Timeline Widget** — Visual timeline of memory entries shown at session start
- **Context Injection** — Top memory entries are injected as hidden context at session start
- **Clean Working Tree** — All storage is global; the working tree only holds a project marker

## Installation

```bash
pi install npm:@aprimediet/memory
```

No manual `npm install` or `settings.json` edit needed. The extension registers automatically.

## Usage

### Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `memory_write` | `scope`, `type`, `text`, `tags?` | Save a durable fact/decision to persistent memory |
| `memory_search` | `query`, `scope?`, `limit?` | Search memory for keywords or questions |
| `memory_forget` | `id?`, `query?`, `scope?` | Archive (soft-delete) entries by id or keywords |

### Commands

`/memory status` — Show config, entry counts, pruning settings, FTS status  
`/memory timeline` — Show or reshow the memory timeline widget  
`/memory list [scope]` — List entries (default: project scope)  
`/memory search <q>` — Search all memory  
`/memory prune` — Heuristic prune + background consolidation  
`/memory forget <id>` — Archive a specific entry  
`/memory distill` — Manually trigger session distillation

## Configuration

Config lives in `~/.pi/projects/<id>/memory.json` (NOT in the working tree). Precedence:

```
bundled default (memory.json in package)
→ global default (~/.pi/agent/memory.json)
→ per-project (~/.pi/projects/<id>/memory.json)
→ env (MEMORY_MODEL / MEMORY_DISABLED)
→ flags
```

Default values:
- `enabled: true`
- `model: "claude-haiku-4-5"`
- `capture: "both"` (tool + background)
- `injection.scope: "both"`, `digestMaxEntries: 20`
- `pruning.ttlDays: 90`, `maxEntries: 200`, `consolidateEverySessions: 10`
- `useFtsIndex: false`

## Architecture

### Memory Model

- **Source of truth:** Markdown files with frontmatter (`id`, `type`, `scope`, `created`, `lastUsed`, `useCount`, `tags`, `source`, `supersedes`, `status`) + body text
- **Derived index:** `MEMORY.md` is rebuilt on every write; not the source of truth
- **SQLite FTS:** Optional accelerator (`memory.db`); best-effort — falls back to plain file keyword scan if `better-sqlite3` is missing

### Background Agent

The distiller spawns a `pi` subprocess in headless JSON mode (`--mode json --no-session`) with a system prompt. Uses `MEMORY_INTERNAL` env var to prevent recursive re-entrance. Session transcripts are enqueued at `session_shutdown` and drained at the next `session_start` for that project. Consolidation runs every N sessions (`consolidateEverySessions` default: 10).

### Project Identity

Deterministic from project root path: `<slug>-<sha1-hash>` (first 8 hex chars). If a marker file already exists with an `id`, that id wins (stable across renames). Marker file: `<cwd>/.pi/<id>.md` with frontmatter `pi-project: true`.

### Pruning (heuristic)

1. Resolve superseded entries
2. Archive never-used entries older than `ttlDays` (default: 90)
3. LRU cap at `maxEntries` (default: 200)

## Troubleshooting

> [!TIP]
> Check `/memory status` for a quick health check of your memory setup.

- **No memories found:** Verify the extension is enabled (`/memory status` shows `enabled: true`).
- **FTS not working:** Install `better-sqlite3` (optional dependency). Check `/memory status` for "enabled (better-sqlite3 missing → file scan)".
- **Distillation not happening:** Ensure `capture` is not `"tool"` and the model flag is set correctly.
- **Recursive distiller crash:** The `MEMORY_INTERNAL` env guard prevents this. If it still happens, check the spawned process invocation path.
- **Timeline widget not showing:** Verify `ctx.hasUI` is true and the extension is enabled.
- **Entry duplicates:** `findDuplicate` uses Jaccard similarity ≥ 0.85 on normalized text.

## Resources

- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) — The agent this extension is built for
- [TypeBox](https://github.com/sinclairzx81/typebox) — Runtime type validation used for tool parameters
- [better-sqlite3](https://github.com/JoshuaGoldberg/better-sqlite3) — Optional SQLite FTS accelerator
