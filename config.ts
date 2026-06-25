/**
 * Configuration resolution.
 *
 * Precedence (re-read every call, so edits apply with no reload):
 *   bundled default → global default ~/.pi/agent/memory.json
 *   → per-project ~/.pi/projects/<id>/memory.json → env (MEMORY_MODEL / MEMORY_DISABLED) → flags.
 *
 * Note: per-project config lives in the GLOBAL per-project dir, not in the working tree — the
 * working tree only ever holds the project marker. See project.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveProject } from "./project.ts";

export type CaptureMode = "tool" | "background" | "both";
export type InjectionScope = "project" | "global" | "both";

export interface MemoryConfig {
	enabled: boolean;
	model: string;
	capture: CaptureMode;
	injection: { scope: InjectionScope; digestMaxEntries: number };
	pruning: { ttlDays: number; maxEntries: number; consolidateEverySessions: number };
	useFtsIndex: boolean;
}

const HERE =
	typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_CONFIG_FILE = path.join(HERE, "memory.json");

const DEFAULT_CONFIG: MemoryConfig = {
	enabled: true,
	model: "claude-haiku-4-5",
	capture: "both",
	injection: { scope: "both", digestMaxEntries: 20 },
	pruning: { ttlDays: 90, maxEntries: 200, consolidateEverySessions: 10 },
	useFtsIndex: false,
};

export function bundledConfigFile(): string {
	return BUNDLED_CONFIG_FILE;
}
export function globalDefaultConfigFile(): string {
	return path.join(getAgentDir(), "memory.json");
}

// ----------------------------------------------------------------- flag overrides

interface FlagOverrides {
	model?: string;
	disabled?: boolean;
	capture?: CaptureMode;
}
let flags: FlagOverrides = {};
export function setFlagOverrides(next: FlagOverrides): void {
	flags = {
		model: next.model && next.model.trim() ? next.model.trim() : undefined,
		disabled: next.disabled === true ? true : undefined,
		capture: next.capture,
	};
}

// ----------------------------------------------------------------- config merge

function readPartial(file: string): Partial<MemoryConfig> {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<MemoryConfig>;
	} catch {
		return {};
	}
}

function merge(base: MemoryConfig, over: Partial<MemoryConfig>): MemoryConfig {
	return {
		enabled: over.enabled ?? base.enabled,
		model: over.model ?? base.model,
		capture: over.capture ?? base.capture,
		injection: { ...base.injection, ...(over.injection ?? {}) },
		pruning: { ...base.pruning, ...(over.pruning ?? {}) },
		useFtsIndex: over.useFtsIndex ?? base.useFtsIndex,
	};
}

function truthy(v: string | undefined): boolean {
	return v === "1" || v?.toLowerCase() === "true";
}

export function resolveConfig(cwd: string): MemoryConfig {
	let cfg = DEFAULT_CONFIG;
	cfg = merge(cfg, readPartial(BUNDLED_CONFIG_FILE));
	cfg = merge(cfg, readPartial(globalDefaultConfigFile()));
	cfg = merge(cfg, readPartial(resolveProject(cwd).configFile));

	const envModel = process.env.MEMORY_MODEL?.trim();
	const model = flags.model ?? (envModel || cfg.model);
	const disabled = flags.disabled === true || truthy(process.env.MEMORY_DISABLED);
	const capture = flags.capture ?? cfg.capture;

	return { ...cfg, model, capture, enabled: cfg.enabled && !disabled };
}
