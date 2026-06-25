/**
 * Project identity + path layout.
 *
 * The working tree stays clean: the only artifact written into <cwd>/.pi is a single identifier
 * file `<project-id>.md`. Everything else (memory entries, index, thoughts, queue, db, config)
 * lives globally under ~/.pi/projects/<project-id>/.
 *
 * The project id is deterministic from the project root path (`<slug>-<hash>`) so it is stable
 * across runs; if the marker already records an id (e.g. the directory was moved), that id wins,
 * so memory follows the project rather than the path.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const GLOBAL_PROJECT_ID = "_global";

export interface ProjectPaths {
	id: string;
	root: string; // project root (the dir whose .pi holds the marker)
	configDir: string; // <root>/.pi
	markerPath: string; // <root>/.pi/<id>.md
	globalDir: string; // ~/.pi/projects/<id>
	memoryDir: string; // <globalDir>/memory
	thoughtsDir: string; // <globalDir>/thoughts
	queueDir: string; // <globalDir>/queue
	dbPath: string; // <globalDir>/memory.db
	configFile: string; // <globalDir>/memory.json
	stateFile: string; // <globalDir>/state.json
	projectJson: string; // <globalDir>/project.json
}

function piHome(): string {
	// getAgentDir() === ~/.pi/agent ; its parent is ~/.pi
	return path.dirname(getAgentDir());
}
export function projectsRoot(): string {
	return path.join(piHome(), "projects");
}

function slug(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return s || "project";
}

function pathHash(abs: string): string {
	return crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8);
}

function findProjectRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (fs.existsSync(path.join(dir, CONFIG_DIR_NAME)) || fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return cwd;
		dir = parent;
	}
}

/** Read an existing marker (a .pi/*.md file with `pi-project: true`); return its id + file. */
function readMarker(configDir: string): { id: string; file: string } | null {
	if (!fs.existsSync(configDir)) return null;
	let names: string[];
	try {
		names = fs.readdirSync(configDir).filter((n) => n.endsWith(".md"));
	} catch {
		return null;
	}
	for (const name of names) {
		const file = path.join(configDir, name);
		try {
			const { frontmatter } = parseFrontmatter<Record<string, string>>(fs.readFileSync(file, "utf-8"));
			if (frontmatter && String(frontmatter["pi-project"]) === "true" && frontmatter.id) {
				return { id: frontmatter.id, file };
			}
		} catch {
			/* not a marker */
		}
	}
	return null;
}

function pathsForId(id: string, root: string, configDir: string, markerPath: string): ProjectPaths {
	const globalDir = path.join(projectsRoot(), id);
	return {
		id,
		root,
		configDir,
		markerPath,
		globalDir,
		memoryDir: path.join(globalDir, "memory"),
		thoughtsDir: path.join(globalDir, "thoughts"),
		queueDir: path.join(globalDir, "queue"),
		dbPath: path.join(globalDir, "memory.db"),
		configFile: path.join(globalDir, "memory.json"),
		stateFile: path.join(globalDir, "state.json"),
		projectJson: path.join(globalDir, "project.json"),
	};
}

/** Resolve project identity for a cwd (read-only — does not create anything). */
export function resolveProject(cwd: string): ProjectPaths {
	const root = findProjectRoot(cwd);
	const configDir = path.join(root, CONFIG_DIR_NAME);
	const existing = readMarker(configDir);
	const id = existing?.id ?? `${slug(path.basename(root))}-${pathHash(root)}`;
	const markerPath = existing?.file ?? path.join(configDir, `${id}.md`);
	return pathsForId(id, root, configDir, markerPath);
}

/** Paths for the reserved cross-project ("global") scope. */
export function globalScope(): ProjectPaths {
	const id = GLOBAL_PROJECT_ID;
	const globalDir = path.join(projectsRoot(), id);
	return pathsForId(id, globalDir, globalDir, path.join(globalDir, "MARKER"));
}

function markerBody(id: string, createdISO: string): string {
	return [
		"---",
		"pi-project: true",
		`id: ${id}`,
		`created: ${createdISO}`,
		"---",
		"# pi memory project",
		"",
		"This file marks this directory as a pi memory project. To keep your working tree clean,",
		"all memory artifacts are stored globally — NOT here — under:",
		"",
		`    ~/.pi/projects/${id}/`,
		"",
		"- `memory/entries/` durable memory (markdown, source of truth)",
		"- `memory/MEMORY.md` generated index",
		"- `thoughts/`        per-session journals",
		"- `memory.db`        optional search index",
		"",
		"Managed by @aprimediet/memory. Safe to commit (stable id) and safe to delete (recreated).",
		"",
	].join("\n");
}

interface ProjectMeta {
	id: string;
	name: string;
	paths: string[];
	created: string;
	lastSeen: string;
}

/** Create the global directory structure + the cwd marker (idempotent). Returns the paths. */
export async function ensureProject(cwd: string): Promise<ProjectPaths> {
	const p = resolveProject(cwd);
	const nowISO = new Date().toISOString();

	for (const dir of [path.join(p.memoryDir, "entries"), p.thoughtsDir, p.queueDir]) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// marker in cwd (the only thing we write into the working tree)
	if (!fs.existsSync(p.markerPath)) {
		fs.mkdirSync(p.configDir, { recursive: true });
		await withFileMutationQueue(p.markerPath, async () => {
			const tmp = `${p.markerPath}.tmp`;
			await fs.promises.writeFile(tmp, markerBody(p.id, nowISO), { encoding: "utf-8", mode: 0o644 });
			await fs.promises.rename(tmp, p.markerPath);
		});
	}

	// project.json metadata (track every path this project has been seen at)
	let meta: ProjectMeta = { id: p.id, name: path.basename(p.root), paths: [], created: nowISO, lastSeen: nowISO };
	try {
		meta = { ...meta, ...(JSON.parse(fs.readFileSync(p.projectJson, "utf-8")) as ProjectMeta) };
	} catch {
		/* first run */
	}
	if (!meta.paths.includes(p.root)) meta.paths.push(p.root);
	meta.lastSeen = nowISO;
	try {
		await withFileMutationQueue(p.projectJson, async () => {
			const tmp = `${p.projectJson}.tmp`;
			await fs.promises.writeFile(tmp, JSON.stringify(meta, null, 2), { encoding: "utf-8", mode: 0o600 });
			await fs.promises.rename(tmp, p.projectJson);
		});
	} catch {
		/* non-fatal */
	}

	return p;
}

export function ensureGlobalScope(): ProjectPaths {
	const g = globalScope();
	fs.mkdirSync(path.join(g.memoryDir, "entries"), { recursive: true });
	return g;
}
