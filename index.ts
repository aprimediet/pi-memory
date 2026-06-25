/**
 * @aprimediet/memory
 *
 * Persistent, self-managing memory for the pi coding agent.
 *
 * Storage model: the working tree stays clean — the only file written into <cwd>/.pi is a single
 * project identifier `<project-id>.md`. ALL memory artifacts live globally under
 * ~/.pi/projects/<project-id>/ (entries, MEMORY.md, thoughts, queue, memory.db, config), with a
 * reserved ~/.pi/projects/_global/ for cross-project ("global") memory. See project.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type MemoryConfig,
	bundledConfigFile,
	globalDefaultConfigFile,
	resolveConfig,
	setFlagOverrides,
} from "./config.ts";
import { buildDigest } from "./digest.ts";
import { type TimelineData, TYPE_ICON, buildTimelineData } from "./timeline.ts";
import {
	bumpSessionCount,
	buildTranscript,
	enqueue,
	isInternalRun,
	processQueue,
	runConsolidate,
	runDistill,
} from "./distiller.ts";
import { ftsSearch } from "./index-fts.ts";
import { ensureGlobalScope, ensureProject, globalScope, resolveProject } from "./project.ts";
import {
	type MemoryEntry,
	type MemoryScope,
	type MemoryType,
	archive,
	bumpUsage,
	findDuplicate,
	generateId,
	listEntries,
	nowISOString,
	pruneScope,
	rankEntries,
	rebuildIndexFile,
	writeEntry,
} from "./store.ts";

const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TYPE_ENUM = ["fact", "decision", "progress", "preference", "reference"] as const;

interface Scope {
	memoryDir: string;
	dbPath: string;
}
function getScope(scope: MemoryScope, cwd: string): Scope {
	const p = scope === "global" ? globalScope() : resolveProject(cwd);
	return { memoryDir: p.memoryDir, dbPath: p.dbPath };
}

const TIMELINE_WIDGET = "memory-timeline";

// Render the timeline as a pi-tui node (used as a widget above the editor).
function renderTimeline(theme: { fg: (role: string, s: string) => string; bold: (s: string) => string }, d: TimelineData): Text {
	const lines: string[] = [
		theme.fg("accent", theme.bold(`🧠 Memory — ${d.project}`)) +
			theme.fg("muted", `  (${d.projectCount} project · ${d.globalCount} global)`),
	];
	for (const day of d.days) {
		lines.push(theme.fg("warning", day.label));
		for (const it of day.items) {
			const icon = TYPE_ICON[it.type] ?? "•";
			const scopeTag = it.scope === "global" ? theme.fg("dim", " ⟂global") : "";
			lines.push(`  ${theme.fg("muted", it.time.padStart(6))} ${theme.fg("accent", icon)} ${it.title}${scopeTag}`);
		}
	}
	if (d.total > d.shown) lines.push(theme.fg("dim", `  … +${d.total - d.shown} more`));
	lines.push(theme.fg("dim", "/memory search <q> to recall · /memory list to browse · /memory timeline to reshow"));
	return new Text(lines.join("\n"), 0, 0);
}

function normalizeTokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

function fileSearch(entries: MemoryEntry[], query: string, limit: number): MemoryEntry[] {
	const ranked = rankEntries(entries);
	const tokens = normalizeTokens(query);
	if (tokens.length === 0) return ranked.slice(0, limit);
	const scored = ranked
		.map((e) => {
			const set = new Set(normalizeTokens(`${e.text} ${e.tags.join(" ")}`));
			return { e, rel: tokens.reduce((n, t) => n + (set.has(t) ? 1 : 0), 0) };
		})
		.filter((x) => x.rel > 0)
		.sort((a, b) => b.rel - a.rel);
	return scored.slice(0, limit).map((x) => x.e);
}

// ----------------------------------------------------------------- tools

function registerTools(pi: ExtensionAPI): void {
	const MemoryWriteParams = Type.Object({
		scope: StringEnum(["project", "global"] as const, { description: "project = this repo; global = all projects" }),
		type: StringEnum(TYPE_ENUM, { description: "Kind of memory" }),
		text: Type.String({ description: "A self-contained, durable fact/decision worth recalling later" }),
		tags: Type.Optional(Type.Array(Type.String(), { description: "Short topic tags" })),
	});

	pi.registerTool({
		name: "memory_write",
		label: "Memory",
		description:
			"Save a durable fact, decision, progress note, or preference to persistent memory so it survives across sessions. Use for non-obvious knowledge worth recalling later — not transient details. Never store secrets.",
		promptSnippet: "Save a durable fact to persistent memory",
		promptGuidelines: [
			"Use memory_write to save durable, reusable knowledge (decisions, gotchas, conventions, progress) — never secrets.",
			"Use scope 'project' for repo-specific facts and 'global' for cross-project preferences.",
		],
		parameters: MemoryWriteParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const config = resolveConfig(ctx.cwd);
			if (!config.enabled) return { content: [{ type: "text", text: "Memory is disabled." }], details: { disabled: true } };
			const scope = params.scope as MemoryScope;
			const { memoryDir } = getScope(scope, ctx.cwd);
			const dup = findDuplicate(memoryDir, params.text);
			if (dup) return { content: [{ type: "text", text: `Already remembered (duplicate of ${dup}).` }], details: { id: dup, duplicate: true } };
			const now = nowISOString();
			const entry: MemoryEntry = {
				id: generateId(),
				type: params.type as MemoryType,
				scope,
				created: now,
				lastUsed: now,
				useCount: 0,
				tags: (params.tags as string[]) ?? [],
				source: "tool",
				supersedes: [],
				status: "active",
				text: params.text,
			};
			await writeEntry(memoryDir, entry);
			await rebuildIndexFile(memoryDir);
			return { content: [{ type: "text", text: `Saved to ${scope} memory (${entry.id}).` }], details: { id: entry.id } };
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", "▣ ") + (text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	const MemorySearchParams = Type.Object({
		query: Type.String({ description: "What to recall (keywords or a question)" }),
		scope: Type.Optional(StringEnum(["project", "global", "both"] as const, { description: 'Default "both"' })),
		limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory search",
		description:
			"Search persistent memory for durable facts/decisions saved in past sessions. Use when you need background context the session-start digest did not include.",
		promptSnippet: "Recall durable facts from persistent memory",
		parameters: MemorySearchParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const config = resolveConfig(ctx.cwd);
			if (!config.enabled) return { content: [{ type: "text", text: "Memory is disabled." }], details: { disabled: true } };
			const which = (params.scope as string) ?? "both";
			const limit = (params.limit as number) ?? 5;
			const scopes: MemoryScope[] = which === "both" ? ["project", "global"] : [which as MemoryScope];

			const hits: Array<{ entry: MemoryEntry; memoryDir: string }> = [];
			for (const s of scopes) {
				const { memoryDir, dbPath } = getScope(s, ctx.cwd);
				const entries = listEntries(memoryDir);
				let selected: MemoryEntry[] | null = null;
				if (config.useFtsIndex) {
					const ids = await ftsSearch(dbPath, entries, params.query, limit);
					if (ids) {
						const byId = new Map(entries.map((e) => [e.id, e]));
						selected = ids.map((i) => byId.get(i)).filter((e): e is MemoryEntry => Boolean(e));
					}
				}
				if (!selected) selected = fileSearch(entries, params.query, limit);
				for (const entry of selected) hits.push({ entry, memoryDir });
			}

			if (hits.length === 0) return { content: [{ type: "text", text: "No matching memories." }], details: { count: 0 } };

			const byDir = new Map<string, string[]>();
			for (const h of hits) byDir.set(h.memoryDir, [...(byDir.get(h.memoryDir) ?? []), h.entry.id]);
			for (const [dir, ids] of byDir) await bumpUsage(dir, ids);

			const text = hits
				.slice(0, limit)
				.map((h) => `- [${h.entry.scope}/${h.entry.type}] ${h.entry.text} (${h.entry.id})`)
				.join("\n");
			return { content: [{ type: "text", text }], details: { count: hits.length } };
		},
		renderResult(result, _opts, theme) {
			const text = result.content[0];
			return new Text(theme.fg("muted", "▣ search\n") + (text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	const MemoryForgetParams = Type.Object({
		id: Type.Optional(Type.String({ description: "Entry id to archive" })),
		query: Type.Optional(Type.String({ description: "Archive active entries whose text matches these keywords" })),
		scope: Type.Optional(StringEnum(["project", "global", "both"] as const, { description: 'Default "both"' })),
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory forget",
		description: "Archive (soft-delete) one or more memory entries by id or matching keywords.",
		promptSnippet: "Forget a stored memory entry",
		parameters: MemoryForgetParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const which = (params.scope as string) ?? "both";
			const scopes: MemoryScope[] = which === "both" ? ["project", "global"] : [which as MemoryScope];
			let archived = 0;
			for (const s of scopes) {
				const { memoryDir } = getScope(s, ctx.cwd);
				if (params.id) {
					if (await archive(memoryDir, params.id as string)) archived++;
				} else if (params.query) {
					for (const e of fileSearch(listEntries(memoryDir), params.query as string, 50)) if (await archive(memoryDir, e.id)) archived++;
				}
				await rebuildIndexFile(memoryDir);
			}
			return { content: [{ type: "text", text: `Archived ${archived} entr${archived === 1 ? "y" : "ies"}.` }], details: { archived } };
		},
	});
}

// ----------------------------------------------------------------- extension

export default function memoryExtension(pi: ExtensionAPI): void {
	registerTools(pi);

	pi.registerFlag("memory-model", { description: "Model for the background memory agent (distiller/consolidator)", type: "string" });
	pi.registerFlag("memory-disabled", { description: "Disable the memory extension for this session", type: "boolean" });
	pi.registerFlag("memory-capture", { description: "Capture mode: tool, background, or both", type: "string" });

	let digest: string | null = null;
	let lastCtx: ExtensionContext | undefined;
	let timelineWidgetActive = false;

	// Show the claude-mem-style timeline as a widget above the editor at the very start of the
	// session (visible immediately, before the user types). It is a startup banner: cleared when
	// the first turn begins so it does not permanently consume space.
	const showTimelineWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const config = resolveConfig(ctx.cwd);
		if (!config.enabled) return;
		const data = buildTimelineData(ctx.cwd, config);
		if (!data) return;
		ctx.ui.setWidget(TIMELINE_WIDGET, (_tui, theme) => renderTimeline(theme, data));
		timelineWidgetActive = true;
	};
	const clearTimelineWidget = (ctx: ExtensionContext): void => {
		if (!timelineWidgetActive) return;
		timelineWidgetActive = false;
		if (ctx.hasUI) ctx.ui.setWidget(TIMELINE_WIDGET, undefined);
	};

	const onStart = async (_e: unknown, ctx: ExtensionContext) => {
		lastCtx = ctx;

		const fm = pi.getFlag("memory-model");
		const fd = pi.getFlag("memory-disabled");
		const fc = pi.getFlag("memory-capture");
		setFlagOverrides({
			model: typeof fm === "string" ? fm : undefined,
			disabled: fd === true,
			capture: typeof fc === "string" ? (fc as MemoryConfig["capture"]) : undefined,
		});

		// seed bundled default config into the global default path on first run (idempotent)
		try {
			const target = globalDefaultConfigFile();
			if (!fs.existsSync(target) && fs.existsSync(bundledConfigFile())) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.copyFileSync(bundledConfigFile(), target);
			}
		} catch {
			/* non-fatal */
		}

		if (isInternalRun()) return; // the spawned distiller child must not be reentrant

		const config = resolveConfig(ctx.cwd);
		digest = null;
		if (!config.enabled) return;

		// create the cwd marker + global project structure, and the _global scope
		let project: ReturnType<typeof resolveProject>;
		try {
			project = await ensureProject(ctx.cwd);
			ensureGlobalScope();
		} catch {
			project = resolveProject(ctx.cwd);
		}
		const g = globalScope();

		try {
			await pruneScope(project.memoryDir, config.pruning);
			await pruneScope(g.memoryDir, config.pruning);
		} catch {
			/* non-fatal */
		}

		if (config.capture !== "tool") {
			processQueue(project.queueDir, config.model).catch(() => {});
			const count = bumpSessionCount(project.stateFile);
			if (config.pruning.consolidateEverySessions > 0 && count % config.pruning.consolidateEverySessions === 0) {
				runConsolidate(project.memoryDir, g.memoryDir, config.model, ctx.cwd).catch(() => {});
			}
		}

		try {
			digest = buildDigest(ctx.cwd, config);
		} catch {
			digest = null;
		}

		// Show the visible memory timeline at the very start of the session (before the user types).
		try {
			showTimelineWidget(ctx);
		} catch {
			/* non-fatal */
		}
	};

	pi.on("session_start", onStart);
	pi.on("session_tree", onStart);
	// The timeline is a startup banner — clear it once the user begins working.
	pi.on("turn_start", async (_e, ctx) => {
		lastCtx = ctx;
		clearTimelineWidget(ctx);
	});
	pi.on("turn_end", async (_e, ctx) => {
		lastCtx = ctx;
	});

	pi.on("before_agent_start", async () => {
		if (!digest) return undefined;
		return { message: { customType: "memory-context", content: digest, display: false } };
	});

	pi.on("context", async (event) => {
		const msgs = (event as any).messages as any[];
		let lastIdx = -1;
		for (let i = 0; i < msgs.length; i++) if (msgs[i]?.customType === "memory-context") lastIdx = i;
		if (lastIdx === -1) return undefined;
		return { messages: msgs.filter((m, i) => m?.customType !== "memory-context" || i === lastIdx) };
	});

	pi.on("session_shutdown", async () => {
		if (isInternalRun() || !lastCtx) return;
		try {
			const config = resolveConfig(lastCtx.cwd);
			if (!config.enabled || config.capture === "tool") return;
			const transcript = buildTranscript(lastCtx);
			if (!transcript.trim()) return;
			const p = resolveProject(lastCtx.cwd);
			const g = globalScope();
			await enqueue({
				sessionId: SESSION_ID,
				cwd: lastCtx.cwd,
				projectMemoryDir: p.memoryDir,
				globalMemoryDir: g.memoryDir,
				thoughtsDir: p.thoughtsDir,
				queueDir: p.queueDir,
				transcript,
			});
		} catch {
			/* non-fatal */
		}
	});

	// ----------------------------------------------------------------- /memory
	pi.registerCommand("memory", {
		description: "memory: status | timeline | list [scope] | search <q> | prune | forget <id> | distill",
		handler: async (args, ctx: ExtensionContext) => {
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] ?? "status";
			const config = resolveConfig(ctx.cwd);
			const project = resolveProject(ctx.cwd);
			const g = globalScope();
			const notify = (msg: string, level: "info" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
			};

			switch (sub) {
				case "timeline": {
					const data = buildTimelineData(ctx.cwd, config);
					if (!data) return notify("No memories saved for this project yet.");
					if (ctx.hasUI) showTimelineWidget(ctx);
					return;
				}
				case "status": {
					const projCount = listEntries(project.memoryDir).length;
					const globCount = listEntries(g.memoryDir).length;
					const fts = config.useFtsIndex ? await (await import("./index-fts.ts")).isAvailable() : false;
					notify(
						[
							`enabled     : ${config.enabled}`,
							`model       : ${config.model}`,
							`capture     : ${config.capture}`,
							`injection   : ${config.injection.scope} (max ${config.injection.digestMaxEntries})`,
							`pruning     : ttl ${config.pruning.ttlDays}d, max ${config.pruning.maxEntries}, consolidate every ${config.pruning.consolidateEverySessions}`,
							`fts index   : ${config.useFtsIndex ? (fts ? "enabled (available)" : "enabled (better-sqlite3 missing → file scan)") : "off"}`,
							`entries     : ${projCount} project, ${globCount} global`,
							`project id  : ${project.id}`,
							`marker      : ${project.markerPath}`,
							`global dir  : ${project.globalDir}`,
						].join("\n"),
					);
					return;
				}
				case "list": {
					const dir = tokens[1] === "global" ? g.memoryDir : project.memoryDir;
					const entries = rankEntries(listEntries(dir));
					notify(entries.length === 0 ? "(no memories)" : entries.map((e) => `[${e.type}] ${e.text.split("\n")[0]} (${e.id})`).join("\n"));
					return;
				}
				case "search": {
					const q = tokens.slice(1).join(" ");
					const all = [...fileSearch(listEntries(project.memoryDir), q, 10), ...fileSearch(listEntries(g.memoryDir), q, 10)];
					notify(all.length === 0 ? "No matches." : all.map((e) => `[${e.scope}/${e.type}] ${e.text} (${e.id})`).join("\n"));
					return;
				}
				case "prune": {
					const a = await pruneScope(project.memoryDir, config.pruning);
					const b = await pruneScope(g.memoryDir, config.pruning);
					if (config.capture !== "tool") runConsolidate(project.memoryDir, g.memoryDir, config.model, ctx.cwd).catch(() => {});
					notify(`Heuristic prune archived ${a + b} entr${a + b === 1 ? "y" : "ies"}. Consolidation running in background.`);
					return;
				}
				case "forget": {
					const id = tokens[1];
					if (!id) return notify("Usage: /memory forget <id>", "error");
					const ok = (await archive(project.memoryDir, id)) || (await archive(g.memoryDir, id));
					await rebuildIndexFile(project.memoryDir);
					await rebuildIndexFile(g.memoryDir);
					notify(ok ? `Archived ${id}.` : `Not found: ${id}.`, ok ? "info" : "error");
					return;
				}
				case "distill": {
					if (config.capture === "tool") return notify("Capture mode is 'tool'; background distillation is off.", "error");
					const transcript = buildTranscript(ctx);
					if (!transcript.trim()) return notify("Nothing to distill from this session yet.");
					notify("Distilling current session in background…");
					runDistill(
						{
							sessionId: SESSION_ID,
							cwd: ctx.cwd,
							projectMemoryDir: project.memoryDir,
							globalMemoryDir: g.memoryDir,
							thoughtsDir: project.thoughtsDir,
							queueDir: project.queueDir,
							transcript,
						},
						config.model,
					).catch(() => {});
					return;
				}
				default:
					notify("Usage: /memory status | list [scope] | search <q> | prune | forget <id> | distill", "error");
			}
		},
	});
}
