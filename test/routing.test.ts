import { describe, expect, test } from "bun:test";
import type { AgentAvailability } from "../src/agents/types.ts";
import { DEFAULTS, type MultiHarnessConfig } from "../src/config/schema.ts";
import {
	buildRouterPrompt,
	parseRouterAnswer,
	resolveWorkerModel,
	route,
	routeByRules,
	usabilityFrom,
	type RouterModelFn,
} from "../src/routing/route.ts";

const config = (over: Partial<MultiHarnessConfig["routing"]> = {}): MultiHarnessConfig => ({
	...DEFAULTS,
	routing: { ...DEFAULTS.routing, ...over },
});

/** Rules-only config: no `askModel` is passed, so nothing can reach the network. */
const rules = config({ mode: "rules" });

const missing = (agent: "codex" | "claude"): AgentAvailability => ({
	agent,
	available: false,
	auth: "unknown",
	authDetail: "-",
	reason: `\`${agent}\` not found on PATH`,
});

describe("routeByRules", () => {
	test("an explicit agent always wins", () => {
		const d = routeByRules({ agent: "claude", task: "implement the endpoint and fix the failing tests" }, rules);
		expect(d.agent).toBe("claude");
		expect(d.routedBy).toBe("explicit");
	});

	test("mode maps before any keyword is read", () => {
		expect(routeByRules({ task: "implement the endpoint", mode: "plan" }, rules)).toMatchObject({
			agent: "claude",
			routedBy: "mode",
		});
		expect(routeByRules({ task: "think about the architecture", mode: "implement" }, rules)).toMatchObject({
			agent: "codex",
			routedBy: "mode",
		});
	});

	test("a user-configured modeMap overrides the built-in preference", () => {
		const flipped = config({ modeMap: { ...DEFAULTS.routing.modeMap, review: "codex" } });
		expect(routeByRules({ task: "look at auth", mode: "review" }, flipped).agent).toBe("codex");
	});

	test("keywords: implementation-shaped work goes to codex", () => {
		for (const task of [
			"Implement this endpoint.",
			"Fix the failing unit tests in the parser.",
			"Refactor the spawn helper and rename its arguments.",
		]) {
			expect(routeByRules({ task }, rules)).toMatchObject({ agent: "codex", routedBy: "rules" });
		}
	});

	test("keywords: analysis-shaped work goes to claude", () => {
		for (const task of [
			"Review whether this architecture will scale.",
			"Plan the migration strategy and weigh the trade-offs.",
			"Is this approach worth it?",
		]) {
			expect(routeByRules({ task }, rules)).toMatchObject({ agent: "claude", routedBy: "rules" });
		}
	});

	test("no signal falls through to routing.default", () => {
		expect(routeByRules({ task: "the thing" }, config({ default: "claude" })).agent).toBe("claude");
		expect(routeByRules({ task: "the thing" }, config({ default: "codex" })).agent).toBe("codex");
		// `default: "auto"` with nothing to go on still decides rather than refusing.
		expect(routeByRules({ task: "the thing" }, rules)).toMatchObject({ agent: "codex", routedBy: "rules" });
	});

	test("no fixed workflow is imposed: one task, one agent, and never a chain (spec 12-E)", () => {
		const d = routeByRules({ task: "Implement this endpoint." }, rules);
		expect(["codex", "claude"]).toContain(d.agent);
		expect(Object.keys(d)).toEqual(["ok", "agent", "routedBy", "reason"]);
	});
});

describe("router prompt and answer parsing", () => {
	test("the task text is capped at 1 000 characters", () => {
		const prompt = buildRouterPrompt({ task: "x".repeat(5_000) });
		expect(prompt).toContain("x".repeat(1_000));
		expect(prompt).not.toContain("x".repeat(1_001));
	});

	test("the mode is passed along when there is one", () => {
		expect(buildRouterPrompt({ task: "t", mode: "review" })).toContain("Mode: review");
	});

	test("only a single token parses", () => {
		expect(parseRouterAnswer("codex")).toBe("codex");
		expect(parseRouterAnswer("  Claude.\n")).toBe("claude");
		expect(parseRouterAnswer('"codex"')).toBe("codex");
		for (const junk of ["", "both", "I think codex is best here", "{\"agent\":\"codex\"}", "gpt-5.2"]) {
			expect(parseRouterAnswer(junk)).toBeUndefined();
		}
	});
});

