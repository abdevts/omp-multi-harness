import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClaudeAgent, buildClaudeArgs, claudeCapabilities } from "../src/agents/claude.ts";
import { applyClaudeEvent, newClaudeStreamState } from "../src/agents/claude-events.ts";
import { DEFAULTS } from "../src/config/schema.ts";
import { parseJsonl } from "../src/process/jsonl.ts";

const BIN = join(import.meta.dir, "fixtures", "bin");
const REPO = join(import.meta.dir, "..");
const caps = claudeCapabilities("2.1.274 (Claude Code)");
const base = { agent: "claude" as const, task: "review this", cwd: REPO };
const SESSION = "3f2b1a44-0000-4000-8000-000000000001";

describe("buildClaudeArgs", () => {
	test("new read-only run gates both permission mode and tools", () => {
		const args = buildClaudeArgs({ request: base, config: DEFAULTS.claude, capabilities: caps, readOnly: true, sessionId: SESSION });
		expect(args).toEqual([
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--session-id",
			SESSION,
			"--permission-mode",
			"plan",
			"--tools",
			"Read,Grep,Glob",
		]);
	});

	test("never passes a working directory flag — Claude Code has no -C", () => {
		const args = buildClaudeArgs({ request: base, config: DEFAULTS.claude, capabilities: caps, readOnly: false, sessionId: SESSION });
		expect(args).not.toContain("-C");
		expect(args).not.toContain("--cd");
	});

	test("write run stays on the default permission mode unless acceptEdits is configured", () => {
		expect(
			buildClaudeArgs({ request: base, config: DEFAULTS.claude, capabilities: caps, readOnly: false, sessionId: SESSION }),
		).not.toContain("--permission-mode");
		expect(
			buildClaudeArgs({
				request: base,
				config: { ...DEFAULTS.claude, acceptEdits: true },
				capabilities: caps,
				readOnly: false,
				sessionId: SESSION,
			}),
		).toContain("acceptEdits");
	});

	test("never passes a permission bypass flag", () => {
		const all = [true, false].map((readOnly) =>
			buildClaudeArgs({ request: base, config: { ...DEFAULTS.claude, acceptEdits: true }, capabilities: caps, readOnly, sessionId: SESSION }).join(" "),
		);
		for (const args of all) expect(args).not.toContain("dangerously");
	});

	test("resume replaces --session-id, and forking is explicit", () => {
		const resumed = buildClaudeArgs({
			request: { ...base, sessionId: "prior-session" },
			config: DEFAULTS.claude,
			capabilities: caps,
			readOnly: true,
			sessionId: SESSION,
		});
		expect(resumed).toContain("--resume");
		expect(resumed).not.toContain("--session-id");
		expect(resumed).not.toContain("--fork-session");

		const forked = buildClaudeArgs({
			request: { ...base, sessionId: "prior-session" },
			config: DEFAULTS.claude,
			capabilities: caps,
			readOnly: true,
			sessionId: SESSION,
			fork: true,
		});
		expect(forked).toContain("--fork-session");
	});

	test("model comes from the call, then config, else not at all", () => {
		expect(buildClaudeArgs({ request: base, config: DEFAULTS.claude, capabilities: caps, readOnly: true, sessionId: SESSION })).not.toContain("--model");
		const args = buildClaudeArgs({
			request: { ...base, model: "opus" },
			config: { ...DEFAULTS.claude, model: "sonnet" },
			capabilities: caps,
			readOnly: true,
			sessionId: SESSION,
		});
		expect(args[args.indexOf("--model") + 1]).toBe("opus");
	});
});

