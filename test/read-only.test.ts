/**
 * T-602: `readOnlyEnforced` must reflect what the provider actually enforced, never what
 * was merely requested. Covers both adapters' argv, the honest-enforcement helpers, and
 * the fork / fresh-session behavior for `AgentRequest.fork` (_plan/phase-6-hardening.md,
 * _spec/02-agent-interface.md, _spec/10-errors-and-security.md).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CodexAgent, buildCodexArgs, codexCapabilities, codexReadOnlyEnforcement } from "../src/agents/codex.ts";
import { ClaudeAgent, buildClaudeArgs, claudeCapabilities, claudeReadOnlyEnforcement } from "../src/agents/claude.ts";
import { DEFAULTS } from "../src/config/schema.ts";

const BIN = join(import.meta.dir, "fixtures", "bin");
const REPO = join(import.meta.dir, "..");

const codexCaps = codexCapabilities("codex-cli 0.155.0");
const codexBase = { agent: "codex" as const, task: "look around", cwd: REPO };

const claudeCaps = claudeCapabilities("2.1.274 (Claude Code)");
const claudeBase = { agent: "claude" as const, task: "look around", cwd: REPO };
const SESSION = "3f2b1a44-0000-4000-8000-000000000009";

describe("codex — exact argv for read-only vs write", () => {
	test("read-only run passes `-s read-only` (verified via `codex exec --help`)", () => {
		const args = buildCodexArgs({ request: codexBase, config: DEFAULTS.codex, capabilities: codexCaps, readOnly: true });
		expect(args).toEqual(["exec", "--json", "-C", REPO, "-s", "read-only", "-"]);
	});

	test("write run passes `-s workspace-write`, never a bypass flag", () => {
		const args = buildCodexArgs({ request: codexBase, config: DEFAULTS.codex, capabilities: codexCaps, readOnly: false });
		expect(args).toEqual(["exec", "--json", "-C", REPO, "-s", "workspace-write", "-"]);
	});
});

describe("codex — codexReadOnlyEnforcement is derived from argv, not the request", () => {
	test("true only when `-s read-only` is actually present", () => {
		const args = buildCodexArgs({ request: codexBase, config: DEFAULTS.codex, capabilities: codexCaps, readOnly: true });
		expect(codexReadOnlyEnforcement(args, true)).toEqual({ enforced: true, mechanism: "-s read-only" });
	});

	test("a write run reports false", () => {
		const args = buildCodexArgs({ request: codexBase, config: DEFAULTS.codex, capabilities: codexCaps, readOnly: false });
		expect(codexReadOnlyEnforcement(args, false)).toEqual({ enforced: false });
	});

	test("a requested-but-unenforceable read-only run reports false, never optimistically true", () => {
		// Simulates a codex build that dropped/renamed `-s`: the capability says so, so the
		// flag never makes it into argv, and enforcement must not be claimed.
		const noSandbox = { ...codexCaps, supportsSandboxMode: false };
		const args = buildCodexArgs({ request: codexBase, config: DEFAULTS.codex, capabilities: noSandbox, readOnly: true });
		expect(args).not.toContain("-s");
		expect(codexReadOnlyEnforcement(args, true)).toEqual({ enforced: false });
	});
});

describe("codex — fork has no equivalent, so it starts a fresh session", () => {
	test("fork: true omits `resume <id>` even though a sessionId was supplied", () => {
		const args = buildCodexArgs({
			request: { ...codexBase, sessionId: "prior-thread" },
			config: DEFAULTS.codex,
			capabilities: codexCaps,
			readOnly: true,
			fork: true,
		});
		expect(args).not.toContain("resume");
		expect(args).not.toContain("prior-thread");
	});

	test("without fork, the same sessionId resumes normally", () => {
		const args = buildCodexArgs({
			request: { ...codexBase, sessionId: "prior-thread" },
			config: DEFAULTS.codex,
			capabilities: codexCaps,
			readOnly: true,
		});
		expect(args.slice(0, 3)).toEqual(["exec", "resume", "prior-thread"]);
	});
});

describe("claude — exact argv for read-only vs write", () => {
	test("read-only run passes `--permission-mode plan` and a read-only `--tools` allowlist", () => {
		const args = buildClaudeArgs({ request: claudeBase, config: DEFAULTS.claude, capabilities: claudeCaps, readOnly: true, sessionId: SESSION });
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

	test("write run carries neither flag", () => {
		const args = buildClaudeArgs({ request: claudeBase, config: DEFAULTS.claude, capabilities: claudeCaps, readOnly: false, sessionId: SESSION });
		expect(args).not.toContain("--permission-mode");
		expect(args).not.toContain("--tools");
	});
});

describe("claude — claudeReadOnlyEnforcement is derived from argv, not the request", () => {
	test("true only when both the plan mode and the tools allowlist are present", () => {
		const args = buildClaudeArgs({ request: claudeBase, config: DEFAULTS.claude, capabilities: claudeCaps, readOnly: true, sessionId: SESSION });
		expect(claudeReadOnlyEnforcement(args, true)).toEqual({
			enforced: true,
			mechanism: "--permission-mode plan --tools Read,Grep,Glob",
		});
	});

	test("a write run reports false", () => {
		const args = buildClaudeArgs({ request: claudeBase, config: DEFAULTS.claude, capabilities: claudeCaps, readOnly: false, sessionId: SESSION });
		expect(claudeReadOnlyEnforcement(args, false)).toEqual({ enforced: false });
	});

	test("a requested-but-unenforceable read-only run reports false, never optimistically true", () => {
		// Simulates a claude build without --permission-mode support: no enforcing flags are
		// emitted, so honesty requires reporting false even though readOnly was requested.
		const noPermissionMode = { ...claudeCaps, supportsPermissionMode: false };
		const args = buildClaudeArgs({ request: claudeBase, config: DEFAULTS.claude, capabilities: noPermissionMode, readOnly: true, sessionId: SESSION });
		expect(args).not.toContain("--permission-mode");
		expect(args).not.toContain("--tools");
		expect(claudeReadOnlyEnforcement(args, true)).toEqual({ enforced: false });
	});
});

describe("claude — fork emits --fork-session only when resuming", () => {
	test("fork: true with a sessionId adds --fork-session", () => {
		const args = buildClaudeArgs({
			request: { ...claudeBase, sessionId: "prior-session" },
			config: DEFAULTS.claude,
			capabilities: claudeCaps,
			readOnly: true,
			sessionId: SESSION,
			fork: true,
		});
		expect(args).toContain("--fork-session");
	});

	test("fork: true with no sessionId to resume is a no-op flag-wise (nothing to fork)", () => {
		const args = buildClaudeArgs({ request: claudeBase, config: DEFAULTS.claude, capabilities: claudeCaps, readOnly: true, sessionId: SESSION, fork: true });
		expect(args).not.toContain("--fork-session");
	});
});

describe("end-to-end against the fake CLIs: honest metadata", () => {
	const originalPath = process.env.PATH;
	afterEach(() => {
		delete process.env.FAKE_MODE;
		process.env.PATH = originalPath;
	});

	test("codex read-only run reports readOnlyEnforced true with its mechanism", async () => {
		const agent = new CodexAgent({ ...DEFAULTS.codex, executable: join(BIN, "codex") });
		const result = await agent.run({ ...codexBase, readOnly: true }, { signal: new AbortController().signal });
		expect(result.metadata?.readOnlyEnforced).toBe(true);
		expect(result.metadata?.readOnlyMechanism).toBe("-s read-only");
	});

	test("codex write run reports readOnlyEnforced false", async () => {
		const agent = new CodexAgent({ ...DEFAULTS.codex, executable: join(BIN, "codex") });
		const result = await agent.run({ ...codexBase, readOnly: false }, { signal: new AbortController().signal });
		expect(result.metadata?.readOnlyEnforced).toBe(false);
		expect(result.metadata?.readOnlyMechanism).toBeUndefined();
	});

	test("codex fork: true reports metadata.forked = true and starts fresh", async () => {
		const agent = new CodexAgent({ ...DEFAULTS.codex, executable: join(BIN, "codex") });
		const result = await agent.run(
			{ ...codexBase, sessionId: "prior-thread-does-not-exist", fork: true, readOnly: true },
			{ signal: new AbortController().signal },
		);
		expect(result.metadata?.forked).toBe(true);
		// The fake CLI echoes back the default thread id when no `resume <id>` was given,
		// proving `resume` (and the stale id) never reached argv.
		expect(result.sessionId).toBe("01a0b606-9c69-7c20-98e0-9426e6cb7bd6");
	});

	test("claude read-only run reports readOnlyEnforced true with its mechanism", async () => {
		const agent = new ClaudeAgent({ ...DEFAULTS.claude, executable: join(BIN, "claude") });
		const result = await agent.run({ ...claudeBase, readOnly: true }, { signal: new AbortController().signal });
		expect(result.metadata?.readOnlyEnforced).toBe(true);
		expect(result.metadata?.readOnlyMechanism).toBe("--permission-mode plan --tools Read,Grep,Glob");
	});

	test("claude write run reports readOnlyEnforced false", async () => {
		const agent = new ClaudeAgent({ ...DEFAULTS.claude, executable: join(BIN, "claude") });
		const result = await agent.run({ ...claudeBase, readOnly: false }, { signal: new AbortController().signal });
		expect(result.metadata?.readOnlyEnforced).toBe(false);
		expect(result.metadata?.readOnlyMechanism).toBeUndefined();
	});

	test("claude fork: true against a resumed session reports metadata.forked = true", async () => {
		const agent = new ClaudeAgent({ ...DEFAULTS.claude, executable: join(BIN, "claude") });
		const result = await agent.run(
			{ ...claudeBase, sessionId: "prior-session", fork: true, readOnly: false },
			{ signal: new AbortController().signal },
		);
		expect(result.metadata?.forked).toBe(true);
	});
});
