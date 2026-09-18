/**
 * OMP ↔ worker session mapping (T-407). See _spec/08-sessions-and-parallelism.md.
 *
 * One JSON file per `(ompSessionId, realpath(cwd))` pair under the **runtime-resolved**
 * agent dir, so `continueSession: true` survives an OMP restart. Only ids, the cwd and
 * timestamps are persisted — never task text, tokens, keys, env or cookies.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentName } from "../agents/types.ts";

/** A worker session id plus when we last saw it. */
export interface WorkerSessionRef {
	sessionId: string;
	/** ISO 8601. */
	updatedAt: string;
}

/** The persisted record. Anything not on this shape must never reach disk. */
export interface HarnessSession {
	version: 1;
	ompSessionId: string;
	cwd: string;
	workers: {
		codex?: WorkerSessionRef;
		claude?: WorkerSessionRef;
	};
}

export interface SessionStoreOptions {
	/**
	 * Root to store under, in place of the resolved agent dir. Tests pass a temp dir;
	 * production leaves it unset so `--profile` / `PI_CODING_AGENT_DIR` are honored.
	 */
	baseDir?: string;
	/** Non-fatal problems (corrupt file, rejected id, unwritable dir) land here. */
	onWarning?: (message: string) => void;
}

export interface SessionStore {
	/** Absolute path of the file backing this key. Resolves the agent dir on first use. */
	path(ompSessionId: string, cwd: string): Promise<string>;
	/** The mapping, or undefined when there is none — including when the file is corrupt. */
	get(ompSessionId: string, cwd: string): Promise<HarnessSession | undefined>;
	/** Convenience: just the worker session id for one agent. */
	workerSessionId(ompSessionId: string, cwd: string, agent: AgentName): Promise<string | undefined>;
	/** Upsert one agent's worker session id. Returns the record as persisted. */
	record(ompSessionId: string, cwd: string, agent: AgentName, workerSessionId: string): Promise<HarnessSession | undefined>;
	/** Drop one agent's mapping, or the whole record when `agent` is omitted. */
	clear(ompSessionId: string, cwd: string, agent?: AgentName): Promise<boolean>;
}

/** Worker session ids are UUIDs (Claude) or opaque thread ids (Codex) — nothing else. */
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** OMP session ids are opaque; cap them so a hostile id cannot bloat the file. */
const OMP_SESSION_ID = /^[\x20-\x7e]{1,256}$/;

/** `<agentDir>/multi-harness/sessions`. */
const SUBDIR = join("multi-harness", "sessions");

let cachedAgentDir: Promise<string> | undefined;

/**
 * The active agent dir, resolved at runtime so `--profile` and `PI_CODING_AGENT_DIR` are
 * honored. Prefers OMP's own `getAgentDir` (it knows about profiles); falls back to the env
 * var, then `~/.omp/agent`. Never hard-code the last one at a call site.
 */
export async function resolveAgentDir(): Promise<string> {
	cachedAgentDir ??= (async () => {
		// PI_CODING_AGENT_DIR is checked FIRST, before OMP's own resolver, for one concrete
		// reason: upstream `getAgentDir()` reads the env var once at module load and memoizes
		// it forever. Set before the process starts (the production case) both orders agree.
		// Changed afterwards, the upstream value is frozen and no reset seam of ours can undo
		// it — so consulting the env directly is what makes this resolver actually honor the
		// variable, rather than only appearing to. Env beats --profile in OMP too, so the
		// precedence is unchanged; when the var is absent we still defer to OMP for profiles.
		const fromEnv = process.env.PI_CODING_AGENT_DIR;
		if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);

		// The coding-agent index is the canonical re-export and is already loaded inside OMP;
		// `pi-utils/dirs` is the same resolver without pulling the whole agent in, which
		// matters for tests and scripts where the native addon may be missing.
		for (const specifier of ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-utils/dirs"]) {
			try {
				const mod = (await import(specifier)) as { getAgentDir?: () => string };
				const dir = mod.getAgentDir?.();
				if (typeof dir === "string" && dir.length > 0) return dir;
			} catch {
				// Not importable here — try the next source.
			}
		}
		return join(homedir(), ".omp", "agent");
	})();
	return cachedAgentDir;
}

/** Test seam: forget the memoized agent dir so a changed env is picked up again. */
export function resetAgentDirCache(): void {
	cachedAgentDir = undefined;
}

/**
 * Canonical cwd for keying. Symlinked and relative paths must land on the same key as the
 * real path, or two runs in one repo would get two mappings.
 */
export function normalizeCwd(cwd: string): string {
	const absolute = resolve(cwd);
	try {
		return realpathSync(absolute);
	} catch {
		// Not on disk (yet) — the resolved path is still a stable key.
		return absolute;
	}
}

/** Stable, non-reversible file name for a key. The id and path never appear in it. */
export function sessionKey(ompSessionId: string, cwd: string): string {
	return createHash("sha256").update(`${ompSessionId}\0${normalizeCwd(cwd)}`).digest("hex").slice(0, 32);
}

