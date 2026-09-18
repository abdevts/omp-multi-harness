import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../src/process/process-error.ts";
import { createWriteLockTable, workspaceKey } from "../src/runs/lock.ts";

const CWD = realpathSync(tmpdir());

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

describe("workspaceKey", () => {
	test("normalizes through symlinks so one tree is one lock", () => {
		const dir = mkdtempSync(join(realpathSync(tmpdir()), "mh-lock-"));
		const link = `${dir}-link`;
		symlinkSync(dir, link);
		expect(workspaceKey(link)).toBe(realpathSync(dir));
	});

	test("falls back to an absolute path for a directory that does not exist", () => {
		expect(workspaceKey("/definitely/not/here")).toBe("/definitely/not/here");
	});
});

describe("write lock", () => {
	test("grants an uncontended lock immediately and reports the holder", async () => {
		const table = createWriteLockTable();
		expect(table.isHeld(CWD)).toBe(false);
		const release = await table.acquire(CWD, { agent: "codex", queue: true, holder: "codex r1" });
		expect(table.isHeld(CWD)).toBe(true);
		expect(table.holder(CWD)).toBe("codex r1");
		release();
		expect(table.isHeld(CWD)).toBe(false);
		expect(table.holder(CWD)).toBeUndefined();
	});

	test("serializes writers in FIFO order", async () => {
		const table = createWriteLockTable();
		const order: string[] = [];
		const first = await table.acquire(CWD, { agent: "codex", queue: true, holder: "a" });
		order.push("a-acquired");

		const b = table.acquire(CWD, { agent: "codex", queue: true, holder: "b" }).then((r) => {
			order.push("b-acquired");
			return r;
		});
		const c = table.acquire(CWD, { agent: "claude", queue: true, holder: "c" }).then((r) => {
			order.push("c-acquired");
			return r;
		});
		await tick();
		expect(order).toEqual(["a-acquired"]);
		expect(table.queueDepth(CWD)).toBe(2);

		first();
		(await b)();
		(await c)();
		expect(order).toEqual(["a-acquired", "b-acquired", "c-acquired"]);
		expect(table.isHeld(CWD)).toBe(false);
	});

	test("different workspaces do not contend", async () => {
		const table = createWriteLockTable();
		const a = mkdtempSync(join(CWD, "mh-lock-a-"));
		const b = mkdtempSync(join(CWD, "mh-lock-b-"));
		const releaseA = await table.acquire(a, { agent: "codex", queue: true });
		const releaseB = await table.acquire(b, { agent: "claude", queue: true });
		expect(table.isHeld(a)).toBe(true);
		expect(table.isHeld(b)).toBe(true);
		releaseA();
		releaseB();
	});

	test("queue:false rejects with WORKSPACE_BUSY naming the holder", async () => {
		const table = createWriteLockTable();
		const release = await table.acquire(CWD, { agent: "codex", queue: true, holder: "codex r7c1" });
		const err = await table.acquire(CWD, { agent: "claude", queue: false }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentError);
		expect((err as AgentError).code).toBe("WORKSPACE_BUSY");
		expect((err as AgentError).message).toContain("codex r7c1");
		release();
		// The refusal must not have consumed the lock or left a phantom waiter.
		expect(table.isHeld(CWD)).toBe(false);
	});

	test("release is idempotent — a second call cannot steal the next holder's lock", async () => {
		const table = createWriteLockTable();
		const first = await table.acquire(CWD, { agent: "codex", queue: true, holder: "a" });
		const second = table.acquire(CWD, { agent: "codex", queue: true, holder: "b" });
		first();
		const releaseB = await second;
		expect(table.holder(CWD)).toBe("b");
		first();
		first();
		expect(table.holder(CWD)).toBe("b");
		releaseB();
		expect(table.isHeld(CWD)).toBe(false);
	});

	test("a throwing critical section still releases when the caller uses finally", async () => {
		const table = createWriteLockTable();
		await expect(
			(async () => {
				const release = await table.acquire(CWD, { agent: "codex", queue: true });
				try {
					throw new Error("boom");
				} finally {
					release();
				}
			})(),
		).rejects.toThrow("boom");
		expect(table.isHeld(CWD)).toBe(false);
		// And the workspace is usable again.
		(await table.acquire(CWD, { agent: "claude", queue: true }))();
	});

	test("aborting a queued writer removes it and never deadlocks the ones behind it", async () => {
		const table = createWriteLockTable();
		const release = await table.acquire(CWD, { agent: "codex", queue: true, holder: "a" });
		const controller = new AbortController();
		const aborted = table.acquire(CWD, { agent: "codex", queue: true, holder: "b", signal: controller.signal });
		const third = table.acquire(CWD, { agent: "claude", queue: true, holder: "c" });
		await tick();

		controller.abort();
		const err = await aborted.catch((e: unknown) => e);
		expect((err as AgentError).code).toBe("CANCELLED");
		expect(table.queueDepth(CWD)).toBe(1);

		release();
		const releaseC = await third;
		expect(table.holder(CWD)).toBe("c");
		releaseC();
		expect(table.isHeld(CWD)).toBe(false);
	});

	test("an already-aborted signal is rejected before joining the queue", async () => {
		const table = createWriteLockTable();
		const err = await table
			.acquire(CWD, { agent: "codex", queue: true, signal: AbortSignal.abort() })
			.catch((e: unknown) => e);
		expect((err as AgentError).code).toBe("CANCELLED");
		expect(table.isHeld(CWD)).toBe(false);
	});
});
