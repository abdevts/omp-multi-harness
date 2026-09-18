/** Compact context handoff and output shaping. See _spec/02-agent-interface.md. */
import type { AgentMode, AgentResult } from "../agents/types.ts";

/** Truncate from the middle so both the opening and the conclusion survive. */
export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const keep = Math.max(200, Math.floor((maxChars - 80) / 2));
	const head = text.slice(0, keep);
	const tail = text.slice(-keep);
	const dropped = text.length - head.length - tail.length;
	return { text: `${head}\n\n[… ${dropped.toLocaleString()} characters omitted …]\n\n${tail}`, truncated: true };
}

const MODE_PREAMBLE: Record<AgentMode, string> = {
	analyze: "Analyze and explain. Do not modify any files.",
	plan: "Produce a concrete plan. Do not modify any files.",
	review: "Review the code and report findings, most important first. Do not modify any files.",
	implement: "Implement the change. Keep the diff minimal and focused.",
	debug: "Find the root cause first, then fix it.",
	test: "Run the relevant tests and repair what fails.",
};

export interface HandoffInput {
	task: string;
	mode?: AgentMode;
	context?: string;
	maxChars: number;
}

/**
 * Build the text sent to a worker: a short mode preamble, optional caller context, then the
 * task. Never the OMP transcript — the worker can read the repository itself.
 */
export function buildHandoff(input: HandoffInput): string {
	const sections: string[] = [];
	if (input.mode) sections.push(MODE_PREAMBLE[input.mode]);
	if (input.context?.trim()) {
		const { text } = truncateMiddle(input.context.trim(), input.maxChars);
		sections.push(`Context from the supervisor:\n${text}`);
	}
	sections.push(`Task:\n${input.task.trim()}`);
	return sections.join("\n\n");
}

/** One-line summary used in run lists and status lines. */
export function summarize(task: string, max = 60): string {
	const flat = task.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Compact, human-readable rendering of a finished run. */
export function renderResult(result: AgentResult, maxOutputChars: number): { text: string; truncated: boolean } {
	const { text, truncated } = truncateMiddle(result.output, maxOutputChars);
	const seconds = (result.durationMs / 1000).toFixed(1);
	const bits = [result.agent, `${seconds}s`];
	if (result.sessionId) bits.push(`session ${result.sessionId.slice(0, 8)}`);
	if (result.metadata?.readOnlyEnforced === true) bits.push("read-only");
	return { text: `[${bits.join(" · ")}]\n${text}`, truncated };
}
