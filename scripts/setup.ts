#!/usr/bin/env bun
/**
 * omp-multi-harness setup — orchestrator.
 *
 *   bun scripts/setup.ts            # same as `check`
 *   bun scripts/setup.ts check      # read-only report of every setup step
 *   bun scripts/setup.ts fix        # apply the safe automatic fixes (asks first)
 *   bun scripts/setup.ts fix --yes  # ...without asking
 *   bun scripts/setup.ts check --json
 *   bun scripts/setup.ts check --only codex,claude
 *
 * Each provider owns its own module under scripts/setup/; this file just runs them all.
 * Rules (see _spec/10 and _spec/14):
 *   - never read a credential file, never print a token, never log in for the user
 *   - auth state comes only from each CLI's own status command
 *   - installs and logins are printed as commands; they are never auto-run
 */
import { createInterface } from "node:readline/promises";
import { claudeSetup } from "./setup/claude.ts";
import { codexSetup } from "./setup/codex.ts";
import { ompSetup } from "./setup/omp.ts";
import { toolchainSetup } from "./setup/toolchain.ts";
import type { SetupGroup, Status, Step } from "./setup/types.ts";

/** Registration order = report order. Add a provider by adding its module here. */
const GROUPS: SetupGroup[] = [toolchainSetup, ompSetup, codexSetup, claudeSetup];

const GLYPH: Record<Status, string> = { ok: "✔", warn: "!", fail: "✘", skip: "–" };

interface Outcome {
	group: SetupGroup;
	step: Step;
	status: Status;
	detail: string;
	fix?: { description: string; command?: string; auto?: () => void };
}

function arg(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
	const argv = process.argv.slice(2);
	const mode = argv.find((a) => !a.startsWith("--")) ?? "check";
	const yes = argv.includes("--yes") || argv.includes("-y");
	const asJson = argv.includes("--json");
	const only = arg(argv, "only")?.split(",").map((s) => s.trim());

	const groups = only ? GROUPS.filter((g) => only.includes(g.id)) : GROUPS;
	const results: Outcome[] = groups.flatMap((group) =>
		group.steps.map((step) => ({ group, step, ...step.run() })),
	);

	if (asJson) {
		console.log(
			JSON.stringify(
				results.map((r) => ({ group: r.group.id, id: r.step.id, status: r.status, detail: r.detail })),
				null,
				2,
			),
		);
		process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
	}

	console.log("\nomp-multi-harness setup\n");
	for (const group of groups) {
		console.log(`${group.title}`);
		for (const r of results.filter((x) => x.group.id === group.id)) {
			console.log(`  ${GLYPH[r.status]} ${r.step.title.padEnd(36)} ${r.detail}`);
		}
		console.log();
	}

	const actionable = results.filter((r) => r.fix && r.status !== "ok" && r.status !== "skip");
	if (actionable.length === 0) {
		console.log("Everything is set up.\n");
		return;
	}

	const auto = actionable.filter((r) => r.fix?.auto);
	const manual = actionable.filter((r) => !r.fix?.auto);

	if (mode === "fix" && auto.length > 0) {
		const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
		for (const r of auto) {
			if (rl) {
				const a = (await rl.question(`${r.fix!.description}? [y/N] `)).trim().toLowerCase();
				if (a !== "y" && a !== "yes") continue;
			}
			try {
				r.fix!.auto!();
				console.log(`  ${GLYPH.ok} ${r.step.title}: fixed`);
			} catch (e) {
				console.log(`  ${GLYPH.fail} ${r.step.title}: ${(e as Error).message}`);
			}
		}
		rl?.close();
		console.log();
	} else if (auto.length > 0) {
		console.log("Automatic fixes available — run `bun scripts/setup.ts fix`:");
		for (const r of auto) console.log(`  · ${r.fix!.description}`);
		console.log();
	}

	if (manual.length > 0) {
		console.log("Run these yourself (installs and logins are never automated):");
		for (const r of manual) {
			console.log(`  · [${r.group.title}] ${r.fix!.description}`);
			if (r.fix!.command) console.log(`      ${r.fix!.command}`);
		}
		console.log();
	}
}

await main();
