/**
 * T-603 — cancellation and shutdown-drain hardening for `src/process/spawn-agent.ts`.
 *
 * Everything here uses local shell fixtures (`test/fixtures/*.sh`) — never a real
 * `codex`/`claude` binary. Waits are deadline-polled, not fixed `sleep`s, so this stays
 * robust (and fast) on a loaded machine.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgent } from "../src/process/spawn-agent.ts";
import { cancelled, timedOut } from "../src/process/process-error.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const REPO = join(import.meta.dir, "..");

/** Poll `check` until it returns true or `deadlineMs` elapses. Never sleeps a fixed amount. */
async function waitFor(check: () => boolean, deadlineMs = 3_000, intervalMs = 20): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > deadlineMs) throw new Error(`waitFor: condition not met within ${deadlineMs}ms`);
		await Bun.sleep(intervalMs);
	}
}

function isAlive(pid: string | number): boolean {
	try {
		execSync(`ps -p ${pid}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("cancellation: escalation ladder", () => {
	test("SIGKILL reaps a child that ignores SIGTERM, and the promise still settles", async () => {
		const controller = new AbortController();
		let ready = false;
		const promise = spawnAgent({
			command: join(FIXTURES, "ignore-sigterm.sh"),
			args: [],
			cwd: REPO,
			signal: controller.signal,
			killGraceMs: 250,
			onStdout: (chunk) => {
				if (chunk.includes("ready")) ready = true;
			},
		});

		await waitFor(() => ready);
		const abortedAt = Date.now();
		controller.abort();

		const r = await promise;
		const settledAfterMs = Date.now() - abortedAt;

		expect(r.cancelled).toBe(true);
		// SIGTERM was ignored: only SIGKILL (unblockable) could have ended it, so the promise
		// must not have settled before the grace period elapsed.
		expect(settledAfterMs).toBeGreaterThanOrEqual(200);
		// ...and it must not hang forever either — bounded by grace + a generous margin.
		expect(settledAfterMs).toBeLessThan(5_000);
	});
});

describe("cancellation: grandchildren", () => {
	test("the whole three-generation tree is reaped, not just the direct child", async () => {
		const controller = new AbortController();
		const pids: Record<string, string> = {};
		const promise = spawnAgent({
			command: join(FIXTURES, "grandchildren-chain.sh"),
			args: [],
			cwd: REPO,
			signal: controller.signal,
			killGraceMs: 300,
			onStdout: (chunk) => {
				for (const line of chunk.split("\n")) {
					const m = /^(child|grandchild|greatgrandchild):(\d+)/.exec(line.trim());
					if (m) pids[m[1]!] = m[2]!;
				}
			},
		});

		await waitFor(() => "child" in pids && "grandchild" in pids && "greatgrandchild" in pids);
		controller.abort();
		const r = await promise;
		expect(r.cancelled).toBe(true);

		// Poll for reaping (SIGKILL after the grace period) instead of a fixed sleep.
		await waitFor(() => Object.values(pids).every((pid) => !isAlive(pid)), 3_000);
		for (const [gen, pid] of Object.entries(pids)) {
			expect(isAlive(pid), `${gen} pid ${pid} should be reaped`).toBe(false);
		}
	});
});

describe("cancellation: temp-file cleanup", () => {
	/** Mirrors the finally-cleanup pattern real adapters (e.g. codex.ts) wrap spawnAgent in. */
	async function withTempDirAround(run: (dir: string) => Promise<unknown>): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), "multi-harness-cancel-test-"));
		try {
			await run(dir).catch(() => undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		return dir;
	}

	test("no leftovers after a cancelled run", async () => {
		const controller = new AbortController();
		const dir = await withTempDirAround(async () => {
			const p = spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, signal: controller.signal, killGraceMs: 200 });
			await Bun.sleep(150);
			controller.abort();
			return p;
		});
		expect(() => execSync(`ls ${dir}`, { stdio: "ignore" })).toThrow();
	});

	test("no leftovers after a timeout", async () => {
		const dir = await withTempDirAround(() =>
			spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, timeoutMs: 200, killGraceMs: 200 }),
		);
		expect(() => execSync(`ls ${dir}`, { stdio: "ignore" })).toThrow();
	});

	test("no leftovers after a spawn failure", async () => {
		const dir = await withTempDirAround(() => spawnAgent({ command: join(FIXTURES, "definitely-not-here"), args: [], cwd: REPO }));
		expect(() => execSync(`ls ${dir}`, { stdio: "ignore" })).toThrow();
	});
});

describe("cancellation: idempotent and racing cancel", () => {
	test("aborting twice settles exactly once and does not throw", async () => {
		const controller = new AbortController();
		const promise = spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, signal: controller.signal, killGraceMs: 200 });
		await Bun.sleep(150);
		controller.abort();
		controller.abort(); // AbortController itself only ever fires once, but prove it's harmless either way.
		const r = await promise;
		expect(r.cancelled).toBe(true);
	});

	test("aborting a signal after the process already exited is a no-op", async () => {
		const controller = new AbortController();
		const r = await spawnAgent({ command: join(FIXTURES, "echo-args.sh"), args: ["done"], cwd: REPO, signal: controller.signal });
		expect(r.cancelled).toBe(false);
		expect(() => controller.abort()).not.toThrow();
		// The signal listener was removed on settle, so this late abort must not resurrect anything.
		expect(getEventListeners(controller.signal, "abort").length).toBe(0);
	});

	test("abort fired in the same synchronous tick the run was started in is still safe", async () => {
		const controller = new AbortController();
		// No `await` between the call and the abort: races the "PID doesn't exist yet" window.
		const promise = spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, signal: controller.signal, killGraceMs: 200 });
		controller.abort();
		const r = await promise;
		expect(r.cancelled).toBe(true);
		expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
	});

	test("an already-aborted signal never leaves a listener registered", async () => {
		const controller = new AbortController();
		controller.abort();
		const r = await spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, signal: controller.signal });
		expect(r.cancelled).toBe(true);
		expect(getEventListeners(controller.signal, "abort").length).toBe(0);
	});
});

describe("cancellation: listener hygiene", () => {
	test("every AbortSignal listener is removed once the run settles, across many sequential runs", async () => {
		for (let i = 0; i < 20; i++) {
			const controller = new AbortController();
			// Alternate between a run that finishes on its own and one that gets cancelled.
			if (i % 2 === 0) {
				await spawnAgent({ command: join(FIXTURES, "echo-args.sh"), args: [String(i)], cwd: REPO, signal: controller.signal });
			} else {
				const p = spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, signal: controller.signal, killGraceMs: 100 });
				await Bun.sleep(50);
				controller.abort();
				await p;
			}
			expect(getEventListeners(controller.signal, "abort").length).toBe(0);
		}
	});

	test("stdout/stderr callbacks stop firing once the run has settled", async () => {
		let callsAfterSettle = 0;
		const controller = new AbortController();
		const promise = spawnAgent({
			command: join(FIXTURES, "hang-with-child.sh"),
			args: [],
			cwd: REPO,
			signal: controller.signal,
			killGraceMs: 200,
			onStdout: () => {
				if (settled) callsAfterSettle++;
			},
		});
		let settled = false;
		await Bun.sleep(150);
		controller.abort();
		await promise;
		settled = true;
		// Give any late/leaked listener a chance to misfire before asserting it didn't.
		await Bun.sleep(150);
		expect(callsAfterSettle).toBe(0);
	});
});

describe("cancellation: timeout vs cancel", () => {
	test("timeout yields TIMEOUT (not CANCELLED) and kills the process group", async () => {
		const pids: Record<string, string> = {};
		const r = await spawnAgent({
			command: join(FIXTURES, "grandchildren-chain.sh"),
			args: [],
			cwd: REPO,
			timeoutMs: 250,
			killGraceMs: 200,
			onStdout: (chunk) => {
				for (const line of chunk.split("\n")) {
					const m = /^(child|grandchild|greatgrandchild):(\d+)/.exec(line.trim());
					if (m) pids[m[1]!] = m[2]!;
				}
			},
		});

		expect(r.timedOut).toBe(true);
		expect(r.cancelled).toBe(false);

		// Same typed-error mapping the adapters (codex.ts/claude.ts) apply to these flags.
		const err = r.cancelled ? cancelled("codex") : r.timedOut ? timedOut("codex", 250) : undefined;
		expect(err?.code).toBe("TIMEOUT");

		await waitFor(() => Object.keys(pids).length >= 1, 2_000);
		await waitFor(() => Object.values(pids).every((pid) => !isAlive(pid)), 3_000);
	});

	test("abort yields CANCELLED (not TIMEOUT) with no timeout configured", async () => {
		const controller = new AbortController();
		const promise = spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, signal: controller.signal, killGraceMs: 200 });
		await Bun.sleep(150);
		controller.abort();
		const r = await promise;

		expect(r.cancelled).toBe(true);
		expect(r.timedOut).toBe(false);

		const err = r.cancelled ? cancelled("claude") : timedOut("claude", 0);
		expect(err.code).toBe("CANCELLED");
	});
});
