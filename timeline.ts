/**
 * Build the claude-mem-style memory timeline shown to the USER at session start, so they can see
 * what is remembered for this project. Returns structured data; the renderer (index.ts) colorizes
 * it, and `timelinePlainText` is a no-color fallback.
 */

import type { MemoryConfig } from "./config.ts";
import { globalScope, resolveProject } from "./project.ts";
import { type MemoryEntry, listEntries } from "./store.ts";

export const TYPE_ICON: Record<string, string> = {
	fact: "○",
	decision: "⚖",
	progress: "◆",
	preference: "★",
	reference: "🔖",
};

export interface TimelineItem {
	time: string;
	type: string;
	title: string;
	scope: string;
	id: string;
}
export interface TimelineDay {
	label: string;
	items: TimelineItem[];
}
export interface TimelineData {
	project: string;
	projectCount: number;
	globalCount: number;
	total: number;
	shown: number;
	days: TimelineDay[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}
function fmtTime(d: Date): string {
	let h = d.getHours();
	const m = d.getMinutes();
	const ampm = h < 12 ? "a" : "p";
	h = h % 12;
	if (h === 0) h = 12;
	return `${h}:${pad2(m)}${ampm}`;
}
function dayKey(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dayLabel(key: string, todayKey: string, yesterdayKey: string): string {
	if (key === todayKey) return "Today";
	if (key === yesterdayKey) return "Yesterday";
	const [y, m, dd] = key.split("-").map(Number);
	const now = new Date();
	const label = `${MONTHS[(m - 1) % 12]} ${dd}`;
	return y === now.getFullYear() ? label : `${label}, ${y}`;
}
function firstLine(text: string): string {
	const line = text.split("\n")[0].trim();
	return line.length > 72 ? `${line.slice(0, 72)}…` : line;
}

/** Build the timeline, most-recent first, capped at maxItems. Returns null when empty. */
export function buildTimelineData(cwd: string, _config: MemoryConfig, maxItems = 25): TimelineData | null {
	const projEntries = listEntries(resolveProject(cwd).memoryDir);
	const globEntries = listEntries(globalScope().memoryDir);
	const projectCount = projEntries.length;
	const globalCount = globEntries.length;
	if (projectCount + globalCount === 0) return null;

	const tagged: Array<{ e: MemoryEntry; scope: string }> = [
		...projEntries.map((e) => ({ e, scope: "project" })),
		...globEntries.map((e) => ({ e, scope: "global" })),
	].sort((a, b) => Date.parse(b.e.created) - Date.parse(a.e.created));

	const shown = tagged.slice(0, maxItems);

	const now = new Date();
	const todayKey = dayKey(now);
	const yesterdayKey = dayKey(new Date(now.getTime() - 86400000));

	const byDay = new Map<string, TimelineItem[]>();
	const order: string[] = [];
	for (const { e, scope } of shown) {
		const d = new Date(e.created);
		const key = Number.isNaN(d.getTime()) ? "unknown" : dayKey(d);
		if (!byDay.has(key)) {
			byDay.set(key, []);
			order.push(key);
		}
		byDay.get(key)?.push({
			time: Number.isNaN(d.getTime()) ? "" : fmtTime(d),
			type: e.type,
			title: firstLine(e.text),
			scope,
			id: e.id,
		});
	}

	const days: TimelineDay[] = order.map((key) => ({
		label: key === "unknown" ? "Earlier" : dayLabel(key, todayKey, yesterdayKey),
		items: byDay.get(key) ?? [],
	}));

	return { project: resolveProject(cwd).id, projectCount, globalCount, total: tagged.length, shown: shown.length, days };
}

export function timelinePlainText(d: TimelineData): string {
	const lines: string[] = [`🧠 Memory — ${d.project}  (${d.projectCount} project · ${d.globalCount} global)`];
	for (const day of d.days) {
		lines.push(day.label);
		for (const it of day.items) {
			const icon = TYPE_ICON[it.type] ?? "•";
			lines.push(`  ${it.time.padStart(6)} ${icon} ${it.title}${it.scope === "global" ? " (global)" : ""}`);
		}
	}
	if (d.total > d.shown) lines.push(`  … +${d.total - d.shown} more`);
	lines.push("use /memory search <q> to recall · /memory list to browse");
	return lines.join("\n");
}
