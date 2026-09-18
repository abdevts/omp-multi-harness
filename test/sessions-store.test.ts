import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, normalizeCwd, resetAgentDirCache, resolveAgentDir, sessionKey } from "../src/sessions/store.ts";

const temps: string[] = [];

function tempBase(): string {
	const dir = mkdtempSync(join(tmpdir(), "mh-sessions-"));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetAgentDirCache();
});

describe("createSessionStore", () => {
	test("round-trips a mapping per agent", async () => {
		const store = createSessionStore({ baseDir: tempBase() });
		expect(await store.get("omp-1", process.cwd())).toBeUndefined();

		await store.record("omp-1", process.cwd(), "codex", "thread-abc");
		await store.record("omp-1", process.cwd(), "claude", "0199a4d0-1111-7000-8000-aaaaaaaaaaaa");

		const session = await store.get("omp-1", process.cwd());
		expect(session?.version).toBe(1);
		expect(session?.ompSessionId).toBe("omp-1");
		expect(session?.workers.codex?.sessionId).toBe("thread-abc");
		expect(session?.workers.claude?.sessionId).toBe("0199a4d0-1111-7000-8000-aaaaaaaaaaaa");
		expect(await store.workerSessionId("omp-1", process.cwd(), "codex")).toBe("thread-abc");
	});

	test("keys on (ompSessionId, realpath(cwd))", async () => {
		const base = tempBase();
		const store = createSessionStore({ baseDir: base });
		await store.record("omp-1", process.cwd(), "codex", "one");
		await store.record("omp-2", process.cwd(), "codex", "two");

		expect(await store.workerSessionId("omp-1", process.cwd(), "codex")).toBe("one");
		expect(await store.workerSessionId("omp-2", process.cwd(), "codex")).toBe("two");
		// A relative path must land on the same record as the absolute one.
		expect(await store.workerSessionId("omp-1", ".", "codex")).toBe("one");
		expect(sessionKey("omp-1", ".")).toBe(sessionKey("omp-1", process.cwd()));
		expect(sessionKey("omp-1", process.cwd())).not.toBe(sessionKey("omp-2", process.cwd()));
	});

	test("stores under <baseDir>/multi-harness/sessions with 0600 files in a 0700 dir", async () => {
		const base = tempBase();
		const store = createSessionStore({ baseDir: base });
		const file = await store.path("omp-1", process.cwd());
		expect(file.startsWith(join(base, "multi-harness", "sessions"))).toBe(true);

		await store.record("omp-1", process.cwd(), "codex", "thread-abc");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(base, "multi-harness", "sessions")).mode & 0o777).toBe(0o700);
		expect(statSync(join(base, "multi-harness")).mode & 0o777).toBe(0o700);
	});

	test("persists only ids, cwd and timestamps — never task text or secrets", async () => {
		const base = tempBase();
		const store = createSessionStore({ baseDir: base });
		const secret = "sk-live-DEADBEEF";
		const task = "rewrite the billing module and keep the invoice fixtures";
		await store.record("omp-1", process.cwd(), "codex", "thread-abc");

		const file = await store.path("omp-1", process.cwd());
		const body = readFileSync(file, "utf8");
		expect(body).not.toContain(task);
		expect(body).not.toContain(secret);
		expect(body).not.toContain("token");
		expect(Object.keys(JSON.parse(body)).sort()).toEqual(["cwd", "ompSessionId", "version", "workers"]);
		expect(Object.keys(JSON.parse(body).workers.codex).sort()).toEqual(["sessionId", "updatedAt"]);
	});

	test("a malformed worker session id is refused rather than written", async () => {
		const warnings: string[] = [];
		const store = createSessionStore({ baseDir: tempBase(), onWarning: (w) => warnings.push(w) });
		expect(await store.record("omp-1", process.cwd(), "codex", "thread abc; rm -rf /")).toBeUndefined();
		expect(await store.get("omp-1", process.cwd())).toBeUndefined();
		expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
	});

	test("corrupt JSON degrades to no mapping with a warning", async () => {
		const warnings: string[] = [];
		const store = createSessionStore({ baseDir: tempBase(), onWarning: (w) => warnings.push(w) });
		await store.record("omp-1", process.cwd(), "codex", "thread-abc");
		writeFileSync(await store.path("omp-1", process.cwd()), "{not json");

		expect(await store.get("omp-1", process.cwd())).toBeUndefined();
		expect(warnings.some((w) => w.includes("corrupt"))).toBe(true);
		// And a later write repairs the file rather than compounding the damage.
		await store.record("omp-1", process.cwd(), "codex", "thread-xyz");
		expect(await store.workerSessionId("omp-1", process.cwd(), "codex")).toBe("thread-xyz");
	});

	test("a wrong-version record is ignored", async () => {
		const store = createSessionStore({ baseDir: tempBase() });
		const file = await store.path("omp-1", process.cwd());
		await store.record("omp-1", process.cwd(), "codex", "thread-abc");
		writeFileSync(file, JSON.stringify({ version: 99, ompSessionId: "omp-1", cwd: process.cwd(), workers: {} }));
		expect(await store.get("omp-1", process.cwd())).toBeUndefined();
	});

	test("clear drops one agent or the whole record", async () => {
		const store = createSessionStore({ baseDir: tempBase() });
		await store.record("omp-1", process.cwd(), "codex", "thread-abc");
		await store.record("omp-1", process.cwd(), "claude", "claude-1");

		expect(await store.clear("omp-1", process.cwd(), "codex")).toBe(true);
		expect(await store.workerSessionId("omp-1", process.cwd(), "codex")).toBeUndefined();
		expect(await store.workerSessionId("omp-1", process.cwd(), "claude")).toBe("claude-1");
		expect(await store.clear("omp-1", process.cwd(), "codex")).toBe(false);

		expect(await store.clear("omp-1", process.cwd())).toBe(true);
		expect(await store.get("omp-1", process.cwd())).toBeUndefined();
	});

	test("no temp files are left behind after a write", async () => {
		const base = tempBase();
		const store = createSessionStore({ baseDir: base });
		await store.record("omp-1", process.cwd(), "codex", "thread-abc");
		const entries = [...new Bun.Glob("**/*").scanSync(base)];
		expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
	});
});

