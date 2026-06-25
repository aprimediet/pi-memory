/**
 * The independent background "memory agent". pi has no in-process sub-session API, so this
 * spawns a real `pi` subprocess in headless JSON mode (configurable model) and parses NDJSON.
 *
 * Two jobs: distill (transcript → durable entries + a thoughts journal) and consolidate
 * (prune/merge entries). Distillation is deferred: session_shutdown enqueues a job into the
 * project's queue; the next session for that project drains it without blocking. The
 * MEMORY_INTERNAL env guard stops the spawned child (which also loads this extension) from
 * recursively enqueuing/draining.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "./config.ts";
import {
	type MemoryEntry,
	type MemoryScope,
	type MemoryType,
	archive,
	findDuplicate,
	generateId,
	listEntries,
	nowISOString,
	rebuildIndexFile,
	writeEntry,
} from "./store.ts";

const HERE =
	typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT_CAP = 60 * 1024;

export const INTERNAL_ENV = "MEMORY_INTERNAL";
export function isInternalRun(): boolean {
	return process.env[INTERNAL_ENV] === "1";
}

// --------------------------------------------------------------- pi subprocess

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function getFinalText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) if (part?.type === "text") return part.text;
		}
	}
	return "";
}

async function runMemoryAgent(model: string, systemPrompt: string, task: string, cwd: string): Promise<string> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "memory-"));
	const promptPath = path.join(tmpDir, "system.md");
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	const args = ["--mode", "json", "-p", "--no-session", "--model", model, "--append-system-prompt", promptPath, task];

	try {
		return await new Promise<string>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [INTERNAL_ENV]: "1" },
			});
			const messages: any[] = [];
			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message) messages.push(event.message);
			};
			proc.stdout.on("data", (d) => {
				buffer += d.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.on("close", () => {
				if (buffer.trim()) processLine(buffer);
				resolve(getFinalText(messages));
			});
			proc.on("error", () => resolve(""));
		});
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

// --------------------------------------------------------------- action parsing

interface Action {
	action: "add" | "supersede" | "drop";
	type?: MemoryType;
	scope?: MemoryScope;
	text?: string;
	tags?: string[];
	supersedes?: string[];
}

export function parseActions(raw: string): Action[] {
	let text = raw.trim();
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) text = fence[1].trim();
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) return [];
	try {
		const parsed = JSON.parse(text.slice(start, end + 1));
		return Array.isArray(parsed) ? (parsed as Action[]) : [];
	} catch {
		return [];
	}
}

async function applyActions(
	actions: Action[],
	dirs: { project: string; global: string },
	source: string,
): Promise<{ added: number; archived: number; addedEntries: MemoryEntry[] }> {
	let added = 0;
	let archived = 0;
	const addedEntries: MemoryEntry[] = [];
	for (const a of actions) {
		const scope: MemoryScope = a.scope === "global" ? "global" : "project";
		const scopeDir = scope === "global" ? dirs.global : dirs.project;

		for (const sid of a.supersedes ?? []) {
			if ((await archive(dirs.project, sid)) || (await archive(dirs.global, sid))) archived++;
		}
		if (a.action === "drop") continue;
		if (!a.text || !a.text.trim()) continue;
		if (findDuplicate(scopeDir, a.text)) continue;

		const now = nowISOString();
		const entry: MemoryEntry = {
			id: generateId(),
			type: a.type ?? "fact",
			scope,
			created: now,
			lastUsed: now,
			useCount: 0,
			tags: Array.isArray(a.tags) ? a.tags : [],
			source,
			supersedes: a.supersedes ?? [],
			status: "active",
			text: a.text.trim(),
		};
		await writeEntry(scopeDir, entry);
		addedEntries.push(entry);
		added++;
	}
	await rebuildIndexFile(dirs.project);
	await rebuildIndexFile(dirs.global);
	return { added, archived, addedEntries };
}

// --------------------------------------------------------------- transcript

export function buildTranscript(ctx: any): string {
	let out = "";
	try {
		for (const entry of ctx.sessionManager.getBranch() ?? []) {
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			if (msg.role === "user" || msg.role === "assistant") {
				const text = Array.isArray(msg.content)
					? msg.content
							.map((p: any) => (p?.type === "text" ? p.text : p?.type === "toolCall" ? `→ ${p.name}` : ""))
							.filter(Boolean)
							.join("\n")
					: "";
				if (text.trim()) out += `\n## ${msg.role}\n${text}\n`;
			}
		}
	} catch {
		/* ignore */
	}
	if (Buffer.byteLength(out, "utf8") > TRANSCRIPT_CAP) out = out.slice(-TRANSCRIPT_CAP);
	return out.trim();
}

