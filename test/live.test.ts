/**
 * Live integration tests. Skipped unless MULTI_HARNESS_LIVE_TESTS=1.
 * These call the real CLIs and cost real money — never run them in CI.
 *
 * Phase 3's live pass exercised the adapters directly. Since then `ask_claude`/`/claude`
 * moved onto `createRunRegistry` (queueing, write lock, session-resume plumbing,
 * cancellation translation) — that code path had never been verified against real
 * binaries. This file closes that gap by driving the registry, not the adapter.
 *
 * Every scratch cwd lives under /private/tmp — never this repo, so a write-capable run
 * can never touch this source tree.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgent } from "../src/agents/claude.ts";
import { CodexAgent } from "../src/agents/codex.ts";
import type { AgentName } from "../src/agents/types.ts";
import { DEFAULTS, type MultiHarnessConfig } from "../src/config/schema.ts";
import { createRunRegistry } from "../src/runs/registry.ts";

const LIVE = process.env.MULTI_HARNESS_LIVE_TESTS === "1";
const describeLive = LIVE ? describe : describe.skip;

// Scratch dirs only — never the repo working tree (see file banner).
const SCRATCH_ROOT = "/private/tmp";

function scratchRepo(magicWord: string): string {
	const dir = mkdtempSync(join(SCRATCH_ROOT, "multi-harness-live-"));
	writeFileSync(join(dir, "README.md"), `# Scratch\n\nThe magic word is ${magicWord}.\n`);
	return dir;
}

/** A registry wired to the real adapters, matching how src/index.ts builds one. */
function makeRegistry(overrides: Partial<MultiHarnessConfig> = {}) {
	const config: MultiHarnessConfig = { ...DEFAULTS, ...overrides };
	const agentFor = (agent: AgentName) => (agent === "codex" ? new CodexAgent(config.codex) : new ClaudeAgent(config.claude));
	const sessionSeeds = new Map<string, string>();
	const registry = createRunRegistry({
		config: () => config,
		agentFor,
		resolveSessionId: (agent, cwd) => sessionSeeds.get(`${agent}:${cwd}`),
		onWorkerSession: (agent, cwd, sessionId) => sessionSeeds.set(`${agent}:${cwd}`, sessionId),
	});
	return { registry, sessionSeeds };
}

/** Count live `claude -p` child processes, used to confirm cancellation actually kills the tree. */
function claudeProcessCount(): number {
	try {
		const out = execSync("pgrep -f 'claude -p'", { encoding: "utf8" }).trim();
		return out.length === 0 ? 0 : out.split("\n").length;
	} catch {
		// pgrep exits 1 with empty output when nothing matches.
		return 0;
	}
}

