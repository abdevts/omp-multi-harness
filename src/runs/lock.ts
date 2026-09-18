/**
 * Workspace write lock (T-601, _spec/08 "Concurrency policy").
 *
 * Read-only runs are unrestricted. Write-capable runs take an exclusive, per-workspace
 * lock so two agents never edit the same tree at once. The queue is strictly FIFO: the
 * writer that asked first goes first, otherwise a long queue could starve someone.
 *
 * **Release contract:** `acquire` resolves with a release function that the caller MUST
 * invoke from a `finally` block. Release is idempotent and safe to call after the run was
 * cancelled or threw — a leaked lock wedges the workspace for the rest of the session.
 *
 * The key is the **realpath-normalized** cwd, so `/tmp/x` and `/private/tmp/x` (macOS) or
 * a symlinked checkout are recognized as the same workspace.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentName } from "../agents/types.ts";
import { cancelled, workspaceBusy } from "../process/process-error.ts";

/** Call in a `finally`. Idempotent — the second and later calls do nothing. */
export type ReleaseWriteLock = () => void;

export interface AcquireWriteLockOptions {
	/** Agent asking for the lock — only used to shape the `WORKSPACE_BUSY` error. */
	agent: AgentName;
	/** Wait for the holder (`concurrency.writerQueue: true`) or fail fast with WORKSPACE_BUSY. */
	queue: boolean;
	/** Short label for the lock's owner, shown to the user when someone else is busy. */
	holder?: string;
	/** Aborting while queued removes the waiter and rejects with CANCELLED. */
	signal?: AbortSignal;
}

export interface WriteLockTable {
	/** Resolves once the workspace is exclusively ours. Rejects with an `AgentError`. */
	acquire(cwd: string, options: AcquireWriteLockOptions): Promise<ReleaseWriteLock>;
	/** True while a writer holds this workspace — `/agents` prints "write lock: free" otherwise. */
	isHeld(cwd: string): boolean;
	/** Label of the current holder, if any. */
	holder(cwd: string): string | undefined;
	/** Number of writers waiting behind the holder. */
	queueDepth(cwd: string): number;
}

/** Resolve to a stable identity for a workspace. A missing dir falls back to an absolute path. */
export function workspaceKey(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return resolve(cwd);
	}
}

interface Waiter {
	holder: string;
	grant: (release: ReleaseWriteLock) => void;
	reject: (err: unknown) => void;
	/** Detaches the abort listener once the waiter settles, either way. */
	cleanup: () => void;
}

interface LockEntry {
	holder: string;
	waiters: Waiter[];
}

/**
 * Create an independent lock table. The registry takes one as a dependency so tests get a
 * clean table instead of racing on module-level state.
 */
export function createWriteLockTable(): WriteLockTable {
	const locks = new Map<string, LockEntry>();

	function handOff(key: string, entry: LockEntry): void {
		const next = entry.waiters.shift();
		if (!next) {
			locks.delete(key);
			return;
		}
		entry.holder = next.holder;
		next.cleanup();
		next.grant(makeRelease(key, entry));
	}

	function makeRelease(key: string, entry: LockEntry): ReleaseWriteLock {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			// Guard against a stale release from a previous generation of this key.
			if (locks.get(key) !== entry) return;
			handOff(key, entry);
		};
	}

	return {
		acquire(cwd, options) {
			const key = workspaceKey(cwd);
			const holder = options.holder ?? options.agent;
			const signal = options.signal;

			if (signal?.aborted) return Promise.reject(cancelled(options.agent));

			const entry = locks.get(key);
			if (!entry) {
				const fresh: LockEntry = { holder, waiters: [] };
				locks.set(key, fresh);
				return Promise.resolve(makeRelease(key, fresh));
			}
			if (!options.queue) return Promise.reject(workspaceBusy(options.agent, entry.holder));

			const held = entry;
			return new Promise<ReleaseWriteLock>((grant, reject) => {
				const onAbort = (): void => {
					const i = held.waiters.indexOf(waiter);
					if (i >= 0) held.waiters.splice(i, 1);
					waiter.cleanup();
					reject(cancelled(options.agent));
				};
				const waiter: Waiter = {
					holder,
					grant,
					reject,
					cleanup: () => signal?.removeEventListener("abort", onAbort),
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				held.waiters.push(waiter);
			});
		},
		isHeld(cwd) {
			return locks.has(workspaceKey(cwd));
		},
		holder(cwd) {
			return locks.get(workspaceKey(cwd))?.holder;
		},
		queueDepth(cwd) {
			return locks.get(workspaceKey(cwd))?.waiters.length ?? 0;
		},
	};
}

/** Process-wide table, used when no table is injected. */
const sharedTable = createWriteLockTable();

/** Acquire the shared workspace write lock. Release in a `finally`. */
export function acquireWriteLock(cwd: string, options: AcquireWriteLockOptions): Promise<ReleaseWriteLock> {
	return sharedTable.acquire(cwd, options);
}

/** True while a writer holds this workspace in the shared table. */
export function isWriteLockHeld(cwd: string): boolean {
	return sharedTable.isHeld(cwd);
}

/** Label of the shared table's current holder for this workspace, if any. */
export function writeLockHolder(cwd: string): string | undefined {
	return sharedTable.holder(cwd);
}
