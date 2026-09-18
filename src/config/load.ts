/**
 * Reads the `multiHarness` block from OMP's config files.
 *
 * OMP's ExtensionAPI exposes no config accessor and its `Settings.get()` is typed to known
 * setting paths, so the extension reads the YAML itself: user config first, project config
 * merged over it (_spec/09-config.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MultiHarnessConfig, type NormalizeResult, normalizeConfig } from "./schema.ts";

/**
 * Active OMP agent directory. Honors PI_CODING_AGENT_DIR; `omp --profile <name>` moves this
 * to ~/.omp/profiles/<name>/agent, so callers must never hard-code ~/.omp/agent.
 */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

export function configPaths(cwd: string): { user: string; project: string } {
	return { user: join(agentDir(), "config.yml"), project: join(cwd, ".omp", "config.yml") };
}

function readYaml(path: string, warnings: string[]): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		warnings.push(`${path}: not a YAML mapping — ignored`);
	} catch (e) {
		warnings.push(`${path}: ${(e as Error).message} — ignored`);
	}
	return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge, `over` winning. Arrays replace rather than concatenate. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) {
		const prev = out[k];
		out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
	}
	return out;
}

export interface LoadedConfig extends NormalizeResult {
	config: MultiHarnessConfig;
	/** Config files that actually existed, in merge order. */
	sources: string[];
}

export function loadConfig(cwd: string): LoadedConfig {
	const warnings: string[] = [];
	const sources: string[] = [];
	const { user, project } = configPaths(cwd);

	let raw: Record<string, unknown> = {};
	for (const path of [user, project]) {
		const doc = readYaml(path, warnings);
		if (!doc) continue;
		sources.push(path);
		const block = doc.multiHarness;
		if (block === undefined) continue;
		if (!isPlainObject(block)) {
			warnings.push(`${path}: multiHarness must be a mapping — ignored`);
			continue;
		}
		raw = deepMerge(raw, block);
	}

	const normalized = normalizeConfig(raw);
	return { ...normalized, warnings: [...warnings, ...normalized.warnings], sources };
}
