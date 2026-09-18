# 08 — Sessions, Parallel Runs, and Locking

This chapter covers the user requirement: **multiple delegated sessions running in
parallel, with `/sessions` to display and switch between them.**

## Concepts

- **OMP session** — the user's conversation. One at a time; OMP owns it.
- **Run** — one invocation of one external agent (one child process). Many may be alive at
  once.
- **Worker session** — the external CLI's own native session (Codex thread id / Claude
  session UUID). A run either creates one or resumes one.

## Run registry (`src/runs/registry.ts`)

In-memory, session-scoped, created on `session_start` and drained on `session_shutdown`.

```ts
type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

interface Run {
  id: string;                 // short, user-typeable, e.g. "r7c1"
  agent: AgentName;
  mode?: AgentMode;
  task: string;               // full task text
  summary: string;            // one line, for lists
  cwd: string;
  readOnly: boolean;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  phase: string;              // latest progress phase
  workerSessionId?: string;
  result?: AgentResult;
  error?: AgentError;
  controller: AbortController;
  output: RingBuffer;         // capped live output for the attach view
}
```

Rules:

- `registry.start(request)` → `Run`, spawning immediately (subject to the lock below).
- `registry.list()`, `get(id)`, `cancel(id)`, `wait(id, ms)`.
- `session_shutdown` cancels every non-terminal run and awaits termination (bounded by
  `killGraceMs`) so no child outlives OMP.
- All periodic work (progress ticks, UI refresh) uses **`ctx.setInterval`**, never raw
  timers — a raw timer that throws kills the whole OMP session (01 §2).
- Every detached promise gets a `.catch` that marks the run `failed`.

## Concurrency policy

| situation | allowed in parallel? |
|---|---|
| N read-only runs, same cwd | ✅ yes |
| read-only + writer, same cwd | ✅ yes (read-only cannot corrupt the writer's tree, but the reader may observe a moving tree — noted in the result) |
| 2 writers, same cwd | ❌ no — serialized by the workspace write lock |
| 2 writers, different cwd | ✅ yes |

- Lock key = **realpath-normalized** cwd (`src/runs/lock.ts`).
- The write lock is an async FIFO queue: a second writer **waits** (default) or is rejected
  with `WORKSPACE_BUSY` when `concurrency.writerQueue: false`.
- `concurrency.maxConcurrentRuns` (default 4) caps total live child processes; excess runs
  sit in `queued`.
- Lock release happens in `finally` — cancellation and crashes must not leak it.
- The two-writer restriction disappears once worktree mode lands (13); both CLIs already
  support `--worktree` / `-w`.

## Focus / switching

The registry holds a `focusedRunId`. Focus only affects presentation:

- focused run → `ctx.ui.setWidget("multi-harness", <last N output lines>)` and
  `ctx.ui.setStatus("multi-harness", "codex · implement · 2m14s · running tests")`.
- Unfocused runs keep executing and keep filling their own ring buffers.
- Focus survives run completion (the widget shows the final summary until detached).
- `/sessions` (07) is the UI over this.

## OMP ↔ worker session mapping (`src/sessions/store.ts`)

Persisted so `continueSession: true` works across OMP restarts.

```ts
interface HarnessSession {
  version: 1;
  ompSessionId: string;
  cwd: string;
  workers: {
    codex?:  { sessionId: string; updatedAt: string };
    claude?: { sessionId: string; updatedAt: string };
  };
}
```

- Key: `(ompSessionId, realpath(cwd))`.
- Storage: prefer OMP-provided extension storage if one exists at implementation time;
  otherwise JSON files under the **active agent dir** —
  `<agentDir>/multi-harness/sessions/<hash>.json`, where `agentDir` is resolved at runtime
  (honors `--profile` and `PI_CODING_AGENT_DIR`; do not hard-code `~/.omp/agent`).
- Mode 0600 files, 0700 directory.
- Persist **only** non-sensitive metadata: ids, cwd, timestamps. Never tokens, API keys,
  cookies, env dumps, or task text.
- Also mirrored into the OMP session via `pi.appendEntry("multi-harness-session", …)` so
  branching/forking a session carries the mapping.
- Background runs' results are additionally recorded with `pi.appendEntry` so a finished
  background run is still retrievable after a reload.

## Session continuation

- `continueSession: true` (default) → resume the mapped worker session for
  `(OMP session, repo)`.
- `continueSession: false` → fresh worker session; the mapping is then overwritten.
- Resume failure → one automatic fallback to a fresh session **with compact handoff
  context**, `metadata.resumedFallback = true`, and a visible note in the result. Never
  emulate full history.
- Parallel runs on the **same** agent in the **same** cwd cannot both resume the same
  worker session: the second one gets a fresh session (Codex) or `--fork-session`
  (Claude), recorded in `metadata.forked = true`.