/** Only the shape above survives a round trip; anything else is treated as corrupt. */
function parseSession(raw: unknown): HarnessSession | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.version !== 1) return undefined;
	if (typeof value.ompSessionId !== "string" || typeof value.cwd !== "string") return undefined;
	const workers: HarnessSession["workers"] = {};
	const rawWorkers = typeof value.workers === "object" && value.workers !== null ? (value.workers as Record<string, unknown>) : {};
	for (const agent of ["codex", "claude"] as const) {
		const entry = rawWorkers[agent];
		if (typeof entry !== "object" || entry === null) continue;
		const { sessionId, updatedAt } = entry as Record<string, unknown>;
		if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) continue;
		workers[agent] = { sessionId, updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString() };
	}
	return { version: 1, ompSessionId: value.ompSessionId, cwd: value.cwd, workers };
}

/** Write via temp + rename so a crash mid-write can never leave a half file in place. */
function writeAtomic(file: string, body: string): void {
	const tmp = `${file}.${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		writeFileSync(tmp, body, { mode: 0o600 });
		renameSync(tmp, file);
		// rename keeps the temp file's mode, but an existing target could predate this code.
		chmodSync(file, 0o600);
	} catch (e) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// best effort
		}
		throw e;
	}
}

/**
 * Create a session store. All methods are async because the agent dir is resolved lazily;
 * none of them ever throw — I/O problems degrade to "no mapping" plus a warning, because a
 * missing resume is an inconvenience while a thrown error would kill the run.
 */
export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
	const warn = options.onWarning ?? (() => {});

	async function dir(): Promise<string> {
		const base = options.baseDir ?? (await resolveAgentDir());
		const target = join(base, SUBDIR);
		mkdirSync(target, { recursive: true, mode: 0o700 });
		// mkdir's mode is masked by umask and skipped for existing dirs; be explicit.
		chmodSync(target, 0o700);
		chmodSync(join(base, "multi-harness"), 0o700);
		return target;
	}

	async function path(ompSessionId: string, cwd: string): Promise<string> {
		return join(await dir(), `${sessionKey(ompSessionId, cwd)}.json`);
	}

	async function read(ompSessionId: string, cwd: string): Promise<HarnessSession | undefined> {
		let file: string;
		try {
			file = await path(ompSessionId, cwd);
		} catch (e) {
			warn(`multi-harness: session store unavailable (${(e as Error).message}) — continuing without session mapping`);
			return undefined;
		}
		let body: string;
		try {
			body = readFileSync(file, "utf8");
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") warn(`multi-harness: could not read ${file} (${code ?? (e as Error).message}) — treating as no mapping`);
			return undefined;
		}
		try {
			const parsed = parseSession(JSON.parse(body));
			if (!parsed) {
				warn(`multi-harness: ${file} is not a v1 session record — treating as no mapping`);
				return undefined;
			}
			return parsed;
		} catch {
			warn(`multi-harness: ${file} is corrupt JSON — treating as no mapping`);
			return undefined;
		}
	}

	return {
		path,
		get: read,

		async workerSessionId(ompSessionId, cwd, agent) {
			return (await read(ompSessionId, cwd))?.workers[agent]?.sessionId;
		},

		async record(ompSessionId, cwd, agent, workerSessionId) {
			if (!SESSION_ID.test(workerSessionId)) {
				warn(`multi-harness: refusing to persist a malformed ${agent} session id — not saved`);
				return undefined;
			}
			if (!OMP_SESSION_ID.test(ompSessionId)) {
				warn("multi-harness: refusing to persist a malformed OMP session id — not saved");
				return undefined;
			}
			const existing = await read(ompSessionId, cwd);
			// Built field by field on purpose: only ids, cwd and timestamps may reach disk.
			const next: HarnessSession = {
				version: 1,
				ompSessionId,
				cwd: normalizeCwd(cwd),
				workers: { ...existing?.workers, [agent]: { sessionId: workerSessionId, updatedAt: new Date().toISOString() } },
			};
			try {
				writeAtomic(await path(ompSessionId, cwd), `${JSON.stringify(next, null, "\t")}\n`);
			} catch (e) {
				warn(`multi-harness: could not persist the session mapping (${(e as Error).message}) — resume will not survive a restart`);
				return undefined;
			}
			return next;
		},

		async clear(ompSessionId, cwd, agent) {
			let file: string;
			try {
				file = await path(ompSessionId, cwd);
			} catch {
				return false;
			}
			if (agent) {
				const existing = await read(ompSessionId, cwd);
				if (!existing?.workers[agent]) return false;
				const workers = { ...existing.workers };
				delete workers[agent];
				try {
					writeAtomic(file, `${JSON.stringify({ ...existing, workers }, null, "\t")}\n`);
					return true;
				} catch (e) {
					warn(`multi-harness: could not clear the ${agent} session mapping (${(e as Error).message})`);
					return false;
				}
			}
			try {
				rmSync(file, { force: true });
				return true;
			} catch (e) {
				warn(`multi-harness: could not remove ${file} (${(e as Error).message})`);
				return false;
			}
		},
	};
}
