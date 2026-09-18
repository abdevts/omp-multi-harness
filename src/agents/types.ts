/** Provider-neutral agent interface. See _spec/02-agent-interface.md. */
import type { AgentMode, AgentName } from "../config/schema.ts";

export type { AgentMode, AgentName };

export interface AgentRequest {
	agent: AgentName;
	task: string;
	cwd: string;
	mode?: AgentMode;
	/** Prior worker session id to resume. */
	sessionId?: string;
	/** Compact handoff context — never the OMP transcript. */
	context?: string;
	timeoutMs?: number;
	/** Request provider-enforced read-only execution. */
	readOnly?: boolean;
	/** Per-call worker model override; falls back to config, then the CLI's own config. */
	model?: string;
}

export interface AgentResult {
	agent: AgentName;
	success: boolean;
	/** Final textual answer only — never the raw event stream. */
	output: string;
	sessionId?: string;
	exitCode: number | null;
	durationMs: number;
	stderr?: string;
	metadata?: Record<string, unknown>;
}

export interface AgentProgress {
	/** e.g. "starting", "inspecting repository", "running tests", "completed" */
	phase: string;
	detail?: string;
	/** Provider-native event kind — debug logs only. */
	raw?: string;
}

export interface AgentRunOptions {
	signal: AbortSignal;
	onProgress?: (event: AgentProgress) => void;
}

export type AuthState = "ok" | "logged-out" | "unknown";

export interface AgentAvailability {
	agent: AgentName;
	available: boolean;
	executablePath?: string;
	version?: string;
	auth: AuthState;
	/** One line, safe to display. Never contains credentials. */
	authDetail: string;
	/** Present when `available` is false. */
	reason?: string;
}

export interface ExternalAgent {
	readonly name: AgentName;
	isAvailable(force?: boolean): Promise<AgentAvailability>;
	run(request: AgentRequest, options: AgentRunOptions): Promise<AgentResult>;
}

/** Mode defaults. An explicit readOnly on the request always wins. */
export const MODE_DEFAULT_READ_ONLY: Record<AgentMode, boolean> = {
	analyze: true,
	plan: true,
	review: true,
	implement: false,
	debug: false,
	test: false,
};
