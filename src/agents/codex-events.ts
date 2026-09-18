/**
 * Interpretation of `codex exec --json` output.
 *
 * Event shapes captured from codex-cli 0.155.0 (2026-09-18):
 *   {"type":"thread.started","thread_id":"01a0…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"…"}}
 *   {"type":"error","message":"…"}
 *   {"type":"turn.failed","error":{"message":"…"}}
 *
 * Shapes drift between versions, so nothing here switches on an exhaustive list of event
 * names: keys are searched from a candidate list and anything unrecognized is ignored
 * (_spec/03-codex-adapter.md).
 */
export interface CodexStreamState {
	sessionId?: string;
	/** Last assistant text seen, used only if the -o file is empty. */
	lastAgentMessage?: string;
	/** Terminal failure reported by the stream itself, even when the exit code is 0. */
	failure?: string;
	turnCompleted: boolean;
	itemCount: number;
	/**
	 * Set once a terminal event (`turn.completed`, `turn.failed`, or top-level `error`) has
	 * been recorded. A real stream carries at most one of these; a duplicate or out-of-order
	 * repeat (garbled stream, buggy CLI) must not flip an already-decided outcome — losing a
	 * real success to a stray late failure event would be worse than ignoring the duplicate.
	 */
	settled: boolean;
}

export interface CodexProgressEvent {
	phase: string;
	detail?: string;
	raw?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const v = source[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

const SESSION_KEYS = ["thread_id", "session_id", "conversation_id", "threadId", "sessionId"];
const TEXT_KEYS = ["text", "message", "content", "last_agent_message"];

/** Human-friendly phase for an item type. Unknown types fall back to the raw type. */
function phaseForItem(itemType: string): string {
	switch (itemType) {
		case "agent_message":
		case "assistant_message":
			return "writing response";
		case "command_execution":
		case "local_shell_call":
			return "running a command";
		case "file_change":
		case "patch_apply":
			return "editing files";
		case "reasoning":
			return "thinking";
		case "mcp_tool_call":
			return "calling a tool";
		case "web_search":
			return "searching the web";
		case "error":
			return "reported a problem";
		default:
			return itemType.replace(/_/g, " ");
	}
}

/** Feed one parsed event; mutates state and optionally yields a progress update. */
export function applyCodexEvent(state: CodexStreamState, value: unknown): CodexProgressEvent | null {
	const event = asRecord(value);
	if (!event) return null;

	const type = typeof event.type === "string" ? event.type : "";

	// Session id can appear on any event; take the first one we see.
	if (!state.sessionId) {
		const direct = firstString(event, SESSION_KEYS);
		const nested = asRecord(event.thread) ?? asRecord(event.session) ?? asRecord(event.conversation);
		state.sessionId = direct ?? (nested ? firstString(nested, [...SESSION_KEYS, "id"]) : undefined);
	}

	if (type === "thread.started") return { phase: "starting", raw: type };
	if (type === "turn.started") return { phase: "working", raw: type };

	if (type === "turn.completed") {
		if (!state.settled) {
			state.turnCompleted = true;
			state.settled = true;
		}
		return { phase: "completed", raw: type };
	}

	if (type === "turn.failed") {
		const error = asRecord(event.error);
		const message = (error ? firstString(error, ["message", "detail"]) : undefined) ?? "the turn failed";
		if (!state.settled) {
			state.failure = message;
			state.settled = true;
		}
		return { phase: "failed", detail: state.failure ?? message, raw: type };
	}

	if (type === "error") {
		const message = firstString(event, ["message", "detail"]) ?? "unknown error";
		if (!state.settled) {
			state.failure = message;
			state.settled = true;
		}
		return { phase: "failed", detail: state.failure ?? message, raw: type };
	}

	if (type === "item.completed" || type === "item.started" || type === "item.updated") {
		const item = asRecord(event.item);
		if (!item) return null;
		const itemType = typeof item.type === "string" ? item.type : "item";
		if (type === "item.completed") state.itemCount++;

		if (itemType === "agent_message" || itemType === "assistant_message") {
			const text = firstString(item, TEXT_KEYS);
			if (text) state.lastAgentMessage = text;
		}

		// An `error` item is informational (e.g. a truncated skill description), not fatal —
		// only top-level `error` / `turn.failed` end the run.
		const detail = itemType === "command_execution" ? firstString(item, ["command", "cmd"]) : undefined;
		return { phase: phaseForItem(itemType), detail, raw: `${type}:${itemType}` };
	}

	return null;
}

export function newCodexStreamState(): CodexStreamState {
	return { turnCompleted: false, itemCount: 0, settled: false };
}

/** Provider-side limits are worth their own message — refilling is the fix, not retrying. */
export function isQuotaFailure(message: string): boolean {
	return /out of credits|quota|rate.?limit|billing|insufficient.*(credit|balance)|usage limit/i.test(message);
}
