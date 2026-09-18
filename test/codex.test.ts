import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CodexAgent, buildCodexArgs, codexCapabilities } from "../src/agents/codex.ts";
import { applyCodexEvent, isQuotaFailure, newCodexStreamState } from "../src/agents/codex-events.ts";
import { DEFAULTS } from "../src/config/schema.ts";
import { parseJsonl } from "../src/process/jsonl.ts";

const BIN = join(import.meta.dir, "fixtures", "bin");
const REPO = join(import.meta.dir, "..");
const caps = codexCapabilities("codex-cli 0.155.0");
const base = { agent: "codex" as const, task: "do the thing", cwd: REPO };

describe("buildCodexArgs", () => {
	test("new read-only run", () => {
		const args = buildCodexArgs({ request: base, config: DEFAULTS.codex, capabilities: caps, lastMessageFile: "/tmp/x", readOnly: true });
		expect(args).toEqual(["exec", "--json", "-C", REPO, "-s", "read-only", "-o", "/tmp/x", "-"]);
	});

	test("write run uses workspace-write, never a bypass flag", () => {
		const args = buildCodexArgs({ request: base, config: DEFAULTS.codex, capabilities: caps, readOnly: false });
		expect(args).toContain("workspace-write");
		expect(args.join(" ")).not.toContain("dangerously");
	});

	test("resume puts the session id right after `exec`", () => {
		const args = buildCodexArgs({
			request: { ...base, sessionId: "01a0-thread" },
			config: DEFAULTS.codex,
			capabilities: caps,
			readOnly: true,
		});
		expect(args.slice(0, 3)).toEqual(["exec", "resume", "01a0-thread"]);
	});

	test("no model flag unless one is configured or passed", () => {
		expect(buildCodexArgs({ request: base, config: DEFAULTS.codex, capabilities: caps, readOnly: true })).not.toContain("-m");
		expect(
			buildCodexArgs({ request: base, config: { ...DEFAULTS.codex, model: "gpt-5.2" }, capabilities: caps, readOnly: true }),
		).toContain("gpt-5.2");
		// A per-call model wins over config.
		const args = buildCodexArgs({
			request: { ...base, model: "o4" },
			config: { ...DEFAULTS.codex, model: "gpt-5.2" },
			capabilities: caps,
			readOnly: true,
		});
		expect(args[args.indexOf("-m") + 1]).toBe("o4");
	});

	test("--skip-git-repo-check only outside a repo, and the prompt is never in argv", () => {
		const outside = buildCodexArgs({ request: base, config: DEFAULTS.codex, capabilities: caps, readOnly: true, skipGitRepoCheck: true });
		expect(outside).toContain("--skip-git-repo-check");
		expect(outside.at(-1)).toBe("-");
		expect(outside.join(" ")).not.toContain("do the thing");
	});
});