describe("claude event stream", () => {
	// Abridged from a real 2.1.274 run.
	const REAL = [
		'{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup","session_id":"3f2b1a44-0000-4000-8000-000000000002"}',
		'{"type":"system","subtype":"init","session_id":"3f2b1a44-0000-4000-8000-000000000002"}',
		'{"type":"system","subtype":"thinking_tokens"}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}',
		'{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"3f2b1a44-0000-4000-8000-000000000002","num_turns":1,"duration_ms":8243,"total_cost_usd":0.43,"permission_denials":[]}',
	].join("\n");

	test("reads the session id, the final result, turns and cost", () => {
		const state = newClaudeStreamState();
		for (const value of parseJsonl(REAL).values) applyClaudeEvent(state, value);
		expect(state.sessionId).toBe("3f2b1a44-0000-4000-8000-000000000002");
		expect(state.result).toBe("pong");
		expect(state.turns).toBe(1);
		expect(state.costUsd).toBeCloseTo(0.43, 2);
		expect(state.failure).toBeUndefined();
		expect(state.sawResult).toBe(true);
	});

	test("hook chatter produces no progress noise", () => {
		const state = newClaudeStreamState();
		expect(applyClaudeEvent(state, { type: "system", subtype: "hook_started" })).toBeNull();
		expect(applyClaudeEvent(state, { type: "system", subtype: "thinking_tokens" })).toBeNull();
		expect(applyClaudeEvent(state, { type: "system", subtype: "init" })?.phase).toBe("starting");
	});

	test("tool use is named in the progress phase", () => {
		const state = newClaudeStreamState();
		const progress = applyClaudeEvent(state, { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep" }] } });
		expect(progress?.phase).toBe("using Grep");
	});

	test("an error result becomes a failure with its text", () => {
		const state = newClaudeStreamState();
		applyClaudeEvent(state, { type: "result", subtype: "error_max_turns", is_error: true, result: "hit the turn limit" });
		expect(state.failure).toBe("hit the turn limit");
	});

	test("permission denials are counted as read-only evidence", () => {
		const state = newClaudeStreamState();
		applyClaudeEvent(state, { type: "result", subtype: "success", result: "ok", permission_denials: [{ tool: "Edit" }, { tool: "Bash" }] });
		expect(state.permissionDenials).toBe(2);
	});
});

describe("ClaudeAgent.run against a fake CLI", () => {
	const originalPath = process.env.PATH;
	afterEach(() => {
		delete process.env.FAKE_MODE;
		process.env.PATH = originalPath;
	});
	const agent = (mode?: string) => {
		if (mode) process.env.FAKE_MODE = mode;
		return new ClaudeAgent({ ...DEFAULTS.claude, executable: join(BIN, "claude") });
	};

	test("success: result text, session id, turns, and progress", async () => {
		const phases: string[] = [];
		const result = await agent("success").run(
			{ ...base, task: "summarize" },
			{ signal: new AbortController().signal, onProgress: (p) => phases.push(p.phase) },
		);
		expect(result.success).toBe(true);
		expect(result.output).toBe("Answer for: summarize");
		expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.metadata?.turns).toBe(1);
		expect(phases).toContain("using Read");
		expect(phases).toContain("completed");
	});

	test("read-only run reports enforcement honestly", async () => {
		const result = await agent("success").run({ ...base, mode: "review" }, { signal: new AbortController().signal });
		expect(result.metadata?.readOnlyEnforced).toBe(true);
	});

	test("usage limit surfaces PROVIDER_LIMIT", async () => {
		await expect(agent("quota").run(base, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "PROVIDER_LIMIT",
		});
	});

	test("auth failure surfaces AUTH_REQUIRED", async () => {
		await expect(agent("auth").run(base, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "AUTH_REQUIRED",
		});
	});

	test("an empty result falls back to the streamed assistant text", async () => {
		const result = await agent("malformed").run(base, { signal: new AbortController().signal });
		expect(result.output).toBe("streamed fallback");
		expect(result.metadata?.parseErrors).toBe(1);
	});

	test("no result event at all is INVALID_OUTPUT", async () => {
		await expect(agent("noresult").run(base, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "INVALID_OUTPUT",
		});
	});

	test("cancellation and timeout are reported distinctly", async () => {
		const controller = new AbortController();
		const promise = agent("hang").run({ ...base, timeoutMs: 30_000 }, { signal: controller.signal });
		await Bun.sleep(300);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });

		process.env.FAKE_MODE = "hang";
		await expect(agent().run({ ...base, timeoutMs: 400 }, { signal: new AbortController().signal })).rejects.toMatchObject({
			code: "TIMEOUT",
		});
	});
});
