import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveExecutable } from "../src/process/executable.ts";

const BIN = join(import.meta.dir, "fixtures", "bin");

describe("resolveExecutable", () => {
	test("finds a bare name on PATH", () => {
		expect(resolveExecutable("codex", { PATH: BIN })).toBe(join(BIN, "codex"));
	});

	test("returns null when the name is not on PATH", () => {
		expect(resolveExecutable("codex", { PATH: "/nonexistent" })).toBeNull();
	});

	test("accepts an absolute path and verifies it is executable", () => {
		expect(resolveExecutable(join(BIN, "claude"), {})).toBe(join(BIN, "claude"));
	});

	test("rejects a path that exists but is not executable", () => {
		expect(resolveExecutable(join(import.meta.dir, "..", "package.json"), {})).toBeNull();
	});

	test("rejects a directory", () => {
		expect(resolveExecutable(BIN, {})).toBeNull();
	});

	test("handles PATH entries containing spaces and empty segments", () => {
		expect(resolveExecutable("codex", { PATH: `:/no such dir:${BIN}:` })).toBe(join(BIN, "codex"));
	});

	test("empty name resolves to null", () => {
		expect(resolveExecutable("", { PATH: BIN })).toBeNull();
	});
});