describeLive("live: registry -> Claude (real binary)", () => {
	test(
		"read-only run through the registry completes, reports honest read-only enforcement, and yields a real worker session id",
		async () => {
			const cwd = scratchRepo("bananaphone");
			const { registry } = makeRegistry();

			const started = registry.start({
				agent: "claude",
				task: "Read README.md in this directory and reply with only the magic word it contains.",
				cwd,
				mode: "analyze",
				readOnly: true,
			});
			expect(["queued", "running"]).toContain(started.status);

			const finished = await registry.wait(started.id, 180_000);

			// Printed (not just asserted) so a human reviewer can see the real worker session id
			// and answer text this run produced, not just that a regex matched it.
			console.log(`[live] basic run: workerSessionId=${finished?.workerSessionId} output=${JSON.stringify(finished?.output)}`);

			expect(finished?.status).toBe("done");
			expect(finished?.output?.toLowerCase()).toContain("bananaphone");
			expect(finished?.workerSessionId).toMatch(/^[0-9a-f-]{36}$/);
			expect(finished?.metadata?.readOnlyEnforced).toBe(true);
			expect(typeof finished?.metadata?.readOnlyMechanism).toBe("string");
			expect(String(finished?.metadata?.readOnlyMechanism)).toContain("--permission-mode plan");
		},
		200_000,
	);

	test(
		"a second run seeded with the first run's worker session id resumes it (session continuation, criterion J)",
		async () => {
			const cwd = scratchRepo("palindrome42");
			const { registry, sessionSeeds } = makeRegistry();

			const first = registry.start({
				agent: "claude",
				task:
					"Read README.md in this directory. Reply with only the magic word it contains, then remember it — I will ask you to recall it without reading the file again in a moment.",
				cwd,
				mode: "analyze",
				readOnly: true,
			});
			const firstDone = await registry.wait(first.id, 180_000);
			expect(firstDone?.status).toBe("done");
			const firstSessionId = firstDone?.workerSessionId;
			expect(firstSessionId).toMatch(/^[0-9a-f-]{36}$/);
			// registry's onWorkerSession callback should have populated the seed map already.
			expect(sessionSeeds.get(`claude:${cwd}`)).toBe(firstSessionId!);

			const second = registry.start({
				agent: "claude",
				task: "Without reading any file, reply with only the magic word from a moment ago.",
				cwd,
				mode: "analyze",
				readOnly: true,
			});
			const secondDone = await registry.wait(second.id, 180_000);

			console.log(
				`[live] resume run: firstSessionId=${firstSessionId} secondSessionId=${secondDone?.workerSessionId} ` +
					`secondOutput=${JSON.stringify(secondDone?.output)}`,
			);

			expect(secondDone?.status).toBe("done");
			expect(secondDone?.output?.toLowerCase()).toContain("palindrome42");
			// The whole point of resume: same worker session id reused, not a fresh one.
			expect(secondDone?.workerSessionId).toBe(firstSessionId);
		},
		200_000,
	);

	test(
		"two concurrent read-only runs both progress and complete correctly (acceptance criterion K)",
		async () => {
			const cwdA = scratchRepo("trombone-alpha");
			const cwdB = scratchRepo("kazoo-beta");
			const { registry } = makeRegistry();

			const a = registry.start({
				agent: "claude",
				task: "Read README.md in this directory and reply with only the magic word it contains.",
				cwd: cwdA,
				mode: "analyze",
				readOnly: true,
			});
			const b = registry.start({
				agent: "claude",
				task: "Read README.md in this directory and reply with only the magic word it contains.",
				cwd: cwdB,
				mode: "analyze",
				readOnly: true,
			});

			// Both should be alive (queued or running) right after both starts — neither was
			// starved by the other at the moment of admission.
			const listRightAfterStart = registry.list().map((r) => r.id);
			expect(listRightAfterStart).toContain(a.id);
			expect(listRightAfterStart).toContain(b.id);

			const [doneA, doneB] = await Promise.all([registry.wait(a.id, 180_000), registry.wait(b.id, 180_000)]);

			expect(doneA?.status).toBe("done");
			expect(doneB?.status).toBe("done");
			expect(doneA?.output?.toLowerCase()).toContain("trombone-alpha");
			expect(doneB?.output?.toLowerCase()).toContain("kazoo-beta");
			// Distinct outputs, distinct worker sessions — no cross-talk between the two runs.
			expect(doneA?.output).not.toBe(doneB?.output);
			expect(doneA?.workerSessionId).not.toBe(doneB?.workerSessionId);
		},
		200_000,
	);

	test(
		"cancelling a run mid-flight reaches `cancelled` and leaves no claude process behind",
		async () => {
			const cwd = scratchRepo("cancel-me");
			const { registry } = makeRegistry();
			const baseline = claudeProcessCount();

			const started = registry.start({
				agent: "claude",
				task:
					"Without using any tools, slowly write out the English words for every integer from 1 to 300, one per line, " +
					"pausing to double-check each one before writing the next.",
				cwd,
				mode: "analyze",
				readOnly: true,
			});

			// Give the CLI time to actually spawn before we cancel it — this is the "mid-flight"
			// window; the long-winded task above is chosen so the process is still alive here.
			await new Promise((r) => setTimeout(r, 1_500));
			const midFlightCount = claudeProcessCount();

			const cancelled = await registry.cancel(started.id);
			expect(cancelled).toBe(true);

			const finished = await registry.wait(started.id, 15_000);
			expect(finished?.status).toBe("cancelled");
			expect(finished?.errorCode).toBe("CANCELLED");

			// killGraceMs (default 5s) plus slack for the OS to actually reap the process group.
			await new Promise((r) => setTimeout(r, 6_000));
			const afterCount = claudeProcessCount();

			expect(midFlightCount).toBeGreaterThan(baseline);
			expect(afterCount).toBe(baseline);
		},
		60_000,
	);
});

describeLive("live: registry -> Codex (real binary, known blocker)", () => {
	test(
		"Codex is out of provider credits — confirm the failure is classified PROVIDER_LIMIT, not a generic failure",
		async () => {
			const cwd = scratchRepo("codex-marker");
			const { registry } = makeRegistry();

			const started = registry.start({
				agent: "codex",
				task: "Read README.md in this directory and reply with only the magic word it contains.",
				cwd,
				mode: "analyze",
				readOnly: true,
			});
			const finished = await registry.wait(started.id, 180_000);

			// This account is known to be out of credits (documented blocker, not a bug here).
			// If Codex quota is ever restored, this assertion should be revisited — a `done`
			// result would then also be an acceptable, better outcome.
			expect(finished?.status).toBe("failed");
			expect(finished?.errorCode).toBe("PROVIDER_LIMIT");
		},
		200_000,
	);
});
