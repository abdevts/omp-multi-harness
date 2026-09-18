# 05 — Process Runner (`src/process/spawn-agent.ts`)

One reusable subprocess abstraction. Both adapters use it; nothing else spawns.

```ts
export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnAgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;   // capped ring buffer
  stderr: string;   // capped ring buffer
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}
```

## Requirements

1. Argument **arrays only**. `shell: false`. Never `exec(\`codex ${task}\`)`.
2. Spaces/unicode in paths must work — no quoting logic anywhere.
3. `cwd` is resolved, normalized, and verified to exist and be a directory before spawn
   (see 09 §Working directory rules).
4. **Environment:** inherit `process.env` so both CLIs find their own auth and config.
   Additionally set `CI=1`-style non-interactive hints only if a CLI needs them. Never
   inject provider API keys; never copy one provider's env into the other's run.
5. **Timeout:** `timeoutMs` (default from config, 30 min) → graceful termination path.
6. **Cancellation:** `AbortSignal` → same termination path. Already-aborted signal must
   reject before spawning.
7. **Termination path:** `SIGTERM` → wait `killGraceMs` (default 5 s) → `SIGKILL`.
   On POSIX, spawn with `detached: true` and kill the **process group** (`-pid`) so the
   CLI's own children (shells, test runners) die too. Windows: `taskkill /T /F`.
8. `stdout`/`stderr` captured **independently**, each into a capped ring buffer
   (default 1 MiB) so a runaway agent cannot exhaust memory.
9. Exit code and signal preserved verbatim in the result.
10. **No zombies:** every spawn resolves exactly once; `close`, `error`, and `exit` are
    all handled; all listeners and timers are removed in a `finally`.
11. Errors from spawn itself (`ENOENT`, `EACCES`) map to typed errors (10).
12. Nothing from `stdin`, `args`, or `env` is logged at default log level (10 §Logging).

## Streaming

`onStdout` receives decoded chunks with a persistent `TextDecoder({stream: true})` so
multi-byte characters split across chunk boundaries are not corrupted. Line splitting for
JSONL parsing happens in the adapter, not here.

## Cancellation contract

```text
OMP abort (ctx.signal / tool signal)
   → run registry aborts the run's AbortController
   → spawn-agent SIGTERMs the process group
   → (grace) SIGKILL
   → run resolves as { cancelled: true }
   → workspace lock released in a finally
```

The lock release must be in `finally`, not on the success path — a cancelled writer that
holds the lock deadlocks every later write (see 08).
