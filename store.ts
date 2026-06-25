/**
 * Entry model + file operations. Markdown files (frontmatter + body) are the source of
 * truth; MEMORY.md is a derived, rebuildable index. All writes go through
 * withFileMutationQueue with atomic temp-write + rename, mode 0o600.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type MemoryType = "fact" | "decision" | "progress" | "preference" | "reference";
export type MemoryScope = "project" | "global";
export type MemoryStatus = "active" | "archived";

export interface MemoryEntry {
	id: string;
	type: MemoryType;
	scope: MemoryScope;
	created: string;
	lastUsed: string;
	useCount: number;
	tags: string[];
	source: string;
	supersedes: string[];
	status: MemoryStatus;
	text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function nowISO(): string {
	return new Date().toISOString();
}

function entriesDir(scopeDir: string): string {
	return path.join(scopeDir, "entries");
}

export function generateId(): string {
	const d = new Date().toISOString().slice(0, 10);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${d}-${rand}`;
}

// --------------------------------------------------------------- (de)serialize

function csv(values: string[]): string {
	return values.filter(Boolean).join(", ");
}
function splitCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function serialize(e: MemoryEntry): string {
	const fm = [
		"---",
		`id: ${e.id}`,
		`type: ${e.type}`,
		`scope: ${e.scope}`,
		`created: ${e.created}`,
		`lastUsed: ${e.lastUsed}`,
		`useCount: ${e.useCount}`,
		`tags: ${csv(e.tags)}`,
		`source: ${e.source}`,
		`supersedes: ${csv(e.supersedes)}`,
		`status: ${e.status}`,
		"---",
		"",
	].join("\n");
	return `${fm}${e.text.trim()}\n`;
}

function parse(content: string, fallbackId: string): MemoryEntry | null {
	try {
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter || !body.trim()) return null;
		return {
			id: frontmatter.id || fallbackId,
			type: (frontmatter.type as MemoryType) || "fact",
			scope: (frontmatter.scope as MemoryScope) || "project",
			created: frontmatter.created || nowISO(),
			lastUsed: frontmatter.lastUsed || frontmatter.created || nowISO(),
			useCount: Number.parseInt(frontmatter.useCount ?? "0", 10) || 0,
			tags: splitCsv(frontmatter.tags),
			source: frontmatter.source || "unknown",
			supersedes: splitCsv(frontmatter.supersedes),
			status: (frontmatter.status as MemoryStatus) || "active",
			text: body.trim(),
		};
	} catch {
		return null;
	}
}

// --------------------------------------------------------------- read / write

export function listEntries(scopeDir: string, includeArchived = false): MemoryEntry[] {
	const dir = entriesDir(scopeDir);
	if (!fs.existsSync(dir)) return [];
	const out: MemoryEntry[] = [];
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".md")) continue;
		let content: string;
		try {
			content = fs.readFileSync(path.join(dir, name), "utf-8");
		} catch {
			continue;
		}
		const entry = parse(content, name.replace(/\.md$/, ""));
		if (!entry) continue;
		if (!includeArchived && entry.status !== "active") continue;
		out.push(entry);
	}
	return out;
}

function entryPath(scopeDir: string, id: string): string {
	return path.join(entriesDir(scopeDir), `${id}.md`);
}

export async function writeEntry(scopeDir: string, entry: MemoryEntry): Promise<void> {
	const file = entryPath(scopeDir, entry.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await withFileMutationQueue(file, async () => {
		const tmp = `${file}.tmp`;
		await fs.promises.writeFile(tmp, serialize(entry), { encoding: "utf-8", mode: 0o600 });
		await fs.promises.rename(tmp, file);
	});
}

export function getEntry(scopeDir: string, id: string): MemoryEntry | null {
	const file = entryPath(scopeDir, id);
	if (!fs.existsSync(file)) return null;
	try {
		return parse(fs.readFileSync(file, "utf-8"), id);
	} catch {
		return null;
	}
}

export async function archive(scopeDir: string, id: string): Promise<boolean> {
	const entry = getEntry(scopeDir, id);
	if (!entry || entry.status === "archived") return false;
	entry.status = "archived";
	await writeEntry(scopeDir, entry);
	return true;
}

export async function bumpUsage(scopeDir: string, ids: string[]): Promise<void> {
	for (const id of ids) {
		const entry = getEntry(scopeDir, id);
		if (!entry) continue;
		entry.useCount += 1;
		entry.lastUsed = nowISO();
		await writeEntry(scopeDir, entry);
	}
}

// --------------------------------------------------------------- dedupe

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function jaccard(a: string, b: string): number {
	const sa = new Set(a.split(" "));
	const sb = new Set(b.split(" "));
	if (sa.size === 0 || sb.size === 0) return 0;
	let inter = 0;
	for (const t of sa) if (sb.has(t)) inter++;
	return inter / (sa.size + sb.size - inter);
}

/** Returns the id of an existing active entry that is a near-duplicate, or null. */
export function findDuplicate(scopeDir: string, text: string): string | null {
	const norm = normalize(text);
	for (const e of listEntries(scopeDir)) {
		const en = normalize(e.text);
		if (en === norm || jaccard(en, norm) >= 0.85) return e.id;
	}
	return null;
}

