import { describe, expect, test } from "bun:test";
import { deepMerge } from "../src/config/load.ts";
import { DEFAULTS, isValidModelToken, normalizeConfig } from "../src/config/schema.ts";

describe("normalizeConfig", () => {
	test("empty input yields defaults with no warnings", () => {
		const { config, warnings } = normalizeConfig({});
		expect(config).toEqual(DEFAULTS);
		expect(warnings).toEqual([]);
	});

	test("partial override keeps sibling defaults", () => {
		const { config } = normalizeConfig({ codex: { timeoutMs: 60_000 } });
		expect(config.codex.timeoutMs).toBe(60_000);
		expect(config.codex.executable).toBe("codex");
		expect(config.claude).toEqual(DEFAULTS.claude);
	});

	test("invalid value falls back and warns instead of throwing", () => {
		const { config, warnings } = normalizeConfig({ codex: { timeoutMs: "soon" }, debug: "yes" });
		expect(config.codex.timeoutMs).toBe(DEFAULTS.codex.timeoutMs);
		expect(config.debug).toBe(false);
		expect(warnings.some((w) => w.includes("codex.timeoutMs"))).toBe(true);
		expect(warnings.some((w) => w.includes("debug"))).toBe(true);
	});

	test("unknown top-level key warns but is ignored", () => {
		const { warnings } = normalizeConfig({ nonsense: 1 });
		expect(warnings).toEqual(["multiHarness.nonsense: unknown option — ignored"]);
	});

	test("model override must be a model token", () => {
		expect(normalizeConfig({ codex: { model: "gpt-5.2" } }).config.codex.model).toBe("gpt-5.2");
		const bad = normalizeConfig({ codex: { model: "rm -rf /" } });
		expect(bad.config.codex.model).toBeNull();
		expect(bad.warnings.some((w) => w.includes("codex.model"))).toBe(true);
	});

	test("model defaults to null so the CLI's own config decides", () => {
		expect(DEFAULTS.codex.model).toBeNull();
		expect(DEFAULTS.claude.model).toBeNull();
	});

	test("routing mode and default are validated", () => {
		expect(normalizeConfig({ routing: { mode: "rules" } }).config.routing.mode).toBe("rules");
		const bad = normalizeConfig({ routing: { mode: "vibes", default: "gemini" } });
		expect(bad.config.routing.mode).toBe("model");
		expect(bad.config.routing.default).toBe("auto");
		expect(bad.warnings.length).toBe(2);
	});

	test("modeMap merges per-mode and rejects unknown agents", () => {
		const { config, warnings } = normalizeConfig({ routing: { modeMap: { review: "codex", debug: "gemini", wat: "codex" } } });
		expect(config.routing.modeMap.review).toBe("codex");
		expect(config.routing.modeMap.debug).toBe("codex"); // default kept
		expect(config.routing.modeMap.plan).toBe("claude");
		expect(warnings.some((w) => w.includes("modeMap.debug"))).toBe(true);
		expect(warnings.some((w) => w.includes("modeMap.wat"))).toBe(true);
	});

	test("default router model is the @smol role with a concrete fallback chain", () => {
		expect(DEFAULTS.routing.model).toBe("@smol");
		expect(DEFAULTS.routing.modelFallbacks[0]).toBe("anthropic/claude-haiku-4-5");
	});

	test("parallel writes are off by default", () => {
		expect(DEFAULTS.concurrency.allowParallelWrites).toBe(false);
		expect(DEFAULTS.concurrency.allowParallelReads).toBe(true);
	});
});

describe("isValidModelToken", () => {
	test.each([
		["gpt-5.2", true],
		["anthropic/claude-haiku-4-5", true],
		["@smol", true],
		["provider/id:thinking", true],
		["", false],
		["model; rm -rf /", false],
		["a b", false],
		["$(whoami)", false],
	])("%s → %s", (value, expected) => {
		expect(isValidModelToken(value as string)).toBe(expected);
	});
});

describe("deepMerge", () => {
	test("project config wins over user config, per leaf", () => {
		const merged = deepMerge({ codex: { enabled: true, timeoutMs: 1 }, debug: false }, { codex: { timeoutMs: 2 } });
		expect(merged).toEqual({ codex: { enabled: true, timeoutMs: 2 }, debug: false });
	});

	test("arrays replace rather than concatenate", () => {
		expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
	});
});
