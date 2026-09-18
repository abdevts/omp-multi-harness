import { describe, expect, test } from "bun:test";
import {
	AgentError,
	authRequired,
	executableNotFound,
	fromSpawnError,
	invalidCwd,
	invalidOutput,
	looksLikeAuthFailure,
	processFailed,
	timedOut,
	workspaceBusy,
} from "../src/process/process-error.ts";

describe("looksLikeAuthFailure", () => {
	test.each([
		"Error: not logged in. Please run codex login",
		"authentication required",
		"401 Unauthorized",
		"No credentials found",
		"session expired, please log in again",
	])("recognizes %s", (stderr) => {
		expect(looksLikeAuthFailure(stderr)).toBe(true);
	});

	test.each(["TypeError: cannot read property", "test suite failed: 3 assertions", ""])(
		"does not mistake %s for an auth problem",
		(stderr) => {
			expect(looksLikeAuthFailure(stderr)).toBe(false);
		},
	);
});

describe("error messages name the fix", () => {
	test("missing executable points at install or config", () => {
		const e = executableNotFound("codex", "codex");
		expect(e.code).toBe("EXECUTABLE_NOT_FOUND");
		expect(e.message).toContain("multiHarness.codex.executable");
	});

	test("auth error names the login command and disclaims auto-login", () => {
		const e = authRequired("claude");
		expect(e.message).toContain("claude auth login");
		expect(e.message).toContain("never logs in on your behalf");
	});

	test("timeout names the config knob", () => {
		expect(timedOut("codex", 1_800_000).message).toContain("multiHarness.codex.timeoutMs");
	});

	test("workspace busy names the holder and the escape hatches", () => {
		const e = workspaceBusy("claude", "run r7c2, codex");
		expect(e.message).toContain("r7c2");
		expect(e.message).toContain("/sessions");
	});

	test("every constructor produces an AgentError carrying its code", () => {
		const errors = [
			executableNotFound("codex", "codex"),
			authRequired("codex"),
			processFailed("codex", 3, "boom"),
			timedOut("codex", 1000),
			invalidOutput("codex", "empty stream"),
			invalidCwd("codex", "/nope", "does not exist"),
			workspaceBusy("codex", "run r1"),
		];
		for (const e of errors) {
			expect(e).toBeInstanceOf(AgentError);
			expect(e.agent).toBe("codex");
			expect(e.message.length).toBeGreaterThan(10);
		}
	});
});

describe("fromSpawnError", () => {
	test("ENOENT becomes EXECUTABLE_NOT_FOUND", () => {
		const err = Object.assign(new Error("spawn"), { code: "ENOENT" });
		expect(fromSpawnError("codex", "codex", err).code).toBe("EXECUTABLE_NOT_FOUND");
	});

	test("EACCES explains the permission problem", () => {
		const err = Object.assign(new Error("spawn"), { code: "EACCES" });
		expect(fromSpawnError("claude", "/bin/claude", err).message).toContain("not executable");
	});

	test("anything else is a process failure that keeps the cause", () => {
		const err = Object.assign(new Error("weird"), { code: "EPIPE" });
		const mapped = fromSpawnError("claude", "claude", err);
		expect(mapped.code).toBe("PROCESS_FAILED");
		expect(mapped.cause).toBe(err);
	});
});