// --------------------------------------------------------------- ranking / index

export function score(e: MemoryEntry, now = Date.now()): number {
	const ageDays = (now - Date.parse(e.lastUsed || e.created)) / DAY_MS;
	return e.useCount * 5 - ageDays * 0.1;
}

export function rankEntries(entries: MemoryEntry[]): MemoryEntry[] {
	const now = Date.now();
	return [...entries].sort((a, b) => score(b, now) - score(a, now));
}

export async function rebuildIndexFile(scopeDir: string): Promise<void> {
	const entries = rankEntries(listEntries(scopeDir));
	const lines = entries.map((e) => {
		const head = e.text.split("\n")[0].trim();
		const preview = head.length > 100 ? `${head.slice(0, 100)}…` : head;
		return `- [${e.type}] ${preview} (${e.id})`;
	});
	const body = `# Memory index\n\n${entries.length === 0 ? "_(empty)_" : lines.join("\n")}\n`;
	const file = path.join(scopeDir, "MEMORY.md");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	await withFileMutationQueue(file, async () => {
		const tmp = `${file}.tmp`;
		await fs.promises.writeFile(tmp, body, { encoding: "utf-8", mode: 0o600 });
		await fs.promises.rename(tmp, file);
	});
}

// --------------------------------------------------------------- heuristic prune

export interface PruneConfig {
	ttlDays: number;
	maxEntries: number;
}

/** Cheap deterministic sweep: TTL on unused, supersede resolution, LRU cap. */
export async function pruneScope(scopeDir: string, cfg: PruneConfig): Promise<number> {
	const now = Date.now();
	let archived = 0;
	const active = listEntries(scopeDir);

	// 1. supersede resolution
	const supersededIds = new Set<string>();
	for (const e of active) for (const sid of e.supersedes) supersededIds.add(sid);
	for (const id of supersededIds) if (await archive(scopeDir, id)) archived++;

	// 2. TTL on never-used entries
	for (const e of active) {
		if (supersededIds.has(e.id)) continue;
		const ageDays = (now - Date.parse(e.created)) / DAY_MS;
		if (e.useCount === 0 && ageDays > cfg.ttlDays) {
			if (await archive(scopeDir, e.id)) archived++;
		}
	}

	// 3. LRU cap on what remains active
	const remaining = listEntries(scopeDir);
	if (remaining.length > cfg.maxEntries) {
		const byLru = [...remaining].sort((a, b) => Date.parse(a.lastUsed) - Date.parse(b.lastUsed));
		const overflow = byLru.slice(0, remaining.length - cfg.maxEntries);
		for (const e of overflow) if (await archive(scopeDir, e.id)) archived++;
	}

	await rebuildIndexFile(scopeDir);
	return archived;
}

export function nowISOString(): string {
	return nowISO();
}
