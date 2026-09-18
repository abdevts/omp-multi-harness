/**
 * Interpretation of `claude -p --output-format stream-json` output.
 *
 * Shapes captured from Claude Code 2.1.274 (2026-09-18):
 *   {"type":"system","subtype":"init","session_id":"…"}
 *   {"type":"system","subtype":"hook_started"|"hook_response"|"thinking_tokens"|"post_turn_summary",…}
 *   {"type":"assistant", …}
 *   {"type":"rate_limit_event", …}
 *   {"type":"result","subtype":"success","result":"pong","is_error":false,
 *    "session_id":"…","num_turns":1,"duration_ms":8243,"total_cost_usd":0.43,
 *    "usage":{…},"permission_denials":[…]}
 *
 * A real run is mostly hook noise, so progress reporting deliberately ignores it.
 */
export interface ClaudeStreamState {
	sessionId?: string;
	/** Terminal text from the `result` event. */
	result?: string;
	/** Set when the result event reports a failure. */
	failure?: string;
	lastAssistantText?: string;
	turns?: number;
	costUsd?: number;
	/** Tools Claude asked for and was refused — evidence that read-only actually held. */
	permissionDenials: number;
	sawResult: boolean;
}

export interface ClaudeProgressEvent {
	phase: string;
	detail?: string;
	raw?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Pull readable text out of an assistant message's content blocks. */
function assistantText(event: Record<string, unknown>): string | undefined {
	const message = asRecord(event.message);
	const content = message?.content ?? event.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		const b = asRecord(block);
		if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.length > 0 ? parts.join("") : undefined;
}

/** Tool names mentioned by an assistant event, for progress display. */
function toolName(event: Record<string, unknown>): string | undefined {
	const message = asRecord(event.message);
	const content = message?.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const b = asRecord(block);
		if (b && b.type === "tool_use" && typeof b.name === "string") return b.name;
	}
	return undefined;
}

export function newClaudeStreamState(): ClaudeStreamState {
	return { permissionDenials: 0, sawResult: false };
}

export function applyClaudeEvent(state: ClaudeStreamState, value: unknown): ClaudeProgressEvent | null {
	const event = asRecord(value);
	if (!event) return null;

	if (!state.sessionId && typeof event.session_id === "string") state.sessionId = event.session_id;

	const type = typeof event.type === "string" ? event.type : "";
	const subtype = typeof event.subtype === "string" ? event.subtype : "";

	if (type === "system") {
		// Hook chatter and token accounting are noise; only `init` is worth a phase.
		return subtype === "init" ? { phase: "starting", raw: "system:init" } : null;
	}

	if (type === "assistant") {
		const text = assistantText(event);
		if (text) state.lastAssistantText = text;
		const tool = toolName(event);
		return tool ? { phase: `using ${tool}`, raw: "assistant:tool_use" } : { phase: "writing response", raw: "assistant" };
	}

	if (type === "user") return { phase: "reading tool results", raw: "user" };

	if (type === "rate_limit_event") return { phase: "waiting on rate limit", raw: type };

	if (type === "result") {
		state.sawResult = true;
		if (typeof event.num_turns === "number") state.turns = event.num_turns;
		if (typeof event.total_cost_usd === "number") state.costUsd = event.total_cost_usd;
		if (Array.isArray(event.permission_denials)) state.permissionDenials = event.permission_denials.length;

		const isError = event.is_error === true || (subtype !== "" && subtype !== "success");
		const text = typeof event.result === "string" ? event.result : undefined;

		if (isError) {
			state.failure = text && text.length > 0 ? text : `the run ended with "${subtype || "an error"}"`;
			return { phase: "failed", detail: state.failure, raw: `result:${subtype}` };
		}

		state.result = text;
		return { phase: "completed", raw: `result:${subtype}` };
	}

	return null;
}