describe("route with a router model", () => {
	const modelConfig = config({ mode: "model", modelTimeoutMs: 50 });

	test("a valid answer wins over the rules decision", async () => {
		const askModel: RouterModelFn = async () => "claude";
		const d = await route({ task: "Implement this endpoint." }, { config: modelConfig, askModel });
		expect(d).toMatchObject({ ok: true, agent: "claude", routedBy: "model" });
	});

	test("routing.mode: rules skips the call entirely", async () => {
		let called = false;
		const askModel: RouterModelFn = async () => {
			called = true;
			return "claude";
		};
		const d = await route({ task: "Implement this endpoint." }, { config: rules, askModel });
		expect(called).toBe(false);
		expect(d).toMatchObject({ agent: "codex", routedBy: "rules" });
	});

	test("an explicit agent skips the call entirely", async () => {
		let called = false;
		const askModel: RouterModelFn = async () => {
			called = true;
			return "claude";
		};
		const d = await route({ agent: "codex", task: "anything" }, { config: modelConfig, askModel });
		expect(called).toBe(false);
		expect(d).toMatchObject({ agent: "codex", routedBy: "explicit" });
	});

	test.each([
		["a rejected call (unresolvable model, unauthenticated host)", async () => Promise.reject(new Error("no model"))],
		["a thrown error", () => Promise.reject(new Error("boom"))],
		["an unparseable answer", async () => "I would use claude for this"],
		["an empty answer", async () => ""],
	])("falls back to rules on %s", async (_name, impl) => {
		const d = await route({ task: "Implement this endpoint." }, { config: modelConfig, askModel: impl as RouterModelFn });
		expect(d).toMatchObject({ ok: true, agent: "codex", routedBy: "rules" });
	});

	test("a slow call is abandoned at routing.modelTimeoutMs, not awaited", async () => {
		const askModel: RouterModelFn = () => new Promise<string>((resolve) => setTimeout(() => resolve("claude"), 5_000));
		const started = Date.now();
		const d = await route({ task: "Implement this endpoint." }, { config: modelConfig, askModel });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(d).toMatchObject({ agent: "codex", routedBy: "rules" });
	});

	test("no askModel dependency means no model path at all", async () => {
		const d = await route({ task: "Implement this endpoint." }, { config: modelConfig });
		expect(d).toMatchObject({ agent: "codex", routedBy: "rules" });
	});
});

describe("availability-aware fallback (T-504)", () => {
	test("an unavailable winner routes to the other agent and says why", async () => {
		const usability = usabilityFrom(DEFAULTS, { codex: missing("codex") });
		const d = await route({ task: "Implement this endpoint." }, { config: rules, usability });
		expect(d).toMatchObject({ ok: true, agent: "claude", routedBy: "fallback" });
		if (d.ok) expect(d.reason).toContain("not found on PATH");
	});

	test("a disabled agent is treated as unavailable", async () => {
		const disabled: MultiHarnessConfig = { ...rules, claude: { ...rules.claude, enabled: false } };
		const d = await route({ task: "Review whether this will scale." }, { config: disabled, usability: usabilityFrom(disabled) });
		expect(d).toMatchObject({ agent: "codex", routedBy: "fallback" });
	});

	test("neither available returns a typed refusal instead of throwing", async () => {
		const usability = usabilityFrom(DEFAULTS, { codex: missing("codex"), claude: missing("claude") });
		const d = await route({ task: "anything" }, { config: rules, usability });
		expect(d.ok).toBe(false);
		if (!d.ok) {
			expect(d.reason).toContain("No agent is available");
			expect(d.reason).toContain("/agents");
		}
	});

	test("an explicit choice is still subject to availability", async () => {
		const usability = usabilityFrom(DEFAULTS, { claude: missing("claude") });
		const d = await route({ agent: "claude", task: "plan it" }, { config: rules, usability });
		expect(d).toMatchObject({ agent: "codex", routedBy: "fallback" });
	});
});

describe("resolveWorkerModel (T-507)", () => {
	test("a per-call model wins over config", () => {
		expect(resolveWorkerModel("gpt-5.2", "o4-mini")).toMatchObject({ model: "gpt-5.2", source: "call" });
	});

	test("config is used when no per-call model is given", () => {
		expect(resolveWorkerModel(undefined, "o4-mini")).toMatchObject({ model: "o4-mini", source: "config" });
	});

	test("with neither, the flag is omitted entirely so the CLI's own config decides", () => {
		const choice = resolveWorkerModel(undefined, null);
		expect(choice.model).toBeUndefined();
		expect(choice.source).toBe("cli");
		expect(choice.warning).toBeUndefined();
	});

	test("a bogus per-call token never reaches argv; it falls through with a warning", () => {
		const choice = resolveWorkerModel("; rm -rf /", "o4-mini");
		expect(choice).toMatchObject({ model: "o4-mini", source: "config" });
		expect(choice.warning).toContain("not a valid model token");

		const none = resolveWorkerModel("; rm -rf /", null);
		expect(none.model).toBeUndefined();
		expect(none.source).toBe("cli");
	});
});
