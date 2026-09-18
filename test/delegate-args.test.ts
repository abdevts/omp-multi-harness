import { describe, expect, test } from "bun:test";
import { parseDelegateArgs } from "../src/commands/delegate-command.ts";
import { buildHandoff, summarize, truncateMiddle } from "../src/routing/handoff.ts";

describe("parseDelegateArgs", () => {
	test("bare task", () => {
		const p = parseDelegateArgs("fix the failing unit tests");
		expect(p.task).toBe("fix the failing unit tests");
		expect(p.readOnly).toBeUndefined();
		expect(p.errors).toEqual([]);
	});

	test("flags are stripped only from the front, never from the task", () => {
		const p = parseDelegateArgs("--read-only explain why --new is confusing");
		expect(p.readOnly).toBe(true);
		expect(p.task).toBe("explain why --new is confusing");
		expect(p.newSession).toBe(false);
	});

	test("--model validates its value", () => {
		expect(parseDelegateArgs("--model gpt-5.2 do it").model).toBe("gpt-5.2");
		expect(parseDelegateArgs("--model ; rm -rf / do it").errors.length).toBe(1);
		expect(parseDelegateArgs("--model").errors).toEqual(["--model needs a value"]);
	});

	test("--mode validates against the known modes", () => {
		expect(parseDelegateArgs("--mode review look at auth").mode).toBe("review");
		expect(parseDelegateArgs("--mode vibes look at auth").errors.length).toBe(1);
	});

	test("unknown flags are reported rather than silently treated as task text", () => {
		expect(parseDelegateArgs("--yolo go").errors).toEqual(["unknown flag --yolo"]);
	});
});

describe("handoff", () => {
	test("mode preamble precedes the task and forbids edits for read-only modes", () => {
		const text = buildHandoff({ task: "look at auth", mode: "review", maxChars: 1000 });
		expect(text.startsWith("Review the code")).toBe(true);
		expect(text).toContain("Do not modify any files");
		expect(text).toContain("Task:\nlook at auth");
	});

	test("context is included but capped", () => {
		const text = buildHandoff({ task: "t", context: "x".repeat(5000), maxChars: 500 });
		expect(text).toContain("characters omitted");
		expect(text.length).toBeLessThan(1200);
	});

	test("no context section when none is given", () => {
		expect(buildHandoff({ task: "t", maxChars: 100 })).toBe("Task:\nt");
	});
});

describe("truncateMiddle", () => {
	test("keeps head and tail", () => {
		const { text, truncated } = truncateMiddle(`START${"x".repeat(5000)}END`, 1000);
		expect(truncated).toBe(true);
		expect(text.startsWith("START")).toBe(true);
		expect(text.endsWith("END")).toBe(true);
	});

	test("short text is untouched", () => {
		expect(truncateMiddle("short", 1000)).toEqual({ text: "short", truncated: false });
	});
});

describe("summarize", () => {
	test("collapses whitespace and ellipsizes", () => {
		expect(summarize("a\n  b\tc")).toBe("a b c");
		expect(summarize("x".repeat(100)).length).toBe(60);
	});
});
