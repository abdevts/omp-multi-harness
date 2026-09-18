/**
 * T-505 — behavioral checks on top of test/routing.test.ts (which unit-tests the routing
 * functions themselves). This file asks a different question: does the router make
 * *sensible* choices on task strings a user would actually type, and does it stay a set of
 * preferences rather than a required workflow (_spec/12 E)?
 *
 * All assertions here go through `routeByRules` — the offline, deterministic path — so this
 * file never depends on a model call. That is deliberate: it is what actually ships by
 * default (`routing.mode: "model"` still falls back to these same rules on any failure, per
 * routing.test.ts), and it is the only part of routing whose output is reproducible enough
 * to assert against a corpus.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULTS, type MultiHarnessConfig } from "../src/config/schema.ts";
import { routeByRules } from "../src/routing/route.ts";

const config = (over: Partial<MultiHarnessConfig["routing"]> = {}): MultiHarnessConfig => ({
	...DEFAULTS,
	routing: { ...DEFAULTS.routing, ...over },
});

const rules = config();

/**
 * A realistic corpus: the kind of thing a user actually types into a supervisor, not
 * three toy sentences. Each entry is a task string paired with the agent a reasonable
 * human dispatcher would pick, per spec 12-E's split — planning / architecture / analysis
 * / review reads as Claude, implementation / debugging / test-fixing reads as Codex.
 */
const CLAUDE_CORPUS = [
	"Review whether this architecture will scale to 10x traffic.",
	"Can you review my PR before I merge it?",
	"What's the best approach for splitting this monolith into services?",
	"Give me a second opinion on this caching strategy.",
	"Should we use event sourcing here, or is that overkill?",
	"Explain how the authentication flow works in this codebase.",
	"Compare Redis and Postgres for this use case and give me the trade-offs.",
	"Assess the risk of rolling this out to production without a feature flag.",
	"Is this approach worth it given our timeline?",
	"Walk me through the pros and cons of switching to a monorepo.",
	"Do a design review of the new payments module before we start building.",
	"What's the rationale behind the current retry logic?",
	"How maintainable is this abstraction going to be in six months?",
	"Plan the migration strategy for moving off the legacy queue.",
	"Think through the risks if this service goes down mid-deploy.",
	// Phrase-level: "test coverage/strategy/plan" is assessment, not implementation, even
	// though it contains the word "test" (the finding fixed in route.ts — see below).
	"Analyze the test coverage gaps in the billing service.",
	"What's our test strategy for the new payments flow?",
	"Draft a test plan for the checkout redesign before anyone writes code.",
];

const CODEX_CORPUS = [
	"Implement this endpoint.",
	"Fix the failing unit tests in the parser.",
	"Refactor the spawn helper and rename its arguments.",
	"Add a new POST /users endpoint with validation.",
	"There's a bug where the login form submits twice, please fix it.",
	"Write tests for the new rate limiter.",
	"Rename all occurrences of `oldName` to `newName` across the repo.",
	"The build is failing with a typecheck error in src/agents/claude.ts, fix it.",
	"Remove the deprecated /v1/legacy route.",
	"Wire up the new config flag to the CLI arg parser.",
	"Patch the off-by-one error in the pagination code.",
	"Debug why the webhook handler is dropping events.",
	"Migrate the database schema to add a new `status` column.",
	"Reproduce the crash from this stack trace and fix the root cause.",
	"Lint and clean up the routing module.",
	// Phrase-level counterparts to the CLAUDE_CORPUS additions above: a bare "test" outside
	// "test coverage/strategy/plan" still reads as implementation work, not assessment.
	"Run the tests before you push.",
	"Fix the flaky test in CI.",
	"Add integration tests for the checkout flow.",
];

describe("routing corpus: planning/architecture/analysis/review -> claude", () => {
	for (const task of CLAUDE_CORPUS) {
		test(task, () => {
			expect(routeByRules({ task }, rules)).toMatchObject({ agent: "claude", routedBy: "rules" });
		});
	}
});

describe("routing corpus: implementation/debugging/test-fixing -> codex", () => {
	for (const task of CODEX_CORPUS) {
		test(task, () => {
			expect(routeByRules({ task }, rules)).toMatchObject({ agent: "codex", routedBy: "rules" });
		});
	}
});

