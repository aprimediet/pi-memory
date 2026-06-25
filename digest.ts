/**
 * Build the compact session-start digest injected as hidden context, so the agent "does not
 * forget" prior work without a per-turn token tax.
 */

import type { MemoryConfig } from "./config.ts";
import { globalScope, resolveProject } from "./project.ts";
import { type MemoryEntry, listEntries, rankEntries } from "./store.ts";

function formatGroup(title: string, entries: MemoryEntry[]): string {
	if (entries.length === 0) return "";
	const lines = entries.map((e) => `- [${e.type}] ${e.text.split("\n")[0].trim()}`);
	return `${title}:\n${lines.join("\n")}`;
}

/** Returns the digest markdown, or null when there is nothing to inject. */
export function buildDigest(cwd: string, config: MemoryConfig): string | null {
	const max = config.injection.digestMaxEntries;
	const wantProject = config.injection.scope === "project" || config.injection.scope === "both";
	const wantGlobal = config.injection.scope === "global" || config.injection.scope === "both";

	const project = wantProject ? rankEntries(listEntries(resolveProject(cwd).memoryDir)).slice(0, max) : [];
	const globalMax = Math.max(0, Math.floor(max / 2));
	const global = wantGlobal ? rankEntries(listEntries(globalScope().memoryDir)).slice(0, globalMax) : [];

	const sections = [formatGroup("Project", project), formatGroup("Global", global)].filter(Boolean);
	if (sections.length === 0) return null;

	return [
		"## Memory (recalled from past sessions)",
		"This is durable context distilled from prior work. Treat it as background knowledge; use the",
		"`memory_search` tool to recall more, and `memory_write` to save new durable facts.",
		"",
		sections.join("\n\n"),
	].join("\n");
}
