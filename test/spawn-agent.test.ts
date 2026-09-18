import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { RingBuffer, SpawnCwdError, spawnAgent } from "../src/process/spawn-agent.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const REPO = join(import.meta.dir, "..");

describe("RingBuffer", () => {
	test("keeps the tail once the cap is exceeded", () => {
		const b = new RingBuffer(10);
		b.push("aaaaa");
		b.push("bbbbb");
		b.push("ccccc");
		expect(b.text.endsWith("ccccc")).toBe(true);
		expect(Buffer.byteLength(b.text)).toBeLessThanOrEqual(15);
	});

	test("never drops the only chunk, however large", () => {
		const b = new RingBuffer(4);
		b.push("0123456789");
		expect(b.text).toBe("0123456789");
	});
});

describe("spawnAgent", () => {
	test("passes argv as an array and feeds stdin, without a shell", async () => {
		const r = await spawnAgent({
			command: join(FIXTURES, "echo-args.sh"),
			// A shell would mangle every one of these.
			args: ["--task", "a b; rm -rf /", "$(whoami)", "with space"],
			cwd: REPO,
			stdin: "prompt from stdin\n",
		});
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("--task a b; rm -rf / $(whoami) with space");
		expect(r.stdout).toContain("STDIN:prompt from stdin");
	});

	test("runs in the requested cwd", async () => {
		const r = await spawnAgent({ command: join(FIXTURES, "echo-args.sh"), args: [], cwd: FIXTURES });
		expect(r.stdout).toContain(`CWD:${require("node:fs").realpathSync(FIXTURES)}`);
	});

	test("preserves a non-zero exit code and captures stderr separately", async () => {
		const r = await spawnAgent({ command: join(FIXTURES, "fail.sh"), args: [], cwd: REPO });
		expect(r.exitCode).toBe(3);
		expect(r.stdout).toContain("partial output");
		expect(r.stderr).toContain("not logged in");
		expect(r.stdout).not.toContain("not logged in");
	});

	test("rejects a working directory that does not exist", async () => {
		await expect(spawnAgent({ command: "echo", args: [], cwd: join(REPO, "does-not-exist") })).rejects.toBeInstanceOf(
			SpawnCwdError,
		);
	});

	test("reports ENOENT for a missing executable", async () => {
		await expect(
			spawnAgent({ command: join(FIXTURES, "definitely-not-here"), args: [], cwd: REPO }),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("an already-aborted signal short-circuits before spawning", async () => {
		const r = await spawnAgent({ command: join(FIXTURES, "hang-with-child.sh"), args: [], cwd: REPO, signal: AbortSignal.abort() });
		expect(r.cancelled).toBe(true);
		expect(r.exitCode).toBeNull();
		expect(r.durationMs).toBe(0);
	});

	test("timeout terminates the run", async () => {
		const r = await spawnAgent({
			command: join(FIXTURES, "hang-with-child.sh"),
			args: [],
			cwd: REPO,
			timeoutMs: 300,
			killGraceMs: 200,
		});
		expect(r.timedOut).toBe(true);
		expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
	});

	test("abort mid-run cancels and kills the whole process group", async () => {
		const controller = new AbortController();
		const promise = spawnAgent({
			command: join(FIXTURES, "hang-with-child.sh"),
			args: [],
			cwd: REPO,
			signal: controller.signal,
			killGraceMs: 200,
		});
		// Let the fixture start its grandchild and print the pid.
		await Bun.sleep(400);
		controller.abort();
		const r = await promise;

		expect(r.cancelled).toBe(true);
		const pid = /child:(\d+)/.exec(r.stdout)?.[1];
		expect(pid).toBeDefined();

		// The grandchild must be gone too, not merely orphaned.
		await Bun.sleep(400);
		let alive = true;
		try {
			execSync(`ps -p ${pid}`, { stdio: "ignore" });
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});

	test("streams stdout chunks to the callback", async () => {
		const chunks: string[] = [];
		await spawnAgent({
			command: join(FIXTURES, "echo-args.sh"),
			args: ["hello"],
			cwd: REPO,
			stdin: "",
			onStdout: (c) => chunks.push(c),
		});
		expect(chunks.join("")).toContain("hello");
	});
});