function readPrompt(name: string): string {
	try {
		return fs.readFileSync(path.join(HERE, "prompts", name), "utf-8");
	} catch {
		return "";
	}
}

function readIndex(memoryDir: string): string {
	try {
		return fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf-8");
	} catch {
		return "(empty)";
	}
}

async function writeThoughtsJournal(thoughtsDir: string, sessionId: string, added: MemoryEntry[]): Promise<void> {
	if (!thoughtsDir) return;
	try {
		fs.mkdirSync(thoughtsDir, { recursive: true });
		const date = new Date().toISOString().slice(0, 10);
		const file = path.join(thoughtsDir, `${date}-${sessionId.slice(0, 12)}.md`);
		const body = [
			`# Session journal — ${new Date().toISOString()}`,
			`session: ${sessionId}`,
			"",
			added.length === 0 ? "_No new durable memory distilled._" : "Distilled into memory:",
			...added.map((e) => `- [${e.scope}/${e.type}] ${e.text} (${e.id})`),
			"",
		].join("\n");
		await withFileMutationQueue(file, async () => {
			await fs.promises.writeFile(file, body, { encoding: "utf-8", mode: 0o600 });
		});
	} catch {
		/* non-fatal */
	}
}

// --------------------------------------------------------------- queue / jobs

export interface DistillJob {
	sessionId: string;
	cwd: string;
	projectMemoryDir: string;
	globalMemoryDir: string;
	thoughtsDir: string;
	queueDir: string;
	transcript: string;
}

export async function enqueue(job: DistillJob): Promise<void> {
	fs.mkdirSync(job.queueDir, { recursive: true });
	const file = path.join(job.queueDir, `${job.sessionId}-${Math.random().toString(36).slice(2, 8)}.json`);
	await withFileMutationQueue(file, async () => {
		const tmp = `${file}.tmp`;
		await fs.promises.writeFile(tmp, JSON.stringify(job), { encoding: "utf-8", mode: 0o600 });
		await fs.promises.rename(tmp, file);
	});
}

export async function runDistill(job: DistillJob, model: string): Promise<{ added: number; archived: number }> {
	const system = readPrompt("distill.md");
	if (!system || !job.transcript.trim()) return { added: 0, archived: 0 };
	const task = [
		"Current project memory index:",
		readIndex(job.projectMemoryDir),
		"",
		"Session transcript to distill:",
		job.transcript,
	].join("\n");
	const out = await runMemoryAgent(model, system, task, job.cwd);
	const result = await applyActions(
		parseActions(out),
		{ project: job.projectMemoryDir, global: job.globalMemoryDir },
		`session/${job.sessionId}`,
	);
	await writeThoughtsJournal(job.thoughtsDir, job.sessionId, result.addedEntries);
	return { added: result.added, archived: result.archived };
}

/** Drain one project's pending-distill queue. Fire-and-forget from session_start. */
export async function processQueue(queueDir: string, model: string): Promise<void> {
	if (!fs.existsSync(queueDir)) return;
	const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
	for (const f of files) {
		const full = path.join(queueDir, f);
		const processing = `${full}.processing`;
		try {
			fs.renameSync(full, processing); // claim atomically
		} catch {
			continue;
		}
		try {
			const job = JSON.parse(fs.readFileSync(processing, "utf-8")) as DistillJob;
			await runDistill(job, model);
			fs.rmSync(processing, { force: true });
		} catch {
			try {
				fs.renameSync(processing, full); // retry next time
			} catch {
				/* ignore */
			}
		}
	}
}

export async function runConsolidate(scopeDir: string, otherDir: string, model: string, cwd: string): Promise<void> {
	const system = readPrompt("consolidate.md");
	const entries = listEntries(scopeDir);
	if (!system || entries.length === 0) return;
	const payload = entries.map((e) => ({ id: e.id, type: e.type, tags: e.tags, text: e.text }));
	const task = `Active memory entries (JSON):\n${JSON.stringify(payload, null, 2)}`;
	const out = await runMemoryAgent(model, system, task, cwd);
	await applyActions(parseActions(out), { project: scopeDir, global: otherDir }, "consolidate");
}

// --------------------------------------------------------------- session counter

interface State {
	sessionCount: number;
}
export function bumpSessionCount(stateFile: string): number {
	let state: State = { sessionCount: 0 };
	try {
		state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as State;
	} catch {
		/* default */
	}
	state.sessionCount = (state.sessionCount || 0) + 1;
	try {
		fs.mkdirSync(path.dirname(stateFile), { recursive: true });
		fs.writeFileSync(stateFile, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
	} catch {
		/* non-fatal */
	}
	return state.sessionCount;
}

export { runMemoryAgent };
export type { MemoryConfig };
