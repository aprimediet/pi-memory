/**
 * OPTIONAL SQLite FTS accelerator, persisted at <project>/memory.db. Entirely best-effort: if
 * better-sqlite3 (an optionalDependency) is absent or FTS5 is unavailable, every function
 * returns null and the caller falls back to the plain file keyword scan.
 *
 * The entry markdown files remain the source of truth; this DB is rebuilt from them whenever the
 * entry set changes (tracked by a cheap signature), so it is always disposable and never stale.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryEntry } from "./store.ts";

let loadAttempted = false;
let Sqlite: any = null;

async function loadSqlite(): Promise<any> {
	if (loadAttempted) return Sqlite;
	loadAttempted = true;
	try {
		const mod = await import("better-sqlite3");
		Sqlite = mod.default ?? mod;
	} catch {
		Sqlite = null;
	}
	return Sqlite;
}

export async function isAvailable(): Promise<boolean> {
	return (await loadSqlite()) !== null;
}

function signature(entries: MemoryEntry[]): string {
	// cheap, order-independent: count + sum over (id length + text length + lastUsed)
	let acc = 0;
	for (const e of entries) acc += e.id.length + e.text.length + Date.parse(e.lastUsed || e.created || "") || 0;
	return `${entries.length}:${acc}`;
}

/**
 * FTS-rank entries against a query, persisting/refreshing the DB at dbPath. Returns ordered
 * entry ids, or null when FTS is unavailable (caller should fall back).
 */
export async function ftsSearch(dbPath: string, entries: MemoryEntry[], query: string, limit: number): Promise<string[] | null> {
	const S = await loadSqlite();
	if (!S) return null;
	let db: any;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		db = new S(dbPath);
		db.pragma("journal_mode = WAL");
		db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
		db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS m USING fts5(id UNINDEXED, body)");

		const sig = signature(entries);
		const stored = db.prepare("SELECT v FROM meta WHERE k = 'sig'").get() as { v: string } | undefined;
		if (!stored || stored.v !== sig) {
			const insert = db.prepare("INSERT INTO m (id, body) VALUES (?, ?)");
			const rebuild = db.transaction((rows: MemoryEntry[]) => {
				db.exec("DELETE FROM m");
				for (const e of rows) insert.run(e.id, `${e.text} ${e.tags.join(" ")}`);
				db.prepare("INSERT INTO meta (k, v) VALUES ('sig', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(sig);
			});
			rebuild(entries);
		}

		const match = query
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter(Boolean)
			.map((t) => `"${t}"`)
			.join(" OR ");
		if (!match) return [];
		const rows = db.prepare("SELECT id FROM m WHERE m MATCH ? ORDER BY rank LIMIT ?").all(match, limit);
		return rows.map((r: any) => r.id as string);
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			/* ignore */
		}
	}
}