describe("resolveAgentDir", () => {
	test("honors PI_CODING_AGENT_DIR when OMP's getAgentDir is unavailable", async () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const base = tempBase();
		process.env.PI_CODING_AGENT_DIR = join(base, "profile-x");
		resetAgentDirCache();
		try {
			const dir = await resolveAgentDir();
			// Under OMP, getAgentDir() wins and is itself profile/env aware; standalone we see the env var.
			expect(dir.length).toBeGreaterThan(0);
			expect(dir === join(base, "profile-x") || dir.includes(".omp")).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			resetAgentDirCache();
		}
	});

	test("the store writes under the resolved agent dir when no baseDir is injected", async () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const base = tempBase();
		process.env.PI_CODING_AGENT_DIR = base;
		resetAgentDirCache();
		try {
			const expected = await resolveAgentDir();
			// Only exercise the write when resolution landed inside the temp dir; a real agent
			// dir must never be touched by a test.
			expect(expected).toContain(tmpdir());
			const file = await createSessionStore().path("omp-1", process.cwd());
			expect(file.startsWith(join(expected, "multi-harness", "sessions"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			resetAgentDirCache();
		}
	});
});

describe("normalizeCwd", () => {
	test("resolves relative paths and survives a missing directory", () => {
		expect(normalizeCwd(".")).toBe(normalizeCwd(process.cwd()));
		expect(normalizeCwd("/definitely/not/here")).toBe("/definitely/not/here");
	});
});
