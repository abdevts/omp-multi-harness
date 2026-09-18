/**
 * Live integration tests. Skipped unless MULTI_HARNESS_LIVE_TESTS=1.
 * These call the real CLIs and cost real money — never run them in CI.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgent } from "../src/agents/claude.ts";
import { CodexAgent } from "../src/agents/codex.ts";
import { DEFAULTS } from "../src/config/schema.ts";

const LIVE = process.env.MULTI_HARNESS_LIVE_TESTS === "1";
const describeLive = LIVE ? describe : describe.skip;

function scratchRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "multi-harness-live-"));
	writeFileSync(join(dir, "README.md"), "# Scratch\n\nThe magic word is bananaphone.\n");
	return dir;
}

describeLive("live: Claude Code", () => {
	test(
		"read-only run returns an answer, a session id, and leaves the tree alone",
		async () => {
			const cwd = scratchRepo();
			const result = await new ClaudeAgent(DEFAULTS.claude).run(
				{
					agent: "claude",
					task: "Read README.md in this directory and reply with only the magic word it contains.",
					cwd,
					mode: "analyze",
					readOnly: true,
					timeoutMs: 180_000,
				},
				{ signal: AbortSignal.timeout(180_000) },
			);

			expect(result.success).toBe(true);
			expect(result.output.toLowerCase()).toContain("bananaphone");
			expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
			expect(result.metadata?.readOnlyEnforced).toBe(true);
		},
		200_000,
	);
});

describeLive("live: Codex", () => {
	test(
		"read-only run returns an answer and a thread id",
		async () => {
			const cwd = scratchRepo();
			const result = await new CodexAgent(DEFAULTS.codex).run(
				{
					agent: "codex",
					task: "Read README.md in this directory and reply with only the magic word it contains.",
					cwd,
					mode: "analyze",
					readOnly: true,
					timeoutMs: 180_000,
				},
				{ signal: AbortSignal.timeout(180_000) },
			);

			expect(result.success).toBe(true);
			expect(result.output.toLowerCase()).toContain("bananaphone");
			expect(result.sessionId).toBeDefined();
		},
		200_000,
	);
});