describe("codex event stream", () => {
	// Exactly what codex-cli 0.155.0 emitted during verification.
	const REAL_FAILURE = [
		'{"type":"thread.started","thread_id":"01a0b606-9c69-7c20-98e0-9426e6cb7bd6"}',
		'{"type":"turn.started"}',
		'{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened"}}',
		'{"type":"error","message":"Your workspace is out of credits. Ask your workspace owner to refill in order to continue."}',
		'{"type":"turn.failed","error":{"message":"Your workspace is out of credits."}}',
	].join("\n");

	test("captures the thread id and the terminal failure", () => {
		const state = newCodexStreamState();
		for (const value of parseJsonl(REAL_FAILURE).values) applyCodexEvent(state, value);
		expect(state.sessionId).toBe("01a0b606-9c69-7c20-98e0-9426e6cb7bd6");
		expect(state.failure).toContain("out of credits");
		expect(state.turnCompleted).toBe(false);
	});

	test("an `error` ITEM is informational, not a terminal failure", () => {
		const state = newCodexStreamState();
		applyCodexEvent(state, JSON.parse('{"type":"item.completed","item":{"type":"error","message":"skills truncated"}}'));
		expect(state.failure).toBeUndefined();
	});

	test("collects the last agent message and a completion", () => {
		const state = newCodexStreamState();
		applyCodexEvent(state, { type: "item.completed", item: { type: "agent_message", text: "first" } });
		applyCodexEvent(state, { type: "item.completed", item: { type: "agent_message", text: "second" } });
		applyCodexEvent(state, { type: "turn.completed" });
		expect(state.lastAgentMessage).toBe("second");
		expect(state.turnCompleted).toBe(true);
		expect(state.itemCount).toBe(2);
	});

	test("progress phases are human-readable", () => {
		const state = newCodexStreamState();
		expect(applyCodexEvent(state, { type: "item.completed", item: { type: "command_execution", command: "ls" } })).toEqual({
			phase: "running a command",
			detail: "ls",
			raw: "item.completed:command_execution",
		});
	});

	test("unknown events and junk are ignored", () => {
		const state = newCodexStreamState();
		expect(applyCodexEvent(state, { type: "something.new" })).toBeNull();
		expect(applyCodexEvent(state, "not an object")).toBeNull();
		expect(state.failure).toBeUndefined();
	});

	test("quota failures are recognized", () => {
		expect(isQuotaFailure("Your workspace is out of credits.")).toBe(true);
		expect(isQuotaFailure("rate limit exceeded")).toBe(true);
		expect(isQuotaFailure("the tests failed")).toBe(false);
	});
});

describe("CodexAgent.run against a fake CLI", () => {
	const env = { ...process.env, PATH: `${BIN}:${process.env.PATH}` };
	const originalPath = process.env.PATH;
	afterEach(() => {
		delete process.env.FAKE_MODE;
		process.env.PATH = originalPath;
	});
	const agent = (mode?: string) => {
		process.env.PATH = `${BIN}:${env.PATH}`;
		if (mode) process.env.FAKE_MODE = mode;
		else delete process.env.FAKE_MODE;
		return new CodexAgent({ ...DEFAULTS.codex, executable: join(BIN, "codex") });
	};

	test("success: final message from -o, session id from the stream, progress emitted", async () => {
		const phases: string[] = [];
		const result = await agent("success").run(
			{ ...base, task: "summarize" },
			{ signal: new AbortController().signal, onProgress: (p) => phases.push(p.phase) },
		);
		expect(result.success).toBe(true);
		expect(result.output).toBe("Final answer for: summarize");
		expect(result.sessionId).toBe("01a0b606-9c69-7c20-98e0-9426e6cb7bd6");
		expect(result.metadata?.items).toBe(2);
		expect(phases).toContain("running a command");
		expect(phases).toContain("completed");
	});

	test("quota failure surfaces PROVIDER_LIMIT, not a generic failure", async () => {
		await expect(agent("quota").run(base, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "PROVIDER_LIMIT",
		});
	});

	test("auth failure in the stream surfaces AUTH_REQUIRED", async () => {
		await expect(agent("auth").run(base, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "AUTH_REQUIRED",
		});
	});

	test("malformed lines do not break the run — it recovers the streamed answer", async () => {
		const result = await agent("malformed").run(base, { signal: new AbortController().signal });
		expect(result.output).toBe("recovered answer");
		expect(result.metadata?.parseErrors).toBe(1);
	});

	test("a run with no final message is INVALID_OUTPUT", async () => {
		await expect(agent("empty").run(base, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "INVALID_OUTPUT",
		});
	});

	test("cancellation is reported as CANCELLED", async () => {
		const controller = new AbortController();
		const promise = agent("hang").run({ ...base, timeoutMs: 30_000 }, { signal: controller.signal });
		await Bun.sleep(300);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
	});

	test("timeout is reported as TIMEOUT", async () => {
		await expect(agent("hang").run({ ...base, timeoutMs: 400 }, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "TIMEOUT",
		});
	});
});
