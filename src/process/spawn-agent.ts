/**
 * The only place this project spawns a process.
 *
 * Contract (_spec/05-process-runner.md): argument arrays only, never a shell; prompts on
 * stdin; independent capped output buffers; timeout and AbortSignal both terminate the
 * whole process group; exactly one resolution; every listener cleaned up.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { realpathSync } from "node:fs";

const IS_WINDOWS = process.platform === "win32";

export interface SpawnAgentOptions {
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Written to the child's stdin, which is then closed. Keeps prompts out of `ps`. */
	stdin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Milliseconds between SIGTERM and SIGKILL. */
	killGraceMs?: number;
	maxBufferBytes?: number;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface SpawnAgentResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	cancelled: boolean;
}

/** Byte-capped buffer that keeps the tail — a runaway agent must not exhaust memory. */
export class RingBuffer {
	#chunks: string[] = [];
	#bytes = 0;
	constructor(private readonly maxBytes: number) {}

	push(chunk: string): void {
		this.#chunks.push(chunk);
		this.#bytes += Buffer.byteLength(chunk);
		while (this.#bytes > this.maxBytes && this.#chunks.length > 1) {
			const dropped = this.#chunks.shift()!;
			this.#bytes -= Buffer.byteLength(dropped);
		}
	}

	get text(): string {
		return this.#chunks.join("");
	}
}

export class SpawnCwdError extends Error {}

/** Terminate the child and everything it started. */
function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (IS_WINDOWS) {
			spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false }).unref();
		} else {
			// Negative pid = the whole process group, so the CLI's own children die too.
			process.kill(-child.pid, signal);
		}
	} catch {
		try {
			child.kill(signal);
		} catch {
			/* already gone */
		}
	}
}

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
	const {
		command,
		args,
		cwd,
		env = process.env,
		stdin,
		timeoutMs,
		signal,
		killGraceMs = 5_000,
		maxBufferBytes = 1_048_576,
		onStdout,
		onStderr,
	} = options;

	let realCwd: string;
	try {
		realCwd = realpathSync(cwd);
		if (!statSync(realCwd).isDirectory()) throw new Error("not a directory");
	} catch (e) {
		throw new SpawnCwdError(`${cwd}: ${(e as Error).message}`);
	}

	if (signal?.aborted) {
		return { exitCode: null, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false, cancelled: true };
	}

	const started = Date.now();
	const stdout = new RingBuffer(maxBufferBytes);
	const stderr = new RingBuffer(maxBufferBytes);

	return await new Promise<SpawnAgentResult>((resolvePromise, rejectPromise) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd: realCwd,
				env,
				shell: false,
				// Own process group so we can signal the whole tree on cancel/timeout.
				detached: !IS_WINDOWS,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (e) {
			rejectPromise(e);
			return;
		}

		let settled = false;
		let timedOut = false;
		let cancelled = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const escalate = () => {
			graceTimer = setTimeout(() => terminate(child, "SIGKILL"), killGraceMs);
			graceTimer.unref?.();
		};

		const onAbort = () => {
			cancelled = true;
			terminate(child, "SIGTERM");
			escalate();
		};

		const cleanup = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (graceTimer) clearTimeout(graceTimer);
			signal?.removeEventListener("abort", onAbort);
			child.stdout?.removeAllListeners();
			child.stderr?.removeAllListeners();
			child.removeAllListeners();
		};

		const settle = (result: SpawnAgentResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolvePromise(result);
		};

		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(err);
		};

		if (timeoutMs && timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				terminate(child, "SIGTERM");
				escalate();
			}, timeoutMs);
			timeoutTimer.unref?.();
		}

		signal?.addEventListener("abort", onAbort, { once: true });

		// Persistent decoders: a multi-byte character split across chunks must not corrupt.
		const outDecoder = new TextDecoder("utf8");
		const errDecoder = new TextDecoder("utf8");

		child.stdout?.on("data", (buf: Buffer) => {
			const text = outDecoder.decode(buf, { stream: true });
			if (!text) return;
			stdout.push(text);
			onStdout?.(text);
		});
		child.stderr?.on("data", (buf: Buffer) => {
			const text = errDecoder.decode(buf, { stream: true });
			if (!text) return;
			stderr.push(text);
			onStderr?.(text);
		});

		child.on("error", fail);

		child.on("close", (code, sig) => {
			settle({
				exitCode: code,
				signal: sig,
				stdout: stdout.text,
				stderr: stderr.text,
				durationMs: Date.now() - started,
				timedOut,
				cancelled,
			});
		});

		if (child.stdin) {
			child.stdin.on("error", () => {
				/* child may exit before we finish writing — not fatal */
			});
			if (stdin !== undefined) child.stdin.write(stdin);
			child.stdin.end();
		}
	});
}