// FIXED FINDING: "Analyze the test coverage gaps in the billing service." used to read as
// analysis/assessment work to a human, but routed to codex — "Analyze" scored one Claude
// point while "test" (from "test coverage") scored one Codex point via the bare \btest\b
// signal, and the tie fell through to `routing.default` ("codex"). route.ts now (1) treats
// "test coverage/strategy/plan" as a phrase-level Claude signal instead of letting the bare
// word collide with it, and (2) gives a sentence-initial imperative verb ("Analyze…") an
// extra point over an incidental noun later in the sentence. Both changes are general — not
// a special case for this one string — and are pinned down by the CLAUDE_CORPUS/CODEX_CORPUS
// additions above (test coverage/strategy/plan phrases -> claude; bare "test"/"tests"
// elsewhere -> codex, unchanged).
test("fixed: an analysis-shaped task no longer ties on the bare word \"test\"", () => {
	const d = routeByRules({ task: "Analyze the test coverage gaps in the billing service." }, rules);
	expect(d).toMatchObject({ agent: "claude", routedBy: "rules" });
});

describe("no rigid workflow is imposed (spec 12-E)", () => {
	test("a direct implementation request is not deflected into planning first", () => {
		const d = routeByRules({ task: "Implement this endpoint." }, rules);
		expect(d.agent).toBe("codex");
		// The decision is a single, one-shot pick — no field steering toward a "plan first"
		// step, no chain, no required predecessor run.
		expect(Object.keys(d).sort()).toEqual(["agent", "ok", "reason", "routedBy"]);
	});

	test("routing never requires a prior planning run: implement, then implement again, is fine", () => {
		const first = routeByRules({ task: "Implement the retry logic for the queue consumer." }, rules);
		const second = routeByRules({ task: "Implement the same thing but for the outbound webhook sender." }, rules);
		expect(first.agent).toBe("codex");
		expect(second.agent).toBe("codex");
		// Each call is independent — nothing in RouteInput carries state from a previous call.
	});

	test("a review-shaped ask never forces a follow-up implement step and vice versa", () => {
		const review = routeByRules({ task: "Review this diff for correctness before I merge it." }, rules);
		const implement = routeByRules({ task: "Implement the fix directly, no review needed first." }, rules);
		expect(review.agent).toBe("claude");
		expect(implement.agent).toBe("codex");
	});

	test("mode is a routing hint, not a stage in a pipeline: any mode can be requested standalone", () => {
		for (const mode of ["analyze", "plan", "implement", "debug", "review", "test"] as const) {
			const d = routeByRules({ task: "do the thing", mode }, rules);
			expect(d.routedBy).toBe("mode");
			expect(d.agent).toBe(rules.routing.modeMap[mode]);
		}
	});
});

describe("an explicit agent choice always wins over every heuristic", () => {
	test("explicit codex beats strongly claude-shaped task text", () => {
		const d = routeByRules(
			{ agent: "codex", task: "Review the architecture, assess the risks, and give a second opinion on trade-offs." },
			rules,
		);
		expect(d).toMatchObject({ agent: "codex", routedBy: "explicit" });
	});

	test("explicit claude beats strongly codex-shaped task text", () => {
		const d = routeByRules({ agent: "claude", task: "Fix the failing tests, refactor the parser, patch the bug." }, rules);
		expect(d).toMatchObject({ agent: "claude", routedBy: "explicit" });
	});

	test("explicit agent beats an explicit mode too", () => {
		const d = routeByRules({ agent: "codex", task: "do the thing", mode: "plan" }, rules);
		expect(d).toMatchObject({ agent: "codex", routedBy: "explicit" });
	});
});

describe("config overrides change routing outcomes", () => {
	test("a custom routing.modeMap actually changes which agent a mode maps to", () => {
		const defaultMap = routeByRules({ task: "do the thing", mode: "review" }, rules);
		expect(defaultMap.agent).toBe("claude");

		const flipped = config({ modeMap: { ...DEFAULTS.routing.modeMap, review: "codex" } });
		const overridden = routeByRules({ task: "do the thing", mode: "review" }, flipped);
		expect(overridden.agent).toBe("codex");
	});

	test("a custom routing.default changes the no-signal outcome", () => {
		const noSignalTask = "the thing over there";
		expect(routeByRules({ task: noSignalTask }, config({ default: "codex" })).agent).toBe("codex");
		expect(routeByRules({ task: noSignalTask }, config({ default: "claude" })).agent).toBe("claude");
	});

	test("routing.default: auto with no signal still decides rather than refusing", () => {
		const d = routeByRules({ task: "the thing over there" }, config({ default: "auto" }));
		expect(d.ok).toBe(true);
		expect(["codex", "claude"]).toContain(d.agent);
	});

	test("modeMap override is per-mode: overriding review leaves plan and implement untouched", () => {
		const flipped = config({ modeMap: { ...DEFAULTS.routing.modeMap, review: "codex" } });
		expect(routeByRules({ task: "x", mode: "plan" }, flipped).agent).toBe("claude");
		expect(routeByRules({ task: "x", mode: "implement" }, flipped).agent).toBe("codex");
	});
});
